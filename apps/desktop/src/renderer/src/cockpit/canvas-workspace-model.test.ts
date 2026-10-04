import { describe, expect, it } from 'vitest';

import {
  applyCanvasPreviewGesture,
  canvasShortcutAction,
  canvasConnectionSelectionChanged,
  catalogEntryCanDrag,
  catalogInsertAvailability,
  catalogInsertTarget,
  projectGraphEdges
} from './canvas-workspace-model';

describe('canvas workspace interaction model', () => {
  it('refreshes only changed semantics for a surviving selected connection', () => {
    const previous = {
      projectFence: 'project-a:graph-a',
      selectedEdgeId: 'dashboard-orders',
      signature: 'destination:dashboard'
    };
    const next = { ...previous, signature: 'destination:orders' };
    expect(canvasConnectionSelectionChanged(previous, next)).toBe(true);
    expect(canvasConnectionSelectionChanged(next, previous)).toBe(true);
    expect(canvasConnectionSelectionChanged(next, { ...next })).toBe(false);
    expect(canvasConnectionSelectionChanged(undefined, next)).toBe(false);
    expect(
      canvasConnectionSelectionChanged(previous, { ...next, selectedEdgeId: 'other-edge' })
    ).toBe(false);
    expect(
      canvasConnectionSelectionChanged(previous, { ...next, projectFence: 'project-b:graph-a' })
    ).toBe(false);
  });

  it('retains selected surviving edges across same-graph topology refreshes', () => {
    const current = [
      { id: 'dashboard-orders', source: 'dashboard', target: 'orders', selected: true },
      { id: 'removed', source: 'orders', target: 'dashboard', selected: true }
    ];
    const graphEdges = [
      { id: 'dashboard-orders', source: 'dashboard', target: 'dashboard' },
      { id: 'new-edge', source: 'orders', target: 'dashboard' }
    ];
    const next = projectGraphEdges(graphEdges, current, [], {
      currentFence: 'project-a:graph-a',
      graphFence: 'project-a:graph-a'
    });
    expect(next).toEqual([{ ...graphEdges[0], selected: true }, graphEdges[1]]);
    expect(next.some((edge) => edge.id === 'removed')).toBe(false);
    expect(current[0]?.target).toBe('orders');
  });

  it('honors explicit deselection after a host edge refresh', () => {
    const graphEdges = [{ id: 'dashboard-orders', source: 'dashboard', target: 'dashboard' }];
    const current = [{ ...graphEdges[0]!, selected: true }];
    expect(
      projectGraphEdges(graphEdges, current, [
        { type: 'select', id: 'dashboard-orders', selected: false }
      ])
    ).toEqual([{ ...graphEdges[0], selected: false }]);
  });

  it('resets local edge selection when a project or graph fence changes', () => {
    const graphEdges = [{ id: 'dashboard-orders', source: 'dashboard', target: 'orders' }];
    const current = [{ ...graphEdges[0]!, selected: true }];
    expect(
      projectGraphEdges(graphEdges, current, [], {
        currentFence: 'project-a:graph-a',
        graphFence: 'project-b:graph-a'
      })
    ).toEqual(graphEdges);
    expect(
      projectGraphEdges(graphEdges, current, [], {
        currentFence: 'project-a:graph-a',
        graphFence: 'project-a:graph-b'
      })
    ).toEqual(graphEdges);
  });

  it('reprojects host graph edges after transient flow reset/remove churn', () => {
    type EdgeFixture = {
      id: string;
      source: string;
      target: string;
      selected?: boolean;
    };
    const dashboardOrders: EdgeFixture = {
      id: 'dashboard-orders',
      source: 'dashboard',
      target: 'orders'
    };
    const ordersDashboard: EdgeFixture = {
      id: 'orders-dashboard',
      source: 'orders',
      target: 'dashboard'
    };
    const graphEdges = [dashboardOrders, ordersDashboard];
    expect(
      projectGraphEdges(
        graphEdges,
        [{ ...dashboardOrders, selected: true }],
        [{ type: 'reset' }, { type: 'remove', id: 'dashboard-orders' }]
      )
    ).toEqual([{ ...dashboardOrders, selected: true }, ordersDashboard]);
    expect(
      projectGraphEdges(graphEdges, graphEdges, [
        { type: 'select', id: 'orders-dashboard', selected: true }
      ])
    ).toEqual([dashboardOrders, { ...ordersDashboard, selected: true }]);
  });

  it('matches fit, selection, hand, and escape shortcuts', () => {
    expect(canvasShortcutAction({ key: '1', shiftKey: true, repeat: false })).toBe('fit-all');
    expect(canvasShortcutAction({ key: '0', shiftKey: true, repeat: false })).toBe(
      'reset-viewport'
    );
    expect(canvasShortcutAction({ key: '2', shiftKey: true, repeat: false })).toBe('fit-selection');
    expect(canvasShortcutAction({ key: 'h', shiftKey: false, repeat: false })).toBe('hand-on');
    expect(canvasShortcutAction({ key: 'v', shiftKey: false, repeat: false })).toBe('hand-off');
    expect(canvasShortcutAction({ key: 'Escape', shiftKey: false, repeat: false })).toBe('clear');
  });

  it('keeps pinch zoom anchored beneath the preview pointer and clamps its range', () => {
    const viewport = { x: 30, y: 20, zoom: 0.75 };
    const flowBounds = { left: 10, top: 20, width: 1200, height: 800 };
    const previewBounds = { left: 210, top: 120, width: 960, height: 680 };
    const pointer = {
      x: previewBounds.left + previewBounds.width * 0.25 - flowBounds.left,
      y: previewBounds.top + previewBounds.height * 0.4 - flowBounds.top
    };
    const worldBefore = {
      x: (pointer.x - viewport.x) / viewport.zoom,
      y: (pointer.y - viewport.y) / viewport.zoom
    };
    const next = applyCanvasPreviewGesture(
      viewport,
      { gesture: 'zoom', deltaX: 0, deltaY: -180, x: 0.25, y: 0.4 },
      flowBounds,
      previewBounds,
      { minimumZoom: 0.12, maximumZoom: 0.9 }
    );
    expect(next.zoom).toBe(0.9);
    expect((pointer.x - next.x) / next.zoom).toBeCloseTo(worldBefore.x);
    expect((pointer.y - next.y) / next.zoom).toBeCloseTo(worldBefore.y);
  });

  it('pans the outer canvas for ordinary two-finger motion over the preview', () => {
    expect(
      applyCanvasPreviewGesture(
        { x: 30, y: 20, zoom: 0.75 },
        { gesture: 'pan', deltaX: 45, deltaY: -80, x: 0.25, y: 0.4 },
        { left: 10, top: 20, width: 1200, height: 800 },
        { left: 210, top: 120, width: 960, height: 680 },
        { minimumZoom: 0.12, maximumZoom: 2.4 }
      )
    ).toEqual({ x: -15, y: 100, zoom: 0.75 });
  });

  it('admits drag intent only for configured governed library entries', () => {
    const entry = {
      origin: 'design-system' as const,
      packageName: '@selene/ui',
      version: '1.0.0',
      entrypoint: '.',
      exportName: 'Button',
      artifactDigest: 'a'.repeat(64),
      properties: [{ name: 'label', label: 'Label', control: 'text' as const, required: true }]
    };
    expect(catalogEntryCanDrag(entry, {}, true)).toBe(false);
    expect(catalogEntryCanDrag(entry, { label: 'Checkout' }, true)).toBe(true);
    expect(catalogEntryCanDrag({ ...entry, origin: 'project' }, { label: 'Checkout' }, true)).toBe(
      false
    );
    expect(catalogEntryCanDrag(entry, { label: 'Checkout' }, false)).toBe(false);
  });

  it('keeps renderer drop eligibility subordinate to an authenticated target', () => {
    const entry = {
      origin: 'design-system' as const,
      packageName: '@selene/ui',
      version: '1.0.0',
      entrypoint: '.',
      exportName: 'Button',
      artifactDigest: 'a'.repeat(64)
    };
    expect(
      catalogInsertAvailability(entry, {}, { hostAvailable: true, targetAvailable: false })
    ).toBe('target-required');
    expect(
      catalogInsertAvailability(entry, {}, { hostAvailable: true, targetAvailable: true })
    ).toBe('ready');
    expect(
      catalogInsertAvailability(
        {
          origin: 'design-system',
          packageName: '@selene/ui',
          version: '1.0.0',
          entrypoint: '.',
          exportName: 'Button'
        },
        {},
        { hostAvailable: true, targetAvailable: true }
      )
    ).toBe('provenance-required');
    expect(
      catalogInsertAvailability(
        { origin: 'federated' },
        {},
        { hostAvailable: true, targetAvailable: true }
      )
    ).toBe('federated-reference');
    expect(catalogEntryCanDrag({ origin: 'federated' }, {}, true)).toBe(false);
  });

  it('offers catalog drops only for current authenticated flex or grid containers', () => {
    expect(
      catalogInsertTarget('orders.content', {
        nodeId: 'orders.content',
        layout: 'flex'
      })
    ).toEqual({ kind: 'compatible', nodeId: 'orders.content', layout: 'flex' });
    expect(catalogInsertTarget('orders.title', undefined)).toEqual({
      kind: 'incompatible',
      nodeId: 'orders.title'
    });
    expect(
      catalogInsertTarget(undefined, { nodeId: 'orders.content', layout: 'grid' })
    ).toBeUndefined();
  });
});
