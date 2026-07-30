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
    expect(
      artifactSelectionAnchor(selection({ left: 120, top: 80, width: 240, height: 48 }), {
        width: 1200,
        height: 800
      })
    ).toEqual({
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.06,
      viewport: { width: 1200, height: 800 },
      nodeRef: 'orders.action'
    });
  });

  it('clips a partially off-canvas mapped region to the preview viewport', () => {
    expect(
      artifactSelectionAnchor(selection({ left: -40, top: 760, width: 120, height: 80 }), {
        width: 1200,
        height: 800
      })
    ).toMatchObject({
      x: 0,
      y: 0.95,
      width: 80 / 1200,
      height: 0.05
    });
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
  });
});
