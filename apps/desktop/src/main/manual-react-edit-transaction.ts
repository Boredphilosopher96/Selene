import { createHash } from 'node:crypto';

import {
  serializeCanonicalData,
  type DesignEditProposal,
  type DesignEditResult,
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

const preparedResult = (prepared: ReactTsxDesignEditPreparation): DesignEditResult | undefined => {
  if (prepared.kind === 'prepared') return undefined;
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

export interface ManualReactEditTransactionPort {
  /** Never returns `applied` until a future port atomically persists all edit state. */
  evaluate(
    proposal: DesignEditProposal,
    context: Readonly<{
      readonly workspace: ReactSourceWorkspace;
      readonly designSystemLockDigest: string;
      /** Host-stored immutable design revision, never inferred from source revision text. */
      readonly designRevisionId?: string;
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
      readonly designRevisionId?: string;
    }>
  ): Promise<DesignEditResult> {
    return Promise.resolve(rejected('HOST_BINDING_UNAVAILABLE'));
  }
}

/**
 * Compiles the exact current workspace, derives opaque per-marker module IDs
 * from compiler evidence, and validates the host-local AST preparation. The
 * prepared patch is intentionally discarded because persistence is not yet
 * atomic across source, binding, receipt, replay, and undo state.
 */
export class CompilerBoundManualReactEditTransactionPort implements ManualReactEditTransactionPort {
  public constructor(private readonly compiler: ReactCompilerPort) {}

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
      readonly designRevisionId?: string;
    }>
  ): Promise<DesignEditResult> {
    if (context.designRevisionId === undefined) return rejected('DESIGN_REVISION_UNAVAILABLE');
    const snapshot = await this.snapshot(context.workspace);
    if (snapshot === undefined) return rejected('COMPILER_BINDING_UNAVAILABLE');
    if (
      proposal.base.projectId !== snapshot.projectId ||
      proposal.base.revisionId !== context.designRevisionId
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
    const result = preparedResult(prepared);
    if (result !== undefined) return result;
    return rejected('ATOMIC_PERSISTENCE_UNAVAILABLE');
  }
}
