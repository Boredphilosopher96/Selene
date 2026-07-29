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
});
