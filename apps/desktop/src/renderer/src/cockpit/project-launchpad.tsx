import { useCallback, useEffect, useRef, useState } from 'react';

import { Popover } from '@selene/ui/workspace';

import type { ProjectOpenResult, RecentProject } from '../../../shared/designer-api';

export interface ProjectLaunchpadActions {
  listRecentProjects(): Promise<readonly RecentProject[]>;
  openProject(request: { readonly projectId: string }): Promise<ProjectOpenResult>;
  createProject(request: {
    readonly id: string;
    readonly name: string;
    readonly template: 'blank' | 'dashboard' | 'review';
  }): Promise<ProjectOpenResult>;
  importProjectFile(): Promise<ProjectOpenResult | undefined>;
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
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [projects, setProjects] = useState<readonly RecentProject[]>([]);
  const [status, setStatus] = useState('Loading recent projects…');
  const [busy, setBusy] = useState<string>();
  const [query, setQuery] = useState('');
  const [name, setName] = useState('New project');
  const [template, setTemplate] = useState<'blank' | 'dashboard' | 'review'>('dashboard');
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy('refresh');
    try {
      const recent = await actions.listRecentProjects();
      if (!mounted.current) return;
      setProjects(recent);
      setStatus(recent.length === 0 ? 'No local projects yet.' : 'Recent local projects.');
    } catch (error) {
      if (mounted.current)
        setStatus(error instanceof Error ? error.message : 'Recent projects could not be loaded.');
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(undefined);
    }
  }, [actions]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const openProject = async (project: RecentProject) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(project.id);
    try {
      await onProjectOpened(await actions.openProject({ projectId: project.id }));
      if (!mounted.current) return;
      setStatus(`Opened ${project.name}.`);
      setPopoverOpen(false);
    } catch (error) {
      if (mounted.current)
        setStatus(error instanceof Error ? error.message : `Could not open ${project.name}.`);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(undefined);
    }
  };
  const createProject = async () => {
    const projectName = name.trim();
    if (busyRef.current || projectName.length === 0) return;
    busyRef.current = true;
    setBusy('create');
    try {
      await onProjectOpened(
        await actions.createProject({ id: projectId(projectName), name: projectName, template })
      );
      if (mounted.current) setStatus(`Created ${projectName}.`);
    } catch (error) {
      if (mounted.current)
        setStatus(error instanceof Error ? error.message : `Could not create ${projectName}.`);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(undefined);
    }
  };
  const importProject = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy('import');
    try {
      const opened = await actions.importProjectFile();
      if (opened === undefined) {
        if (mounted.current) setStatus('No project selected.');
        return;
      }
      await onProjectOpened(opened);
      if (mounted.current) setStatus(`Imported ${opened.receipt.name}.`);
    } catch (error) {
      if (mounted.current)
        setStatus(error instanceof Error ? error.message : 'Could not import the local project.');
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(undefined);
    }
  };
  const visible = projects.filter((project) =>
    project.name.toLocaleLowerCase('en-US').includes(query.slice(0, 120).toLocaleLowerCase('en-US'))
  );
  const content = (
    <section
      aria-label={mode === 'first-run' ? 'Selene project launchpad' : 'Recent projects'}
      className={`sl-field project-launchpad project-launchpad--${mode}${mode === 'first-run' ? ' sl-card' : ''}`}
    >
      {mode === 'first-run' ? (
        <header className="project-launchpad__hero">
          <span aria-hidden="true" className="sl-status-badge sl-status-badge--neutral">
            S
          </span>
          <p className="sl-field__label">Selene desktop designer</p>
          <h1>Start a local project</h1>
          <p>{startupMessage}</p>
        </header>
      ) : null}
      <strong className="sl-field__label">Recent projects</strong>
      {mode === 'first-run' ? (
        <label className="sl-field">
          <span className="sl-field__label">Search recent projects</span>
          <input
            className="sl-field__control"
            maxLength={120}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
      ) : null}
      <p className="sl-field__help" role="status">
        {status}
      </p>
      {visible.length === 0 ? null : (
        <div className="conversation-history project-launchpad__recent">
          {visible.map((project) => (
            <button
              className="sl-list-row sl-popover__trigger"
              key={project.id}
              type="button"
              disabled={busy !== undefined}
              onClick={() => void openProject(project)}
            >
              {busy === project.id ? `Opening ${project.name}…` : project.name}
            </button>
          ))}
        </div>
      )}
      {projects.length > 0 && visible.length === 0 ? <p>No recent projects match.</p> : null}
      {mode === 'first-run' ? (
        <form
          className="project-launchpad__create"
          onSubmit={(event) => {
            event.preventDefault();
            void createProject();
          }}
        >
          <h2>Create a project</h2>
          <label className="sl-field">
            <span className="sl-field__label">Project name</span>
            <input
              className="sl-field__control"
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <label className="sl-field">
            <span className="sl-field__label">Starting point</span>
            <select
              className="sl-field__control"
              value={template}
              onChange={(event) =>
                setTemplate(event.currentTarget.value as 'blank' | 'dashboard' | 'review')
              }
            >
              <option value="dashboard">Dashboard</option>
              <option value="review">Review</option>
              <option value="blank">Blank</option>
            </select>
          </label>
          <button
            className="sl-button sl-button--primary"
            type="submit"
            disabled={busy !== undefined || !name.trim()}
          >
            {busy === 'create' ? 'Creating…' : 'Create project'}
          </button>
          <button
            className="sl-button sl-button--secondary"
            type="button"
            disabled={busy !== undefined}
            onClick={() => void importProject()}
          >
            {busy === 'import' ? 'Importing…' : 'Import a local project'}
          </button>
        </form>
      ) : null}
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
