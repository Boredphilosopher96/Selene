import { describe, expect, it } from 'vitest';

import { corePackageName } from './index';

describe('core package', () => {
  it('exports a stable package identifier', () => {
    expect(corePackageName).toBe('@selene/core');
  });
});
