import { describe, expect, it } from 'vitest';

import type { HostCallContext } from '@selene/host-runtime';
import type { HostedBffStore, OidcRuntime } from '@selene/identity-runtime';

import { createSupervisedOidcBffEffects } from './oidc-effect-ports';
import type { OidcEffectRunner } from './oidc-effects';

function context() {
  const listeners = new Set<(reason: 'caller-aborted' | 'deadline-exceeded') => void>();
  let cancelled = false;
  return {
    value: {
      remainingDurationMs: 100,
      deadlineMs: 100,
      cancellation: {
        isCancellationRequested: () => cancelled,
        reason: () => (cancelled ? 'caller-aborted' : undefined),
        subscribe(listener: (reason: 'caller-aborted' | 'deadline-exceeded') => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }
      }
    } as HostCallContext,
    cancel() {
      cancelled = true;
      for (const listener of [...listeners]) listener('caller-aborted');
    },
    listeners: () => listeners.size
  };
}

const directRunner: OidcEffectRunner = {
  run(owner, method, arguments_, callContext) {
    return Promise.resolve(
      Reflect.apply((owner as Record<string, (...values: unknown[]) => unknown>)[method]!, owner, [
        callContext,
        ...arguments_
      ])
    );
  },
  fromHostContext(hostContext) {
    return {
      remainingDurationMs: 100,
      cancellation: hostContext.cancellation
    };
  }
};

const runtime: OidcRuntime = {
  async begin() {
    throw new Error('not used');
  },
  async exchange() {
    throw new Error('not used');
  },
  async revoke() {},
  async endSession() {
    return undefined;
  }
};

describe('OIDC supervised store ports', () => {
  it('takes one aggregate descriptor snapshot for each adapter and rejects oversized ports', () => {
    let runtimeDescriptorPasses = 0;
    const observedRuntime = new Proxy(runtime, {
      ownKeys(target) {
        runtimeDescriptorPasses += 1;
        return Reflect.ownKeys(target);
      }
    });
    createSupervisedOidcBffEffects(observedRuntime, createInMemoryStore(), directRunner);
    expect(runtimeDescriptorPasses).toBe(0);

    const oversized = Object.create(null) as Record<string, unknown>;
    for (let index = 0; index < 129; index += 1) oversized[`noise${index}`] = index;
    expect(() => createSupervisedOidcBffEffects(runtime, oversized as never, directRunner)).toThrow(
      'OIDC adapter methods are invalid'
    );
  });

  it('releases every inherited cancellation subscription after sequential effects', async () => {
    const calls: AbortSignal[] = [];
    const store: HostedBffStore = {
      async createTransaction() {},
      async consumeTransaction() {
        return undefined;
      },
      async createSession() {},
      async readSession(_id, signal) {
        if (signal) calls.push(signal);
        return undefined;
      },
      async consumeSession() {
        return undefined;
      },
      async bindSessionAccess() {
        return false;
      },
      async revokeSession() {}
    };
    const call = context();
    const supervised = createSupervisedOidcBffEffects(runtime, store, directRunner).forContext(
      call.value
    ).store;
    await Array.from({ length: 33 }, (_, index) => index).reduce(
      (pending, index) => pending.then(() => supervised.readSession(`session-${index}`)),
      Promise.resolve()
    );
    expect(calls).toHaveLength(33);
    expect(call.listeners()).toBe(0);
  });

  it('aborts a pending adapter signal and releases its callback when the call is cancelled', async () => {
    let resolve!: () => void;
    let received: AbortSignal | undefined;
    const store: HostedBffStore = {
      async createTransaction() {},
      async consumeTransaction() {
        return undefined;
      },
      async createSession() {},
      readSession(_id, signal) {
        received = signal;
        return new Promise((done) => {
          resolve = done;
        });
      },
      async consumeSession() {
        return undefined;
      },
      async bindSessionAccess() {
        return false;
      },
      async revokeSession() {}
    };
    const call = context();
    const pending = createSupervisedOidcBffEffects(runtime, store, directRunner)
      .forContext(call.value)
      .store.readSession('session');
    await Promise.resolve();
    call.cancel();
    expect(received?.aborted).toBe(true);
    resolve();
    await pending;
    expect(call.listeners()).toBe(0);
  });
});

function createInMemoryStore(): HostedBffStore {
  return {
    async createTransaction() {},
    async consumeTransaction() {
      return undefined;
    },
    async createSession() {},
    async readSession() {
      return undefined;
    },
    async consumeSession() {
      return undefined;
    },
    async bindSessionAccess() {
      return false;
    },
    async revokeSession() {}
  };
}
