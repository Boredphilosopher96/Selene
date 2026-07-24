import { describe, expect, it } from 'vitest';

import {
  createHostEffectAdmissionPool,
  createHostEffectSupervisorOptions,
  HostEffectSupervisor,
  HostEffectSupervisorError,
  readHostEffectLifecycle,
  type HostEffectCancellationSignal
} from './index';

class Runtime {
  public now = 0;
  public cancelled = 0;
  private next = 0;
  private readonly tasks = new Map<
    number,
    { readonly at: number; readonly callback: () => void }
  >();
  public readonly clock = { now: () => this.now };
  public readonly scheduler = {
    schedule: (delay: number, callback: () => void) => {
      const id = ++this.next;
      this.tasks.set(id, { at: this.now + delay, callback });
      return {
        cancel: () => {
          this.cancelled += this.tasks.delete(id) ? 1 : 0;
        }
      };
    }
  };
  public advance(milliseconds: number): void {
    this.now += milliseconds;
    while (true) {
      const due = [...this.tasks.entries()].find(([, task]) => task.at <= this.now);
      if (due === undefined) return;
      this.tasks.delete(due[0]);
      due[1].callback();
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function setup(runtime: Runtime, max = 2, perOwner = 1) {
  const pool = createHostEffectAdmissionPool({
    clock: runtime.clock,
    maxConcurrentEffects: max,
    maxConcurrentEffectsPerOwner: perOwner
  });
  const options = () =>
    createHostEffectSupervisorOptions({ admissionPool: pool, scheduler: runtime.scheduler });
  return {
    left: new HostEffectSupervisor(options()),
    pool,
    right: new HostEffectSupervisor(options())
  };
}

function cancellation(initial = false) {
  let aborted = initial;
  const listeners = new Set<() => void>();
  let adds = 0;
  let removes = 0;
  const port: HostEffectCancellationSignal = {
    isAborted: () => aborted,
    addAbortListener: (listener) => {
      adds += 1;
      listeners.add(listener);
    },
    removeAbortListener: (listener) => {
      removes += 1;
      listeners.delete(listener);
    }
  };
  return {
    abort: () => {
      aborted = true;
      for (const listener of [...listeners]) listener();
    },
    counts: () => ({ adds, listeners: listeners.size, removes }),
    port
  };
}

describe('HostEffectSupervisor', () => {
  it('enforces process, owner, quarantine, status, and generation across supervisors', async () => {
    const runtime = new Runtime();
    const { left, pool, right } = setup(runtime, 1, 1);
    const pending = deferred<number>();
    const owner = { run: () => pending.promise };
    const caller = left.run(owner, 'run', [], { deadlineMs: 10 });
    await expect(right.run(owner, 'run')).rejects.toMatchObject({ code: 'OWNER_CAPACITY_REACHED' });
    expect(readHostEffectLifecycle(pool, owner)).toEqual({
      activeProcessReservations: 1,
      lastObservedNowMs: 0,
      owner: { activeReservations: 1, generation: 1, quarantined: false }
    });
    runtime.advance(10);
    await expect(caller).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    await expect(right.run(owner, 'run')).rejects.toMatchObject({ code: 'OWNER_QUARANTINED' });
    pending.resolve(1);
    await Promise.resolve();
    right.recoverOwner(owner);
    let contextGeneration = 0;
    owner.run = (context: { ownerGeneration: number }) =>
      (contextGeneration = context.ownerGeneration);
    await expect(right.run(owner, 'run')).resolves.toBe(2);
    expect(contextGeneration).toBe(2);
  });

  it('provides immutable bounded cancellation subscriptions with a stable supervisor-owned reason', async () => {
    const runtime = new Runtime();
    const { left } = setup(runtime);
    const pending = deferred<void>();
    let context:
      | {
          cancellation: {
            isCancellationRequested(): boolean;
            reason(): unknown;
            subscribe(listener: (reason: string) => void): () => void;
          };
        }
      | undefined;
    const caller = left.run(
      {
        run: (received) => {
          context = received;
          return pending.promise;
        }
      },
      'run',
      [],
      { deadlineMs: 10 }
    );
    expect(Object.isFrozen(context)).toBe(true);
    expect(context).toMatchObject({ ownerGeneration: 1 });
    expect(Object.isFrozen(context?.cancellation)).toBe(true);
    expect(context?.cancellation.isCancellationRequested()).toBe(false);
    const notifications: string[] = [];
    context?.cancellation.subscribe((reason) => notifications.push(reason));
    const removed: string[] = [];
    const unsubscribe = context?.cancellation.subscribe((reason) => removed.push(reason));
    unsubscribe?.();
    for (let index = 0; index < 31; index += 1) context?.cancellation.subscribe(() => undefined);
    expect(() => context?.cancellation.subscribe(() => undefined)).toThrow(/subscriber limit/);
    runtime.advance(10);
    await expect(caller).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    expect(notifications).toEqual(['deadline-exceeded']);
    expect(removed).toEqual([]);
    expect(context?.cancellation.reason()).toBe('deadline-exceeded');
    expect(context?.cancellation.isCancellationRequested()).toBe(true);
    const late: string[] = [];
    context?.cancellation.subscribe((reason) => late.push(reason));
    expect(late).toEqual([]);
    pending.resolve();
    await Promise.resolve();
  });

  it('marks contexts across distinct deadline windows while retaining reservations until late settlement', async () => {
    const runtime = new Runtime();
    const { left, pool, right } = setup(runtime, 3, 3);
    const waits = [deferred<void>(), deferred<void>(), deferred<void>()];
    const contexts: { cancellation: { isCancellationRequested(): boolean; reason(): unknown } }[] =
      [];
    let index = 0;
    const owner = {
      run: (context: {
        cancellation: { isCancellationRequested(): boolean; reason(): unknown };
      }) => {
        contexts.push(context);
        return waits[index++]?.promise;
      }
    };
    const callers = [
      left.run(owner, 'run', [], { deadlineMs: 5 }),
      left.run(owner, 'run', [], { deadlineMs: 10 }),
      left.run(owner, 'run', [], { deadlineMs: 15 })
    ];
    runtime.advance(5);
    expect(contexts.map((context) => context.cancellation.reason())).toEqual([
      'deadline-exceeded',
      undefined,
      undefined
    ]);
    runtime.advance(5);
    runtime.advance(5);
    await expect(Promise.allSettled(callers)).resolves.toHaveLength(3);
    expect(contexts.map((context) => context.cancellation.isCancellationRequested())).toEqual([
      true,
      true,
      true
    ]);
    expect(readHostEffectLifecycle(pool, owner).owner).toMatchObject({
      activeReservations: 3,
      quarantined: true
    });
    await expect(right.run({ run: () => 1 }, 'run')).rejects.toMatchObject({
      code: 'PROCESS_CAPACITY_REACHED'
    });
    waits[0]?.resolve();
    waits[1]?.reject(new Error('late'));
    waits[2]?.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(readHostEffectLifecycle(pool, owner).owner.activeReservations).toBe(0);
  });

  it('captures config, timer, signal, and owner methods without trusting external supervisor errors', async () => {
    const runtime = new Runtime();
    const external = new HostEffectSupervisorError('OWNER_QUARANTINED');
    const pool = createHostEffectAdmissionPool({
      clock: runtime.clock,
      maxConcurrentEffects: 1,
      maxConcurrentEffectsPerOwner: 1
    });
    const clockErrorPool = createHostEffectAdmissionPool({
      clock: {
        now: () => {
          throw external;
        }
      },
      maxConcurrentEffects: 1,
      maxConcurrentEffectsPerOwner: 1
    });
    const options = createHostEffectSupervisorOptions({
      admissionPool: clockErrorPool,
      scheduler: runtime.scheduler
    });
    await expect(
      new HostEffectSupervisor(options).run({ run: () => 1 }, 'run')
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    expect(() => new HostEffectSupervisor(new Proxy(options, {}))).toThrow(/configuration/);
    expect(() =>
      createHostEffectSupervisorOptions({
        admissionPool: pool,
        scheduler: new Proxy(runtime.scheduler, {
          ownKeys: () => {
            throw external;
          }
        })
      })
    ).toThrow(/configuration/);
    let reads = 0;
    const owner = Object.create(null, {
      run: {
        get: () => {
          reads += 1;
          return () => 1;
        }
      }
    });
    await expect(
      new HostEffectSupervisor(
        createHostEffectSupervisorOptions({ admissionPool: pool, scheduler: runtime.scheduler })
      ).run(owner, 'run')
    ).rejects.toMatchObject({ code: 'INVALID_EFFECT_METHOD' });
    expect(reads).toBe(0);
  });

  it('handles hostile signal setup, timer callbacks and cleanup without a caller hang', async () => {
    const runtime = new Runtime();
    const { left } = setup(runtime);
    const pending = deferred<void>();
    const control = cancellation();
    const caller = left.run({ run: () => pending.promise }, 'run', [], {
      deadlineMs: 10,
      signal: control.port
    });
    control.abort();
    control.abort();
    await expect(caller).rejects.toMatchObject({ code: 'CALLER_ABORTED' });
    expect(control.counts()).toEqual({ adds: 1, listeners: 0, removes: 1 });
    expect(runtime.cancelled).toBe(1);
    pending.resolve();
    await Promise.resolve();

    const hostile = {
      isAborted: () => false,
      addAbortListener: () => {
        throw new HostEffectSupervisorError('OWNER_QUARANTINED');
      },
      removeAbortListener: () => undefined
    };
    await expect(left.run({ run: () => 1 }, 'run', [], { signal: hostile })).rejects.toMatchObject({
      code: 'INVALID_OPTIONS'
    });
  });

  it('handles scheduler sync callback, invalid handle, sync throw, hostile thenable, and monotonic rollback', async () => {
    const runtime = new Runtime();
    let calls = 0;
    let repeated: (() => void) | undefined;
    let cancels = 0;
    const pool = createHostEffectAdmissionPool({
      clock: runtime.clock,
      maxConcurrentEffects: 1,
      maxConcurrentEffectsPerOwner: 1
    });
    const sync = new HostEffectSupervisor(
      createHostEffectSupervisorOptions({
        admissionPool: pool,
        scheduler: {
          schedule: (_delay, callback) => {
            repeated = callback;
            callback();
            return { cancel: () => (cancels += 1) };
          }
        }
      })
    );
    await expect(
      sync.run({ run: () => ++calls }, 'run', [], { deadlineMs: 1 })
    ).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    expect(calls).toBe(0);
    repeated?.();
    repeated?.();
    expect(cancels).toBe(1);
    const invalid = new HostEffectSupervisor(
      createHostEffectSupervisorOptions({
        admissionPool: pool,
        scheduler: { schedule: () => ({}) }
      })
    );
    await expect(invalid.run({ run: () => 1 }, 'run', [], { deadlineMs: 1 })).rejects.toMatchObject(
      { code: 'INVALID_CONFIGURATION' }
    );
    await expect(
      sync.run(
        {
          run: () => {
            throw new Error('secret');
          }
        },
        'run'
      )
    ).rejects.toMatchObject({ code: 'EFFECT_FAILED' });
    await expect(
      sync.run(
        {
          run: () => {
            throw new HostEffectSupervisorError('OWNER_QUARANTINED');
          }
        },
        'run'
      )
    ).rejects.toMatchObject({ code: 'EFFECT_FAILED' });
    await expect(
      sync.run(
        {
          run: () =>
            Object.create(null, {
              then: {
                get: () => {
                  throw new Error('secret');
                }
              }
            })
        },
        'run'
      )
    ).rejects.toMatchObject({ code: 'EFFECT_FAILED' });
    runtime.now = 5;
    await expect(sync.run({ run: () => 1 }, 'run')).resolves.toBe(1);
    runtime.now = 4;
    await expect(sync.run({ run: () => 1 }, 'run')).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION'
    });
  });

  it('runtime-validates exported error codes and rejects hostile argument collections before effects start', async () => {
    expect(() => new HostEffectSupervisorError('not-a-code')).toThrow(/code is invalid/);
    const runtime = new Runtime();
    const { left } = setup(runtime);
    let calls = 0;
    const owner = { run: () => ++calls };
    await expect(left.run(owner, 'run', new Array(1))).rejects.toMatchObject({
      code: 'INVALID_OPTIONS'
    });
    const accessor: unknown[] = [];
    accessor.length = 1;
    let reads = 0;
    Object.defineProperty(accessor, '0', {
      get: () => {
        reads += 1;
        return 'unsafe';
      }
    });
    await expect(left.run(owner, 'run', accessor)).rejects.toMatchObject({
      code: 'INVALID_OPTIONS'
    });
    await expect(
      left.run(
        owner,
        'run',
        new Proxy(['unsafe'], {
          getOwnPropertyDescriptor: () => {
            throw new Error('proxy');
          }
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(reads).toBe(0);
    expect(calls).toBe(0);
  });

  it('rejects accessor and cyclic configuration records without evaluating accessors', () => {
    const runtime = new Runtime();
    const { pool } = setup(runtime);
    let reads = 0;
    const hostile = Object.create(Object.prototype, {
      admissionPool: { value: pool },
      scheduler: {
        get: () => {
          reads += 1;
          return runtime.scheduler;
        }
      }
    });
    expect(() => createHostEffectSupervisorOptions(hostile)).toThrow(/configuration/);
    expect(reads).toBe(0);
    const cyclic: Record<string, unknown> = { admissionPool: pool, scheduler: runtime.scheduler };
    cyclic.scheduler = cyclic;
    expect(() => createHostEffectSupervisorOptions(cyclic)).toThrow(/configuration/);
  });

  it('rejects pre-aborted and forged caller signals before effects start', async () => {
    const runtime = new Runtime();
    const { left } = setup(runtime);
    let calls = 0;
    const owner = { run: () => ++calls };
    await expect(
      left.run(owner, 'run', [], { signal: cancellation(true).port })
    ).rejects.toMatchObject({
      code: 'CALLER_ABORTED'
    });
    await expect(
      left.run(owner, 'run', [], {
        signal: {
          isAborted: () => 'false',
          addAbortListener: () => undefined,
          removeAbortListener: () => undefined
        }
      })
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(calls).toBe(0);
  });

  it('uses Reflect.apply for owner methods and makes hostile timer cleanup nonthrowing', async () => {
    const runtime = new Runtime();
    const pool = createHostEffectAdmissionPool({
      clock: runtime.clock,
      maxConcurrentEffects: 1,
      maxConcurrentEffectsPerOwner: 1
    });
    const bounded = new HostEffectSupervisor(
      createHostEffectSupervisorOptions({
        admissionPool: pool,
        scheduler: {
          schedule: () => ({
            cancel: () => {
              throw new Error('cleanup');
            }
          })
        }
      })
    );
    const method = function (this: unknown, context: { ownerGeneration: number }, value: string) {
      return { owner: this, generation: context.ownerGeneration, value };
    };
    Object.defineProperty(method, 'apply', {
      value: () => {
        throw new Error('apply');
      }
    });
    const owner = { run: method };
    await expect(bounded.run(owner, 'run', ['safe'], { deadlineMs: 10 })).resolves.toEqual({
      owner,
      generation: 1,
      value: 'safe'
    });
  });

  it('closes retained contexts after successful settlement so new listeners are not stored', async () => {
    const runtime = new Runtime();
    const { left } = setup(runtime);
    let context:
      { cancellation: { subscribe(listener: (reason: string) => void): () => void } } | undefined;
    await expect(
      left.run(
        {
          run: (received) => {
            context = received;
            return 'settled';
          }
        },
        'run'
      )
    ).resolves.toBe('settled');
    const calls: string[] = [];
    const unsubscribe = context?.cancellation.subscribe((reason) => calls.push(reason));
    unsubscribe?.();
    expect(calls).toEqual([]);
  });

  it('makes self-resubscription after cancellation a no-op while preserving the stable reason', async () => {
    const runtime = new Runtime();
    const { left } = setup(runtime);
    const pending = deferred<void>();
    let context:
      | {
          cancellation: {
            reason(): unknown;
            subscribe(listener: (reason: string) => void): () => void;
          };
        }
      | undefined;
    const caller = left.run(
      {
        run: (received) => {
          context = received;
          return pending.promise;
        }
      },
      'run',
      [],
      { deadlineMs: 5 }
    );
    let calls = 0;
    const listener = () => {
      calls += 1;
      context?.cancellation.subscribe(listener);
    };
    context?.cancellation.subscribe(listener);
    runtime.advance(5);
    await expect(caller).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    expect(calls).toBe(1);
    expect(context?.cancellation.reason()).toBe('deadline-exceeded');
    pending.resolve();
    await Promise.resolve();
  });

  it('rejects recovery while an owner remains actively reserved', async () => {
    const runtime = new Runtime();
    const { left, right } = setup(runtime, 1, 1);
    const pending = deferred<void>();
    const owner = { run: () => pending.promise };
    const caller = left.run(owner, 'run', [], { deadlineMs: 5 });
    runtime.advance(5);
    await expect(caller).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    const generation = left.status(owner).generation;
    try {
      right.recoverOwner(owner);
      throw new Error('expected active owner recovery to fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'OWNER_STILL_ACTIVE' });
    }
    expect(right.status(owner).generation).toBe(generation);
    pending.resolve();
    await Promise.resolve();
    expect(() => right.recoverOwner(owner)).not.toThrow();
  });

  it('rejects more than one hundred cross-supervisor reentries while one quarantined call remains live', async () => {
    const runtime = new Runtime();
    const { left, pool, right } = setup(runtime, 2, 1);
    let calls = 0;
    const pending = deferred<void>();
    const owner = {
      run: () => {
        calls += 1;
        return pending.promise;
      }
    };
    const caller = left.run(owner, 'run', [], { deadlineMs: 5 });
    runtime.advance(5);
    await expect(caller).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    await Array.from({ length: 128 }).reduce(
      (previous, _, index) =>
        previous.then(() => {
          const supervisor = index % 2 === 0 ? left : right;
          return expect(supervisor.run(owner, 'run')).rejects.toMatchObject({
            code: 'OWNER_QUARANTINED'
          });
        }),
      Promise.resolve()
    );
    expect(calls).toBe(1);
    expect(readHostEffectLifecycle(pool, owner).owner).toEqual({
      activeReservations: 1,
      generation: 1,
      quarantined: true
    });
    pending.resolve();
    await Promise.resolve();
  });

  it('publishes caller-abort cooperative reason and drains its late settlement', async () => {
    const runtime = new Runtime();
    const { left, pool } = setup(runtime, 1, 1);
    const control = cancellation();
    const pending = deferred<void>();
    const reasons: string[] = [];
    const owner = {
      run: (context: {
        cancellation: { subscribe(listener: (reason: string) => void): () => void };
      }) => {
        context.cancellation.subscribe((reason) => {
          reasons.push(reason);
          pending.resolve();
        });
        return pending.promise;
      }
    };
    const caller = left.run(owner, 'run', [], { signal: control.port });
    control.abort();
    await expect(caller).rejects.toMatchObject({ code: 'CALLER_ABORTED' });
    expect(reasons).toEqual(['caller-aborted']);
    await Promise.resolve();
    expect(readHostEffectLifecycle(pool, owner).owner.activeReservations).toBe(0);
  });

  it('cleans an add-then-throw signal listener without starting the effect', async () => {
    const runtime = new Runtime();
    const { left } = setup(runtime);
    const listeners = new Set<() => void>();
    let removes = 0;
    let calls = 0;
    const signal = {
      isAborted: () => false,
      addAbortListener: (listener: () => void) => {
        listeners.add(listener);
        throw new Error('after add');
      },
      removeAbortListener: (listener: () => void) => {
        removes += 1;
        listeners.delete(listener);
      }
    };
    await expect(left.run({ run: () => ++calls }, 'run', [], { signal })).rejects.toMatchObject({
      code: 'INVALID_OPTIONS'
    });
    expect({ calls, listeners: listeners.size, removes }).toEqual({
      calls: 0,
      listeners: 0,
      removes: 1
    });
  });

  it('normalizes scheduler throws and still removes the caller listener', async () => {
    const runtime = new Runtime();
    await Promise.all(
      [new Error('scheduler secret'), new HostEffectSupervisorError('OWNER_QUARANTINED')].map(
        async (thrown) => {
          const pool = createHostEffectAdmissionPool({
            clock: runtime.clock,
            maxConcurrentEffects: 1,
            maxConcurrentEffectsPerOwner: 1
          });
          const supervisor = new HostEffectSupervisor(
            createHostEffectSupervisorOptions({
              admissionPool: pool,
              scheduler: {
                schedule: () => {
                  throw thrown;
                }
              }
            })
          );
          const control = cancellation();
          await expect(
            supervisor.run({ run: () => 1 }, 'run', [], { deadlineMs: 5, signal: control.port })
          ).rejects.toMatchObject({
            code: 'INVALID_CONFIGURATION'
          });
          expect(control.counts()).toEqual({ adds: 1, listeners: 0, removes: 1 });
        }
      )
    );
  });

  it('returns only the exact redacted failure error for provider rejection', async () => {
    const runtime = new Runtime();
    const failure = await setup(runtime)
      .left.run({ run: () => Promise.reject(new Error('token=secret provider detail')) }, 'run')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HostEffectSupervisorError);
    expect(failure).toMatchObject({ code: 'EFFECT_FAILED', message: 'host effect failed' });
    expect(String((failure as Error).message)).not.toContain('secret');
  });

  it('rejects oversized, malformed, and proxy request inputs before an effect starts', async () => {
    const runtime = new Runtime();
    const { left } = setup(runtime);
    let calls = 0;
    const owner = { run: () => ++calls };
    await expect(left.run(owner, 'run', Array.from({ length: 65 }))).rejects.toMatchObject({
      code: 'INVALID_OPTIONS'
    });
    await expect(
      left.run(owner, 'run', [], { deadlineMs: 1, extra: true } as never)
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    let requestReads = 0;
    const accessorRequest = Object.create(Object.prototype, {
      deadlineMs: {
        get: () => {
          requestReads += 1;
          return 1;
        }
      }
    });
    await expect(left.run(owner, 'run', [], accessorRequest as never)).rejects.toMatchObject({
      code: 'INVALID_OPTIONS'
    });
    await expect(
      left.run(
        owner,
        'run',
        [],
        new Proxy(
          {},
          {
            ownKeys: () => {
              throw new Error('proxy');
            }
          }
        ) as never
      )
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    expect({ calls, requestReads }).toEqual({ calls: 0, requestReads: 0 });
  });

  it('rejects a scheduler cancel-descriptor proxy without starting the effect', async () => {
    const runtime = new Runtime();
    const pool = createHostEffectAdmissionPool({
      clock: runtime.clock,
      maxConcurrentEffects: 1,
      maxConcurrentEffectsPerOwner: 1
    });
    const supervisor = new HostEffectSupervisor(
      createHostEffectSupervisorOptions({
        admissionPool: pool,
        scheduler: {
          schedule: () =>
            new Proxy(
              { cancel: () => undefined },
              {
                getOwnPropertyDescriptor: () => {
                  throw new Error('cancel descriptor proxy');
                }
              }
            )
        }
      })
    );
    let calls = 0;
    await expect(
      supervisor.run({ run: () => ++calls }, 'run', [], { deadlineMs: 5 })
    ).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION'
    });
    expect(calls).toBe(0);
  });

  it('runs timer and listener cleanup exactly once on both success and failure', async () => {
    const runtime = new Runtime();
    await Promise.all(
      [
        () => 'ok',
        () => {
          throw new Error('failure');
        }
      ].map(async (effect) => {
        let cancels = 0;
        const pool = createHostEffectAdmissionPool({
          clock: runtime.clock,
          maxConcurrentEffects: 1,
          maxConcurrentEffectsPerOwner: 1
        });
        const supervisor = new HostEffectSupervisor(
          createHostEffectSupervisorOptions({
            admissionPool: pool,
            scheduler: { schedule: () => ({ cancel: () => (cancels += 1) }) }
          })
        );
        const control = cancellation();
        await supervisor
          .run({ run: effect }, 'run', [], { deadlineMs: 5, signal: control.port })
          .catch(() => undefined);
        expect({ cancels, ...control.counts() }).toEqual({
          adds: 1,
          cancels: 1,
          listeners: 0,
          removes: 1
        });
      })
    );
  });

  it('drains a late rejection after deadline without changing its stable caller outcome', async () => {
    const runtime = new Runtime();
    const { left, pool } = setup(runtime, 1, 1);
    const pending = deferred<void>();
    const owner = { run: () => pending.promise };
    const caller = left.run(owner, 'run', [], { deadlineMs: 5 });
    runtime.advance(5);
    await expect(caller).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    pending.reject(new Error('late provider secret'));
    await Promise.resolve();
    await Promise.resolve();
    expect(readHostEffectLifecycle(pool, owner).owner).toMatchObject({
      activeReservations: 0,
      quarantined: true
    });
  });

  it('waits for actual late settlement without relying on a caller microtask turn', async () => {
    const runtime = new Runtime();
    const { left, pool } = setup(runtime, 1, 1);
    const pending = deferred<void>();
    const owner = { run: () => pending.promise };
    const caller = left.run(owner, 'run', [], { deadlineMs: 5 });
    runtime.advance(5);
    await expect(caller).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    let settled = false;
    const waiter = left.whenOwnerIdle(owner).then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    pending.resolve();
    await waiter;
    expect(settled).toBe(true);
    expect(readHostEffectLifecycle(pool, owner).owner.activeReservations).toBe(0);
  });

  it('shares one active IdleEpoch across 10k callers and advances it only after every reservation settles', async () => {
    const runtime = new Runtime();
    const { left } = setup(runtime, 2, 2);
    const first = deferred<void>();
    const second = deferred<void>();
    const third = deferred<void>();
    let calls = 0;
    const owner = {
      run: () => {
        calls += 1;
        return calls === 1 ? first.promise : calls === 2 ? second.promise : third.promise;
      }
    };
    const one = left.run(owner, 'run');
    const two = left.run(owner, 'run');
    const epoch = left.whenOwnerIdle(owner);
    expect(Array.from({ length: 10_000 }, () => left.whenOwnerIdle(owner))).toEqual(
      Array.from({ length: 10_000 }, () => epoch)
    );
    first.resolve();
    await one;
    let idle = false;
    void epoch.then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    second.resolve();
    await two;
    await epoch;
    const next = left.run(owner, 'run');
    expect(left.whenOwnerIdle(owner)).not.toBe(epoch);
    third.resolve();
    await next;
  });
});
