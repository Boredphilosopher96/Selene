import { describe, expect, it } from 'vitest';

import type { DesignerSnapshot } from '../../../shared/designer-api';
import type { PreviewElementTelemetry } from '../../../shared/preview-channel';
import {
  computedCssSnippet,
  devModeAiClipboard,
  deriveInspectorSelection,
  normalizedPercent,
  reactSourceReference,
  safeInspectorValue
} from './contextual-inspector-model';

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

const safeTelemetry: PreviewElementTelemetry = {
  hierarchy: [
    { nodeId: 'orders.root', semanticTag: 'main' },
    { nodeId: 'total', semanticTag: 'button' }
  ],
  display: 'flex',
  position: 'relative',
  boxSizing: 'border-box',
  margin: '0px',
  padding: '16px',
  gap: '8px',
  fontFamily: 'Inter',
  fontSize: '14px',
  fontWeight: '400',
  lineHeight: '20px',
  letterSpacing: 'normal',
  color: 'rgb(12, 20, 40)',
  backgroundColor: 'rgb(255, 255, 255)',
  border: '0px none rgb(12, 20, 40)',
  borderRadius: '8px',
  boxShadow: 'none',
  opacity: '1',
  width: 320,
  height: 48,
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'space-between',
  gridTemplateColumns: 'none',
  gridTemplateRows: 'none',
  overflow: 'visible',
  textAlign: 'start',
  textDecoration: 'none',
  semanticTag: 'button',
  explicitAriaRole: '',
  ariaLabel: '',
  accessibleDescription: '',
  ariaDisabled: '',
  ariaExpanded: '',
  ariaPressed: '',
  ariaChecked: '',
  ariaSelected: '',
  ariaHidden: '',
  tabIndex: 0
};

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

  it('fails closed for hostile telemetry and source references before rendering or copying', () => {
    expect(safeInspectorValue('\u001b[31mhttps://provider.example.test\u001b[0m')).toBeUndefined();
    expect(safeInspectorValue('/Users/designer/private/source.tsx')).toBeUndefined();
    expect(
      reactSourceReference({
        nodeId: 'unsafe',
        path: '/Users/designer/private/source.tsx',
        exportName: 'PrivateComponent'
      })
    ).toBeUndefined();
    expect(
      computedCssSnippet({
        hierarchy: [{ nodeId: 'unsafe', semanticTag: 'div' }],
        display: 'block',
        position: 'static',
        boxSizing: 'border-box',
        margin: '0px',
        padding: '0px',
        gap: 'normal',
        fontFamily: 'Inter',
        fontSize: '14px',
        fontWeight: '400',
        lineHeight: '20px',
        letterSpacing: 'normal',
        color: 'rgb(0, 0, 0)',
        backgroundColor: 'url(https://provider.example.test/token)',
        border: '0px none rgb(0, 0, 0)',
        borderRadius: '0px',
        boxShadow: 'none',
        opacity: '1',
        width: 1,
        height: 1,
        flexDirection: 'row',
        alignItems: 'normal',
        justifyContent: 'normal',
        gridTemplateColumns: 'none',
        gridTemplateRows: 'none',
        overflow: 'visible',
        textAlign: 'start',
        textDecoration: 'none',
        semanticTag: 'div',
        explicitAriaRole: '',
        ariaLabel: '',
        accessibleDescription: '',
        ariaDisabled: '',
        ariaExpanded: '',
        ariaPressed: '',
        ariaChecked: '',
        ariaSelected: '',
        ariaHidden: '',
        tabIndex: -1
      })
    ).toBeUndefined();
  });

  it('creates copyable handoff evidence only from bounded computed values and relative sources', () => {
    expect(
      reactSourceReference({
        nodeId: 'total',
        path: 'src/orders/OrderTotal.tsx',
        exportName: 'OrderTotal'
      })
    ).toContain('// Source: src/orders/OrderTotal.tsx');
    expect(safeInspectorValue('rgb(12, 20, 40)')).toBe('rgb(12, 20, 40)');
    expect(computedCssSnippet(safeTelemetry)).toContain('width: 320px;');
    expect(computedCssSnippet(safeTelemetry)).toContain('height: 48px;');
    expect(computedCssSnippet(safeTelemetry)).toContain('align-items: center;');
    expect(computedCssSnippet(safeTelemetry)).toContain('grid-template-columns: none;');
  });

  it('omits every non-selection clipboard branch when its evidence is absent or hostile', () => {
    const absent = devModeAiClipboard({
      selectionLabel: '/Users/designer/private',
      sourceReference: undefined,
      revisionId: 'https://provider.example.test',
      computedCss:
        '/* Computed from the authenticated rendered selection; not authored source. */\n.selected-element {\n  background: url(https://provider.example.test/token);\n}'
    });
    expect(absent).not.toContain('/Users/designer/private');
    expect(absent).not.toContain('provider.example.test');
    expect(absent).not.toContain('background: url');
    expect(absent).toContain('no safe host-confirmed React mapping');

    const sourceOnly = devModeAiClipboard({
      selectionLabel: 'OrderTotal',
      sourceReference:
        '// Host-confirmed React reference\n// Component: OrderTotal\n// Source: src/orders/OrderTotal.tsx',
      revisionId: undefined,
      computedCss: undefined
    });
    expect(sourceOnly).toContain('// Component: OrderTotal');
    expect(sourceOnly).toContain('no safe authenticated computed preview evidence');

    const complete = devModeAiClipboard({
      selectionLabel: 'OrderTotal',
      sourceReference:
        '// Host-confirmed React reference\n// Component: OrderTotal\n// Source: src/orders/OrderTotal.tsx',
      revisionId: 'desktop-r1',
      computedCss:
        '/* Computed from the authenticated rendered selection; not authored source. */\n.selected-element {\n  width: 320px;\n}'
    });
    expect(complete).toContain('authenticated-preview');
    expect(complete).toContain('desktop-r1');
    expect(complete).toContain('width: 320px');
    expect(complete).not.toContain('baseline');
    expect(complete).not.toContain('catalog');
    expect(complete).not.toContain('canvasAnchor');
  });
});
