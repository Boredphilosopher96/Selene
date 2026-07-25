import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent
} from 'react';

import {
  copyPrototypeNodes,
  pastePrototypeNodes,
  removePrototypeTransition,
  upsertPrototypeTransition,
  type PrototypeGraph,
  type PrototypeNode,
  type PrototypeTransition
} from '@selene/core';

import './prototype-studio.css';

const kinds = [
  'navigate',
  'back',
  'set-state',
  'open-overlay',
  'close-overlay',
  'reset-flow'
] as const;
type ConnectorStart = { nodeId: string; portId: string; x: number; y: number };
type CanvasBounds = { minX: number; minY: number; width: number; height: number };
type WireLayout = {
  readonly path: string;
  readonly label: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly text: string;
  };
};
type LayoutRectangle = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

function rectanglesOverlap(left: LayoutRectangle, right: LayoutRectangle): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

function transitionText(transition: PrototypeTransition): string {
  return `${transition.from.nodeId}.${transition.from.portId} · ${transition.kind}`;
}

function connectionText(transition: PrototypeTransition): string {
  return `${transition.from.nodeId}.${transition.from.portId} → ${
    'to' in transition
      ? transition.to.nodeId
      : transition.kind === 'back'
        ? 'history/back'
        : 'active scenario start'
  } (${transition.kind})`;
}

/**
 * Routes edges in stable ID order and shifts labels out of previously occupied
 * text boxes. This deliberately uses only graph data, making visual output
 * reproducible across browser runs and independent of DOM measurement.
 */
export function layoutPrototypeWires(
  graph: PrototypeGraph,
  bounds: CanvasBounds
): ReadonlyMap<string, WireLayout> {
  const transitions = [...graph.transitions].sort((left, right) => left.id.localeCompare(right.id));
  const occupied: LayoutRectangle[] = graph.nodes.map((node) => ({
    x: node.position.x - bounds.minX - 8,
    y: node.position.y - bounds.minY - 8,
    width: 196,
    height: 160 + node.ports.length * 29
  }));
  const layouts = new Map<string, WireLayout>();
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, PrototypeTransition[]>();
  for (const transition of transitions) {
    const key = transition.from.nodeId;
    outgoing.set(key, [...(outgoing.get(key) ?? []), transition]);
  }

  function label(x: number, y: number, text: string) {
    const width = Math.max(72, text.length * 6.25);
    const height = 16;
    const clampX = (value: number) => Math.max(12, Math.min(value, bounds.width - width - 12));
    const xCandidates = [...new Set([clampX(x), clampX(x + 260), clampX(x - width - 24)])];
    const preferredBaseline = Math.max(height + 8, Math.min(y, bounds.height - 12));
    const baselines = [preferredBaseline];
    for (let offset = 20; offset <= bounds.height; offset += 20) {
      baselines.push(preferredBaseline + offset, preferredBaseline - offset);
    }
    for (let baseline = height + 8; baseline <= bounds.height - 12; baseline += 20) {
      baselines.push(baseline);
    }
    const position = baselines
      .flatMap((baseline) => xCandidates.map((candidateX) => ({ x: candidateX, baseline })))
      .find(({ x: candidateX, baseline }) => {
        const rectangle = { x: candidateX, y: baseline - height, width, height };
        return (
          rectangle.y >= 8 &&
          rectangle.y + rectangle.height <= bounds.height - 8 &&
          !occupied.some((item) => rectanglesOverlap(rectangle, item))
        );
      }) ?? { x: xCandidates[0] ?? 12, baseline: preferredBaseline };
    const nextX = position.x;
    const nextBaseline = position.baseline;
    occupied.push({ x: nextX, y: nextBaseline - height, width, height });
    return { x: nextX, y: nextBaseline, width, height, text };
  }

  for (const transition of transitions) {
    const from = nodeById.get(transition.from.nodeId);
    if (!from) continue;
    const x1 = from.position.x - bounds.minX + 180;
    const y1 = from.position.y - bounds.minY + 42;
    const group = outgoing.get(transition.from.nodeId) ?? [];
    const lane = group.findIndex((item) => item.id === transition.id);
    const text = transitionText(transition);

    if (!('to' in transition)) {
      const routeX = x1 + 52 + lane * 26;
      const routeY = y1 - 48 - lane * 24;
      layouts.set(transition.id, {
        path: `M ${x1} ${y1} H ${routeX} V ${routeY} H ${x1 + 8}`,
        label: label(routeX + 8, routeY - 8, text)
      });
      continue;
    }

    const to = nodeById.get(transition.to.nodeId);
    if (!to) continue;
    const x2 = to.position.x - bounds.minX;
    const y2 = to.position.y - bounds.minY + 42;
    if (x2 > x1 + 48) {
      const routeX = Math.round((x1 + x2) / 2) + lane * 22;
      layouts.set(transition.id, {
        path: `M ${x1} ${y1} H ${routeX} V ${y2} H ${x2}`,
        label: label(routeX + 8, Math.min(y1, y2) + Math.abs(y2 - y1) / 2 - 8, text)
      });
    } else {
      const routeX = x1 + 56 + lane * 26;
      const routeY = Math.min(y1, y2) - 54 - lane * 24;
      layouts.set(transition.id, {
        path: `M ${x1} ${y1} H ${routeX} V ${routeY} H ${x2 - 28} V ${y2} H ${x2}`,
        label: label(routeX + 8, routeY - 8, text)
      });
    }
  }
  return layouts;
}

function supportedTargets(graph: PrototypeGraph, kind: PrototypeTransition['kind']) {
  return graph.nodes.filter((node) => {
    if (kind === 'back' || kind === 'reset-flow') return false;
    if (kind === 'navigate') return node.kind === 'screen' || node.kind === 'page';
    if (kind === 'set-state') return node.kind === 'state';
    return node.kind === 'overlay';
  });
}

function inferredKind(target: PrototypeNode): PrototypeTransition['kind'] {
  if (target.kind === 'state') return 'set-state';
  if (target.kind === 'overlay') return 'open-overlay';
  return 'navigate';
}

function connectionId(fromNodeId: string, portId: string, targetId = 'history'): string {
  return `wire-${fromNodeId}-${portId}-${targetId}`.replace(/[^A-Za-z0-9._:-]/g, '-');
}

export interface PrototypeFlowCanvasProps {
  readonly graph: PrototypeGraph;
  /** The owning host persists this explicit, already-validated headless graph. */
  readonly onGraphChange?: ((graph: PrototypeGraph) => void) | undefined;
  readonly activeNodeIds?: readonly string[] | undefined;
  readonly activeTransitionIds?: readonly string[] | undefined;
  readonly readOnly?: boolean | undefined;
}

/**
 * A reusable, controlled graph editor. Pointer wiring is primary; the form is
 * the keyboard-accessible parity path for every connector operation.
 */
export function PrototypeFlowCanvas({
  graph,
  onGraphChange,
  activeNodeIds = [],
  activeTransitionIds = [],
  readOnly = false
}: PrototypeFlowCanvasProps) {
  const selectId = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const firstPort = graph.nodes.find((node) => node.ports.length > 0);
  const [sourceNodeId, setSourceNodeId] = useState(firstPort?.id ?? '');
  const [portId, setPortId] = useState(firstPort?.ports[0]?.id ?? '');
  const [kind, setKind] = useState<PrototypeTransition['kind']>('navigate');
  const [targetNodeId, setTargetNodeId] = useState('');
  const [editingId, setEditingId] = useState<string>();
  const [connector, setConnector] = useState<ConnectorStart>();
  const [pointer, setPointer] = useState<{ x: number; y: number }>();
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragPan, setDragPan] = useState<{
    x: number;
    y: number;
    startX: number;
    startY: number;
  }>();
  const [past, setPast] = useState<PrototypeGraph[]>([]);
  const [future, setFuture] = useState<PrototypeGraph[]>([]);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [clipboard, setClipboard] = useState('');
  const [error, setError] = useState<string>();
  const [transitionSearch, setTransitionSearch] = useState('');
  const [pendingDelete, setPendingDelete] = useState<PrototypeTransition>();
  const fitted = useRef(false);

  const source = graph.nodes.find((node) => node.id === sourceNodeId);
  const targets = useMemo(() => supportedTargets(graph, kind), [graph, kind]);
  const bounds = useMemo<CanvasBounds>(() => {
    const xs = graph.nodes.map((node) => node.position.x);
    const ys = graph.nodes.map((node) => node.position.y);
    return {
      minX: Math.min(...xs) - 80,
      minY: Math.min(...ys) - 120,
      width: Math.max(840, Math.max(...xs) - Math.min(...xs) + 460),
      height: Math.max(520, Math.max(...ys) - Math.min(...ys) + 380)
    };
  }, [graph.nodes]);
  const wireLayouts = useMemo(() => layoutPrototypeWires(graph, bounds), [bounds, graph]);
  const transitionGroups = useMemo(() => {
    const query = transitionSearch.trim().toLocaleLowerCase();
    const groups = new Map<string, PrototypeTransition[]>();
    for (const transition of graph.transitions) {
      if (query && !transitionText(transition).toLocaleLowerCase().includes(query)) continue;
      groups.set(transition.from.nodeId, [
        ...(groups.get(transition.from.nodeId) ?? []),
        transition
      ]);
    }
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [graph.transitions, transitionSearch]);

  function fitToView() {
    const rect = viewport.current?.getBoundingClientRect();
    if (!rect) return;
    const padding = 48;
    const nextZoom = Math.min(
      1,
      Math.max(
        0.5,
        Math.min((rect.width - padding) / bounds.width, (rect.height - padding) / bounds.height)
      )
    );
    setZoom(nextZoom);
    setPan({
      x: Math.round((rect.width - bounds.width * nextZoom) / 2),
      y: Math.round((rect.height - bounds.height * nextZoom) / 2)
    });
  }

  useLayoutEffect(() => {
    if (fitted.current) return;
    fitted.current = true;
    fitToView();
  }, [bounds.height, bounds.width]);

  useEffect(() => {
    if (source?.ports.some((port) => port.id === portId)) return;
    setPortId(source?.ports[0]?.id ?? '');
  }, [portId, source]);

  useEffect(() => {
    if (targets.some((node) => node.id === targetNodeId)) return;
    setTargetNodeId(targets[0]?.id ?? '');
  }, [targetNodeId, targets]);

  function commit(next: PrototypeGraph) {
    if (readOnly || !onGraphChange) return;
    setPast((items) => [...items, graph]);
    setFuture([]);
    onGraphChange(next);
  }

  function connect(
    fromNodeId: string,
    nextPortId: string,
    targetId: string | undefined,
    nextKind: PrototypeTransition['kind'],
    id?: string
  ) {
    if (readOnly) return;
    try {
      const transition =
        nextKind === 'back' || nextKind === 'reset-flow'
          ? {
              id: id ?? connectionId(fromNodeId, nextPortId),
              kind: nextKind,
              from: { nodeId: fromNodeId, portId: nextPortId }
            }
          : {
              id: id ?? connectionId(fromNodeId, nextPortId, targetId),
              kind: nextKind,
              from: { nodeId: fromNodeId, portId: nextPortId },
              to: { nodeId: targetId! }
            };
      commit(upsertPrototypeTransition(graph, transition));
      setEditingId(undefined);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create that connector.');
    } finally {
      setConnector(undefined);
      setPointer(undefined);
    }
  }

  function edit(transition: PrototypeTransition) {
    if (readOnly) return;
    setEditingId(transition.id);
    setSourceNodeId(transition.from.nodeId);
    setPortId(transition.from.portId);
    setKind(transition.kind);
    setTargetNodeId('to' in transition ? transition.to.nodeId : '');
  }
  function remove(transition: PrototypeTransition) {
    if (readOnly) return;
    commit(removePrototypeTransition(graph, transition.id));
    if (editingId === transition.id) setEditingId(undefined);
  }

  function startConnector(
    nodeId: string,
    nextPortId: string,
    event?: PointerEvent<HTMLButtonElement>
  ) {
    if (readOnly) return;
    event?.stopPropagation();
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return;
    setSourceNodeId(nodeId);
    setPortId(nextPortId);
    setConnector({
      nodeId,
      portId: nextPortId,
      x: node.position.x - bounds.minX + 180,
      y: node.position.y - bounds.minY + 42
    });
  }

  function finishConnector(target: PrototypeNode) {
    if (readOnly) return;
    if (!connector) return;
    if (connector.nodeId === target.id) {
      setConnector(undefined);
      setPointer(undefined);
      return;
    }
    connect(connector.nodeId, connector.portId, target.id, inferredKind(target));
  }

  function point(event: PointerEvent<HTMLElement>) {
    const rect = viewport.current?.getBoundingClientRect();
    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : undefined;
  }

  function onViewportPointerDown(event: PointerEvent<HTMLDivElement>) {
    if ((event.target as Element).closest('button, select, [data-prototype-target]')) return;
    setDragPan({ x: event.clientX, y: event.clientY, startX: pan.x, startY: pan.y });
  }

  function onViewportPointerMove(event: PointerEvent<HTMLDivElement>) {
    const next = point(event);
    if (connector && next) setPointer(next);
    if (dragPan)
      setPan({
        x: dragPan.startX + event.clientX - dragPan.x,
        y: dragPan.startY + event.clientY - dragPan.y
      });
  }

  function undo() {
    if (readOnly || !onGraphChange) return;
    const previous = past.at(-1);
    if (!previous) return;
    setPast((items) => items.slice(0, -1));
    setFuture((items) => [graph, ...items]);
    onGraphChange(previous);
  }

  function redo() {
    if (readOnly || !onGraphChange) return;
    const next = future[0];
    if (!next) return;
    setFuture((items) => items.slice(1));
    setPast((items) => [...items, graph]);
    onGraphChange(next);
  }

  async function copySelected() {
    if (readOnly) return;
    if (selectedNodeIds.length === 0) return;
    const serialized = copyPrototypeNodes(graph, selectedNodeIds);
    setClipboard(serialized);
    try {
      await navigator.clipboard?.writeText(serialized);
    } catch {
      // The in-memory value remains available in permission-restricted hosts.
    }
  }

  async function pasteSelected() {
    if (readOnly) return;
    let serialized = clipboard;
    try {
      serialized = (await navigator.clipboard?.readText()) || serialized;
    } catch {
      // Clipboard permission is optional for a local editor.
    }
    if (!serialized) {
      setError('No prototype fragment is available in the clipboard.');
      return;
    }
    try {
      commit(pastePrototypeNodes(graph, serialized));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not paste the prototype fragment.');
    }
  }

  return (
    <section className="prototype-flow" aria-label="Prototype flow canvas">
      <div className="prototype-flow__heading">
        <div>
          <p className="prototype-kicker">Prototype graph</p>
          <h2>{graph.name}</h2>
        </div>
        <div className="prototype-flow__actions">
          {!readOnly ? (
            <button type="button" onClick={undo} disabled={past.length === 0}>
              Undo
            </button>
          ) : null}
          {!readOnly ? (
            <button type="button" onClick={redo} disabled={future.length === 0}>
              Redo
            </button>
          ) : null}
          {!readOnly ? (
            <button
              type="button"
              onClick={() => void copySelected()}
              disabled={selectedNodeIds.length === 0}
            >
              Copy selected
            </button>
          ) : null}
          {!readOnly ? (
            <button type="button" onClick={() => void pasteSelected()}>
              Paste
            </button>
          ) : null}
          <button type="button" onClick={fitToView} aria-label="Fit canvas to view">
            Fit view
          </button>
          <button
            type="button"
            onClick={() => setZoom((value) => Math.max(0.5, value - 0.1))}
            aria-label="Zoom out"
          >
            −
          </button>
          <span aria-label={`Canvas zoom ${Math.round(zoom * 100)} percent`}>
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setZoom((value) => Math.min(2, value + 0.1))}
            aria-label="Zoom in"
          >
            +
          </button>
        </div>
      </div>
      {error ? (
        <p className="prototype-flow__error" role="alert">
          {error}
        </p>
      ) : null}
      {!readOnly && pendingDelete ? (
        <section
          className="prototype-flow__confirmation"
          role="alertdialog"
          aria-label="Confirm transition deletion"
        >
          <p>Delete {connectionText(pendingDelete)}? Undo remains available after deletion.</p>
          <button
            type="button"
            onClick={() => {
              remove(pendingDelete);
              setPendingDelete(undefined);
            }}
          >
            Delete transition
          </button>
          <button type="button" onClick={() => setPendingDelete(undefined)}>
            Keep transition
          </button>
        </section>
      ) : null}
      {!readOnly ? (
        <p className="prototype-flow__instruction">
          Drag from an action port to a target node. Select a port, then press Enter on a node for
          keyboard wiring. Drag empty canvas to pan.
        </p>
      ) : null}
      <div
        ref={viewport}
        className="prototype-flow__viewport"
        tabIndex={readOnly ? -1 : 0}
        aria-label="Visual prototype flow"
        onPointerDown={readOnly ? undefined : onViewportPointerDown}
        onPointerMove={readOnly ? undefined : onViewportPointerMove}
        onPointerUp={
          readOnly
            ? undefined
            : (event) => {
                setDragPan(undefined);
                if (!connector) return;
                const targetId = document
                  .elementFromPoint(event.clientX, event.clientY)
                  ?.closest<HTMLElement>('[data-prototype-target]')?.dataset.prototypeTarget;
                const target = graph.nodes.find((node) => node.id === targetId);
                if (target) finishConnector(target);
                else {
                  setConnector(undefined);
                  setPointer(undefined);
                }
              }
        }
        onPointerLeave={readOnly ? undefined : () => setDragPan(undefined)}
      >
        <div
          className="prototype-flow__transform"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        >
          <div
            className="prototype-flow__plane"
            style={{ width: bounds.width, height: bounds.height }}
          >
            <svg aria-hidden="true" viewBox={`0 0 ${bounds.width} ${bounds.height}`}>
              <defs>
                <marker
                  id={`${selectId}-arrow`}
                  markerWidth="8"
                  markerHeight="8"
                  refX="7"
                  refY="4"
                  orient="auto"
                >
                  <path d="M0,0 L8,4 L0,8 Z" />
                </marker>
              </defs>
              {graph.transitions.map((transition) => (
                <Wire
                  key={transition.id}
                  transition={transition}
                  markerId={selectId}
                  layout={wireLayouts.get(transition.id)}
                  active={
                    activeTransitionIds.includes(transition.id) ||
                    (activeTransitionIds.length === 0 &&
                      (activeNodeIds.includes(transition.from.nodeId) ||
                        ('to' in transition && activeNodeIds.includes(transition.to.nodeId))))
                  }
                />
              ))}
              {connector && pointer ? (
                <path
                  className="prototype-flow__wire prototype-flow__wire--draft"
                  d={`M ${connector.x} ${connector.y} L ${(pointer.x - pan.x) / zoom} ${(pointer.y - pan.y) / zoom}`}
                  markerEnd={`url(#${selectId}-arrow)`}
                />
              ) : null}
            </svg>
            {graph.nodes.map((node) => (
              <GraphNode
                key={node.id}
                node={node}
                bounds={bounds}
                active={activeNodeIds.includes(node.id)}
                selected={selectedNodeIds.includes(node.id)}
                connectorActive={!readOnly && connector !== undefined}
                {...(!readOnly
                  ? {
                      onStart: startConnector,
                      onFinish: finishConnector,
                      onSelect: (nodeId: string) =>
                        setSelectedNodeIds((items) =>
                          items.includes(nodeId)
                            ? items.filter((item) => item !== nodeId)
                            : [...items, nodeId]
                        )
                    }
                  : {})}
              />
            ))}
          </div>
        </div>
      </div>
      {!readOnly ? (
        <form
          className="prototype-flow__connector"
          aria-label="Transition editor"
          onSubmit={(event) => {
            event.preventDefault();
            if (source && portId && (kind === 'back' || kind === 'reset-flow' || targetNodeId))
              connect(source.id, portId, targetNodeId || undefined, kind, editingId);
          }}
        >
          <strong>{editingId ? 'Edit transition' : 'Create a transition'}</strong>
          <fieldset>
            <legend>Source</legend>
            <label>
              From node
              <select
                value={sourceNodeId}
                onChange={(event) => setSourceNodeId(event.currentTarget.value)}
              >
                {graph.nodes
                  .filter((node) => node.ports.length > 0)
                  .map((node) => (
                    <option key={node.id} value={node.id}>
                      {node.label}
                    </option>
                  ))}
              </select>
            </label>
            {!readOnly ? (
              <label>
                Action port
                <select value={portId} onChange={(event) => setPortId(event.currentTarget.value)}>
                  {source?.ports.map((port) => (
                    <option key={port.id} value={port.id}>
                      {port.label} ({port.trigger})
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </fieldset>
          <fieldset>
            <legend>Outcome</legend>
            <label>
              Effect
              <select
                value={kind}
                onChange={(event) =>
                  setKind(event.currentTarget.value as PrototypeTransition['kind'])
                }
              >
                {kinds.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            {kind === 'back' ? (
              <p>Destination: history/back</p>
            ) : kind === 'reset-flow' ? (
              <p>Destination: active scenario start</p>
            ) : (
              <label>
                Target
                <select
                  value={targetNodeId}
                  onChange={(event) => setTargetNodeId(event.currentTarget.value)}
                >
                  {targets.map((node) => (
                    <option key={node.id} value={node.id}>
                      {node.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </fieldset>
          <button
            type="submit"
            disabled={
              !source || !portId || (!(kind === 'back' || kind === 'reset-flow') && !targetNodeId)
            }
          >
            {editingId ? 'Save connector' : 'Connect action'}
          </button>
          {editingId ? (
            <button type="button" onClick={() => setEditingId(undefined)}>
              Cancel edit
            </button>
          ) : null}
        </form>
      ) : null}
      <section className="prototype-flow__connections" aria-label="Existing connectors">
        <div className="prototype-flow__connections-heading">
          <div>
            <p className="prototype-kicker">Transition details</p>
            <h3>{graph.transitions.length} transitions</h3>
          </div>
          <label>
            Search transitions
            <input
              aria-label="Search transitions"
              value={transitionSearch}
              onChange={(event) => setTransitionSearch(event.currentTarget.value)}
            />
          </label>
        </div>
        {transitionGroups.map(([nodeId, transitions]) => {
          const node = graph.nodes.find((item) => item.id === nodeId);
          return (
            <details key={nodeId} open={transitionSearch.length > 0}>
              <summary>
                {node?.label ?? nodeId} · {transitions.length} transition
                {transitions.length === 1 ? '' : 's'}
              </summary>
              <ul>
                {transitions.map((transition) => (
                  <li key={transition.id}>
                    <span>{connectionText(transition)}</span>
                    {!readOnly ? (
                      <button type="button" onClick={() => edit(transition)}>
                        Edit
                      </button>
                    ) : null}
                    {!readOnly ? (
                      <button type="button" onClick={() => setPendingDelete(transition)}>
                        Delete
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </details>
          );
        })}
      </section>
    </section>
  );
}

function Wire({
  transition,
  markerId,
  layout,
  active
}: {
  readonly transition: PrototypeTransition;
  readonly markerId: string;
  readonly layout: WireLayout | undefined;
  readonly active: boolean;
}) {
  if (!layout) return null;
  return (
    <g data-prototype-wire={transition.id}>
      <path
        className={`prototype-flow__wire${active ? ' prototype-flow__wire--active' : ''}`}
        d={layout.path}
        markerEnd={`url(#${markerId}-arrow)`}
      />
      <rect
        className="prototype-flow__wire-label-background"
        x={layout.label.x - 4}
        y={layout.label.y - layout.label.height}
        width={layout.label.width + 8}
        height={layout.label.height + 4}
        rx="4"
      />
      <text
        data-prototype-wire-label={transition.id}
        x={layout.label.x}
        y={layout.label.y}
        className="prototype-flow__wire-label"
      >
        {layout.label.text}
      </text>
    </g>
  );
}

function GraphNode({
  node,
  bounds,
  active,
  selected,
  connectorActive,
  onStart,
  onFinish,
  onSelect
}: {
  readonly node: PrototypeNode;
  readonly bounds: { minX: number; minY: number };
  readonly active: boolean;
  readonly selected: boolean;
  readonly connectorActive: boolean;
  readonly onStart?: (
    nodeId: string,
    portId: string,
    event?: PointerEvent<HTMLButtonElement>
  ) => void;
  readonly onFinish?: (target: PrototypeNode) => void;
  readonly onSelect?: (nodeId: string) => void;
}) {
  return (
    <article
      className={`prototype-flow__node prototype-flow__node--${node.kind}${active ? ' prototype-flow__node--active' : ''}${selected ? ' prototype-flow__node--selected' : ''}`}
      data-prototype-target={node.id}
      style={{ left: node.position.x - bounds.minX, top: node.position.y - bounds.minY }}
      aria-label={`${node.label} node`}
    >
      <span>{node.kind}</span>
      <strong>{node.label}</strong>
      {'route' in node ? <code>{node.route}</code> : null}
      {'parentId' in node ? <small>state of {node.parentId}</small> : null}
      {'dismissible' in node ? (
        <small>{node.dismissible ? 'dismissible' : 'persistent'}</small>
      ) : null}
      {onFinish ? (
        <button
          type="button"
          className="prototype-flow__drop-target"
          aria-label={`Connect to ${node.label}`}
          onKeyDown={(event) => {
            if (connectorActive && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault();
              onFinish?.(node);
            }
          }}
        >
          Drop target
        </button>
      ) : null}
      {onSelect ? (
        <button
          type="button"
          className="prototype-flow__select"
          aria-pressed={selected}
          onClick={() => onSelect(node.id)}
        >
          {selected ? 'Selected' : 'Select'}
        </button>
      ) : null}
      {onStart ? (
        <div className="prototype-flow__ports" aria-label={`${node.label} action ports`}>
          {node.ports.map((port) => (
            <button
              key={port.id}
              type="button"
              className="prototype-flow__port"
              aria-label={`${port.label} action port`}
              onPointerDown={(event) => onStart(node.id, port.id, event)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onStart(node.id, port.id);
                }
              }}
            >
              {port.label}
            </button>
          ))}
        </div>
      ) : null}
    </article>
  );
}
