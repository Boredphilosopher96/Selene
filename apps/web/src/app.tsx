import { useEffect, useState } from 'react';

import {
  createProject,
  executeProjectCommand,
  exportProject,
  openProject,
  reopenProject,
  type LocalProjectPersistencePort,
  type ProjectCommand
} from '@selene/core';
import type { DesignerWorkspace } from '@selene/project-schema';
import { DesignerWorkspace as DesignerWorkspaceView, type WorkspaceStatus } from '@selene/ui';

const STORAGE_PREFIX = 'selene.designer-workspace.';

const browserPersistence: LocalProjectPersistencePort = {
  async load(projectId) {
    return window.localStorage.getItem(`${STORAGE_PREFIX}${projectId}`) ?? undefined;
  },
  async save(projectId, serializedProject) {
    window.localStorage.setItem(`${STORAGE_PREFIX}${projectId}`, serializedProject);
  }
};

function sampleProject(): DesignerWorkspace {
  return {
    format: 'selene-designer-workspace/v1',
    projectId: 'northstar',
    name: 'Northstar workspace',
    status: 'in-review',
    selectedScreenId: 'dashboard',
    selectedState: 'default',
    screens: [
      {
        id: 'dashboard',
        name: 'Dashboard',
        route: '/',
        states: ['default', 'busy'],
        nodeIds: ['dashboard.hero', 'dashboard.revenue', 'dashboard.orders', 'dashboard.activity']
      },
      {
        id: 'orders',
        name: 'Orders',
        route: '/orders',
        states: ['default', 'empty'],
        nodeIds: ['orders.header', 'orders.title', 'orders.table']
      },
      {
        id: 'settings',
        name: 'Settings',
        route: '/settings',
        states: ['default'],
        nodeIds: ['settings.sidebar', 'settings.preferences']
      }
    ],
    comments: [
      {
        id: 'comment-welcome',
        nodeId: 'dashboard.hero',
        body: 'Keep this greeting warm, but make the decision count easy to scan.',
        author: 'Mina',
        createdAt: '2026-07-23T20:30:00Z'
      }
    ],
    developerDirections: ['Preserve data-selene-node-id values when extracting components.'].map(
      (body, index) => ({ id: `direction-${index + 1}`, body, createdAt: '2026-07-23T20:30:00Z' })
    ),
    changelog: [
      {
        id: 'initial',
        at: '2026-07-23T20:00:00Z',
        summary: 'Created the Northstar React review project.'
      },
      { id: 'review', at: '2026-07-23T20:30:00Z', summary: 'Added the dashboard review state.' }
    ],
    updatedAt: '2026-07-23T20:30:00Z'
  };
}

function commandId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`;
}

export function App() {
  const [workspace, setWorkspace] = useState<DesignerWorkspace>(sampleProject);
  const [notice, setNotice] = useState('Local-only workspace. Nothing is sent to a server.');

  useEffect(() => {
    void reopenProject(browserPersistence, 'northstar').then((saved) => {
      if (saved) {
        setWorkspace(saved);
        setNotice('Reopened the local Northstar workspace.');
      }
    });
  }, []);

  function persist(next: DesignerWorkspace, message: string) {
    setWorkspace(next);
    setNotice(message);
    void createProject(browserPersistence, next);
  }

  function dispatch(command: ProjectCommand, message: string) {
    persist(executeProjectCommand(workspace, command), message);
  }

  function exportCurrentProject() {
    const data = exportProject(workspace);
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${workspace.projectId}.selene.json`;
    link.click();
    URL.revokeObjectURL(url);
    setNotice('Exported a portable project file.');
  }

  return (
    <DesignerWorkspaceView
      workspace={workspace}
      notice={notice}
      onCreate={() => persist(sampleProject(), 'Created a fresh local Northstar project.')}
      onOpenFile={(file) => {
        void file
          .text()
          .then(openProject)
          .then((opened) => persist(opened, `Opened ${opened.name}.`))
          .catch((error: unknown) =>
            setNotice(error instanceof Error ? error.message : 'Could not open that project.')
          );
      }}
      onExport={exportCurrentProject}
      onReopen={() => {
        void reopenProject(browserPersistence, workspace.projectId).then((saved) => {
          if (saved) persist(saved, `Reopened ${saved.name}.`);
          else setNotice('No saved project was found yet.');
        });
      }}
      onScreenChange={(screenId) =>
        dispatch({ type: 'select-screen', screenId }, 'Navigated the live preview.')
      }
      onStateChange={(state) =>
        dispatch({ type: 'select-state', state }, `Switched preview to ${state}.`)
      }
      onNodeSelect={(nodeId) => dispatch({ type: 'select-node', nodeId }, `Selected ${nodeId}.`)}
      onAddComment={(body) =>
        dispatch(
          {
            type: 'add-comment',
            id: commandId('comment'),
            nodeId: workspace.selectedNodeId ?? 'dashboard.hero',
            body,
            author: 'You',
            createdAt: new Date().toISOString()
          },
          'Added a node-level comment.'
        )
      }
      onResolveComment={(commentId) =>
        dispatch(
          { type: 'resolve-comment', commentId, resolvedAt: new Date().toISOString() },
          'Resolved the comment.'
        )
      }
      onAddDirection={(body) =>
        dispatch(
          {
            type: 'add-direction',
            id: commandId('direction'),
            body,
            createdAt: new Date().toISOString()
          },
          'Added a developer handoff direction.'
        )
      }
      onStatusChange={(status: WorkspaceStatus) =>
        dispatch({ type: 'set-status', status }, `Set project status to ${status}.`)
      }
    />
  );
}
