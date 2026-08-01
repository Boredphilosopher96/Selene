import { describe, expect, it } from 'vitest';

import { previewSelectionPoint } from './preview-channel';

describe('previewSelectionPoint', () => {
  it('accepts only finite normalized coordinate-only Design-plane commands', () => {
    expect(previewSelectionPoint({ x: 0, y: 1 })).toEqual({ x: 0, y: 1 });
    expect(previewSelectionPoint({ x: 0.375, y: 0.625 })).toEqual({ x: 0.375, y: 0.625 });
  });

  it('rejects out-of-frame, non-finite, and expanded parent commands', () => {
    expect(previewSelectionPoint({ x: -0.01, y: 0.5 })).toBeUndefined();
    expect(previewSelectionPoint({ x: 0.5, y: 1.01 })).toBeUndefined();
    expect(previewSelectionPoint({ x: Number.NaN, y: 0.5 })).toBeUndefined();
    expect(previewSelectionPoint({ x: 0.5, y: Number.POSITIVE_INFINITY })).toBeUndefined();
    expect(previewSelectionPoint({ nodeId: 'designer.action', x: 0.5, y: 0.5 })).toBeUndefined();
  });
});
