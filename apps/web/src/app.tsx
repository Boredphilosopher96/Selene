import { useEffect, useRef, useState } from 'react';

import {
  createProject,
  executeProjectCommand,
  exportProject,
  openProject,
  reopenProject,
  type LocalProjectPersistencePort,
  type ProjectCommand
} from '@selene/core/project';
import {
  createPrototypeRuntime,
  prototypeGraphFixture,
  schedulePrototypeTimeouts,
  type PrototypeGraph,
  type PrototypeRuntime
} from '@selene/core/prototype';
import type { DesignerWorkspace } from '@selene/project-schema';
import { PrototypeFlowCanvas } from '@selene/ui/prototype-flow';
import { PrototypeRuntimePreview } from '@selene/ui/prototype-runtime';
import { DesignerWorkspace as DesignerWorkspaceView } from '@selene/ui/designer-workspace';
import type { WorkspaceStatus } from '@selene/ui/workspace';

import { createPrototypeBrowserNavigation } from './prototype-browser-navigation';

const STORAGE_PREFIX = 'selene.designer-workspace.';
const editablePrototypeFixture: PrototypeGraph = {
  ...prototypeGraphFixture,
  transitions: prototypeGraphFixture.transitions.filter(
    (transition) => transition.id !== 'create-order'
  ),
  scenarios: prototypeGraphFixture.scenarios.map((scenario) =>
    scenario.id === 'orders-default' ? { ...scenario, expectedPath: ['orders'] } : scenario
  )
};

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
    <>
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
      <PrototypeStudio />
    </>
  );
}

/** Web is only a host for the reusable UI; graph validation and transitions remain in core. */
function PrototypeStudio() {
  const [graph, setGraph] = useState<PrototypeGraph>(editablePrototypeFixture);
  const runtime = useRef<PrototypeRuntime>(
    createPrototypeRuntime(editablePrototypeFixture, 'orders-default')
  );
  const browserNavigation = useRef(createPrototypeBrowserNavigation(editablePrototypeFixture));
  const [snapshot, setSnapshot] = useState(() => runtime.current.snapshot());
  const [notice, setNotice] = useState(
    'Wire the Create order action to run this compiled React prototype.'
  );

  function resetRuntime(nextGraph: PrototypeGraph) {
    const scenarioId = runtime.current.snapshot().scenarioId;
    runtime.current = createPrototypeRuntime(
      nextGraph,
      scenarioId !== undefined && nextGraph.scenarios.some((item) => item.id === scenarioId)
        ? scenarioId
        : undefined
    );
    setSnapshot(runtime.current.snapshot());
  }

  useEffect(() => {
    const navigation = createPrototypeBrowserNavigation(graph);
    browserNavigation.current = navigation;
    navigation.replace(runtime.current.snapshot());
    return navigation.onPopState((saved) => {
      try {
        setSnapshot(runtime.current.restore(saved));
        setNotice('Restored prototype navigation from browser history.');
      } catch {
        setNotice('Ignored an invalid browser prototype history entry.');
      }
    });
  }, [graph]);

  function updateGraph(next: PrototypeGraph) {
    setGraph(next);
    resetRuntime(next);
    setNotice('Updated the portable flow graph and restarted its local runtime.');
  }

  function run(action: { type: 'trigger'; nodeId: string; portId: string } | { type: 'back' }) {
    try {
      const transition =
        action.type === 'trigger'
          ? graph.transitions.find(
              (item) => item.from.nodeId === action.nodeId && item.from.portId === action.portId
            )
          : undefined;
      if (action.type === 'back' || transition?.kind === 'back') {
        const previous = runtime.current.snapshot();
        const next = runtime.current.dispatch(action);
        if (next.history.length < previous.history.length) window.history.back();
        else {
          setSnapshot(next);
          browserNavigation.current.replace(next);
          setNotice('Prototype history is already at its local boundary.');
        }
        return;
      }
      const previous = runtime.current.snapshot();
      const next = runtime.current.dispatch(action);
      setSnapshot(next);
      if (next.activeNodeId !== previous.activeNodeId) browserNavigation.current.push(next);
      else browserNavigation.current.replace(next);
      setNotice('Prototype action completed locally.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Prototype action failed.');
    }
  }

  function startScenario(scenarioId: string) {
    try {
      runtime.current = createPrototypeRuntime(graph, scenarioId);
      const next = runtime.current.snapshot();
      setSnapshot(next);
      browserNavigation.current.replace(next);
      setNotice(`Started scenario ${scenarioId}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not start scenario.');
    }
  }

  useEffect(
    () =>
      schedulePrototypeTimeouts(
        runtime.current,
        {
          setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
          clearTimeout: (handle) => window.clearTimeout(handle as number)
        },
        (next) => {
          if (next.activeNodeId !== snapshot.activeNodeId) browserNavigation.current.push(next);
          else browserNavigation.current.replace(next);
          setSnapshot(next);
          setNotice('Prototype timeout completed locally.');
        },
        (failure) => {
          setNotice(
            `Prototype timeout failed for ${failure.nodeId}.${failure.portId}: ${
              failure.error instanceof Error ? failure.error.message : 'unexpected host error'
            }`
          );
        }
      ),
    [graph, snapshot]
  );

  return (
    <section className="prototype-studio" aria-label="Prototype editor and runtime">
      <div className="prototype-studio__intro">
        <p className="prototype-kicker">Local prototype workspace</p>
        <h2>Flow canvas and runtime</h2>
        <p role="status" aria-label="Prototype status">
          {notice}
        </p>
      </div>
      <div className="prototype-studio__grid">
        <PrototypeFlowCanvas
          graph={graph}
          onGraphChange={updateGraph}
          activeNodeIds={[
            snapshot.activeNodeId,
            snapshot.activeStateId,
            snapshot.activeOverlayId
          ].filter((nodeId): nodeId is string => nodeId !== undefined)}
          activeTransitionIds={snapshot.activePathTransitionIds}
        />
        <PrototypeRuntimePreview
          graph={graph}
          snapshot={snapshot}
          onTrigger={(nodeId, portId) => run({ type: 'trigger', nodeId, portId })}
          onBack={() => run({ type: 'back' })}
          onScenarioStart={startScenario}
        />
      </div>
    </section>
  );
}
