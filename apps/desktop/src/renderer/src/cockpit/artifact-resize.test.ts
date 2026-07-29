import { describe, expect, it } from 'vitest';

import {
  constrainedArtifactDimension,
  keyboardArtifactDimension,
  maximumArtifactDimension,
  minimumArtifactDimension
} from './artifact-resize';

describe('artifact resize constraints', () => {
  it('snaps pointer values and preserves precise modifier values', () => {
    expect(constrainedArtifactDimension(317, true)).toBe(320);
    expect(constrainedArtifactDimension(317, false)).toBe(317);
  });

  it('clamps hostile and out-of-range geometry', () => {
    expect(constrainedArtifactDimension(Number.NaN, true)).toBe(minimumArtifactDimension);
    expect(constrainedArtifactDimension(-10, false)).toBe(minimumArtifactDimension);
    expect(constrainedArtifactDimension(100_000, false)).toBe(maximumArtifactDimension);
  });

  it('provides deterministic fine and coarse keyboard steps', () => {
    expect(keyboardArtifactDimension(320, 1, false)).toBe(321);
    expect(keyboardArtifactDimension(320, -1, true)).toBe(312);
  });
});
