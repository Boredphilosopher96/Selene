import { describe, expect, it } from 'vitest';

import {
  markDesignReady,
  parseGeneratedDesignHandoff,
  prototypeGraphFixture,
  recordDesignMutation,
  type DesignBaselineState,
  type GeneratedDesignHandoff
} from '@selene/core';

import { createImmutablePublishBundle } from './designer-host-ports';
import { createInitialWorkspace } from './designer-service';
import { BunViteReactGeneratedProjectTemplate } from './generated-project-template';
import { createEmbeddedGeneratedProjectToolchainPort } from './generated-project-toolchain';

describe('generated public review', () => {
  it('exports the recorded baseline delta and portable source without host receipt locations or discussion author identities', () => {
    const source = createInitialWorkspace('travel-review');
    const draft: DesignBaselineState = {
      projectId: source.projectId,
      readiness: 'draft',
      currency: 'none',
      changesSinceBaseline: [],
      approvalsStale: false
    };
    const baseline = {
      id: 'travel-baseline-r8',
      projectId: source.projectId,
      revision: { id: 'travel-r8', fingerprint: 'sha256:r8' },
      intent: 'handoff' as const,
      createdAt: '2026-09-30T00:00:00Z',
      createdBy: 'private-author@example.test'
    };
    const stale = recordDesignMutation(markDesignReady(draft, 'handoff', baseline).state, {
      id: 'travel-fare-change',
      kind: 'source',
      beforeRevision: baseline.revision,
      currentRevision: { id: source.revision.id, fingerprint: 'sha256:r9' },
      affected: {
        projectId: source.projectId,
        screenIds: ['itinerary'],
        routePaths: ['/itinerary'],
        scenarioIds: ['book-trip'],
        componentIds: ['Travel'],
        stableNodeIds: [source.nodes[0]!.nodeId]
      },
      evidence: [{ description: 'Fare changed from $80 to $90', href: '/Users/private/fare.png' }],
      provenance: { kind: 'actor', actorId: 'private-author@example.test' },
      occurredAt: '2026-09-30T00:01:00Z',
      reason: 'Update the displayed itinerary fare.'
    });
    const bundle = createImmutablePublishBundle({
      projectId: source.projectId,
      source,
      prototype: {
        graph: {
          ...prototypeGraphFixture,
          project: { ...prototypeGraphFixture.project, projectId: source.projectId }
        },
        revision: 7
      },
      scenarios: [],
      collaborationSnapshot: JSON.stringify({
        format: 'selene-collaboration/v2',
        project: { id: source.projectId, organizationId: 'local', name: 'Travel review' },
        revisions: [],
        threads: [],
        comments: [],
        reactions: [],
        approvals: [],
        reviewThreads: [],
        aiChangeRequests: [],
        developerAnnotations: [],
        designReviewState: { format: 'selene-design-review-state/v1', ...stale }
      }),
      designInputProvenance: {
        format: 'selene-desktop-current-workspace-design-inputs/v1',
        projectId: source.projectId,
        designLanguage: {
          status: 'staged',
          provenance: { provider: 'markdown', location: '/Users/private/design-language.md' },
          artifactDigest: 'b'.repeat(64),
          sectionCount: 2
        }
      },
      componentCatalog: {
        manifest: {
          format: 'selene-component-catalog-projection/v1',
          state: 'unavailable',
          reason: 'NOT_CONFIGURED'
        },
        entries: []
      },
      packageProvenance: {
        packageManager: 'bun@1.3.14',
        lockfile: { path: '/Users/private/bun.lock', checksum: 'a'.repeat(64) },
        packages: [],
        dependencies: []
      }
    });
    const plan = new BunViteReactGeneratedProjectTemplate(
      createEmbeddedGeneratedProjectToolchainPort()
    ).create(bundle);
    const seed = JSON.parse(
      plan.files.find((file) => file.path === 'selene/review-seed.json')!.content
    ) as { baseline: DesignBaselineState; handoff: GeneratedDesignHandoff };
    expect(seed.baseline).toMatchObject({
      currency: 'stale',
      readiness: 'ready-for-handoff',
      approvalsStale: true,
      baseline: { id: 'travel-baseline-r8', revision: { id: 'travel-r8' } }
    });
    const handoff = parseGeneratedDesignHandoff(JSON.stringify(seed.handoff));
    expect(handoff.project.status).toBe('draft');
    expect(handoff.project.owner).toBe(bundle.prototype.graph.project.owner);
    expect(handoff.reactBinding).toBeNull();
    expect(handoff.baseline.exactChangesToRecheck[0]).toMatchObject({
      id: 'travel-fare-change',
      kind: 'source',
      beforeRevision: { id: 'travel-r8' },
      currentRevision: { id: source.revision.id },
      reason: 'Update the displayed itinerary fare.',
      affected: { routePaths: ['/itinerary'] }
    });
    expect(JSON.parse(handoff.source).files).toEqual(source.files);
    const publishedText = plan.files.map((file) => file.content).join('\n');
    expect(publishedText).not.toContain('/Users/private');
    expect(publishedText).not.toContain('private-author@example.test');
    expect(publishedText).toContain('Fare changed from $80 to $90');
  });
});
