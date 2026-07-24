import { describe, expect, it } from 'vitest';

import { exactBunStoreEntry, exactDependencyVersion } from '../../../a11y/bun-store';

describe('Bun package-store resolution used by the desktop accessibility harness', () => {
  it('selects only the manifest-pinned version with its Bun metadata suffix', () => {
    expect(
      exactBunStoreEntry('electron', '43.2.0', [
        'electron@37.4.0+stale37',
        'electron@43.2.0+759ce506b1ed1a42',
        'electron@44.0.0+future44'
      ])
    ).toBe('electron@43.2.0+759ce506b1ed1a42');
  });

  it('rejects missing or ambiguous exact-version entries and non-exact manifest declarations', () => {
    expect(() => exactBunStoreEntry('electron', '43.2.0', ['electron@37.4.0+stale37'])).toThrow(
      /missing exact entry/
    );
    expect(() =>
      exactBunStoreEntry('electron', '43.2.0', [
        'electron@43.2.0+759ce506b1ed1a42',
        'electron@43.2.0+secondhash'
      ])
    ).toThrow(/ambiguous/);
    expect(() =>
      exactBunStoreEntry('electron', '43.2.0', ['electron@43.2.0+759ce506b1ed1a42-junk'])
    ).toThrow(/missing exact entry/);
    expect(() =>
      exactDependencyVersion({ dependencies: { electron: '^43.2.0' } }, 'electron')
    ).toThrow(/exact version/);
  });
});
