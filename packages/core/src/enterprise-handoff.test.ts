import { describe, expect, it } from 'vitest';

import { markDesignReady } from './design-baseline';
import {
  createGeneratedDesignHandoff,
  enterpriseScenarioFixtures,
  parseGeneratedDesignHandoff,
  serializeGeneratedDesignHandoff
} from './enterprise-handoff';

const workspace = {
  format: 'selene-react-workspace/v1' as const,
  projectId: 'commerce-shell',
  entrypoint: 'src/App.tsx',
  files: [
    {
      path: 'src/App.tsx',
      language: 'tsx' as const,
      content: 'export default () => <main data-selene-node-id="orders.root" />;'
    }
  ],
  dependencies: [],
  nodes: [{ nodeId: 'orders.root', path: 'src/App.tsx', exportName: 'default' }],
  revision: {
    id: 'r2',
    parentId: 'r1',
    createdAt: '2026-07-23T22:00:00Z',
    summary: 'Orders review'
  }
};
const baseline = markDesignReady(
  {
    projectId: 'commerce-shell',
    readiness: 'draft' as const,
    currency: 'none' as const,
    changesSinceBaseline: [],
    approvalsStale: false
  },
  'handoff',
  {
    id: 'baseline-r2',
    projectId: 'commerce-shell',
    revision: { id: 'r2', fingerprint: 'sha256:r2' },
    intent: 'handoff',
    createdAt: '2026-07-23T22:00:00Z',
    createdBy: 'designer-1'
  }
).state;
const handoffDetails = {
  reproducibility: {
    packageManager: 'bun@1.3.14',
    lockfile: { path: 'bun.lock', checksum: 'a'.repeat(64) },
    packages: [{ name: '@selene/core', version: '0.0.0' }],
    dependencies: [{ name: 'react', version: '19.1.1' }]
  },
  project: {
    id: 'commerce-shell',
    owner: 'commerce-team',
    status: 'ready-for-handoff',
    routes: ['/', '/orders'],
    storybook: [
      { component: 'OrdersList', url: 'https://storybook.example.test/?path=/story/orders-list' }
    ],
    acceptanceCriteria: ['Verify source maps, stable node IDs, and empty-state focus behavior.']
  },
  agentInstructions: [
    'Read the lockfile checksum before modifying source.',
    'Re-check every exact baseline delta before handoff.'
  ]
};

describe('enterprise generated-design handoff', () => {
  it('round-trips source, node map, comments, source map, scenarios, and baseline currency', () => {
    const handoff = createGeneratedDesignHandoff({
      workspace,
      baseline,
      build: { sourceMap: '{"version":3}' },
      comments: [{ nodeId: 'orders.root', body: 'Verify the empty state.' }],
      reviewThreads: [
        {
          id: 'thread-orders-empty',
          status: 'open',
          anchor: {
            artifactId: 'commerce-shell',
            screenId: 'orders',
            scenarioId: 'editor-empty-mobile',
            state: 'empty',
            revisionId: 'r2',
            x: 0.25,
            y: 0.4,
            width: 0.2,
            height: 0.1,
            nodeId: 'orders.root'
          },
          messages: [
            {
              body: 'Verify the empty state.',
              author: 'designer-1',
              createdAt: '2026-07-23T22:05:00.000Z'
            },
            {
              body: 'Confirmed for keyboard focus.',
              author: 'designer-2',
              createdAt: '2026-07-23T22:06:00.000Z'
            }
          ]
        }
      ],
      developerDirections: ['Keep orders.root stable during component extraction.'],
      ...handoffDetails
    });
    const restored = parseGeneratedDesignHandoff(serializeGeneratedDesignHandoff(handoff));
    expect(restored).toMatchObject({
      sourceMap: '{"version":3}',
      baseline: { baselineId: 'baseline-r2', currency: 'current' }
    });
    expect(restored.scenarios.map((scenario) => scenario.state).sort()).toEqual([
      'empty',
      'error',
      'loading',
      'success'
    ]);
    expect(restored).toMatchObject({
      reproducibility: { packageManager: 'bun@1.3.14', lockfile: { path: 'bun.lock' } },
      project: { owner: 'commerce-team', routes: ['/', '/orders'] },
      reviewThreads: [
        {
          id: 'thread-orders-empty',
          status: 'open',
          anchor: { nodeId: 'orders.root', scenarioId: 'editor-empty-mobile' },
          messages: [{ body: 'Verify the empty state.' }, { author: 'designer-2' }]
        }
      ]
    });
  });

  it('covers roles, flags, viewports, locale, token modes, focus, reduced motion, and multi-step navigation', () => {
    expect(enterpriseScenarioFixtures).toHaveLength(4);
    expect(
      enterpriseScenarioFixtures.some((scenario) => scenario.accessibility.reducedMotion)
    ).toBe(true);
    expect(enterpriseScenarioFixtures.every((scenario) => scenario.navigation.length >= 2)).toBe(
      true
    );
    expect(
      enterpriseScenarioFixtures.find((scenario) => scenario.state === 'success')?.fixture.rows
    ).toHaveLength(2);
    expect(
      enterpriseScenarioFixtures.find((scenario) => scenario.state === 'error')?.fixture.errorCode
    ).toBe('SUPPORT_UPSTREAM_TIMEOUT');
  });

  it('rejects adversarial handoffs that detach comments or maps from stable source nodes', () => {
    expect(() =>
      createGeneratedDesignHandoff({
        workspace,
        baseline,
        comments: [{ nodeId: 'missing.node', body: 'No anchor' }],
        developerDirections: ['Review it.'],
        ...handoffDetails
      })
    ).toThrow(/unknown stable node/);
    expect(() =>
      createGeneratedDesignHandoff({
        workspace,
        baseline,
        comments: [],
        reviewThreads: [
          {
            id: 'thread-forged',
            status: 'open',
            anchor: {
              artifactId: 'commerce-shell',
              screenId: 'orders',
              scenarioId: 'editor-empty-mobile',
              state: 'empty',
              revisionId: 'r2',
              x: 0.25,
              y: 0.4,
              nodeId: 'missing.node'
            },
            messages: [
              {
                body: 'Forged anchor',
                author: 'designer-1',
                createdAt: '2026-07-23T22:05:00.000Z'
              }
            ]
          }
        ],
        developerDirections: ['Review it.'],
        ...handoffDetails
      })
    ).toThrow(/unknown stable node/);
  });

  it('rejects malformed imports and non-exact reproducibility metadata', () => {
    expect(() => parseGeneratedDesignHandoff('{')).toThrow(
      /Malformed generated design handoff JSON/
    );
    const handoff = createGeneratedDesignHandoff({
      workspace,
      baseline,
      comments: [],
      developerDirections: ['Review it.'],
      ...handoffDetails
    });
    expect(() =>
      parseGeneratedDesignHandoff(
        JSON.stringify({
          ...handoff,
          reproducibility: {
            ...handoff.reproducibility,
            lockfile: { ...handoff.reproducibility.lockfile, checksum: 'NOT-A-CHECKSUM' }
          }
        })
      )
    ).toThrow(/SHA-256/);
    expect(() =>
      createGeneratedDesignHandoff({
        workspace,
        baseline,
        comments: [],
        developerDirections: ['Review it.'],
        ...handoffDetails,
        reproducibility: {
          ...handoffDetails.reproducibility,
          dependencies: [{ name: 'react', version: '^19.1.1' }]
        }
      })
    ).toThrow(/exact semantic version/);

    expect(() =>
      parseGeneratedDesignHandoff(
        JSON.stringify({
          ...handoff,
          reviewThreads: [
            {
              id: 'thread-forged-geometry',
              status: 'open',
              anchor: {
                artifactId: 'commerce-shell',
                screenId: 'orders',
                scenarioId: 'editor-empty-mobile',
                state: 'empty',
                revisionId: 'r2',
                x: Number.POSITIVE_INFINITY,
                y: 0.4,
                width: 'wide'
              },
              messages: [
                {
                  body: 'Forged geometry',
                  author: 'designer-1',
                  createdAt: '2026-07-23T22:05:00.000Z'
                }
              ]
            }
          ]
        })
      )
    ).toThrow(/malformed/);
  });
});
