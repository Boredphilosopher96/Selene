import { describe, expect, it } from 'vitest';

import { artifactToolbarScreenPosition } from './artifact-toolbar-position';

const viewport = {
  left: 100,
  top: 50,
  right: 900,
  bottom: 650,
  width: 800,
  height: 600
};
const toolbar = { width: 560, height: 80 };

describe('artifactToolbarScreenPosition', () => {
  it('keeps remembered title and summary exposed when neither side fits', () => {
    const title = { left: 375, top: 244, right: 608, bottom: 278, width: 233, height: 34 };
    const summary = { left: 375, top: 288, right: 608, bottom: 307, width: 233, height: 19 };
    for (const right of [926, 768]) {
      const constrained = { left: 8, top: 130, right, bottom: 760, width: right - 8, height: 630 };
      const titlePosition = artifactToolbarScreenPosition(
        title,
        { width: 406, height: 36 },
        constrained,
        8,
        'side',
        [summary]
      );
      const summaryPosition = artifactToolbarScreenPosition(
        summary,
        { width: 406, height: 36 },
        constrained,
        8,
        'side',
        [title]
      );
      expect(titlePosition).toEqual({ left: 288.5, top: 200, placement: 'above' });
      expect(summaryPosition).toEqual({ left: 288.5, top: 315, placement: 'below' });
    }
  });
  it('keeps direct title actions beside the neighboring editable summary', () => {
    const position = artifactToolbarScreenPosition(
      { left: 375, top: 244, right: 608, bottom: 278, width: 233, height: 34 },
      { width: 406, height: 36 },
      { left: 8, top: 130, right: 1172, bottom: 760, width: 1164, height: 630 },
      8,
      'side'
    );
    expect(position).toEqual({ left: 616, top: 243, placement: 'right' });
    expect(position.left).toBeGreaterThan(608);
    const reverse = artifactToolbarScreenPosition(
      { left: 375, top: 288, right: 608, bottom: 307, width: 233, height: 19 },
      { width: 406, height: 36 },
      { left: 8, top: 130, right: 1172, bottom: 760, width: 1164, height: 630 },
      8,
      'side'
    );
    expect(reverse).toEqual({ left: 616, top: 279.5, placement: 'right' });
    expect(reverse.left).toBeGreaterThan(608);
  });

  it('uses a contained side when the preferred upper action lane is unavailable', () => {
    expect(
      artifactToolbarScreenPosition(
        { left: 375, top: 145, right: 608, bottom: 179, width: 233, height: 34 },
        { width: 406, height: 36 },
        { left: 8, top: 130, right: 1172, bottom: 760, width: 1164, height: 630 },
        8,
        'side'
      )
    ).toEqual({ left: 616, top: 144, placement: 'right' });
  });
  it('centers an in-bounds toolbar below the selection', () => {
    expect(
      artifactToolbarScreenPosition(
        { left: 400, top: 200, right: 500, bottom: 240, width: 100, height: 40 },
        toolbar,
        viewport
      )
    ).toEqual({ left: 170, placement: 'below', top: 248 });
  });

  it('docks a left-edge selection on its disjoint right side', () => {
    expect(
      artifactToolbarScreenPosition(
        { left: 110, top: 200, right: 170, bottom: 240, width: 60, height: 40 },
        toolbar,
        viewport
      )
    ).toEqual({ left: 178, placement: 'right', top: 180 });
  });

  it('docks a right-edge selection on its disjoint left side', () => {
    expect(
      artifactToolbarScreenPosition(
        { left: 820, top: 200, right: 880, bottom: 240, width: 60, height: 40 },
        toolbar,
        viewport
      )
    ).toEqual({ left: 252, placement: 'left', top: 180 });
  });

  it('moves above when the selected artifact has more room there', () => {
    expect(
      artifactToolbarScreenPosition(
        { left: 400, top: 580, right: 500, bottom: 620, width: 100, height: 40 },
        toolbar,
        viewport
      )
    ).toEqual({ left: 170, placement: 'above', top: 492 });
  });

  it('uses a disjoint side dock when compact vertical clamping would cross the selection', () => {
    expect(
      artifactToolbarScreenPosition(
        { left: 230, top: 160, right: 290, bottom: 280, width: 60, height: 120 },
        { width: 180, height: 220 },
        { left: 0, top: 0, right: 620, bottom: 360, width: 620, height: 360 }
      )
    ).toEqual({ left: 298, placement: 'right', top: 110 });
  });
});
