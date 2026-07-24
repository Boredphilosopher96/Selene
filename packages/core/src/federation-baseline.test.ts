import { describe, expect, it } from 'vitest';

import { createFederatedDesignCatalog } from './federation-baseline';

const current = (projectId: string) => ({
  projectId,
  baselineId: 'b1',
  currency: 'current' as const,
  approvalsStale: false,
  exactChangesToRecheck: []
});

describe('federated generated-design catalog', () => {
  it('covers a shell and two independently owned child projects with baseline status', () => {
    expect(
      createFederatedDesignCatalog('commerce-shell', [
        {
          projectId: 'commerce-shell',
          owner: 'commerce-team',
          baseline: current('commerce-shell')
        },
        { projectId: 'orders', owner: 'orders-team', baseline: current('orders') },
        {
          projectId: 'customer-service',
          owner: 'support-team',
          baseline: current('customer-service')
        }
      ])
    ).toMatchObject({ readyForHandoff: true, blockers: [] });
  });

  it('surfaces precise stale design and approval blockers to developers', () => {
    const catalog = createFederatedDesignCatalog('commerce-shell', [
      { projectId: 'commerce-shell', owner: 'commerce-team', baseline: current('commerce-shell') },
      { projectId: 'orders', owner: 'orders-team', baseline: current('orders') },
      {
        projectId: 'customer-service',
        owner: 'support-team',
        baseline: { ...current('customer-service'), currency: 'stale', approvalsStale: true }
      }
    ]);
    expect(catalog.readyForHandoff).toBe(false);
    expect(catalog.blockers).toEqual([
      expect.objectContaining({ projectId: 'customer-service', kind: 'stale-approval' }),
      expect.objectContaining({ projectId: 'customer-service', kind: 'stale-design' })
    ]);
  });

  it('rejects a baseline status attached to a different federated project', () => {
    expect(() =>
      createFederatedDesignCatalog('commerce-shell', [
        {
          projectId: 'commerce-shell',
          owner: 'commerce-team',
          baseline: current('commerce-shell')
        },
        { projectId: 'orders', owner: 'orders-team', baseline: current('other-project') },
        {
          projectId: 'customer-service',
          owner: 'support-team',
          baseline: current('customer-service')
        }
      ])
    ).toThrow(/must belong to its project/);
  });
});
