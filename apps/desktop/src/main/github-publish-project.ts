import { createHash } from 'node:crypto';

import {
  parseGeneratedDesignHandoff,
  parsePrototypeGraph,
  serializeCanonicalData
} from '@selene/core';

import {
  createImmutablePublishBundle,
  PublishAdapterError,
  type ImmutablePublishBundle
} from './designer-host-ports';
import type {
  GeneratedProjectPublicationOutputs,
  HostedStaticReviewStatus
} from '../shared/designer-api';
import { canonicalGitHubRepository } from '../shared/github-repository';
import {
  validateGeneratedProjectFilePlan,
  type GeneratedProjectFilePlan
} from './generated-project-template';
import { generatedReviewFiles } from './generated-review-template';
import { validatePublicPrototypeGraph } from './generated-publication-privacy';

/** The adapter commits source; these paths describe the build without inventing deployment URLs. */
export function validateGeneratedProjectPublication(
  bundle: ImmutablePublishBundle,
  value: GeneratedProjectFilePlan
): GeneratedProjectFilePlan {
  const plan = validateGeneratedProjectFilePlan(value);
  try {
    const checked = createImmutablePublishBundle({
      projectId: bundle.projectId,
      source: bundle.source,
      prototype: bundle.prototype,
      scenarios: bundle.scenarios,
      collaborationSnapshot: bundle.collaborationSnapshot,
      designInputProvenance: bundle.designInputProvenance,
      componentCatalog: bundle.componentCatalog,
      packageProvenance: bundle.packageProvenance,
      ...(bundle.compiledArtifact === undefined
        ? {}
        : { compiledArtifact: bundle.compiledArtifact })
    });
    if (checked.bundleDigest !== bundle.bundleDigest || checked.immutableId !== bundle.immutableId)
      throw new Error('Digest mismatch');
  } catch {
    throw new PublishAdapterError(
      'INTEGRITY',
      'Publication output does not match its immutable project.'
    );
  }
  const graph = parsePrototypeGraph(bundle.prototype.graph);
  if (
    plan.bundle.digest !== bundle.bundleDigest ||
    plan.bundle.immutableId !== bundle.immutableId ||
    bundle.source.projectId !== bundle.projectId ||
    graph.project.projectId !== bundle.projectId
  )
    throw new PublishAdapterError(
      'INTEGRITY',
      'Publication output does not match its immutable project.'
    );
  const requiredPaths = [
    'selene/bundle.json',
    'selene/review-seed.json',
    'selene/component-catalog.json',
    'scripts/selene-review-artifacts.mjs',
    'src/.selene-review/Review.tsx',
    'src/.selene-prototype/main.tsx',
    '.github/workflows/selene-pages.yml'
  ];
  if (requiredPaths.some((path) => !plan.files.some((file) => file.path === path)))
    throw new PublishAdapterError(
      'INTEGRITY',
      'Publication output is missing its generated review files.'
    );
  const expectedFiles = [...bundle.source.files, ...generatedReviewFiles(bundle, plan.toolchain)];
  if (
    plan.bundle.sourceEntrypoint !== bundle.source.entrypoint ||
    expectedFiles.some(
      (expected) =>
        !plan.files.some((file) => file.path === expected.path && file.content === expected.content)
    )
  )
    throw new PublishAdapterError(
      'INTEGRITY',
      'Publication source or review bytes differ from its immutable project.'
    );
  const seedText = plan.files.find((file) => file.path === 'selene/review-seed.json')!.content;
  const seed: unknown = JSON.parse(seedText);
  if (
    typeof seed !== 'object' ||
    seed === null ||
    !('handoff' in seed) ||
    !('bundleDigest' in seed) ||
    seed.bundleDigest !== bundle.bundleDigest
  )
    throw new PublishAdapterError(
      'INTEGRITY',
      'Publication review seed is not bound to its bundle.'
    );
  const handoff = parseGeneratedDesignHandoff(JSON.stringify(seed.handoff));
  if (
    handoff.project.id !== bundle.projectId ||
    handoff.revision.id !== bundle.sourceRevisionId ||
    (bundle.compiledArtifact === undefined
      ? handoff.reactBinding !== null || handoff.project.status !== 'draft'
      : JSON.stringify(handoff.reactBinding) !==
        JSON.stringify(bundle.compiledArtifact.reactBinding))
  )
    throw new PublishAdapterError(
      'INTEGRITY',
      'Publication handoff does not match its source and compiler authority.'
    );
  return plan;
}

export function generatedProjectPublicationOutputs(
  bundle: ImmutablePublishBundle,
  value: GeneratedProjectFilePlan,
  repository: string,
  commitSha: string
): GeneratedProjectPublicationOutputs {
  validateGeneratedProjectPublication(bundle, value);
  if (!/^[a-f0-9]{40}$/.test(commitSha))
    throw new PublishAdapterError('INTEGRITY', 'Publication output requires an immutable commit.');
  const canonical = canonicalGitHubRepository(repository);
  return Object.freeze({
    format: 'selene-generated-project-publication-outputs/v1',
    delivery: 'repository-source',
    projectId: bundle.projectId,
    sourceRevisionId: bundle.sourceRevisionId,
    graphRevision: bundle.graphRevision,
    repositoryCommitUrl: `https://github.com/${canonical}/tree/${commitSha}`,
    sourceArchiveUrl: `https://github.com/${canonical}/archive/${commitSha}.tar.gz`,
    committedPaths: Object.freeze({
      sourceEntrypoint: bundle.source.entrypoint,
      bundleManifest: 'selene/bundle.json',
      reviewSeed: 'selene/review-seed.json',
      componentCatalog: 'selene/component-catalog.json',
      lockfile: 'bun.lock',
      pagesWorkflow: '.github/workflows/selene-pages.yml'
    }),
    staticBuildPaths: Object.freeze({
      review: 'index.html',
      prototype: 'index.html?view=prototype',
      catalog: 'storybook/',
      manifest: 'review/manifest.json',
      receipt: 'review/receipt.json'
    }),
    ...(bundle.compiledArtifact === undefined
      ? { handoffStatus: 'draft' as const, bindingIncluded: false as const }
      : { handoffStatus: 'compiler-bound' as const, bindingIncluded: true as const }),
    independentAcceptance: false
  });
}

export function preparedStaticReviewStatus(): HostedStaticReviewStatus {
  return Object.freeze({
    status: 'prepared',
    reason: 'BUILD_AND_DEPLOYMENT_REQUIRED',
    workflowPath: '.github/workflows/selene-pages.yml'
  });
}

/** Only same-project source/graph bytes are proposed to a configured cloud publisher. */
export interface HostedProjectPublicationArtifact {
  readonly format: 'selene-hosted-project-publication-artifact/v1';
  readonly projectId: string;
  readonly immutableId: string;
  readonly bundleDigest: string;
  readonly filePlanDigest: string;
  readonly source: {
    readonly revisionId: string;
    readonly sha256: string;
    readonly workspace: ImmutablePublishBundle['source'];
  };
  readonly prototype: {
    readonly revision: number;
    readonly revisionId: string;
    readonly sha256: string;
    readonly graph: ImmutablePublishBundle['prototype']['graph'];
  };
  readonly compilation: {
    readonly receipt: NonNullable<
      NonNullable<ImmutablePublishBundle['compiledArtifact']>['build']['receipt']
    >;
    readonly reactBinding: NonNullable<ImmutablePublishBundle['compiledArtifact']>['reactBinding'];
    readonly compilerEvidence: NonNullable<
      ImmutablePublishBundle['compiledArtifact']
    >['compilerEvidence'];
  } | null;
  readonly handoff:
    | {
        readonly status: 'draft';
        readonly compilerBinding: null;
        readonly hostedInspection: 'unavailable';
      }
    | {
        readonly status: 'compiler-bound';
        readonly compilerBinding: NonNullable<
          ImmutablePublishBundle['compiledArtifact']
        >['reactBinding'];
        readonly hostedInspection: 'binding-verified';
      };
  readonly manifestDigest: string;
}

export function createHostedProjectPublicationArtifact(
  bundle: ImmutablePublishBundle,
  plan: GeneratedProjectFilePlan
): HostedProjectPublicationArtifact {
  const publicGraph = validatePublicPrototypeGraph(bundle.prototype.graph);
  // Reuse the output boundary before any host adapter can receive an artifact.
  validateGeneratedProjectPublication(bundle, plan);
  const hash = (value: unknown) =>
    createHash('sha256').update(serializeCanonicalData(value)).digest('hex');
  const artifact = {
    format: 'selene-hosted-project-publication-artifact/v1' as const,
    projectId: bundle.projectId,
    immutableId: bundle.immutableId,
    bundleDigest: bundle.bundleDigest,
    filePlanDigest: plan.filePlanDigest,
    source: {
      revisionId: bundle.sourceRevisionId,
      sha256: hash(bundle.source),
      workspace: structuredClone(bundle.source)
    },
    prototype: {
      revision: bundle.graphRevision,
      revisionId: bundle.prototype.graph.revision.id,
      sha256: hash(bundle.prototype.graph),
      graph: structuredClone(publicGraph)
    },
    compilation:
      bundle.compiledArtifact === undefined
        ? null
        : {
            receipt: structuredClone(bundle.compiledArtifact.build.receipt!),
            reactBinding: structuredClone(bundle.compiledArtifact.reactBinding),
            compilerEvidence: structuredClone(bundle.compiledArtifact.compilerEvidence)
          },
    handoff:
      bundle.compiledArtifact === undefined
        ? {
            status: 'draft' as const,
            compilerBinding: null,
            hostedInspection: 'unavailable' as const
          }
        : {
            status: 'compiler-bound' as const,
            compilerBinding: structuredClone(bundle.compiledArtifact.reactBinding),
            hostedInspection: 'binding-verified' as const
          }
  };
  return { ...artifact, manifestDigest: hash(artifact) };
}
