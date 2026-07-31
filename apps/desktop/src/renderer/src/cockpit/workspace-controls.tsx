import { useCallback, useEffect, useState } from 'react';

import type {
  DesignerSnapshot,
  ProductShellConfigurationInput
} from '../../../shared/designer-api';
import { presentDesignerError } from '../presentation-error';

export interface WorkspaceControlActions {
  render(): Promise<void>;
  markReadyForReview(): Promise<DesignerSnapshot>;
  markReadyForHandoff(): Promise<DesignerSnapshot>;
  exportHandoff(): Promise<string>;
  exportProductHandoff(): Promise<string>;
  configureProductShell(input: ProductShellConfigurationInput): Promise<DesignerSnapshot>;
  diagnostics: {
    export(): Promise<unknown>;
    delete(): Promise<void>;
    consent(): Promise<{ readonly user: 'unknown' | 'granted' | 'denied' }>;
    setConsent(
      choice: 'granted' | 'denied'
    ): Promise<{ readonly user: 'unknown' | 'granted' | 'denied' }>;
    recovery(): Promise<{ readonly active: boolean }>;
    resetRecovery(): Promise<{ readonly active: boolean }>;
  };
}

function download(contents: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** Production topbar controls; effects stay in injected renderer orchestration. */
export function WorkspaceControls({
  actions,
  onSnapshot,
  onStatus
}: {
  readonly actions: WorkspaceControlActions;
  readonly onSnapshot: (snapshot: DesignerSnapshot) => void;
  readonly onStatus: (message: string) => void;
}) {
  const [consent, setConsent] = useState<'unknown' | 'granted' | 'denied'>('unknown');
  const [recoveryActive, setRecoveryActive] = useState<boolean | undefined>(undefined);
  const fail = (error: unknown, _fallback: string) =>
    onStatus(presentDesignerError(error, 'workspace'));
  const refresh = useCallback(
    () =>
      void Promise.all([actions.diagnostics.consent(), actions.diagnostics.recovery()])
        .then(([nextConsent, recovery]) => {
          setConsent(nextConsent.user);
          setRecoveryActive(recovery.active);
        })
        .catch((error: unknown) => fail(error, 'Diagnostics state could not be loaded.')),
    [actions.diagnostics, onStatus]
  );
  useEffect(() => {
    refresh();
  }, [refresh]);
  return (
    <section aria-label="Workspace controls">
      <button
        type="button"
        onClick={() =>
          void actions
            .render()
            .then(() => onStatus('Rendered current revision.'))
            .catch((error: unknown) => fail(error, 'Render failed.'))
        }
        disabled={recoveryActive !== false}
      >
        Render revision
      </button>
      {recoveryActive === undefined ? <span role="status">Checking crash recovery…</span> : null}
      <button
        type="button"
        onClick={() =>
          void actions
            .markReadyForReview()
            .then(onSnapshot)
            .catch((error: unknown) => fail(error, 'Could not mark ready for review.'))
        }
      >
        Ready for review
      </button>
      <button
        type="button"
        onClick={() =>
          void actions
            .markReadyForHandoff()
            .then(onSnapshot)
            .catch((error: unknown) => fail(error, 'Could not mark ready for handoff.'))
        }
      >
        Ready for handoff
      </button>
      <button
        type="button"
        onClick={() =>
          void actions
            .exportHandoff()
            .then((handoff) => {
              download(handoff, 'selene-desktop.handoff.json');
              onStatus('Exported developer handoff.');
            })
            .catch((error: unknown) => fail(error, 'Handoff export failed.'))
        }
      >
        Export handoff
      </button>
      <button type="button" onClick={refresh}>
        Refresh diagnostics
      </button>
      {recoveryActive ? (
        <span role="alert">
          Crash recovery pauses previews.{' '}
          <button
            type="button"
            onClick={() =>
              void actions.diagnostics
                .resetRecovery()
                .then((next) => {
                  setRecoveryActive(next.active);
                  onStatus('Crash recovery reset.');
                })
                .catch((error: unknown) => fail(error, 'Could not reset crash recovery.'))
            }
          >
            Resume previews
          </button>
        </span>
      ) : null}
      <label>
        <input
          type="checkbox"
          checked={consent === 'granted'}
          onChange={(event) =>
            void actions.diagnostics
              .setConsent(event.currentTarget.checked ? 'granted' : 'denied')
              .then((next) => {
                setConsent(next.user);
                onStatus(
                  next.user === 'granted'
                    ? 'Local diagnostics enabled.'
                    : 'Local diagnostics disabled.'
                );
              })
              .catch((error: unknown) => fail(error, 'Diagnostics consent could not be saved.'))
          }
        />
        Store local crash diagnostics on this device
      </label>
      <button
        type="button"
        onClick={() =>
          void actions.diagnostics
            .export()
            .then((bundle) => {
              download(JSON.stringify(bundle, null, 2), 'selene-crash-diagnostics.json');
              onStatus('Exported local diagnostics.');
            })
            .catch((error: unknown) => fail(error, 'Diagnostics export failed.'))
        }
      >
        Export diagnostics
      </button>
      <button
        type="button"
        onClick={() =>
          void actions.diagnostics
            .delete()
            .then(() => onStatus('Deleted local diagnostics.'))
            .catch((error: unknown) => fail(error, 'Diagnostics delete failed.'))
        }
      >
        Delete diagnostics
      </button>
    </section>
  );
}
