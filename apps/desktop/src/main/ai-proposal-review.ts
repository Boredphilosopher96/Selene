import { createHash } from 'node:crypto';

import {
  normalizeSourcePath,
  serializeCanonicalData,
  validateReactSourceWorkspace,
  type NodeMetadata,
  type ReactSourceWorkspace
} from '@selene/core';
import type {
  AIChangeHistoryTarget,
  AIProposalReview,
  AIProposalSourceChange,
  PendingAIProposal
} from '../shared/designer-api';
import type { LocalPendingAIProposal } from './project-lifecycle';

export const AI_PROPOSAL_REVIEW_LIMITS = Object.freeze({
  workspaceFiles: 512,
  workspaceBytes: 8 * 1024 * 1024,
  sourceNodes: 4096,
  dependencies: 128,
  changedFiles: 32,
  diffBytes: 64 * 1024,
  linesPerFile: 20_000,
  affectedMappings: 128
});

export interface AIProposalReviewInput {
  readonly source: ReactSourceWorkspace;
  readonly proposal: LocalPendingAIProposal;
  readonly target?: AIChangeHistoryTarget | undefined;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function workspaceDigest(workspace: ReactSourceWorkspace): string {
  // Matches the host's persisted proposal fingerprint and acceptance fence.
  return digest(JSON.stringify(workspace));
}

function workspaceWithinBudget(workspace: ReactSourceWorkspace): boolean {
  return (
    workspace.files.length <= AI_PROPOSAL_REVIEW_LIMITS.workspaceFiles &&
    workspace.nodes.length <= AI_PROPOSAL_REVIEW_LIMITS.sourceNodes &&
    workspace.dependencies.length <= AI_PROPOSAL_REVIEW_LIMITS.dependencies &&
    workspace.dependencies.every((dependency) => dependency.length <= 256) &&
    workspace.files.reduce((size, file) => size + Buffer.byteLength(file.content), 0) <=
      AI_PROPOSAL_REVIEW_LIMITS.workspaceBytes
  );
}

function sourcePath(path: string): string {
  if (
    path.includes(':') ||
    [...path].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
  )
    throw new Error('Source paths must be relative workspace paths.');
  return normalizeSourcePath(path);
}

function lines(content: string): readonly string[] | undefined {
  const result: string[] = [];
  let offset = 0;
  while (offset < content.length) {
    if (result.length >= AI_PROPOSAL_REVIEW_LIMITS.linesPerFile) return undefined;
    const end = content.indexOf('\n', offset);
    const next = end < 0 ? content.length : end + 1;
    result.push(content.slice(offset, next));
    offset = next;
  }
  return result;
}

function diffLine(prefix: string, content: string): string {
  return `${prefix}${content}${content.endsWith('\n') ? '' : '\n\\ No newline at end of file\n'}`;
}

function sourceDiff(
  path: string,
  before: string,
  after: string,
  remainingBytes: number
): string | undefined {
  const oldLines = lines(before);
  const newLines = lines(after);
  if (oldLines === undefined || newLines === undefined) return undefined;
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  )
    prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
  )
    suffix += 1;
  const start = Math.max(0, prefix - 3);
  const tail = Math.min(3, suffix);
  const oldEnd = oldLines.length - suffix;
  const newEnd = newLines.length - suffix;
  const oldCount = oldEnd + tail - start;
  const newCount = newEnd + tail - start;
  const parts = [
    `--- a/${path}\n+++ b/${path}\n@@ -${oldCount === 0 ? 0 : start + 1},${oldCount} +${newCount === 0 ? 0 : start + 1},${newCount} @@\n`
  ];
  let bytes = Buffer.byteLength(parts[0] ?? '');
  const append = (marker: string, content: string): boolean => {
    const line = diffLine(marker, content);
    bytes += Buffer.byteLength(line);
    if (bytes > remainingBytes) return false;
    parts.push(line);
    return true;
  };
  for (const line of oldLines.slice(start, prefix)) if (!append(' ', line)) return undefined;
  for (const line of oldLines.slice(prefix, oldEnd)) if (!append('-', line)) return undefined;
  for (const line of newLines.slice(prefix, newEnd)) if (!append('+', line)) return undefined;
  for (const line of oldLines.slice(oldEnd, oldEnd + tail))
    if (!append(' ', line)) return undefined;
  const result = parts.join('');
  return Buffer.byteLength(result) <= remainingBytes ? result : undefined;
}

function nodeKey(node: NodeMetadata): string {
  return JSON.stringify([node.path, node.exportName]);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function unavailableReview(
  input: AIProposalReviewInput,
  status: 'stale' | 'unavailable',
  warning: string,
  sourceDigest?: string,
  candidateDigest?: string
): AIProposalReview {
  const { source, proposal } = input;
  return {
    format: 'selene-ai-proposal-review/v1',
    status,
    identity: {
      projectId: source.projectId,
      sourceRevisionId: source.revision.id,
      ...(sourceDigest === undefined ? {} : { sourceDigest }),
      baseRevisionId: proposal.baseRevisionId,
      baseDigest: proposal.baseFingerprint,
      candidateRevisionId: proposal.candidateWorkspace.revision.id,
      ...(candidateDigest === undefined ? {} : { candidateDigest })
    },
    sourceChanges: [],
    coverage: {
      totalChangedFiles: 0,
      shownFiles: 0,
      omittedFiles: 0,
      omittedPaths: [],
      diffBytes: 0,
      complete: false
    },
    metadataChanges: { dependenciesAdded: [], dependenciesRemoved: [], nodeMappingsChanged: 0 },
    affected: {
      components: [],
      sourceNodeIds: [],
      screenIds: [],
      scenarioIds: [],
      mappingsComplete: false
    },
    checks: [{ id: 'identity', status: 'failed', description: warning }],
    warnings: [warning]
  };
}

/** Projects review evidence only; the host's existing acceptance fence remains authoritative. */
export function projectPendingAIProposal(input: AIProposalReviewInput): PendingAIProposal {
  const { source, proposal, target } = input;
  const candidate = proposal.candidateWorkspace;
  const pending: Omit<PendingAIProposal, 'review'> = {
    requestId: proposal.requestId,
    agentId: proposal.agentId,
    baseRevisionId: proposal.baseRevisionId,
    candidateRevisionId: candidate.revision.id,
    summary: proposal.summary,
    createdAt: proposal.createdAt
  };
  if (!workspaceWithinBudget(source) || !workspaceWithinBudget(candidate))
    return {
      ...pending,
      review: unavailableReview(
        input,
        'unavailable',
        'The workspace exceeds the bounded proposal review limits.'
      )
    };
  const sourceDigest = workspaceDigest(source);
  const candidateDigest = workspaceDigest(candidate);
  if (
    proposal.baseRevisionId !== source.revision.id ||
    proposal.baseFingerprint !== sourceDigest ||
    candidate.projectId !== source.projectId ||
    candidate.revision.parentId !== source.revision.id ||
    proposal.candidateFingerprint !== candidateDigest
  )
    return {
      ...pending,
      review: unavailableReview(
        input,
        'stale',
        'The proposal source or candidate identity has changed. Request a new proposal before accepting it.',
        sourceDigest,
        candidateDigest
      )
    };
  try {
    for (const workspace of [source, candidate]) {
      for (const file of workspace.files) sourcePath(file.path);
      validateReactSourceWorkspace(workspace, { allowedBareDependencies: workspace.dependencies });
    }
  } catch {
    return {
      ...pending,
      review: unavailableReview(
        input,
        'unavailable',
        'Source validation failed. This proposal cannot be reviewed or accepted.',
        sourceDigest,
        candidateDigest
      )
    };
  }
  const oldFiles = new Map(source.files.map((file) => [file.path, file.content]));
  const newFiles = new Map(candidate.files.map((file) => [file.path, file.content]));
  const changedPaths = unique([...oldFiles.keys(), ...newFiles.keys()]).filter(
    (path) => oldFiles.get(path) !== newFiles.get(path)
  );
  const sourceChanges: AIProposalSourceChange[] = [];
  const omittedPaths: string[] = [];
  let diffBytes = 0;
  let omittedFiles = 0;
  for (const path of changedPaths) {
    const before = oldFiles.get(path);
    const after = newFiles.get(path);
    const diff =
      sourceChanges.length >= AI_PROPOSAL_REVIEW_LIMITS.changedFiles
        ? undefined
        : sourceDiff(
            path,
            before ?? '',
            after ?? '',
            AI_PROPOSAL_REVIEW_LIMITS.diffBytes - diffBytes
          );
    if (diff === undefined) {
      omittedFiles += 1;
      if (omittedPaths.length < AI_PROPOSAL_REVIEW_LIMITS.affectedMappings) omittedPaths.push(path);
      continue;
    }
    diffBytes += Buffer.byteLength(diff);
    sourceChanges.push({
      path,
      kind: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      ...(before === undefined ? {} : { beforeDigest: digest(before) }),
      ...(after === undefined ? {} : { afterDigest: digest(after) }),
      diff
    });
  }
  const oldNodes = new Map(source.nodes.map((node) => [node.nodeId, node]));
  const newNodes = new Map(candidate.nodes.map((node) => [node.nodeId, node]));
  const changedNodeIds = unique([...oldNodes.keys(), ...newNodes.keys()]).filter((id) => {
    const before = oldNodes.get(id);
    const after = newNodes.get(id);
    return before === undefined || after === undefined || nodeKey(before) !== nodeKey(after);
  });
  const affectedPaths = new Set(changedPaths);
  const changedNodes = new Set(changedNodeIds);
  const affectedNodes = [...source.nodes, ...candidate.nodes].filter(
    (node) => affectedPaths.has(node.path) || changedNodes.has(node.nodeId)
  );
  const componentMap = new Map(
    affectedNodes.map((node) => [nodeKey(node), { path: node.path, exportName: node.exportName }])
  );
  const sourceNodeIds = unique(affectedNodes.map((node) => node.nodeId));
  const components = [...componentMap.values()].sort((left, right) =>
    left.path < right.path
      ? -1
      : left.path > right.path
        ? 1
        : left.exportName < right.exportName
          ? -1
          : left.exportName > right.exportName
            ? 1
            : 0
  );
  const mappingsComplete =
    components.length <= AI_PROPOSAL_REVIEW_LIMITS.affectedMappings &&
    sourceNodeIds.length <= AI_PROPOSAL_REVIEW_LIMITS.affectedMappings;
  const dependenciesAdded = unique(
    candidate.dependencies.filter((dependency) => !source.dependencies.includes(dependency))
  );
  const dependenciesRemoved = unique(
    source.dependencies.filter((dependency) => !candidate.dependencies.includes(dependency))
  );
  const targetCurrent =
    target !== undefined &&
    target.revisionId === proposal.baseRevisionId &&
    target.scenarioId === proposal.scenarioId;
  const compileEvidence = proposal.compileEvidence;
  const compilationMatches =
    compileEvidence !== undefined &&
    compileEvidence.projectId === candidate.projectId &&
    compileEvidence.sourceRevisionId === candidate.revision.id &&
    compileEvidence.sourceDigest === digest(serializeCanonicalData(candidate)) &&
    compileEvidence.compilerId.length > 0 &&
    compileEvidence.compilerId.length <= 128 &&
    [
      compileEvidence.bindingDigest,
      compileEvidence.compilerDigest,
      compileEvidence.previewDigest
    ].every((value) => /^[a-f0-9]{64}$/.test(value));
  const warnings = [
    'Source-mapped components and nodes identify possible impact; dependent components and runtime behavior have not been checked.',
    'Interaction, accessibility and visual acceptance checks have not run for this review.'
  ];
  if (compileEvidence === undefined)
    warnings.push(
      'No compiler result is attached to this review. Preview the proposal to run the current compiler.'
    );
  else if (!compilationMatches)
    warnings.push(
      'The stored compiler evidence does not match this candidate. Request a new proposal before accepting it.'
    );
  if (omittedFiles > 0)
    warnings.push(
      `${omittedFiles} changed source file(s) exceed the review limits; their diffs are omitted.`
    );
  if (!mappingsComplete)
    warnings.push(
      'Affected source mappings exceed the review limit; only the first 128 entries are shown.'
    );
  if (!targetCurrent)
    warnings.push(
      'No current screen target is attached; affected screens cannot be inferred from source alone.'
    );
  if (changedPaths.length === 0)
    warnings.push(
      'This candidate changes no source-file bytes. Review its workspace metadata changes.'
    );
  const review: AIProposalReview = {
    format: 'selene-ai-proposal-review/v1',
    status: 'current',
    identity: {
      projectId: source.projectId,
      sourceRevisionId: source.revision.id,
      sourceDigest,
      baseRevisionId: proposal.baseRevisionId,
      baseDigest: proposal.baseFingerprint,
      candidateRevisionId: candidate.revision.id,
      candidateDigest
    },
    sourceChanges,
    coverage: {
      totalChangedFiles: changedPaths.length,
      shownFiles: sourceChanges.length,
      omittedFiles,
      omittedPaths,
      diffBytes,
      complete: omittedFiles === 0
    },
    metadataChanges: {
      ...(source.entrypoint === candidate.entrypoint
        ? {}
        : { entrypoint: { before: source.entrypoint, after: candidate.entrypoint } }),
      dependenciesAdded,
      dependenciesRemoved,
      nodeMappingsChanged: changedNodeIds.length
    },
    affected: {
      components: components.slice(0, AI_PROPOSAL_REVIEW_LIMITS.affectedMappings),
      sourceNodeIds: sourceNodeIds.slice(0, AI_PROPOSAL_REVIEW_LIMITS.affectedMappings),
      screenIds: targetCurrent ? [target.screenId] : [],
      scenarioIds: unique([proposal.scenarioId]),
      mappingsComplete
    },
    ...(compilationMatches ? { compilationEvidence: { ...compileEvidence } } : {}),
    checks: [
      {
        id: 'identity',
        status: 'passed',
        description:
          'Current source and candidate match the stored revision and SHA-256 fingerprints.'
      },
      {
        id: 'source-validation',
        status: 'passed',
        description:
          'Workspace paths, declared imports, dependencies and stable node metadata passed source validation.'
      },
      {
        id: 'compilation',
        status:
          compileEvidence === undefined ? 'not-recorded' : compilationMatches ? 'passed' : 'failed',
        description:
          compileEvidence === undefined
            ? 'No current compiler receipt is attached to this review.'
            : compilationMatches
              ? 'The staging compiler evidence names this exact candidate source and records binding and preview digests.'
              : 'The stored compiler evidence does not match this candidate.'
      },
      {
        id: 'runtime',
        status: 'not-run',
        description: 'Scenario interactions and dependent screen behavior have not been checked.'
      },
      {
        id: 'accessibility',
        status: 'not-run',
        description: 'Keyboard, focus and accessibility acceptance have not been checked.'
      },
      { id: 'visual', status: 'not-run', description: 'Visual acceptance has not been checked.' }
    ],
    warnings
  };
  return { ...pending, review };
}
