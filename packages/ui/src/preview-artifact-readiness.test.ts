import { describe, expect, it } from 'vitest';

import { relativeLuminance } from './preview-artifact-readiness';

describe('preview artifact luminance', () => {
  it.each([
    ['rgb(247, 248, 245)'],
    ['rgba(247, 248, 245, 0.98)'],
    // CSSOM may serialize the same numeric color using this modern form.
    ['rgb(247 248 245 / 1)']
  ])('accepts bright numeric CSSOM color %s', (color) => {
    expect(relativeLuminance(color) ?? Number.NEGATIVE_INFINITY).toBeGreaterThanOrEqual(0.5);
  });

  it.each([
    'rgb(247, 248)',
    'rgb(256, 248, 245)',
    'rgb(247 248 245 / 1.01)',
    'rgba(247, 248, 245, 0)',
    'rgb(NaN, 248, 245)',
    'transparent'
  ])('rejects malformed, nonfinite, out-of-range, or transparent color %s', (color) => {
    expect(relativeLuminance(color)).toBeUndefined();
  });

  it('keeps dark colors below the painted-artifact luminance threshold', () => {
    expect(relativeLuminance('rgb(0, 0, 0)') ?? Number.POSITIVE_INFINITY).toBeLessThan(0.5);
  });
});
