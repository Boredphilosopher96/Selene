import { useCallback, useEffect, useRef, useState } from 'react';

import { Popover } from '@selene/ui/workspace';

import type {
  DesignerPublishConsentInput,
  DesignerSnapshot,
  GeneratedCodePublishReceipt,
  GitHubPublishSetup
} from '../../../shared/designer-api';
import { CommandPalette } from '../command-palette';
import { presentDesignerError, safeDesignerNotice } from '../presentation-error';
import { PublishPanel } from './publish-panel';
import { useReviewHandoffActions } from './review-handoff-actions';
import { ReviewHandoffPanel } from './review-handoff-panel';
import type { WorkspaceCommand } from './workspace-command-model';
import type { WorkspaceControlActions } from './workspace-controls';
import {
  createDiagnosticsInitialRefreshStore,
  createDiagnosticsActivationTracker,
  createLatestDiagnosticsOperationQueue,
  createDiagnosticsOperationLane,
  type DiagnosticsInitialRefreshKey,
  type DiagnosticsOperationLane,
  type LatestDiagnosticsOperationQueue
} from './workspace-toolbar-diagnostics';

type DiagnosticsConsent = 'unknown' | 'granted' | 'denied';
type DiagnosticsConsentResult = Awaited<
  ReturnType<WorkspaceControlActions['diagnostics']['setConsent']>
>;
type DiagnosticsRefreshResult = readonly [
  Awaited<ReturnType<WorkspaceControlActions['diagnostics']['consent']>>,
  Awaited<ReturnType<WorkspaceControlActions['diagnostics']['recovery']>>
];
type DiagnosticsAdapter = {
  readonly activation: DiagnosticsInitialRefreshKey;
  readonly host: WorkspaceControlActions['diagnostics'];
};

export interface WorkspaceToolbarProps {
  readonly baseline: DesignerSnapshot['baseline'];
  readonly productMap?: DesignerSnapshot['productMap'];
  readonly actions: WorkspaceControlActions;
  readonly onSnapshot: (snapshot: DesignerSnapshot) => void;
  readonly onStatus: (message: string) => void;
  readonly onDeliveryBusyChange: (busy: boolean) => void;
  readonly workspaceBlocked: boolean;
  /** Host-owned download behavior keeps browser/Electron file delivery explicit. */
  readonly onExportHandoff: (contents: string) => void;
  readonly onExportProductHandoff: (contents: string) => void;
  readonly onExportDiagnostics: (contents: string) => void;
  readonly onPublish: (request: DesignerPublishConsentInput) => Promise<void>;
  readonly publishActive: boolean;
  readonly publishStarting: boolean;
  readonly publishStatus: string;
  readonly onCancelPublish: () => Promise<void>;
  readonly onGitHubSetup: () => Promise<GitHubPublishSetup>;
  readonly completedRemoteReceipt?: Extract<
    GeneratedCodePublishReceipt,
    { readonly mode: 'github-remote' }
  >;
  readonly onOpenCompletedReceipt: () => Promise<void>;
}

/** Daily actions stay compact; operational controls are progressive and keyboard-safe. */
export function WorkspaceToolbar({
  baseline,
  productMap,
  actions,
  onSnapshot,
  onStatus,
  onDeliveryBusyChange,
  workspaceBlocked,
  onExportHandoff,
  onExportProductHandoff,
  onExportDiagnostics,
  onPublish,
  publishActive,
  publishStarting,
  publishStatus,
  onCancelPublish,
  onGitHubSetup,
  completedRemoteReceipt,
  onOpenCompletedReceipt
}: WorkspaceToolbarProps) {
  const [consent, setConsent] = useState<DiagnosticsConsent>('unknown');
  const [recoveryActive, setRecoveryActive] = useState<boolean | undefined>(undefined);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(true);
  const [diagnosticsSaving, setDiagnosticsSaving] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState<string | undefined>(undefined);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [reviewHandoffOpen, setReviewHandoffOpen] = useState(false);
  const [compactReviewHandoffOpen, setCompactReviewHandoffOpen] = useState(false);
  const [compactOperationsOpen, setCompactOperationsOpen] = useState(false);
  const [productMapBusy, setProductMapBusy] = useState(false);
  const [productHandoffBusy, setProductHandoffBusy] = useState(false);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const diagnosticsLane = useRef<DiagnosticsOperationLane | undefined>(undefined);
  const diagnosticsConsentQueue = useRef<
    LatestDiagnosticsOperationQueue<'granted' | 'denied'> | undefined
  >(undefined);
  const diagnosticsInitialRefresh = useRef(
    createDiagnosticsInitialRefreshStore<DiagnosticsRefreshResult>()
  );
  const diagnosticsActivations = useRef(createDiagnosticsActivationTracker());
  const activation = diagnosticsActivations.current.activate(baseline.projectId);
  const confirmedConsent = useRef<DiagnosticsConsent>('unknown');
  const diagnosticsAdapterRef = useRef<DiagnosticsAdapter>({
    activation,
    host: actions.diagnostics
  });
  if (
    diagnosticsAdapterRef.current.activation.generation !== activation.generation ||
    diagnosticsAdapterRef.current.activation.projectId !== activation.projectId
  )
    diagnosticsAdapterRef.current = { activation, host: actions.diagnostics };
  useEffect(() => {
    setReviewHandoffOpen(false);
    setCompactReviewHandoffOpen(false);
    setCompactOperationsOpen(false);
  }, [baseline.projectId]);
  const fail = useCallback((error: unknown, _fallback: string) => {
    onStatusRef.current(presentDesignerError(error, 'toolbar'));
  }, []);
  const applyConfirmedConsent = useCallback((next: DiagnosticsConsent) => {
    confirmedConsent.current = next;
    setConsent(next);
  }, []);
  const reportConsentFailure = useCallback((error: unknown) => {
    const message = presentDesignerError(error, 'toolbar');
    setDiagnosticsError(message);
    onStatusRef.current(message);
  }, []);
  const delivery = useReviewHandoffActions({
    baseline,
    actions,
    blocked: workspaceBlocked || publishActive || publishStarting,
    onBusyChange: onDeliveryBusyChange,
    onSnapshot,
    onStatus,
    onExportHandoff,
    onOpenReceipt: onOpenCompletedReceipt
  });
  const runDiagnosticsActionOn = useCallback(
    <Result,>(
      lane: DiagnosticsOperationLane,
      operation: () => Promise<Result>,
      onSuccess: (result: Result) => void,
      fallback: string
    ): void => {
      lane.run({
        operation,
        onSuccess,
        onFailure: (error) => fail(error, fallback),
        onSettled: () => undefined
      });
    },
    [fail]
  );
  const runDiagnosticsAction = useCallback(
    <Result,>(
      operation: () => Promise<Result>,
      onSuccess: (result: Result) => void,
      fallback: string
    ): void => {
      const lane = diagnosticsLane.current;
      if (lane === undefined) return;
      runDiagnosticsActionOn(lane, operation, onSuccess, fallback);
    },
    [runDiagnosticsActionOn]
  );
  const refreshDiagnostics = useCallback(
    (announce = false) =>
      runDiagnosticsAction(
        () => {
          const { host } = diagnosticsAdapterRef.current;
          return Promise.all([host.consent(), host.recovery()]);
        },
        ([nextConsent, recovery]) => {
          applyConfirmedConsent(nextConsent.user);
          setRecoveryActive(recovery.active);
          if (announce) onStatusRef.current('Crash recovery status refreshed.');
        },
        'Diagnostics state could not be loaded.'
      ),
    [applyConfirmedConsent, runDiagnosticsAction]
  );

  useEffect(() => {
    const adapter = diagnosticsAdapterRef.current;
    const initialRefresh = diagnosticsInitialRefresh.current.acquire(adapter.activation, () =>
      Promise.all([adapter.host.consent(), adapter.host.recovery()])
    );
    const lane = createDiagnosticsOperationLane(setDiagnosticsBusy);
    const consentQueue = createLatestDiagnosticsOperationQueue<
      'granted' | 'denied',
      DiagnosticsConsentResult
    >(lane, {
      operation: (choice) => adapter.host.setConsent(choice),
      onSuccess: (_choice, next, isLatest) => {
        confirmedConsent.current = next.user;
        if (!isLatest) return;
        setConsent(next.user);
        setDiagnosticsError(undefined);
        onStatusRef.current(
          next.user === 'granted' ? 'Local diagnostics enabled.' : 'Local diagnostics disabled.'
        );
      },
      onFailure: (_choice, error, isLatest) => {
        if (!isLatest) return;
        setConsent(confirmedConsent.current);
        reportConsentFailure(error);
      },
      onIdle: () => setDiagnosticsSaving(false)
    });
    diagnosticsLane.current = lane;
    diagnosticsConsentQueue.current = consentQueue;
    runDiagnosticsActionOn(
      lane,
      () => initialRefresh,
      ([nextConsent, recovery]) => {
        applyConfirmedConsent(nextConsent.user);
        setRecoveryActive(recovery.active);
      },
      'Diagnostics state could not be loaded.'
    );
    return () => {
      consentQueue.dispose();
      lane.dispose();
      if (diagnosticsLane.current === lane) diagnosticsLane.current = undefined;
      if (diagnosticsConsentQueue.current === consentQueue)
        diagnosticsConsentQueue.current = undefined;
    };
  }, [applyConfirmedConsent, baseline.projectId, reportConsentFailure, runDiagnosticsActionOn]);
  useEffect(() => {
    const openCommandPalette = (event: globalThis.KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.shiftKey ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLocaleLowerCase('en-US') !== 'k'
      )
        return;
      event.preventDefault();
      setCommandQuery('');
      setCommandPaletteOpen(true);
    };
    window.addEventListener('keydown', openCommandPalette);
    return () => window.removeEventListener('keydown', openCommandPalette);
  }, []);

  const render = () =>
    workspaceBlocked
      ? onStatus('Finish opening the selected project before rendering.')
      : void actions
          .render()
          .then(() => onStatus('Rendered current revision.'))
          .catch((error: unknown) => fail(error, 'Render failed.'));
  const resumePreviews = () =>
    runDiagnosticsAction(
      () => actions.diagnostics.resetRecovery(),
      (next) => {
        setRecoveryActive(next.active);
        onStatusRef.current(next.active ? 'Crash recovery remains active.' : 'Previews resumed.');
      },
      'Could not resume previews.'
    );
  const setDiagnosticsConsent = (choice: 'granted' | 'denied') => {
    const queue = diagnosticsConsentQueue.current;
    if (queue === undefined) return;
    setConsent(choice);
    setDiagnosticsError(undefined);
    setDiagnosticsSaving(true);
    queue.submit(choice);
  };
  const exportDiagnostics = () =>
    runDiagnosticsAction(
      () => actions.diagnostics.export(),
      (bundle) => {
        onExportDiagnostics(JSON.stringify(bundle, null, 2));
        onStatusRef.current('Exported local diagnostics.');
      },
      'Diagnostics export failed.'
    );
  const deleteDiagnostics = () =>
    runDiagnosticsAction(
      () => actions.diagnostics.delete(),
      () => onStatusRef.current('Deleted local diagnostics.'),
      'Diagnostics delete failed.'
    );
  const commands: readonly WorkspaceCommand[] = [
    {
      id: 'render-preview',
      label: 'Render current revision',
      detail: 'Compile and refresh the secure React preview.',
      group: 'workspace',
      disabled: workspaceBlocked || recoveryActive !== false,
      execute: render
    },
    {
      id: 'ready-review',
      label: 'Mark ready for review',
      detail: 'Create the design baseline stakeholders will review.',
      group: 'review',
      disabled: delivery.reviewDisabled,
      execute: delivery.readyForReview
    },
    {
      id: 'ready-handoff',
      label: 'Mark ready for handoff',
      detail: 'Prepare the current design baseline for developers.',
      group: 'publish',
      disabled: delivery.handoffDisabled,
      execute: delivery.readyForHandoff
    }
  ];
  const dismissCommandPalette = () => {
    setCommandPaletteOpen(false);
    setCommandQuery('');
  };
  const reviewHandoffPanel = (dismissAfterExport: () => void) => (
    <ReviewHandoffPanel
      baseline={baseline}
      {...(productMap === undefined ? {} : { productMap })}
      productMapBusy={productMapBusy}
      productHandoffBusy={productHandoffBusy}
      onConfigureProductShell={(childProjectIds) => {
        if (productMap === undefined || productMapBusy) return;
        setProductMapBusy(true);
        void actions
          .configureProductShell({
            projectId: productMap.currentProjectId,
            childProjectIds
          })
          .then((next) => {
            onSnapshot(next);
            onStatusRef.current(
              childProjectIds.length === 0
                ? 'Removed the local product shell.'
                : `Saved a product shell with ${childProjectIds.length} child ${
                    childProjectIds.length === 1 ? 'project' : 'projects'
                  }.`
            );
          })
          .catch((error: unknown) => onStatusRef.current(presentDesignerError(error, 'workspace')))
          .finally(() => setProductMapBusy(false));
      }}
      onExportProductHandoff={() => {
        if (productHandoffBusy) return;
        setProductHandoffBusy(true);
        void actions
          .exportProductHandoff()
          .then((contents) => {
            onExportProductHandoff(contents);
            onStatusRef.current('Exported the independently owned product handoff.');
          })
          .catch((error: unknown) => onStatusRef.current(presentDesignerError(error, 'workspace')))
          .finally(() => setProductHandoffBusy(false));
      }}
      {...(delivery.active === undefined ? {} : { active: delivery.active })}
      status={delivery.status}
      reviewDisabled={delivery.reviewDisabled}
      handoffDisabled={delivery.handoffDisabled}
      exportDisabled={delivery.exportDisabled}
      receiptDisabled={delivery.receiptDisabled}
      onReadyForReview={delivery.readyForReview}
      onReadyForHandoff={delivery.readyForHandoff}
      onExportHandoff={() => {
        delivery.exportHandoff();
        dismissAfterExport();
      }}
      onOpenReceipt={delivery.openReceipt}
      publishStatus={publishStatus}
      publishBusy={publishActive || publishStarting}
      {...(completedRemoteReceipt === undefined ? {} : { receipt: completedRemoteReceipt })}
    />
  );
  const publishPanel = () => (
    <PublishPanel
      publishActive={publishActive}
      publishStarting={publishStarting}
      publishStatus={publishStatus}
      onPublish={onPublish}
      onCancel={onCancelPublish}
      setup={onGitHubSetup}
      {...(completedRemoteReceipt === undefined ? {} : { receipt: completedRemoteReceipt })}
      onOpenReceipt={onOpenCompletedReceipt}
    />
  );
  const workspaceOperations = () => (
    <section className="workspace-toolbar__more" aria-label="Workspace operations">
      <button type="button" disabled={delivery.exportDisabled} onClick={delivery.exportHandoff}>
        Export handoff
      </button>
      <section className="workspace-toolbar__status" aria-live="polite">
        <strong>Publish</strong>
        <span>
          {safeDesignerNotice(publishStatus, 'Publish status is unavailable. Try again.')}
        </span>
        {publishActive && !publishStarting ? (
          <button
            type="button"
            onClick={() =>
              void onCancelPublish().catch((error: unknown) =>
                fail(error, 'Could not cancel publish operation.')
              )
            }
          >
            Cancel publish
          </button>
        ) : null}
      </section>
      <section
        className="workspace-toolbar__status"
        aria-live="polite"
        data-diagnostics-busy={diagnosticsBusy}
        data-diagnostics-consent={consent}
        data-diagnostics-recovery={
          recoveryActive === undefined ? 'checking' : recoveryActive ? 'active' : 'clear'
        }
        data-diagnostics-saving={diagnosticsSaving}
      >
        <strong>Crash recovery</strong>
        <span>
          {recoveryActive === undefined
            ? 'Checking recovery status…'
            : recoveryActive
              ? 'Preview execution is paused.'
              : 'No recovery action is required.'}
        </span>
        <button type="button" disabled={diagnosticsBusy} onClick={() => refreshDiagnostics(true)}>
          Refresh recovery status
        </button>
        {recoveryActive ? (
          <button type="button" disabled={diagnosticsBusy} onClick={resumePreviews}>
            Resume previews
          </button>
        ) : null}
      </section>
      <label className="workspace-toolbar__consent">
        <input
          type="checkbox"
          checked={consent === 'granted'}
          disabled={diagnosticsBusy}
          aria-describedby={
            diagnosticsError === undefined ? undefined : 'workspace-diagnostics-consent-error'
          }
          onChange={(event) =>
            setDiagnosticsConsent(event.currentTarget.checked ? 'granted' : 'denied')
          }
        />
        Store local crash diagnostics on this device
      </label>
      {diagnosticsSaving ? <span role="status">Saving diagnostics preference…</span> : null}
      {diagnosticsError === undefined ? null : (
        <span id="workspace-diagnostics-consent-error" role="alert">
          {diagnosticsError}
        </span>
      )}
      <button type="button" disabled={diagnosticsBusy} onClick={exportDiagnostics}>
        Export diagnostics
      </button>
      <button type="button" disabled={diagnosticsBusy} onClick={deleteDiagnostics}>
        Delete diagnostics
      </button>
    </section>
  );

  return (
    <div className="workspace-toolbar" role="toolbar" aria-label="Daily workspace actions">
      <CommandPalette
        open={commandPaletteOpen}
        query={commandQuery}
        commands={commands}
        onQueryChange={setCommandQuery}
        onOpenChange={(next) => {
          setCommandPaletteOpen(next);
          if (!next) setCommandQuery('');
        }}
        onSelect={(command) => {
          dismissCommandPalette();
          void command.execute();
        }}
      />
      <button
        type="button"
        disabled={workspaceBlocked || recoveryActive !== false}
        onClick={render}
      >
        Render
      </button>
      <Popover
        contentLabel="Review and developer handoff"
        triggerText="Review & handoff"
        open={reviewHandoffOpen}
        onOpenChange={setReviewHandoffOpen}
      >
        {reviewHandoffPanel(() => setReviewHandoffOpen(false))}
      </Popover>
      <Popover contentLabel="Publish generated project" triggerText="Publish">
        {publishPanel()}
      </Popover>
      <Popover contentLabel="Workspace operations" triggerText="More">
        {workspaceOperations()}
      </Popover>
      <span className="workspace-toolbar__compact-overflow">
        <Popover
          contentLabel="Compact action menu"
          triggerText="Operations"
          open={compactOperationsOpen}
          onOpenChange={setCompactOperationsOpen}
        >
          <section
            className="workspace-toolbar__compact-operations"
            aria-label="Compact action menu"
          >
            <Popover
              contentLabel="Review and developer handoff"
              triggerText="Review & handoff"
              open={compactReviewHandoffOpen}
              onOpenChange={setCompactReviewHandoffOpen}
            >
              {reviewHandoffPanel(() => {
                setCompactReviewHandoffOpen(false);
                setCompactOperationsOpen(false);
              })}
            </Popover>
            <Popover contentLabel="Publish generated project" triggerText="Publish">
              {publishPanel()}
            </Popover>
            <Popover contentLabel="Workspace operations" triggerText="More">
              {workspaceOperations()}
            </Popover>
          </section>
        </Popover>
      </span>
    </div>
  );
}
