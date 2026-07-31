import { describe, expect, it } from 'vitest';

import {
  applyCanvasPreviewGesture,
  canvasShortcutAction,
  catalogEntryCanDrag,
  catalogInsertAvailability,
  catalogInsertTarget
} from './canvas-workspace-model';

describe('canvas workspace interaction model', () => {
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
