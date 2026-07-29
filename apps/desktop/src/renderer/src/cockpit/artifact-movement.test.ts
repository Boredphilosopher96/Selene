import { describe, expect, it } from 'vitest';

import { artifactMove, maximumArtifactMove } from './artifact-movement';

const geometry = {
  element: { left: 37, top: 29, width: 100, height: 60 },
  artboard: { width: 800, height: 600 }
};

describe('artifact movement', () => {
  it('uses an 8px grid unless precise movement is requested', () => {
    expect(artifactMove({ ...geometry, deltaX: 19, deltaY: -13, precise: false })).toMatchObject({
      offset: { left: 16, top: -16 },
      alignment: {}
    });
    expect(artifactMove({ ...geometry, deltaX: 19.4, deltaY: -13.4, precise: true })).toEqual({
      offset: { left: 19, top: -13 },
      alignment: {}
    });
  });

  it('prefers nearby artboard centerlines over the generic grid', () => {
    const centerDelta = 400 - (geometry.element.left + geometry.element.width / 2);
    expect(
      artifactMove({
        ...geometry,
        deltaX: centerDelta,
        deltaY: 80,
        precise: false
      })
    ).toMatchObject({
      offset: { left: centerDelta },
      alignment: { vertical: { kind: 'center', position: 400 } }
    });
  });

  it('aligns edges and fails closed for hostile movement', () => {
    expect(
      artifactMove({
        ...geometry,
        deltaX: -geometry.element.left + 1,
        deltaY: 600 - (geometry.element.top + geometry.element.height),
        precise: false
      })
    ).toEqual({
      offset: {
        left: -geometry.element.left,
        top: 600 - (geometry.element.top + geometry.element.height)
      },
      alignment: {
        vertical: { kind: 'start', position: 0 },
        horizontal: { kind: 'end', position: 600 }
      }
    });
    expect(
      artifactMove({
        ...geometry,
        deltaX: Number.NaN,
        deltaY: Number.POSITIVE_INFINITY,
        precise: true
      })
    ).toEqual({ offset: { left: 0, top: 0 }, alignment: {} });
    expect(
      artifactMove({
        ...geometry,
        deltaX: maximumArtifactMove * 2,
        deltaY: -maximumArtifactMove * 2,
        precise: true
      })
    ).toEqual({
      offset: { left: maximumArtifactMove, top: -maximumArtifactMove },
      alignment: {}
    });
  });
});
