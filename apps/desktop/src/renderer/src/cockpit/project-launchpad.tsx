import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { Popover } from '@selene/ui/workspace';

import type { ProjectOpenResult, RecentProject } from '../../../shared/designer-api';
import { StudioIcon } from './studio-icon';
import './studio-polish.css';

type ProjectTemplate = 'blank' | 'dashboard' | 'review';

const projectTemplates: readonly {
  readonly id: ProjectTemplate;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    description: 'React + TypeScript workspace with a dashboard starting screen.'
  },
  {
    id: 'review',
    label: 'Review',
    description: 'React + TypeScript workspace prepared for a review starting screen.'
  },
  {
    id: 'blank',
    label: 'Blank',
    description: 'React + TypeScript workspace without a named starting workflow.'
  }
];

export interface ProjectLaunchpadActions {
  listRecentProjects(): Promise<readonly RecentProject[]>;
  openProject(request: { readonly projectId: string }): Promise<ProjectOpenResult>;
  createProject(request: {
    readonly id: string;
    readonly name: string;
    readonly template: ProjectTemplate;
  }): Promise<ProjectOpenResult>;
  chooseProjectToImport(): Promise<ProjectOpenResult | undefined>;
  diagnostics: {
    recovery(): Promise<{ readonly active: boolean; readonly attempts: number }>;
    resetRecovery(): Promise<{ readonly active: boolean; readonly attempts: number }>;
  };
}

interface ProjectLaunchpadProps {
  readonly actions: ProjectLaunchpadActions;
  readonly onProjectOpened: (opened: ProjectOpenResult) => Promise<void>;
  readonly mode?: 'header' | 'first-run';
  readonly startupMessage?: string;
}

function projectId(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return /^[a-z]/.test(normalized) ? normalized : 'new-project';
}

/** Project switching stays visible in the production chrome, not in setup-only controls. */
export function ProjectLaunchpad({
  actions,
  onProjectOpened,
  mode = 'header',
  startupMessage
}: ProjectLaunchpadProps) {
  const recentHeadingId = useId();
  const createHeadingId = useId();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [projects, setProjects] = useState<readonly RecentProject[]>([]);
  const [recentState, setRecentState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [status, setStatus] = useState('Loading recent projects…');
  const [busy, setBusy] = useState<string>();
  const [query, setQuery] = useState('');
  const [name, setName] = useState('New project');
  const [template, setTemplate] = useState<ProjectTemplate>('dashboard');
  const [recovery, setRecovery] = useState<
    { readonly active: boolean; readonly attempts: number } | undefined
  >();
  const [recoveryError, setRecoveryError] = useState<string>();
  const [checkingRecovery, setCheckingRecovery] = useState(true);
  const busyRef = useRef(false);
  const recoveryInFlight = useRef(false);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy('refresh');
    setRecentState('loading');
    try {
      const recent = await actions.listRecentProjects();
      if (!mounted.current) return;
      setProjects(recent);
      setRecentState('ready');
      setStatus(recent.length === 0 ? 'No local projects yet.' : 'Recent local projects.');
    } catch {
      if (mounted.current) {
        setProjects([]);
        setRecentState('error');
        setStatus('Recent projects could not be loaded.');
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(undefined);
    }
  }, [actions]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  const refreshRecovery = useCallback(async () => {
    if (recoveryInFlight.current) return;
    recoveryInFlight.current = true;
    setCheckingRecovery(true);
    setRecovery(undefined);
    setRecoveryError(undefined);
    try {
      const next = await actions.diagnostics.recovery();
      if (mounted.current) setRecovery(next);
    } catch {
      if (mounted.current) setRecoveryError('Recovery status could not be loaded.');
    } finally {
      recoveryInFlight.current = false;
      if (mounted.current) setCheckingRecovery(false);
    }
  }, [actions.diagnostics]);
  useEffect(() => {
    void refreshRecovery();
  }, [refreshRecovery]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const projectActionsBlocked =
    busy !== undefined || checkingRecovery || recovery?.active !== false;
  const openProject = async (project: RecentProject) => {
    if (busyRef.current || projectActionsBlocked) return;
    busyRef.current = true;
    setBusy(project.id);
    try {
      await onProjectOpened(await actions.openProject({ projectId: project.id }));
      if (!mounted.current) return;
      setStatus(`Opened ${project.name}.`);
      setPopoverOpen(false);
    } catch {
      if (mounted.current) setStatus(`Could not open ${project.name}.`);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(undefined);
    }
  };
  const createProject = async () => {
    const projectName = name.trim();
    if (busyRef.current || projectActionsBlocked || projectName.length === 0) return;
    busyRef.current = true;
    setBusy('create');
    try {
      await onProjectOpened(
        await actions.createProject({ id: projectId(projectName), name: projectName, template })
      );
      if (mounted.current) setStatus(`Created ${projectName}.`);
    } catch {
      if (mounted.current) setStatus(`Could not create ${projectName}.`);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(undefined);
    }
  };
  const importProject = async () => {
    if (busyRef.current || projectActionsBlocked) return;
    busyRef.current = true;
    setBusy('import');
    try {
      const opened = await actions.chooseProjectToImport();
      if (opened === undefined) {
        if (mounted.current) setStatus('No project selected.');
        return;
      }
      await onProjectOpened(opened);
      if (mounted.current) setStatus(`Imported ${opened.receipt.name}.`);
    } catch {
      if (mounted.current) setStatus('Could not import the local project.');
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(undefined);
    }
  };
  const resetRecovery = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy('recovery');
    try {
      const next = await actions.diagnostics.resetRecovery();
      if (!mounted.current) return;
      setRecovery(next);
      setRecoveryError(undefined);
      setStatus(next.active ? 'Preview execution remains paused.' : 'Preview execution resumed.');
    } catch {
      if (mounted.current) setRecoveryError('Preview recovery could not be reset.');
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(undefined);
    }
  };
  const visible = projects.filter((project) =>
    project.name.toLocaleLowerCase('en-US').includes(query.slice(0, 120).toLocaleLowerCase('en-US'))
  );
  const recentZone = (
    <section aria-labelledby={recentHeadingId} className="project-launchpad__recent-zone">
      <header className="project-launchpad__zone-heading">
        <div>
          <p className="project-launchpad__eyebrow">
            {mode === 'first-run' ? 'Continue locally' : 'Switch projects'}
          </p>
          <h2 id={recentHeadingId}>Recent projects</h2>
        </div>
        {projects.length > 0 ? (
          <span className="sl-status-badge sl-status-badge--neutral">{projects.length} saved</span>
        ) : null}
      </header>
      {mode === 'first-run' ? (
        <label className="sl-field">
          <span className="sl-field__label">Search recent projects</span>
          <input
            className="sl-field__control"
            maxLength={120}
            placeholder="Search local projects"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
      ) : null}
      <p aria-atomic="true" className="sl-field__help" role="status">
        {checkingRecovery ? 'Verifying safe preview startup…' : status}
      </p>
      {recentState === 'loading' ? (
        <div className="project-launchpad__loading" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      ) : null}
      {recentState === 'error' ? (
        <button
          className="sl-button sl-button--secondary"
          type="button"
          disabled={busy !== undefined}
          onClick={() => void refresh()}
        >
          {busy === 'refresh' ? 'Retrying…' : 'Retry recent projects'}
        </button>
      ) : null}
      {recovery?.active ? (
        <section className="sl-card project-launchpad__recovery" role="alert">
          <strong>Preview execution is paused</strong>
          <p>
            {recoveryError ??
              `Recovery is active after ${recovery.attempts} startup ${
                recovery.attempts === 1 ? 'attempt' : 'attempts'
              }. Project actions are unavailable.`}
          </p>
          <button
            className="sl-button sl-button--primary"
            type="button"
            disabled={busy !== undefined}
            onClick={() => void resetRecovery()}
          >
            {busy === 'recovery' ? 'Resuming…' : 'Resume previews'}
          </button>
        </section>
      ) : recoveryError ? (
        <section className="sl-card project-launchpad__recovery" role="alert">
          <strong>Recovery status is unavailable</strong>
          <p>{recoveryError}</p>
          <button
            className="sl-button sl-button--secondary"
            type="button"
            disabled={checkingRecovery || busy !== undefined}
            onClick={() => void refreshRecovery()}
          >
            Retry status
          </button>
        </section>
      ) : null}
      {visible.length === 0 ? null : (
        <ul
          aria-label="Recent local projects"
          className="conversation-history project-launchpad__recent"
        >
          {visible.map((project) => (
            <li key={project.id}>
              <button
                className="sl-list-row sl-popover__trigger project-launchpad__project"
                aria-label={busy === project.id ? `Opening ${project.name}…` : project.name}
                type="button"
                disabled={projectActionsBlocked}
                onClick={() => void openProject(project)}
              >
                <span className="project-launchpad__project-icon">
                  <StudioIcon name="folder" />
                </span>
                <span className="project-launchpad__project-copy">
                  <strong>{busy === project.id ? `Opening ${project.name}…` : project.name}</strong>
                  <small>Local workspace</small>
                </span>
                <StudioIcon name="arrow" className="project-launchpad__project-arrow" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {projects.length === 0 &&
      recentState === 'ready' &&
      recovery?.active === false &&
      !checkingRecovery &&
      !recoveryError ? (
        <div className="project-launchpad__empty">
          <StudioIcon name="folder" />
          <strong>Your next idea starts here</strong>
          <p>
            {mode === 'first-run'
              ? 'No local projects yet. Start with a new project.'
              : 'No recent projects yet.'}
          </p>
        </div>
      ) : null}
      {projects.length > 0 && visible.length === 0 ? (
        <p className="project-launchpad__empty">No recent projects match this search.</p>
      ) : null}
    </section>
  );
  const content = (
    <section
      aria-label={mode === 'first-run' ? 'Selene project launchpad' : 'Recent projects'}
      className={`sl-field project-launchpad project-launchpad--${mode}${mode === 'first-run' ? ' sl-card' : ''}`}
      aria-busy={busy !== undefined || undefined}
    >
      {mode === 'first-run' ? (
        <header className="project-launchpad__hero">
          <div className="project-launchpad__intro">
            <div className="project-launchpad__brand">
              <span aria-hidden="true" className="brand-mark">
                S
              </span>
              <span>
                Selene <small>DESIGN STUDIO</small>
              </span>
            </div>
            <p className="project-launchpad__eyebrow">From intent to interface</p>
            <h1>Start a local project</h1>
            <p className="project-launchpad__subtitle">
              Shape the experience. Explore every flow. Hand off real React.
            </p>
            <p className="project-launchpad__startup">{startupMessage}</p>
            <ul className="project-launchpad__principles" aria-label="Workspace principles">
              <li>
                <StudioIcon name="shield" /> Local-first
              </li>
              <li>
                <StudioIcon name="canvas" /> React + TypeScript
              </li>
              <li>
                <StudioIcon name="sparkles" /> Your choice of agent
              </li>
            </ul>
          </div>
          <div className="project-launchpad__artwork" aria-hidden="true">
            <div className="project-launchpad__artboard">
              <span className="project-launchpad__artboard-top">
                <i />
                <i />
                <i />
              </span>
              <div className="project-launchpad__artboard-content">
                <span className="project-launchpad__artboard-sidebar" />
                <div>
                  <b />
                  <span />
                  <span />
                  <span />
                  <em />
                  <em />
                  <em />
                </div>
              </div>
            </div>
            <div className="project-launchpad__artwork-note">
              <StudioIcon name="check" /> Source-backed by design
            </div>
          </div>
        </header>
      ) : null}
      {mode === 'first-run' ? (
        <div className="project-launchpad__workspace">
          {recentZone}
          <form
            aria-labelledby={createHeadingId}
            className="project-launchpad__create"
            onSubmit={(event) => {
              event.preventDefault();
              void createProject();
            }}
          >
            <header className="project-launchpad__zone-heading">
              <div>
                <p className="project-launchpad__eyebrow">Start fresh</p>
                <h2 id={createHeadingId}>Create a project</h2>
              </div>
            </header>
            <p className="project-launchpad__create-copy">
              Choose a starting point, then create a local workspace you can refine privately.
            </p>
            <label className="sl-field">
              <span className="sl-field__label">Project name</span>
              <input
                className="sl-field__control"
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </label>
            <fieldset className="project-launchpad__templates" disabled={projectActionsBlocked}>
              <legend>React + TypeScript starter</legend>
              <p>A source-backed starting point. No packages are installed here.</p>
              <div>
                {projectTemplates.map((option) => (
                  <label
                    key={option.id}
                    className={`project-launchpad__template${template === option.id ? ' is-selected' : ''}`}
                  >
                    <input
                      checked={template === option.id}
                      name="project-template"
                      type="radio"
                      value={option.id}
                      onChange={() => setTemplate(option.id)}
                    />
                    <span
                      className={`project-launchpad__template-preview project-launchpad__template-preview--${option.id}`}
                      aria-hidden="true"
                    >
                      <i />
                      <i />
                      <i />
                      <i />
                    </span>
                    <span className="project-launchpad__template-copy">
                      <strong>{option.label}</strong>
                      <small>{option.description}</small>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div
              aria-label="Project creation actions"
              className="project-launchpad__actions"
              role="group"
            >
              <button
                className="sl-button sl-button--primary"
                type="submit"
                disabled={projectActionsBlocked || !name.trim()}
              >
                {busy === 'create' ? 'Creating…' : 'Create project'}
              </button>
              <button
                className="sl-button sl-button--secondary"
                type="button"
                disabled={projectActionsBlocked}
                onClick={() => void importProject()}
              >
                {busy === 'import' ? 'Importing…' : 'Import a local project'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
      {mode === 'header' ? recentZone : null}
    </section>
  );

  if (mode === 'first-run') return content;
  return (
    <Popover
      contentLabel="Project launchpad"
      open={popoverOpen}
      onOpenChange={setPopoverOpen}
      triggerText="Projects"
    >
      {content}
    </Popover>
  );
}
