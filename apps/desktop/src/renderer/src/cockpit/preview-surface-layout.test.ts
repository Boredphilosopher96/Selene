import { describe, expect, it } from 'vitest';

import { previewFitRangeKeyboardZoom, previewFitScale } from './preview-surface';

describe('preview surface fit scale', () => {
  it('lower-clamps a nonzero constrained viewport so inverse-scaled pins stay usable', () => {
    const zoom = previewFitScale({
      viewportWidth: 120,
      viewportHeight: 80,
      artifactWidth: 1440,
      artifactHeight: 900
    });

    const physicalPinSize = 30 * zoom * (1 / zoom);
    expect(zoom).toBe(0.2);
    expect(physicalPinSize).toBeGreaterThanOrEqual(30);
    expect(physicalPinSize).toBeLessThanOrEqual(30.0001);
  });

  it('does not round an intermediate fitted ratio upward into crop', () => {
    const zoom = previewFitScale({
      viewportWidth: 500,
      viewportHeight: 900,
      artifactWidth: 1112,
      artifactHeight: 834
    });

    expect(zoom).toBe(500 / 1112);
    expect(1112 * zoom).toBeLessThanOrEqual(500);
    expect(834 * zoom).toBeLessThanOrEqual(900);
  });
});

describe('preview surface Fit range keyboard transition', () => {
  const range = {
    displayedValue: 0.4,
    minimum: 0.2,
    maximum: 1.5,
    step: 0.1
  } as const;

  it.each([
    ['ArrowRight', 0.5],
    ['ArrowUp', 0.5],
    ['ArrowLeft', 0.3],
    ['ArrowDown', 0.3]
  ] as const)('moves %s one native step from the normalized displayed value', (key, expected) => {
    expect(previewFitRangeKeyboardZoom({ ...range, key })).toBe(expected);
  });

  it('clamps boundary steps and ignores keys that retain native range behavior', () => {
    expect(
      previewFitRangeKeyboardZoom({ ...range, displayedValue: range.minimum, key: 'ArrowLeft' })
    ).toBe(range.minimum);
    expect(
      previewFitRangeKeyboardZoom({ ...range, displayedValue: range.maximum, key: 'ArrowRight' })
    ).toBe(range.maximum);
    expect(previewFitRangeKeyboardZoom({ ...range, key: 'Home' })).toBeUndefined();
  });

  it('uses the physical arrow code when the platform key value is unidentified', () => {
    expect(
      previewFitRangeKeyboardZoom({
        ...range,
        code: 'ArrowRight',
        key: 'Unidentified'
      })
    ).toBe(0.5);
  });
});
