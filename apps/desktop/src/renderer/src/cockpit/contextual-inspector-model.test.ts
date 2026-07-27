import { describe, expect, it } from 'vitest';

import type { DesignerSnapshot } from '../../../shared/designer-api';
import { deriveInspectorSelection, normalizedPercent } from './contextual-inspector-model';

const snapshot = {
  selectedNodeId: undefined,
  nodes: [{ nodeId: 'total', path: 'src/orders/OrderTotal.tsx', exportName: 'OrderTotal' }],
  artifactPins: [
    {
      id: 'pin-total',
      label: 'Order total',
      createdAt: '2026-07-25T00:00:00.000Z',
      anchor: {
        x: 0.72,
        y: 0.58,
        width: 0.2,
        height: 0.1,
        viewport: { width: 1200, height: 800 },
        nodeRef: 'total'
      }
    }
  ],
  componentCatalog: { entries: [{ component: 'OrderTotal', href: '#order-total' }] }
} as unknown as DesignerSnapshot;

describe('contextual inspector model', () => {
  it('joins only selected pin geometry with host node and catalog metadata', () => {
    expect(
      deriveInspectorSelection({
        snapshot,
        selectedArtifactPinId: 'pin-total',
        aiTarget: undefined,
        reviewTarget: undefined
      })
    ).toMatchObject({
      node: { nodeId: 'total', path: 'src/orders/OrderTotal.tsx', exportName: 'OrderTotal' },
      target: { x: 0.72, y: 0.58, nodeRef: 'total' },
      targetOrigin: 'review pin',
      catalogEntry: { component: 'OrderTotal', href: '#order-total' }
    });
  });

  it('keeps an active target node reference authoritative over a stale snapshot selection', () => {
    const selected = deriveInspectorSelection({
      snapshot: { ...snapshot, selectedNodeId: 'total' },
      selectedArtifactPinId: undefined,
      aiTarget: { x: 0.1, y: 0.2, viewport: { width: 800, height: 600 }, nodeRef: 'other' },
      reviewTarget: undefined
    });
    expect(selected.node).toBeUndefined();
    expect(selected.target?.nodeRef).toBe('other');
    expect(normalizedPercent(0.725)).toBe('72.5%');
  });

  it('does not borrow snapshot component metadata for a free spatial target', () => {
    const selected = deriveInspectorSelection({
      snapshot: { ...snapshot, selectedNodeId: 'total' },
      selectedArtifactPinId: undefined,
      aiTarget: { x: 0.1, y: 0.2, width: 0.3, height: 0.15, viewport: { width: 800, height: 600 } },
      reviewTarget: undefined
    });
    expect(selected.node).toBeUndefined();
    expect(selected.catalogEntry).toBeUndefined();
    expect(selected.target).toMatchObject({ x: 0.1, y: 0.2, width: 0.3, height: 0.15 });
  });

  it('uses the durable snapshot selection when no transient spatial target exists', () => {
    const selected = deriveInspectorSelection({
      snapshot: { ...snapshot, selectedNodeId: 'total' },
      selectedArtifactPinId: undefined,
      aiTarget: undefined,
      reviewTarget: undefined
    });
    expect(selected.node?.nodeId).toBe('total');
    expect(selected.target).toBeUndefined();
  });
});
