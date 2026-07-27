import { createHash } from 'node:crypto';

import {
  serializeCanonicalData,
  type DesignEditProposal,
  type DesignEditResult,
  type DesignRevision,
  type ReactCompilerPort,
  type ReactSourceWorkspace
} from '@selene/core';

import { issueReactBindingCompilerEvidence } from './react-binding-evidence';
import {
  prepareReactTsxDesignEdit,
  type HostSourceBinding,
  type ReactTsxDesignEditPreparation
} from './react-tsx-design-edit-adapter';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const rejected = (code: string): DesignEditResult => ({
  format: 'selene-design-edit-result/v1',
  kind: 'rejected',
  diagnostics: [{ code }]
});

const preparedResult = (
  prepared: Exclude<ReactTsxDesignEditPreparation, { readonly kind: 'prepared' }>
): DesignEditResult => {
  return {
    format: 'selene-design-edit-result/v1',
    kind: prepared.kind,
    diagnostics: [{ code: prepared.code }]
  };
};

/** Private compiler authority; source text and paths never leave this process. */
interface EditableBindingSnapshot {
  readonly projectId: string;
  readonly sourceRevisionId: string;
  readonly sourceDigest: string;
  readonly bindingDigest: string;
  readonly sourceBindings: readonly HostSourceBinding[];
}

/**
 * Host-only final commit boundary. It receives a fully recompiled candidate,
 * then must atomically replace source, inert binding metadata, lifecycle state,
 * receipt/replay data, and undo data before it may return `applied`.
 */
export interface ManualReactEditAtomicPersistencePort {
  commit(
    candidate: Readonly<{
      readonly proposal: DesignEditProposal;
      readonly baseRevision: DesignRevision;
      readonly workspace: ReactSourceWorkspace;
      readonly sourceDigest: string;
      readonly bindingDigest: string;
    }>
  ): Promise<DesignEditResult>;
}

export interface ManualReactEditTransactionPort {
  /** Returns `applied` only from the host's atomic persistence authority. */
  evaluate(
    proposal: DesignEditProposal,
    context: Readonly<{
      readonly workspace: ReactSourceWorkspace;
      readonly designSystemLockDigest: string;
      /** Host-stored immutable revision, never inferred from source revision text. */
      readonly designRevision?: DesignRevision;
    }>
  ): Promise<DesignEditResult>;
}

/** Default denial keeps fixtures and hosts without compiler authority mutation-free. */
export class UnavailableManualReactEditTransactionPort implements ManualReactEditTransactionPort {
  public evaluate(
    _proposal: DesignEditProposal,
    _context: Readonly<{
      readonly workspace: ReactSourceWorkspace;
      readonly designSystemLockDigest: string;
      readonly designRevision?: DesignRevision;
    }>
  ): Promise<DesignEditResult> {
    return Promise.resolve(rejected('HOST_BINDING_UNAVAILABLE'));
  }
}

/**
 * Compiles the exact current workspace, derives opaque per-marker module IDs,
 * validates a host-local AST preparation, then recompiles the candidate before
 * offering it to the sole atomic persistence authority.
 */
export class CompilerBoundManualReactEditTransactionPort implements ManualReactEditTransactionPort {
  public constructor(
    private readonly compiler: ReactCompilerPort,
    private readonly persistence?: ManualReactEditAtomicPersistencePort
  ) {}

  private async snapshot(
    workspace: ReactSourceWorkspace
  ): Promise<EditableBindingSnapshot | undefined> {
    let artifact: Awaited<ReturnType<ReactCompilerPort['compile']>>;
    try {
      artifact = await this.compiler.compile(workspace);
    } catch {
      return undefined;
    }
    if (artifact.diagnostics.length !== 0 || artifact.receipt === undefined) return undefined;
    const receipt = artifact.receipt;
    let evidence: ReturnType<typeof issueReactBindingCompilerEvidence>;
    try {
      evidence = issueReactBindingCompilerEvidence(workspace, receipt);
    } catch {
      return undefined;
    }
    const bindingDigest = sha256(serializeCanonicalData(evidence));
    const sourceBindings = evidence.nodeMarkers.map((marker) => ({
      sourceAnchorId: marker.sourceNodeId,
      moduleId: `selene-compiler:${sha256(`${marker.path}\u0000${marker.exportName}`).slice(0, 32)}`,
      path: marker.path,
      exportName: marker.exportName,
      sourceDigest: receipt.sourceSha256,
      bindingDigest
    }));
    return Object.freeze({
      projectId: workspace.projectId,
      sourceRevisionId: workspace.revision.id,
      sourceDigest: receipt.sourceSha256,
      bindingDigest,
      sourceBindings: Object.freeze(sourceBindings)
    });
  }

  public async evaluate(
    proposal: DesignEditProposal,
    context: Readonly<{
      readonly workspace: ReactSourceWorkspace;
      readonly designSystemLockDigest: string;
      readonly designRevision?: DesignRevision;
    }>
  ): Promise<DesignEditResult> {
    if (context.designRevision === undefined) return rejected('DESIGN_REVISION_UNAVAILABLE');
    const snapshot = await this.snapshot(context.workspace);
    if (snapshot === undefined) return rejected('COMPILER_BINDING_UNAVAILABLE');
    if (
      proposal.base.projectId !== snapshot.projectId ||
      proposal.base.revisionId !== context.designRevision.revisionId ||
      proposal.base.revisionCommitment !== context.designRevision.revisionCommitment
    )
      return {
        format: 'selene-design-edit-result/v1',
        kind: 'conflict',
        diagnostics: [{ code: 'STALE_SOURCE' }]
      };
    const prepared = prepareReactTsxDesignEdit(proposal, {
      workspace: context.workspace,
      sourceDigest: snapshot.sourceDigest,
      bindingDigest: snapshot.bindingDigest,
      designSystemLockDigest: context.designSystemLockDigest,
      sourceBindings: snapshot.sourceBindings
    });
    if (prepared.kind !== 'prepared') return preparedResult(prepared);
    const nextWorkspace = Object.freeze({
      ...context.workspace,
      files: Object.freeze(
        context.workspace.files.map((file) =>
          file.path === prepared.patch.path
            ? Object.freeze({ ...file, content: prepared.patch.nextContent })
            : file
        )
      )
    });
    const revalidated = await this.snapshot(nextWorkspace);
    if (revalidated === undefined) return rejected('REVALIDATED_COMPILER_BINDING_UNAVAILABLE');
    if (this.persistence === undefined) return rejected('ATOMIC_PERSISTENCE_UNAVAILABLE');
    try {
      return await this.persistence.commit({
        proposal,
        baseRevision: context.designRevision,
        workspace: nextWorkspace,
        sourceDigest: revalidated.sourceDigest,
        bindingDigest: revalidated.bindingDigest
      });
    } catch {
      return rejected('ATOMIC_PERSISTENCE_UNAVAILABLE');
    }
  }
}
