import { describe, expect, it } from 'vitest';

import { validateSpatialTarget } from './designer-api';

const viewport = { width: 1100, height: 700 };

describe('validateSpatialTarget', () => {
  it('accepts points and bounded, non-zero regions', () => {
    expect(validateSpatialTarget({ x: 0, y: 1, viewport })).toEqual({ x: 0, y: 1, viewport });
    expect(validateSpatialTarget({ x: 0.2, y: 0.3, width: 0.5, height: 0.4, viewport })).toEqual({
      x: 0.2,
      y: 0.3,
      width: 0.5,
      height: 0.4,
      viewport
    });
  });

  it('requires paired, non-zero region dimensions within the normalized artifact', () => {
    expect(() => validateSpatialTarget({ x: 0.1, y: 0.1, width: 0.2, viewport })).toThrow(
      /provided together/
    );
    expect(() =>
      validateSpatialTarget({ x: 0.1, y: 0.1, width: 0, height: 0.2, viewport })
    ).toThrow(/non-zero/);
    expect(() =>
      validateSpatialTarget({ x: 0.9, y: 0.1, width: 0.2, height: 0.2, viewport })
    ).toThrow(/within normalized bounds/);
    expect(() =>
      validateSpatialTarget({ x: 0.1, y: 0.9, width: 0.2, height: 0.2, viewport })
    ).toThrow(/within normalized bounds/);
  });
});
