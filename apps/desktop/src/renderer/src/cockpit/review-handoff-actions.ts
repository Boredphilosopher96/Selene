import { useCallback, useEffect, useRef, useState } from 'react';

import type { DesignerSnapshot } from '../../../shared/designer-api';
import { presentDesignerError } from '../presentation-error';
import type { WorkspaceControlActions } from './workspace-controls';

export type ReviewHandoffAction = 'review' | 'handoff' | 'export' | 'receipt';

interface ReviewHandoffActionsInput {
  readonly baseline: DesignerSnapshot['baseline'];
  readonly actions: WorkspaceControlActions;
  readonly blocked: boolean;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onSnapshot: (snapshot: DesignerSnapshot) => void;
  readonly onStatus: (message: string) => void;
  readonly onExportHandoff: (contents: string) => void;
  readonly onOpenReceipt: () => Promise<void>;
}

/** One project-fenced, single-flight path for toolbar, command, and panel delivery actions. */
export function useReviewHandoffActions({
  baseline,
  actions,
  blocked,
  onBusyChange,
  onSnapshot,
  onStatus,
  onExportHandoff,
  onOpenReceipt
}: ReviewHandoffActionsInput) {
  const [active, setActive] = useState<ReviewHandoffAction>();
  const [status, setStatus] = useState('Choose a host-backed next step.');
  const activeRef = useRef(false);
  const projectIdRef = useRef(baseline.projectId);
  projectIdRef.current = baseline.projectId;
  useEffect(() => {
    if (!activeRef.current) setStatus('Choose a host-backed next step.');
  }, [baseline.projectId]);

  const run = useCallback(
    <Result>(
      kind: ReviewHandoffAction,
      pending: string,
      success: string,
      work: () => Promise<Result>,
      commit?: (result: Result) => void
    ): void => {
      if (blocked || activeRef.current) return;
      const projectId = projectIdRef.current;
      activeRef.current = true;
      onBusyChange(true);
      setActive(kind);
      setStatus(pending);
      void work()
        .then((result) => {
          if (projectIdRef.current !== projectId) {
            const message =
              'The operation finished for the previous project; no state was applied here.';
            setStatus(message);
            onStatus(message);
            return;
          }
          commit?.(result);
          setStatus(success);
          onStatus(success);
        })
        .catch((error: unknown) => {
          if (projectIdRef.current !== projectId) {
            const message =
              'The previous project operation ended after the project changed; this project was not modified.';
            setStatus(message);
            onStatus(message);
            return;
          }
          const message = presentDesignerError(error, kind === 'export' ? 'handoff' : 'review');
          setStatus(message);
          onStatus(message);
        })
        .finally(() => {
          activeRef.current = false;
          onBusyChange(false);
          setActive(undefined);
        });
    },
    [blocked, onBusyChange, onStatus]
  );

  const readyForReview = useCallback(
    () =>
      run(
        'review',
        'Creating an immutable review baseline…',
        'Marked ready for review.',
        actions.markReadyForReview,
        onSnapshot
      ),
    [actions.markReadyForReview, onSnapshot, run]
  );
  const readyForHandoff = useCallback(
    () =>
      run(
        'handoff',
        'Creating an immutable developer handoff baseline…',
        'Marked ready for handoff.',
        actions.markReadyForHandoff,
        onSnapshot
      ),
    [actions.markReadyForHandoff, onSnapshot, run]
  );
  const exportHandoff = useCallback(
    () =>
      run(
        'export',
        'Preparing the developer handoff…',
        'Exported the developer handoff.',
        actions.exportHandoff,
        onExportHandoff
      ),
    [actions.exportHandoff, onExportHandoff, run]
  );
  const openReceipt = useCallback(
    () =>
      run(
        'receipt',
        'Opening the verified publish receipt…',
        'Opened the immutable publish receipt.',
        onOpenReceipt
      ),
    [onOpenReceipt, run]
  );

  const reviewCurrent =
    baseline.readiness === 'ready-for-review' &&
    baseline.currency === 'current' &&
    !baseline.approvalsStale &&
    baseline.changesSinceBaseline.length === 0;
  const handoffCurrent =
    baseline.readiness === 'ready-for-handoff' &&
    baseline.currency === 'current' &&
    !baseline.approvalsStale &&
    baseline.changesSinceBaseline.length === 0;
  // Staleness is developer handoff evidence, not a reason to hide that evidence.
  // Export remains unavailable until an actual handoff baseline exists.
  const handoffEstablished =
    baseline.readiness === 'ready-for-handoff' && baseline.baseline?.intent === 'handoff';
  const busy = blocked || active !== undefined;

  return {
    active,
    status,
    readyForReview,
    readyForHandoff,
    exportHandoff,
    openReceipt,
    reviewDisabled: busy || reviewCurrent,
    handoffDisabled: busy || handoffCurrent,
    exportDisabled: busy || !handoffEstablished,
    receiptDisabled: busy
  } as const;
}
