import { describe, expect, it } from 'vitest';

import * as collaboration from '@selene/collaboration';
import * as identity from '@selene/collaboration/identity';
import * as service from '@selene/collaboration/service';

describe('collaboration source aliases', () => {
  it('loads every public collaboration entry point without dist output', () => {
    expect(Object.keys(collaboration)).not.toHaveLength(0);
    expect(Object.keys(identity)).not.toHaveLength(0);
    expect(Object.keys(service)).not.toHaveLength(0);
  });
});
