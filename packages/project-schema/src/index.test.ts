import { describe, expect, it } from 'vitest';

import { projectSchema } from './index';

const checksum = 'a'.repeat(64);

const validProject = {
  schemaVersion: '1.0',
  projectId: 'orders',
  parentProjectId: 'commerce-shell',
  role: 'child',
  status: { state: 'active', updatedAt: '2026-07-23T20:00:00Z' },
  ownership: { nodeIds: ['commerce.orders.root'], nodeIdPrefixes: ['commerce.orders.'] },
  changelog: [{ id: 'orders-1', at: '2026-07-23T20:00:00Z', summary: 'Created Orders surface' }],
  designSystem: [
    { packageName: '@acme/design-system', version: '1.2.0', tokenSource: '@acme/tokens@1.2.0' }
  ],
  screens: [{ id: 'orders-list', name: 'Orders list' }],
  routes: [{ path: '/orders', screenId: 'orders-list' }],
  storybook: [
    { component: 'OrdersList', url: 'https://storybook.example.test/?path=/story/orders' }
  ],
  reactSource: [{ path: 'src/orders.tsx', revision: 'main', checksum }],
  deployment: { mode: 'static', baseUrl: 'https://orders.example.test', outputDirectory: 'dist' }
};

describe('projectSchema', () => {
  it('requires portable ownership, design, screen, route, Storybook, source, and static metadata', () => {
    expect(projectSchema.safeParse(validProject).success).toBe(true);
    expect(projectSchema.safeParse({ ...validProject, routes: [] }).success).toBe(false);
    expect(
      projectSchema.safeParse({
        ...validProject,
        routes: [{ path: '/orders', screenId: 'missing-screen' }]
      }).success
    ).toBe(false);
  });
});
