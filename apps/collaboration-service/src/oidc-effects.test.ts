import { describe, expect, it } from 'vitest';

import { cancellationFromAbortSignal, createOidcEffectRunner } from './oidc-effects';

function callContext(deadlineMs: number) {
  return {
    remainingDurationMs: deadlineMs,
    cancellation: {
      isCancellationRequested: () => false,
      subscribe: () => () => undefined
    }
  };
}

describe('OIDC effect admission', () => {
  it('removes an abort listener when a hostile add operation throws after registration', () => {
    let added = 0;
    let removed = 0;
    let notified = 0;
    const signal = {
      aborted: false,
      addEventListener(_event: string, listener: () => void) {
        added += 1;
        listener();
        throw new Error('registered then failed');
      },
      removeEventListener(_event: string, _listener: () => void) {
        removed += 1;
      }
    } as unknown as AbortSignal;
    cancellationFromAbortSignal(signal).addAbortListener(() => {
      notified += 1;
    });
    expect(added).toBe(1);
    expect(removed).toBe(1);
    expect(notified).toBe(1);
  });

  it('tracks exact wrappers across replacement, disposal, abort, and hostile removal', () => {
    const listeners = new Set<() => void>();
    let removeFailures = 0;
    const signal = {
      aborted: false,
      addEventListener(_event: string, listener: () => void) {
        listeners.add(listener);
      },
      removeEventListener(_event: string, listener: () => void) {
        if (removeFailures > 0) {
          removeFailures -= 1;
          throw new Error('hostile remove');
        }
        listeners.delete(listener);
      }
    } as unknown as AbortSignal;
    const bridge = cancellationFromAbortSignal(signal);
    const listener = () => undefined;
    bridge.addAbortListener(listener);
    expect(listeners.size).toBe(1);
    bridge.addAbortListener(listener);
    expect(listeners.size).toBe(1);
    bridge.removeAbortListener(listener);
    expect(listeners.size).toBe(0);

    let throws = 0;
    bridge.addAbortListener(() => {
      throws += 1;
      throw new Error('listener failure');
    });
    expect(() => [...listeners][0]?.()).toThrow('listener failure');
    expect(throws).toBe(1);
    expect(listeners.size).toBe(0);

    removeFailures = 1;
    let disposedCalls = 0;
    bridge.addAbortListener(listener);
    bridge.removeAbortListener(listener);
    expect(listeners.size).toBe(1);
    for (const callback of [...listeners]) callback();
    expect(disposedCalls).toBe(0);
    bridge.removeAbortListener(listener);
    expect(listeners.size).toBe(1);

    const disposedListener = () => {
      disposedCalls += 1;
    };
    bridge.addAbortListener(disposedListener);
    bridge.removeAbortListener(disposedListener);
    bridge.removeAbortListener(disposedListener);
    for (const callback of [...listeners]) callback();
    expect(disposedCalls).toBe(0);

    const aborted = { ...signal, aborted: true } as unknown as AbortSignal;
    let immediate = 0;
    cancellationFromAbortSignal(aborted).addAbortListener(() => {
      immediate += 1;
    });
    expect(immediate).toBe(1);

    const cappedListeners = new Set<() => void>();
    const cappedSignal = {
      aborted: false,
      addEventListener(_event: string, callback: () => void) {
        cappedListeners.add(callback);
      },
      removeEventListener(_event: string, callback: () => void) {
        cappedListeners.delete(callback);
      }
    } as unknown as AbortSignal;
    let cappedImmediate = 0;
    const capped = cancellationFromAbortSignal(cappedSignal);
    for (let index = 0; index < 129; index += 1)
      capped.addAbortListener(() => {
        cappedImmediate += 1;
      });
    expect(cappedListeners.size).toBe(128);
    expect(cappedImmediate).toBe(1);
  });

  it('automatically recovers a timed-out owner only after its abandoned adapter settles', async () => {
    let now = 0;
    const tasks: { at: number; task: () => void }[] = [];
    const runner = createOidcEffectRunner({
      clock: { now: () => now },
      deadlineMs: 5,
      scheduler: {
        schedule(delayMs, task) {
          const entry = { at: now + delayMs, task };
          tasks.push(entry);
          return { cancel: () => tasks.splice(tasks.indexOf(entry), 1) };
        }
      }
    });
    let release!: () => void;
    let calls = 0;
    const hung = {
      run() {
        calls += 1;
        if (calls > 1) return Promise.resolve();
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    };
    const healthy = { run: () => Promise.resolve('available') };
    const first = runner.run<void>(hung, 'run', [], callContext(5));
    now = 5;
    for (const pending of [...tasks]) pending.task();
    await expect(first).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    await expect(runner.run(hung, 'run', [], callContext(5))).rejects.toMatchObject({
      code: 'OWNER_QUARANTINED'
    });
    await expect(runner.run(healthy, 'run', [], callContext(5))).resolves.toBe('available');
    release();
    await Promise.resolve();
    await expect(runner.run(hung, 'run', [], callContext(5))).resolves.toBeUndefined();
  });

  it('caps configured and inherited duration while accepting a portable remaining duration', async () => {
    expect(() => createOidcEffectRunner({ deadlineMs: 60_001 })).toThrow('options are invalid');
    const scheduled: number[] = [];
    const runner = createOidcEffectRunner({
      clock: { now: () => 10 },
      deadlineMs: 10,
      scheduler: {
        schedule(delayMs) {
          scheduled.push(delayMs);
          return { cancel: () => undefined };
        }
      }
    });
    await expect(
      runner.run({ run: () => undefined }, 'run', [], {
        remainingDurationMs: 60_001,
        cancellation: { isCancellationRequested: () => false, subscribe: () => () => undefined }
      })
    ).rejects.toThrow();
    await expect(
      runner.run({ run: () => undefined }, 'run', [], {
        remainingDurationMs: 3,
        cancellation: { isCancellationRequested: () => false, subscribe: () => () => undefined }
      })
    ).resolves.toBeUndefined();
    await expect(
      runner.run({ run: () => undefined }, 'run', [], {
        remainingDurationMs: 10,
        cancellation: { isCancellationRequested: () => false, subscribe: () => () => undefined }
      })
    ).resolves.toBeUndefined();
    expect(scheduled).toEqual(expect.arrayContaining([3, 10]));
    await expect(
      runner.run({ run: () => undefined }, 'run', [], {
        remainingDurationMs: 0,
        cancellation: { isCancellationRequested: () => false, subscribe: () => () => undefined }
      })
    ).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
  });

  it('takes hostile option and context data snapshots once and captures prototype methods', async () => {
    const hostile = {} as { clock?: { now(): number } };
    Object.defineProperty(hostile, 'clock', { get: () => ({ now: () => 1 }) });
    expect(() => createOidcEffectRunner(hostile)).toThrow('options are invalid');

    class Cancellation {
      public isCancellationRequested(): boolean {
        return false;
      }
      public subscribe(): () => void {
        return () => undefined;
      }
    }
    const clock = { now: () => 1 };
    const runner = createOidcEffectRunner({ clock });
    clock.now = () => {
      throw new Error('captured clock was reread');
    };
    const context = {
      remainingDurationMs: 1,
      cancellation: new Cancellation()
    };
    await expect(runner.run({ run: () => undefined }, 'run', [], context)).resolves.toBeUndefined();
    const hostileContext = {} as { cancellation?: Cancellation };
    Object.defineProperty(hostileContext, 'cancellation', { get: () => new Cancellation() });
    await expect(runner.run({ run: () => undefined }, 'run', [], hostileContext)).rejects.toThrow();
  });

  it('captures cancellation methods in one bounded traversal and fences hostile cycles', async () => {
    let descriptorPasses = 0;
    const target = {
      isCancellationRequested: () => false,
      subscribe: () => () => undefined
    };
    const cancellation = new Proxy(target, {
      ownKeys(current) {
        descriptorPasses += 1;
        return Reflect.ownKeys(current);
      }
    });
    const runner = createOidcEffectRunner();
    await expect(
      runner.run({ run: () => undefined }, 'run', [], {
        remainingDurationMs: 1,
        cancellation
      })
    ).resolves.toBeUndefined();
    expect(descriptorPasses).toBe(0);

    let cyclePasses = 0;
    const cycle = new Proxy(
      {},
      {
        ownKeys() {
          cyclePasses += 1;
          return [];
        },
        getPrototypeOf() {
          return cycle;
        }
      }
    );
    await expect(
      runner.run({ run: () => undefined }, 'run', [], {
        remainingDurationMs: 1,
        cancellation: cycle as never
      })
    ).rejects.toThrow('OIDC cancellation port is invalid');
    expect(cyclePasses).toBe(0);
  });

  it('rejects oversized aggregate descriptor maps before following a port prototype', () => {
    const clock = Object.create(null) as Record<string, unknown>;
    for (let index = 0; index < 65; index += 1) clock[`noise${index}`] = index;
    expect(() => createOidcEffectRunner({ clock: clock as never })).toThrow(
      'OIDC effect runner options are invalid'
    );
  });
});
