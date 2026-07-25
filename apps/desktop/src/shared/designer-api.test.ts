import { describe, expect, it } from 'vitest';

import {
  assertDesignerApiVersion,
  DESIGNER_API_VERSION,
  isSafeDesignLanguageDisplayLabel,
  validateSpatialTarget
} from './designer-api';

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

describe('desktop designer API version', () => {
  it('accepts the current breaking contract version', () => {
    expect(() => assertDesignerApiVersion(DESIGNER_API_VERSION)).not.toThrow();
  });

  it('rejects stale and unknown host contracts clearly', () => {
    expect(() => assertDesignerApiVersion('selene-desktop-designer/v1')).toThrow(
      /Unsupported desktop designer API version/
    );
    expect(() => assertDesignerApiVersion(undefined)).toThrow(
      /Unsupported desktop designer API version/
    );
  });
});

describe('design-language display labels', () => {
  it('preserves bounded normalized Unicode basenames', () => {
    expect(isSafeDesignLanguageDisplayLabel('設計原則.md')).toBe(true);
    expect(isSafeDesignLanguageDisplayLabel('Règles produit.mdx')).toBe(true);
  });

  it('rejects paths, controls, bidi overrides, non-normalized text, and oversized labels', () => {
    expect(isSafeDesignLanguageDisplayLabel('../DESIGN.md')).toBe(false);
    expect(isSafeDesignLanguageDisplayLabel('folder\\DESIGN.md')).toBe(false);
    expect(isSafeDesignLanguageDisplayLabel('unsafe\u0000.md')).toBe(false);
    expect(isSafeDesignLanguageDisplayLabel('unsafe\u202e.md')).toBe(false);
    expect(isSafeDesignLanguageDisplayLabel('e\u0301.md')).toBe(false);
    expect(isSafeDesignLanguageDisplayLabel(`${'界'.repeat(54)}.md`)).toBe(false);
  });
});
