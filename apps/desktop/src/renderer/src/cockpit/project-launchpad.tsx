import { useCallback, useEffect, useRef, useState } from 'react';

import { Popover } from '@selene/ui/workspace';

import type { ProjectOpenResult, RecentProject } from '../../../shared/designer-api';

export interface ProjectLaunchpadActions {
  listRecent(): Promise<readonly RecentProject[]>;
  openProject(request: { readonly projectId: string }): Promise<ProjectOpenResult>;
}

interface ProjectLaunchpadProps {
  readonly actions: ProjectLaunchpadActions;
  readonly onProjectOpened: (opened: ProjectOpenResult) => Promise<void>;
}

/** Project switching stays visible in the production chrome, not in setup-only controls. */
export function ProjectLaunchpad({ actions, onProjectOpened }: ProjectLaunchpadProps) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<readonly RecentProject[]>([]);
  const [status, setStatus] = useState('Loading recent projects…');
  const [openingProjectId, setOpeningProjectId] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const refreshInFlight = useRef<
    { readonly token: symbol; readonly promise: Promise<void> } | undefined
  >(undefined);
  const refresh = useCallback(() => {
    const existing = refreshInFlight.current;
    if (existing !== undefined) return existing.promise;
    setRefreshing(true);
    const token = Symbol('recent-project-refresh');
    const request = actions
      .listRecent()
      .then((recent) => {
        setProjects(recent);
        setStatus(recent.length === 0 ? 'No local projects yet.' : 'Recent local projects.');
      })
      .catch((error: unknown) => {
        setStatus(error instanceof Error ? error.message : 'Recent projects could not be loaded.');
      })
      .finally(() => {
        if (refreshInFlight.current?.token === token) {
          refreshInFlight.current = undefined;
          setRefreshing(false);
        }
      });
    refreshInFlight.current = { token, promise: request };
    return request;
  }, [actions]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = async (project: RecentProject) => {
    if (openingProjectId !== undefined || refreshing) return;
    setOpeningProjectId(project.id);
    try {
      await onProjectOpened(await actions.openProject({ projectId: project.id }));
      await refresh();
      setStatus(`Opened ${project.name}.`);
      setOpen(false);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `Could not open ${project.name}.`);
    } finally {
      setOpeningProjectId(undefined);
    }
  };
  const busy = refreshing || openingProjectId !== undefined;

  return (
    <Popover
      contentLabel="Project launchpad"
      open={open}
      onOpenChange={setOpen}
      triggerText="Projects"
    >
      <section aria-label="Recent projects" className="project-launchpad">
        <div className="project-launchpad__heading">
          <strong>Recent projects</strong>
          <button
            className="sl-button sl-button--secondary"
            type="button"
            onClick={() => void refresh()}
            disabled={busy}
          >
            Refresh
          </button>
        </div>
        <p role="status">{status}</p>
        {projects.length === 0 ? null : (
          <div className="project-launchpad__recent">
            {projects.map((project) => (
              <button
                className="sl-button sl-button--secondary"
                key={project.id}
                type="button"
                disabled={busy}
                onClick={() => void open(project)}
              >
                {openingProjectId === project.id ? `Opening ${project.name}…` : project.name}
              </button>
            ))}
          </div>
        )}
      </section>
    </Popover>
  );
}
