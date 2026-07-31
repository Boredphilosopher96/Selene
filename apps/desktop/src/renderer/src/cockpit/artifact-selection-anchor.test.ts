import { describe, expect, it } from 'vitest';

import type { PreviewMappedElementTelemetrySelection } from '../../../shared/preview-channel';
import { artifactSelectionAnchor } from './artifact-selection-anchor';

function selection(
  geometry: Readonly<{ left: number; top: number; width: number; height: number }>
): PreviewMappedElementTelemetrySelection {
  return {
    provenance: 'authenticated-preview-node',
    nodeId: 'orders.action',
    revisionId: 'revision-1',
    values: {
      hierarchy: [],
      alignmentTargets: [],
      ...geometry,
      display: 'inline-flex',
      position: 'absolute',
      boxSizing: 'border-box',
      margin: '0px',
      padding: '8px',
      gap: '4px',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gridTemplateColumns: 'none',
      gridTemplateRows: 'none',
      overflow: 'visible',
      fontFamily: 'system-ui',
      fontSize: '14px',
      fontWeight: '600',
      lineHeight: '20px',
      letterSpacing: 'normal',
      textAlign: 'center',
      textDecoration: 'none',
      color: 'rgb(0, 0, 0)',
      backgroundColor: 'rgb(255, 255, 255)',
      border: '0px none rgb(0, 0, 0)',
      borderRadius: '0px',
      boxShadow: 'none',
      opacity: '1',
      semanticTag: 'button',
      explicitAriaRole: '',
      ariaLabel: '',
      accessibleDescription: '',
      ariaDisabled: '',
      ariaExpanded: '',
      ariaPressed: '',
      ariaChecked: '',
      ariaSelected: '',
      ariaHidden: '',
      tabIndex: 0
    }
  };
}

describe('artifactSelectionAnchor', () => {
  it('normalizes the exact mapped region and preserves its compiler identity', () => {
    const anchor = artifactSelectionAnchor(
      selection({ left: 120, top: 80, width: 240, height: 48 }),
      {
        width: 1200,
        height: 800
      }
    );
    expect(anchor).toMatchObject({
      x: 0.1,
      y: 0.1,
      viewport: { width: 1200, height: 800 },
      nodeRef: 'orders.action'
    });
    expect(anchor?.width).toBeCloseTo(0.2);
    expect(anchor?.height).toBeCloseTo(0.06);
  });

  it('clips a partially off-canvas mapped region to the preview viewport', () => {
    const anchor = artifactSelectionAnchor(
      selection({ left: -40, top: 760, width: 120, height: 80 }),
      {
        width: 1200,
        height: 800
      }
    );
    expect(anchor).toMatchObject({ x: 0, y: 0.95 });
    expect(anchor?.width).toBeCloseTo(80 / 1200);
    expect(anchor?.height).toBeCloseTo(0.05);
  });

  it('refuses geometry without a usable preview viewport or mapped origin', () => {
    expect(
      artifactSelectionAnchor(selection({ left: 0, top: 0, width: 100, height: 40 }), {
        width: 0,
        height: 800
      })
    ).toBeUndefined();
    const missingOrigin = selection({ left: 0, top: 0, width: 100, height: 40 });
    const { left, ...valuesWithoutLeft } = missingOrigin.values;
    expect(left).toBe(0);
    expect(
      artifactSelectionAnchor(
        { ...missingOrigin, values: valuesWithoutLeft },
        { width: 1200, height: 800 }
      )
    ).toBeUndefined();
    for (const hostile of [
      { left: Number.NaN, top: 0, width: 100, height: 40 },
      { left: 0, top: Number.POSITIVE_INFINITY, width: 100, height: 40 },
      { left: 0, top: 0, width: Number.NaN, height: 40 },
      { left: 0, top: 0, width: 100, height: Number.NEGATIVE_INFINITY },
      { left: 0, top: 0, width: 0, height: 40 },
      { left: 0, top: 0, width: 100, height: -1 }
    ]) {
      expect(
        artifactSelectionAnchor(selection(hostile), {
          width: 1200,
          height: 800
        })
      ).toBeUndefined();
    }
  });

  it('keeps a deterministic bounded anchor corpus inside the artifact plane', () => {
    for (const left of [-10_000, -1, 0, 400, 1_200, 10_000]) {
      for (const top of [-10_000, -1, 0, 300, 800, 10_000]) {
        for (const width of [1, 24, 1_200, 10_000]) {
          for (const height of [1, 24, 800, 10_000]) {
            const input = selection({ left, top, width, height });
            const first = artifactSelectionAnchor(input, { width: 1200, height: 800 });
            const second = artifactSelectionAnchor(input, { width: 1200, height: 800 });
            expect(first).toEqual(second);
            expect(first).toBeDefined();
            if (!first) throw new Error('Finite positive geometry must yield an anchor.');
            const { width: anchorWidth, height: anchorHeight } = first;
            if (anchorWidth === undefined || anchorHeight === undefined)
              throw new Error('Mapped element geometry must preserve its bounded region.');
            for (const value of [first.x, first.y, anchorWidth, anchorHeight])
              expect(value).toBeGreaterThanOrEqual(0);
            expect(first.x + anchorWidth).toBeLessThanOrEqual(1);
            expect(first.y + anchorHeight).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });
});
