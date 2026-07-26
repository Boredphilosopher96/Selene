import { describe, expect, it } from 'vitest';

import {
  createDiagnosticsActivationTracker,
  createDiagnosticsInitialRefreshStore,
  createDiagnosticsOperationLane,
  createLatestDiagnosticsOperationQueue
} from './workspace-toolbar-diagnostics';

function deferred<Value>() {
  let resolve: (value: Value) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<Value>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function pendingOperation<Value>() {
  const result = deferred<Value>();
  const entered = deferred<void>();
  const completed = deferred<void>();
  return {
    ...result,
    entered: entered.promise,
    completed: completed.promise,
    operation: () => {
      entered.resolve();
      return result.promise.then(
        (value) => {
          completed.resolve();
          return value;
        },
        (error: unknown) => {
          completed.resolve();
          throw error;
        }
      );
    }
  };
}

describe('workspace toolbar diagnostics operation lane', () => {
  it('retries a rejected settled read and keeps one project refresh through host wrapper churn', async () => {
    const store = createDiagnosticsInitialRefreshStore<string>();
    const key = { generation: 1, projectId: 'project-a' };
    const rejected = deferred<string>();
    let reads = 0;
    const first = store.acquire(key, () => {
      reads += 1;
      return rejected.promise;
    });
    rejected.reject(new Error('Initial diagnostics read failed.'));
    await expect(first).rejects.toThrow('Initial diagnostics read failed.');
    await Promise.resolve();

    await expect(
      store.acquire(key, async () => {
        reads += 1;
        return 'fresh';
      })
    ).resolves.toBe('fresh');
    expect(reads).toBe(2);
    await Promise.resolve();

    const pending = deferred<string>();
    const currentRequest = store.acquire(key, () => pending.promise);
    const hostWrapperChurn = store.acquire(
      { generation: 1, projectId: 'project-a' },
      async () => 'unexpected'
    );
    expect(hostWrapperChurn).toBe(currentRequest);
    pending.resolve('current');
    await expect(currentRequest).resolves.toBe('current');
    await Promise.resolve();

    await expect(
      store.acquire({ generation: 2, projectId: 'project-b' }, async () => 'replacement')
    ).resolves.toBe('replacement');
  });

  it('uses a fresh activation for A to B to A without publishing the first A read', async () => {
    const activations = createDiagnosticsActivationTracker();
    const store = createDiagnosticsInitialRefreshStore<string>();
    const firstA = deferred<string>();
    const b = deferred<string>();
    const returnedA = deferred<string>();
    const returnedSettled = deferred<void>();
    const reads: string[] = [];
    const published: string[] = [];

    const initialA = store.acquire(activations.activate('project-a'), () => {
      reads.push('a:1');
      return firstA.promise;
    });
    const firstLane = createDiagnosticsOperationLane(() => undefined);
    firstLane.run({
      operation: () => initialA,
      onSuccess: (value) => published.push(`a:1:${value}`),
      onFailure: () => published.push('a:1:failed'),
      onSettled: () => published.push('a:1:settled')
    });
    expect(activations.activate('project-a')).toEqual({ generation: 1, projectId: 'project-a' });
    const projectB = store.acquire(activations.activate('project-b'), () => {
      reads.push('b:2');
      return b.promise;
    });
    const secondLane = createDiagnosticsOperationLane(() => undefined);
    secondLane.run({
      operation: () => projectB,
      onSuccess: (value) => published.push(`b:2:${value}`),
      onFailure: () => published.push('b:2:failed'),
      onSettled: () => published.push('b:2:settled')
    });
    const nextA = store.acquire(activations.activate('project-a'), () => {
      reads.push('a:3');
      return returnedA.promise;
    });
    const returnedLane = createDiagnosticsOperationLane(() => undefined);
    returnedLane.run({
      operation: () => nextA,
      onSuccess: (value) => published.push(`a:3:${value}`),
      onFailure: () => published.push('a:3:failed'),
      onSettled: () => returnedSettled.resolve()
    });

    await Promise.resolve();
    expect(reads).toEqual(['a:1', 'b:2', 'a:3']);
    expect(nextA).not.toBe(initialA);
    firstLane.dispose();
    secondLane.dispose();
    firstA.resolve('stale-a');
    b.resolve('stale-b');
    returnedA.resolve('current-a');
    await returnedSettled.promise;
    await expect(initialA).resolves.toBe('stale-a');
    await expect(projectB).resolves.toBe('stale-b');
    await expect(nextA).resolves.toBe('current-a');
    expect(published).toEqual(['a:3:current-a']);
  });

  it('invalidates an old refresh, then runs and applies exactly one refresh for the new host', async () => {
    const writes: string[] = [];
    const first = pendingOperation<string>();
    const second = pendingOperation<string>();
    const settled = deferred<void>();
    const lane = createDiagnosticsOperationLane(() => undefined);
    expect(
      lane.run({
        operation: first.operation,
        onSuccess: (value) => writes.push(`old:${value}`),
        onFailure: () => writes.push('old-failure'),
        onSettled: () => writes.push('old-settled')
      })
    ).toBe(true);
    await first.entered;

    lane.invalidate();
    expect(
      lane.run({
        operation: second.operation,
        onSuccess: (value) => writes.push(`new:${value}`),
        onFailure: () => writes.push('new-failure'),
        onSettled: () => {
          writes.push('new-settled');
          settled.resolve();
        }
      })
    ).toBe(true);
    await second.entered;

    first.resolve('stale');
    await first.completed;
    expect(writes).toEqual([]);
    second.resolve('current');
    await settled.promise;
    expect(writes).toEqual(['new:current', 'new-settled']);
  });

  it('suppresses every late callback after toolbar unmount', async () => {
    const writes: string[] = [];
    const pending = pendingOperation<string>();
    const lane = createDiagnosticsOperationLane((busy) => writes.push(`busy:${busy}`));
    lane.run({
      operation: pending.operation,
      onSuccess: () => writes.push('success'),
      onFailure: () => writes.push('failure'),
      onSettled: () => writes.push('settled')
    });
    await pending.entered;
    lane.dispose();
    const beforeLateSettlement = [...writes];
    pending.reject(new Error('late host failure'));
    await expect(pending.promise).rejects.toThrow('late host failure');
    expect(writes).toEqual(beforeLateSettlement);
  });

  it('serializes rapid consent requests so an older host result cannot be reordered', async () => {
    const writes: string[] = [];
    const granted = pendingOperation<'granted'>();
    const settled = deferred<void>();
    const lane = createDiagnosticsOperationLane(() => undefined);
    expect(
      lane.run({
        operation: granted.operation,
        onSuccess: (value) => writes.push(value),
        onFailure: () => writes.push('failure'),
        onSettled: () => {
          writes.push('settled');
          settled.resolve();
        }
      })
    ).toBe(true);
    await granted.entered;
    expect(
      lane.run({
        operation: async () => 'denied',
        onSuccess: (value) => writes.push(value),
        onFailure: () => writes.push('failure'),
        onSettled: () => writes.push('settled')
      })
    ).toBe(false);

    granted.resolve('granted');
    await settled.promise;
    expect(writes).toEqual(['granted', 'settled']);
  });

  it('keeps the latest optimistic consent queued until the prior host write settles', async () => {
    const writes: string[] = [];
    const granted = pendingOperation<'granted'>();
    const denied = pendingOperation<'denied'>();
    const idle = deferred<void>();
    const lane = createDiagnosticsOperationLane((busy) => writes.push(`busy:${busy}`));
    const queue = createLatestDiagnosticsOperationQueue(lane, {
      operation: (choice) => {
        writes.push(`start:${choice}`);
        return choice === 'granted' ? granted.operation() : denied.operation();
      },
      onSuccess: (choice, result, isLatest) =>
        writes.push(`success:${choice}:${result}:${isLatest}`),
      onFailure: () => writes.push('failure'),
      onIdle: () => {
        writes.push('idle');
        idle.resolve();
      }
    });

    queue.submit('granted');
    await granted.entered;
    queue.submit('denied');
    expect(writes).toEqual(['busy:true', 'start:granted']);

    granted.resolve('granted');
    await granted.completed;
    await denied.entered;
    denied.resolve('denied');
    await idle.promise;

    expect(writes).toEqual([
      'busy:true',
      'start:granted',
      'success:granted:granted:false',
      'busy:false',
      'busy:true',
      'start:denied',
      'success:denied:denied:true',
      'busy:false',
      'idle'
    ]);
  });

  it('rolls back the latest rejected consent, reports the error, and leaves saving idle', async () => {
    const writes: string[] = [];
    const rejected = pendingOperation<'denied'>();
    const idle = deferred<void>();
    const lane = createDiagnosticsOperationLane((busy) => writes.push(`busy:${busy}`));
    let confirmed: 'granted' | 'denied' = 'granted';
    let displayed: 'granted' | 'denied' = confirmed;
    let error: string | undefined;
    let saving = true;
    const queue = createLatestDiagnosticsOperationQueue(lane, {
      operation: (choice) => {
        writes.push(`start:${choice}`);
        return rejected.operation();
      },
      onSuccess: () => writes.push('success'),
      onFailure: (choice, reason, isLatest) => {
        const message = reason instanceof Error ? reason.message : 'unexpected';
        writes.push(`failure:${choice}:${isLatest}:${message}`);
        if (!isLatest) return;
        displayed = confirmed;
        error = message;
      },
      onIdle: () => {
        saving = false;
        writes.push('idle');
        idle.resolve();
      }
    });

    displayed = 'denied';
    queue.submit('denied');
    await rejected.entered;
    rejected.reject(new Error('Consent rejected by host.'));
    await rejected.completed;
    await idle.promise;

    expect({ confirmed, displayed, error, saving }).toEqual({
      confirmed: 'granted',
      displayed: 'granted',
      error: 'Consent rejected by host.',
      saving: false
    });
    expect(writes).toEqual([
      'busy:true',
      'start:denied',
      'failure:denied:true:Consent rejected by host.',
      'busy:false',
      'idle'
    ]);
  });

  it('does not let an older rejection roll back a newer queued consent', async () => {
    const writes: string[] = [];
    const older = pendingOperation<'granted'>();
    const newer = pendingOperation<'denied'>();
    const idle = deferred<void>();
    const lane = createDiagnosticsOperationLane((busy) => writes.push(`busy:${busy}`));
    let confirmed: 'granted' | 'denied' = 'denied';
    let displayed: 'granted' | 'denied' = confirmed;
    let error: string | undefined;
    let saving = true;
    const queue = createLatestDiagnosticsOperationQueue(lane, {
      operation: (choice) => {
        writes.push(`start:${choice}`);
        return choice === 'granted' ? older.operation() : newer.operation();
      },
      onSuccess: (choice, result, isLatest) => {
        writes.push(`success:${choice}:${result}:${isLatest}`);
        if (!isLatest) return;
        confirmed = result;
        displayed = result;
      },
      onFailure: (choice, _reason, isLatest) => {
        writes.push(`failure:${choice}:${isLatest}`);
        if (!isLatest) return;
        displayed = confirmed;
        error = 'Diagnostics consent could not be saved.';
      },
      onIdle: () => {
        saving = false;
        writes.push('idle');
        idle.resolve();
      }
    });

    displayed = 'granted';
    queue.submit('granted');
    await older.entered;
    displayed = 'denied';
    queue.submit('denied');
    older.reject(new Error('Older write rejected.'));
    await older.completed;
    await newer.entered;
    expect({ displayed, error, saving }).toEqual({
      displayed: 'denied',
      error: undefined,
      saving: true
    });

    newer.resolve('denied');
    await idle.promise;

    expect({ confirmed, displayed, error, saving }).toEqual({
      confirmed: 'denied',
      displayed: 'denied',
      error: undefined,
      saving: false
    });
    expect(writes).toEqual([
      'busy:true',
      'start:granted',
      'failure:granted:false',
      'busy:false',
      'busy:true',
      'start:denied',
      'success:denied:denied:true',
      'busy:false',
      'idle'
    ]);
  });

  it('suppresses active and queued consent callbacks after disposal', async () => {
    const writes: string[] = [];
    const active = pendingOperation<'granted'>();
    let pendingStarted = false;
    const lane = createDiagnosticsOperationLane(() => undefined);
    const queue = createLatestDiagnosticsOperationQueue(lane, {
      operation: (choice) => {
        writes.push(`start:${choice}`);
        if (choice === 'granted') return active.operation();
        pendingStarted = true;
        return Promise.resolve('denied' as const);
      },
      onSuccess: () => writes.push('success'),
      onFailure: () => writes.push('failure'),
      onIdle: () => writes.push('idle')
    });

    queue.submit('granted');
    await active.entered;
    queue.submit('denied');
    queue.dispose();
    lane.dispose();
    active.resolve('granted');
    await active.completed;
    await Promise.resolve();

    expect(pendingStarted).toBe(false);
    expect(writes).toEqual(['start:granted']);
  });
});
