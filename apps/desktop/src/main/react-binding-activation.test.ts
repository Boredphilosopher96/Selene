import { describe, expect, it } from 'vitest';

import { activateReactBindingAfterPreviewPublication } from './react-binding-activation';

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe('deferred React binding activation', () => {
  it('keeps a published preview independent from a later activation rejection', async () => {
    const order: string[] = [];
    const activationStarted = deferred<void>();
    const recordStarted = deferred<void>();
    const rejectActivation = deferred<void>();
    const published = () => order.push('published');

    published();
    activateReactBindingAfterPreviewPublication(
      async () => {
        order.push('activate');
        activationStarted.resolve();
        await rejectActivation.promise;
      },
      async () => {
        order.push('recorded');
        recordStarted.resolve();
      }
    );

    expect(order).toEqual(['published']);
    await activationStarted.promise;
    expect(order).toEqual(['published', 'activate']);
    rejectActivation.reject(new Error('stale receipt'));
    await recordStarted.promise;
    expect(order).toEqual(['published', 'activate', 'recorded']);
  });

  it('contains a diagnostics persistence failure without an unhandled rejection', async () => {
    const records: string[] = [];
    const activationStarted = deferred<void>();
    const rejectActivation = deferred<void>();
    const recordStarted = deferred<void>();
    activateReactBindingAfterPreviewPublication(
      async () => {
        activationStarted.resolve();
        await rejectActivation.promise;
      },
      async () => {
        records.push('attempted');
        recordStarted.resolve();
        throw new Error('diagnostics unavailable');
      }
    );

    await activationStarted.promise;
    rejectActivation.reject(new Error('stale receipt'));
    await recordStarted.promise;
    expect(records).toEqual(['attempted']);
  });
});
