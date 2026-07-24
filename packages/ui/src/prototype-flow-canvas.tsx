import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';

import {
  copyPrototypeNodes,
  pastePrototypeNodes,
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
  readonly onGraphChange: (graph: PrototypeGraph) => void;
  readonly activeNodeIds?: readonly string[] | undefined;
  readonly activeTransitionIds?: readonly string[] | undefined;
}

/**
 * A reusable, controlled graph editor. Pointer wiring is primary; the form is
 * the keyboard-accessible parity path for every connector operation.
 */
export function PrototypeFlowCanvas({
  graph,
  onGraphChange,
  activeNodeIds = [],
  activeTransitionIds = []
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

  const source = graph.nodes.find((node) => node.id === sourceNodeId);
  const targets = useMemo(() => supportedTargets(graph, kind), [graph, kind]);
  const bounds = useMemo(() => {
    const xs = graph.nodes.map((node) => node.position.x);
    const ys = graph.nodes.map((node) => node.position.y);
    return {
      minX: Math.min(...xs) - 40,
      minY: Math.min(...ys) - 40,
      width: Math.max(720, Math.max(...xs) - Math.min(...xs) + 290),
      height: Math.max(360, Math.max(...ys) - Math.min(...ys) + 190)
    };
  }, [graph.nodes]);

  useEffect(() => {
    if (source?.ports.some((port) => port.id === portId)) return;
    setPortId(source?.ports[0]?.id ?? '');
  }, [portId, source]);

  useEffect(() => {
    if (targets.some((node) => node.id === targetNodeId)) return;
    setTargetNodeId(targets[0]?.id ?? '');
  }, [targetNodeId, targets]);

  function commit(next: PrototypeGraph) {
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
    setEditingId(transition.id);
    setSourceNodeId(transition.from.nodeId);
    setPortId(transition.from.portId);
    setKind(transition.kind);
    setTargetNodeId('to' in transition ? transition.to.nodeId : '');
  }

  function startConnector(
    nodeId: string,
    nextPortId: string,
    event?: PointerEvent<HTMLButtonElement>
  ) {
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
    const previous = past.at(-1);
    if (!previous) return;
    setPast((items) => items.slice(0, -1));
    setFuture((items) => [graph, ...items]);
    onGraphChange(previous);
  }

  function redo() {
    const next = future[0];
    if (!next) return;
    setFuture((items) => items.slice(1));
    setPast((items) => [...items, graph]);
    onGraphChange(next);
  }

  async function copySelected() {
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
          <button type="button" onClick={undo} disabled={past.length === 0}>
            Undo
          </button>
          <button type="button" onClick={redo} disabled={future.length === 0}>
            Redo
          </button>
          <button
            type="button"
            onClick={() => void copySelected()}
            disabled={selectedNodeIds.length === 0}
          >
            Copy selected
          </button>
          <button type="button" onClick={() => void pasteSelected()}>
            Paste
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
      <p className="prototype-flow__instruction">
        Drag from an action port to a target node. Select a port, then press Enter on a node for
        keyboard wiring. Drag empty canvas to pan.
      </p>
      <div
        ref={viewport}
        className="prototype-flow__viewport"
        tabIndex={0}
        aria-label="Visual prototype flow"
        onPointerDown={onViewportPointerDown}
        onPointerMove={onViewportPointerMove}
        onPointerUp={(event) => {
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
        }}
        onPointerLeave={() => setDragPan(undefined)}
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
                  graph={graph}
                  transition={transition}
                  bounds={bounds}
                  markerId={selectId}
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
                connectorActive={connector !== undefined}
                onStart={startConnector}
                onFinish={finishConnector}
                onSelect={(nodeId) =>
                  setSelectedNodeIds((items) =>
                    items.includes(nodeId)
                      ? items.filter((item) => item !== nodeId)
                      : [...items, nodeId]
                  )
                }
              />
            ))}
          </div>
        </div>
      </div>
      <form
        className="prototype-flow__connector"
        aria-label="Create or edit connector"
        onSubmit={(event) => {
          event.preventDefault();
          if (source && portId && (kind === 'back' || kind === 'reset-flow' || targetNodeId))
            connect(source.id, portId, targetNodeId || undefined, kind, editingId);
        }}
      >
        <strong>{editingId ? 'Edit connector' : 'Keyboard connector controls'}</strong>
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
        <label>
          Effect
          <select
            value={kind}
            onChange={(event) => setKind(event.currentTarget.value as PrototypeTransition['kind'])}
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
      <ul className="prototype-flow__connections" aria-label="Existing connectors">
        {graph.transitions.map((transition) => (
          <li key={transition.id}>
            <span>
              {transition.from.nodeId}.{transition.from.portId} →{' '}
              {'to' in transition
                ? transition.to.nodeId
                : transition.kind === 'back'
                  ? 'history/back'
                  : 'active scenario start'}{' '}
              ({transition.kind})
            </span>
            <button type="button" onClick={() => edit(transition)}>
              Edit
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Wire({
  graph,
  transition,
  bounds,
  markerId,
  active
}: {
  readonly graph: PrototypeGraph;
  readonly transition: PrototypeTransition;
  readonly bounds: { minX: number; minY: number };
  readonly markerId: string;
  readonly active: boolean;
}) {
  const from = graph.nodes.find((node) => node.id === transition.from.nodeId);
  if (!from) return null;
  const x1 = from.position.x - bounds.minX + 180;
  const y1 = from.position.y - bounds.minY + 42;
  if (!('to' in transition))
    return (
      <g>
        <path
          className={`prototype-flow__wire${active ? ' prototype-flow__wire--active' : ''}`}
          d={`M ${x1} ${y1} C ${x1 + 56} ${y1}, ${x1 + 56} ${y1 - 42}, ${x1} ${y1 - 42}`}
          markerEnd={`url(#${markerId}-arrow)`}
        />
        <text x={x1 + 8} y={y1 - 50} className="prototype-flow__wire-label">
          {transition.kind === 'back' ? 'history/back' : 'scenario reset'}
        </text>
      </g>
    );
  const to = graph.nodes.find((node) => node.id === transition.to.nodeId);
  if (!to) return null;
  const x2 = to.position.x - bounds.minX;
  const y2 = to.position.y - bounds.minY + 42;
  return (
    <path
      className={`prototype-flow__wire${active ? ' prototype-flow__wire--active' : ''}`}
      d={`M ${x1} ${y1} C ${x1 + 56} ${y1}, ${x2 - 56} ${y2}, ${x2} ${y2}`}
      markerEnd={`url(#${markerId}-arrow)`}
    />
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
  readonly onStart: (
    nodeId: string,
    portId: string,
    event?: PointerEvent<HTMLButtonElement>
  ) => void;
  readonly onFinish: (target: PrototypeNode) => void;
  readonly onSelect: (nodeId: string) => void;
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
      <button
        type="button"
        className="prototype-flow__drop-target"
        aria-label={`Connect to ${node.label}`}
        onKeyDown={(event) => {
          if (connectorActive && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            onFinish(node);
          }
        }}
      >
        Drop target
      </button>
      <button
        type="button"
        className="prototype-flow__select"
        aria-pressed={selected}
        onClick={() => onSelect(node.id)}
      >
        {selected ? 'Selected' : 'Select'}
      </button>
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
    </article>
  );
}
