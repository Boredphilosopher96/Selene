import { describe, expect, it } from 'vitest';

import {
  recoverAdapterGeneration,
  replaceAdapterGeneration,
  streamValidatedEvents,
  type AgentAdapter,
  type EventEnvelope
} from '@selene/agent-sdk';
import {
  createHostEffectAdmissionPool,
  createHostEffectSupervisorOptions,
  HostEffectSupervisor
} from '@selene/host-runtime';

import { createDesktopAgentProviderRuntime } from './agent-provider-runtime';

class Runtime {
  public now = 0;
  private next = 0;
  private readonly tasks = new Map<number, { readonly at: number; readonly task: () => void }>();
  public readonly clock = { now: () => this.now };
  public readonly scheduler = {
    schedule: (delayMs: number, task: () => void) => {
      const id = ++this.next;
      this.tasks.set(id, { at: this.now + delayMs, task });
      return { cancel: () => this.tasks.delete(id) };
    }
  };
  public advance(delayMs: number): void {
    this.now += delayMs;
    for (const [id, due] of [...this.tasks]) {
      if (due.at <= this.now) {
        this.tasks.delete(id);
        due.task();
      }
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function cancellation() {
  let aborted = false;
  const listeners = new Set<() => void>();
  return {
    port: {
      isAborted: () => aborted,
      addAbortListener: (listener: () => void) => listeners.add(listener),
      removeAbortListener: (listener: () => void) => listeners.delete(listener)
    },
    abort: () => {
      aborted = true;
      for (const listener of [...listeners]) listener();
    }
  };
}

describe('desktop agent provider runtime', () => {
  it('preserves shared pool outcomes, stable owners, cancellation, deadlines, quarantine, and late settlement', async () => {
    const clock = new Runtime();
    const pool = createHostEffectAdmissionPool({
      clock: clock.clock,
      maxConcurrentEffects: 1,
      maxConcurrentEffectsPerOwner: 1
    });
    const supervisor = new HostEffectSupervisor(
      createHostEffectSupervisorOptions({ admissionPool: pool, scheduler: clock.scheduler })
    );
    const runtime = createDesktopAgentProviderRuntime(supervisor, clock.clock);
    expect(createDesktopAgentProviderRuntime(supervisor, clock.clock)).toBe(runtime);
    expect(() => runtime.replaceGeneration({})).toThrow(/runtime rejected/);
    expect(() => runtime.recover({})).toThrow(/runtime rejected/);
    await expect(
      runtime.run({}, () => 1, { timeoutMs: 1, owner: {} } as never)
    ).rejects.toMatchObject({ code: 'EFFECT_FAILED' });

    let receivedGeneration = 0;
    let receivedRemaining: number | undefined;
    const stream = streamValidatedEvents(
      {
        capabilities: ['project.inspect'],
        async *stream(context, execution) {
          receivedGeneration = context.ownerGeneration;
          receivedRemaining = context.remainingMs;
          yield {
            protocolVersion: '1.0' as const,
            kind: 'event' as const,
            messageId: 'desktop-1',
            sentAt: '2026-07-24T00:00:00Z',
            requestId: execution.requestId,
            event: 'completed'
          };
        }
      },
      { requestId: 'request-1', capability: 'project.inspect', input: {} },
      { runtime, timeoutMs: 11 }
    );
    await expect(stream[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { event: 'completed' }
    });
    expect(receivedGeneration).toBeGreaterThan(0);
    expect(receivedRemaining).toBe(11);

    const owner = {};
    const active = deferred<number>();
    const first = runtime.run(owner, () => active.promise);
    expect(() => runtime.replaceGeneration(owner)).toThrow(/runtime rejected/);
    await expect(runtime.run({}, () => 2)).rejects.toMatchObject({
      code: 'PROCESS_CAPACITY_REACHED'
    });
    await expect(runtime.run(owner, () => 2)).rejects.toMatchObject({
      code: 'OWNER_CAPACITY_REACHED'
    });
    active.resolve(1);
    await expect(first).resolves.toBe(1);

    const aborted = cancellation();
    const cancellationPending = deferred<void>();
    const reasons: string[] = [];
    const cancelled = runtime.run(
      {},
      (context) => {
        context.cancellation.subscribe((reason) => reasons.push(reason));
        return cancellationPending.promise;
      },
      { cancellation: aborted.port }
    );
    aborted.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'CALLER_ABORTED' });
    expect(reasons).toEqual(['caller-aborted']);
    cancellationPending.resolve();
    await Promise.resolve();

    const lateOwner = {};
    const late = deferred<void>();
    const deadlineOptions = { timeoutMs: 10 };
    const deadline = runtime.run(lateOwner, () => late.promise, deadlineOptions);
    deadlineOptions.timeoutMs = 1_000;
    clock.advance(10);
    await expect(deadline).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    await expect(runtime.run(lateOwner, () => undefined)).rejects.toMatchObject({
      code: 'OWNER_QUARANTINED'
    });
    expect(() => runtime.replaceGeneration(lateOwner)).toThrow(/runtime rejected/);
    late.resolve();
    await Promise.resolve();
    expect(() => runtime.replaceGeneration(lateOwner)).not.toThrow();
    expect(() => runtime.replaceGeneration(lateOwner)).toThrow(/runtime rejected/);
  });

  it('fences abandoned generations, performs cleanup on a replacement owner, and isolates others', async () => {
    const clock = new Runtime();
    const pool = createHostEffectAdmissionPool({
      clock: clock.clock,
      maxConcurrentEffects: 2,
      maxConcurrentEffectsPerOwner: 1
    });
    const supervisor = new HostEffectSupervisor(
      createHostEffectSupervisorOptions({ admissionPool: pool, scheduler: clock.scheduler })
    );
    const runtime = createDesktopAgentProviderRuntime(supervisor, clock.clock);
    const next = deferred<IteratorResult<EventEnvelope>>();
    const returned = deferred<IteratorResult<EventEnvelope>>();
    let returns = 0;
    let restart = false;
    const adapter: AgentAdapter = {
      capabilities: ['project.inspect'],
      stream(executionContext, execution) {
        if (restart) {
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                protocolVersion: '1.0' as const,
                kind: 'event' as const,
                messageId: 'restarted',
                sentAt: '2026-07-24T00:00:00Z',
                requestId: execution.requestId,
                event: 'completed' as const
              };
            }
          };
        }
        void executionContext;
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => next.promise,
              return: (_value?: unknown) => {
                returns += 1;
                return returned.promise;
              }
            };
          }
        };
      }
    };
    const stalledStream = streamValidatedEvents(
      adapter,
      { requestId: 'stalled', capability: 'project.inspect', input: {} },
      { runtime, timeoutMs: 5 }
    );
    const pending = stalledStream[Symbol.asyncIterator]().next();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    clock.advance(5);
    await expect(pending).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(returns).toBe(1);
    clock.advance(5);
    next.resolve({ done: true, value: undefined });
    returned.resolve({ done: true, value: undefined });
    await Promise.resolve();
    await Promise.resolve();
    const unrelated = streamValidatedEvents(
      {
        capabilities: ['project.inspect'],
        async *stream(_context, execution) {
          yield {
            protocolVersion: '1.0' as const,
            kind: 'event' as const,
            messageId: 'unrelated',
            sentAt: '2026-07-24T00:00:00Z',
            requestId: execution.requestId,
            event: 'completed' as const
          };
        }
      },
      { requestId: 'unrelated', capability: 'project.inspect', input: {} },
      { runtime }
    )[Symbol.asyncIterator]();
    await expect(unrelated.next()).resolves.toMatchObject({ value: { event: 'completed' } });
    restart = true;
    replaceAdapterGeneration(adapter, runtime);
    const resumed = streamValidatedEvents(
      adapter,
      { requestId: 'restarted', capability: 'project.inspect', input: {} },
      { runtime }
    )[Symbol.asyncIterator]();
    await expect(resumed.next()).resolves.toMatchObject({ value: { event: 'completed' } });
  });

  it('serializes cleanup on one generation and blocks replacement until all cleanup settles', async () => {
    const clock = new Runtime();
    const pool = createHostEffectAdmissionPool({
      clock: clock.clock,
      maxConcurrentEffects: 2,
      maxConcurrentEffectsPerOwner: 1
    });
    const supervisor = new HostEffectSupervisor(
      createHostEffectSupervisorOptions({ admissionPool: pool, scheduler: clock.scheduler })
    );
    const runtime = createDesktopAgentProviderRuntime(supervisor, clock.clock);
    const owner = {};
    const late = deferred<void>();
    const abandoned = runtime.run(owner, () => late.promise, { timeoutMs: 5 });
    clock.advance(5);
    await expect(abandoned).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });

    const cleanup = deferred<void>();
    const firstCleanup = runtime.runCleanup(owner, () => cleanup.promise);
    await expect(runtime.runCleanup(owner, () => undefined)).rejects.toMatchObject({
      code: 'OWNER_CAPACITY_REACHED'
    });
    late.resolve();
    await Promise.resolve();
    expect(() => runtime.replaceGeneration(owner)).toThrow(/runtime rejected/);
    cleanup.resolve();
    await expect(firstCleanup).resolves.toBeUndefined();
    expect(() => runtime.replaceGeneration(owner)).not.toThrow();
    expect(() => runtime.replaceGeneration(owner)).toThrow(/runtime rejected/);
  });

  it('recovers a settled quarantined adapter generation and converts duration with its captured clock', async () => {
    const clock = new Runtime();
    const pool = createHostEffectAdmissionPool({
      clock: clock.clock,
      maxConcurrentEffects: 1,
      maxConcurrentEffectsPerOwner: 1
    });
    const supervisor = new HostEffectSupervisor(
      createHostEffectSupervisorOptions({ admissionPool: pool, scheduler: clock.scheduler })
    );
    const runtime = createDesktopAgentProviderRuntime(supervisor, clock.clock);
    const delayedNext = deferred<IteratorResult<EventEnvelope>>();
    let calls = 0;
    const adapter: AgentAdapter = {
      capabilities: ['project.inspect'],
      stream(_context, execution) {
        calls += 1;
        if (calls === 1) {
          return {
            [Symbol.asyncIterator]() {
              return { next: () => delayedNext.promise };
            }
          };
        }
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              protocolVersion: '1.0' as const,
              kind: 'event' as const,
              messageId: 'recovered',
              sentAt: '2026-07-24T00:00:00Z',
              requestId: execution.requestId,
              event: 'completed' as const
            };
          }
        };
      }
    };
    const recoverStream = streamValidatedEvents(
      adapter,
      { requestId: 'recover-1', capability: 'project.inspect', input: {} },
      { runtime, timeoutMs: 5 }
    );
    const pending = recoverStream[Symbol.asyncIterator]().next();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    clock.advance(5);
    await expect(pending).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(() => recoverAdapterGeneration(adapter, runtime)).toThrow(/Agent provider call failed/);
    delayedNext.resolve({ done: true, value: undefined });
    await Promise.resolve();
    await Promise.resolve();
    expect(() => recoverAdapterGeneration(adapter, runtime)).not.toThrow();
    const recovered = streamValidatedEvents(
      adapter,
      { requestId: 'recover-2', capability: 'project.inspect', input: {} },
      { runtime }
    )[Symbol.asyncIterator]();
    await expect(recovered.next()).resolves.toMatchObject({ value: { event: 'completed' } });

    const divergent = new Runtime();
    divergent.now = 100;
    const divergentPool = createHostEffectAdmissionPool({
      clock: clock.clock,
      maxConcurrentEffects: 1,
      maxConcurrentEffectsPerOwner: 1
    });
    const divergentSupervisor = new HostEffectSupervisor(
      createHostEffectSupervisorOptions({
        admissionPool: divergentPool,
        scheduler: clock.scheduler
      })
    );
    const divergentRuntime = createDesktopAgentProviderRuntime(
      divergentSupervisor,
      divergent.clock
    );
    await expect(divergentRuntime.run({}, () => 1, { timeoutMs: 1 })).resolves.toBe(1);
    expect(() => createDesktopAgentProviderRuntime(divergentSupervisor, clock.clock)).toThrow(
      /clock must be shared/
    );
  });

  it('captures clock.now as one own data method and fails closed for hostile clock changes', async () => {
    const state = new Runtime();
    const clockPort = { now: () => state.now };
    const pool = createHostEffectAdmissionPool({
      clock: clockPort,
      maxConcurrentEffects: 1,
      maxConcurrentEffectsPerOwner: 1
    });
    const supervisor = new HostEffectSupervisor(
      createHostEffectSupervisorOptions({ admissionPool: pool, scheduler: state.scheduler })
    );
    const runtime = createDesktopAgentProviderRuntime(supervisor, clockPort);
    clockPort.now = () => 9_999;
    let remainingMs: number | undefined;
    await expect(
      runtime.run(
        {},
        (context) => {
          remainingMs = context.remainingMs;
          return 1;
        },
        { timeoutMs: 5 }
      )
    ).resolves.toBe(1);
    expect(remainingMs).toBe(5);

    const hostClock = new Runtime();
    const getterPool = createHostEffectAdmissionPool({
      clock: hostClock.clock,
      maxConcurrentEffects: 1,
      maxConcurrentEffectsPerOwner: 1
    });
    const getterSupervisor = new HostEffectSupervisor(
      createHostEffectSupervisorOptions({
        admissionPool: getterPool,
        scheduler: hostClock.scheduler
      })
    );
    let getterCalls = 0;
    const getterClock = {};
    Object.defineProperty(getterClock, 'now', {
      get() {
        getterCalls += 1;
        return () => 0;
      }
    });
    expect(() => createDesktopAgentProviderRuntime(getterSupervisor, getterClock as never)).toThrow(
      /own data now/
    );
    expect(getterCalls).toBe(0);

    const proxySupervisor = new HostEffectSupervisor(
      createHostEffectSupervisorOptions({
        admissionPool: getterPool,
        scheduler: hostClock.scheduler
      })
    );
    const hostileClock = new Proxy(
      { now: () => 0 },
      {
        getOwnPropertyDescriptor() {
          throw new Error('private proxy failure');
        }
      }
    );
    expect(() => createDesktopAgentProviderRuntime(proxySupervisor, hostileClock as never)).toThrow(
      /cannot be inspected safely/
    );

    let proxyOwnKeys = 0;
    let proxyDescriptors = 0;
    const mutableProxyTarget = { now: () => hostClock.now };
    const mutableProxy = new Proxy(mutableProxyTarget, {
      ownKeys(target) {
        proxyOwnKeys += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, key) {
        proxyDescriptors += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      }
    });
    const mutationSupervisor = new HostEffectSupervisor(
      createHostEffectSupervisorOptions({
        admissionPool: getterPool,
        scheduler: hostClock.scheduler
      })
    );
    const mutationRuntime = createDesktopAgentProviderRuntime(mutationSupervisor, mutableProxy);
    const capturedScans = { ownKeys: proxyOwnKeys, descriptors: proxyDescriptors };
    mutableProxyTarget.now = () => 9_999;
    let proxyRemaining: number | undefined;
    await expect(
      mutationRuntime.run(
        {},
        (context) => {
          proxyRemaining = context.remainingMs;
          return 1;
        },
        { timeoutMs: 5 }
      )
    ).resolves.toBe(1);
    expect(proxyRemaining).toBe(5);
    expect({ ownKeys: proxyOwnKeys, descriptors: proxyDescriptors }).toEqual(capturedScans);

    const backwards = new Runtime();
    backwards.now = 10;
    const backwardsPool = createHostEffectAdmissionPool({
      clock: backwards.clock,
      maxConcurrentEffects: 1,
      maxConcurrentEffectsPerOwner: 1
    });
    const backwardsSupervisor = new HostEffectSupervisor(
      createHostEffectSupervisorOptions({
        admissionPool: backwardsPool,
        scheduler: backwards.scheduler
      })
    );
    const backwardsRuntime = createDesktopAgentProviderRuntime(
      backwardsSupervisor,
      backwards.clock
    );
    await expect(backwardsRuntime.run({}, () => 1)).resolves.toBe(1);
    backwards.now = 9;
    await expect(backwardsRuntime.run({}, () => 1, { timeoutMs: 1 })).rejects.toMatchObject({
      code: 'EFFECT_FAILED'
    });

    const overflow = new Runtime();
    overflow.now = Number.MAX_SAFE_INTEGER;
    const overflowPool = createHostEffectAdmissionPool({
      clock: overflow.clock,
      maxConcurrentEffects: 1,
      maxConcurrentEffectsPerOwner: 1
    });
    const overflowSupervisor = new HostEffectSupervisor(
      createHostEffectSupervisorOptions({
        admissionPool: overflowPool,
        scheduler: overflow.scheduler
      })
    );
    const overflowRuntime = createDesktopAgentProviderRuntime(overflowSupervisor, overflow.clock);
    await expect(overflowRuntime.run({}, () => 1, { timeoutMs: 1 })).rejects.toMatchObject({
      code: 'EFFECT_FAILED'
    });
  });
});
