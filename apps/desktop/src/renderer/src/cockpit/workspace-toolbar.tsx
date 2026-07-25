import { useCallback, useEffect, useState } from 'react';

import { Popover } from '@selene/ui/workspace';

import type { DesignerPublishConsentInput, DesignerSnapshot } from '../../../shared/designer-api';
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
  readonly publishStatus: string;
  readonly onCancelPublish: () => Promise<void>;
}

/** Daily actions stay compact; operational controls are progressive and keyboard-safe. */
export function WorkspaceToolbar({
  actions, onSnapshot, onStatus, onExportHandoff, onExportDiagnostics, onPublish, publishActive, publishStatus, onCancelPublish
}: WorkspaceToolbarProps) {
  const [repository, setRepository] = useState('owner/desktop-design');
  const [title, setTitle] = useState('Review generated desktop flow');
  const [publishMode, setPublishMode] = useState<'local-preview' | 'github-remote'>('local-preview');
  const [consent, setConsent] = useState<DiagnosticsConsent>('unknown');
  const [recoveryActive, setRecoveryActive] = useState<boolean | undefined>(undefined);
  const fail = useCallback((error: unknown, fallback: string) => {
    onStatus(error instanceof Error ? error.message : fallback);
  }, [onStatus]);
  const refreshDiagnostics = useCallback(async () => {
    const [nextConsent, recovery] = await Promise.all([actions.diagnostics.consent(), actions.diagnostics.recovery()]);
    setConsent(nextConsent.user);
    setRecoveryActive(recovery.active);
  }, [actions.diagnostics]);

  useEffect(() => {
    void refreshDiagnostics().catch((error: unknown) => fail(error, 'Diagnostics state could not be loaded.'));
  }, [fail, refreshDiagnostics]);

  const render = () => void actions.render()
    .then(() => onStatus('Rendered current revision.'))
    .catch((error: unknown) => fail(error, 'Render failed.'));
  const markReadyForReview = () => void actions.markReadyForReview()
    .then((snapshot) => { onSnapshot(snapshot); onStatus('Marked ready for review.'); })
    .catch((error: unknown) => fail(error, 'Could not mark ready for review.'));
  const markReadyForHandoff = () => void actions.markReadyForHandoff()
    .then((snapshot) => { onSnapshot(snapshot); onStatus('Marked ready for handoff.'); })
    .catch((error: unknown) => fail(error, 'Could not mark ready for handoff.'));
  const exportHandoff = () => void actions.exportHandoff()
    .then((contents) => { onExportHandoff(contents); onStatus('Exported developer handoff.'); })
    .catch((error: unknown) => fail(error, 'Handoff export failed.'));
  const requestPublish = () => {
    const request: DesignerPublishConsentInput = publishMode === 'github-remote'
      ? { mode: 'github-remote', repository, title }
      : { mode: 'local-preview', title };
    return void onPublish(request)
      .then(() => onStatus(publishMode === 'github-remote' ? 'Remote publish requested.' : 'Local immutable bundle validation requested.'))
      .catch((error: unknown) => fail(error, publishMode === 'github-remote' ? 'Could not request remote publish.' : 'Could not validate a local immutable bundle.'));
  };
  const resumePreviews = () => void actions.diagnostics.resetRecovery()
    .then((next) => { setRecoveryActive(next.active); onStatus(next.active ? 'Crash recovery remains active.' : 'Previews resumed.'); })
    .catch((error: unknown) => fail(error, 'Could not resume previews.'));
  const setDiagnosticsConsent = (choice: 'granted' | 'denied') => void actions.diagnostics.setConsent(choice)
    .then((next) => {
      setConsent(next.user);
      onStatus(next.user === 'granted' ? 'Local diagnostics enabled.' : 'Local diagnostics disabled.');
    })
    .catch((error: unknown) => fail(error, 'Diagnostics consent could not be saved.'));
  const exportDiagnostics = () => void actions.diagnostics.export()
    .then((bundle) => { onExportDiagnostics(JSON.stringify(bundle, null, 2)); onStatus('Exported local diagnostics.'); })
    .catch((error: unknown) => fail(error, 'Diagnostics export failed.'));
  const deleteDiagnostics = () => void actions.diagnostics.delete()
    .then(() => onStatus('Deleted local diagnostics.'))
    .catch((error: unknown) => fail(error, 'Diagnostics delete failed.'));

  return <div className="workspace-toolbar" role="toolbar" aria-label="Daily workspace actions">
    <button type="button" disabled={recoveryActive !== false} onClick={render}>Render</button>
    <button type="button" onClick={markReadyForReview}>Ready for review</button>
    <button type="button" onClick={markReadyForHandoff}>Ready for handoff</button>
    <button type="button" disabled={publishActive} onClick={requestPublish}>{publishActive ? 'Publishing…' : 'Publish'}</button>
    <Popover contentLabel="Workspace operations" triggerText="More">
      <section className="workspace-toolbar__more" aria-label="Workspace operations">
        <label>Publish mode<select value={publishMode} onChange={(event) => setPublishMode(event.currentTarget.value as 'local-preview' | 'github-remote')}><option value="local-preview">Validate local bundle</option><option value="github-remote">GitHub remote (adapter required)</option></select></label>
        {publishMode === 'github-remote'
          ? <label>Repository<input value={repository} onChange={(event) => setRepository(event.currentTarget.value)} /></label>
          : <p>Local validation does not publish to a repository or retain files.</p>}
        <label>{publishMode === 'github-remote' ? 'Remote review title' : 'Bundle title'}<input value={title} onChange={(event) => setTitle(event.currentTarget.value)} /></label>
        <button type="button" onClick={exportHandoff}>Export handoff</button>
        <section className="workspace-toolbar__status" aria-live="polite">
          <strong>Publish</strong><span>{publishStatus}</span>
          {publishActive ? <button type="button" onClick={() => void onCancelPublish().catch((error: unknown) => fail(error, 'Could not cancel publish operation.'))}>Cancel publish</button> : null}
        </section>
        <section className="workspace-toolbar__status" aria-live="polite">
          <strong>Crash recovery</strong>
          <span>{recoveryActive === undefined ? 'Checking recovery status…' : recoveryActive ? 'Preview execution is paused.' : 'No recovery action is required.'}</span>
          <button type="button" onClick={() => void refreshDiagnostics().then(() => onStatus('Crash recovery status refreshed.')).catch((error: unknown) => fail(error, 'Crash recovery status could not be loaded.'))}>Refresh recovery status</button>
          {recoveryActive ? <button type="button" onClick={resumePreviews}>Resume previews</button> : null}
        </section>
        <label className="workspace-toolbar__consent"><input type="checkbox" checked={consent === 'granted'} onChange={(event) => setDiagnosticsConsent(event.currentTarget.checked ? 'granted' : 'denied')} />Store local crash diagnostics</label>
        <button type="button" onClick={exportDiagnostics}>Export diagnostics</button>
        <button type="button" onClick={deleteDiagnostics}>Delete diagnostics</button>
      </section>
    </Popover>
  </div>;
}
