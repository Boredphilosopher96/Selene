import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent
} from 'react';

import {
  copyPrototypeNodes,
  migratePrototypeGraphViewState,
  parsePrototypeGraph,
  pastePrototypeNodes,
  removePrototypeTransition,
  upsertPrototypeTransition,
  withPrototypeGraphCompactViewState,
  type PrototypeGraph,
  type PrototypeNode,
  type PrototypeTransition
} from '@selene/core/prototype';

import './prototype-studio.css';

const kinds = [
  'navigate',
  'back',
  'set-state',
  'open-overlay',
  'close-overlay',
  'reset-flow'
] as const;
/**
 * The only card geometry contract. Graph layout and the component-local CSS
 * custom properties use these border-box values together.
 */
export const prototypeFlowCardLayout = {
  border: 1,
  borderLeft: 5,
  columns: 2,
  detailHeight: 30,
  gap: 6,
  headerHeight: 42,
  kindHeight: 13,
  actionHeight: 30,
  padding: 10,
  portGap: 8,
  portHeight: 52,
  width: 224
} as const;
const prototypeFlowBoundsPadding = { left: 48, top: 48, right: 96, bottom: 72 } as const;
// Compact Flow is a real, bounded graph reflow rather than a visual counter-scale.
// Two complete cards plus this gutter fit the compact stage at the physical port
// size declared above, so wires, cards, hit targets, and keyboard geometry all
// continue to share one coordinate system.
const prototypeFlowCompactBoundsPadding = { left: 12, top: 12, right: 12, bottom: 12 } as const;
const prototypeFlowCompactColumnGap = 12;
const prototypeFlowCompactColumns = 2;
const prototypeFlowMinimumZoom = 0.87;
const prototypeFlowMaximumZoom = 3;
const prototypeFlowZoomStep = 0.2;
const prototypeFlowPortCharactersPerLine = 6;
const prototypeFlowPortLineHeight = 15;
const prototypeFlowPortVerticalChrome = 16;
const prototypeFlowWireLabelInset = 12;
const prototypeFlowWireLabelHeight = 16;
type ConnectorStart = {
  nodeId: string;
  portId: string;
  x: number;
  y: number;
  kind?: PrototypeTransition['kind'];
};
export interface PrototypeFlowCanvasBounds {
  readonly minX: number;
  readonly minY: number;
  readonly width: number;
  readonly height: number;
}
export interface PrototypeFlowNodeExtent {
  readonly width: number;
  readonly height: number;
}

function prototypeFlowWireLabelExtent(text: string): {
  readonly width: number;
  readonly height: number;
} {
  return {
    width: Math.max(72, text.length * 6.25),
    height: prototypeFlowWireLabelHeight
  };
}
export interface PrototypeFlowWireLayout {
  readonly path: string;
  readonly label?:
    | {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
        readonly text: string;
        /** A visible attachment when collision avoidance moves a label from its wire-local slot. */
        readonly tether?:
          | {
              readonly x1: number;
              readonly y1: number;
              readonly x2: number;
              readonly y2: number;
            }
          | undefined;
      }
    | undefined;
}
export interface PrototypeFlowWireLayoutResult {
  readonly layouts: ReadonlyMap<string, PrototypeFlowWireLayout>;
  readonly work: number;
  readonly budget: number;
  readonly saturated: boolean;
}
export const prototypeFlowLabelLayoutWorkBudget = 96_000;
type LayoutRectangle = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};
type LineSegment = {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
};
type NodeDrag = {
  readonly nodeId: string;
  /** Position of this card in the currently rendered coordinate system. */
  readonly displayPosition: NodePosition;
  readonly offsetX: number;
  readonly offsetY: number;
};
type NodePosition = { readonly x: number; readonly y: number };
type SelectionBox = {
  readonly startX: number;
  readonly startY: number;
  readonly endX: number;
  readonly endY: number;
};

type PrototypeFlowCardStyle = CSSProperties & {
  readonly '--prototype-flow-card-action-height': string;
  readonly '--prototype-flow-card-border': string;
  readonly '--prototype-flow-card-border-left': string;
  readonly '--prototype-flow-card-columns': string;
  readonly '--prototype-flow-card-detail-height': string;
  readonly '--prototype-flow-card-gap': string;
  readonly '--prototype-flow-card-header-height': string;
  readonly '--prototype-flow-card-height': string;
  readonly '--prototype-flow-card-kind-height': string;
  readonly '--prototype-flow-card-padding': string;
  readonly '--prototype-flow-card-port-gap': string;
  readonly '--prototype-flow-card-port-height': string;
  readonly '--prototype-flow-card-width': string;
};

type PrototypeFlowPortStyle = CSSProperties & {
  readonly '--prototype-flow-port-height': string;
};

/**
 * Reserves visible lines for the full validated label rather than clipping a
 * semantic action. The conservative character budget also covers unbroken
 * valid labels, which CSS wraps with overflow-wrap:anywhere.
 */
export function prototypeFlowPortHeight(label: string): number {
  const lines = Math.max(1, Math.ceil(label.length / prototypeFlowPortCharactersPerLine));
  return Math.max(
    prototypeFlowCardLayout.portHeight,
    lines * prototypeFlowPortLineHeight + prototypeFlowPortVerticalChrome
  );
}

function prototypeFlowPortRowHeight(
  ports: readonly Pick<PrototypeNode['ports'][number], 'label'>[],
  row: number
): number {
  const first = row * prototypeFlowCardLayout.columns;
  return Math.max(
    ...ports
      .slice(first, first + prototypeFlowCardLayout.columns)
      .map((port) => prototypeFlowPortHeight(port.label))
  );
}

function prototypeFlowPortRowsHeight(
  ports: readonly Pick<PrototypeNode['ports'][number], 'label'>[]
): number {
  const rows = Math.ceil(ports.length / prototypeFlowCardLayout.columns);
  if (rows === 0) return 0;
  return (
    Array.from({ length: rows }, (_, row) => prototypeFlowPortRowHeight(ports, row)).reduce(
      (total, height) => total + height,
      0
    ) +
    (rows - 1) * prototypeFlowCardLayout.portGap
  );
}

function prototypeFlowCardChromeHeight(): number {
  return (
    prototypeFlowCardLayout.border * 2 +
    prototypeFlowCardLayout.padding * 2 +
    prototypeFlowCardLayout.headerHeight +
    prototypeFlowCardLayout.detailHeight +
    prototypeFlowCardLayout.actionHeight +
    prototypeFlowCardLayout.gap * 3
  );
}

/** Models the component's border-box card and fixed two-column semantic-port grid. */
export function prototypeFlowNodeExtent(
  node: Pick<PrototypeNode, 'ports'>
): PrototypeFlowNodeExtent {
  return {
    width: prototypeFlowCardLayout.width,
    height: prototypeFlowCardChromeHeight() + prototypeFlowPortRowsHeight(node.ports)
  };
}

/** Locates the actual center of one fixed-grid port within the card contract. */
export function prototypeFlowPortCenter(
  node: PrototypeNode,
  portId: string,
  bounds: Pick<PrototypeFlowCanvasBounds, 'minX' | 'minY'>
): NodePosition | undefined {
  const index = node.ports.findIndex((port) => port.id === portId);
  if (index < 0) return undefined;
  const extent = prototypeFlowNodeExtent(node);
  const contentWidth =
    extent.width -
    prototypeFlowCardLayout.borderLeft -
    prototypeFlowCardLayout.border -
    prototypeFlowCardLayout.padding * 2;
  const portWidth =
    (contentWidth - prototypeFlowCardLayout.portGap * (prototypeFlowCardLayout.columns - 1)) /
    prototypeFlowCardLayout.columns;
  const column = index % prototypeFlowCardLayout.columns;
  const row = Math.floor(index / prototypeFlowCardLayout.columns);
  const priorRowsHeight = Array.from({ length: row }, (_, currentRow) =>
    prototypeFlowPortRowHeight(node.ports, currentRow)
  ).reduce((total, height) => total + height, 0);
  const portHeight = prototypeFlowPortHeight(node.ports[index]!.label);
  return {
    x:
      node.position.x -
      bounds.minX +
      prototypeFlowCardLayout.borderLeft +
      prototypeFlowCardLayout.padding +
      column * (portWidth + prototypeFlowCardLayout.portGap) +
      portWidth / 2,
    y:
      node.position.y -
      bounds.minY +
      prototypeFlowCardLayout.border +
      prototypeFlowCardLayout.padding +
      prototypeFlowCardLayout.headerHeight +
      prototypeFlowCardLayout.gap +
      prototypeFlowCardLayout.detailHeight +
      prototypeFlowCardLayout.gap +
      prototypeFlowCardLayout.actionHeight +
      prototypeFlowCardLayout.gap +
      priorRowsHeight +
      row * prototypeFlowCardLayout.portGap +
      portHeight / 2
  };
}

function prototypeFlowCardStyle(
  node: PrototypeNode,
  bounds: Pick<PrototypeFlowCanvasBounds, 'minX' | 'minY'>
): PrototypeFlowCardStyle {
  const extent = prototypeFlowNodeExtent(node);
  return {
    '--prototype-flow-card-action-height': `${prototypeFlowCardLayout.actionHeight}px`,
    '--prototype-flow-card-border': `${prototypeFlowCardLayout.border}px`,
    '--prototype-flow-card-border-left': `${prototypeFlowCardLayout.borderLeft}px`,
    '--prototype-flow-card-columns': `${prototypeFlowCardLayout.columns}`,
    '--prototype-flow-card-detail-height': `${prototypeFlowCardLayout.detailHeight}px`,
    '--prototype-flow-card-gap': `${prototypeFlowCardLayout.gap}px`,
    '--prototype-flow-card-header-height': `${prototypeFlowCardLayout.headerHeight}px`,
    '--prototype-flow-card-height': `${extent.height}px`,
    '--prototype-flow-card-kind-height': `${prototypeFlowCardLayout.kindHeight}px`,
    '--prototype-flow-card-padding': `${prototypeFlowCardLayout.padding}px`,
    '--prototype-flow-card-port-gap': `${prototypeFlowCardLayout.portGap}px`,
    '--prototype-flow-card-port-height': `${prototypeFlowCardLayout.portHeight}px`,
    '--prototype-flow-card-width': `${extent.width}px`,
    left: node.position.x - bounds.minX,
    top: node.position.y - bounds.minY
  };
}

function prototypeFlowPortStyle(label: string): PrototypeFlowPortStyle {
  return { '--prototype-flow-port-height': `${prototypeFlowPortHeight(label)}px` };
}

/**
 * Includes every full card and fixed canvas breathing room. Wire labels are
 * deliberately not inputs: allowing label text to grow the canvas would make
 * an otherwise impossible label renderable through a circular bounds change.
 */
function prototypeFlowGraphBoundsWithLayout(
  nodes: readonly PrototypeNode[],
  padding: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  },
  minimum: { readonly width: number; readonly height: number }
): PrototypeFlowCanvasBounds {
  const first = nodes[0];
  if (!first) return { minX: 0, minY: 0, width: minimum.width, height: minimum.height };
  let minX = first.position.x;
  let minY = first.position.y;
  let maxX = first.position.x + prototypeFlowNodeExtent(first).width;
  let maxY = first.position.y + prototypeFlowNodeExtent(first).height;
  for (const node of nodes.slice(1)) {
    const extent = prototypeFlowNodeExtent(node);
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + extent.width);
    maxY = Math.max(maxY, node.position.y + extent.height);
  }
  const boundedMinX = minX - padding.left;
  const boundedMinY = minY - padding.top;
  return {
    minX: boundedMinX,
    minY: boundedMinY,
    width: Math.max(minimum.width, maxX + padding.right - boundedMinX),
    height: Math.max(minimum.height, maxY + padding.bottom - boundedMinY)
  };
}

export function prototypeFlowGraphBounds(
  nodes: readonly PrototypeNode[]
): PrototypeFlowCanvasBounds {
  return prototypeFlowGraphBoundsWithLayout(nodes, prototypeFlowBoundsPadding, {
    width: 840,
    height: 520
  });
}

/**
 * Orders a compact graph by reachable transition topology before retaining any
 * disconnected cards in their source order. This keeps the first actionable
 * path legible while remaining deterministic for cycles and incomplete graphs.
 */
function prototypeFlowCompactNodeOrder(graph: PrototypeGraph): readonly PrototypeNode[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const ordered: PrototypeNode[] = [];
  const queue = [graph.initialNodeId];
  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId || seen.has(nodeId)) continue;
    const node = byId.get(nodeId);
    if (!node) continue;
    seen.add(nodeId);
    ordered.push(node);
    for (const transition of graph.transitions) {
      if (transition.from.nodeId !== nodeId || !('to' in transition)) continue;
      if (!seen.has(transition.to.nodeId)) queue.push(transition.to.nodeId);
    }
  }
  for (const node of graph.nodes) if (!seen.has(node.id)) ordered.push(node);
  return ordered;
}

/**
 * The core parser admits only a complete, exact-node-set view-state map. Keep
 * this conversion local and total so every visual consumer uses the same saved
 * compact coordinates after a remount.
 */
function prototypeFlowPersistedCompactLayout(
  graph: PrototypeGraph
): ReadonlyMap<string, NodePosition> | undefined {
  return graph.viewState
    ? new Map(
        graph.nodes.map((node) => {
          const position = graph.viewState!.compactNodePositions[node.id]!;
          return [node.id, { x: position.x, y: position.y }];
        })
      )
    : undefined;
}

/**
 * Produces the compact coordinate system used by cards, wires, minimap and
 * hit-testing. A committed compact layout is part of the parsed graph state;
 * otherwise the initial reflow is a deterministic topology projection.
 */
function prototypeFlowCompactGraph(graph: PrototypeGraph): PrototypeGraph {
  const persisted = prototypeFlowPersistedCompactLayout(graph);
  if (persisted)
    return {
      ...graph,
      nodes: graph.nodes.map((node) => ({
        ...node,
        position: persisted.get(node.id) ?? node.position
      }))
    };
  const positions = new Map<string, NodePosition>();
  const ordered = prototypeFlowCompactNodeOrder(graph);
  let rowTop = 0;
  for (let start = 0; start < ordered.length; start += prototypeFlowCompactColumns) {
    const row = ordered.slice(start, start + prototypeFlowCompactColumns);
    const rowHeight = Math.max(...row.map((node) => prototypeFlowNodeExtent(node).height));
    row.forEach((node, column) => {
      positions.set(node.id, {
        x: column * (prototypeFlowCardLayout.width + prototypeFlowCompactColumnGap),
        y: rowTop
      });
    });
    rowTop += rowHeight + prototypeFlowCompactColumnGap;
  }
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      position: positions.get(node.id) ?? node.position
    }))
  };
}

function prototypeFlowCompactGraphBounds(
  nodes: readonly PrototypeNode[]
): PrototypeFlowCanvasBounds {
  return prototypeFlowGraphBoundsWithLayout(nodes, prototypeFlowCompactBoundsPadding, {
    width: prototypeFlowCompactBoundsPadding.left + prototypeFlowCompactBoundsPadding.right + 1,
    height: prototypeFlowCompactBoundsPadding.top + prototypeFlowCompactBoundsPadding.bottom + 1
  });
}

/**
 * Computes an actual full-card-graph fit. Visual wire labels are not fit
 * geometry: impossible labels stay suppressed rather than changing the canvas
 * that determines whether they can render. Manual zoom controls retain their
 * readability floor; Fit deliberately does not, because a Fit command must
 * not leave committed graph geometry clipped at scroll origin.
 */
export function fitPrototypeFlowViewport(
  viewport: Pick<PrototypeViewportGeometry, 'width' | 'height'>,
  bounds: PrototypeFlowCanvasBounds
): { readonly zoom: number; readonly pan: NodePosition } {
  // Graph bounds already include their own breathing room. On a desktop-sized
  // canvas, spending another 24px on each edge left the fitted graph visibly
  // undersized after the workspace visual reset. Retain the compact inset where
  // touch/edge separation matters, while allowing the wide professional canvas
  // to use its actual client box.
  const padding = viewport.width < 680 ? 16 : 0;
  const availableWidth = Math.max(0, viewport.width - padding * 2);
  const availableHeight = Math.max(0, viewport.height - padding * 2);
  const zoom = Math.min(
    prototypeFlowMaximumZoom,
    Math.min(availableWidth / bounds.width, availableHeight / bounds.height)
  );
  return {
    zoom,
    pan: {
      x: Math.round((viewport.width - bounds.width * zoom) / 2),
      y: Math.round((viewport.height - bounds.height * zoom) / 2)
    }
  };
}

/**
 * Reserves layout space for the translated rendered plane. Fit centres the
 * plane with positive pan; omitting that pan from the normal-flow box creates
 * a horizontal scrollbar after measurement, which then steals client height.
 */
export function prototypeFlowCanvasSpaceExtent(
  bounds: Pick<PrototypeFlowCanvasBounds, 'width' | 'height'>,
  zoom: number,
  pan: NodePosition
): { readonly width: number; readonly height: number } {
  return {
    width: Math.max(1, bounds.width * zoom + Math.max(0, pan.x)),
    height: Math.max(1, bounds.height * zoom + Math.max(0, pan.y))
  };
}

/** Keeps a fitted sub-floor zoom continuous until it reaches the manual floor. */
export function nextPrototypeFlowWheelZoom(current: number, deltaY: number): number {
  const next = Math.round((current - deltaY * 0.001) * 100) / 100;
  if (current < prototypeFlowMinimumZoom) {
    if (next < current) return current;
    return Math.min(prototypeFlowMinimumZoom, next);
  }
  return Math.max(prototypeFlowMinimumZoom, Math.min(prototypeFlowMaximumZoom, next));
}

/** Projects a complete card extent, not merely its origin, into the minimap. */
export function prototypeFlowOverviewNodeRect(
  node: PrototypeNode,
  bounds: PrototypeFlowCanvasBounds
): {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
} {
  const extent = prototypeFlowNodeExtent(node);
  return {
    left: ((node.position.x - bounds.minX) / bounds.width) * 100,
    top: ((node.position.y - bounds.minY) / bounds.height) * 100,
    width: (extent.width / bounds.width) * 100,
    height: (extent.height / bounds.height) * 100
  };
}
export interface PrototypeViewportGeometry {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly scrollLeft: number;
  readonly scrollTop: number;
}
export interface PrototypeFlowHistory {
  readonly past: readonly PrototypeGraph[];
  readonly future: readonly PrototypeGraph[];
}
export type PrototypeFlowHistoryOperation =
  | { readonly type: 'commit'; readonly before: PrototypeGraph }
  | { readonly type: 'undo'; readonly current: PrototypeGraph }
  | { readonly type: 'redo'; readonly current: PrototypeGraph };

/**
 * Keeps positioning as an immutable, schema-checked portable graph mutation.
 * The owning callback is the only persistence boundary.
 */
export function movePrototypeGraphNode(
  graph: PrototypeGraph,
  nodeId: string,
  position: NodePosition
): PrototypeGraph {
  return parsePrototypeGraph({
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === nodeId ? { ...node, position: { x: position.x, y: position.y } } : node
    )
  });
}

/** Returns the cards touched by a graph-space selection rectangle in stable graph order. */
export function selectPrototypeGraphNodes(
  graph: PrototypeGraph,
  box: SelectionBox
): readonly string[] {
  const left = Math.min(box.startX, box.endX);
  const right = Math.max(box.startX, box.endX);
  const top = Math.min(box.startY, box.endY);
  const bottom = Math.max(box.startY, box.endY);
  return graph.nodes
    .filter(
      (node) =>
        node.position.x < right &&
        node.position.x + prototypeFlowNodeExtent(node).width > left &&
        node.position.y < bottom &&
        node.position.y + prototypeFlowNodeExtent(node).height > top
    )
    .map((node) => node.id);
}

/** Converts a pointer in the scrolled viewport into portable graph coordinates. */
export function graphCanvasPosition(
  client: { readonly x: number; readonly y: number },
  viewport: PrototypeViewportGeometry,
  pan: NodePosition,
  zoom: number,
  bounds: Pick<PrototypeFlowCanvasBounds, 'minX' | 'minY'>
): NodePosition {
  return {
    x: (client.x - viewport.left + viewport.scrollLeft - pan.x) / zoom + bounds.minX,
    y: (client.y - viewport.top + viewport.scrollTop - pan.y) / zoom + bounds.minY
  };
}

/** Converts one exact graph-space pointer coordinate into a node origin during a drag. */
export function prototypeNodeDragPosition(
  pointer: NodePosition,
  drag: Pick<NodeDrag, 'offsetX' | 'offsetY'>
): NodePosition {
  return {
    x: Math.max(-100_000, Math.min(100_000, Math.round(pointer.x - drag.offsetX))),
    y: Math.max(-100_000, Math.min(100_000, Math.round(pointer.y - drag.offsetY)))
  };
}

/** Projects the actual scrolled viewport into the minimap's graph-space percentage rectangle. */
export function graphOverviewViewport(
  viewport: Pick<PrototypeViewportGeometry, 'width' | 'height' | 'scrollLeft' | 'scrollTop'>,
  pan: NodePosition,
  zoom: number,
  bounds: PrototypeFlowCanvasBounds
): {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
} {
  const width = Math.max(2, Math.min(100, (viewport.width / zoom / bounds.width) * 100));
  const height = Math.max(2, Math.min(100, (viewport.height / zoom / bounds.height) * 100));
  const left = ((viewport.scrollLeft - pan.x) / zoom / bounds.width) * 100;
  const top = ((viewport.scrollTop - pan.y) / zoom / bounds.height) * 100;
  return {
    left: Math.max(0, Math.min(100 - width, left)),
    top: Math.max(0, Math.min(100 - height, top)),
    width,
    height
  };
}

/** Applies a history operation only after its owning persistence callback settles successfully. */
export function settlePrototypeFlowHistory(
  history: PrototypeFlowHistory,
  operation: PrototypeFlowHistoryOperation,
  persisted: boolean
): PrototypeFlowHistory {
  if (!persisted) return history;
  if (operation.type === 'commit') return { past: [...history.past, operation.before], future: [] };
  if (operation.type === 'undo')
    return { past: history.past.slice(0, -1), future: [operation.current, ...history.future] };
  return { past: [...history.past, operation.current], future: history.future.slice(1) };
}

/** A cancelled capture must never leave an action-port connector armed. */
export function cancelPrototypeConnectorDrag(_connector: ConnectorStart | undefined): undefined {
  return undefined;
}

/** Computes the next focus target for a two-or-more-control modal dialog trap. */
export function nextPrototypeDialogFocusIndex(
  controlCount: number,
  activeIndex: number,
  backwards: boolean
): number {
  if (controlCount <= 0) return -1;
  if (backwards && activeIndex <= 0) return controlCount - 1;
  if (!backwards && activeIndex >= controlCount - 1) return 0;
  return activeIndex;
}

/** Defers callback invocation so synchronous host failures settle through the same rejection path. */
export function invokePrototypeFlowCallback(callback: () => void | Promise<void>): Promise<void> {
  return Promise.resolve().then(callback);
}

export function prototypeFlowModalIsolation(active: boolean): {
  readonly active: boolean;
  readonly backgroundInert: boolean;
} {
  return { active, backgroundInert: active };
}

export interface PrototypeRunGate {
  readonly nextToken: number;
  readonly activeToken?: number;
}
export interface PrototypeRunGateStart {
  readonly token: number;
  readonly gate: PrototypeRunGate;
}

/** A renderer-owned single-flight gate; completion is valid only for its active token. */
export function beginPrototypeRun(gate: PrototypeRunGate): PrototypeRunGateStart | undefined {
  if (gate.activeToken !== undefined) return undefined;
  const token = gate.nextToken + 1;
  return { token, gate: { nextToken: token, activeToken: token } };
}

export function settlePrototypeRun(
  gate: PrototypeRunGate,
  token: number
): { readonly current: boolean; readonly gate: PrototypeRunGate } {
  if (gate.activeToken !== token) return { current: false, gate };
  return { current: true, gate: { nextToken: gate.nextToken } };
}

function rectanglesOverlap(left: LayoutRectangle, right: LayoutRectangle): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

function rectangleIntersectsSegment(rectangle: LayoutRectangle, segment: LineSegment): boolean {
  if (segment.y1 === segment.y2)
    return (
      segment.y1 >= rectangle.y &&
      segment.y1 <= rectangle.y + rectangle.height &&
      Math.max(segment.x1, segment.x2) >= rectangle.x &&
      Math.min(segment.x1, segment.x2) <= rectangle.x + rectangle.width
    );
  if (segment.x1 === segment.x2)
    return (
      segment.x1 >= rectangle.x &&
      segment.x1 <= rectangle.x + rectangle.width &&
      Math.max(segment.y1, segment.y2) >= rectangle.y &&
      Math.min(segment.y1, segment.y2) <= rectangle.y + rectangle.height
    );
  return false;
}

function transitionText(
  transition: PrototypeTransition,
  source?: Pick<PrototypeNode, 'ports'>
): string {
  const portLabel = source?.ports.find((port) => port.id === transition.from.portId)?.label;
  return `${portLabel ?? `${transition.from.nodeId}.${transition.from.portId}`} · ${transition.kind}`;
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
 * Routes edges in stable ID order and places labels through bounded local then
 * global collision-free searches. One graph-wide geometry-work budget caps
 * the schema maximum without timing assumptions; exhausted labels stay named
 * SVG edges but omit only their visual text. This deliberately uses only graph
 * data, making visual output reproducible across browser runs and independent
 * of DOM measurement.
 */
export function layoutPrototypeWiresWithStats(
  graph: PrototypeGraph,
  bounds: PrototypeFlowCanvasBounds
): PrototypeFlowWireLayoutResult {
  const transitions = [...graph.transitions].sort((left, right) => left.id.localeCompare(right.id));
  const occupied: LayoutRectangle[] = graph.nodes.map((node) => ({
    x: node.position.x - bounds.minX - 8,
    y: node.position.y - bounds.minY - 8,
    width: prototypeFlowNodeExtent(node).width + 16,
    height: prototypeFlowNodeExtent(node).height + 16
  }));
  const layouts = new Map<string, PrototypeFlowWireLayout>();
  const routes: Array<{
    readonly id: string;
    readonly path: string;
    readonly label: { readonly x: number; readonly y: number; readonly text: string };
    readonly segments: readonly LineSegment[];
  }> = [];
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, PrototypeTransition[]>();
  const laneByTransitionId = new Map<string, number>();
  let work = 0;
  let saturated = false;
  for (const transition of transitions) {
    const key = transition.from.nodeId;
    const group = outgoing.get(key);
    if (group) {
      laneByTransitionId.set(transition.id, group.length);
      group.push(transition);
    } else {
      outgoing.set(key, [transition]);
      laneByTransitionId.set(transition.id, 0);
    }
  }

  const consumeWork = (): boolean => {
    if (work >= prototypeFlowLabelLayoutWorkBudget) {
      saturated = true;
      return false;
    }
    work += 1;
    return true;
  };

  function label(x: number, y: number, text: string, routeId: string) {
    if (saturated) return undefined;
    const { width, height } = prototypeFlowWireLabelExtent(text);
    const inset = prototypeFlowWireLabelInset;
    if (width + inset * 2 > bounds.width || height + inset * 2 > bounds.height) return undefined;
    const clampX = (value: number) =>
      Math.max(inset, Math.min(value, bounds.width - width - inset));
    const clampBaseline = (value: number) =>
      Math.max(height + inset, Math.min(value, bounds.height - inset));
    const preferredX = clampX(x);
    const preferredBaseline = clampBaseline(y);
    const seen = new Set<string>();
    const addCandidate = (
      candidates: Array<{ readonly x: number; readonly baseline: number }>,
      limit: number,
      candidateX: number,
      candidateBaseline: number
    ) => {
      if (candidates.length >= limit) return;
      const nextX = clampX(candidateX);
      const nextBaseline = clampBaseline(candidateBaseline);
      const key = `${nextX}:${nextBaseline}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({ x: nextX, baseline: nextBaseline });
    };
    const localCandidates: Array<{ readonly x: number; readonly baseline: number }> = [];
    for (let vertical = 0; vertical <= 8; vertical += 1) {
      const verticalOffsets = vertical === 0 ? [0] : [vertical * 24, -vertical * 24];
      for (let horizontal = 0; horizontal <= 8; horizontal += 1) {
        const horizontalOffsets = horizontal === 0 ? [0] : [horizontal * 24, -horizontal * 24];
        for (const verticalOffset of verticalOffsets)
          for (const horizontalOffset of horizontalOffsets)
            addCandidate(
              localCandidates,
              256,
              preferredX + horizontalOffset,
              preferredBaseline + verticalOffset
            );
      }
    }
    const globalCandidates: Array<{ readonly x: number; readonly baseline: number }> = [];
    for (let row = 0; row < 16; row += 1)
      for (let column = 0; column < 16; column += 1)
        addCandidate(
          globalCandidates,
          256,
          inset + ((bounds.width - width - inset * 2) * column) / 15,
          height + inset + ((bounds.height - height - inset * 2) * row) / 15
        );
    // A broad search must still be a route-local search first. Sorting the
    // bounded grid by distance avoids jumping to an unrelated far-right slot
    // when the nearest clear lane is below the obstructed local region.
    globalCandidates.sort((left, right) => {
      const leftDistance =
        Math.abs(left.x - preferredX) + Math.abs(left.baseline - preferredBaseline);
      const rightDistance =
        Math.abs(right.x - preferredX) + Math.abs(right.baseline - preferredBaseline);
      return leftDistance - rightDistance || left.baseline - right.baseline || left.x - right.x;
    });
    const findCollisionFree = (
      candidates: readonly { readonly x: number; readonly baseline: number }[]
    ) => {
      for (const { x: candidateX, baseline } of candidates) {
        if (!consumeWork()) return undefined;
        const rectangle = { x: candidateX, y: baseline - height, width, height };
        let collision = false;
        for (const item of occupied) {
          if (!consumeWork()) return undefined;
          if (rectanglesOverlap(rectangle, item)) {
            collision = true;
            break;
          }
        }
        if (collision) continue;
        for (const route of routes) {
          if (route.id === routeId) continue;
          for (const segment of route.segments) {
            if (!consumeWork()) return undefined;
            if (rectangleIntersectsSegment(rectangle, segment)) {
              collision = true;
              break;
            }
          }
          if (collision) break;
        }
        if (!collision) return { x: candidateX, baseline };
      }
      return undefined;
    };
    const position = findCollisionFree(localCandidates) ?? findCollisionFree(globalCandidates);
    // A hidden label is safer than a misleading overlap; the SVG edge and its
    // accessible name remain available even when no safe label slot exists.
    if (!position) return undefined;
    const nextX = position.x;
    const nextBaseline = position.baseline;
    occupied.push({ x: nextX, y: nextBaseline - height, width, height });
    const movedFromWireLocalSlot =
      Math.abs(nextX - preferredX) + Math.abs(nextBaseline - preferredBaseline) > 32;
    return {
      x: nextX,
      y: nextBaseline,
      width,
      height,
      text,
      ...(movedFromWireLocalSlot
        ? {
            tether: {
              x1: preferredX + width / 2,
              y1: preferredBaseline - height / 2,
              x2: nextX + width / 2,
              y2: nextBaseline - height / 2
            }
          }
        : {})
    };
  }

  for (const transition of transitions) {
    const from = nodeById.get(transition.from.nodeId);
    if (!from) continue;
    const sourceCenter = prototypeFlowPortCenter(from, transition.from.portId, bounds);
    if (!sourceCenter) continue;
    const x1 = sourceCenter.x;
    const y1 = sourceCenter.y;
    const lane = laneByTransitionId.get(transition.id) ?? 0;
    const text = transitionText(transition, from);

    if (!('to' in transition)) {
      const routeX = x1 + 52 + lane * 26;
      const routeY = y1 - 48 - lane * 24;
      const segments = [
        { x1, y1, x2: routeX, y2: y1 },
        { x1: routeX, y1, x2: routeX, y2: routeY },
        { x1: routeX, y1: routeY, x2: x1 + 8, y2: routeY }
      ];
      routes.push({
        id: transition.id,
        path: `M ${x1} ${y1} H ${routeX} V ${routeY} H ${x1 + 8}`,
        label: { x: routeX + 8, y: routeY - 10, text },
        segments
      });
      continue;
    }

    const to = nodeById.get(transition.to.nodeId);
    if (!to) continue;
    const x2 = to.position.x - bounds.minX;
    const y2 = to.position.y - bounds.minY + prototypeFlowNodeExtent(to).height / 2;
    if (x2 > x1 + 48) {
      const routeX = Math.round((x1 + x2) / 2) + lane * 22;
      const segments = [
        { x1, y1, x2: routeX, y2: y1 },
        { x1: routeX, y1, x2: routeX, y2 },
        { x1: routeX, y1: y2, x2, y2 }
      ];
      routes.push({
        id: transition.id,
        path: `M ${x1} ${y1} H ${routeX} V ${y2} H ${x2}`,
        label: { x: routeX + 8, y: Math.min(y1, y2) - 10, text },
        segments
      });
    } else {
      const routeX = x1 + 56 + lane * 26;
      const routeY = Math.min(y1, y2) - 54 - lane * 24;
      const segments = [
        { x1, y1, x2: routeX, y2: y1 },
        { x1: routeX, y1, x2: routeX, y2: routeY },
        { x1: routeX, y1: routeY, x2: x2 - 28, y2: routeY },
        { x1: x2 - 28, y1: routeY, x2: x2 - 28, y2 },
        { x1: x2 - 28, y1: y2, x2, y2 }
      ];
      routes.push({
        id: transition.id,
        path: `M ${x1} ${y1} H ${routeX} V ${routeY} H ${x2 - 28} V ${y2} H ${x2}`,
        label: { x: routeX + 8, y: routeY - 10, text },
        segments
      });
    }
  }
  for (const route of routes) {
    layouts.set(route.id, {
      path: route.path,
      label: label(route.label.x, route.label.y, route.label.text, route.id)
    });
  }
  return {
    layouts,
    work,
    budget: prototypeFlowLabelLayoutWorkBudget,
    saturated
  };
}

export function layoutPrototypeWires(
  graph: PrototypeGraph,
  bounds: PrototypeFlowCanvasBounds
): ReadonlyMap<string, PrototypeFlowWireLayout> {
  return layoutPrototypeWiresWithStats(graph, bounds).layouts;
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
  readonly onGraphChange?: ((graph: PrototypeGraph) => void | Promise<void>) | undefined;
  /** Optional host callback that switches to the executable committed graph. */
  readonly onRunCommitted?: (() => void | Promise<void>) | undefined;
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
  onRunCommitted,
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
  const [history, setHistory] = useState<PrototypeFlowHistory>({ past: [], future: [] });
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedTransitionId, setSelectedTransitionId] = useState<string>();
  const [nodeDrag, setNodeDrag] = useState<NodeDrag>();
  const [dragPosition, setDragPosition] = useState<NodePosition>();
  const [selectionBox, setSelectionBox] = useState<SelectionBox>();
  const [commitPending, setCommitPending] = useState(false);
  const [runPending, setRunPending] = useState(false);
  const [interactionStatus, setInteractionStatus] = useState('Ready to edit the saved graph.');
  const [clipboard, setClipboard] = useState('');
  const [error, setError] = useState<string>();
  const [transitionSearch, setTransitionSearch] = useState('');
  const [pendingDelete, setPendingDelete] = useState<PrototypeTransition>();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorFitEpoch, setInspectorFitEpoch] = useState(0);
  const [viewportGeometry, setViewportGeometry] = useState<PrototypeViewportGeometry>({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    scrollLeft: 0,
    scrollTop: 0
  });
  const fittedViewport = useRef<
    | {
        readonly structureKey: string;
        readonly compact: boolean;
        readonly height: number;
        readonly width: number;
      }
    | undefined
  >(undefined);
  // A deferred geometry fit must not outlive a later explicit Fit or zoom action.
  const pendingAutomaticFitFrame = useRef<number | undefined>(undefined);
  const runGate = useRef<PrototypeRunGate>({ nextToken: 0 });
  const deleteDialogRef = useRef<HTMLElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const deleteInvokingRef = useRef<HTMLElement | null>(null);
  const nodeDragRef = useRef<NodeDrag | undefined>(undefined);

  const compact = viewportGeometry.width > 0 && viewportGeometry.width < 680;
  const compactGraph = useMemo(
    () => (compact ? prototypeFlowCompactGraph(graph) : graph),
    [compact, graph]
  );
  const displayGraph = useMemo(
    () =>
      nodeDrag && dragPosition
        ? {
            ...compactGraph,
            nodes: compactGraph.nodes.map((node) =>
              node.id === nodeDrag.nodeId ? { ...node, position: dragPosition } : node
            )
          }
        : compactGraph,
    [compactGraph, dragPosition, nodeDrag]
  );
  const source = graph.nodes.find((node) => node.id === sourceNodeId);
  // Position is deliberately absent: a pointer drag changes graph bounds, but
  // must never be interpreted as a request to reset the user's zoom or pan.
  // Fields that can change card extent or compact topology remain included.
  const fitStructureKey = useMemo(
    () =>
      JSON.stringify({
        initialNodeId: graph.initialNodeId,
        nodes: graph.nodes.map((node) => [
          node.id,
          node.ports.map((port) => [port.id, port.label])
        ]),
        transitions: graph.transitions.map((transition) => [
          transition.id,
          transition.kind,
          transition.from.nodeId,
          transition.from.portId,
          'to' in transition ? transition.to.nodeId : undefined
        ])
      }),
    [graph.initialNodeId, graph.nodes, graph.transitions]
  );
  const targets = useMemo(() => supportedTargets(graph, kind), [graph, kind]);
  const bounds = useMemo(
    () =>
      compact
        ? prototypeFlowCompactGraphBounds(displayGraph.nodes)
        : prototypeFlowGraphBounds(displayGraph.nodes),
    [compact, displayGraph.nodes]
  );
  const wireLayouts = useMemo(
    () => layoutPrototypeWires(displayGraph, bounds),
    [bounds, displayGraph]
  );
  const overviewViewport = useMemo(
    () => graphOverviewViewport(viewportGeometry, pan, zoom, bounds),
    [bounds, pan, viewportGeometry, zoom]
  );
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
  const selectedTransition = graph.transitions.find((item) => item.id === selectedTransitionId);
  const selectedNode = graph.nodes.find((item) => item.id === selectedNodeIds[0]);
  const canvasSpace = useMemo(
    () => prototypeFlowCanvasSpaceExtent(bounds, zoom, pan),
    [bounds, pan, zoom]
  );

  function fitToView() {
    const element = viewport.current;
    if (!element) return;
    // Fit must target the scrollable client box, not the border-box rect. A
    // native horizontal scrollbar can consume height after layout; using the
    // rect would then place the fitted plane underneath the scrollbar.
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const borderWidth =
      Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.borderRightWidth);
    const borderHeight =
      Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
    // clientWidth/clientHeight are integer CSSOM values. Use the smaller
    // fractional painted interior, rounded down, so device-scale rounding and
    // a native scrollbar cannot make the transformed plane exceed its client box.
    const fit = fitPrototypeFlowViewport(
      {
        width: Math.max(0, Math.floor(Math.min(element.clientWidth, rect.width - borderWidth))),
        height: Math.max(0, Math.floor(Math.min(element.clientHeight, rect.height - borderHeight)))
      },
      bounds
    );
    setZoom(fit.zoom);
    setPan(fit.pan);
  }

  function cancelPendingAutomaticFit() {
    const frame = pendingAutomaticFitFrame.current;
    if (frame === undefined) return;
    cancelAnimationFrame(frame);
    pendingAutomaticFitFrame.current = undefined;
  }

  function fitToViewFromControl() {
    cancelPendingAutomaticFit();
    fitToView();
  }

  function updateZoomFromControl(update: (current: number) => number) {
    cancelPendingAutomaticFit();
    setZoom(update);
  }

  function syncViewportGeometry() {
    const element = viewport.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const next = {
      left: rect.left,
      top: rect.top,
      width: element.clientWidth,
      height: element.clientHeight,
      scrollLeft: element.scrollLeft,
      scrollTop: element.scrollTop
    };
    setViewportGeometry((current) =>
      current.left === next.left &&
      current.top === next.top &&
      current.width === next.width &&
      current.height === next.height &&
      current.scrollLeft === next.scrollLeft &&
      current.scrollTop === next.scrollTop
        ? current
        : next
    );
  }

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const width = element.clientWidth;
    const height = element.clientHeight;
    if (!width || !height) return;
    const isCompactViewport = width < 680;
    const current = fittedViewport.current;
    if (
      current?.structureKey === fitStructureKey &&
      current.compact === isCompactViewport &&
      current.height === height &&
      current.width === width
    )
      return;
    fittedViewport.current = {
      structureKey: fitStructureKey,
      compact: isCompactViewport,
      height,
      width
    };
    fitToView();
  }, [compact, fitStructureKey, viewportGeometry.height, viewportGeometry.width]);

  // The stage's final client box can settle one paint after a workspace or
  // stylesheet transition. Refit from that measured box so an initially
  // mounted desktop canvas does not retain a stale, visibly undersized scale.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (pendingAutomaticFitFrame.current !== frame) return;
      pendingAutomaticFitFrame.current = undefined;
      fitToView();
    });
    pendingAutomaticFitFrame.current = frame;
    return () => {
      cancelAnimationFrame(frame);
      if (pendingAutomaticFitFrame.current === frame) pendingAutomaticFitFrame.current = undefined;
    };
  }, [fitStructureKey, inspectorFitEpoch, viewportGeometry.height, viewportGeometry.width]);

  useLayoutEffect(() => {
    syncViewportGeometry();
  }, [pan, zoom]);

  useEffect(() => {
    if (!pendingDelete) return;
    const frame = requestAnimationFrame(() => deleteCancelRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [pendingDelete]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(syncViewportGeometry);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (source?.ports.some((port) => port.id === portId)) return;
    setPortId(source?.ports[0]?.id ?? '');
  }, [portId, source]);

  useEffect(() => {
    if (targets.some((node) => node.id === targetNodeId)) return;
    setTargetNodeId(targets[0]?.id ?? '');
  }, [targetNodeId, targets]);

  useEffect(() => {
    setInspectorOpen(selectedTransition !== undefined || selectedNode !== undefined);
  }, [selectedNode?.id, selectedTransition?.id]);

  function commit(next: PrototypeGraph, successMessage: string, onSaved?: () => void) {
    if (readOnly || !onGraphChange) return;
    if (commitPending) {
      setInteractionStatus('Wait for the current graph change to finish saving.');
      return;
    }
    setCommitPending(true);
    setInteractionStatus('Saving graph change…');
    void invokePrototypeFlowCallback(() => onGraphChange(next)).then(
      () => {
        setHistory((current) =>
          settlePrototypeFlowHistory(current, { type: 'commit', before: graph }, true)
        );
        onSaved?.();
        setCommitPending(false);
        setInteractionStatus(successMessage);
      },
      () => {
        setHistory((current) =>
          settlePrototypeFlowHistory(current, { type: 'commit', before: graph }, false)
        );
        setCommitPending(false);
        setInteractionStatus(
          'Graph change was not saved. The visible graph remains the committed revision.'
        );
      }
    );
  }

  /**
   * Source positions remain the host-owned wide-layout authority. Once a
   * compact card moves, its complete compact coordinate map is persisted in
   * the versioned graph view-state contract, so remount and resize cannot
   * restore a session-only offset or detach wires from cards.
   */
  function moveGraphNodeWithCompactLayout(
    nodeId: string,
    sourcePosition: NodePosition,
    displayPosition: NodePosition
  ): PrototypeGraph {
    const next = movePrototypeGraphNode(graph, nodeId, sourcePosition);
    if (compact) {
      const positions = new Map(displayGraph.nodes.map((node) => [node.id, node.position]));
      positions.set(nodeId, displayPosition);
      const compactNodePositions = Object.fromEntries(positions);
      return graph.viewState
        ? withPrototypeGraphCompactViewState(next, compactNodePositions)
        : migratePrototypeGraphViewState(next, compactNodePositions);
    }
    const persisted = prototypeFlowPersistedCompactLayout(graph);
    if (!persisted) return next;
    const original = graph.nodes.find((node) => node.id === nodeId);
    const compactPosition = persisted.get(nodeId);
    if (!original || !compactPosition) return next;
    const compactPositions = new Map(persisted);
    compactPositions.set(nodeId, {
      x: compactPosition.x + sourcePosition.x - original.position.x,
      y: compactPosition.y + sourcePosition.y - original.position.y
    });
    return withPrototypeGraphCompactViewState(next, Object.fromEntries(compactPositions));
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
      commit(
        upsertPrototypeTransition(graph, transition),
        'Connection saved to the committed graph.',
        () => {
          selectTransition(transition);
        }
      );
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
    commit(
      removePrototypeTransition(graph, transition.id),
      'Edge deleted from the committed graph.'
    );
    if (editingId === transition.id) setEditingId(undefined);
  }

  function startConnector(
    nodeId: string,
    nextPortId: string,
    event?: PointerEvent<HTMLButtonElement>,
    transitionKind?: PrototypeTransition['kind']
  ) {
    if (readOnly) return;
    event?.stopPropagation();
    if (event) event.currentTarget.setPointerCapture(event.pointerId);
    // The connector must begin at the same compact coordinate as its rendered
    // port. Source graph positions stay host-owned but are not visual geometry
    // while compact topology reflow is active.
    const node = displayGraph.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return;
    const sourceCenter = prototypeFlowPortCenter(node, nextPortId, bounds);
    if (!sourceCenter) return;
    setSourceNodeId(nodeId);
    setPortId(nextPortId);
    if (transitionKind === undefined) setEditingId(undefined);
    setConnector({
      nodeId,
      portId: nextPortId,
      x: sourceCenter.x,
      y: sourceCenter.y,
      ...(transitionKind === undefined ? {} : { kind: transitionKind })
    });
  }

  function canvasPosition(event: PointerEvent<HTMLElement>): NodePosition | undefined {
    const element = viewport.current;
    if (!element) return undefined;
    const rect = element.getBoundingClientRect();
    return graphCanvasPosition(
      { x: event.clientX, y: event.clientY },
      {
        left: rect.left,
        top: rect.top,
        width: element.clientWidth,
        height: element.clientHeight,
        scrollLeft: element.scrollLeft,
        scrollTop: element.scrollTop
      },
      pan,
      zoom,
      bounds
    );
  }

  function beginNodeDrag(node: PrototypeNode, event: PointerEvent<HTMLElement>) {
    if (readOnly || (event.target as Element).closest('button, input, select')) return;
    const position = canvasPosition(event);
    if (!position) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedTransitionId(undefined);
    setSelectedNodeIds([node.id]);
    const nextDrag = {
      nodeId: node.id,
      displayPosition: node.position,
      offsetX: position.x - node.position.x,
      offsetY: position.y - node.position.y
    };
    nodeDragRef.current = nextDrag;
    setNodeDrag(nextDrag);
    setDragPosition(node.position);
  }

  function updateNodeDrag(event: PointerEvent<HTMLElement>) {
    const currentDrag = nodeDragRef.current;
    if (!currentDrag) return;
    const position = canvasPosition(event);
    if (!position) return;
    const nextPosition = prototypeNodeDragPosition(position, currentDrag);
    setDragPosition(nextPosition);
  }

  function finishNodeDrag(event: PointerEvent<HTMLElement>) {
    const currentDrag = nodeDragRef.current;
    const finalPointerPosition = canvasPosition(event);
    if (!currentDrag || !finalPointerPosition) {
      nodeDragRef.current = undefined;
      setNodeDrag(undefined);
      setDragPosition(undefined);
      return;
    }
    const finalPosition = prototypeNodeDragPosition(finalPointerPosition, currentDrag);
    const original = graph.nodes.find((node) => node.id === currentDrag.nodeId);
    const delta = {
      x: finalPosition.x - currentDrag.displayPosition.x,
      y: finalPosition.y - currentDrag.displayPosition.y
    };
    const nextSourcePosition =
      original === undefined
        ? undefined
        : { x: original.position.x + delta.x, y: original.position.y + delta.y };
    if (
      original &&
      nextSourcePosition &&
      (original.position.x !== nextSourcePosition.x || original.position.y !== nextSourcePosition.y)
    )
      commit(
        moveGraphNodeWithCompactLayout(currentDrag.nodeId, nextSourcePosition, finalPosition),
        'Node position and compact layout saved to the committed graph.'
      );
    nodeDragRef.current = undefined;
    setNodeDrag(undefined);
    setDragPosition(undefined);
  }

  function finishConnector(target: PrototypeNode) {
    if (readOnly) return;
    if (!connector) return;
    if (connector.nodeId === target.id) {
      setConnector(undefined);
      setPointer(undefined);
      return;
    }
    connect(
      connector.nodeId,
      connector.portId,
      target.id,
      connector.kind ?? inferredKind(target),
      editingId
    );
  }

  function point(event: PointerEvent<HTMLElement>) {
    const rect = viewport.current?.getBoundingClientRect();
    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : undefined;
  }

  function onViewportPointerDown(event: PointerEvent<HTMLDivElement>) {
    if ((event.target as Element).closest('button, select, [data-prototype-target]')) return;
    if (event.shiftKey) {
      const position = canvasPosition(event);
      if (!position) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      setSelectionBox({
        startX: position.x,
        startY: position.y,
        endX: position.x,
        endY: position.y
      });
      setSelectedTransitionId(undefined);
      return;
    }
    setDragPan({ x: event.clientX, y: event.clientY, startX: pan.x, startY: pan.y });
  }

  function onViewportPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (nodeDragRef.current) {
      updateNodeDrag(event);
      return;
    }
    if (selectionBox) {
      const position = canvasPosition(event);
      if (position)
        setSelectionBox((current) =>
          current ? { ...current, endX: position.x, endY: position.y } : current
        );
      return;
    }
    const next = point(event);
    if (connector && next) setPointer(next);
    if (dragPan)
      setPan({
        x: dragPan.startX + event.clientX - dragPan.x,
        y: dragPan.startY + event.clientY - dragPan.y
      });
  }

  function undo() {
    if (readOnly || !onGraphChange || commitPending) return;
    const previous = history.past.at(-1);
    if (!previous) return;
    setCommitPending(true);
    setInteractionStatus('Restoring previous graph change…');
    void invokePrototypeFlowCallback(() => onGraphChange(previous)).then(
      () => {
        setHistory((current) =>
          settlePrototypeFlowHistory(current, { type: 'undo', current: graph }, true)
        );
        setCommitPending(false);
        setInteractionStatus('Undo saved to the committed graph.');
      },
      () => {
        setHistory((current) =>
          settlePrototypeFlowHistory(current, { type: 'undo', current: graph }, false)
        );
        setCommitPending(false);
        setInteractionStatus('Undo could not be saved.');
      }
    );
  }

  function redo() {
    if (readOnly || !onGraphChange || commitPending) return;
    const next = history.future[0];
    if (!next) return;
    setCommitPending(true);
    setInteractionStatus('Reapplying graph change…');
    void invokePrototypeFlowCallback(() => onGraphChange(next)).then(
      () => {
        setHistory((current) =>
          settlePrototypeFlowHistory(current, { type: 'redo', current: graph }, true)
        );
        setCommitPending(false);
        setInteractionStatus('Redo saved to the committed graph.');
      },
      () => {
        setHistory((current) =>
          settlePrototypeFlowHistory(current, { type: 'redo', current: graph }, false)
        );
        setCommitPending(false);
        setInteractionStatus('Redo could not be saved.');
      }
    );
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
      commit(pastePrototypeNodes(graph, serialized), 'Pasted nodes saved to the committed graph.');
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not paste the prototype fragment.');
    }
  }

  const modalIsolation = prototypeFlowModalIsolation(!readOnly && pendingDelete !== undefined);

  function selectTransition(transition: PrototypeTransition) {
    setSelectedTransitionId(transition.id);
    setSelectedNodeIds([]);
    edit(transition);
  }

  function reconnect(transition: PrototypeTransition) {
    edit(transition);
    if (transition.kind === 'back' || transition.kind === 'reset-flow') {
      setError('Use the transition editor to change a history or reset edge.');
      return;
    }
    startConnector(transition.from.nodeId, transition.from.portId, undefined, transition.kind);
    setInteractionStatus('Choose a compatible target to reconnect the selected edge.');
  }

  function openDeleteDialog(transition: PrototypeTransition) {
    deleteInvokingRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPendingDelete(transition);
  }

  function closeDeleteDialog() {
    setPendingDelete(undefined);
    requestAnimationFrame(() => deleteInvokingRef.current?.focus());
  }

  function onDeleteDialogKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDeleteDialog();
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = deleteDialogRef.current;
    if (!dialog) return;
    const controls = Array.from(
      dialog.querySelectorAll<HTMLButtonElement>('button:not([disabled])')
    );
    if (controls.length === 0) return;
    const active = document.activeElement;
    const activeIndex = active instanceof HTMLButtonElement ? controls.indexOf(active) : -1;
    const nextIndex = nextPrototypeDialogFocusIndex(controls.length, activeIndex, event.shiftKey);
    if (nextIndex !== activeIndex) {
      event.preventDefault();
      controls[nextIndex]?.focus();
    }
  }

  function cancelPointerInteraction() {
    setConnector(cancelPrototypeConnectorDrag(connector));
    setPointer(undefined);
    setDragPan(undefined);
    nodeDragRef.current = undefined;
    setNodeDrag(undefined);
    setDragPosition(undefined);
    setSelectionBox(undefined);
  }

  function moveSelectedNode(event: KeyboardEvent<HTMLDivElement>): boolean {
    const delta =
      event.key === 'ArrowLeft'
        ? { x: -20, y: 0 }
        : event.key === 'ArrowRight'
          ? { x: 20, y: 0 }
          : event.key === 'ArrowUp'
            ? { x: 0, y: -20 }
            : event.key === 'ArrowDown'
              ? { x: 0, y: 20 }
              : undefined;
    const node =
      selectedNodeIds.length === 1
        ? graph.nodes.find((item) => item.id === selectedNodeIds[0])
        : undefined;
    if (!delta || !node) return false;
    event.preventDefault();
    const sourcePosition = {
      x: Math.max(-100_000, Math.min(100_000, node.position.x + delta.x)),
      y: Math.max(-100_000, Math.min(100_000, node.position.y + delta.y))
    };
    const displayed = displayGraph.nodes.find((item) => item.id === node.id);
    commit(
      moveGraphNodeWithCompactLayout(node.id, sourcePosition, {
        x: (displayed?.position.x ?? node.position.x) + delta.x,
        y: (displayed?.position.y ?? node.position.y) + delta.y
      }),
      'Node position and compact layout saved to the committed graph.'
    );
    return true;
  }

  function runCommittedGraph() {
    if (!onRunCommitted || commitPending || runPending) return;
    const start = beginPrototypeRun(runGate.current);
    if (!start) return;
    runGate.current = start.gate;
    setRunPending(true);
    setInteractionStatus('Starting the committed graph in Preview…');
    const settle = (message: string) => {
      const result = settlePrototypeRun(runGate.current, start.token);
      runGate.current = result.gate;
      if (!result.current) return;
      setRunPending(false);
      setInteractionStatus(message);
    };
    void invokePrototypeFlowCallback(() => onRunCommitted()).then(
      () => settle('Preview is running the committed graph.'),
      () => settle('Preview could not start the committed graph.')
    );
  }

  function recenterFromOverview(event: MouseEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const viewportElement = viewport.current;
    const viewportRect = viewportElement?.getBoundingClientRect();
    if (!viewportElement || !viewportRect || rect.width <= 0 || rect.height <= 0) return;
    const graphX = bounds.minX + ((event.clientX - rect.left) / rect.width) * bounds.width;
    const graphY = bounds.minY + ((event.clientY - rect.top) / rect.height) * bounds.height;
    setPan({
      x: Math.round(
        viewportRect.width / 2 + viewportElement.scrollLeft - (graphX - bounds.minX) * zoom
      ),
      y: Math.round(
        viewportRect.height / 2 + viewportElement.scrollTop - (graphY - bounds.minY) * zoom
      )
    });
    setInteractionStatus('Overview recentered the graph canvas.');
  }

  return (
    <section className="prototype-flow" aria-label="Prototype flow canvas">
      {modalIsolation.active && pendingDelete ? (
        <>
          <div className="prototype-flow__modal-scrim" aria-hidden="true" />
          <section
            ref={deleteDialogRef}
            className="prototype-flow__confirmation"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="prototype-flow-delete-heading"
            onKeyDown={onDeleteDialogKeyDown}
          >
            <h3 id="prototype-flow-delete-heading">Delete transition?</h3>
            <p>Delete {connectionText(pendingDelete)}? Undo remains available after deletion.</p>
            <button
              type="button"
              onClick={() => {
                remove(pendingDelete);
                closeDeleteDialog();
              }}
            >
              Delete transition
            </button>
            <button ref={deleteCancelRef} type="button" onClick={closeDeleteDialog}>
              Keep transition
            </button>
          </section>
        </>
      ) : null}
      <div
        className={`prototype-flow__content${!inspectorOpen ? ' prototype-flow__content--inspector-collapsed' : ''}`}
        inert={modalIsolation.backgroundInert || undefined}
        aria-hidden={modalIsolation.backgroundInert ? true : undefined}
      >
        <div className="prototype-flow__heading">
          <div>
            <p className="prototype-kicker">Prototype graph</p>
            <h2>{graph.name}</h2>
          </div>
          <div className="prototype-flow__actions" aria-label="Flow toolbar">
            {!readOnly ? (
              <div className="prototype-flow__action-group" aria-label="Graph history">
                <button type="button" onClick={undo} disabled={history.past.length === 0}>
                  Undo
                </button>
                <button type="button" onClick={redo} disabled={history.future.length === 0}>
                  Redo
                </button>
              </div>
            ) : null}
            {!readOnly ? (
              <div className="prototype-flow__action-group" aria-label="Graph clipboard">
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
              </div>
            ) : null}
            {!readOnly && onRunCommitted ? (
              <button
                type="button"
                className="prototype-flow__run-preview"
                onClick={runCommittedGraph}
                disabled={commitPending || runPending}
              >
                Run committed graph in Preview
              </button>
            ) : null}
            {!readOnly ? (
              <button
                type="button"
                className="prototype-flow__inspector-toggle"
                aria-controls={`${selectId}-inspector`}
                aria-expanded={inspectorOpen}
                onClick={() => {
                  setInspectorOpen((open) => !open);
                  setInspectorFitEpoch((epoch) => epoch + 1);
                }}
              >
                {inspectorOpen ? 'Hide Inspector' : 'Show Inspector'}
              </button>
            ) : null}
            <div className="prototype-flow__zoom-controls" role="group" aria-label="Canvas zoom">
              <button type="button" onClick={fitToViewFromControl} aria-label="Fit canvas to view">
                Fit view
              </button>
              <button
                type="button"
                onClick={() =>
                  updateZoomFromControl((value) =>
                    value <= prototypeFlowMinimumZoom
                      ? value
                      : Math.max(prototypeFlowMinimumZoom, value - prototypeFlowZoomStep)
                  )
                }
                aria-label="Zoom out"
                disabled={zoom <= prototypeFlowMinimumZoom}
              >
                −
              </button>
              <span
                className="prototype-flow__zoom-readout"
                aria-label={`Canvas zoom ${Math.round(zoom * 100)} percent`}
              >
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                onClick={() =>
                  updateZoomFromControl((value) =>
                    Math.min(prototypeFlowMaximumZoom, value + prototypeFlowZoomStep)
                  )
                }
                aria-label="Zoom in"
              >
                +
              </button>
            </div>
          </div>
        </div>
        {error ? (
          <p className="prototype-flow__error" role="alert">
            {error}
          </p>
        ) : null}
        {!readOnly ? (
          <p className="prototype-flow__status" role="status" aria-live="polite">
            {interactionStatus}
          </p>
        ) : null}
        {!readOnly ? (
          <p className="prototype-flow__instruction">
            Drag from an action port to a target node. Select a port, then press Enter on a node for
            keyboard wiring. Drag a card to move it, Shift-drag blank canvas to box-select, arrow
            keys move one selected card, and drag blank canvas to pan.
          </p>
        ) : null}
        <div className="prototype-flow__stage">
          <div
            ref={viewport}
            className="prototype-flow__viewport"
            tabIndex={readOnly ? -1 : 0}
            aria-label="Visual prototype flow"
            onPointerDown={readOnly ? undefined : onViewportPointerDown}
            onPointerMove={readOnly ? undefined : onViewportPointerMove}
            onScroll={syncViewportGeometry}
            onPointerUp={
              readOnly
                ? undefined
                : (event) => {
                    if (nodeDragRef.current) {
                      finishNodeDrag(event);
                      return;
                    }
                    if (selectionBox) {
                      setSelectedNodeIds([
                        ...selectPrototypeGraphNodes(displayGraph, selectionBox)
                      ]);
                      setSelectionBox(undefined);
                      setInteractionStatus('Selected graph cards from the box.');
                      return;
                    }
                    setDragPan(undefined);
                    if (!connector) return;
                    const targetId = document
                      .elementFromPoint(event.clientX, event.clientY)
                      ?.closest<HTMLElement>('[data-prototype-target]')?.dataset.prototypeTarget;
                    const target = displayGraph.nodes.find((node) => node.id === targetId);
                    if (target) finishConnector(target);
                    else {
                      setConnector(undefined);
                      setPointer(undefined);
                    }
                  }
            }
            onPointerLeave={readOnly ? undefined : () => setDragPan(undefined)}
            onPointerCancel={readOnly ? undefined : cancelPointerInteraction}
            onLostPointerCapture={readOnly ? undefined : cancelPointerInteraction}
            onWheel={
              readOnly
                ? undefined
                : (event) => {
                    event.preventDefault();
                    updateZoomFromControl((value) =>
                      nextPrototypeFlowWheelZoom(value, event.deltaY)
                    );
                  }
            }
            onKeyDown={
              readOnly
                ? undefined
                : (event) => {
                    if (moveSelectedNode(event)) return;
                    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
                      event.preventDefault();
                      if (event.shiftKey) redo();
                      else undo();
                    } else if (
                      (event.key === 'Delete' || event.key === 'Backspace') &&
                      selectedTransition
                    ) {
                      event.preventDefault();
                      openDeleteDialog(selectedTransition);
                    } else if (event.key === 'Escape') {
                      cancelPointerInteraction();
                    }
                  }
            }
          >
            <div
              className="prototype-flow__canvas-space"
              style={{ width: canvasSpace.width, height: canvasSpace.height }}
            >
              <div
                className="prototype-flow__transform"
                style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
              >
                <div
                  className={`prototype-flow__plane${compact ? ' prototype-flow__plane--compact' : ''}`}
                  data-prototype-flow-layout={compact ? 'compact-topology' : 'source-positions'}
                  style={{ width: bounds.width, height: bounds.height }}
                >
                  <svg
                    role="group"
                    aria-label="Graph connection edges"
                    viewBox={`0 0 ${bounds.width} ${bounds.height}`}
                  >
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
                    {displayGraph.transitions.map((transition) => (
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
                        selected={selectedTransitionId === transition.id}
                        {...(!readOnly
                          ? {
                              onSelect: selectTransition,
                              onDelete: openDeleteDialog,
                              onReconnect: reconnect
                            }
                          : {})}
                      />
                    ))}
                    {connector && pointer ? (
                      <path
                        className="prototype-flow__wire prototype-flow__wire--draft"
                        d={`M ${connector.x} ${connector.y} L ${(pointer.x + viewportGeometry.scrollLeft - pan.x) / zoom} ${(pointer.y + viewportGeometry.scrollTop - pan.y) / zoom}`}
                        markerEnd={`url(#${selectId}-arrow)`}
                      />
                    ) : null}
                  </svg>
                  {displayGraph.nodes.map((node) => (
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
                            onBeginNodeDrag: beginNodeDrag,
                            onSelect: (nodeId: string, additive: boolean) => {
                              setSelectedTransitionId(undefined);
                              setSelectedNodeIds((items) =>
                                additive
                                  ? items.includes(nodeId)
                                    ? items.filter((item) => item !== nodeId)
                                    : [...items, nodeId]
                                  : [nodeId]
                              );
                            }
                          }
                        : {})}
                    />
                  ))}
                  {selectionBox ? (
                    <div
                      className="prototype-flow__selection-box"
                      aria-hidden="true"
                      style={{
                        left: Math.min(selectionBox.startX, selectionBox.endX) - bounds.minX,
                        top: Math.min(selectionBox.startY, selectionBox.endY) - bounds.minY,
                        width: Math.abs(selectionBox.endX - selectionBox.startX),
                        height: Math.abs(selectionBox.endY - selectionBox.startY)
                      }}
                    />
                  ) : null}
                </div>
              </div>
            </div>
          </div>
          <button
            type="button"
            className="prototype-flow__overview"
            aria-label={`Graph overview with ${displayGraph.nodes.length} nodes. Click to recenter.`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={recenterFromOverview}
          >
            <span className="prototype-flow__overview-title" aria-hidden="true">
              Map
            </span>
            {displayGraph.nodes.map((node) => (
              <span
                key={node.id}
                className={`prototype-flow__overview-node prototype-flow__overview-node--${node.kind}${selectedNodeIds.includes(node.id) ? ' prototype-flow__overview-node--selected' : ''}`}
                style={(() => {
                  const overviewNode = prototypeFlowOverviewNodeRect(node, bounds);
                  return {
                    left: `${overviewNode.left}%`,
                    top: `${overviewNode.top}%`,
                    width: `${overviewNode.width}%`,
                    height: `${overviewNode.height}%`
                  };
                })()}
                title={node.label}
              />
            ))}
            <span
              className="prototype-flow__overview-viewport"
              aria-hidden="true"
              style={{
                left: `${overviewViewport.left}%`,
                top: `${overviewViewport.top}%`,
                width: `${overviewViewport.width}%`,
                height: `${overviewViewport.height}%`
              }}
            />
          </button>
        </div>
        {!readOnly ? (
          <aside
            className="prototype-flow__side-panel"
            aria-label="Graph properties and keyboard fallback"
            hidden={!inspectorOpen}
            inert={!inspectorOpen || undefined}
            aria-hidden={!inspectorOpen || undefined}
          >
            <details
              id={`${selectId}-inspector`}
              className="prototype-flow__inspector"
              aria-label="Selected graph item inspector"
              open={inspectorOpen}
              onToggle={(event) => setInspectorOpen(event.currentTarget.open)}
            >
              <summary>
                <span>Inspector</span>
                <small>
                  {selectedTransition
                    ? 'Selected connection'
                    : selectedNode
                      ? 'Selected card'
                      : 'Select a card or wire'}
                </small>
              </summary>
              {selectedTransition ? (
                <>
                  <strong>{connectionText(selectedTransition)}</strong>
                  <p>Action port: {selectedTransition.from.portId}</p>
                  <div>
                    <button type="button" onClick={() => reconnect(selectedTransition)}>
                      Reconnect edge
                    </button>
                    <button type="button" onClick={() => openDeleteDialog(selectedTransition)}>
                      Delete edge
                    </button>
                  </div>
                </>
              ) : selectedNode ? (
                <>
                  <strong>{selectedNode.label}</strong>
                  <p>
                    {selectedNode.kind} · {selectedNode.position.x}, {selectedNode.position.y}
                  </p>
                  <p>
                    {selectedNode.ports.length} typed action port
                    {selectedNode.ports.length === 1 ? '' : 's'} · drag the card to persist its
                    position.
                  </p>
                </>
              ) : (
                <p>
                  Select a node or edge to inspect it. Press Delete to remove the selected edge.
                </p>
              )}
            </details>
            <details className="prototype-flow__panel-disclosure">
              <summary>Transitions and keyboard fallback</summary>
              <form
                className="prototype-flow__connector"
                aria-label="Transition editor"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (
                    source &&
                    portId &&
                    (kind === 'back' || kind === 'reset-flow' || targetNodeId)
                  )
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
                      <select
                        value={portId}
                        onChange={(event) => setPortId(event.currentTarget.value)}
                      >
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
                    !source ||
                    !portId ||
                    (!(kind === 'back' || kind === 'reset-flow') && !targetNodeId)
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
                            <button type="button" onClick={() => edit(transition)}>
                              Edit
                            </button>
                            <button type="button" onClick={() => openDeleteDialog(transition)}>
                              Delete
                            </button>
                          </li>
                        ))}
                      </ul>
                    </details>
                  );
                })}
              </section>
            </details>
          </aside>
        ) : null}
        {readOnly ? (
          <section className="prototype-flow__connections" aria-label="Existing connectors">
            <p className="prototype-kicker">Transition details</p>
            <h3>{graph.transitions.length} transitions</h3>
          </section>
        ) : null}
      </div>
    </section>
  );
}

function Wire({
  transition,
  markerId,
  layout,
  active,
  selected,
  onSelect,
  onDelete,
  onReconnect
}: {
  readonly transition: PrototypeTransition;
  readonly markerId: string;
  readonly layout: PrototypeFlowWireLayout | undefined;
  readonly active: boolean;
  readonly selected: boolean;
  readonly onSelect?: ((transition: PrototypeTransition) => void) | undefined;
  readonly onDelete?: ((transition: PrototypeTransition) => void) | undefined;
  readonly onReconnect?: ((transition: PrototypeTransition) => void) | undefined;
}) {
  if (!layout) return null;
  return (
    <g
      data-prototype-wire={transition.id}
      data-prototype-source-node={transition.from.nodeId}
      data-prototype-source-port={transition.from.portId}
      {...('to' in transition ? { 'data-prototype-target-node': transition.to.nodeId } : {})}
      role={onSelect ? 'button' : 'img'}
      tabIndex={onSelect ? 0 : undefined}
      aria-label={`${connectionText(transition)} edge`}
      aria-keyshortcuts={onSelect ? 'Enter Space Delete R' : undefined}
      onKeyDown={
        onSelect
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(transition);
              } else if (event.key === 'Delete' || event.key === 'Backspace') {
                event.preventDefault();
                onDelete?.(transition);
              } else if (event.key.toLowerCase() === 'r') {
                event.preventDefault();
                onReconnect?.(transition);
              }
            }
          : undefined
      }
    >
      <title>{`${connectionText(transition)} edge`}</title>
      <path
        className={`prototype-flow__wire${active ? ' prototype-flow__wire--active' : ''}${selected ? ' prototype-flow__wire--selected' : ''}`}
        d={layout.path}
        markerEnd={`url(#${markerId}-arrow)`}
        pointerEvents={onSelect ? 'stroke' : undefined}
        onClick={onSelect ? () => onSelect(transition) : undefined}
      />
      {layout.label ? (
        <>
          {layout.label.tether ? (
            <line
              className="prototype-flow__wire-label-tether"
              data-prototype-wire-label-tether={transition.id}
              x1={layout.label.tether.x1}
              y1={layout.label.tether.y1}
              x2={layout.label.tether.x2}
              y2={layout.label.tether.y2}
            />
          ) : null}
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
        </>
      ) : null}
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
  onSelect,
  onBeginNodeDrag
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
  readonly onSelect?: (nodeId: string, additive: boolean) => void;
  readonly onBeginNodeDrag?: (node: PrototypeNode, event: PointerEvent<HTMLElement>) => void;
}) {
  return (
    <article
      className={`prototype-flow__node prototype-flow__node--${node.kind}${active ? ' prototype-flow__node--active' : ''}${selected ? ' prototype-flow__node--selected' : ''}`}
      data-prototype-target={node.id}
      data-prototype-node={node.id}
      style={prototypeFlowCardStyle(node, bounds)}
      aria-label={`${node.label} node`}
      onPointerDown={onBeginNodeDrag ? (event) => onBeginNodeDrag(node, event) : undefined}
    >
      <header className="prototype-flow__node-header">
        <span title={node.kind}>{node.kind}</span>
        <strong title={node.label}>{node.label}</strong>
      </header>
      <div className="prototype-flow__node-detail">
        {'route' in node ? <code title={node.route}>{node.route}</code> : null}
        {'parentId' in node ? (
          <small title={`state of ${node.parentId}`}>state of {node.parentId}</small>
        ) : null}
        {'dismissible' in node ? (
          <small title={node.dismissible ? 'dismissible overlay' : 'persistent overlay'}>
            {node.dismissible ? 'dismissible' : 'persistent'}
          </small>
        ) : null}
      </div>
      <div className="prototype-flow__node-actions">
        {onFinish && connectorActive ? (
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
            onClick={(event) => onSelect(node.id, event.shiftKey)}
          >
            {selected ? 'Selected' : 'Select'}
          </button>
        ) : null}
      </div>
      <div className="prototype-flow__ports" aria-label={`${node.label} action ports`}>
        {onStart
          ? node.ports.map((port) => (
              <button
                key={port.id}
                type="button"
                className="prototype-flow__port"
                data-prototype-port={port.id}
                aria-label={`${port.label} action port`}
                title={port.label}
                style={prototypeFlowPortStyle(port.label)}
                onPointerDown={(event) => onStart(node.id, port.id, event)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onStart(node.id, port.id);
                  }
                }}
              >
                <span>{port.label}</span>
              </button>
            ))
          : null}
      </div>
    </article>
  );
}
