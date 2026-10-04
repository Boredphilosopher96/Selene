import { describe, expect, it } from 'vitest';

import { inspectorTabHasUsableGeometry } from './inspector-tab-geometry.mjs';

const tab = {
  visible: true,
  width: 102.65625,
  height: 34,
  clientWidth: 103,
  clientHeight: 34,
  scrollWidth: 103,
  scrollHeight: 34
};

describe('native inspector target and overflow geometry', () => {
  it('accepts the hosted macOS fractional rect with an exact integer scrollport', () => {
    expect(inspectorTabHasUsableGeometry(tab)).toBe(true);
    expect(inspectorTabHasUsableGeometry({ ...tab, width: 102.671875 })).toBe(true);
  });

  it('rejects real inline overflow, even when the outer border box is larger', () => {
    expect(inspectorTabHasUsableGeometry({ ...tab, width: 104, clientWidth: 102 })).toBe(false);
  });

  it('rejects real block overflow', () => {
    expect(inspectorTabHasUsableGeometry({ ...tab, scrollHeight: 35 })).toBe(false);
  });

  it('retains exact physical minimum target dimensions without rounding them up', () => {
    expect(inspectorTabHasUsableGeometry({ ...tab, width: 99.999 })).toBe(false);
    expect(inspectorTabHasUsableGeometry({ ...tab, height: 33.999 })).toBe(false);
  });

  it('rejects hidden targets and invalid or empty scrollport measurements', () => {
    expect(inspectorTabHasUsableGeometry({ ...tab, visible: false })).toBe(false);
    expect(inspectorTabHasUsableGeometry({ ...tab, width: Number.NaN })).toBe(false);
    expect(inspectorTabHasUsableGeometry({ ...tab, clientWidth: 102.5 })).toBe(false);
    expect(inspectorTabHasUsableGeometry({ ...tab, clientHeight: 0 })).toBe(false);
    expect(inspectorTabHasUsableGeometry({ ...tab, scrollWidth: -1 })).toBe(false);
  });
});
