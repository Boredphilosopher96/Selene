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

  it('keeps center alignment visible across fractional-zoom pointer offsets', () => {
    const centerDelta = 400 - (geometry.element.left + geometry.element.width / 2);
    expect(
      artifactMove({
        ...geometry,
        deltaX: centerDelta - 5.8,
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

  it('snaps matching edges and centers to nearby compiler-marked elements', () => {
    expect(
      artifactMove({
        ...geometry,
        deltaX: 168,
        deltaY: 80,
        precise: false,
        alignmentTargets: [{ nodeId: 'peer.card', left: 200, top: 120, width: 100, height: 60 }]
      })
    ).toMatchObject({
      offset: { left: 163 },
      alignment: {
        vertical: { kind: 'center', position: 250, targetNodeId: 'peer.card' }
      }
    });
  });

  it('preserves deterministic bounded command invariants across a hostile delta corpus', () => {
    const deltas = [
      Number.NEGATIVE_INFINITY,
      -maximumArtifactMove * 2,
      -maximumArtifactMove,
      -17.5,
      -0,
      0,
      17.5,
      maximumArtifactMove,
      maximumArtifactMove * 2,
      Number.POSITIVE_INFINITY,
      Number.NaN
    ];
    for (const deltaX of deltas) {
      for (const deltaY of deltas) {
        for (const precise of [false, true]) {
          const input = {
            ...geometry,
            deltaX,
            deltaY,
            precise,
            alignmentTargets: Array.from({ length: 80 }, (_value, index) => ({
              nodeId: `peer-${index}`,
              left: index % 5 === 0 ? Number.NaN : index * 20,
              top: index % 7 === 0 ? Number.POSITIVE_INFINITY : index * 12,
              width: index % 11 === 0 ? -1 : 80,
              height: index % 13 === 0 ? 0 : 40
            }))
          };
          const first = artifactMove(input);
          const second = artifactMove(input);
          expect(first).toEqual(second);
          expect(Number.isFinite(first.offset.left)).toBe(true);
          expect(Number.isFinite(first.offset.top)).toBe(true);
          expect(Math.abs(first.offset.left)).toBeLessThanOrEqual(maximumArtifactMove);
          expect(Math.abs(first.offset.top)).toBeLessThanOrEqual(maximumArtifactMove);
          if (precise) expect(first.alignment).toEqual({});
        }
      }
    }
  });
});
