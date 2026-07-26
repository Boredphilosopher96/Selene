import { describe, expect, it } from 'vitest';

import { previewFitScale } from './preview-surface';

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
