import { useCallback, useEffect, useRef, useState } from 'react';

import { Popover } from '@selene/ui/workspace';

import type { ProjectOpenResult, RecentProject } from '../../../shared/designer-api';

export interface ProjectLaunchpadActions {
  listRecentProjects(): Promise<readonly RecentProject[]>;
  openProject(request: { readonly projectId: string }): Promise<ProjectOpenResult>;
}

interface ProjectLaunchpadProps {
  readonly actions: ProjectLaunchpadActions;
  readonly onProjectOpened: (opened: ProjectOpenResult) => Promise<void>;
}

/** Project switching stays visible in the production chrome, not in setup-only controls. */
export function ProjectLaunchpad({ actions, onProjectOpened }: ProjectLaunchpadProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [projects, setProjects] = useState<readonly RecentProject[]>([]);
  const [status, setStatus] = useState('Loading recent projects…');
  const [busy, setBusy] = useState<string>();
  const busyRef = useRef(false);
  const refresh = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy('refresh');
    try {
      const recent = await actions.listRecentProjects();
      setProjects(recent);
      setStatus(recent.length === 0 ? 'No local projects yet.' : 'Recent local projects.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Recent projects could not be loaded.');
    } finally {
      busyRef.current = false;
      setBusy(undefined);
    }
  }, [actions]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openProject = async (project: RecentProject) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(project.id);
    try {
      await onProjectOpened(await actions.openProject({ projectId: project.id }));
      setStatus(`Opened ${project.name}.`);
      setPopoverOpen(false);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `Could not open ${project.name}.`);
    } finally {
      busyRef.current = false;
      setBusy(undefined);
    }
  };

  return (
    <Popover
      contentLabel="Project launchpad"
      open={popoverOpen}
      onOpenChange={setPopoverOpen}
      triggerText="Projects"
    >
      <section aria-label="Recent projects" className="sl-field">
        <div className="sl-field__label">
          <strong>Recent projects</strong>
          <button
            className="sl-button sl-button--secondary"
            type="button"
            onClick={() => void refresh()}
            disabled={busy !== undefined}
          >
            Refresh
          </button>
        </div>
        <p className="sl-field__help" role="status">
          {status}
        </p>
        {projects.length === 0 ? null : (
          <div className="conversation-history">
            {projects.map((project) => (
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
      </section>
    </Popover>
  );
}
