import {
  Background,
  BackgroundVariant,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  useViewport,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
  type NodeProps,
  type OnNodeDrag,
  type ReactFlowInstance
} from '@xyflow/react';
import {
  removePrototypeTransition,
  upsertPrototypeTransition,
  type PrototypeGraph,
  type PrototypeNode,
  type PrototypeTransition
} from '@selene/core';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from 'react';

import '@xyflow/react/dist/style.css';
import {
  PREVIEW_CANVAS_GESTURE_EVENT,
  PREVIEW_CANVAS_NAVIGATION_EVENT,
  previewCanvasGesture
} from '../../../shared/preview-channel';
import { applyCanvasPreviewGesture, canvasShortcutAction } from './canvas-workspace-model';
import { safeDesignerNotice } from '../presentation-error';
import './canvas-workspace.css';

export type CanvasWorkspaceMode = 'design' | 'present';

export interface CanvasPrototypeConnectionSelection {
  readonly transition: PrototypeTransition;
  readonly sourceLabel: string;
  readonly actionLabel: string;
  readonly targetLabel?: string;
}

interface CanvasWorkspaceProps {
  readonly graph: PrototypeGraph;
  readonly graphRevision: number;
  readonly preview: ReactNode;
  readonly mode: CanvasWorkspaceMode;
  readonly readOnly: boolean;
  readonly saveStatus: string;
  readonly activeNodeId?: string;
  readonly catalogEntries: readonly { readonly component: string; readonly href: string }[];
  readonly activatableNodeIds: readonly string[];
  readonly onModeChange: (
    mode: CanvasWorkspaceMode,
    invoking: HTMLButtonElement
  ) => void | Promise<void>;
  readonly onGraphChange: (
    graph: PrototypeGraph
  ) => Promise<{ readonly graph: PrototypeGraph; readonly revision: number }>;
  readonly onActivateNode: (nodeId: string) => void;
  readonly onConnectionSelectionChange: (
    selection: CanvasPrototypeConnectionSelection | undefined
  ) => void;
  readonly onRequestAiTarget: (invoking: HTMLButtonElement) => void;
  readonly onClearSelection: () => void;
  readonly onRequestReviewTarget: (invoking: HTMLButtonElement) => void;
  readonly canRequestAiTarget: boolean;
  readonly onOpenAi?: () => void;
  readonly onOpenInspector?: () => void;
}

interface ActiveArtboardData extends Record<string, unknown> {
  readonly label: string;
  readonly route?: string;
  readonly isFlowStart: boolean;
  readonly mode: CanvasWorkspaceMode;
  readonly ports: PrototypeNode['ports'];
  readonly commands: readonly PrototypeTransition[];
  readonly onSelectCommand: (transition: PrototypeTransition) => void;
}

interface ReferenceArtboardData extends Record<string, unknown> {
  readonly label: string;
  readonly kind: PrototypeNode['kind'];
  readonly route?: string;
  readonly parentLabel?: string;
  readonly isFlowStart: boolean;
  readonly mode: CanvasWorkspaceMode;
  readonly ports: PrototypeNode['ports'];
  readonly commands: readonly PrototypeTransition[];
  readonly onSelectCommand: (transition: PrototypeTransition) => void;
}

type ActiveArtboardNode = Node<ActiveArtboardData, 'active-artboard'>;
type ReferenceArtboardNode = Node<ReferenceArtboardData, 'reference-artboard'>;
type WorkspaceNode = ActiveArtboardNode | ReferenceArtboardNode;

const CanvasPreviewContext = createContext<ReactNode>(null);
const activeArtboardWidth = 960;
const activeArtboardHeight = 680;
const referenceArtboardWidth = 280;
const referenceArtboardHeight = 176;
const metadataWidth = 196;
const metadataHeight = 72;
const canvasOrigin = { x: 320, y: 96 };
const canvasScale = { x: 2.5, y: 2 };
const canvasMinimumZoom = 0.12;
const canvasMaximumZoom = 2;

function isTextEditingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement)
  );
}

function graphToCanvasPosition(node: PrototypeNode): { readonly x: number; readonly y: number } {
  return {
    x: canvasOrigin.x + node.position.x * canvasScale.x,
    y: canvasOrigin.y + node.position.y * canvasScale.y
  };
}

function canvasToGraphPosition(position: { readonly x: number; readonly y: number }): {
  readonly x: number;
  readonly y: number;
} {
  return {
    x: (position.x - canvasOrigin.x) / canvasScale.x,
    y: (position.y - canvasOrigin.y) / canvasScale.y
  };
}

function transitionTarget(transition: PrototypeTransition): string {
  return 'to' in transition ? transition.to.nodeId : transition.from.nodeId;
}

function stableConnectionId(source: string, port: string, target: string): string {
  let hash = 2166136261;
  for (const character of `${source}\u0000${port}\u0000${target}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `wire-${(hash >>> 0).toString(36)}`;
}

function transitionForConnection(
  graph: PrototypeGraph,
  connection: Connection
): { readonly transition?: PrototypeTransition; readonly error?: string } {
  const source = graph.nodes.find((node) => node.id === connection.source);
  const target = graph.nodes.find((node) => node.id === connection.target);
  const port = source?.ports.find((item) => item.id === connection.sourceHandle);
  if (!source || !target || !port)
    return { error: 'Choose a declared source action and destination artboard.' };
  const existing = graph.transitions.find(
    (transition) => transition.from.nodeId === source.id && transition.from.portId === port.id
  );
  const id = existing?.id ?? stableConnectionId(source.id, port.id, target.id);
  if (existing && (existing.kind === 'back' || existing.kind === 'reset-flow'))
    return {
      error: `${existing.kind === 'back' ? 'Back' : 'Reset flow'} is a source command and has no destination artboard.`
    };
  if (target.kind === 'state') {
    const owner =
      source.kind === 'state'
        ? source.parentId
        : source.kind === 'screen' || source.kind === 'page'
          ? source.id
          : undefined;
    if (owner !== target.parentId)
      return { error: 'A state connection must remain within its owning screen.' };
    return {
      transition: {
        id,
        kind: 'set-state',
        from: { nodeId: source.id, portId: port.id },
        to: { nodeId: target.id }
      }
    };
  }
  if (target.kind === 'overlay') {
    if (source.kind === 'overlay' && source.id !== target.id)
      return {
        error: 'Closing an overlay must target that same active overlay.'
      };
    return {
      transition: {
        id,
        kind: source.kind === 'overlay' ? 'close-overlay' : 'open-overlay',
        from: { nodeId: source.id, portId: port.id },
        to: { nodeId: target.id }
      }
    };
  }
  if (existing?.kind === 'open-overlay' || existing?.kind === 'close-overlay')
    return { error: `${existing.kind.replace('-', ' ')} must target an overlay.` };
  return {
    transition: {
      id,
      kind: 'navigate',
      from: { nodeId: source.id, portId: port.id },
      to: { nodeId: target.id }
    }
  };
}

function CommandChips({
  commands,
  mode,
  onSelect
}: {
  readonly commands: readonly PrototypeTransition[];
  readonly mode: CanvasWorkspaceMode;
  readonly onSelect: (transition: PrototypeTransition) => void;
}) {
  if (mode !== 'design' || commands.length === 0) return null;
  return (
    <div className="canvas-artboard__commands" aria-label="Source-only prototype actions">
      {commands.map((command) => (
        <button
          className="nodrag nopan"
          key={command.id}
          type="button"
          onClick={() => onSelect(command)}
        >
          {command.kind === 'back' ? '↩ Back' : '↻ Reset flow'}
        </button>
      ))}
    </div>
  );
}

function FlowHandles({
  ports,
  mode
}: {
  readonly ports: PrototypeNode['ports'];
  readonly mode: CanvasWorkspaceMode;
}) {
  if (mode !== 'design') return null;
  return (
    <>
      <Handle className="canvas-artboard__target-handle" type="target" position={Position.Left} />
      {ports.map((port, index) => (
        <Handle
          className="canvas-artboard__source-handle"
          id={port.id}
          key={port.id}
          type="source"
          position={Position.Right}
          style={{ top: `${((index + 1) / (ports.length + 1)) * 100}%` }}
          title={`Connect ${port.label}`}
        />
      ))}
    </>
  );
}

function ActiveArtboard({ data, selected }: NodeProps<ActiveArtboardNode>) {
  const preview = useContext(CanvasPreviewContext);
  const { zoom } = useViewport();
  return (
    <article
      className="canvas-artboard canvas-artboard--active"
      data-selected={selected || undefined}
      style={{ '--preview-pin-scale': 1 / zoom } as CSSProperties}
    >
      <header className="canvas-artboard__label canvas-artboard__drag-handle">
        <span>
          <strong>{data.label}</strong>
          {data.route ? <code>{data.route}</code> : null}
        </span>
        <span className="canvas-artboard__badges">
          {data.isFlowStart ? <small>Flow start</small> : null}
          <small>Current screen</small>
        </span>
      </header>
      <div className="canvas-artboard__compiled nodrag">{preview}</div>
      {data.mode === 'design' ? (
        <div
          className="canvas-artboard__navigation-shield"
          aria-hidden="true"
          title="Two-finger scroll to pan. Pinch to zoom."
        />
      ) : null}
      <CommandChips commands={data.commands} mode={data.mode} onSelect={data.onSelectCommand} />
      <FlowHandles mode={data.mode} ports={data.ports} />
    </article>
  );
}

function ReferenceArtboard({ data, selected }: NodeProps<ReferenceArtboardNode>) {
  const isMetadata = data.kind === 'state' || data.kind === 'overlay';
  return (
    <article
      className="canvas-artboard canvas-artboard--reference"
      data-kind={data.kind}
      data-metadata={isMetadata || undefined}
      data-selected={selected || undefined}
    >
      <header className="canvas-artboard__label">
        <span>
          <strong>{data.label}</strong>
          {data.route ? <code>{data.route}</code> : null}
        </span>
        <span className="canvas-artboard__badges">
          {data.isFlowStart ? <small>Flow start</small> : null}
          <small>{data.kind}</small>
        </span>
      </header>
      {isMetadata ? (
        <p className="canvas-artboard__metadata">
          {data.kind === 'state' && data.parentLabel
            ? `State of ${data.parentLabel}`
            : 'Interaction overlay'}
        </p>
      ) : (
        <div className="canvas-artboard__dormant" aria-label="Dormant screen artboard">
          <span>Screen not currently shown</span>
          <small>Open a saved scenario to preview this screen.</small>
        </div>
      )}
      <CommandChips commands={data.commands} mode={data.mode} onSelect={data.onSelectCommand} />
      <FlowHandles mode={data.mode} ports={data.ports} />
    </article>
  );
}

const nodeTypes = {
  'active-artboard': ActiveArtboard,
  'reference-artboard': ReferenceArtboard
};

function hasSameHandleTopology(current: WorkspaceNode, next: WorkspaceNode): boolean {
  return (
    current.data.mode === next.data.mode &&
    current.data.ports.length === next.data.ports.length &&
    current.data.ports.every((port, index) => port.id === next.data.ports[index]?.id)
  );
}

/**
 * The graph is the durable source of artboard semantics, while React Flow owns
 * measured DOM geometry. Replacing controlled nodes with graph-only objects
 * after a save drops those measurements; React Flow intentionally hides
 * unmeasured nodes until its observer runs again. Keep that ephemeral geometry
 * in the local node state when reconciling a durable graph revision.
 */
function reconcileGraphNodes(
  currentNodes: readonly WorkspaceNode[],
  nextGraphNodes: readonly WorkspaceNode[]
): WorkspaceNode[] {
  const currentById = new Map(currentNodes.map((node) => [node.id, node]));
  return nextGraphNodes.map((next) => {
    const current = currentById.get(next.id);
    if (
      !current?.measured ||
      current.type !== next.type ||
      current.style?.width !== next.style?.width ||
      current.style?.height !== next.style?.height ||
      !hasSameHandleTopology(current, next)
    )
      return next;
    return { ...next, measured: current.measured };
  });
}

function connectionSelection(
  graph: PrototypeGraph,
  transition: PrototypeTransition
): CanvasPrototypeConnectionSelection {
  const source = graph.nodes.find((node) => node.id === transition.from.nodeId);
  const target =
    'to' in transition ? graph.nodes.find((node) => node.id === transition.to.nodeId) : undefined;
  const port = source?.ports.find((item) => item.id === transition.from.portId);
  return {
    transition,
    sourceLabel: source?.label ?? transition.from.nodeId,
    actionLabel: port?.label ?? transition.from.portId,
    ...(target ? { targetLabel: target.label } : {})
  };
}

/** One infinite designer surface: live compiled artboard first, prototype wiring as a mode overlay. */
export function CanvasWorkspace({
  graph: authoritativeGraph,
  graphRevision,
  preview,
  mode,
  readOnly,
  saveStatus,
  activeNodeId,
  catalogEntries,
  activatableNodeIds,
  onModeChange,
  onGraphChange,
  onActivateNode,
  onConnectionSelectionChange,
  onRequestAiTarget,
  onClearSelection,
  onRequestReviewTarget,
  canRequestAiTarget,
  onOpenAi,
  onOpenInspector
}: CanvasWorkspaceProps) {
  const projectFence = `${authoritativeGraph.project.projectId}:${authoritativeGraph.id}`;
  const [graph, setGraph] = useState(authoritativeGraph);
  const latestGraph = useRef(authoritativeGraph);
  const latestRevision = useRef(graphRevision);
  const saveGraph = useRef(onGraphChange);
  const reportConnectionSelection = useRef(onConnectionSelectionChange);
  const [canvasError, setCanvasError] = useState<string>();
  const lane = useRef({
    fence: projectFence,
    revision: graphRevision,
    graph: authoritativeGraph,
    pending: 0,
    tail: Promise.resolve()
  });
  latestGraph.current = authoritativeGraph;
  latestRevision.current = graphRevision;
  saveGraph.current = onGraphChange;
  reportConnectionSelection.current = onConnectionSelectionChange;
  useEffect(() => {
    if (lane.current.fence !== projectFence) {
      lane.current = {
        fence: projectFence,
        revision: graphRevision,
        graph: authoritativeGraph,
        pending: 0,
        tail: Promise.resolve()
      };
      setGraph(authoritativeGraph);
      setCanvasError(undefined);
      return;
    }
    if (lane.current.pending > 0 || graphRevision < lane.current.revision) return;
    lane.current.graph = authoritativeGraph;
    lane.current.revision = graphRevision;
    setGraph(authoritativeGraph);
  }, [authoritativeGraph, graphRevision, projectFence]);
  const requestedActiveNode = graph.nodes.find((node) => node.id === activeNodeId);
  const activeId =
    requestedActiveNode?.kind === 'screen' || requestedActiveNode?.kind === 'page'
      ? requestedActiveNode.id
      : requestedActiveNode?.kind === 'state'
        ? requestedActiveNode.parentId
        : graph.initialNodeId;
  const [panel, setPanel] = useState<'artboards' | 'assets'>('artboards');
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState(activeId);
  const [handTool, setHandTool] = useState(false);
  const [spacePressed, setSpacePressed] = useState(false);
  const workspace = useRef<HTMLElement | null>(null);
  const flow = useRef<ReactFlowInstance<WorkspaceNode> | null>(null);
  const presentExit = useRef<HTMLButtonElement | null>(null);
  const fittedProject = useRef<string | undefined>(undefined);
  useEffect(() => setSelectedNodeId(activeId), [activeId]);
  const graphNodes = useMemo<WorkspaceNode[]>(
    () =>
      graph.nodes
        .filter((node) => mode !== 'present' || node.id === activeId)
        .map((node) => {
          const active = node.id === activeId;
          const commands = graph.transitions.filter(
            (transition) =>
              transition.from.nodeId === node.id &&
              (transition.kind === 'back' || transition.kind === 'reset-flow')
          );
          const selectCommand = (transition: PrototypeTransition) =>
            reportConnectionSelection.current(connectionSelection(graph, transition));
          const parent =
            node.kind === 'state'
              ? graph.nodes.find((candidate) => candidate.id === node.parentId)
              : undefined;
          const parentPosition = parent ? graphToCanvasPosition(parent) : undefined;
          const parentIsActive = parent?.id === activeId;
          const siblingIndex =
            node.kind === 'state'
              ? graph.nodes
                  .filter(
                    (candidate) =>
                      candidate.kind === 'state' && candidate.parentId === node.parentId
                  )
                  .findIndex((candidate) => candidate.id === node.id)
              : 0;
          const position =
            node.kind === 'state' && parentPosition
              ? {
                  x: parentPosition.x + 18,
                  y:
                    parentPosition.y +
                    (parentIsActive ? activeArtboardHeight : referenceArtboardHeight) +
                    46 +
                    siblingIndex * (metadataHeight + 28)
                }
              : graphToCanvasPosition(node);
          if (active)
            return {
              id: node.id,
              type: 'active-artboard',
              position,
              selected: node.id === selectedNodeId,
              data: {
                label: node.label,
                ...('route' in node ? { route: node.route } : {}),
                isFlowStart: node.id === graph.initialNodeId,
                mode,
                ports: node.ports,
                commands,
                onSelectCommand: selectCommand
              },
              style: { width: activeArtboardWidth, height: activeArtboardHeight },
              // React Flow may assign selected edges an elevated SVG layer.
              // Keep the interactive live artboard above that layer while its
              // uncovered wire segments remain focusable/selectable.
              zIndex: 10_001,
              draggable: !readOnly && mode === 'design' && !handTool && !spacePressed,
              deletable: false,
              dragHandle: '.canvas-artboard__drag-handle'
            };
          const metadata = node.kind === 'state' || node.kind === 'overlay';
          return {
            id: node.id,
            type: 'reference-artboard',
            position,
            selected: node.id === selectedNodeId,
            data: {
              label: node.label,
              kind: node.kind,
              ...('route' in node ? { route: node.route } : {}),
              ...(parent ? { parentLabel: parent.label } : {}),
              isFlowStart: node.id === graph.initialNodeId,
              mode,
              ports: node.ports,
              commands,
              onSelectCommand: selectCommand
            },
            style: {
              width: metadata ? metadataWidth : referenceArtboardWidth,
              height: metadata ? metadataHeight : referenceArtboardHeight
            },
            draggable:
              !readOnly && mode === 'design' && node.kind !== 'state' && !handTool && !spacePressed,
            deletable: false,
            dragHandle: '.canvas-artboard__label'
          };
        }),
    [activeId, graph, handTool, mode, readOnly, selectedNodeId, spacePressed]
  );
  const [nodes, setNodes] = useState<WorkspaceNode[]>(graphNodes);
  useEffect(() => setNodes((current) => reconcileGraphNodes(current, graphNodes)), [graphNodes]);
  const fitNodes = useCallback(
    async (
      nodeIds: readonly string[],
      options: {
        readonly duration?: number;
        readonly padding?: number;
        readonly maximumZoom?: number;
      } = {}
    ) => {
      const instance = flow.current;
      if (!instance || nodeIds.length === 0) return;
      await instance.fitView({
        nodes: nodeIds.map((id) => ({ id })),
        duration: options.duration ?? 220,
        padding: options.padding ?? 0.18,
        minZoom: canvasMinimumZoom,
        maxZoom: options.maximumZoom ?? 1.15
      });
      const library = workspace.current?.querySelector<HTMLElement>('.canvas-workspace__library');
      const reservedLeft = library?.getBoundingClientRect().width ?? 0;
      if (reservedLeft <= 0) return;
      const viewport = instance.getViewport();
      await instance.setViewport(
        { ...viewport, x: viewport.x + Math.min(140, reservedLeft / 2 + 12) },
        { duration: 0 }
      );
    },
    []
  );
  const fitAll = useCallback(
    (duration = 220) =>
      fitNodes(
        graphNodes.map((node) => node.id),
        { duration }
      ),
    [fitNodes, graphNodes]
  );
  const fitSelection = useCallback(
    () => fitNodes([selectedNodeId || activeId], { padding: 0.12 }),
    [activeId, fitNodes, selectedNodeId]
  );
  const fitActiveArtboard = useCallback(
    (duration = 220) => fitNodes([activeId], { duration, padding: 0.08 }),
    [activeId, fitNodes]
  );
  useEffect(() => {
    if (!flow.current || mode === 'present' || fittedProject.current === projectFence) return;
    fittedProject.current = projectFence;
    let secondFrame: number | undefined;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => void fitActiveArtboard(0));
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) cancelAnimationFrame(secondFrame);
    };
  }, [fitActiveArtboard, mode, projectFence]);
  const graphEdges = useMemo<Edge[]>(
    () =>
      mode !== 'design'
        ? []
        : graph.transitions
            .filter((transition) => 'to' in transition)
            .map((transition) => {
              const port = graph.nodes
                .find((node) => node.id === transition.from.nodeId)
                ?.ports.find((item) => item.id === transition.from.portId);
              return {
                id: transition.id,
                source: transition.from.nodeId,
                sourceHandle: transition.from.portId,
                target: transitionTarget(transition),
                label: port?.label ?? transition.kind,
                markerEnd: { type: MarkerType.ArrowClosed, color: '#6d5dfc' },
                className: 'canvas-prototype-edge',
                style: { stroke: '#6d5dfc', strokeWidth: 2 }
              };
            }),
    [graph.nodes, graph.transitions, mode]
  );
  const [edges, setEdges] = useState<Edge[]>(graphEdges);
  useEffect(() => setEdges(graphEdges), [graphEdges]);

  const enqueueGraphMutation = (
    mutation: (current: PrototypeGraph) => PrototypeGraph,
    failureMessage: string
  ) => {
    const currentLane = lane.current;
    currentLane.pending += 1;
    const operation = currentLane.tail
      .catch(() => undefined)
      .then(async () => {
        if (lane.current !== currentLane) return;
        const base = currentLane.graph;
        try {
          const next = mutation(base);
          currentLane.graph = next;
          setGraph(next);
          setCanvasError(undefined);
          const saved = await saveGraph.current(next);
          if (
            lane.current !== currentLane ||
            `${saved.graph.project.projectId}:${saved.graph.id}` !== currentLane.fence
          )
            return;
          currentLane.graph = saved.graph;
          currentLane.revision = saved.revision;
          setGraph(saved.graph);
        } catch (error) {
          if (lane.current !== currentLane) return;
          const rollback =
            latestRevision.current > currentLane.revision ? latestGraph.current : base;
          currentLane.graph = rollback;
          currentLane.revision = Math.max(currentLane.revision, latestRevision.current);
          setGraph(rollback);
          setCanvasError(
            safeDesignerNotice(error instanceof Error ? error.message : '', failureMessage)
          );
        }
      })
      .finally(() => {
        currentLane.pending = Math.max(0, currentLane.pending - 1);
        if (
          lane.current === currentLane &&
          currentLane.pending === 0 &&
          latestRevision.current > currentLane.revision
        ) {
          currentLane.graph = latestGraph.current;
          currentLane.revision = latestRevision.current;
          setGraph(latestGraph.current);
        }
      });
    currentLane.tail = operation.then(
      () => undefined,
      () => undefined
    );
  };
  const updateNodes = (changes: NodeChange<WorkspaceNode>[]) => {
    const safeChanges = changes.filter((change) => change.type !== 'remove');
    setNodes((current) => applyNodeChanges(safeChanges, current));
  };
  const updateEdges = (changes: EdgeChange[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
  };
  const saveNodePosition: OnNodeDrag<WorkspaceNode> = (_event, node) => {
    // React Flow controls the collection through this component. Mirror its
    // terminal drag state so a delivered pointer-up cannot leave the node
    // visually or semantically latched as dragging.
    setNodes((current) =>
      current.map((item) => (item.id === node.id ? { ...item, dragging: false } : item))
    );
    if (readOnly || mode !== 'design') return;
    const nextPosition = canvasToGraphPosition(node.position);
    enqueueGraphMutation(
      (current) => ({
        ...current,
        nodes: current.nodes.map((item) =>
          item.id === node.id ? { ...item, position: nextPosition } : item
        )
      }),
      'The artboard move could not be saved.'
    );
  };
  const connect = (connection: Connection) => {
    if (mode !== 'design' || readOnly) return;
    enqueueGraphMutation((current) => {
      const result = transitionForConnection(current, connection);
      if (!result.transition)
        throw new Error(result.error ?? 'That prototype connection is not valid.');
      return upsertPrototypeTransition(current, result.transition);
    }, 'The connection could not be saved.');
  };
  const reportSelectedEdge = useCallback((edgeId?: string) => {
    const currentGraph = lane.current.graph;
    const transition = currentGraph.transitions.find((item) => item.id === edgeId);
    reportConnectionSelection.current(
      transition ? connectionSelection(currentGraph, transition) : undefined
    );
  }, []);
  const selectCanvasItems = useCallback(
    (selection: { readonly edges: readonly Edge[] }) => reportSelectedEdge(selection.edges[0]?.id),
    [reportSelectedEdge]
  );
  const removeEdges = (removed: Edge[]) => {
    if (mode !== 'design' || readOnly || removed.length === 0) return;
    reportSelectedEdge();
    enqueueGraphMutation(
      (current) =>
        removed.reduce(
          (next, edge) =>
            next.transitions.some((transition) => transition.id === edge.id)
              ? removePrototypeTransition(next, edge.id)
              : next,
          current
        ),
      'The connection could not be removed.'
    );
  };
  const clearCanvasSelection = useCallback(() => {
    setSelectedNodeId('');
    reportSelectedEdge();
    onClearSelection();
  }, [onClearSelection, reportSelectedEdge]);
  const selectArtboardNode = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    reportSelectedEdge();
    requestAnimationFrame(() => {
      void fitNodes([nodeId]);
      document
        .querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`)
        ?.focus();
    });
  };
  const selectNode: NodeMouseHandler<WorkspaceNode> = (_event, node) => {
    setSelectedNodeId(node.id);
    reportSelectedEdge();
  };
  const applyShortcut = useCallback(
    (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || isTextEditingTarget(event.target)) return;
      const action = canvasShortcutAction({
        key: event.key,
        shiftKey: event.shiftKey,
        repeat: event.repeat
      });
      if (action === undefined) return;
      event.preventDefault();
      if (action === 'fit-all') void fitAll();
      if (action === 'fit-selection') void fitSelection();
      if (action === 'hand-on') {
        clearCanvasSelection();
        setHandTool(true);
      }
      if (action === 'hand-off') {
        clearCanvasSelection();
        setHandTool(false);
      }
      if (action === 'clear') {
        setHandTool(false);
        if (mode === 'present' && presentExit.current) {
          void onModeChange('design', presentExit.current);
          return;
        }
        clearCanvasSelection();
      }
    },
    [clearCanvasSelection, fitAll, fitSelection, mode, onModeChange]
  );
  useEffect(() => {
    const keyDown = (event: globalThis.KeyboardEvent) => {
      if (
        !event.defaultPrevented &&
        !event.isComposing &&
        event.code === 'Space' &&
        !isTextEditingTarget(event.target)
      ) {
        event.preventDefault();
        setSpacePressed(true);
        return;
      }
      applyShortcut(event);
    };
    const keyUp = (event: globalThis.KeyboardEvent) => {
      if (event.code === 'Space') setSpacePressed(false);
    };
    const releaseSpace = () => setSpacePressed(false);
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    window.addEventListener('blur', releaseSpace);
    return () => {
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', releaseSpace);
    };
  }, [applyShortcut]);
  useEffect(() => {
    if (mode !== 'present') return;
    requestAnimationFrame(() => presentExit.current?.focus());
  }, [mode]);
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent(PREVIEW_CANVAS_NAVIGATION_EVENT, {
        detail: { enabled: mode === 'design' }
      })
    );
    return () => {
      if (mode === 'design')
        window.dispatchEvent(
          new CustomEvent(PREVIEW_CANVAS_NAVIGATION_EVENT, { detail: { enabled: false } })
        );
    };
  }, [mode]);
  useEffect(() => {
    if (mode !== 'design') return;
    const applyPreviewGesture = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const gesture = previewCanvasGesture(event.detail);
      const instance = flow.current;
      const canvas = workspace.current?.querySelector<HTMLElement>('.react-flow');
      const compiled = workspace.current?.querySelector<HTMLElement>('.canvas-artboard__compiled');
      if (!gesture || !instance || !canvas || !compiled) return;
      const next = applyCanvasPreviewGesture(
        instance.getViewport(),
        gesture,
        canvas.getBoundingClientRect(),
        compiled.getBoundingClientRect(),
        { minimumZoom: canvasMinimumZoom, maximumZoom: canvasMaximumZoom }
      );
      void instance.setViewport(next, { duration: 0 });
    };
    window.addEventListener(PREVIEW_CANVAS_GESTURE_EVENT, applyPreviewGesture);
    return () => window.removeEventListener(PREVIEW_CANVAS_GESTURE_EVENT, applyPreviewGesture);
  }, [mode]);

  if (mode === 'present')
    return (
      <section className="canvas-presentation" aria-label="Prototype presentation">
        <CanvasPreviewContext.Provider value={preview}>
          <div className="canvas-presentation__artifact">{preview}</div>
        </CanvasPreviewContext.Provider>
        <button
          className="canvas-presentation__exit"
          ref={presentExit}
          type="button"
          onClick={(event) => void onModeChange('design', event.currentTarget)}
        >
          Exit
          <kbd>Esc</kbd>
        </button>
      </section>
    );

  return (
    <section
      className="canvas-workspace"
      data-mode={mode}
      data-hand-tool={handTool || spacePressed || undefined}
      ref={workspace}
      aria-label="Design canvas"
    >
      <header className="canvas-workspace__toolbar">
        <div role="toolbar" aria-label="Canvas tools">
          <button type="button" aria-pressed="true">
            Design
          </button>
          <button
            type="button"
            disabled={readOnly}
            onClick={(event) => void onModeChange('present', event.currentTarget)}
          >
            Present
          </button>
          <span className="canvas-workspace__toolbar-divider" aria-hidden="true" />
          <button
            type="button"
            aria-pressed={handTool}
            aria-keyshortcuts="H"
            onClick={() => {
              clearCanvasSelection();
              setHandTool((current) => !current);
            }}
          >
            Hand <kbd>H</kbd>
          </button>
          <button type="button" aria-keyshortcuts="Shift+1" onClick={() => void fitAll()}>
            Fit <kbd>⇧1</kbd>
          </button>
          <button type="button" aria-keyshortcuts="Shift+2" onClick={() => void fitSelection()}>
            Selection <kbd>⇧2</kbd>
          </button>
        </div>
        <output
          aria-live="polite"
          data-error={canvasError !== undefined || undefined}
          title={safeDesignerNotice(canvasError ?? saveStatus)}
        >
          {safeDesignerNotice(canvasError ?? saveStatus)}
        </output>
        <button
          className="canvas-workspace__ask-ai"
          type="button"
          disabled={!canRequestAiTarget}
          onClick={(event) => onRequestAiTarget(event.currentTarget)}
        >
          @ Ask AI
        </button>
        <button
          className="canvas-workspace__comment"
          type="button"
          aria-label="Add a comment anywhere on the artifact"
          onClick={(event) => onRequestReviewTarget(event.currentTarget)}
        >
          + Comment
        </button>
      </header>
      <CanvasPreviewContext.Provider value={preview}>
        <ReactFlow
          onInit={(instance) => {
            flow.current = instance;
            fittedProject.current = projectFence;
            requestAnimationFrame(() => requestAnimationFrame(() => void fitActiveArtboard(0)));
          }}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={updateNodes}
          onEdgesChange={updateEdges}
          onNodeDragStop={saveNodePosition}
          onConnect={connect}
          onEdgesDelete={removeEdges}
          onSelectionChange={selectCanvasItems}
          onNodeClick={selectNode}
          onPaneClick={() => {
            clearCanvasSelection();
          }}
          nodesDraggable={!readOnly && mode === 'design' && !handTool && !spacePressed}
          nodesConnectable={!readOnly && mode === 'design'}
          edgesFocusable={mode === 'design'}
          edgesReconnectable={false}
          deleteKeyCode={mode === 'design' && !readOnly ? ['Backspace', 'Delete'] : null}
          panOnScroll
          panOnDrag={handTool || spacePressed ? [0, 1, 2] : [1, 2]}
          zoomOnPinch
          zoomOnScroll={false}
          zoomOnDoubleClick={false}
          preventScrolling
          minZoom={canvasMinimumZoom}
          maxZoom={canvasMaximumZoom}
          defaultViewport={{ x: 0, y: 0, zoom: 0.72 }}
          // Selected wires must remain selectable without being elevated above
          // the live artboard's controls and intercepting their pointer input.
          elevateEdgesOnSelect={false}
          attributionPosition="bottom-right"
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#aab3c4" />
          {libraryOpen ? (
            <Panel className="canvas-workspace__library" position="top-left">
              <header className="canvas-workspace__library-header">
                <strong>Pages and assets</strong>
                <button
                  type="button"
                  aria-label="Close pages and assets"
                  onClick={() => {
                    setLibraryOpen(false);
                    requestAnimationFrame(() => void fitActiveArtboard());
                  }}
                >
                  ×
                </button>
              </header>
              <div
                className="canvas-workspace__library-tabs"
                role="group"
                aria-label="Canvas library"
              >
                {(['artboards', 'assets'] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    aria-pressed={panel === item}
                    onClick={() => setPanel(item)}
                  >
                    {item[0]!.toUpperCase() + item.slice(1)}
                  </button>
                ))}
              </div>
              {panel === 'artboards' ? (
                <div aria-label="Artboards">
                  <ol className="canvas-workspace__layers">
                    {graph.nodes.map((node) => (
                      <li
                        key={node.id}
                        data-current={node.id === activeId || undefined}
                        data-selected={node.id === selectedNodeId || undefined}
                      >
                        <button
                          type="button"
                          aria-pressed={node.id === selectedNodeId}
                          onClick={() => selectArtboardNode(node.id)}
                        >
                          <span data-kind={node.kind}>{node.kind === 'overlay' ? '◇' : '▱'}</span>
                          <span>
                            <strong>{node.label}</strong>
                            <small>
                              {node.id === activeId
                                ? 'Current rendered screen'
                                : node.kind === 'state'
                                  ? 'Screen state'
                                  : node.kind === 'overlay'
                                    ? 'Interaction overlay'
                                    : activatableNodeIds.includes(node.id)
                                      ? 'Saved scenario available'
                                      : 'No saved start scenario'}
                            </small>
                          </span>
                        </button>
                        {node.id !== activeId && activatableNodeIds.includes(node.id) ? (
                          <button
                            className="canvas-workspace__layer-run"
                            type="button"
                            aria-label={`Run declared scenario for ${node.label}`}
                            disabled={readOnly}
                            onClick={() => onActivateNode(node.id)}
                          >
                            ▶
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : (
                <div className="canvas-workspace__assets" aria-label="Assets">
                  <strong>Published components</strong>
                  {catalogEntries.length === 0 ? (
                    <p>No catalog components are published for this artifact.</p>
                  ) : (
                    <ol>
                      {catalogEntries.map((entry) => (
                        <li key={`${entry.component}:${entry.href}`}>
                          <span>{entry.component}</span>
                          <small>Reusable component</small>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              )}
            </Panel>
          ) : (
            <Panel className="canvas-workspace__library-toggle" position="top-left">
              <button
                type="button"
                onClick={() => {
                  setLibraryOpen(true);
                  requestAnimationFrame(() => void fitActiveArtboard());
                }}
              >
                Pages
              </button>
            </Panel>
          )}
          {onOpenAi || onOpenInspector ? (
            <Panel className="canvas-workspace__compact-actions" position="top-right">
              {onOpenAi ? (
                <button type="button" onClick={onOpenAi}>
                  Open AI
                </button>
              ) : null}
              {onOpenInspector ? (
                <button type="button" onClick={onOpenInspector}>
                  Inspect
                </button>
              ) : null}
            </Panel>
          ) : null}
        </ReactFlow>
      </CanvasPreviewContext.Provider>
    </section>
  );
}
