import { createHash } from 'node:crypto';

import {
  serializeCanonicalData,
  type ReactBindingCompilerEvidence,
  type ReactBuildArtifact,
  type ReactSourceWorkspace
} from '@selene/core';

import type { PreviewBuildResult, PreviewBuildTicket } from '../shared/designer-api';
import type {
  BoundPreviewBuildIdentity,
  BoundPreviewBuildRequest
} from './bound-preview-build-coordinator';
import { BoundPreviewBuildCoordinator } from './bound-preview-build-coordinator';
import type { PublishedPreview } from './preview-adapter';

export interface ResolvedPreviewBuild {
  readonly ticket: PreviewBuildTicket;
  readonly identity: BoundPreviewBuildIdentity;
  readonly workspace: ReactSourceWorkspace;
  readonly compilerEvidence: ReactBindingCompilerEvidence;
}

/** Privileged current-project authority. It must reject stale, missing, or malformed tickets. */
export interface PreviewBuildAuthority {
  resolvePreviewBuild(value: unknown): ResolvedPreviewBuild;
}

export interface PreviewBuildPublisher {
  publish(artifact: ReactBuildArtifact, identity: BoundPreviewBuildIdentity): PublishedPreview;
}

function authorityDigest(build: ResolvedPreviewBuild): string {
  return createHash('sha256')
    .update(
      serializeCanonicalData({
        ticket: build.ticket,
        identity: build.identity,
        workspace: build.workspace,
        compilerEvidence: build.compilerEvidence
      })
    )
    .digest('hex');
}

function requestFor(build: ResolvedPreviewBuild): BoundPreviewBuildRequest {
  return {
    identity: build.identity,
    workspace: build.workspace,
    compilerEvidence: build.compilerEvidence
  };
}

/**
 * Main-process preview route. A caller can submit only a bounded host-issued
 * ticket; every compiler input is resolved twice from current host state.
 */
export class PreviewBuildRoute {
  private readonly active = new Map<number, AbortController>();

  public constructor(
    private readonly coordinator: BoundPreviewBuildCoordinator,
    private readonly authority: PreviewBuildAuthority,
    private readonly publisher: PreviewBuildPublisher
  ) {}

  public async build(callerId: number, value: unknown): Promise<PreviewBuildResult> {
    if (!Number.isSafeInteger(callerId) || callerId < 0)
      throw new Error('Preview build caller is invalid.');
    const resolved = this.authority.resolvePreviewBuild(value);
    const digest = authorityDigest(resolved);
    this.active.get(callerId)?.abort();
    const controller = new AbortController();
    this.active.set(callerId, controller);
    try {
      const artifact = await this.coordinator.build(requestFor(resolved), controller.signal);
      if (artifact.diagnostics.length > 0)
        throw new Error(artifact.diagnostics.map((issue) => issue.message).join('\n'));
      const current = this.authority.resolvePreviewBuild(value);
      if (authorityDigest(current) !== digest)
        throw new Error('Preview build authority changed during compilation.');
      const published = this.publisher.publish(artifact, current.identity);
      return Object.freeze({
        ...published,
        projectId: current.identity.projectId,
        sourceRevisionId: current.identity.sourceRevisionId,
        graphRevision: current.identity.graphRevision,
        bindingId: current.identity.bindingId
      });
    } finally {
      if (this.active.get(callerId) === controller) this.active.delete(callerId);
    }
  }

  public cancel(callerId: number): void {
    this.active.get(callerId)?.abort();
    this.active.delete(callerId);
  }

  public reset(): void {
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
    this.coordinator.clear();
  }
}
