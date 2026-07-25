import { useCallback, useEffect, useState } from 'react';

import { Popover } from '@selene/ui/workspace';

import type {
  DesignerPublishConsentInput,
  DesignerSnapshot,
  GeneratedCodePublishReceipt,
  GitHubPublishSetup
} from '../../../shared/designer-api';
import { CommandPalette } from '../command-palette';
import { PublishPanel } from './publish-panel';
import type { WorkspaceCommand } from './workspace-command-model';
import type { WorkspaceControlActions } from './workspace-controls';

type DiagnosticsConsent = 'unknown' | 'granted' | 'denied';

export interface WorkspaceToolbarProps {
  readonly actions: WorkspaceControlActions;
  readonly onSnapshot: (snapshot: DesignerSnapshot) => void;
  readonly onStatus: (message: string) => void;
  /** Host-owned download behavior keeps browser/Electron file delivery explicit. */
  readonly onExportHandoff: (contents: string) => void;
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
  actions,
  onSnapshot,
  onStatus,
  onExportHandoff,
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
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const fail = useCallback(
    (error: unknown, fallback: string) => {
      onStatus(error instanceof Error ? error.message : fallback);
    },
    [onStatus]
  );
  const refreshDiagnostics = useCallback(async () => {
    const [nextConsent, recovery] = await Promise.all([
      actions.diagnostics.consent(),
      actions.diagnostics.recovery()
    ]);
    setConsent(nextConsent.user);
    setRecoveryActive(recovery.active);
  }, [actions.diagnostics]);

  useEffect(() => {
    void refreshDiagnostics().catch((error: unknown) =>
      fail(error, 'Diagnostics state could not be loaded.')
    );
  }, [fail, refreshDiagnostics]);
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
    void actions
      .render()
      .then(() => onStatus('Rendered current revision.'))
      .catch((error: unknown) => fail(error, 'Render failed.'));
  const markReadyForReview = () =>
    void actions
      .markReadyForReview()
      .then((snapshot) => {
        onSnapshot(snapshot);
        onStatus('Marked ready for review.');
      })
      .catch((error: unknown) => fail(error, 'Could not mark ready for review.'));
  const markReadyForHandoff = () =>
    void actions
      .markReadyForHandoff()
      .then((snapshot) => {
        onSnapshot(snapshot);
        onStatus('Marked ready for handoff.');
      })
      .catch((error: unknown) => fail(error, 'Could not mark ready for handoff.'));
  const exportHandoff = () =>
    void actions
      .exportHandoff()
      .then((contents) => {
        onExportHandoff(contents);
        onStatus('Exported developer handoff.');
      })
      .catch((error: unknown) => fail(error, 'Handoff export failed.'));
  const resumePreviews = () =>
    void actions.diagnostics
      .resetRecovery()
      .then((next) => {
        setRecoveryActive(next.active);
        onStatus(next.active ? 'Crash recovery remains active.' : 'Previews resumed.');
      })
      .catch((error: unknown) => fail(error, 'Could not resume previews.'));
  const setDiagnosticsConsent = (choice: 'granted' | 'denied') =>
    void actions.diagnostics
      .setConsent(choice)
      .then((next) => {
        setConsent(next.user);
        onStatus(
          next.user === 'granted' ? 'Local diagnostics enabled.' : 'Local diagnostics disabled.'
        );
      })
      .catch((error: unknown) => fail(error, 'Diagnostics consent could not be saved.'));
  const exportDiagnostics = () =>
    void actions.diagnostics
      .export()
      .then((bundle) => {
        onExportDiagnostics(JSON.stringify(bundle, null, 2));
        onStatus('Exported local diagnostics.');
      })
      .catch((error: unknown) => fail(error, 'Diagnostics export failed.'));
  const deleteDiagnostics = () =>
    void actions.diagnostics
      .delete()
      .then(() => onStatus('Deleted local diagnostics.'))
      .catch((error: unknown) => fail(error, 'Diagnostics delete failed.'));
  const commands: readonly WorkspaceCommand[] = [
    {
      id: 'render-preview',
      label: 'Render current revision',
      detail: 'Compile and refresh the secure React preview.',
      group: 'workspace',
      keywords: ['refresh', 'compile', 'canvas'],
      disabled: recoveryActive !== false,
      execute: render
    },
    {
      id: 'ready-review',
      label: 'Mark ready for review',
      detail: 'Create the design baseline stakeholders will review.',
      group: 'review',
      keywords: ['baseline', 'stakeholder'],
      execute: markReadyForReview
    },
    {
      id: 'ready-handoff',
      label: 'Mark ready for handoff',
      detail: 'Prepare the current design baseline for developers.',
      group: 'publish',
      keywords: ['developer', 'delivery'],
      execute: markReadyForHandoff
    },
    {
      id: 'export-handoff',
      label: 'Export developer handoff',
      detail: 'Download the generated-code handoff bundle.',
      group: 'publish',
      keywords: ['download', 'bundle'],
      execute: exportHandoff
    }
  ];
  const dismissCommandPalette = () => {
    setCommandPaletteOpen(false);
    setCommandQuery('');
  };

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
        onSelect={(commandId) => {
          const command = commands.find((candidate) => candidate.id === commandId);
          if (!command || command.disabled) return;
          dismissCommandPalette();
          void command.execute();
        }}
      />
      <button type="button" disabled={recoveryActive !== false} onClick={render}>
        Render
      </button>
      <button type="button" onClick={markReadyForReview}>
        Ready for review
      </button>
      <button type="button" onClick={markReadyForHandoff}>
        Ready for handoff
      </button>
      <Popover contentLabel="Publish generated project" triggerText="Publish">
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
      </Popover>
      <Popover contentLabel="Workspace operations" triggerText="More">
        <section className="workspace-toolbar__more" aria-label="Workspace operations">
          <button type="button" onClick={exportHandoff}>
            Export handoff
          </button>
          <section className="workspace-toolbar__status" aria-live="polite">
            <strong>Publish</strong>
            <span>{publishStatus}</span>
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
          <section className="workspace-toolbar__status" aria-live="polite">
            <strong>Crash recovery</strong>
            <span>
              {recoveryActive === undefined
                ? 'Checking recovery status…'
                : recoveryActive
                  ? 'Preview execution is paused.'
                  : 'No recovery action is required.'}
            </span>
            <button
              type="button"
              onClick={() =>
                void refreshDiagnostics()
                  .then(() => onStatus('Crash recovery status refreshed.'))
                  .catch((error: unknown) =>
                    fail(error, 'Crash recovery status could not be loaded.')
                  )
              }
            >
              Refresh recovery status
            </button>
            {recoveryActive ? (
              <button type="button" onClick={resumePreviews}>
                Resume previews
              </button>
            ) : null}
          </section>
          <label className="workspace-toolbar__consent">
            <input
              type="checkbox"
              checked={consent === 'granted'}
              onChange={(event) =>
                setDiagnosticsConsent(event.currentTarget.checked ? 'granted' : 'denied')
              }
            />
            Store local crash diagnostics
          </label>
          <button type="button" onClick={exportDiagnostics}>
            Export diagnostics
          </button>
          <button type="button" onClick={deleteDiagnostics}>
            Delete diagnostics
          </button>
        </section>
      </Popover>
    </div>
  );
}
