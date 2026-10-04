import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parseSnapshot } from '@selene/collaboration';

import {
  markDesignReady,
  parseGeneratedDesignHandoff,
  prototypeGraphFixture,
  recordDesignMutation,
  serializeCanonicalData,
  type DesignBaselineState,
  type GeneratedDesignHandoff
} from '@selene/core';

import { createImmutablePublishBundle } from './designer-host-ports';
import { createInitialWorkspace } from './designer-service';
import {
  BunViteReactGeneratedProjectTemplate,
  generatedProjectFilePlanDigest
} from './generated-project-template';
import { createEmbeddedGeneratedProjectToolchainPort } from './generated-project-toolchain';
import { generatedPublicBaseline, generatedReviewFiles } from './generated-review-template';
import { validatePublicDesignBaseline } from './generated-publication-privacy';
import {
  createHostedProjectPublicationArtifact,
  generatedProjectPublicationOutputs
} from './github-publish-project';

const privateValues = [
  '/Users/private/layout.png',
  '/home/private/layout.png',
  'file:///private/layout.png',
  'C:\\Users\\private\\layout.png',
  'ghp_' + 'a'.repeat(36),
  'api_key=private-credential'
];
const baselineReferencePaths = [
  'baseline.id',
  'baseline.revision.id',
  'baseline.revision.fingerprint',
  'changesSinceBaseline.0.id',
  'changesSinceBaseline.0.beforeRevision.id',
  'changesSinceBaseline.0.beforeRevision.fingerprint',
  'changesSinceBaseline.0.currentRevision.id',
  'changesSinceBaseline.0.currentRevision.fingerprint',
  'changesSinceBaseline.0.affected.screenIds.0',
  'changesSinceBaseline.0.affected.scenarioIds.0',
  'changesSinceBaseline.0.affected.componentIds.0',
  'changesSinceBaseline.0.affected.stableNodeIds.0',
  'changesSinceBaseline.0.evidence.0.checksum',
  'changesSinceBaseline.0.provenance.promptDigest'
];

function withBaselineReference(
  state: DesignBaselineState,
  path: string,
  value: string
): DesignBaselineState {
  const updated = structuredClone({
    ...state,
    changesSinceBaseline: state.changesSinceBaseline.map((change) => ({
      ...change,
      provenance: {
        kind: 'agent' as const,
        agentId: 'Private author',
        promptDigest: 'sha256:prompt'
      }
    }))
  });
  const keys = path.split('.');
  let parent = updated as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
  parent[keys.at(-1)!] = value;
  return updated;
}

function reviewPublication(
  update: (state: DesignBaselineState) => DesignBaselineState = (state) => state
) {
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
      designReviewState: { format: 'selene-design-review-state/v1', ...update(stale) }
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
  return { source, stale, bundle };
}

describe('generated public review', () => {
  it.each([
    { apiKey: 'private-value' },
    { nested: { client_secret: 'private-value' } },
    { '/Users/private': 'reference' }
  ])('rejects private keys in nested public baseline metadata', (metadata) => {
    const baseline = generatedPublicBaseline(reviewPublication().bundle);
    const extended = { ...baseline, metadata };
    expect(() => validatePublicDesignBaseline(extended)).toThrow(
      'Public design baseline contains private metadata or credentials.'
    );
  });

  it.each(
    baselineReferencePaths.flatMap((path) => privateValues.map((value) => ({ path, value })))
  )(
    'rejects private metadata retained at $path without rewriting its identity',
    ({ path, value }) => {
      const { bundle } = reviewPublication((state) => withBaselineReference(state, path, value));
      const originalBundle = serializeCanonicalData(bundle);
      // These values satisfy the collaboration schema; publication has a stricter privacy boundary.
      expect(parseSnapshot(bundle.collaborationSnapshot).designReviewState).toBeDefined();
      const toolchain = createEmbeddedGeneratedProjectToolchainPort();
      const template = new BunViteReactGeneratedProjectTemplate(toolchain);
      for (const publish of [
        () => generatedPublicBaseline(bundle),
        () => generatedReviewFiles(bundle, toolchain.load()),
        () => template.create(bundle)
      ]) {
        expect(publish).toThrow('Public design baseline contains private metadata or credentials.');
        try {
          publish();
        } catch (error) {
          expect((error as Error).message).not.toContain(value);
        }
      }
      expect(serializeCanonicalData(bundle)).toBe(originalBundle);
    }
  );

  it('rejects unsafe baselines at the hosted publication boundary even with a valid file plan', () => {
    const { bundle: safeBundle } = reviewPublication();
    const toolchain = createEmbeddedGeneratedProjectToolchainPort();
    const safePlan = new BunViteReactGeneratedProjectTemplate(toolchain).create(safeBundle);
    const { bundle } = reviewPublication((state) =>
      withBaselineReference(
        state,
        'changesSinceBaseline.0.provenance.promptDigest',
        privateValues.at(-1)!
      )
    );
    // Match immutable ownership so validation must regenerate the review bytes before transmission.
    const plan = {
      ...safePlan,
      bundle: { ...safePlan.bundle, immutableId: bundle.immutableId, digest: bundle.bundleDigest }
    };
    const validPlan = { ...plan, filePlanDigest: generatedProjectFilePlanDigest(plan) };
    expect(() => createHostedProjectPublicationArtifact(bundle, validPlan)).toThrow(
      'Public design baseline contains private metadata or credentials.'
    );
    expect(() =>
      generatedProjectPublicationOutputs(bundle, validPlan, 'Travel/Prototype', '1'.repeat(40))
    ).toThrow('Public design baseline contains private metadata or credentials.');
  });

  it.each([
    'changesSinceBaseline.0.reason',
    'changesSinceBaseline.0.affected.routePaths.0',
    'changesSinceBaseline.0.evidence.0.description'
  ])(
    'still omits private descriptive text at %s before validating the public projection',
    (path) => {
      const { bundle } = reviewPublication((state) =>
        withBaselineReference(state, path, privateValues[0]!)
      );
      const baseline = generatedPublicBaseline(bundle);
      expect(serializeCanonicalData(baseline)).toContain('[Private metadata omitted]');
      expect(serializeCanonicalData(baseline)).not.toContain(privateValues[0]);
      expect(() =>
        new BunViteReactGeneratedProjectTemplate(
          createEmbeddedGeneratedProjectToolchainPort()
        ).create(bundle)
      ).not.toThrow();
    }
  );

  it('exports the recorded baseline delta and portable source without host receipt locations or discussion author identities', () => {
    const { source, bundle } = reviewPublication();
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

  it('preserves safe baseline references through publication, the built review manifest and downloaded handoff', async () => {
    const { source, bundle } = reviewPublication((state) =>
      withBaselineReference(state, 'changesSinceBaseline.0.evidence.0.checksum', 'sha256:fare-r9')
    );
    const originalBundle = serializeCanonicalData(bundle);
    const template = new BunViteReactGeneratedProjectTemplate(
      createEmbeddedGeneratedProjectToolchainPort()
    );
    const plan = template.create(bundle);
    const baseline = generatedPublicBaseline(bundle);
    const artifact = createHostedProjectPublicationArtifact(bundle, plan);
    expect(artifact.source.workspace).toEqual(source);
    expect(artifact.prototype.graph).toEqual(bundle.prototype.graph);
    expect(plan.bundle).toMatchObject({
      immutableId: bundle.immutableId,
      digest: bundle.bundleDigest
    });
    expect(template.create(bundle)).toEqual(plan);
    expect(
      generatedProjectPublicationOutputs(bundle, plan, 'Travel/Prototype', '1'.repeat(40))
    ).toMatchObject({ projectId: source.projectId, sourceRevisionId: source.revision.id });
    expect(
      JSON.parse(plan.files.find((file) => file.path === 'selene/collaboration.json')!.content)
    ).toMatchObject(baseline);

    const root = await mkdtemp(join(tmpdir(), 'selene-public-baseline-'));
    try {
      await Promise.all(
        plan.files.map(async (file) => {
          const destination = join(root, file.path);
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, file.content);
        })
      );
      await writeFile(join(root, 'bun.lock'), '{"lockfileVersion":1}\n');
      execFileSync('bun', ['scripts/selene-review-artifacts.mjs'], {
        cwd: root,
        env: { ...process.env, GITHUB_SHA: '1'.repeat(40) },
        timeout: 10_000,
        stdio: 'pipe'
      });
      const manifest = JSON.parse(
        await readFile(join(root, 'public/review/manifest.json'), 'utf8')
      );
      expect(manifest.baseline).toEqual(baseline);
      const handoffArtifact = manifest.artifacts.find(
        (entry: { kind: string }) => entry.kind === 'handoff'
      );
      const handoff = parseGeneratedDesignHandoff(
        await readFile(join(root, 'public', handoffArtifact.href), 'utf8')
      );
      expect(handoff.baseline.exactChangesToRecheck).toEqual(baseline.changesSinceBaseline);
      expect(handoff.baseline.exactChangesToRecheck[0]).toMatchObject({
        evidence: [{ checksum: 'sha256:fare-r9' }],
        provenance: { kind: 'agent', agentId: 'Published agent', promptDigest: 'sha256:prompt' }
      });
      expect(JSON.parse(handoff.source).files).toEqual(source.files);
      expect(serializeCanonicalData(bundle)).toBe(originalBundle);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
