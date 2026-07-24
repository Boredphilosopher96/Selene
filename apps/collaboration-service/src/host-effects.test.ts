import { describe, expect, it } from 'vitest';

import {
  CollaborationBoundaryError,
  CollaborationError,
  createInMemoryCollaborationRepository,
  type CollaborationHostContext,
  type ShareTokenSigner
} from '@selene/collaboration';
import { createCollaborationService } from '@selene/collaboration/service';

import { createHostEffectContextFactory } from './host-effects';

class Runtime {
  public now = 0;
  private next = 0;
  private readonly tasks = new Map<number, { readonly at: number; readonly task: () => void }>();
  public readonly clock = { now: () => this.now };
  public readonly scheduler = {
    schedule: (delay: number, task: () => void) => {
      const id = ++this.next;
      this.tasks.set(id, { at: this.now + delay, task });
      return { cancel: () => this.tasks.delete(id) };
    }
  };

  advance(milliseconds: number): void {
    this.now += milliseconds;
    for (const [id, scheduled] of [...this.tasks]) {
      if (scheduled.at <= this.now) {
        this.tasks.delete(id);
        scheduled.task();
      }
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((next) => (resolve = next)), resolve };
}

describe('collaboration-service host effect composition', () => {
  it('shares one process pool across contexts and keeps a stable owner for each adapter port', async () => {
    const runtime = new Runtime();
    const factory = createHostEffectContextFactory({
      clock: runtime.clock,
      scheduler: runtime.scheduler,
      maxConcurrentEffects: 1,
      maxConcurrentEffectsPerOwner: 1
    });
    const first = factory.create({ timeoutMs: 20 });
    const second = factory.create({ timeoutMs: 20 });
    const firstPort = {};
    const secondPort = {};
    const pending = deferred<void>();
    const active = first.runPort!(firstPort, 'query', async () => pending.promise);
    await expect(second.runPort!(secondPort, 'query', async () => undefined)).rejects.toThrow(
      'Host operation failed'
    );
    pending.resolve();
    await expect(active).resolves.toBeUndefined();

    const sameOwner = deferred<void>();
    const again = first.runPort!(firstPort, 'query', async () => sameOwner.promise);
    await expect(second.runPort!(firstPort, 'query', async () => undefined)).rejects.toThrow(
      'Host operation failed'
    );
    sameOwner.resolve();
    await expect(again).resolves.toBeUndefined();
  });

  it('cancels, contains late settlement, then recovers the stable owner generation', async () => {
    const runtime = new Runtime();
    const released = deferred<void>();
    const factory = createHostEffectContextFactory({
      clock: runtime.clock,
      scheduler: runtime.scheduler,
      maxConcurrentEffects: 2,
      maxConcurrentEffectsPerOwner: 1,
      onPortSettled: () => released.resolve()
    });
    const context = factory.create({ timeoutMs: 5 });
    const port = {};
    const pending = deferred<void>();
    const started = deferred<void>();
    const timedOut = context.runPort!(port, 'query', async () => {
      started.resolve();
      return pending.promise;
    });
    await started.promise;
    runtime.advance(5);
    await expect(timedOut).rejects.toThrow('Host operation was cancelled');
    await expect(
      factory.create({ timeoutMs: 5 }).runPort!(port, 'query', async () => undefined)
    ).rejects.toThrow('Host operation failed');
    pending.resolve();
    await released.promise;
    await expect(
      factory.create({ timeoutMs: 5 }).runPort!(port, 'query', async () => undefined)
    ).resolves.toBeUndefined();
  });

  it('captures one observability hook, acknowledges each settled epoch once, and contains hook failure', async () => {
    const runtime = new Runtime();
    let acknowledged = deferred<void>();
    let calls = 0;
    const factoryOptions = {
      clock: runtime.clock,
      scheduler: runtime.scheduler,
      onPortSettled() {
        calls += 1;
        acknowledged.resolve();
        throw new Error('observer failure');
      }
    };
    const factory = createHostEffectContextFactory(factoryOptions);
    factoryOptions.onPortSettled = () => {
      throw new Error('replacement must not be read');
    };
    const port = {};
    await expect(
      factory.create({ timeoutMs: 5 }).runPort!(port, 'query', async () => undefined)
    ).resolves.toBeUndefined();
    await acknowledged.promise;
    expect(calls).toBe(1);

    acknowledged = deferred<void>();
    await expect(
      factory.create({ timeoutMs: 5 }).runPort!(port, 'query', async () => undefined)
    ).resolves.toBeUndefined();
    await acknowledged.promise;
    expect(calls).toBe(2);
  });

  it('caps stable method owners and captures hostile configuration and signals', async () => {
    const runtime = new Runtime();
    const factory = createHostEffectContextFactory({
      clock: runtime.clock,
      scheduler: runtime.scheduler,
      maxMethodsPerPort: 1
    });
    const context = factory.create({ timeoutMs: 5 });
    const port = {};
    await expect(context.runPort!(port, 'first', async () => undefined)).resolves.toBeUndefined();
    await expect(context.runPort!(port, 'second', async () => undefined)).rejects.toThrow(
      'Host port method capacity is exhausted'
    );

    let ownKeysCalled = false;
    expect(() =>
      createHostEffectContextFactory(
        new Proxy(
          {},
          {
            ownKeys: () => {
              ownKeysCalled = true;
              throw new Error('hostile configuration');
            }
          }
        )
      )
    ).not.toThrow();
    expect(ownKeysCalled).toBe(false);
    expect(() =>
      factory.create({
        timeoutMs: 5,
        signal: new Proxy(new AbortController().signal, {
          getPrototypeOf: () => {
            throw new Error('hostile signal');
          }
        })
      })
    ).toThrow('Host effect signal is invalid');

    for (const options of [
      { maxConcurrentEffects: 257 },
      { maxConcurrentEffects: 1, maxConcurrentEffectsPerOwner: 2 },
      { maxMethodsPerPort: 129 },
      { maxConcurrentEffects: Number.MAX_SAFE_INTEGER }
    ])
      expect(() => createHostEffectContextFactory(options)).toThrow(
        'Host effect configuration is invalid'
      );
    expect(() => factory.create({ timeoutMs: 60_001 })).toThrow('Host timeout is invalid');
    const overflow = createHostEffectContextFactory({
      clock: { now: () => Number.MAX_SAFE_INTEGER },
      scheduler: runtime.scheduler
    });
    expect(() => overflow.create({ timeoutMs: 1 })).toThrow('Host timeout is invalid');
  });

  it('normalizes forged public errors from effects and hostile configuration traps', async () => {
    class ForgedBoundaryError extends CollaborationBoundaryError {}
    const factory = createHostEffectContextFactory();
    const context = factory.create({ timeoutMs: 5 });
    await expect(
      context.runPort!({}, 'query', async () => {
        throw new CollaborationError('NOT_FOUND', 'caller-controlled repository secret');
      })
    ).rejects.toMatchObject({ code: 'INVALID', message: 'Host operation failed' });
    await expect(
      context.runPort!({}, 'hash', async () => {
        throw new ForgedBoundaryError('caller-controlled signer secret');
      })
    ).rejects.toMatchObject({ code: 'INVALID', message: 'Host operation failed' });
    let forgedOwnKeysCalled = false;
    expect(() =>
      createHostEffectContextFactory(
        new Proxy(
          {},
          {
            ownKeys() {
              forgedOwnKeysCalled = true;
              throw new ForgedBoundaryError('caller-controlled configuration secret');
            }
          }
        )
      )
    ).not.toThrow();
    expect(forgedOwnKeysCalled).toBe(false);
  });

  it('routes share signing and hashing through captured supervised signer methods', async () => {
    const repository = createInMemoryCollaborationRepository();
    await repository.createProject({ id: 'project-1', organizationId: 'org-1', name: 'Northstar' });
    const seenMethods: string[] = [];
    const seenContexts: CollaborationHostContext[] = [];
    const context: CollaborationHostContext = {
      signal: new AbortController().signal,
      run: async (operation) => operation(context),
      runPort: async (_port, method, operation) => {
        seenMethods.push(method);
        return operation(context);
      },
      dispose: () => undefined
    };
    const signer: ShareTokenSigner = {
      async sign(_payload, received) {
        if (received) seenContexts.push(received);
        return 'signature';
      },
      async verify() {
        return true;
      },
      async hash(_token, received) {
        if (received) seenContexts.push(received);
        return 'hash';
      }
    };
    const service = createCollaborationService({
      repository,
      authorizer: {
        async authorize() {
          return true;
        }
      },
      ids: { next: (kind) => `${kind}-1` },
      hostContextFactory: { create: () => context },
      shareSigner: signer
    });
    signer.sign = async () => {
      throw new Error('swapped signer was called');
    };
    signer.hash = async () => {
      throw new Error('swapped hash was called');
    };
    const response = await service(
      new Request('https://service.test/v1/projects/project-1/share-links', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-selene-user-id': 'user-1' },
        body: JSON.stringify({ permission: 'viewer', expiresAt: '2030-01-01T00:00:00Z' })
      })
    );
    expect(response.status).toBe(201);
    expect(seenMethods).toEqual(expect.arrayContaining(['sign', 'hash']));
    expect(seenContexts).toHaveLength(2);
    expect(seenContexts[0]).toBe(seenContexts[1]);
  });

  it('times out, contains late signer settlement, and recovers the shared signer owners', async () => {
    const runtime = new Runtime();
    const factory = createHostEffectContextFactory({
      clock: runtime.clock,
      scheduler: runtime.scheduler,
      maxConcurrentEffects: 4,
      maxConcurrentEffectsPerOwner: 1
    });
    const repository = createInMemoryCollaborationRepository();
    await repository.createProject({ id: 'project-1', organizationId: 'org-1', name: 'Northstar' });
    const lateSign = deferred<string>();
    const lateHash = deferred<string>();
    const signStarted = deferred<void>();
    const hashStarted = deferred<void>();
    const signSettled = deferred<void>();
    const hashSettled = deferred<void>();
    let signCalls = 0;
    let hashCalls = 0;
    const signer: ShareTokenSigner = {
      sign: async () => {
        signCalls += 1;
        if (signCalls !== 1) return 'signature';
        signStarted.resolve();
        return lateSign.promise.finally(() => signSettled.resolve());
      },
      async verify() {
        return true;
      },
      hash: async () => {
        hashCalls += 1;
        if (hashCalls !== 1) return 'hash';
        hashStarted.resolve();
        return lateHash.promise.finally(() => hashSettled.resolve());
      }
    };
    let next = 0;
    const service = createCollaborationService({
      repository,
      authorizer: {
        async authorize() {
          return true;
        }
      },
      ids: { next: (kind) => `${kind}-${++next}` },
      hostContextFactory: factory,
      shareSigner: signer
    });
    const request = () =>
      new Request('https://service.test/v1/projects/project-1/share-links', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-selene-user-id': 'user-1' },
        body: JSON.stringify({ permission: 'viewer', expiresAt: '2030-01-01T00:00:00Z' })
      });

    const signTimeout = service(request());
    await signStarted.promise;
    expect(signCalls).toBe(1);
    runtime.advance(15_000);
    await expect(signTimeout).resolves.toMatchObject({ status: 503 });
    lateSign.resolve('late-signature');
    await signSettled.promise;

    const hashTimeout = service(request());
    await hashStarted.promise;
    expect(hashCalls).toBe(1);
    runtime.advance(15_000);
    await expect(hashTimeout).resolves.toMatchObject({ status: 503 });
    lateHash.resolve('late-hash');
    await hashSettled.promise;

    await expect(service(request())).resolves.toMatchObject({ status: 201 });
    expect(signCalls).toBe(3);
    expect(hashCalls).toBe(2);
  });
});
