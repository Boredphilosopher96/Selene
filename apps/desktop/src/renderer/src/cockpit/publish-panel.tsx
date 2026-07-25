import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { DesignerPublishConsentInput, GitHubPublishSetup } from '../../../shared/designer-api';

export interface PublishPanelProps {
  readonly publishActive: boolean;
  readonly publishStatus: string;
  readonly onPublish: (request: DesignerPublishConsentInput) => Promise<void>;
  readonly onCancel: () => Promise<void>;
  readonly setup: () => Promise<GitHubPublishSetup>;
}

function repositoryError(value: string): string | undefined {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/.test(value) || value.includes('..') || value.endsWith('.') || value.endsWith('.git')) return 'Use canonical owner/repository form.';
}
function titleError(value: string): string | undefined { return value.length === 0 || value.length > 240 || /[\u0000-\u001f\u007f]/.test(value) ? 'Title must be 1–240 printable characters.' : undefined; }

/** Focused data-only publish flow. It never receives filesystem, process, or credential authority. */
export function PublishPanel({ publishActive, publishStatus, onPublish, onCancel, setup }: PublishPanelProps) {
  const [mode, setMode] = useState<'local-preview' | 'github-remote'>('local-preview');
  const [repository, setRepository] = useState('owner/desktop-design');
  const [title, setTitle] = useState('Review generated desktop flow');
  const [choice, setChoice] = useState<'existing' | 'create'>('existing');
  const [ownerKind, setOwnerKind] = useState<'current-user' | 'organization'>('current-user');
  const [organization, setOrganization] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [visibilityConfirmed, setVisibilityConfirmed] = useState(false);
  const [setupState, setSetupState] = useState<{ readonly phase: 'idle' | 'loading' | 'ready' | 'failed'; readonly value?: GitHubPublishSetup }>({ phase: 'idle' });
  const [error, setError] = useState<string>();
  const token = useRef(0);
  const refreshSetup = useCallback(() => {
    const request = ++token.current; setSetupState({ phase: 'loading' }); setError(undefined);
    void setup().then((value) => { if (request === token.current) setSetupState({ phase: 'ready', value }); }).catch(() => { if (request === token.current) { setSetupState({ phase: 'failed' }); setError('GitHub setup could not be refreshed. Retry when the host is available.'); } });
  }, [setup]);
  useEffect(() => { if (mode === 'github-remote') refreshSetup(); return () => { token.current += 1; }; }, [mode, refreshSetup]);
  const github = setupState.value;
  const account = github?.status === 'available' && github.authentication === 'authenticated' ? github.account : undefined;
  const owner = ownerKind === 'current-user' ? account ?? '' : organization;
  const repositoryIssue = mode === 'github-remote' ? repositoryError(repository) : undefined;
  const titleIssue = titleError(title);
  const setupIssue = mode !== 'github-remote' ? undefined : setupState.phase === 'loading' ? 'Checking trusted GitHub setup.' : setupState.phase === 'failed' ? 'GitHub setup unavailable. Retry.' : github?.status === 'unavailable' ? 'Trusted GitHub CLI is unavailable.' : github?.status === 'offline' ? 'GitHub is offline or rate limited.' : github?.status === 'recovery-required' ? 'Host recovery is required before another GitHub operation.' : account === undefined ? 'GitHub authentication is required.' : undefined;
  const disabledReason = useMemo(() => publishActive ? 'A publish operation is already active.' : titleIssue ?? repositoryIssue ?? setupIssue ?? (mode === 'github-remote' && choice === 'create' && owner.length === 0 ? 'Choose an authenticated owner or enter an organization login.' : undefined) ?? (mode === 'github-remote' && choice === 'create' && !visibilityConfirmed ? 'Confirm the selected repository visibility.' : undefined), [choice, mode, owner.length, publishActive, repositoryIssue, setupIssue, titleIssue, visibilityConfirmed]);
  const submit = useCallback(() => {
    if (disabledReason !== undefined) return;
    const request: DesignerPublishConsentInput = mode === 'local-preview' ? { mode, title } : { mode, title, repository, ...(choice === 'create' ? { provisioning: { create: true as const, owner: ownerKind === 'current-user' ? { kind: 'current-user' as const, login: owner } : { kind: 'organization' as const, login: owner }, visibility, visibilityConfirmed: true as const } } : {}) };
    setError(undefined); void onPublish(request).catch(() => setError('Publish could not be started. Check the target and retry.'));
  }, [choice, disabledReason, mode, onPublish, organization, owner, ownerKind, repository, title, visibility]);
  const cancel = useCallback(() => { setError(undefined); void onCancel().catch(() => setError('Cancellation could not be requested. The active host operation may still be completing.')); }, [onCancel]);
  const disabled = publishActive;
  return <section className={'publish-panel' + (github?.status === 'recovery-required' ? ' is-recovery' : github?.status === 'offline' ? ' is-offline' : '')} aria-label="Generated project publishing">
    <header><strong>Publish generated project</strong><span aria-live="polite">{publishStatus}</span></header>
    <div className="publish-panel__steps"><span>1. Target</span><span>2. Consent</span><span>3. Immutable receipt</span></div>
    <fieldset disabled={disabled}><legend>Destination</legend><div className="publish-panel__modes"><label><input type="radio" checked={mode === 'local-preview'} onChange={() => setMode('local-preview')} />Validate local bundle</label><label><input type="radio" checked={mode === 'github-remote'} onChange={() => setMode('github-remote')} />GitHub remote</label></div>
    {mode === 'github-remote' ? <div className="publish-panel__remote"><p role="status">{setupIssue ?? ('Authenticated as ' + account + '. Existing repositories are validated during publish.')}</p><button type="button" onClick={refreshSetup} disabled={setupState.phase === 'loading'}>Refresh GitHub setup</button><label>Repository<input value={repository} aria-invalid={repositoryIssue !== undefined} onChange={(event) => setRepository(event.currentTarget.value)} /></label>{repositoryIssue ? <small>{repositoryIssue}</small> : null}<fieldset><legend>Repository choice</legend><label><input type="radio" checked={choice === 'existing'} onChange={() => setChoice('existing')} />Use existing Selene-owned repository</label><label><input type="radio" checked={choice === 'create'} onChange={() => setChoice('create')} />Create repository</label></fieldset>{choice === 'create' ? <><label>Owner<select value={ownerKind} onChange={(event) => setOwnerKind(event.currentTarget.value as 'current-user' | 'organization')}><option value="current-user">Current user</option><option value="organization">Organization</option></select></label>{ownerKind === 'organization' ? <label>Organization login<input value={organization} onChange={(event) => setOrganization(event.currentTarget.value)} /></label> : <p>Authenticated current user: {account ?? 'unavailable'}</p>}<label>Visibility<select value={visibility} onChange={(event) => setVisibility(event.currentTarget.value as 'private' | 'public')}><option value="private">Private</option><option value="public">Public</option></select></label><label><input type="checkbox" checked={visibilityConfirmed} onChange={(event) => setVisibilityConfirmed(event.currentTarget.checked)} />I confirm the selected visibility.</label></> : null}</div> : <p>Local validation checks the immutable bundle without selecting a repository.</p>}
    <label>Title<input value={title} aria-invalid={titleIssue !== undefined} onChange={(event) => setTitle(event.currentTarget.value)} /></label>{titleIssue ? <small>{titleIssue}</small> : null}</fieldset>
    {error ? <p className="publish-panel__error" role="alert">{error}</p> : null}{disabledReason ? <p className="publish-panel__reason" role="status">{disabledReason}</p> : null}
    {publishActive ? <button type="button" onClick={cancel}>Cancel publish</button> : <button type="button" disabled={disabledReason !== undefined} onClick={submit}>Continue to consent</button>}
  </section>;
}
