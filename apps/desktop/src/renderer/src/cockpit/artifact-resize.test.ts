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

  it('respects the authenticated min, max, and rendered parent constraints', () => {
    const constraints = { minimum: 96, maximum: 480, parent: 320 };
    expect(constrainedArtifactDimension(24, false, constraints)).toBe(96);
    expect(constrainedArtifactDimension(512, false, constraints)).toBe(320);
    expect(keyboardArtifactDimension(319, 1, false, constraints)).toBe(320);
  });

  it('provides deterministic fine and coarse keyboard steps', () => {
    expect(keyboardArtifactDimension(320, 1, false)).toBe(321);
    expect(keyboardArtifactDimension(320, -1, true)).toBe(312);
  });

  it('keeps pointer and keyboard dimensions finite and bounded across constraint conflicts', () => {
    const values = [
      Number.NEGATIVE_INFINITY,
      -100_000,
      -1,
      0,
      23.9,
      24,
      31.5,
      4_096,
      100_000,
      Number.POSITIVE_INFINITY,
      Number.NaN
    ];
    const constraints = [
      {},
      { minimum: 96 },
      { maximum: 320 },
      { parent: 240 },
      { minimum: 480, maximum: 120, parent: 64 },
      {
        minimum: Number.NaN,
        maximum: Number.POSITIVE_INFINITY,
        parent: Number.NEGATIVE_INFINITY
      }
    ];
    for (const value of values) {
      for (const constraint of constraints) {
        for (const snap of [false, true]) {
          const first = constrainedArtifactDimension(value, snap, constraint);
          const second = constrainedArtifactDimension(value, snap, constraint);
          expect(first).toBe(second);
          expect(Number.isInteger(first)).toBe(true);
          expect(first).toBeGreaterThanOrEqual(minimumArtifactDimension);
          expect(first).toBeLessThanOrEqual(maximumArtifactDimension);
          for (const direction of [-1, 1] as const) {
            const keyboard = keyboardArtifactDimension(first, direction, snap, constraint);
            expect(Number.isInteger(keyboard)).toBe(true);
            expect(keyboard).toBeGreaterThanOrEqual(minimumArtifactDimension);
            expect(keyboard).toBeLessThanOrEqual(maximumArtifactDimension);
          }
        }
      }
    }
  });
});
