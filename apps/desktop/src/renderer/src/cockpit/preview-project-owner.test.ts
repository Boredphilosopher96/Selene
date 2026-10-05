import { describe, expect, it } from 'vitest';

import { PreviewProjectOwner } from './preview-project-owner';

describe('accepted project preview ownership', () => {
  it('revokes a mounted cockpit immediately on same-project reopen, before the new snapshot commits', () => {
    const authority = new PreviewProjectOwner();
    const mounted = authority.choose('orders');
    const oldCallback = () => authority.isCurrent(mounted);
    expect(oldCallback()).toBe(true);
    const accepted = authority.choose('orders');
    expect(authority.ownsProject('orders')).toBe(true);
    expect(oldCallback()).toBe(false);
    expect(authority.isCurrent(mounted)).toBe(false);
    expect(authority.isCurrent(accepted)).toBe(true);
    expect(accepted.epoch).toBeGreaterThan(mounted.epoch);
    // Committing and invoking the fresh callback can never revive the old one.
    const freshCallback = () => authority.isCurrent(accepted);
    expect(freshCallback()).toBe(true);
    expect(oldCallback()).toBe(false);
  });

  it('preserves current ownership when a chooser is cancelled without accepting a new project', () => {
    const authority = new PreviewProjectOwner();
    const mounted = authority.choose('orders');
    expect(authority.isCurrent(mounted)).toBe(true);
    expect(authority.ownsProject('orders')).toBe(true);
  });

  it('rejects a different project, fabricated identity, and callbacks after accepted failure or unmount', () => {
    const authority = new PreviewProjectOwner();
    const first = authority.choose('orders');
    const second = authority.choose('customers');
    expect(authority.isCurrent(first)).toBe(false);
    expect(authority.ownsProject('orders')).toBe(false);
    expect(authority.isCurrent({ ...second })).toBe(false);
    authority.clear();
    expect(authority.isCurrent(second)).toBe(false);
    expect(authority.ownsProject('customers')).toBe(false);
    const reopened = authority.choose('customers');
    expect(authority.isCurrent(second)).toBe(false);
    expect(authority.isCurrent(reopened)).toBe(true);
  });
});
