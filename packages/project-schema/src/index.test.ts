import { describe, expect, it } from 'vitest';

import {
  componentCatalogManifestSchema,
  executablePrototypeManifestSchema,
  projectSchema
} from './index';

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

  it('exposes generated-design baseline currency and exact stale recheck entries in project status', () => {
    expect(
      projectSchema.safeParse({
        ...validProject,
        status: {
          state: 'active',
          updatedAt: '2026-07-23T20:00:00Z',
          designBaseline: {
            baselineId: 'baseline-1',
            revisionId: 'revision-2',
            currency: 'stale',
            approvalsStale: true,
            exactChangesToRecheck: [
              {
                id: 'change-1',
                kind: 'token',
                beforeRevisionId: 'revision-1',
                currentRevisionId: 'revision-2',
                projectId: 'orders',
                screenIds: ['orders-list'],
                routePaths: ['/orders'],
                scenarioIds: ['empty'],
                componentIds: ['OrdersList'],
                stableNodeIds: ['commerce.orders.root'],
                reason: 'Token spacing changed.'
              }
            ]
          }
        }
      }).success
    ).toBe(true);
    expect(
      projectSchema.safeParse({
        ...validProject,
        status: {
          state: 'active',
          updatedAt: 'x',
          designBaseline: { currency: 'stale', approvalsStale: true }
        }
      }).success
    ).toBe(false);
  });
});

describe('separate generated artifact schemas', () => {
  const source = { path: 'src/OrdersPage.tsx', exportName: 'OrdersPage', revision: 'r2' };
  const designSystem = [
    { packageName: '@acme/design-system', version: '1.2.0', tokenSource: '@acme/tokens@1.2.0' }
  ];

  it('requires an executable React manifest with local fixtures and no network/backend adapter', () => {
    const prototype = {
      format: 'selene-executable-prototype/v1',
      schemaVersion: '1.0',
      projectId: 'orders',
      provenance: { generator: 'selene', revision: 'r2', generatedAt: '2026-07-24T12:00:00Z' },
      designSystem,
      runtime: { rendering: 'react', network: 'forbidden', backend: 'simulated' },
      screens: [{ id: 'orders', route: '/orders', componentId: 'orders-page', source }],
      actionGraph: {
        format: 'selene-prototype-graph/v1',
        source: { path: 'src/flow.ts', revision: 'r2' },
        actionPorts: [{ screenId: 'orders', nodeId: 'orders', portId: 'create', event: 'click' }]
      },
      fixtureDatasets: [
        {
          id: 'orders-fixture',
          source: { path: 'src/fixtures.ts', revision: 'r2' },
          deterministic: true
        }
      ],
      scenarios: [
        {
          id: 'orders-success',
          screenId: 'orders',
          fixtureDatasetId: 'orders-fixture',
          state: 'success',
          expectedRoute: '/orders'
        }
      ],
      traceability: [
        {
          screenId: 'orders',
          componentId: 'orders-page',
          storyId: 'orders-page-success',
          actionPortId: 'create'
        }
      ]
    };
    expect(executablePrototypeManifestSchema.safeParse(prototype).success).toBe(true);
    expect(
      executablePrototypeManifestSchema.safeParse({
        ...prototype,
        runtime: { ...prototype.runtime, network: 'allowed' }
      }).success
    ).toBe(false);
  });

  it('accepts real CSF metadata but rejects routes and incomplete required state coverage in a catalog', () => {
    const catalog = {
      format: 'selene-component-catalog/v1',
      schemaVersion: '1.0',
      projectId: 'orders',
      provenance: {
        generator: 'selene',
        revision: 'catalog-r2',
        generatedAt: '2026-07-24T12:00:00Z'
      },
      builtFromPrototypeRevision: 'r2',
      designSystem,
      storybook: {
        url: 'https://storybook.example.test/orders',
        outputDirectory: 'storybook-static',
        buildId: 'catalog-r2'
      },
      components: [
        {
          id: 'orders-page',
          owner: 'orders-team',
          source,
          props: [{ name: 'state', type: 'OrdersPageState', required: true }],
          requiredCoverage: ['loading', 'empty', 'error', 'accessibility'],
          stories: [
            {
              id: 'orders-page-loading',
              file: 'src/OrdersPage.stories.tsx',
              exportName: 'Loading',
              coverage: ['loading', 'accessibility']
            },
            {
              id: 'orders-page-empty',
              file: 'src/OrdersPage.stories.tsx',
              exportName: 'Empty',
              coverage: ['empty']
            },
            {
              id: 'orders-page-error',
              file: 'src/OrdersPage.stories.tsx',
              exportName: 'Error',
              coverage: ['error']
            }
          ]
        }
      ]
    };
    expect(componentCatalogManifestSchema.safeParse(catalog).success).toBe(true);
    expect(componentCatalogManifestSchema.safeParse({ ...catalog, routes: [] }).success).toBe(
      false
    );
    expect(
      componentCatalogManifestSchema.safeParse({
        ...catalog,
        components: [{ ...catalog.components[0], requiredCoverage: ['disabled'] }]
      }).success
    ).toBe(false);
  });
});
