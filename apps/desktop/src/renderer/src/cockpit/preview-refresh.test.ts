import { describe, expect, it, vi } from 'vitest';

import {
  isActivePreviewFrameEvent,
  DEFAULT_PREVIEW_COMPILE_TIMEOUT_MS,
  PreviewPresentationCoordinator,
  PreviewRefreshError,
  previewPresentationIdentityKey,
  retainCurrentSnapshotAfterPreviewRefresh,
  retargetPreviewSelection,
  refreshPreviewRevision,
  type ProjectRevisionSnapshot,
  type RevisionSnapshot,
  type PreviewPresentationClock,
  type PreviewPresentationReceipt
} from './preview-refresh';

class FakeClock implements PreviewPresentationClock {
  public readonly tasks = new Map<number, () => void>();
  public readonly cancelled: number[] = [];
  public readonly delays: number[] = [];
  private next = 0;

  public schedule(task: () => void, delayMs: number): number {
    this.next += 1;
    this.tasks.set(this.next, task);
    this.delays.push(delayMs);
    return this.next;
  }

  public cancel(handle: unknown): void {
    if (typeof handle === 'number') {
      this.cancelled.push(handle);
      this.tasks.delete(handle);
    }
  }

  public fire(handle = this.next): void {
    this.tasks.get(handle)?.();
  }
}

const snapshot: RevisionSnapshot & { readonly selectedNodeId?: string } = {
  source: { revision: { id: 'orders-r2' } },
  selectedNodeId: 'orders.table'
};
const identity = (revisionId: string, nonce = `nonce-${revisionId}`, url = `preview:${nonce}`) => ({
  revisionId,
  nonce,
  url
});
const identify = (build: ReturnType<typeof identity>) => build;
const receipt: PreviewPresentationReceipt = {
  identity: identity('orders-r2'),
  visible: true
};

function deferred<Output>() {
  let resolve!: (value: Output) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Output>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

interface PreviewSettlementSnapshot extends ProjectRevisionSnapshot {
  readonly selectedNodeId?: string;
  readonly collaborationRevision?: number;
}

describe('preview refresh snapshot settlement', () => {
  it('retains a newer host-confirmed selection when a same-revision refresh settles late', () => {
    const current: PreviewSettlementSnapshot = {
      source: { projectId: 'orders', revision: { id: 'orders-r2' } },
      selectedNodeId: 'orders.table',
      collaborationRevision: 4
    };
    const lateRefresh: PreviewSettlementSnapshot = {
      source: { projectId: 'orders', revision: { id: 'orders-r2' } },
      collaborationRevision: 3
    };

    expect(retainCurrentSnapshotAfterPreviewRefresh(current, lateRefresh)).toBe(current);
  });

  it('installs a refresh that belongs to a different source revision', () => {
    const current: PreviewSettlementSnapshot = {
      source: { projectId: 'orders', revision: { id: 'orders-r1' } },
      selectedNodeId: 'orders.summary'
    };
    const refreshed: PreviewSettlementSnapshot = {
      source: { projectId: 'orders', revision: { id: 'orders-r2' } }
    };

    expect(retainCurrentSnapshotAfterPreviewRefresh(current, refreshed)).toBe(refreshed);
    expect(retainCurrentSnapshotAfterPreviewRefresh(undefined, refreshed)).toBe(refreshed);
  });

  it('does not retain state from another project with a matching revision label', () => {
    const current: PreviewSettlementSnapshot = {
      source: { projectId: 'customer-service', revision: { id: 'draft-r1' } },
      selectedNodeId: 'support.search'
    };
    const refreshed: PreviewSettlementSnapshot = {
      source: { projectId: 'orders', revision: { id: 'draft-r1' } }
    };

    expect(retainCurrentSnapshotAfterPreviewRefresh(current, refreshed)).toBe(refreshed);
  });
});

describe('preview presentation coordinator', () => {
  it('keeps initial runtime state keyed to the exact preview identity', () => {
    const dashboard = identity('dashboard-r1', 'nonce-dashboard', 'preview:dashboard');
    const orders = identity('orders-r1', 'nonce-orders', 'preview:orders');
    const runtime = new Map([
      [previewPresentationIdentityKey(dashboard), 'dashboard'],
      [previewPresentationIdentityKey(orders), 'orders']
    ]);

    expect(runtime.get(previewPresentationIdentityKey(dashboard))).toBe('dashboard');
    expect(runtime.get(previewPresentationIdentityKey(orders))).toBe('orders');
  });

  it('rejects ready receipts when no captured pending presentation exists', () => {
    const coordinator = new PreviewPresentationCoordinator(
      () => undefined,
      identify,
      new FakeClock()
    );
    expect(coordinator.ready(identity('orders-r2'))).toBe(false);
  });

  it('accepts only the exact trusted revision receipt and cleans its timeout', async () => {
    const clock = new FakeClock();
    const coordinator = new PreviewPresentationCoordinator(() => undefined, identify, clock);
    const build = identity('orders-r2');
    const pending = coordinator.present(build);
    expect(coordinator.rendered(identity('orders-r1'))).toBe(false);
    expect(coordinator.rendered(build)).toBe(false);
    expect(coordinator.ready(identity('orders-r1'))).toBe(false);
    expect(coordinator.ready(build)).toBe(true);
    expect(coordinator.rendered(build)).toBe(true);
    await expect(pending).resolves.toEqual(receipt);
    expect(clock.cancelled).toEqual([1]);
  });

  it('turns a silent no-ready frame into a bounded retryable timeout', async () => {
    const clock = new FakeClock();
    const coordinator = new PreviewPresentationCoordinator(() => undefined, identify, clock, 250);
    const build = identity('orders-r2');
    const pending = coordinator.present(build);
    expect(coordinator.rendered(build)).toBe(false);
    clock.fire();
    await expect(pending).rejects.toMatchObject({
      code: 'presentation-timeout',
      revisionId: 'orders-r2'
    });
  });

  it('aborts and replaces pending presentations without leaking timers or listeners', async () => {
    const clock = new FakeClock();
    const coordinator = new PreviewPresentationCoordinator(() => undefined, identify, clock);
    const controller = new AbortController();
    const first = coordinator.present(identity('orders-r1'), controller.signal);
    const second = coordinator.present(identity('orders-r2'));
    await expect(first).rejects.toMatchObject({ code: 'refresh-aborted', revisionId: 'orders-r1' });
    controller.abort();
    coordinator.close();
    await expect(second).rejects.toMatchObject({
      code: 'refresh-aborted',
      revisionId: 'orders-r2'
    });
    expect(clock.tasks.size).toBe(0);
  });

  it('serializes replacement and ignores delayed old-frame events for the same revision', async () => {
    const clock = new FakeClock();
    const coordinator = new PreviewPresentationCoordinator(() => undefined, identify, clock);
    const oldBuild = identity('orders-r2', 'nonce-old', 'selene-preview://local/old/index.html');
    const nextBuild = identity('orders-r2', 'nonce-next', 'selene-preview://local/next/index.html');
    const oldPresentation = coordinator.present(oldBuild);
    const nextPresentation = coordinator.present(nextBuild);
    await expect(oldPresentation).rejects.toMatchObject({
      code: 'refresh-aborted',
      revisionId: 'orders-r2'
    });

    expect(coordinator.ready(oldBuild)).toBe(false);
    expect(coordinator.rendered(oldBuild)).toBe(false);
    expect(coordinator.ready(nextBuild)).toBe(true);
    expect(coordinator.failed(oldBuild, 'iframe-runtime-failed', 'delayed old frame error')).toBe(
      false
    );
    expect(coordinator.rendered(oldBuild)).toBe(false);
    expect(coordinator.rendered(nextBuild)).toBe(true);
    await expect(nextPresentation).resolves.toEqual({
      identity: nextBuild,
      visible: true
    });
    expect(clock.tasks.size).toBe(0);
  });

  it('gates stale same-revision selection, action, error notice, and diagnostics', () => {
    const oldBuild = identity('orders-r2', 'nonce-old', 'selene-preview://local/old/index.html');
    const nextBuild = identity('orders-r2', 'nonce-next', 'selene-preview://local/next/index.html');
    const effects = { selections: 0, actions: 0, notices: 0, diagnostics: 0 };
    const dispatch = (
      type: 'select-node' | 'trigger-action' | 'runtime-error',
      eventIdentity: ReturnType<typeof identity>
    ) => {
      if (
        !isActivePreviewFrameEvent({
          activeIdentity: nextBuild,
          eventIdentity,
          channelIsActive: true
        })
      )
        return;
      if (type === 'select-node') effects.selections += 1;
      if (type === 'trigger-action') effects.actions += 1;
      if (type === 'runtime-error') {
        effects.notices += 1;
        effects.diagnostics += 1;
      }
    };

    dispatch('select-node', oldBuild);
    dispatch('trigger-action', oldBuild);
    dispatch('runtime-error', oldBuild);
    expect(effects).toEqual({ selections: 0, actions: 0, notices: 0, diagnostics: 0 });
    expect(
      isActivePreviewFrameEvent({
        activeIdentity: nextBuild,
        eventIdentity: nextBuild,
        channelIsActive: false
      })
    ).toBe(false);
  });
});

describe('preview refresh receipt coordination', () => {
  it('bounds a never-settling compile, aborts its host signal, and permits a fresh retry', async () => {
    const clock = new FakeClock();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const present = vi.fn(async () => receipt);
    const retarget = vi.fn(async (accepted: typeof snapshot) => accepted);
    let compileSignal: AbortSignal | undefined;
    const pending = refreshPreviewRevision({
      snapshot,
      signal: controller.signal,
      compileClock: clock,
      compile: (_accepted, signal) => {
        compileSignal = signal;
        return new Promise<ReturnType<typeof identity>>(() => undefined);
      },
      present,
      selection: { intent: 'authoring', retarget }
    });
    const failure = expect(pending).rejects.toMatchObject({
      code: 'compile-timeout',
      revisionId: 'orders-r2'
    });
    expect(clock.delays).toEqual([DEFAULT_PREVIEW_COMPILE_TIMEOUT_MS]);
    expect(compileSignal?.aborted).toBe(false);
    clock.fire();
    await failure;
    expect(compileSignal?.aborted).toBe(true);
    expect(clock.tasks.size).toBe(0);
    expect(removeListener).toHaveBeenCalledOnce();
    expect(present).not.toHaveBeenCalled();
    expect(retarget).not.toHaveBeenCalled();

    await expect(
      refreshPreviewRevision({
        snapshot,
        compileClock: clock,
        compile: async () => identity('orders-r2'),
        present,
        selection: { intent: 'authoring', retarget }
      })
    ).resolves.toMatchObject({ snapshot, receipt });
    expect(present).toHaveBeenCalledOnce();
    expect(retarget).toHaveBeenCalledOnce();
    expect(clock.tasks.size).toBe(0);
  });

  it('immediately releases a held compile on abort without waiting for its adapter', async () => {
    const clock = new FakeClock();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const present = vi.fn(async () => receipt);
    let compileSignal: AbortSignal | undefined;
    const pending = refreshPreviewRevision({
      snapshot,
      signal: controller.signal,
      compileClock: clock,
      compile: (_accepted, signal) => {
        compileSignal = signal;
        return new Promise<ReturnType<typeof identity>>(() => undefined);
      },
      present,
      selection: { intent: 'presentation' }
    });
    const failure = expect(pending).rejects.toMatchObject({ code: 'refresh-aborted' });
    controller.abort();
    await failure;
    expect(compileSignal?.aborted).toBe(true);
    expect(clock.tasks.size).toBe(0);
    expect(removeListener).toHaveBeenCalledOnce();
    expect(present).not.toHaveBeenCalled();
  });

  it.each([
    ['timeout', 'resolve'],
    ['timeout', 'reject'],
    ['abort', 'resolve'],
    ['abort', 'reject']
  ] as const)(
    'fences a late compile %s/%s after a same-revision retry has already presented',
    async (abandonment, settlement) => {
      const clock = new FakeClock();
      const controller = new AbortController();
      const held = deferred<ReturnType<typeof identity>>();
      const published: ReturnType<typeof identity>[] = [];
      const present = async (build: ReturnType<typeof identity>) => {
        published.push(build);
        return { identity: build, visible: true as const };
      };
      const first = refreshPreviewRevision({
        snapshot,
        signal: controller.signal,
        compileClock: clock,
        compile: () => held.promise,
        present,
        selection: { intent: 'presentation' }
      });
      const failure = expect(first).rejects.toMatchObject({
        code: abandonment === 'timeout' ? 'compile-timeout' : 'refresh-aborted'
      });
      if (abandonment === 'timeout') clock.fire();
      else controller.abort();
      await failure;

      const fresh = identity('orders-r2', 'nonce-fresh', 'preview:fresh');
      await expect(
        refreshPreviewRevision({
          snapshot,
          compileClock: clock,
          compile: async () => fresh,
          present,
          selection: { intent: 'presentation' }
        })
      ).resolves.toMatchObject({ build: fresh });

      if (settlement === 'resolve') held.resolve(identity('orders-r2', 'nonce-abandoned'));
      else held.reject(new Error('late abandoned compiler failure'));
      await Promise.resolve();
      await Promise.resolve();
      expect(published).toEqual([fresh]);
      expect(clock.tasks.size).toBe(0);
    }
  );

  it('does not invoke the compiler for a refresh cancelled before it starts', async () => {
    const clock = new FakeClock();
    const controller = new AbortController();
    const compile = vi.fn(async () => identity('orders-r2'));
    controller.abort();
    await expect(
      refreshPreviewRevision({
        snapshot,
        signal: controller.signal,
        compileClock: clock,
        compile,
        present: async () => receipt,
        selection: { intent: 'presentation' }
      })
    ).rejects.toMatchObject({ code: 'refresh-aborted' });
    expect(compile).not.toHaveBeenCalled();
    expect(clock.tasks.size).toBe(0);
  });

  it('cleans the deadline and abort listener on a synchronous adapter failure', async () => {
    const clock = new FakeClock();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    await expect(
      refreshPreviewRevision({
        snapshot,
        signal: controller.signal,
        compileClock: clock,
        compile: () => {
          throw new Error('host unavailable');
        },
        present: async () => receipt,
        selection: { intent: 'presentation' }
      })
    ).rejects.toMatchObject({ code: 'compile-failed' });
    expect(clock.tasks.size).toBe(0);
    expect(removeListener).toHaveBeenCalledOnce();
  });

  it('rejects compile deadlines that would relax the production wait budget', async () => {
    const compile = vi.fn(async () => identity('orders-r2'));
    await expect(
      refreshPreviewRevision({
        snapshot,
        compileTimeoutMs: DEFAULT_PREVIEW_COMPILE_TIMEOUT_MS + 1,
        compile,
        present: async () => receipt,
        selection: { intent: 'presentation' }
      })
    ).rejects.toMatchObject({ code: 'compile-failed' });
    expect(compile).not.toHaveBeenCalled();
  });

  it('does not restore a selection cleared while compilation was pending', async () => {
    const calls: string[] = [];
    let epoch = 0;
    const startingEpoch = epoch;
    const cleared = { source: snapshot.source };
    const result = await refreshPreviewRevision({
      snapshot,
      compile: async () => {
        epoch += 1;
        calls.push('escape-cleared');
        await Promise.resolve();
        return { revisionId: 'orders-r2' };
      },
      present: async () => receipt,
      selection: {
        intent: 'authoring',
        retarget: (accepted, revisionId) =>
          retargetPreviewSelection({
            snapshot: accepted,
            revisionId,
            isCurrent: () => epoch === startingEpoch,
            enqueue: async (operation) => operation(),
            readSnapshot: async () => {
              calls.push('read-current-selection');
              return cleared;
            },
            selectNode: async (nodeId) => {
              calls.push(`select:${nodeId}`);
              return accepted;
            }
          })
      }
    });
    expect(result.snapshot).toEqual({ source: snapshot.source });
    expect(calls).toEqual(['escape-cleared', 'read-current-selection']);
  });

  it('checks selection intent when the host queue executes, after an earlier clear', async () => {
    const calls: string[] = [];
    let current = true;
    const result = await retargetPreviewSelection({
      snapshot,
      revisionId: 'orders-r2',
      isCurrent: () => current,
      enqueue: async (operation) => {
        current = false;
        calls.push('queued-clear');
        return operation();
      },
      readSnapshot: async () => ({ source: snapshot.source }),
      selectNode: async (nodeId) => {
        calls.push(`select:${nodeId}`);
        return snapshot;
      }
    });
    expect(result).toEqual({ source: snapshot.source });
    expect(calls).toEqual(['queued-clear']);
  });

  it('orders compile, exact visible receipt, then selection retarget before success', async () => {
    const calls: string[] = [];
    const result = await refreshPreviewRevision({
      snapshot,
      compile: async (accepted) => {
        calls.push(`compile:${accepted.source.revision.id}`);
        return { revisionId: 'orders-r2' };
      },
      present: async () => {
        calls.push('visible-frame-receipt');
        return receipt;
      },
      selection: {
        intent: 'authoring',
        retarget: async (accepted, revisionId) => {
          calls.push(`retarget:${revisionId}`);
          return accepted;
        }
      }
    });
    expect(result.snapshot.selectedNodeId).toBe('orders.table');
    expect(calls).toEqual(['compile:orders-r2', 'visible-frame-receipt', 'retarget:orders-r2']);
  });

  it('does not let a hidden authoring selection block a presentation refresh', async () => {
    const result = await refreshPreviewRevision({
      snapshot,
      compile: async () => ({ revisionId: 'orders-r2' }),
      present: async () => receipt,
      selection: { intent: 'presentation' }
    });
    expect(result.snapshot).toBe(snapshot);
    expect(result.receipt).toBe(receipt);
  });

  it('rejects stale compiler and frame receipts', async () => {
    await expect(
      refreshPreviewRevision({
        snapshot,
        compile: async () => ({ revisionId: 'orders-r1' }),
        present: async () => receipt,
        selection: { intent: 'authoring', retarget: async (accepted) => accepted }
      })
    ).rejects.toMatchObject({ code: 'revision-mismatch' });
    await expect(
      refreshPreviewRevision({
        snapshot,
        compile: async () => ({ revisionId: 'orders-r2' }),
        present: async () => ({
          identity: identity('orders-r1'),
          visible: true as const
        }),
        selection: { intent: 'authoring', retarget: async (accepted) => accepted }
      })
    ).rejects.toMatchObject({ code: 'revision-mismatch' });
  });

  it('preserves saved source while reporting render and selection failures', async () => {
    await expect(
      refreshPreviewRevision({
        snapshot,
        compile: async () => ({ revisionId: 'orders-r2' }),
        present: async () =>
          Promise.reject(
            new PreviewRefreshError('iframe-runtime-failed', 'orders-r2', 'render failed')
          ),
        selection: { intent: 'authoring', retarget: async (accepted) => accepted }
      })
    ).rejects.toMatchObject({ code: 'iframe-runtime-failed' });
    await expect(
      refreshPreviewRevision({
        snapshot,
        compile: async () => ({ revisionId: 'orders-r2' }),
        present: async () => receipt,
        selection: {
          intent: 'authoring',
          retarget: async () => Promise.reject(new Error('selection removed'))
        }
      })
    ).rejects.toMatchObject({ code: 'selection-retarget-failed' });
  });

  it('supports retry after a transient frame failure and abort during compile', async () => {
    let attempts = 0;
    const refresh = () =>
      refreshPreviewRevision({
        snapshot,
        compile: async () => ({ revisionId: 'orders-r2' }),
        present: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('frame failed');
          return receipt;
        },
        selection: { intent: 'authoring', retarget: async (accepted) => accepted }
      });
    await expect(refresh()).rejects.toMatchObject({ code: 'iframe-load-failed' });
    await expect(refresh()).resolves.toMatchObject({ receipt });

    const controller = new AbortController();
    await expect(
      refreshPreviewRevision({
        snapshot,
        signal: controller.signal,
        compile: async () => {
          controller.abort();
          return { revisionId: 'orders-r2' };
        },
        present: async () => receipt,
        selection: { intent: 'authoring', retarget: async (accepted) => accepted }
      })
    ).rejects.toMatchObject({ code: 'refresh-aborted' });
  });
});
