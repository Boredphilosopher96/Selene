import { describe, expect, it } from 'vitest';
import { threadCardFocusRequest, threadCardPlacement } from './artifact-thread-card-placement';

const canvas = { left: 8, top: 84, width: 918, height: 808 };
const viewport = { width: 1280, height: 900 };

describe('bounded screen-space review card placement', () => {
  it('repairs the real top56/canvas84 hidden-card regression without dropping containment', () => {
    const card = { left: 108, top: 56.04583740234375, width: 292, height: 251.90625 };
    const placement = threadCardPlacement(card, canvas, viewport)!;
    expect(placement.offsetX).toBe(0);
    expect(card.top + placement.offsetY).toBe(92);
    expect(card.top + placement.offsetY + card.height).toBeLessThanOrEqual(884);
    expect(placement.maxWidth).toBe(902);
    expect(placement.maxHeight).toBe(792);
    expect(
      threadCardPlacement({ ...card, top: card.top + placement.offsetY }, canvas, viewport)?.offsetY
    ).toBe(0);
  });

  it('keeps the repaired card below the actual flow-plane toolbar boundary', () => {
    const card = { left: 108, top: 56.04583740234375, width: 292, height: 251.90625 };
    const usableFlow = { left: 8, top: 132, width: 918, height: 712 };
    const placement = threadCardPlacement(card, usableFlow, viewport)!;
    expect(card.top + placement.offsetY).toBe(140);
    expect(placement.visibleCanvas.top).toBeGreaterThan(canvas.top);
    expect(card.top + placement.offsetY + card.height).toBeLessThan(844);
  });

  it.each([
    { left: -100, top: -100, width: 292, height: 252 },
    { left: 1000, top: 1000, width: 292, height: 252 },
    { left: 100, top: 100, width: 1200, height: 1200 }
  ])('clamps every edge and oversized content into the visible canvas: %j', (card) => {
    const placement = threadCardPlacement(card, canvas, viewport)!;
    const visible = placement.visibleCanvas;
    const left = card.left + placement.offsetX;
    const top = card.top + placement.offsetY;
    expect(left).toBeGreaterThanOrEqual(visible.left);
    expect(top).toBeGreaterThanOrEqual(visible.top);
    expect(left + Math.min(card.width, placement.maxWidth)).toBeLessThanOrEqual(
      visible.left + visible.width
    );
    expect(top + Math.min(card.height, placement.maxHeight)).toBeLessThanOrEqual(
      visible.top + visible.height
    );
  });

  it('limits compact/partly offscreen canvases to their viewport intersection', () => {
    const placement = threadCardPlacement(
      { left: 250, top: 100, width: 292, height: 460 },
      { left: 300, top: 84, width: 500, height: 808 },
      { width: 620, height: 760 }
    )!;
    expect(placement.visibleCanvas).toEqual({ left: 308, top: 92, width: 304, height: 660 });
    expect(placement.offsetX).toBe(58);
    expect(placement.offsetY).toBe(0);
  });

  it('recomputes freely after resize/pan instead of retaining a smaller prior constraint', () => {
    const card = { left: 108, top: 56, width: 292, height: 460 };
    const compact = threadCardPlacement(
      card,
      { left: 100, top: 84, width: 200, height: 300 },
      viewport
    )!;
    const wide = threadCardPlacement(card, canvas, viewport)!;
    expect(compact.maxWidth).toBe(184);
    expect(compact.maxHeight).toBe(284);
    expect(wide.maxWidth).toBe(902);
    expect(wide.maxHeight).toBe(792);
  });

  it.each([NaN, Infinity, -1, 0])('refuses unusable canvas dimensions %s', (width) => {
    expect(
      threadCardPlacement(
        { left: 100, top: 100, width: 292, height: 252 },
        { ...canvas, width },
        viewport
      )
    ).toBeUndefined();
  });
  it('does not invent stable geometry for a departed/offscreen canvas', () => {
    expect(
      threadCardPlacement(
        { left: 100, top: 100, width: 292, height: 252 },
        { ...canvas, left: 1300 },
        viewport
      )
    ).toBeUndefined();
  });
});

describe('review card focus ownership', () => {
  it('focuses only a new thread or explicit request, never a same-thread reply snapshot', () => {
    const first = threadCardFocusRequest('review-1', undefined, undefined, false);
    expect(first.focus).toBe(true);
    expect(threadCardFocusRequest('review-1', undefined, first.key, false).focus).toBe(false);
    expect(threadCardFocusRequest('review-1', 1, first.key, false).focus).toBe(true);
    expect(threadCardFocusRequest('review-2', undefined, first.key, false).focus).toBe(true);
  });
  it('consumes an explicit request while preserving ongoing text input', () => {
    const blocked = threadCardFocusRequest('review-1', 1, undefined, true);
    expect(blocked.focus).toBe(false);
    expect(threadCardFocusRequest('review-1', 1, blocked.key, false).focus).toBe(false);
  });
});
