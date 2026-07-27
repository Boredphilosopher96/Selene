import { createHash } from 'node:crypto';

import {
  applyDesignEditProposal,
  parseDesignRevision,
  serializeCanonicalData,
  type DesignEditProposal,
  type DesignEditReceipt,
  type DesignEditResult,
  type DesignRevision,
  type ReactCompilerPort,
  type ReactSourceWorkspace
} from '@selene/core';

import { issueReactBindingCompilerEvidence } from './react-binding-evidence';
import {
  prepareReactTsxDesignEdit,
  type HostSourceBinding,
  type PreparedReactTsxDesignEdit,
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

const sameWorkspaceContent = (
  expected: ReactSourceWorkspace,
  actual: ReactSourceWorkspace
): boolean => {
  const { revision: _expectedRevision, ...expectedWithoutRevision } = expected;
  const { revision: _actualRevision, ...actualWithoutRevision } = actual;
  return (
    serializeCanonicalData(expectedWithoutRevision) ===
    serializeCanonicalData(actualWithoutRevision)
  );
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
 * Closed host outcome. Core validates its receipt independently before it can
 * become an external DesignEditResult. Raw source remains in the main process.
 */
export interface ManualReactEditAtomicCommitOutcome {
  readonly kind: 'applied' | 'replayed';
  readonly receipt: DesignEditReceipt;
  /** The already durable workspace that the receipt claims to describe. */
  readonly workspace: ReactSourceWorkspace;
}

/**
 * Main-process durability boundary. `replay` must look up a durable
 * commandId/proposal-digest record before `commit`; `commit` must create that
 * record, the undo record, source, binding evidence, receipt, and lifecycle
 * revision in one transaction before returning an outcome.
 */
export interface ManualReactEditAtomicPersistencePort {
  replay(
    request: Readonly<{
      readonly proposal: DesignEditProposal;
      readonly baseRevision: DesignRevision;
      readonly workspace: ReactSourceWorkspace;
    }>
  ): Promise<ManualReactEditAtomicCommitOutcome | undefined>;
  commit(
    request: Readonly<{
      readonly proposal: DesignEditProposal;
      readonly baseRevision: DesignRevision;
      readonly baseWorkspace: ReactSourceWorkspace;
      /** Host-local AST patch; it is never projected through preload. */
      readonly patch: PreparedReactTsxDesignEdit['patch'];
    }>
  ): Promise<ManualReactEditAtomicCommitOutcome>;
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
    let designRevision: DesignRevision;
    try {
      designRevision = parseDesignRevision(context.designRevision);
    } catch {
      return rejected('DESIGN_REVISION_UNAVAILABLE');
    }
    const snapshot = await this.snapshot(context.workspace);
    if (snapshot === undefined) return rejected('COMPILER_BINDING_UNAVAILABLE');
    if (
      proposal.base.projectId !== snapshot.projectId ||
      proposal.base.revisionId !== designRevision.revisionId ||
      proposal.base.revisionCommitment !== designRevision.revisionCommitment
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
    const expectedWorkspace = Object.freeze({
      ...context.workspace,
      files: Object.freeze(
        context.workspace.files.map((file) =>
          file.path === prepared.patch.path
            ? Object.freeze({ ...file, content: prepared.patch.nextContent })
            : file
        )
      )
    });
    if (this.persistence === undefined) return rejected('ATOMIC_PERSISTENCE_UNAVAILABLE');
    let outcome: ManualReactEditAtomicCommitOutcome | undefined;
    try {
      outcome = await this.persistence.replay({
        proposal,
        baseRevision: designRevision,
        workspace: context.workspace
      });
      if (outcome === undefined)
        outcome = await this.persistence.commit({
          proposal,
          baseRevision: designRevision,
          baseWorkspace: context.workspace,
          patch: prepared.patch
        });
    } catch {
      return rejected('ATOMIC_PERSISTENCE_UNAVAILABLE');
    }
    if (outcome === undefined) return rejected('ATOMIC_PERSISTENCE_UNAVAILABLE');
    const finalSnapshot = await this.snapshot(outcome.workspace);
    if (
      finalSnapshot === undefined ||
      outcome.workspace.projectId !== context.workspace.projectId ||
      outcome.workspace.revision.id === context.workspace.revision.id ||
      outcome.workspace.revision.parentId !== context.workspace.revision.id ||
      !sameWorkspaceContent(expectedWorkspace, outcome.workspace)
    )
      return rejected('DURABLE_COMMIT_EVIDENCE_INVALID');
    const result = await applyDesignEditProposal(
      proposal,
      {
        apply: async () => ({
          format: 'selene-design-edit-result/v1' as const,
          kind: outcome.kind,
          receipt: outcome.receipt
        })
      },
      { sha256 }
    );
    if (result.kind !== 'applied' && result.kind !== 'replayed') return result;
    if (
      result.receipt.sourceDigest !== finalSnapshot.sourceDigest ||
      result.receipt.bindingDigest !== finalSnapshot.bindingDigest ||
      result.receipt.targetRevision.tuple.sourceDigest !== finalSnapshot.sourceDigest ||
      result.receipt.targetRevision.tuple.bindingDigest !== finalSnapshot.bindingDigest
    )
      return rejected('DURABLE_COMMIT_EVIDENCE_INVALID');
    return result;
  }
}
