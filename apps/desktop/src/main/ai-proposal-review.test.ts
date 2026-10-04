import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { serializeCanonicalData, type ReactSourceWorkspace } from '@selene/core';
import type { AIChangeHistoryTarget } from '../shared/designer-api';
import type { LocalPendingAIProposal } from './project-lifecycle';
import { AI_PROPOSAL_REVIEW_LIMITS, projectPendingAIProposal } from './ai-proposal-review';

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function source(): ReactSourceWorkspace {
  return {
    format: 'selene-react-workspace/v1',
    projectId: 'review-project',
    entrypoint: 'src/App.tsx',
    files: [
      {
        path: 'src/App.tsx',
        language: 'tsx',
        content: 'export const App = () => <div>Before</div>;\n'
      },
      { path: 'src/remove.ts', language: 'ts', content: 'export const Removed = 1;\n' },
      { path: 'src/style.css', language: 'css', content: 'body { color: black; }\n' }
    ],
    dependencies: ['react'],
    nodes: [
      { nodeId: 'app', path: 'src/App.tsx', exportName: 'App' },
      { nodeId: 'removed', path: 'src/remove.ts', exportName: 'Removed' }
    ],
    revision: { id: 'source-r1', createdAt: '2026-09-30T12:00:00.000Z', summary: 'Initial source' }
  };
}

function proposal(base: ReactSourceWorkspace, next: ReactSourceWorkspace): LocalPendingAIProposal {
  return {
    format: 'selene-local-pending-ai-proposal/v1',
    requestId: 'request-1',
    agentId: 'agent-1',
    scenarioId: 'scenario-1',
    baseRevisionId: base.revision.id,
    baseFingerprint: fingerprint(base),
    candidateWorkspace: next,
    candidateFingerprint: fingerprint(next),
    summary: 'Improve the primary action',
    createdAt: next.revision.createdAt
  };
}

function candidate(base: ReactSourceWorkspace): ReactSourceWorkspace {
  return {
    ...base,
    files: [
      {
        path: 'src/App.tsx',
        language: 'tsx',
        content: 'export const App = () => <div>After</div>;\n'
      },
      { path: 'src/add.ts', language: 'ts', content: 'export const Added = 2;\n' },
      { path: 'src/style.css', language: 'css', content: 'body { color: black; }\n' }
    ],
    nodes: [
      { nodeId: 'app', path: 'src/App.tsx', exportName: 'App' },
      { nodeId: 'added', path: 'src/add.ts', exportName: 'Added' }
    ],
    revision: {
      id: 'candidate-r2',
      parentId: base.revision.id,
      createdAt: '2026-09-30T12:01:00.000Z',
      summary: 'Proposal'
    }
  };
}

const target: AIChangeHistoryTarget = {
  x: 0.5,
  y: 0.5,
  viewport: { width: 1000, height: 800 },
  nodeRef: 'app',
  artifactId: 'artifact-1',
  screenId: 'orders-screen',
  scenarioId: 'scenario-1',
  state: 'success',
  revisionId: 'source-r1'
};

describe('AI proposal review evidence', () => {
  it('projects literal changed, added and removed source hunks and the exact accepted candidate identity', () => {
    const base = source();
    const next = candidate(base);
    const pending = projectPendingAIProposal({
      source: base,
      proposal: proposal(base, next),
      target
    });
    expect(pending).toMatchObject({
      requestId: 'request-1',
      baseRevisionId: 'source-r1',
      candidateRevisionId: 'candidate-r2',
      summary: 'Improve the primary action'
    });
    expect(pending.review?.identity).toEqual({
      projectId: 'review-project',
      sourceRevisionId: 'source-r1',
      sourceDigest: fingerprint(base),
      baseRevisionId: 'source-r1',
      baseDigest: fingerprint(base),
      candidateRevisionId: 'candidate-r2',
      candidateDigest: fingerprint(next)
    });
    expect(
      pending.review?.sourceChanges.map((change) => ({
        path: change.path,
        kind: change.kind,
        diff: change.diff
      }))
    ).toEqual([
      {
        path: 'src/App.tsx',
        kind: 'modified',
        diff: '--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1,1 +1,1 @@\n-export const App = () => <div>Before</div>;\n+export const App = () => <div>After</div>;\n'
      },
      {
        path: 'src/add.ts',
        kind: 'added',
        diff: '--- a/src/add.ts\n+++ b/src/add.ts\n@@ -0,0 +1,1 @@\n+export const Added = 2;\n'
      },
      {
        path: 'src/remove.ts',
        kind: 'removed',
        diff: '--- a/src/remove.ts\n+++ b/src/remove.ts\n@@ -1,1 +0,0 @@\n-export const Removed = 1;\n'
      }
    ]);
    expect(pending.review?.coverage).toMatchObject({
      totalChangedFiles: 3,
      shownFiles: 3,
      omittedFiles: 0,
      complete: true
    });
    expect(pending.review?.affected).toEqual({
      components: [
        { path: 'src/App.tsx', exportName: 'App' },
        { path: 'src/add.ts', exportName: 'Added' },
        { path: 'src/remove.ts', exportName: 'Removed' }
      ],
      sourceNodeIds: ['added', 'app', 'removed'],
      screenIds: ['orders-screen'],
      scenarioIds: ['scenario-1'],
      mappingsComplete: true
    });
  });

  it('preserves exact line endings and missing-final-newline changes', () => {
    const base = source();
    const next = {
      ...candidate(base),
      files: [
        { path: 'src/App.tsx', language: 'tsx' as const, content: 'export const App = 1;\r\n' }
      ],
      nodes: [{ nodeId: 'app', path: 'src/App.tsx', exportName: 'App' }]
    };
    const before = {
      ...base,
      files: [{ path: 'src/App.tsx', language: 'tsx' as const, content: 'export const App = 1;' }],
      nodes: next.nodes
    };
    expect(
      projectPendingAIProposal({ source: before, proposal: proposal(before, next) }).review
        ?.sourceChanges[0]?.diff
    ).toBe(
      '--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1,1 +1,1 @@\n-export const App = 1;\n\\ No newline at end of file\n+export const App = 1;\r\n'
    );
  });

  it('shows unchanged context around the exact replacement without exposing unrelated file contents', () => {
    const base = source();
    const before = {
      ...base,
      files: base.files.map((file) =>
        file.path === 'src/App.tsx'
          ? {
              ...file,
              content: 'first\nsecond\nthird\nfourth\nfifth\nsixth\nseventh\neighth\nninth\n'
            }
          : file
      )
    };
    const next = {
      ...candidate(before),
      files: before.files.map((file) =>
        file.path === 'src/App.tsx'
          ? { ...file, content: file.content.replace('fifth\n', 'changed\n') }
          : file
      ),
      nodes: before.nodes
    };
    expect(
      projectPendingAIProposal({ source: before, proposal: proposal(before, next) }).review
        ?.sourceChanges[0]?.diff
    ).toBe(
      '--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -2,7 +2,7 @@\n second\n third\n fourth\n-fifth\n+changed\n sixth\n seventh\n eighth\n'
    );
  });

  it.each([
    'source-revision',
    'source-content',
    'candidate-content',
    'candidate-project',
    'candidate-parent'
  ])('suppresses stale %s evidence', (kind) => {
    const base = source();
    const next = candidate(base);
    const stored = proposal(base, next);
    const current =
      kind === 'source-revision'
        ? { ...base, revision: { ...base.revision, id: 'source-r3' } }
        : kind === 'source-content'
          ? {
              ...base,
              files: base.files.map((file) => ({ ...file, content: `${file.content}\n` }))
            }
          : base;
    const altered =
      kind === 'candidate-content'
        ? { ...next, files: next.files.map((file) => ({ ...file, content: `${file.content}\n` })) }
        : kind === 'candidate-project'
          ? { ...next, projectId: 'another-project' }
          : kind === 'candidate-parent'
            ? { ...next, revision: { ...next.revision, parentId: 'another-revision' } }
            : next;
    const review = projectPendingAIProposal({
      source: current,
      proposal: { ...stored, candidateWorkspace: altered },
      target
    }).review;
    expect(review?.status).toBe('stale');
    expect(review?.sourceChanges).toEqual([]);
    expect(review?.coverage.complete).toBe(false);
    expect(review?.affected.components).toEqual([]);
    expect(review?.checks).toEqual([
      {
        id: 'identity',
        status: 'failed',
        description:
          'The proposal source or candidate identity has changed. Request a new proposal before accepting it.'
      }
    ]);
  });

  it('reports source checks honestly without inventing compiler, runtime or persona acceptance', () => {
    const base = source();
    const review = projectPendingAIProposal({
      source: base,
      proposal: proposal(base, candidate(base))
    }).review;
    expect(review?.checks.map((check) => [check.id, check.status])).toEqual([
      ['identity', 'passed'],
      ['source-validation', 'passed'],
      ['compilation', 'not-recorded'],
      ['runtime', 'not-run'],
      ['accessibility', 'not-run'],
      ['visual', 'not-run']
    ]);
    expect(review?.affected.screenIds).toEqual([]);
    expect(review?.affected.scenarioIds).toEqual(['scenario-1']);
    expect(review?.warnings).toContain(
      'No current screen target is attached; affected screens cannot be inferred from source alone.'
    );
    expect(
      projectPendingAIProposal({
        source: base,
        proposal: proposal(base, candidate(base)),
        target: { ...target, revisionId: 'old-revision' }
      }).review?.affected.screenIds
    ).toEqual([]);
  });

  it('projects matching staging compiler evidence and refuses a receipt for another source', () => {
    const base = source();
    const next = candidate(base);
    const compileEvidence = {
      projectId: next.projectId,
      sourceRevisionId: next.revision.id,
      sourceDigest: createHash('sha256').update(serializeCanonicalData(next)).digest('hex'),
      bindingDigest: 'a'.repeat(64),
      compilerId: 'selene-vite-react-compiler-v1',
      compilerDigest: 'b'.repeat(64),
      previewDigest: 'c'.repeat(64)
    };
    const stored = { ...proposal(base, next), compileEvidence };
    const review = projectPendingAIProposal({ source: base, proposal: stored }).review;
    expect(review?.compilationEvidence).toEqual(compileEvidence);
    expect(review?.checks.find((check) => check.id === 'compilation')).toEqual({
      id: 'compilation',
      status: 'passed',
      description:
        'The staging compiler evidence names this exact candidate source and records binding and preview digests.'
    });
    const mismatched = projectPendingAIProposal({
      source: base,
      proposal: { ...stored, compileEvidence: { ...compileEvidence, sourceDigest: '0'.repeat(64) } }
    }).review;
    expect(mismatched?.compilationEvidence).toBeUndefined();
    expect(mismatched?.checks.find((check) => check.id === 'compilation')?.status).toBe('failed');
    expect(mismatched?.warnings).toContain(
      'The stored compiler evidence does not match this candidate. Request a new proposal before accepting it.'
    );
    expect(
      review?.checks
        .filter(
          (check) => check.id === 'runtime' || check.id === 'accessibility' || check.id === 'visual'
        )
        .map((check) => check.status)
    ).toEqual(['not-run', 'not-run', 'not-run']);
  });

  it('reports dependency, entrypoint and node-mapping changes without claiming source-byte edits', () => {
    const base = source();
    const next = {
      ...candidate(base),
      files: base.files,
      entrypoint: 'src/remove.ts',
      dependencies: ['react', '@acme/design'],
      nodes: [{ nodeId: 'app', path: 'src/App.tsx', exportName: 'Panel' }]
    };
    const review = projectPendingAIProposal({
      source: base,
      proposal: proposal(base, next)
    }).review;
    expect(review?.sourceChanges).toEqual([]);
    expect(review?.metadataChanges).toEqual({
      entrypoint: { before: 'src/App.tsx', after: 'src/remove.ts' },
      dependenciesAdded: ['@acme/design'],
      dependenciesRemoved: [],
      nodeMappingsChanged: 2
    });
    expect(review?.affected.sourceNodeIds).toEqual(['app', 'removed']);
    expect(review?.warnings).toContain(
      'This candidate changes no source-file bytes. Review its workspace metadata changes.'
    );
  });

  it('names omitted changed files when the file count or byte budget prevents a complete review', () => {
    const base = source();
    const extraFiles = Array.from({ length: 33 }, (_, index) => ({
      path: `src/F${String(index).padStart(2, '0')}.ts`,
      language: 'ts' as const,
      content: 'export const value = 1;\n'
    }));
    const next = { ...candidate(base), files: [...base.files, ...extraFiles], nodes: base.nodes };
    const countReview = projectPendingAIProposal({
      source: base,
      proposal: proposal(base, next)
    }).review;
    expect(countReview?.coverage).toMatchObject({
      totalChangedFiles: 33,
      shownFiles: 32,
      omittedFiles: 1,
      omittedPaths: ['src/F32.ts'],
      complete: false
    });
    const oversized = {
      ...candidate(base),
      files: base.files.map((file) =>
        file.path === 'src/App.tsx'
          ? {
              ...file,
              content: `export const text = '${'x'.repeat(AI_PROPOSAL_REVIEW_LIMITS.diffBytes)}';\n`
            }
          : file
      ),
      nodes: base.nodes
    };
    const byteReview = projectPendingAIProposal({
      source: base,
      proposal: proposal(base, oversized)
    }).review;
    expect(byteReview?.coverage).toMatchObject({
      totalChangedFiles: 1,
      shownFiles: 0,
      omittedFiles: 1,
      omittedPaths: ['src/App.tsx'],
      complete: false,
      diffBytes: 0
    });
  });

  it('bounds line counts, workspace counts and affected mappings', () => {
    const base = source();
    const manyLines = {
      ...candidate(base),
      files: base.files.map((file) =>
        file.path === 'src/App.tsx'
          ? { ...file, content: '\n'.repeat(AI_PROPOSAL_REVIEW_LIMITS.linesPerFile + 1) }
          : file
      ),
      nodes: base.nodes
    };
    expect(
      projectPendingAIProposal({ source: base, proposal: proposal(base, manyLines) }).review
        ?.coverage
    ).toMatchObject({ omittedFiles: 1, shownFiles: 0, complete: false });
    const tooManyFiles = {
      ...candidate(base),
      files: Array.from({ length: AI_PROPOSAL_REVIEW_LIMITS.workspaceFiles + 1 }, (_, index) => ({
        path: `src/F${index}.ts`,
        language: 'ts' as const,
        content: ''
      }))
    };
    expect(
      projectPendingAIProposal({ source: base, proposal: proposal(base, tooManyFiles) }).review
        ?.status
    ).toBe('unavailable');
    const mappedBase = {
      ...base,
      nodes: Array.from({ length: 129 }, (_, index) => ({
        nodeId: `node-${index}`,
        path: 'src/App.tsx',
        exportName: `Component${index}`
      }))
    };
    const mappedNext = { ...candidate(mappedBase), nodes: mappedBase.nodes };
    const mappedReview = projectPendingAIProposal({
      source: mappedBase,
      proposal: proposal(mappedBase, mappedNext)
    }).review;
    expect(mappedReview?.affected.components).toHaveLength(128);
    expect(mappedReview?.affected.sourceNodeIds).toHaveLength(128);
    expect(mappedReview?.affected.mappingsComplete).toBe(false);
  });

  it.each(['../secret.ts', '/Users/private.ts', 'C:private.ts', 'src/line\nbreak.ts'])(
    'rejects unsafe relative diff path %s without exposing source',
    (path) => {
      const base = source();
      const next = {
        ...candidate(base),
        files: [...base.files, { path, language: 'ts' as const, content: 'PRIVATE SOURCE' }],
        nodes: base.nodes
      };
      const review = projectPendingAIProposal({
        source: base,
        proposal: proposal(base, next)
      }).review;
      expect(review?.status).toBe('unavailable');
      expect(review?.sourceChanges).toEqual([]);
      expect(JSON.stringify(review)).not.toContain('PRIVATE SOURCE');
      expect(JSON.stringify(review)).not.toContain(path);
    }
  );
});
