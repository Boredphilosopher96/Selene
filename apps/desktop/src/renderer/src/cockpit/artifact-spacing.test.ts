import { describe, expect, it } from 'vitest';

import { artifactSpacing } from './artifact-spacing';

describe('artifact spacing measurements', () => {
  it('keeps only the nearest overlapping peer on each side', () => {
    expect(
      artifactSpacing({ left: 100, top: 100, width: 80, height: 60 }, [
        { left: 40, top: 110, width: 40, height: 30 },
        { left: 0, top: 100, width: 20, height: 60 },
        { left: 200, top: 120, width: 50, height: 30 },
        { left: 300, top: 100, width: 40, height: 60 }
      ])
    ).toEqual([
      { axis: 'horizontal', side: 'before', start: 80, cross: 125, length: 20 },
      { axis: 'horizontal', side: 'after', start: 180, cross: 135, length: 20 }
    ]);
  });

  it('measures vertical peers and ignores diagonal or hostile geometry', () => {
    expect(
      artifactSpacing({ left: 100, top: 100, width: 80, height: 60 }, [
        { left: 110, top: 40, width: 20, height: 40 },
        { left: 120, top: 180, width: 40, height: 30 },
        { left: 300, top: 300, width: 20, height: 20 },
        { left: Number.NaN, top: 0, width: 10, height: 10 }
      ])
    ).toEqual([
      { axis: 'vertical', side: 'before', start: 80, cross: 120, length: 20 },
      { axis: 'vertical', side: 'after', start: 160, cross: 140, length: 20 }
    ]);
  });

  it('is deterministic, finite, and bounded to four nearest sides for a large hostile corpus', () => {
    const targets = Array.from({ length: 128 }, (_value, index) => ({
      left: index % 17 === 0 ? Number.NaN : (index % 16) * 24,
      top: index % 19 === 0 ? Number.POSITIVE_INFINITY : Math.floor(index / 16) * 24,
      width: index % 23 === 0 ? -1 : 16,
      height: index % 29 === 0 ? 0 : 16
    }));
    const first = artifactSpacing({ left: 160, top: 120, width: 80, height: 64 }, targets);
    const second = artifactSpacing({ left: 160, top: 120, width: 80, height: 64 }, targets);
    expect(first).toEqual(second);
    expect(first.length).toBeLessThanOrEqual(4);
    expect(
      new Set(first.map((measurement) => `${measurement.axis}:${measurement.side}`)).size
    ).toBe(first.length);
    for (const measurement of first) {
      expect(Number.isFinite(measurement.start)).toBe(true);
      expect(Number.isFinite(measurement.cross)).toBe(true);
      expect(Number.isFinite(measurement.length)).toBe(true);
      expect(measurement.length).toBeGreaterThanOrEqual(0);
    }
  });
});
