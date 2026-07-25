import { useCallback, useEffect, useState } from 'react';

import { Popover } from '@selene/ui/workspace';

import type { DesignerPublishConsentInput, DesignerSnapshot, GitHubPublishSetup } from '../../../shared/designer-api';
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
  readonly onGitHubSetup: () => Promise<GitHubPublishSetup>;
}

/** Daily actions stay compact; operational controls are progressive and keyboard-safe. */
export function WorkspaceToolbar({
  actions, onSnapshot, onStatus, onExportHandoff, onExportDiagnostics, onPublish, publishActive, publishStatus, onCancelPublish, onGitHubSetup
}: WorkspaceToolbarProps) {
  const [repository, setRepository] = useState('owner/desktop-design');
  const [title, setTitle] = useState('Review generated desktop flow');
  const [publishMode, setPublishMode] = useState<'local-preview' | 'github-remote'>('local-preview');
  const [consent, setConsent] = useState<DiagnosticsConsent>('unknown');
  const [recoveryActive, setRecoveryActive] = useState<boolean | undefined>(undefined);
  const [github, setGithub] = useState<GitHubPublishSetup>();
  const [createRepository, setCreateRepository] = useState(false);
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [visibilityConfirmed, setVisibilityConfirmed] = useState(false);
  const [ownerKind, setOwnerKind] = useState<'current-user' | 'organization'>('current-user');
  const [organization, setOrganization] = useState('');
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
  const refreshGitHub = () => void onGitHubSetup().then(setGithub).catch((error: unknown) => fail(error, 'GitHub setup state could not be loaded.'));

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
      ? { mode: 'github-remote', repository, title, ...(createRepository ? { provisioning: { create: true as const, owner: ownerKind === 'current-user' ? { kind: 'current-user' as const, login: github?.account ?? '' } : { kind: 'organization' as const, login: organization }, visibility, visibilityConfirmed: true as const } } : {}) }
      : { mode: 'local-preview', title };
    if (publishMode === 'github-remote' && github?.authenticated !== true) return onStatus('GitHub authentication is required before remote publish.');
    if (publishMode === 'github-remote' && createRepository && !visibilityConfirmed) return onStatus('Confirm the selected repository visibility before creating it.');
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
        <label>Publish mode<select value={publishMode} onChange={(event) => setPublishMode(event.currentTarget.value as 'local-preview' | 'github-remote')}><option value="local-preview">Validate local bundle</option><option value="github-remote">GitHub remote</option></select></label>
        {publishMode === 'github-remote'
          ? <><section className="workspace-toolbar__status" aria-live="polite"><strong>GitHub setup</strong><span>{github === undefined ? 'Check trusted GitHub CLI and authentication before publishing.' : github.authenticated ? 'Authenticated as ' + github.account : github.installed ? 'GitHub authentication is required.' : 'Trusted GitHub CLI is unavailable.'}</span><button type="button" onClick={refreshGitHub}>Check GitHub setup</button></section><label>Repository<input value={repository} onChange={(event) => setRepository(event.currentTarget.value)} aria-describedby="github-repository-help" /></label><p id="github-repository-help">Use an existing canonical owner/repository, or explicitly create the named repository with the selected visibility.</p><label className="workspace-toolbar__consent"><input type="checkbox" checked={createRepository} onChange={(event) => setCreateRepository(event.currentTarget.checked)} />Create this repository if it does not exist</label>{createRepository ? <><label>Owner<select value={ownerKind} onChange={(event) => setOwnerKind(event.currentTarget.value as 'current-user' | 'organization')}><option value="current-user">Current user</option><option value="organization">Organization</option></select></label>{ownerKind === 'organization' ? <label>Organization login<input value={organization} onChange={(event) => setOrganization(event.currentTarget.value)} /></label> : <p>Creates only for the authenticated account shown above.</p>}<label>Visibility<select value={visibility} onChange={(event) => setVisibility(event.currentTarget.value as 'private' | 'public')}><option value="private">Private</option><option value="public">Public</option></select></label><label className="workspace-toolbar__consent"><input type="checkbox" checked={visibilityConfirmed} onChange={(event) => setVisibilityConfirmed(event.currentTarget.checked)} />I confirm this repository visibility.</label></> : null}</>
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
