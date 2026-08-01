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
  it('centers an in-bounds toolbar below the selection', () => {
    expect(
      artifactToolbarScreenPosition(
        { left: 400, top: 200, right: 500, bottom: 240, width: 100, height: 40 },
        toolbar,
        viewport
      )
    ).toEqual({ left: 170, placement: 'below', top: 248 });
  });

  it('docks a left-edge selection to the canvas gutter', () => {
    expect(
      artifactToolbarScreenPosition(
        { left: 110, top: 200, right: 170, bottom: 240, width: 60, height: 40 },
        toolbar,
        viewport
      ).left
    ).toBe(108);
  });

  it('docks a right-edge selection to the canvas gutter', () => {
    expect(
      artifactToolbarScreenPosition(
        { left: 820, top: 200, right: 880, bottom: 240, width: 60, height: 40 },
        toolbar,
        viewport
      ).left
    ).toBe(332);
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
