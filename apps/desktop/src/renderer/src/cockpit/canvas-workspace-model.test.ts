import { describe, expect, it } from 'vitest';

import { applyCanvasPreviewGesture, canvasShortcutAction } from './canvas-workspace-model';

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

  it('pans the outer canvas from a wheel gesture over the live preview', () => {
    expect(
      applyCanvasPreviewGesture(
        { x: 120, y: -40, zoom: 0.8 },
        { gesture: 'pan', deltaX: 24, deltaY: -18, x: 0.5, y: 0.5 },
        { left: 0, top: 0, width: 1200, height: 800 },
        { left: 120, top: 80, width: 960, height: 680 },
        { minimumZoom: 0.12, maximumZoom: 2 }
      )
    ).toEqual({ x: 96, y: -22, zoom: 0.8 });
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
});
