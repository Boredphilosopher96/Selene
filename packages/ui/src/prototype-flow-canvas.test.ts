import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { parsePrototypeGraph, prototypeGraphFixture, type PrototypeGraph } from '@selene/core';

import {
  beginPrototypeRun,
  cancelPrototypeConnectorDrag,
  graphCanvasPosition,
  graphOverviewViewport,
  prototypeFlowCanvasSpaceExtent,
  fitPrototypeFlowViewport,
  invokePrototypeFlowCallback,
  layoutPrototypeWiresWithStats,
  layoutPrototypeWires,
  movePrototypeGraphNode,
  selectPrototypeGraphNodes,
  nextPrototypeDialogFocusIndex,
  PrototypeFlowCanvas,
  prototypeNodeDragPosition,
  prototypeFlowModalIsolation,
  nextPrototypeFlowWheelZoom,
  prototypeFlowGraphBounds,
  prototypeFlowCardLayout,
  prototypeFlowLabelLayoutWorkBudget,
  prototypeFlowNodeExtent,
  prototypeFlowOverviewNodeRect,
  prototypeFlowPortHeight,
  prototypeFlowPortCenter,
  settlePrototypeFlowHistory,
  settlePrototypeRun
} from './prototype-flow-canvas';

describe('prototype flow wire layout', () => {
  it('routes overlay, back, and timeout edges deterministically without label collisions', () => {
    const bounds = prototypeFlowGraphBounds(prototypeGraphFixture.nodes);
    const first = layoutPrototypeWires(prototypeGraphFixture, bounds);
    const second = layoutPrototypeWires(prototypeGraphFixture, bounds);
    const firstLayout = [...first.entries()];

    expect(firstLayout).toEqual([...second.entries()]);
    expect(first.get('save-order')?.label?.text).toContain('open-overlay');
    expect(first.get('cancel-order')?.label?.text).toContain('back');
    expect(first.get('expire-order-draft')?.label?.text).toContain('reset-flow');
    expect(first.get('create-order')?.label?.text).toContain('Create order');
    expect(new Set(firstLayout.map(([, layout]) => layout.path)).size).toBe(firstLayout.length);

    const labels = [...first.values()].flatMap((item) =>
      item.label
        ? [
            {
              x: item.label.x,
              y: item.label.y - item.label.height,
              width: item.label.width,
              height: item.label.height
            }
          ]
        : []
    );
    expect(labels).toHaveLength(firstLayout.length);
    for (const [index, label] of labels.entries()) {
      expect(label.x).toBeGreaterThanOrEqual(0);
      expect(label.y).toBeGreaterThanOrEqual(0);
      expect(label.x + label.width).toBeLessThanOrEqual(bounds.width);
      expect(label.y + label.height).toBeLessThanOrEqual(bounds.height);
      for (const other of labels.slice(index + 1))
        expect(
          label.x < other.x + other.width &&
            label.x + label.width > other.x &&
            label.y < other.y + other.height &&
            label.y + label.height > other.y
        ).toBe(false);
    }
    const nodeBoxes = prototypeGraphFixture.nodes.map((node) => {
      const extent = prototypeFlowNodeExtent(node);
      return {
        x: node.position.x - bounds.minX - 8,
        y: node.position.y - bounds.minY - 8,
        width: extent.width + 16,
        height: extent.height + 16
      };
    });
    for (const label of labels)
      for (const node of nodeBoxes)
        expect(
          label.x < node.x + node.width &&
            label.x + label.width > node.x &&
            label.y < node.y + node.height &&
            label.y + label.height > node.y
        ).toBe(false);
  });

  it('keeps the full fixture graph and every rendered label in the actual compact viewport', () => {
    const bounds = prototypeFlowGraphBounds(prototypeGraphFixture.nodes);
    const viewport = { width: 560, height: 520, scrollLeft: 0, scrollTop: 0 };
    const fit = fitPrototypeFlowViewport(viewport, bounds);
    const labels = [...layoutPrototypeWires(prototypeGraphFixture, bounds).values()].flatMap(
      (layout) => (layout.label ? [layout.label] : [])
    );
    const projectRect = (rect: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    }) => ({
      left: fit.pan.x + rect.x * fit.zoom - viewport.scrollLeft,
      right: fit.pan.x + (rect.x + rect.width) * fit.zoom - viewport.scrollLeft,
      top: fit.pan.y + rect.y * fit.zoom - viewport.scrollTop,
      bottom: fit.pan.y + (rect.y + rect.height) * fit.zoom - viewport.scrollTop
    });
    const expectInsideViewport = (rect: ReturnType<typeof projectRect>) => {
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(viewport.width);
      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(rect.bottom).toBeLessThanOrEqual(viewport.height);
    };

    expect(labels.length).toBe(prototypeGraphFixture.transitions.length);
    expect(fit.zoom).toBeLessThan(0.87);
    expect(fit.pan.x).toBeGreaterThanOrEqual(16);
    expect(fit.pan.x + bounds.width * fit.zoom).toBeLessThanOrEqual(viewport.width - 16);
    for (const node of prototypeGraphFixture.nodes) {
      const extent = prototypeFlowNodeExtent(node);
      expectInsideViewport(
        projectRect({
          x: node.position.x - bounds.minX,
          y: node.position.y - bounds.minY,
          width: extent.width,
          height: extent.height
        })
      );
    }
    for (const label of labels) {
      expectInsideViewport(
        projectRect({
          x: label.x,
          y: label.y - label.height,
          width: label.width,
          height: label.height
        })
      );
    }
  });

  it('fits against the actual scroll client box when a native horizontal scrollbar consumes height', () => {
    const bounds = prototypeFlowGraphBounds(prototypeGraphFixture.nodes);
    const clientViewport = { width: 620, height: 502 };
    const fit = fitPrototypeFlowViewport(clientViewport, bounds);

    expect(fit.pan.x).toBeGreaterThanOrEqual(0);
    expect(fit.pan.y).toBeGreaterThanOrEqual(0);
    expect(fit.pan.x + bounds.width * fit.zoom).toBeLessThanOrEqual(clientViewport.width);
    expect(fit.pan.y + bounds.height * fit.zoom).toBeLessThanOrEqual(clientViewport.height);
    const canvasSpace = prototypeFlowCanvasSpaceExtent(bounds, fit.zoom, fit.pan);
    expect(canvasSpace.width).toBeGreaterThanOrEqual(fit.pan.x + bounds.width * fit.zoom);
    expect(canvasSpace.height).toBeGreaterThanOrEqual(fit.pan.y + bounds.height * fit.zoom);
    expect(canvasSpace.width).toBeLessThanOrEqual(clientViewport.width);
    expect(canvasSpace.height).toBeLessThanOrEqual(clientViewport.height);
  });

  it('reaches the deterministic global search after a blocked local label region', () => {
    const [orders, newOrder, ordersEmpty] = prototypeGraphFixture.nodes;
    if (!orders || !newOrder || !ordersEmpty)
      throw new Error('Prototype fixture nodes are required.');
    const createOrder = prototypeGraphFixture.transitions.find(
      (transition) => transition.id === 'create-order'
    );
    if (!createOrder || !('to' in createOrder))
      throw new Error('Prototype fixture create-order transition is required.');
    const blockers = Array.from({ length: 12 }, (_, index) => ({
      ...ordersEmpty,
      id: `local-blocker-${index}`,
      position: { x: (index % 4) * 210, y: Math.floor(index / 4) * 144 },
      ports: []
    }));
    const graph = {
      ...prototypeGraphFixture,
      initialNodeId: 'source',
      nodes: [
        { ...orders, id: 'source', position: { x: 0, y: 0 } },
        { ...newOrder, id: 'target', position: { x: 700, y: 0 }, ports: [] },
        ...blockers
      ],
      transitions: [
        {
          ...createOrder,
          id: 'global-edge',
          from: { nodeId: 'source', portId: orders.ports[0]?.id ?? 'create' },
          to: { nodeId: 'target' }
        }
      ]
    } satisfies PrototypeGraph;
    const bounds = { minX: 0, minY: 0, width: 1100, height: 700 };
    const first = layoutPrototypeWires(graph, bounds).get('global-edge');
    const second = layoutPrototypeWires(graph, bounds).get('global-edge');
    if (!first?.label || !second?.label) throw new Error('Global label layout is required.');

    expect(first).toEqual(second);
    expect(first.label.tether).toBeDefined();
    expect(first.label.y - first.label.height).toBeGreaterThanOrEqual(440);
    expect(first.label.x).toBeGreaterThanOrEqual(0);
    expect(first.label.y - first.label.height).toBeGreaterThanOrEqual(0);
    expect(first.label.x + first.label.width).toBeLessThanOrEqual(bounds.width);
    expect(first.label.y).toBeLessThanOrEqual(bounds.height);
  });

  it('suppresses only an impossible visual label for a valid hostile graph without crashing', () => {
    const [orders, newOrder] = prototypeGraphFixture.nodes;
    if (!orders || !newOrder) throw new Error('Prototype fixture nodes are required.');
    const createOrder = prototypeGraphFixture.transitions.find(
      (transition) => transition.id === 'create-order'
    );
    if (!createOrder || !('to' in createOrder))
      throw new Error('Prototype fixture create-order transition is required.');
    const sourcePort = orders.ports[0];
    const scenario = prototypeGraphFixture.scenarios[0];
    if (!sourcePort || !scenario)
      throw new Error('Prototype fixture port and scenario are required.');
    const sourceId = `s${'a'.repeat(127)}`;
    const targetId = `t${'b'.repeat(127)}`;
    const portId = `p${'c'.repeat(127)}`;
    const graph = parsePrototypeGraph({
      ...prototypeGraphFixture,
      initialNodeId: sourceId,
      nodes: [
        {
          ...orders,
          id: sourceId,
          route: '/source',
          position: { x: 0, y: 0 },
          ports: [{ ...sourcePort, id: portId }]
        },
        { ...newOrder, id: targetId, route: '/target', position: { x: 340, y: 0 }, ports: [] }
      ],
      transitions: [
        {
          ...createOrder,
          id: 'saturated-edge',
          from: { nodeId: sourceId, portId },
          to: { nodeId: targetId }
        }
      ],
      scenarios: [
        {
          ...scenario,
          id: 'saturated-scenario',
          startNodeId: sourceId,
          expectedPath: [sourceId, targetId]
        }
      ]
    });
    const componentBounds = prototypeFlowGraphBounds(graph.nodes);
    const shortConnectionGraph = parsePrototypeGraph({
      ...graph,
      initialNodeId: 'source',
      nodes: [
        { ...graph.nodes[0]!, id: 'source', ports: [{ ...sourcePort, id: 'go' }] },
        { ...graph.nodes[1]!, id: 'target' }
      ],
      transitions: [
        {
          ...createOrder,
          id: 'short-edge',
          from: { nodeId: 'source', portId: 'go' },
          to: { nodeId: 'target' }
        }
      ],
      scenarios: [
        {
          ...scenario,
          id: 'short-scenario',
          startNodeId: 'source',
          expectedPath: ['source', 'target']
        }
      ]
    });
    const layout = layoutPrototypeWires(graph, componentBounds).get('saturated-edge');

    expect(componentBounds).toEqual(prototypeFlowGraphBounds(shortConnectionGraph.nodes));
    for (const node of graph.nodes) {
      const extent = prototypeFlowNodeExtent(node);
      expect(node.position.x).toBeGreaterThanOrEqual(componentBounds.minX);
      expect(node.position.x + extent.width).toBeLessThanOrEqual(
        componentBounds.minX + componentBounds.width
      );
      expect(node.position.y).toBeGreaterThanOrEqual(componentBounds.minY);
      expect(node.position.y + extent.height).toBeLessThanOrEqual(
        componentBounds.minY + componentBounds.height
      );
    }
    expect(layout?.path).toContain('M');
    expect(layout?.label).toBeUndefined();

    const readonly = renderToStaticMarkup(
      createElement(PrototypeFlowCanvas, { graph, readOnly: true })
    );
    const editable = renderToStaticMarkup(
      createElement(PrototypeFlowCanvas, { graph, onGraphChange: () => undefined })
    );
    expect(readonly).toContain('role="img"');
    expect(readonly).toContain(`aria-label="${sourceId}.${portId} → ${targetId} (navigate) edge"`);
    expect(readonly).toContain(
      `<title>${sourceId}.${portId} → ${targetId} (navigate) edge</title>`
    );
    expect(readonly).not.toContain('data-prototype-wire-label="saturated-edge"');
    expect(editable).toContain('role="button"');
  });

  it('contains max-port and max-length route/state cards in bounds, fit, selection, and minimap geometry', () => {
    const [orders, , ordersEmpty] = prototypeGraphFixture.nodes;
    const scenario = prototypeGraphFixture.scenarios[0];
    if (!orders || !ordersEmpty || !scenario)
      throw new Error('Prototype fixture nodes and scenario are required.');
    const screenId = `s${'a'.repeat(127)}`;
    const stateId = `t${'b'.repeat(127)}`;
    const route = `/${'r'.repeat(239)}`;
    const label = 'L'.repeat(160);
    const lastPortId = 'port-31';
    const graph = parsePrototypeGraph({
      ...prototypeGraphFixture,
      initialNodeId: screenId,
      nodes: [
        {
          ...orders,
          id: screenId,
          label,
          route,
          position: { x: 480, y: 640 },
          ports: Array.from({ length: 32 }, (_, index) => ({
            id: `port-${index}`,
            label: `Action ${index}`,
            trigger: 'click' as const
          }))
        },
        {
          ...ordersEmpty,
          id: stateId,
          label,
          parentId: screenId,
          position: { x: 900, y: 720 },
          ports: []
        }
      ],
      transitions: [
        {
          id: 'last-port-edge',
          kind: 'set-state',
          from: { nodeId: screenId, portId: lastPortId },
          to: { nodeId: stateId }
        }
      ],
      scenarios: [
        {
          ...scenario,
          id: 'max-ports-scenario',
          startNodeId: screenId,
          expectedPath: [screenId, stateId]
        }
      ]
    });
    const node = graph.nodes[0]!;
    const state = graph.nodes[1]!;
    const extent = prototypeFlowNodeExtent(node);
    const stateExtent = prototypeFlowNodeExtent(state);
    const bounds = prototypeFlowGraphBounds(graph.nodes);
    const fit = fitPrototypeFlowViewport({ width: 600, height: 520 }, bounds);
    const overview = prototypeFlowOverviewNodeRect(node, bounds);
    const stateOverview = prototypeFlowOverviewNodeRect(state, bounds);
    const lastPortCenter = prototypeFlowPortCenter(node, lastPortId, bounds);
    const wire = layoutPrototypeWires(graph, bounds).get('last-port-edge');
    if (!lastPortCenter || !wire)
      throw new Error('Max-port center and committed wire are required.');
    const editable = renderToStaticMarkup(
      createElement(PrototypeFlowCanvas, { graph, onGraphChange: () => undefined })
    );

    expect(extent).toEqual({ width: prototypeFlowCardLayout.width, height: 1_094 });
    expect(node.position.x).toBeGreaterThanOrEqual(bounds.minX);
    expect(node.position.y).toBeGreaterThanOrEqual(bounds.minY);
    expect(node.position.x + extent.width).toBeLessThanOrEqual(bounds.minX + bounds.width);
    expect(node.position.y + extent.height).toBeLessThanOrEqual(bounds.minY + bounds.height);
    expect(state.position.x + stateExtent.width).toBeLessThanOrEqual(bounds.minX + bounds.width);
    expect(state.position.y + stateExtent.height).toBeLessThanOrEqual(bounds.minY + bounds.height);
    const fitViewport = { width: 600, height: 520, scrollLeft: 0, scrollTop: 0 };
    const limitingZoom = Math.min(
      1,
      (fitViewport.width - 32) / bounds.width,
      (fitViewport.height - 32) / bounds.height
    );
    const projectFitRect = (rect: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    }) => ({
      left: fit.pan.x + rect.x * fit.zoom - fitViewport.scrollLeft,
      right: fit.pan.x + (rect.x + rect.width) * fit.zoom - fitViewport.scrollLeft,
      top: fit.pan.y + rect.y * fit.zoom - fitViewport.scrollTop,
      bottom: fit.pan.y + (rect.y + rect.height) * fit.zoom - fitViewport.scrollTop
    });
    const expectFitContained = (rect: ReturnType<typeof projectFitRect>) => {
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(fitViewport.width);
      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(rect.bottom).toBeLessThanOrEqual(fitViewport.height);
    };
    expect(Number.isFinite(fit.zoom)).toBe(true);
    expect(fit.zoom).toBeGreaterThan(0);
    expect(fit.zoom).toBeCloseTo(limitingZoom, 10);
    expect(fit.zoom).toBeLessThan(0.87);
    expect(
      Math.min(
        Math.abs(bounds.width * fit.zoom - (fitViewport.width - 32)),
        Math.abs(bounds.height * fit.zoom - (fitViewport.height - 32))
      )
    ).toBeLessThanOrEqual(1);
    expectFitContained(
      projectFitRect({
        x: node.position.x - bounds.minX,
        y: node.position.y - bounds.minY,
        width: extent.width,
        height: extent.height
      })
    );
    expectFitContained(
      projectFitRect({
        x: state.position.x - bounds.minX,
        y: state.position.y - bounds.minY,
        width: stateExtent.width,
        height: stateExtent.height
      })
    );
    expect(overview.left + overview.width).toBeLessThanOrEqual(100);
    expect(overview.top + overview.height).toBeLessThanOrEqual(100);
    expect(stateOverview.left + stateOverview.width).toBeLessThanOrEqual(100);
    expect(stateOverview.top + stateOverview.height).toBeLessThanOrEqual(100);
    expect(lastPortCenter.y).toBe(
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
        15 * (prototypeFlowCardLayout.portHeight + prototypeFlowCardLayout.portGap) +
        prototypeFlowCardLayout.portHeight / 2
    );
    expect(wire.path).toContain(`M ${lastPortCenter.x} ${lastPortCenter.y}`);
    expect(editable).toContain(`title="${route}"`);
    expect(editable).toContain(`title="state of ${screenId}"`);
    expect(editable).toContain(`title="${label}"`);
    expect(
      selectPrototypeGraphNodes(graph, {
        startX: node.position.x + 8,
        startY: node.position.y + extent.height - 24,
        endX: node.position.x + extent.width - 8,
        endY: node.position.y + extent.height - 1
      })
    ).toEqual([screenId]);
    expect(
      selectPrototypeGraphNodes(graph, {
        startX: state.position.x + 8,
        startY: state.position.y + stateExtent.height - 24,
        endX: state.position.x + stateExtent.width - 8,
        endY: state.position.y + stateExtent.height - 1
      })
    ).toEqual([stateId]);
  });

  it('reflows a maximum valid action label into a full-height semantic target', () => {
    const longPortLabel = 'W'.repeat(160);
    const longPortGraph = parsePrototypeGraph({
      ...prototypeGraphFixture,
      nodes: prototypeGraphFixture.nodes.map((node) =>
        node.id === 'orders'
          ? {
              ...node,
              ports: node.ports.map((port) =>
                port.id === 'create' ? { ...port, label: longPortLabel } : port
              )
            }
          : node
      )
    });
    const orders = longPortGraph.nodes.find((node) => node.id === 'orders');
    if (!orders) throw new Error('Long-label fixture requires the Orders node.');
    const bounds = prototypeFlowGraphBounds(longPortGraph.nodes);
    const longPortCenter = prototypeFlowPortCenter(orders, 'create', bounds);
    const markup = renderToStaticMarkup(
      createElement(PrototypeFlowCanvas, { graph: longPortGraph, onGraphChange: () => undefined })
    );

    expect(prototypeFlowPortHeight(longPortLabel)).toBeGreaterThan(
      prototypeFlowCardLayout.portHeight
    );
    expect(prototypeFlowNodeExtent(orders).height).toBeGreaterThan(
      prototypeFlowNodeExtent(prototypeGraphFixture.nodes[0]!).height
    );
    expect(longPortCenter?.y).toBeGreaterThan(0);
    expect(longPortCenter?.y).toBeLessThan(prototypeFlowNodeExtent(orders).height);
    expect(markup).toContain(`aria-label="${longPortLabel} action port"`);
    expect(markup).toContain(
      `--prototype-flow-port-height:${prototypeFlowPortHeight(longPortLabel)}px`
    );
    expect(markup).toContain(`>${longPortLabel}</span>`);
  });

  it('caps schema-max label work and preserves named readonly edges after saturation', () => {
    const [screen] = prototypeGraphFixture.nodes;
    const transition = prototypeGraphFixture.transitions.find(
      (candidate) => candidate.kind === 'navigate' && 'to' in candidate
    );
    const scenario = prototypeGraphFixture.scenarios[0];
    if (!screen || !transition || !scenario)
      throw new Error('Prototype fixture screen, navigation, and scenario are required.');
    const nodes = Array.from({ length: 500 }, (_nodePlaceholder, nodeIndex) => ({
      ...screen,
      id: `node-${nodeIndex}`,
      label: `Node ${nodeIndex}`,
      route: `/node-${nodeIndex}`,
      position: { x: (nodeIndex % 25) * 320, y: Math.floor(nodeIndex / 25) * 320 },
      ports: Array.from({ length: 4 }, (_portPlaceholder, portIndex) => ({
        id: `port-${portIndex}`,
        label: `Action ${portIndex}`,
        trigger: 'click' as const
      }))
    }));
    const graph = parsePrototypeGraph({
      ...prototypeGraphFixture,
      initialNodeId: nodes[0]!.id,
      nodes,
      transitions: nodes.flatMap((node, nodeIndex) =>
        node.ports.map((port, portIndex) => ({
          ...transition,
          id: `edge-${nodeIndex}-${portIndex}`,
          from: { nodeId: node.id, portId: port.id },
          to: { nodeId: nodes[(nodeIndex + 1) % nodes.length]!.id }
        }))
      ),
      scenarios: [
        {
          ...scenario,
          id: 'max-schema-scenario',
          startNodeId: nodes[0]!.id,
          expectedPath: [nodes[0]!.id]
        }
      ]
    });
    const report = layoutPrototypeWiresWithStats(graph, prototypeFlowGraphBounds(graph.nodes));
    const suppressed = [...report.layouts.entries()].find(
      ([, layout]) => layout.label === undefined
    );
    if (!suppressed) throw new Error('The deterministic global work budget must suppress a label.');
    const [edgeId] = suppressed;
    const edge = graph.transitions.find((candidate) => candidate.id === edgeId);
    if (!edge) throw new Error('Suppressed edge must remain in the valid graph.');
    const readonly = renderToStaticMarkup(
      createElement(PrototypeFlowCanvas, { graph, readOnly: true })
    );

    expect(report.layouts.size).toBe(2_000);
    expect(report.work).toBeLessThanOrEqual(prototypeFlowLabelLayoutWorkBudget);
    expect(report.budget).toBe(prototypeFlowLabelLayoutWorkBudget);
    expect(report.saturated).toBe(true);
    expect(readonly).toContain(`data-prototype-wire="${edgeId}"`);
    expect(readonly).toContain(`aria-label="${edge.from.nodeId}.${edge.from.portId} → `);
    expect(readonly).toContain('(navigate) edge"');
    expect(readonly).toContain('<title>');
  });
});

describe('prototype flow graph editing', () => {
  it('keeps fitted wheel zoom gradual below the manual readability floor and bounds it', () => {
    expect(nextPrototypeFlowWheelZoom(0.5, -10)).toBe(0.51);
    expect(nextPrototypeFlowWheelZoom(0.86, -10)).toBe(0.87);
    expect(nextPrototypeFlowWheelZoom(0.5, 10)).toBe(0.5);
    expect(nextPrototypeFlowWheelZoom(0.9, 10)).toBe(0.89);
    expect(nextPrototypeFlowWheelZoom(2.99, -20)).toBe(3);
  });

  it('moves a node through the portable graph so the host callback can persist it', () => {
    const original = prototypeGraphFixture.nodes.find((node) => node.id === 'orders')!;
    const moved = movePrototypeGraphNode(prototypeGraphFixture, original.id, { x: 740, y: 360 });

    expect(moved.nodes.find((node) => node.id === original.id)?.position).toEqual({
      x: 740,
      y: 360
    });
    expect(prototypeGraphFixture.nodes.find((node) => node.id === original.id)?.position).toEqual(
      original.position
    );
    expect(moved.transitions).toEqual(prototypeGraphFixture.transitions);
  });

  it('rejects positions outside the portable graph contract', () => {
    expect(() =>
      movePrototypeGraphNode(prototypeGraphFixture, prototypeGraphFixture.initialNodeId, {
        x: 100_001,
        y: 0
      })
    ).toThrow(/position/);
  });

  it('selects only cards actually touched by a graph-space box', () => {
    expect(
      selectPrototypeGraphNodes(prototypeGraphFixture, {
        startX: -10,
        startY: -10,
        endX: 240,
        endY: 210
      })
    ).toEqual(['orders']);
    expect(
      selectPrototypeGraphNodes(prototypeGraphFixture, {
        startX: -10,
        startY: -10,
        endX: 600,
        endY: 500
      })
    ).toEqual(['orders', 'new-order', 'orders-empty']);
  });

  it('includes viewport scroll when converting a pointer to graph coordinates', () => {
    expect(
      graphCanvasPosition(
        { x: 170, y: 135 },
        { left: 20, top: 30, width: 600, height: 400, scrollLeft: 200, scrollTop: 100 },
        { x: 40, y: 20 },
        2,
        { minX: -80, minY: -120 }
      )
    ).toEqual({ x: 75, y: -27.5 });
  });

  it('uses the final pointer-up coordinate rather than the preceding move while scrolled and zoomed', () => {
    const viewport = {
      left: 20,
      top: 30,
      width: 600,
      height: 400,
      scrollLeft: 200,
      scrollTop: 100
    };
    const pan = { x: 40, y: 20 };
    const bounds = { minX: -80, minY: -120 };
    const drag = { offsetX: 12, offsetY: 8 };
    const lastMove = graphCanvasPosition({ x: 170, y: 135 }, viewport, pan, 2, bounds);
    const pointerUp = graphCanvasPosition({ x: 230, y: 195 }, viewport, pan, 2, bounds);

    expect(prototypeNodeDragPosition(pointerUp, drag)).toEqual({ x: 93, y: -5 });
    expect(prototypeNodeDragPosition(pointerUp, drag)).not.toEqual(
      prototypeNodeDragPosition(lastMove, drag)
    );
  });

  it('keeps history exact when a graph save is rejected', () => {
    const history = { past: [prototypeGraphFixture], future: [] };
    expect(
      settlePrototypeFlowHistory(history, { type: 'commit', before: prototypeGraphFixture }, false)
    ).toBe(history);
    expect(
      settlePrototypeFlowHistory(history, { type: 'undo', current: prototypeGraphFixture }, false)
    ).toBe(history);
  });

  it('derives the overview rectangle from the current visible viewport', () => {
    expect(
      graphOverviewViewport(
        { width: 200, height: 100, scrollLeft: 120, scrollTop: 80 },
        { x: 20, y: 10 },
        2,
        { minX: -80, minY: -120, width: 800, height: 400 }
      )
    ).toEqual({ left: 6.25, top: 8.75, width: 12.5, height: 12.5 });
  });

  it('clears an armed connector after pointer cancel or lost capture', () => {
    expect(
      cancelPrototypeConnectorDrag({
        nodeId: 'dashboard',
        portId: 'open-orders',
        x: 180,
        y: 42
      })
    ).toBeUndefined();
  });

  it('traps deletion-dialog focus and wraps it in both directions', () => {
    expect(nextPrototypeDialogFocusIndex(2, 1, false)).toBe(0);
    expect(nextPrototypeDialogFocusIndex(2, 0, true)).toBe(1);
    expect(nextPrototypeDialogFocusIndex(2, 0, false)).toBe(0);
  });

  it('settles synchronous callback throws as promise rejections', async () => {
    await expect(
      invokePrototypeFlowCallback(() => {
        throw new Error('host rejected');
      })
    ).rejects.toThrow('host rejected');
  });

  it('isolates the graph background whenever deletion confirmation is open', () => {
    expect(prototypeFlowModalIsolation(true)).toEqual({ active: true, backgroundInert: true });
    expect(prototypeFlowModalIsolation(false)).toEqual({ active: false, backgroundInert: false });
  });

  it('allows only one run callback and ignores an old completion after a newer token', () => {
    const first = beginPrototypeRun({ nextToken: 0 });
    if (!first) throw new Error('first run should start');
    expect(beginPrototypeRun(first.gate)).toBeUndefined();
    const settledFirst = settlePrototypeRun(first.gate, first.token);
    expect(settledFirst.current).toBe(true);
    const second = beginPrototypeRun(settledFirst.gate);
    if (!second) throw new Error('second run should start after the first settles');
    expect(second.token).toBeGreaterThan(first.token);
    expect(settlePrototypeRun(second.gate, first.token).current).toBe(false);
    expect(settlePrototypeRun(second.gate, second.token).current).toBe(true);
  });

  it('renders editable and readonly canvas affordances from the same portable graph', () => {
    const editable = renderToStaticMarkup(
      createElement(PrototypeFlowCanvas, {
        graph: prototypeGraphFixture,
        onGraphChange: () => undefined,
        onRunCommitted: () => undefined
      })
    );
    const readonly = renderToStaticMarkup(
      createElement(PrototypeFlowCanvas, { graph: prototypeGraphFixture, readOnly: true })
    );

    expect(editable).toContain('Run committed graph in Preview');
    expect(readonly).toContain(
      'prototype-flow__content prototype-flow__content--inspector-collapsed'
    );
    expect(editable).toContain('Graph properties and keyboard fallback');
    expect(editable).toMatch(
      /prototype-flow__side-panel[^>]*hidden=""[^>]*inert=""[^>]*aria-hidden="true"/
    );
    expect(editable).toContain('Flow toolbar');
    expect(editable).toContain('Graph history');
    expect(editable).toContain('Graph clipboard');
    expect(editable).toContain('Show Inspector');
    expect(editable).toContain('Select a card or wire');
    expect(editable).toContain('Graph overview with');
    expect(editable).toMatch(
      /prototype-flow__side-panel[\s\S]*prototype-flow__inspector[\s\S]*prototype-flow__panel-disclosure/
    );
    expect(editable).toContain('Transition editor');
    expect(editable).toContain('Create order action port');
    expect(readonly).not.toContain('Transition editor');
    expect(readonly).not.toContain('Create order action port');
    expect(readonly).not.toContain('Graph properties and keyboard fallback');
    expect(readonly).toContain('Graph connection edges');
  });
});
