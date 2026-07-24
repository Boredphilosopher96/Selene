import { describe, expect, it } from 'vitest';

import {
  aggregateFederation,
  corePackageName,
  createProject,
  createHandoffBundle,
  executeProjectCommand,
  exportProject,
  FederationCompatibilityError,
  openProject,
  reopenProject,
  serializeHandoffBundle,
  validateFederation
} from './index';

const checksum = 'a'.repeat(64);

function manifest(
  projectId: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    projectId,
    role: projectId === 'commerce-shell' ? 'shell' : 'child',
    ...(projectId === 'commerce-shell' ? {} : { parentProjectId: 'commerce-shell' }),
    status: { state: 'active', updatedAt: '2026-07-23T20:00:00Z' },
    ownership: { nodeIds: [`${projectId}.root`], nodeIdPrefixes: [`${projectId}.`] },
    changelog: [
      { id: `${projectId}-initial`, at: '2026-07-23T20:00:00Z', summary: 'Initial handoff' }
    ],
    designSystem: [
      {
        packageName: '@acme/design-system',
        version: '1.2.0',
        tokenSource: '@acme/tokens@1.2.0'
      }
    ],
    screens: [{ id: `${projectId}-screen`, name: `${projectId} screen` }],
    routes: [{ path: `/${projectId}`, screenId: `${projectId}-screen` }],
    storybook: [
      {
        component: `${projectId}Component`,
        url: `https://storybook.example.test/?path=/${projectId}`
      }
    ],
    reactSource: [
      {
        path: `src/${projectId}.tsx`,
        exportName: `${projectId}Component`,
        revision: 'main',
        checksum
      }
    ],
    deployment: {
      mode: 'static',
      baseUrl: `https://${projectId}.example.test`,
      outputDirectory: 'dist'
    },
    children: projectId === 'commerce-shell' ? ['orders', 'customer-service'] : [],
    ...overrides
  };
}

describe('core package', () => {
  it('exports a stable package identifier', () => {
    expect(corePackageName).toBe('@selene/core');
  });
});

function workspace() {
  return {
    format: 'selene-designer-workspace/v1' as const,
    projectId: 'northstar',
    name: 'Northstar',
    status: 'draft' as const,
    selectedScreenId: 'home',
    selectedState: 'default',
    screens: [
      { id: 'home', name: 'Home', route: '/', states: ['default', 'busy'], nodeIds: ['home.root'] },
      {
        id: 'orders',
        name: 'Orders',
        route: '/orders',
        states: ['default'],
        nodeIds: ['orders.root']
      }
    ],
    comments: [],
    developerDirections: [],
    changelog: [{ id: 'initial', at: '2026-07-23T20:00:00Z', summary: 'Created project' }],
    updatedAt: '2026-07-23T20:00:00Z'
  };
}

describe('portable project commands', () => {
  it('changes screen, state, selected node, comments, directions, and status through typed commands', () => {
    const selected = executeProjectCommand(workspace(), {
      type: 'select-screen',
      screenId: 'orders'
    });
    const nodeSelected = executeProjectCommand(selected, {
      type: 'select-node',
      nodeId: 'orders.root'
    });
    const commented = executeProjectCommand(nodeSelected, {
      type: 'add-comment',
      id: 'comment-1',
      nodeId: 'orders.root',
      body: 'Tighten the empty state.',
      author: 'Mina',
      createdAt: '2026-07-23T20:01:00Z'
    });
    const resolved = executeProjectCommand(commented, {
      type: 'resolve-comment',
      commentId: 'comment-1',
      resolvedAt: '2026-07-23T20:02:00Z'
    });
    const directed = executeProjectCommand(resolved, {
      type: 'add-direction',
      id: 'direction-1',
      body: 'Keep the route transition instant.',
      createdAt: '2026-07-23T20:03:00Z'
    });
    const ready = executeProjectCommand(directed, { type: 'set-status', status: 'ready' });

    expect(ready).toMatchObject({
      selectedScreenId: 'orders',
      selectedNodeId: 'orders.root',
      status: 'ready'
    });
    expect(ready.comments[0]?.resolvedAt).toBe('2026-07-23T20:02:00Z');
    expect(ready.developerDirections[0]?.body).toContain('route transition');
  });

  it('exports, opens, creates, and reopens a project through a local port', async () => {
    const values = new Map<string, string>();
    const persistence = {
      load: async (projectId: string) => values.get(projectId),
      save: async (projectId: string, serialized: string) => void values.set(projectId, serialized)
    };
    const created = await createProject(persistence, workspace());
    const reopened = await reopenProject(persistence, created.projectId);

    expect(openProject(exportProject(created))).toEqual(created);
    expect(reopened).toEqual(created);
  });
});

describe('federation compatibility', () => {
  it('accepts a compatible shell with independently static children', () => {
    const issues = validateFederation(manifest('commerce-shell'), [
      manifest('customer-service'),
      manifest('orders')
    ]);

    expect(issues).toEqual([]);
  });

  it('reports ownership conflicts in a stable order', () => {
    const issues = validateFederation(manifest('commerce-shell'), [
      manifest('orders', {
        ownership: { nodeIds: ['commerce.order.root'], nodeIdPrefixes: ['commerce.order.'] }
      }),
      manifest('customer-service', {
        ownership: {
          nodeIds: ['commerce.customer.root'],
          nodeIdPrefixes: ['commerce.order.detail.']
        }
      })
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: 'ownership-conflict',
      projectIds: ['customer-service', 'orders']
    });
  });

  it('preserves node-ID suffixes that contain colons when checking ownership', () => {
    const issues = validateFederation(manifest('commerce-shell'), [
      manifest('orders', {
        ownership: {
          nodeIds: ['commerce:orders.root'],
          nodeIdPrefixes: ['commerce:orders.']
        }
      }),
      manifest('customer-service', {
        ownership: {
          nodeIds: ['commerce:orders.detail'],
          nodeIdPrefixes: ['commerce:customer-service.']
        }
      })
    ]);

    expect(issues[0]?.code).toBe('ownership-conflict');
  });

  it('rejects a child that is not declared by the shell', () => {
    const issues = validateFederation(manifest('commerce-shell', { children: ['orders'] }), [
      manifest('orders'),
      manifest('customer-service')
    ]);

    expect(issues.map((issue) => issue.code)).toEqual(['shell-children-mismatch']);
  });

  it('rejects incompatible design-system references', () => {
    const issues = validateFederation(manifest('commerce-shell'), [
      manifest('orders'),
      manifest('customer-service', {
        designSystem: [
          {
            packageName: '@acme/design-system',
            version: '2.0.0',
            tokenSource: '@acme/tokens@2.0.0'
          }
        ]
      })
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('design-system-conflict');
  });
});

describe('catalog and handoff aggregation', () => {
  it('aggregates manifests deterministically and emits a data-only downloadable bundle', () => {
    const catalog = aggregateFederation(manifest('commerce-shell'), [
      manifest('orders', { status: { state: 'complete', updatedAt: '2026-07-23T20:01:00Z' } }),
      manifest('customer-service', {
        status: { state: 'blocked', updatedAt: '2026-07-23T20:02:00Z' }
      })
    ]);
    const bundle = createHandoffBundle(catalog, {
      bundleId: 'commerce-handoff-2026-07-23',
      issuedAt: '2026-07-23T21:00:00Z',
      href: 'https://downloads.example.test/commerce-handoff.json',
      sha256: checksum,
      comments: ['Customer Service remains blocked on copy approval.'],
      developerDirections: ['Install the referenced design system before rendering sources.'],
      agentDownload: {
        href: 'https://downloads.example.test/commerce-handoff.agent.json',
        mediaType: 'application/json',
        checksum,
        instructions: 'Read the manifest and source pointers; do not execute remote code.'
      }
    });

    expect(catalog.overallStatus).toBe('blocked');
    expect(catalog.projects.map((project) => project.projectId)).toEqual([
      'commerce-shell',
      'customer-service',
      'orders'
    ]);
    expect(catalog.deployments.every((deployment) => deployment.mode === 'static')).toBe(true);
    expect(bundle.reactSource.map((source) => source.projectId)).toEqual([
      'commerce-shell',
      'customer-service',
      'orders'
    ]);
    expect(serializeHandoffBundle(bundle)).not.toContain('remoteEntry');
    expect(JSON.parse(serializeHandoffBundle(bundle)).manifest.projects).toHaveLength(3);
  });

  it('throws sorted compatibility errors rather than aggregating incompatible input', () => {
    expect(() => aggregateFederation(manifest('commerce-shell'), [manifest('orders')])).toThrow(
      FederationCompatibilityError
    );
  });
});
