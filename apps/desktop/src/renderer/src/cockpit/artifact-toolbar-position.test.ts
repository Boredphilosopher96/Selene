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
    ).toEqual({ left: 170, top: 248, vertical: 'below' });
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
    ).toEqual({ left: 170, top: 492, vertical: 'above' });
  });
});
