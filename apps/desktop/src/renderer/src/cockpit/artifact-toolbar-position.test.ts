import { describe, expect, it } from 'vitest';

import { artifactToolbarScreenNudge } from './artifact-toolbar-position';

describe('artifactToolbarScreenNudge', () => {
  const viewport = { left: 100, right: 900 };

  it('leaves an in-bounds toolbar in place', () => {
    expect(artifactToolbarScreenNudge({ left: 200, right: 500 }, viewport)).toBe(0);
  });

  it('docks a clipped toolbar to the leading gutter', () => {
    expect(artifactToolbarScreenNudge({ left: -120, right: 440 }, viewport)).toBe(228);
  });

  it('docks a clipped toolbar to the trailing gutter', () => {
    expect(artifactToolbarScreenNudge({ left: 500, right: 980 }, viewport)).toBe(-88);
  });

  it('keeps the leading controls reachable when the toolbar is wider than the canvas', () => {
    expect(artifactToolbarScreenNudge({ left: -200, right: 700 }, viewport)).toBe(308);
  });
});
