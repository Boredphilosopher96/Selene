import { describe, expect, it } from 'vitest';

import {
  artifactGapPixels,
  maximumArtifactGap,
  nextArtifactGap,
  sourceBackedArtifactGapPixels,
  supportsArtifactAutoLayout
} from './artifact-auto-layout';

describe('artifact auto-layout controls', () => {
  it('recognizes supported flex and grid containers', () => {
    expect(supportsArtifactAutoLayout('flex')).toBe(true);
    expect(supportsArtifactAutoLayout('inline-grid')).toBe(true);
    expect(supportsArtifactAutoLayout('block')).toBe(false);
  });

  it('keeps direct gap stepping limited to one finite pixel value', () => {
    expect(artifactGapPixels('12px')).toBe(12);
    expect(artifactGapPixels('0')).toBe(0);
    expect(artifactGapPixels('var(--space-3)')).toBeUndefined();
    expect(artifactGapPixels('8px 16px')).toBeUndefined();
    expect(artifactGapPixels('normal')).toBeUndefined();
    expect(artifactGapPixels(`${maximumArtifactGap + 1}px`)).toBeUndefined();
  });

  it('provides bounded fine and coarse gap steps', () => {
    expect(nextArtifactGap('12px', 1, false)).toBe('13px');
    expect(nextArtifactGap('12px', -1, true)).toBe('4px');
    expect(nextArtifactGap('0px', -1, false)).toBe('0px');
    expect(nextArtifactGap(`${maximumArtifactGap}px`, 1, true)).toBe(`${maximumArtifactGap}px`);
  });

  it('distinguishes source pixels from token and relative values', () => {
    expect(sourceBackedArtifactGapPixels(12)).toBe(12);
    expect(sourceBackedArtifactGapPixels('12px')).toBe(12);
    expect(sourceBackedArtifactGapPixels('var(--space-3)')).toBeUndefined();
    expect(sourceBackedArtifactGapPixels('1rem')).toBeUndefined();
  });
});
