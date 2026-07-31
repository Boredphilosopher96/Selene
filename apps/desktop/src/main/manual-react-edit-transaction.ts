import { createHash, randomUUID } from 'node:crypto';

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
  type ApprovedDesignSystemComponent,
  type HostSourceBinding,
  type PreparedReactTsxDesignEdit,
  type ReactTsxDesignEditPreparation
} from './react-tsx-design-edit-adapter';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Mirrors the core's deliberately private canonical host digest payload. */
const proposalDigest = (proposal: DesignEditProposal): string =>
  sha256(
    serializeCanonicalData([
      'selene-design-edit-proposal-digest/v1',
      proposal.proposalId,
      proposal.commandId,
      proposal.actorId,
      proposal.operation,
      proposal.base.revisionCommitment,
      proposal.commands,
      proposal.preconditions,
      proposal.requestedAt
    ])
  );

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
  readonly compilerId: string;
  readonly compilerDigest: string;
  readonly previewDigest: string;
  readonly sourceBindings: readonly HostSourceBinding[];
}

export type ManualReactEditCompilerEvidence = Omit<EditableBindingSnapshot, 'sourceBindings'>;

/**
 * Closed host outcome. Core validates its receipt independently before it can
 * become an external DesignEditResult. Raw source remains in the main process.
 */
export interface ManualReactEditAtomicCommitOutcome {
  readonly kind: 'applied' | 'replayed';
  readonly receipt: DesignEditReceipt;
  /** Present for a newly applied edit; replay never needs current source. */
  readonly workspace?: ReactSourceWorkspace;
  /**
   * Opaque main-process-only state to adopt after core has validated the
   * receipt. This must never cross preload or IPC.
   */
  readonly adoption?: ManualReactEditAdoption;
}

export interface ManualReactEditAdoption {
  readonly workspace: ReactSourceWorkspace;
  readonly designRevision: DesignRevision;
  /** Opaque validated journal state, retained only by the desktop service. */
  readonly journal?: readonly unknown[];
}

export interface ManualReactEditTransactionEvaluation {
  readonly result: DesignEditResult;
  /** Present only for an authenticated durable applied/replay outcome. */
  readonly adoption?: ManualReactEditAdoption;
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
      readonly proposalDigest: string;
      readonly baseRevision: DesignRevision;
      readonly workspace: ReactSourceWorkspace;
    }>
  ): Promise<ManualReactEditAtomicCommitOutcome | undefined>;
  commit(
    request: Readonly<{
      readonly proposal: DesignEditProposal;
      readonly proposalDigest: string;
      readonly baseRevision: DesignRevision;
      readonly baseWorkspace: ReactSourceWorkspace;
      readonly candidateWorkspace: ReactSourceWorkspace;
      /** Compiled before the atomic record commit; source/path data stays local. */
      readonly candidateEvidence: Readonly<{
        readonly sourceDigest: string;
        readonly bindingDigest: string;
        readonly compilerId: string;
        readonly compilerDigest: string;
        readonly previewDigest: string;
      }>;
      /** Host-local AST patch; it is never projected through preload. */
      readonly patch: PreparedReactTsxDesignEdit['patch'];
    }>
  ): Promise<ManualReactEditAtomicCommitOutcome>;
}

export interface ManualReactEditTransactionPort {
  /**
   * Compiles a host-owned workspace for a compensating operation. No source,
   * paths, or bindings cross the main-process boundary.
   */
  compileWorkspace?(
    workspace: ReactSourceWorkspace
  ): Promise<ManualReactEditCompilerEvidence | undefined>;
  /** Returns `applied` only from the host's atomic persistence authority. */
  evaluate(
    proposal: DesignEditProposal,
    context: Readonly<{
      readonly workspace: ReactSourceWorkspace;
      readonly designSystemLockDigest: string;
      readonly approvedComponents?: readonly ApprovedDesignSystemComponent[];
      /** Host-stored immutable revision, never inferred from source revision text. */
      readonly designRevision?: DesignRevision;
    }>
  ): Promise<DesignEditResult>;
  /**
   * Private richer result for the owning desktop service. Kept separate from
   * `evaluate` so the public renderer/preload/core contract remains exactly
   * `DesignEditResult`.
   */
  evaluateDetailed?(
    proposal: DesignEditProposal,
    context: Readonly<{
      readonly workspace: ReactSourceWorkspace;
      readonly designSystemLockDigest: string;
      readonly approvedComponents?: readonly ApprovedDesignSystemComponent[];
      readonly designRevision?: DesignRevision;
    }>
  ): Promise<ManualReactEditTransactionEvaluation>;
}

/** Default denial keeps fixtures and hosts without compiler authority mutation-free. */
export class UnavailableManualReactEditTransactionPort implements ManualReactEditTransactionPort {
  public evaluate(
    _proposal: DesignEditProposal,
    _context: Readonly<{
      readonly workspace: ReactSourceWorkspace;
      readonly designSystemLockDigest: string;
      readonly approvedComponents?: readonly ApprovedDesignSystemComponent[];
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
      // The compiler has already validated these exact declared dependencies
      // against its host-owned live registry. Reuse that bounded declaration
      // set for binding extraction so an approved design-system import is not
      // rejected by the evidence pass's dependency-free default policy.
      evidence = issueReactBindingCompilerEvidence(workspace, receipt, {
        allowedBareDependencies: workspace.dependencies
      });
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
      // Core compiler identifiers are bounded opaque IDs, while the build
      // receipt intentionally carries a slash-delimited protocol identity.
      compilerId: 'selene-vite-react-compiler-v1',
      compilerDigest: sha256(receipt.compilerIdentity),
      previewDigest: receipt.outputSha256,
      sourceBindings: Object.freeze(sourceBindings)
    });
  }

  public async compileWorkspace(
    workspace: ReactSourceWorkspace
  ): Promise<ManualReactEditCompilerEvidence | undefined> {
    const snapshot = await this.snapshot(workspace);
    if (snapshot === undefined) return undefined;
    const { sourceBindings: _sourceBindings, ...evidence } = snapshot;
    return Object.freeze(evidence);
  }

  public async evaluate(
    proposal: DesignEditProposal,
    context: Readonly<{
      readonly workspace: ReactSourceWorkspace;
      readonly designSystemLockDigest: string;
      readonly approvedComponents?: readonly ApprovedDesignSystemComponent[];
      readonly designRevision?: DesignRevision;
    }>
  ): Promise<DesignEditResult> {
    return (await this.evaluateDetailed(proposal, context)).result;
  }

  public async evaluateDetailed(
    proposal: DesignEditProposal,
    context: Readonly<{
      readonly workspace: ReactSourceWorkspace;
      readonly designSystemLockDigest: string;
      readonly approvedComponents?: readonly ApprovedDesignSystemComponent[];
      readonly designRevision?: DesignRevision;
    }>
  ): Promise<ManualReactEditTransactionEvaluation> {
    if (context.designRevision === undefined)
      return { result: rejected('DESIGN_REVISION_UNAVAILABLE') };
    let designRevision: DesignRevision;
    try {
      designRevision = parseDesignRevision(context.designRevision);
    } catch {
      return { result: rejected('DESIGN_REVISION_UNAVAILABLE') };
    }
    // An exact durable replay is intentionally checked before current-source
    // fencing: the current authority is the receipt target, not its base.
    if (this.persistence !== undefined) {
      try {
        const replay = await this.persistence.replay({
          proposal,
          proposalDigest: proposalDigest(proposal),
          baseRevision: designRevision,
          workspace: context.workspace
        });
        if (replay !== undefined) {
          const result = await applyDesignEditProposal(
            proposal,
            {
              apply: async () => ({
                format: 'selene-design-edit-result/v1' as const,
                kind: 'replayed' as const,
                receipt: replay.receipt
              })
            },
            { sha256 }
          );
          if (
            result.kind !== 'replayed' ||
            result.receipt.proposalDigest.value !== proposalDigest(proposal)
          )
            return { result: rejected('DURABLE_COMMIT_EVIDENCE_INVALID') };
          return Object.freeze({ result });
        }
      } catch {
        return { result: rejected('ATOMIC_PERSISTENCE_UNAVAILABLE') };
      }
    }
    const snapshot = await this.snapshot(context.workspace);
    if (snapshot === undefined) return { result: rejected('COMPILER_BINDING_UNAVAILABLE') };
    if (
      proposal.base.projectId !== snapshot.projectId ||
      proposal.base.revisionId !== designRevision.revisionId ||
      proposal.base.revisionCommitment !== designRevision.revisionCommitment
    )
      return {
        result: {
          format: 'selene-design-edit-result/v1',
          kind: 'conflict',
          diagnostics: [{ code: 'STALE_SOURCE' }]
        }
      };
    const prepared = prepareReactTsxDesignEdit(proposal, {
      workspace: context.workspace,
      sourceDigest: snapshot.sourceDigest,
      bindingDigest: snapshot.bindingDigest,
      designSystemLockDigest: context.designSystemLockDigest,
      sourceBindings: snapshot.sourceBindings,
      approvedComponents: context.approvedComponents ?? []
    });
    if (prepared.kind !== 'prepared') return { result: preparedResult(prepared) };
    const nextCreatedAt = new Date(
      Math.max(Date.now(), Date.parse(context.workspace.revision.createdAt) + 1)
    ).toISOString();
    const expectedWorkspace = Object.freeze({
      ...context.workspace,
      revision: Object.freeze({
        id: `manual-${randomUUID()}`,
        parentId: context.workspace.revision.id,
        createdAt: nextCreatedAt,
        summary:
          proposal.commands[0]?.kind === 'set-layout'
            ? 'Manual layout edit'
            : proposal.commands[0]?.kind === 'set-style'
              ? 'Manual appearance edit'
              : proposal.commands[0]?.kind === 'insert-child'
                ? 'Insert design-system component'
                : proposal.commands[0]?.kind === 'reorder-child'
                  ? 'Manual semantic reorder'
                  : proposal.commands[0]?.kind === 'reparent-child'
                    ? 'Manual semantic reparent'
                    : 'Manual content edit'
      }),
      dependencies: Object.freeze(
        prepared.patch.dependency === undefined ||
          context.workspace.dependencies.includes(prepared.patch.dependency)
          ? [...context.workspace.dependencies]
          : [...context.workspace.dependencies, prepared.patch.dependency].sort()
      ),
      nodes: Object.freeze(
        prepared.patch.addedNode === undefined
          ? [...context.workspace.nodes]
          : [...context.workspace.nodes, prepared.patch.addedNode].sort((left, right) =>
              left.nodeId.localeCompare(right.nodeId)
            )
      ),
      files: Object.freeze(
        context.workspace.files.map((file) =>
          file.path === prepared.patch.path
            ? Object.freeze({ ...file, content: prepared.patch.nextContent })
            : file
        )
      )
    });
    // Compile before committing. Persistence assigns the next immutable
    // lifecycle revision ID after this candidate has been proven buildable.
    const candidateSnapshot = await this.snapshot(expectedWorkspace);
    if (candidateSnapshot === undefined)
      return { result: rejected('CANDIDATE_COMPILATION_FAILED') };
    if (this.persistence === undefined)
      return { result: rejected('ATOMIC_PERSISTENCE_UNAVAILABLE') };
    let outcome: ManualReactEditAtomicCommitOutcome | undefined;
    try {
      outcome = await this.persistence.commit({
        proposal,
        proposalDigest: proposalDigest(proposal),
        baseRevision: designRevision,
        baseWorkspace: context.workspace,
        candidateWorkspace: expectedWorkspace,
        candidateEvidence: {
          sourceDigest: candidateSnapshot.sourceDigest,
          bindingDigest: candidateSnapshot.bindingDigest,
          compilerId: candidateSnapshot.compilerId,
          compilerDigest: candidateSnapshot.compilerDigest,
          previewDigest: candidateSnapshot.previewDigest
        },
        patch: prepared.patch
      });
    } catch {
      return { result: rejected('ATOMIC_PERSISTENCE_UNAVAILABLE') };
    }
    if (outcome === undefined) return { result: rejected('ATOMIC_PERSISTENCE_UNAVAILABLE') };
    if (outcome.workspace === undefined)
      return { result: rejected('DURABLE_COMMIT_EVIDENCE_INVALID') };
    if (
      outcome.kind !== 'applied' ||
      outcome.workspace.projectId !== context.workspace.projectId ||
      outcome.workspace.revision.id === context.workspace.revision.id ||
      outcome.workspace.revision.parentId !== context.workspace.revision.id ||
      !sameWorkspaceContent(expectedWorkspace, outcome.workspace)
    )
      return { result: rejected('DURABLE_COMMIT_EVIDENCE_INVALID') };
    if (
      outcome.adoption === undefined ||
      outcome.adoption.workspace.revision.id !== outcome.workspace.revision.id ||
      outcome.adoption.designRevision.revisionId !== outcome.receipt.targetRevisionId ||
      outcome.adoption.designRevision.revisionCommitment !==
        outcome.receipt.targetRevision.revisionCommitment
    )
      return { result: rejected('DURABLE_COMMIT_EVIDENCE_INVALID') };
    return Object.freeze({
      result: Object.freeze({
        format: 'selene-design-edit-result/v1' as const,
        kind: 'applied' as const,
        receipt: outcome.receipt
      }),
      adoption: outcome.adoption
    });
  }
}
