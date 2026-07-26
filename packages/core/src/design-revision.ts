/** Portable, data-only authority boundary for immutable generated-design revisions. */
export type DesignRevisionValidationCode =
  'invalid' | 'unsupported' | 'unauthorized' | 'stale' | 'conflict' | 'replay' | 'recovery';

export class DesignRevisionContractError extends Error {
  readonly code: DesignRevisionValidationCode;

  public constructor(
    code: DesignRevisionValidationCode = 'invalid',
    message = 'Design revision contract is invalid'
  ) {
    super(message);
    this.name = 'DesignRevisionContractError';
    this.code = code;
    Object.defineProperty(this, 'code', {
      enumerable: true,
      configurable: false,
      writable: false
    });
  }
}

const internalContractErrorScopes = new WeakMap<object, symbol>();
const contractErrorScopeStack: symbol[] = [];

export type DesignRevisionCapability =
  | 'design:revision.commit'
  | 'design:revision.preview'
  | 'design:revision.selection'
  | 'design:revision.inspect'
  | 'design:revision.edit'
  | 'design:revision.proposal'
  | 'design:revision.undo'
  | 'design:revision.baseline'
  | 'design:revision.publish'
  | 'design:revision.handoff';
export type DesignPrivacyClassification = 'internal' | 'restricted';
export type DesignPrivacyLifecycle = 'active' | 'redacted' | 'tombstoned' | 'expired';
export type DesignTelemetryField = 'geometry' | 'interaction-kind' | 'performance';
export type DesignPrivacyRequiredExclusion =
  | 'authorization-headers'
  | 'cookies'
  | 'customer-identifiers'
  | 'dom-snapshots'
  | 'local-paths'
  | 'page-content'
  | 'prompt-text'
  | 'prop-values'
  | 'source-text'
  | 'urls';

export const designRevisionRequiredPrivacyExclusions: readonly DesignPrivacyRequiredExclusion[] =
  Object.freeze([
    'authorization-headers',
    'cookies',
    'customer-identifiers',
    'dom-snapshots',
    'local-paths',
    'page-content',
    'prompt-text',
    'prop-values',
    'source-text',
    'urls'
  ] as const);

export interface DesignPrivacyField {
  readonly category: 'personal' | 'secret' | 'prompt';
  readonly mode: 'mask' | 'redact' | 'exclude';
  readonly digest: string;
}

export interface DesignRevisionPrivacy {
  readonly format: 'selene-design-privacy/v2';
  readonly classification: DesignPrivacyClassification;
  /** A digest of privacy-classified content, never raw source or personal data. */
  readonly contentDigest: string;
  readonly promptDigest?: string;
  readonly lifecycle: DesignPrivacyLifecycle;
  /** Required evidence for any non-active lifecycle state. */
  readonly lifecycleAudit?: DesignPrivacyTransition;
  readonly fields: readonly DesignPrivacyField[];
  readonly retention: { readonly deleteAfter: string };
  readonly deletion: { readonly action: 'tombstone'; readonly tombstoneDigest: string };
  readonly exportPolicyDigest: string;
  readonly auditCorrelationId: string;
  readonly exclusions: readonly string[];
  readonly telemetry: DesignRevisionTelemetryPolicy;
}

export type DesignRevisionTelemetryPolicy =
  | {
      readonly format: 'selene-design-telemetry-policy/v1';
      readonly mode: 'disabled';
      readonly consent: 'not-granted';
      readonly export: 'denied';
      readonly fields: readonly [];
    }
  | {
      readonly format: 'selene-design-telemetry-policy/v1';
      readonly mode: 'local-redacted';
      readonly consent: 'explicit';
      readonly export: 'denied';
      readonly fields: readonly DesignTelemetryField[];
    };

export interface DesignPrivacyTransition {
  readonly format: 'selene-design-privacy-transition/v1';
  readonly from: DesignPrivacyLifecycle;
  readonly to: DesignPrivacyLifecycle;
  readonly occurredAt: string;
  readonly auditCorrelationId: string;
  /** Trusted prior revision identity; required when a revision commits this transition. */
  readonly priorRevisionId?: string;
  /** Trusted prior tuple binding; required when a revision commits this transition. */
  readonly priorTupleBinding?: string;
  /** Deterministic commitment to immutable prior privacy policy fields. */
  readonly priorPrivacyBinding?: string;
  readonly tombstoneDigest?: string;
}

export type DesignPrivacyTransitionOutcome =
  | {
      readonly kind: 'preflight';
      readonly privacy: DesignRevisionPrivacy;
      readonly audit: DesignPrivacyTransition;
    }
  | { readonly kind: 'conflict'; readonly code: 'conflict' }
  | { readonly kind: 'unauthorized'; readonly code: 'unauthorized' };

/** A compiler-issued operation target, deliberately not a project-wide revision field. */
export interface CompilerIssuedNodeIdentity {
  readonly format: 'selene-compiler-node-identity/v2';
  readonly projectId: string;
  readonly nodeId: string;
  readonly compilerDigest: string;
  /** Stable, compiler-issued source binding; never a host filesystem path. */
  readonly source: CompilerSourceIdentity;
  /** Compiler-issued rendered occurrence; never renderer-asserted authority. */
  readonly instance: CompilerRenderedInstanceIdentity;
}

export interface CompilerSourceIdentity {
  readonly format: 'selene-compiler-source-identity/v1';
  /** Opaque project-relative module identity, not a local path or URL. */
  readonly moduleId: string;
  readonly exportName: string;
  readonly astNodeId: string;
  readonly sourceDigest: string;
  readonly bindingDigest: string;
}

export type CompilerRenderedInstanceRepeat =
  | { readonly kind: 'singleton' }
  | { readonly kind: 'collection-key'; readonly keyDigest: string }
  | { readonly kind: 'occurrence'; readonly occurrence: number };

/**
 * Distinguishes rendered occurrences which share one stable source anchor.
 * Context identifiers are compiler output and contain no DOM, path, URL, or prop values.
 */
export interface CompilerRenderedInstanceDescriptor {
  readonly format: 'selene-compiler-rendered-instance-identity/v1';
  readonly instanceId: string;
  readonly ancestry: readonly string[];
  readonly repeat: CompilerRenderedInstanceRepeat;
  readonly slotId?: string;
  readonly portalId?: string;
  readonly overlayId?: string;
}

export interface CompilerRenderedInstanceIdentity extends CompilerRenderedInstanceDescriptor {
  /** Canonical revision-and-manifest-bound identity recomputed by core. */
  readonly instanceDigest: string;
}

export interface DesignRevisionOperationTarget {
  readonly format: 'selene-design-revision-operation-target/v2';
  readonly tenantId: string;
  readonly projectId: string;
  readonly revisionId: string;
  readonly tupleBinding: string;
  readonly revisionCommitment: string;
  readonly node: CompilerIssuedNodeIdentity;
}

export type DesignRevisionOperationKind =
  | 'preview'
  | 'selection'
  | 'inspect'
  | 'edit'
  | 'proposal'
  | 'undo'
  | 'baseline'
  | 'publish'
  | 'handoff';

const designRevisionOperationCapabilities: Readonly<
  Record<DesignRevisionOperationKind, DesignRevisionCapability>
> = Object.freeze({
  preview: 'design:revision.preview',
  selection: 'design:revision.selection',
  inspect: 'design:revision.inspect',
  edit: 'design:revision.edit',
  proposal: 'design:revision.proposal',
  undo: 'design:revision.undo',
  baseline: 'design:revision.baseline',
  publish: 'design:revision.publish',
  handoff: 'design:revision.handoff'
});

/** Exact revision reference shared by every host-owned design operation. */
export interface DesignRevisionOperationReference {
  readonly format: 'selene-design-revision-operation-reference/v2';
  readonly kind: DesignRevisionOperationKind;
  readonly tenantId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly commandId: string;
  readonly revisionId: string;
  readonly tupleBinding: string;
  readonly revisionCommitment: string;
}

/** Local work is not assigned a deployment id until it is actually published. */
export type DeploymentIdentity =
  | {
      readonly format: 'selene-deployment-identity/v1';
      readonly state: 'unpublished';
      readonly draftId: string;
      readonly manifestDigest: string;
    }
  | {
      readonly format: 'selene-deployment-identity/v1';
      readonly state: 'deployed';
      readonly deploymentId: string;
      readonly manifestDigest: string;
    };

/** The compiled preview/build is distinct from both deployment and compiler identity. */
export interface CompiledPreviewIdentity {
  readonly format: 'selene-compiled-preview-identity/v1';
  readonly buildId: string;
  readonly previewDigest: string;
}

export interface CompilerIdentity {
  readonly format: 'selene-compiler-identity/v1';
  readonly compilerId: string;
  readonly compilerDigest: string;
}

/** The complete immutable project revision tuple. */
export interface DesignRevisionTuple {
  readonly sourceDigest: string;
  readonly graphDigest: string;
  readonly bindingDigest: string;
  readonly commandLogDigest: string;
  readonly designSystemLockDigest: string;
  readonly deployment: DeploymentIdentity;
  readonly preview: CompiledPreviewIdentity;
  readonly compiler: CompilerIdentity;
}

export interface DesignRevision {
  readonly format: 'selene-design-revision/v2';
  readonly tenantId: string;
  readonly projectId: string;
  readonly revisionId: string;
  readonly parentRevisionId?: string;
  readonly sequence: number;
  readonly createdAt: string;
  readonly tuple: DesignRevisionTuple;
  /** Canonical, deterministic tuple binding computed by this module, never accepted from callers. */
  readonly tupleBinding: string;
  readonly privacy: DesignRevisionPrivacy;
  /** Commitment to every canonical revision field, including privacy lifecycle evidence. */
  readonly revisionCommitment: string;
}

export interface DesignRevisionV1MigrationReceipt {
  readonly format: 'selene-design-revision-v1-migration-receipt/v1';
  readonly sourceFormat: 'selene-design-revision/v1';
  readonly sourceCommitment: string;
  readonly migratedRevision: DesignRevision;
  readonly migratedCommitment: string;
  readonly persistence: {
    readonly decision: 'host-must-persist-before-use';
    readonly requiredStateFormat: 'selene-design-revision-state/v2';
  };
}

export interface DesignRevisionPolicy {
  readonly format: 'selene-design-revision-policy/v2';
  readonly tenantId: string;
  readonly projectId: string;
  readonly policyId: string;
  readonly revision: number;
  readonly digest: string;
  readonly capabilities: readonly DesignRevisionCapability[];
  readonly trustAnchor: DesignRevisionTrustAnchor;
}

/** Stable host-issued terms which authorize a revision grant. */
export interface DesignRevisionTrustAnchor {
  readonly format: 'selene-design-revision-trust-anchor/v1';
  readonly issuer: string;
  readonly audience: string;
  readonly grantId: string;
  readonly schemaRevision: number;
  readonly commandsDigest: string;
}

/** Capability grant supplied by a host after its own authentication/authorization decision. */
export interface DesignRevisionAuthority {
  readonly format: 'selene-design-revision-authority/v2';
  readonly tenantId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly commandId: string;
  readonly policyId: string;
  readonly policyRevision: number;
  readonly policyDigest: string;
  readonly revisionId: string;
  readonly tupleBinding: string;
  readonly revisionCommitment: string;
  readonly capabilities: readonly DesignRevisionCapability[];
  readonly grantId: string;
  readonly grantEpoch: number;
  readonly issuer: string;
  readonly audience: string;
  readonly schemaRevision: number;
  readonly commandsDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
}

export interface DesignRevisionHead {
  readonly format: 'selene-design-revision-head/v2';
  readonly revisionId: string;
  readonly sequence: number;
  readonly createdAt: string;
  readonly tupleBinding: string;
  readonly privacy: DesignRevisionPrivacy;
  readonly privacyBinding: string;
  /** The complete canonical revision, persisted atomically with its commitment. */
  readonly revision: DesignRevision;
  readonly revisionCommitment: string;
}

export interface DesignRevisionState {
  readonly format: 'selene-design-revision-state/v2';
  readonly tenantId: string;
  readonly projectId: string;
  readonly policy: DesignRevisionPolicy;
  readonly grantStatus: DesignRevisionGrantStatus;
  readonly processedCommandIds: readonly string[];
  readonly head?: DesignRevisionHead;
}

export interface CommitDesignRevisionCommand {
  readonly format: 'selene-design-revision-command/v2';
  readonly authority: DesignRevisionAuthority;
  readonly revision: DesignRevision;
}

export type DesignRevisionOutcome =
  | { readonly kind: 'accepted'; readonly state: DesignRevisionState }
  | { readonly kind: 'invalid'; readonly code: 'invalid' }
  | { readonly kind: 'stale'; readonly code: 'stale' }
  | { readonly kind: 'conflict'; readonly code: 'conflict' }
  | { readonly kind: 'replay'; readonly code: 'replay' }
  | { readonly kind: 'unauthorized'; readonly code: 'unauthorized' }
  | { readonly kind: 'recovery'; readonly code: 'recovery' }
  | { readonly kind: 'unsupported'; readonly code: 'unsupported' };

export interface DesignRevisionHostCapabilities {
  readonly format: 'selene-design-revision-host-capabilities/v2';
  readonly issuer: string;
  readonly audience: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly grantId: string;
  readonly grantEpoch: number;
  readonly schemaRevision: number;
  readonly commandsDigest: string;
  readonly revisionId: string;
  readonly tupleBinding: string;
  readonly revisionCommitment: string;
  readonly policyRevision: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
  readonly capabilities: readonly DesignRevisionCapability[];
}

/** Authoritative grant status is state data, not a claim supplied by the authority bearer. */
export type DesignRevisionGrantStatus =
  | {
      readonly format: 'selene-design-revision-grant-status/v1';
      readonly grantId: string;
      readonly epoch: number;
      readonly state: 'active';
    }
  | {
      readonly format: 'selene-design-revision-grant-status/v1';
      readonly grantId: string;
      readonly epoch: number;
      readonly state: 'revoked';
      readonly revokedAt: string;
    };

export interface DesignRevisionHostNegotiationExpectation {
  readonly format: 'selene-design-revision-host-negotiation-expectation/v2';
  readonly tenantId: string;
  readonly projectId: string;
  readonly trustAnchor: DesignRevisionTrustAnchor;
  readonly grantStatus: DesignRevisionGrantStatus;
  readonly policyRevision: number;
  readonly revisionId: string;
  readonly tupleBinding: string;
  readonly revisionCommitment: string;
  readonly capabilities: readonly DesignRevisionCapability[];
}

export type DesignRevisionExportCapability = 'design:revision.export';

/** Host-issued export grant. It is only valid when it exactly matches host state. */
export interface DesignRevisionExportAuthority {
  readonly format: 'selene-design-revision-export-authority/v2';
  readonly authorityId: string;
  readonly epoch: number;
  readonly issuer: string;
  readonly audience: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly revisionId: string;
  readonly tupleBinding: string;
  readonly revisionCommitment: string;
  readonly privacyBinding: string;
  readonly lifecycle: DesignPrivacyLifecycle;
  readonly retentionDeleteAfter: string;
  readonly policyDigest: string;
  readonly exportPolicyDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly capabilities: readonly DesignRevisionExportCapability[];
}

/** Canonical host record for an export authority, including authoritative revocation state. */
export type DesignRevisionExportGrantStatus =
  | {
      readonly format: 'selene-design-revision-export-grant-status/v1';
      readonly authorityId: string;
      readonly epoch: number;
      readonly state: 'active';
    }
  | {
      readonly format: 'selene-design-revision-export-grant-status/v1';
      readonly authorityId: string;
      readonly epoch: number;
      readonly state: 'revoked';
      readonly revokedAt: string;
    };

/** Explicit host capability input; callers cannot authorize export by echoing a policy digest. */
export interface DesignRevisionExportHostState {
  readonly format: 'selene-design-revision-export-host-state/v2';
  readonly authorityId: string;
  readonly epoch: number;
  readonly issuer: string;
  readonly audience: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly revisionId: string;
  readonly tupleBinding: string;
  readonly revisionCommitment: string;
  readonly privacyBinding: string;
  readonly lifecycle: DesignPrivacyLifecycle;
  readonly retentionDeleteAfter: string;
  readonly policyDigest: string;
  readonly exportPolicyDigest: string;
  readonly authorityBinding: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly capabilities: readonly DesignRevisionExportCapability[];
  readonly grantStatus: DesignRevisionExportGrantStatus;
}

export interface DesignRevisionExportVerificationRequest {
  readonly format: 'selene-design-revision-export-verification-request/v2';
  readonly authorityId: string;
  readonly epoch: number;
  readonly audience: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly revisionId: string;
  readonly tupleBinding: string;
  readonly revisionCommitment: string;
  readonly privacyBinding: string;
  readonly lifecycle: DesignPrivacyLifecycle;
  readonly retentionDeleteAfter: string;
  /** Exact canonical commitment over every authority term, compared before consumption. */
  readonly authorityBinding: string;
  readonly now: string;
}

export type DesignRevisionExportVerificationResult =
  | { readonly kind: 'accepted'; readonly commitment: DesignRevisionExportHostState }
  | {
      /** The host verified the binding but did not consume this ineligible one-shot grant. */
      readonly kind: 'ineligible';
      readonly code: 'lifecycle' | 'retention';
      readonly commitment: DesignRevisionExportHostState;
    }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'replay' }
  | { readonly kind: 'unsupported' };

/** Host-owned adapter which atomically consumes only an eligible single-use export authority. */
export type DesignRevisionExportVerificationPort =
  | {
      verifyAndConsume(
        request: DesignRevisionExportVerificationRequest
      ): DesignRevisionExportVerificationResult;
    }
  | ((request: DesignRevisionExportVerificationRequest) => DesignRevisionExportVerificationResult);

export type DesignRevisionExportEligibility =
  | {
      readonly kind: 'eligible';
      readonly authorityId: string;
      readonly lifecycle: 'active';
    }
  | { readonly kind: 'ineligible'; readonly code: 'lifecycle' | 'retention' }
  | { readonly kind: 'replay'; readonly code: 'replay' }
  | { readonly kind: 'unauthorized'; readonly code: 'unauthorized' };

export type DesignRevisionHostNegotiationOutcome =
  | { readonly kind: 'accepted'; readonly capabilities: DesignRevisionHostCapabilities }
  | { readonly kind: 'invalid'; readonly code: 'invalid' }
  | { readonly kind: 'unauthorized'; readonly code: 'unauthorized' }
  | { readonly kind: 'unsupported'; readonly code: 'unsupported' };

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const maxCommands = 10_000;
const maxSnapshotBytes = 1_000_000;
const maxSnapshotNodes = 10_000;
const maxStateCommandSnapshotNodes = maxCommands * 2 + 1;
const maxStateCommandBytes = maxCommands * 128 + 4_096;

interface SnapshotBudget {
  bytes: number;
  nodes: number;
  stateCommandBytes: number;
  stateCommandNodes: number;
}

function fail(code: DesignRevisionValidationCode = 'invalid', message?: string): never {
  const error = new DesignRevisionContractError(code, message);
  internalContractErrorScopes.set(
    error,
    contractErrorScopeStack[contractErrorScopeStack.length - 1] ?? Symbol()
  );
  throw error;
}

function withContractErrorScope<Result>(run: (scope: symbol) => Result): Result {
  const scope = Symbol();
  contractErrorScopeStack.push(scope);
  try {
    return run(scope);
  } finally {
    contractErrorScopeStack.pop();
  }
}

function isInternalContractError(
  error: unknown,
  scope: symbol
): error is DesignRevisionContractError {
  return (
    typeof error === 'object' && error !== null && internalContractErrorScopes.get(error) === scope
  );
}

function boundedUtf8ByteLength(value: string, limit: number): number {
  if (value.length > limit) fail();
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) bytes += 1;
    else if (codeUnit <= 0x7ff) bytes += 2;
    else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
    if (bytes > limit) fail();
  }
  return bytes;
}

function countBytes(value: string, budget: SnapshotBudget, stateCommandScalar = false): void {
  const remaining = stateCommandScalar
    ? maxStateCommandBytes - budget.stateCommandBytes
    : maxSnapshotBytes - budget.bytes;
  // UTF-8 is never shorter than the JavaScript code-unit count. Reject before allocating
  // an encoded copy when the cheapest possible representation already exceeds the budget.
  const bytes = boundedUtf8ByteLength(value, remaining);
  if (stateCommandScalar) {
    budget.stateCommandBytes += bytes;
    if (budget.stateCommandBytes > maxStateCommandBytes) fail();
    return;
  }
  budget.bytes += bytes;
  if (budget.bytes > maxSnapshotBytes) fail();
}

/** Clones enumerable data only, rejects accessors/prototypes/cycles, and applies one aggregate budget. */
function snapshot(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
  budget: SnapshotBudget = { bytes: 0, nodes: 0, stateCommandBytes: 0, stateCommandNodes: 0 },
  stateCommandArray = false,
  recognizesStateCommandIds = false,
  stateCommandScalar = false
): unknown {
  if (depth > 32) fail();
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    if (
      stateCommandScalar
        ? ++budget.stateCommandNodes > maxStateCommandSnapshotNodes
        : ++budget.nodes > maxSnapshotNodes
    )
      fail();
    if (typeof value === 'number' && !Number.isFinite(value)) fail();
    if (typeof value === 'string') countBytes(value, budget, stateCommandScalar);
    return value;
  }
  if (typeof value !== 'object' || seen.has(value)) fail();
  try {
    seen.add(value);
    if (++budget.nodes > maxSnapshotNodes) fail();
    const isArray = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (isArray ? Array.prototype : Object.prototype)) fail();
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length > (isArray ? maxCommands + 1 : maxCommands) ||
      ownKeys.some((key) => typeof key !== 'string')
    )
      fail();
    const names = ownKeys as string[];
    if (isArray && names.some((name) => name !== 'length' && !/^(0|[1-9][0-9]*)$/.test(name)))
      fail();
    const descriptors = new Map<string, PropertyDescriptor>();
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor === undefined) fail();
      descriptors.set(name, descriptor);
    }
    if (names.some((name) => name !== 'length' && !descriptors.get(name)?.enumerable)) fail();
    if (isArray) {
      const length = descriptors.get('length')?.value;
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > maxCommands ||
        names.length !== length + 1
      )
        fail();
      if (stateCommandArray) {
        budget.stateCommandNodes += length;
        if (budget.stateCommandNodes > maxStateCommandSnapshotNodes) fail();
      } else {
        budget.nodes += length;
        if (budget.nodes > maxSnapshotNodes) fail();
      }
      const result = Array.from({ length }, (_, index) => {
        const descriptor = descriptors.get(String(index));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail();
        return snapshot(
          descriptor.value,
          depth + 1,
          seen,
          budget,
          false,
          false,
          stateCommandArray && typeof descriptor.value === 'string'
        );
      });
      seen.delete(value);
      return Object.freeze(result);
    }
    const result: Record<string, unknown> = {};
    for (const name of names) {
      const descriptor = descriptors.get(name);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail();
      countBytes(name, budget);
      Object.defineProperty(result, name, {
        value: snapshot(
          descriptor.value,
          depth + 1,
          seen,
          budget,
          recognizesStateCommandIds && depth === 0 && name === 'processedCommandIds'
        ),
        enumerable: true,
        configurable: false,
        writable: false
      });
    }
    seen.delete(value);
    return Object.freeze(result);
  } catch {
    fail();
  }
}

function exact(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const allowed = new Set([...required, ...optional]);
  if (keys.some((key) => !allowed.has(key)) || required.some((key) => !keys.includes(key))) fail();
  return record;
}

function snapshotRejectingLegacyFormat(value: unknown, legacyFormat: string): unknown {
  const captured = snapshot(value);
  if (
    typeof captured === 'object' &&
    captured !== null &&
    !Array.isArray(captured) &&
    (captured as Record<string, unknown>).format === legacyFormat
  )
    fail('unsupported');
  return captured;
}

function verificationFunction(
  value: unknown,
  name: string
): Readonly<{ invoke: (argument: unknown) => unknown }> | undefined {
  try {
    if (typeof value === 'function') {
      return Object.freeze({
        invoke: (argument: unknown) => Reflect.apply(value, undefined, [argument])
      });
    }
    if (typeof value !== 'object' || value === null) return undefined;
    let owner: object | null = value;
    for (let depth = 0; owner !== null && depth < 16; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name);
      if (descriptor !== undefined) {
        if (!('value' in descriptor) || typeof descriptor.value !== 'function') return undefined;
        const method = descriptor.value as (argument: unknown) => unknown;
        return Object.freeze({
          invoke: (argument: unknown) => Reflect.apply(method, value, [argument])
        });
      }
      owner = Object.getPrototypeOf(owner);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !identifierPattern.test(value)) fail();
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !digestPattern.test(value)) fail();
  return value;
}

function tupleBinding(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 2_048 ||
    !value.startsWith('["selene-design-revision-tuple-binding/v1",')
  )
    fail();
  return value;
}

function privacyBinding(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 4_096 ||
    (!value.startsWith('["selene-design-revision-privacy-binding/v1",') &&
      !value.startsWith('["selene-design-revision-privacy-binding/v2",'))
  )
    fail();
  return value;
}

function revisionCommitment(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 8_192 ||
    !value.startsWith('["selene-design-revision-commitment/v1",')
  )
    fail();
  return value;
}

function migrationSourceCommitment(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 8_192 ||
    !value.startsWith('["selene-design-revision-v1-source-commitment/v1",')
  )
    fail();
  return value;
}

function renderedInstanceDigest(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 8_192 ||
    !value.startsWith('["selene-compiler-rendered-instance-digest/v1",')
  )
    fail();
  return value;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail();
  return value as number;
}

function instant(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64) fail();
  try {
    if (new Date(value).toISOString() !== value) fail();
  } catch {
    fail();
  }
  return value;
}

function capability(value: unknown): DesignRevisionCapability {
  if (
    value !== 'design:revision.commit' &&
    value !== 'design:revision.preview' &&
    value !== 'design:revision.selection' &&
    value !== 'design:revision.inspect' &&
    value !== 'design:revision.edit' &&
    value !== 'design:revision.proposal' &&
    value !== 'design:revision.undo' &&
    value !== 'design:revision.baseline' &&
    value !== 'design:revision.publish' &&
    value !== 'design:revision.handoff'
  )
    fail('unsupported');
  return value;
}

function capabilities(value: unknown): readonly DesignRevisionCapability[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) fail();
  const accepted = value.map(capability).sort(compareCanonicalText);
  if (new Set(accepted).size !== accepted.length) fail();
  return Object.freeze(accepted);
}

function operationKind(value: unknown): DesignRevisionOperationKind {
  if (
    value !== 'preview' &&
    value !== 'selection' &&
    value !== 'inspect' &&
    value !== 'edit' &&
    value !== 'proposal' &&
    value !== 'undo' &&
    value !== 'baseline' &&
    value !== 'publish' &&
    value !== 'handoff'
  )
    fail('unsupported');
  return value;
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function privacy(value: unknown): DesignRevisionPrivacy {
  const input = exact(
    value,
    [
      'auditCorrelationId',
      'classification',
      'contentDigest',
      'deletion',
      'exclusions',
      'exportPolicyDigest',
      'fields',
      'format',
      'lifecycle',
      'retention',
      'telemetry'
    ],
    ['lifecycleAudit', 'promptDigest']
  );
  if (
    input.format !== 'selene-design-privacy/v2' ||
    (input.classification !== 'internal' && input.classification !== 'restricted') ||
    (input.lifecycle !== 'active' &&
      input.lifecycle !== 'redacted' &&
      input.lifecycle !== 'tombstoned' &&
      input.lifecycle !== 'expired')
  )
    fail('unsupported');
  if (!Array.isArray(input.fields) || !Array.isArray(input.exclusions)) fail();
  const promptDigest = input.promptDigest === undefined ? undefined : digest(input.promptDigest);
  const lifecycleAudit =
    input.lifecycleAudit === undefined
      ? undefined
      : parseDesignPrivacyTransition(input.lifecycleAudit);
  const auditCorrelationId = text(input.auditCorrelationId);
  if (
    (input.lifecycle === 'active' && lifecycleAudit !== undefined) ||
    (input.lifecycle !== 'active' &&
      (lifecycleAudit === undefined ||
        lifecycleAudit.to !== input.lifecycle ||
        lifecycleAudit.auditCorrelationId !== auditCorrelationId))
  )
    fail('conflict');
  const fields = input.fields
    .map((field) => {
      const entry = exact(field, ['category', 'digest', 'mode']);
      if (
        (entry.category !== 'personal' &&
          entry.category !== 'secret' &&
          entry.category !== 'prompt') ||
        (entry.mode !== 'mask' && entry.mode !== 'redact' && entry.mode !== 'exclude')
      )
        fail('unsupported');
      return Object.freeze({
        category: entry.category,
        mode: entry.mode,
        digest: digest(entry.digest)
      });
    })
    .sort((left, right) =>
      compareCanonicalText(
        `${left.category}\0${left.mode}\0${left.digest}`,
        `${right.category}\0${right.mode}\0${right.digest}`
      )
    );
  if (
    new Set(fields.map((field) => `${field.category}\0${field.mode}\0${field.digest}`)).size !==
    fields.length
  )
    fail('conflict');
  const providedExclusions = input.exclusions.map(text);
  if (new Set(providedExclusions).size !== providedExclusions.length) fail('conflict');
  const exclusions = providedExclusions.sort(compareCanonicalText);
  if (
    designRevisionRequiredPrivacyExclusions.some(
      (requiredExclusion) => !exclusions.includes(requiredExclusion)
    )
  )
    fail('unauthorized');
  const telemetryInput = exact(input.telemetry, ['consent', 'export', 'fields', 'format', 'mode']);
  if (
    telemetryInput.format !== 'selene-design-telemetry-policy/v1' ||
    telemetryInput.export !== 'denied' ||
    !Array.isArray(telemetryInput.fields)
  )
    fail('unsupported');
  const telemetryFields = telemetryInput.fields
    .map((field) =>
      field === 'geometry' || field === 'interaction-kind' || field === 'performance'
        ? field
        : fail('unsupported')
    )
    .sort(compareCanonicalText);
  if (new Set(telemetryFields).size !== telemetryFields.length) fail('conflict');
  const telemetry: DesignRevisionTelemetryPolicy =
    telemetryInput.mode === 'disabled' &&
    telemetryInput.consent === 'not-granted' &&
    telemetryFields.length === 0
      ? Object.freeze({
          format: telemetryInput.format,
          mode: 'disabled',
          consent: 'not-granted',
          export: 'denied',
          fields: Object.freeze([]) as readonly []
        })
      : telemetryInput.mode === 'local-redacted' &&
          telemetryInput.consent === 'explicit' &&
          telemetryFields.length > 0
        ? Object.freeze({
            format: telemetryInput.format,
            mode: 'local-redacted',
            consent: 'explicit',
            export: 'denied',
            fields: Object.freeze(telemetryFields)
          })
        : fail('unauthorized');
  const retention = exact(input.retention, ['deleteAfter']);
  const deletion = exact(input.deletion, ['action', 'tombstoneDigest']);
  if (deletion.action !== 'tombstone') fail('unsupported');
  return Object.freeze({
    format: 'selene-design-privacy/v2',
    classification: input.classification,
    contentDigest: digest(input.contentDigest),
    ...(promptDigest === undefined ? {} : { promptDigest }),
    lifecycle: input.lifecycle,
    ...(lifecycleAudit === undefined ? {} : { lifecycleAudit }),
    fields: Object.freeze(fields),
    retention: Object.freeze({
      deleteAfter: instant(retention.deleteAfter)
    }),
    deletion: Object.freeze({
      action: deletion.action,
      tombstoneDigest: digest(deletion.tombstoneDigest)
    }),
    exportPolicyDigest: digest(input.exportPolicyDigest),
    auditCorrelationId,
    exclusions: Object.freeze(exclusions),
    telemetry
  });
}

function migrateDesignPrivacyV1(
  value: unknown
): Readonly<{ privacy: DesignRevisionPrivacy; sourceBinding: string }> {
  const input = exact(
    value,
    [
      'auditCorrelationId',
      'classification',
      'contentDigest',
      'deletion',
      'exclusions',
      'exportPolicyDigest',
      'fields',
      'format',
      'lifecycle',
      'retention'
    ],
    ['lifecycleAudit', 'promptDigest']
  );
  if (input.format !== 'selene-design-privacy/v1' || !Array.isArray(input.exclusions))
    fail('unsupported');
  const legacyExclusions = input.exclusions.map(text).sort(compareCanonicalText);
  if (new Set(legacyExclusions).size !== legacyExclusions.length) fail('conflict');
  const migrated = privacy({
    ...input,
    format: 'selene-design-privacy/v2',
    exclusions: [...new Set([...legacyExclusions, ...designRevisionRequiredPrivacyExclusions])],
    telemetry: {
      format: 'selene-design-telemetry-policy/v1',
      mode: 'disabled',
      consent: 'not-granted',
      export: 'denied',
      fields: []
    }
  });
  const audit = migrated.lifecycleAudit;
  return Object.freeze({
    privacy: migrated,
    sourceBinding: JSON.stringify([
      'selene-design-privacy-v1-source-binding/v1',
      migrated.classification,
      migrated.contentDigest,
      migrated.promptDigest ?? null,
      migrated.lifecycle,
      audit === undefined
        ? null
        : [
            audit.format,
            audit.from,
            audit.to,
            audit.occurredAt,
            audit.auditCorrelationId,
            audit.priorRevisionId ?? null,
            audit.priorTupleBinding ?? null,
            audit.priorPrivacyBinding ?? null,
            audit.tombstoneDigest ?? null
          ],
      migrated.fields.map((field) => [field.category, field.mode, field.digest]),
      migrated.retention.deleteAfter,
      migrated.deletion.action,
      migrated.deletion.tombstoneDigest,
      migrated.exportPolicyDigest,
      migrated.auditCorrelationId,
      legacyExclusions
    ])
  });
}

function serializedBindingInput(value: string): unknown {
  if (typeof value !== 'string' || value.length > maxSnapshotBytes) fail();
  boundedUtf8ByteLength(value, maxSnapshotBytes);
  try {
    return snapshot(JSON.parse(value));
  } catch {
    fail();
  }
}

function createDesignRevisionPrivacyBindingFromParsed(parsed: DesignRevisionPrivacy): string {
  return privacyBinding(
    JSON.stringify([
      'selene-design-revision-privacy-binding/v2',
      parsed.classification,
      parsed.contentDigest,
      parsed.promptDigest ?? null,
      parsed.fields.map((field) => [field.category, field.mode, field.digest]),
      parsed.retention.deleteAfter,
      parsed.deletion.action,
      parsed.deletion.tombstoneDigest,
      parsed.exportPolicyDigest,
      parsed.auditCorrelationId,
      [...parsed.exclusions],
      [
        parsed.telemetry.format,
        parsed.telemetry.mode,
        parsed.telemetry.consent,
        parsed.telemetry.export,
        [...parsed.telemetry.fields]
      ]
    ])
  );
}

function parseCompilerSourceIdentity(value: unknown): CompilerSourceIdentity {
  const source = exact(value, [
    'astNodeId',
    'bindingDigest',
    'exportName',
    'format',
    'moduleId',
    'sourceDigest'
  ]);
  if (source.format !== 'selene-compiler-source-identity/v1') fail('unsupported');
  return Object.freeze({
    format: source.format,
    moduleId: text(source.moduleId),
    exportName: text(source.exportName),
    astNodeId: text(source.astNodeId),
    sourceDigest: digest(source.sourceDigest),
    bindingDigest: digest(source.bindingDigest)
  });
}

function parseRenderedInstanceDescriptor(
  value: unknown,
  requiresDigest: boolean
): CompilerRenderedInstanceDescriptor | CompilerRenderedInstanceIdentity {
  const required = ['ancestry', 'format', 'instanceId', 'repeat'];
  if (requiresDigest) required.push('instanceDigest');
  const instanceInput = exact(value, required, ['overlayId', 'portalId', 'slotId']);
  if (
    instanceInput.format !== 'selene-compiler-rendered-instance-identity/v1' ||
    !Array.isArray(instanceInput.ancestry) ||
    instanceInput.ancestry.length < 1 ||
    instanceInput.ancestry.length > 32
  )
    fail('unsupported');
  const ancestry = instanceInput.ancestry.map(text);
  const repeatInput = exact(instanceInput.repeat, ['kind'], ['keyDigest', 'occurrence']);
  const repeat: CompilerRenderedInstanceRepeat =
    repeatInput.kind === 'singleton' &&
    repeatInput.keyDigest === undefined &&
    repeatInput.occurrence === undefined
      ? Object.freeze({ kind: 'singleton' })
      : repeatInput.kind === 'collection-key' &&
          repeatInput.keyDigest !== undefined &&
          repeatInput.occurrence === undefined
        ? Object.freeze({
            kind: 'collection-key',
            keyDigest: digest(repeatInput.keyDigest)
          })
        : repeatInput.kind === 'occurrence' &&
            repeatInput.keyDigest === undefined &&
            repeatInput.occurrence !== undefined
          ? Object.freeze({
              kind: 'occurrence',
              occurrence: integer(repeatInput.occurrence)
            })
          : fail('unsupported');
  const optionalContext = (context: unknown): string | undefined =>
    context === undefined ? undefined : text(context);
  const slotId = optionalContext(instanceInput.slotId);
  const portalId = optionalContext(instanceInput.portalId);
  const overlayId = optionalContext(instanceInput.overlayId);
  return Object.freeze({
    format: instanceInput.format,
    instanceId: text(instanceInput.instanceId),
    ancestry: Object.freeze(ancestry),
    repeat,
    ...(slotId === undefined ? {} : { slotId }),
    ...(portalId === undefined ? {} : { portalId }),
    ...(overlayId === undefined ? {} : { overlayId }),
    ...(requiresDigest
      ? { instanceDigest: renderedInstanceDigest(instanceInput.instanceDigest) }
      : {})
  });
}

export function parseCompilerIssuedNodeIdentity(value: unknown): CompilerIssuedNodeIdentity {
  const input = exact(snapshotRejectingLegacyFormat(value, 'selene-compiler-node-identity/v1'), [
    'compilerDigest',
    'format',
    'instance',
    'nodeId',
    'projectId',
    'source'
  ]);
  if (input.format !== 'selene-compiler-node-identity/v2') fail('unsupported');
  return Object.freeze({
    format: input.format,
    projectId: text(input.projectId),
    nodeId: text(input.nodeId),
    compilerDigest: digest(input.compilerDigest),
    source: parseCompilerSourceIdentity(input.source),
    instance: parseRenderedInstanceDescriptor(
      input.instance,
      true
    ) as CompilerRenderedInstanceIdentity
  });
}

/** Recomputes the compiler instance identity from source, occurrence, and revision manifest data. */
export function createCompilerRenderedInstanceDigest(
  revisionValue: unknown,
  sourceValue: unknown,
  instanceValue: unknown
): string {
  const revision = parseDesignRevision(revisionValue);
  const source = parseCompilerSourceIdentity(snapshot(sourceValue));
  const instance = parseRenderedInstanceDescriptor(
    snapshot(instanceValue),
    false
  ) as CompilerRenderedInstanceDescriptor;
  if (
    source.sourceDigest !== revision.tuple.sourceDigest ||
    source.bindingDigest !== revision.tuple.bindingDigest
  )
    fail('conflict');
  const repeatBinding =
    instance.repeat.kind === 'singleton'
      ? ['singleton']
      : instance.repeat.kind === 'collection-key'
        ? ['collection-key', instance.repeat.keyDigest]
        : ['occurrence', instance.repeat.occurrence];
  return renderedInstanceDigest(
    JSON.stringify([
      'selene-compiler-rendered-instance-digest/v1',
      source.format,
      source.moduleId,
      source.exportName,
      source.astNodeId,
      source.sourceDigest,
      source.bindingDigest,
      instance.format,
      instance.instanceId,
      [...instance.ancestry],
      repeatBinding,
      instance.slotId ?? null,
      instance.portalId ?? null,
      instance.overlayId ?? null,
      revision.tupleBinding,
      revision.tuple.designSystemLockDigest,
      revision.tuple.compiler.compilerDigest
    ])
  );
}

function deployment(value: unknown): DeploymentIdentity {
  const input = exact(value, ['format', 'manifestDigest', 'state'], ['deploymentId', 'draftId']);
  if (input.format !== 'selene-deployment-identity/v1') fail('unsupported');
  const manifestDigest = digest(input.manifestDigest);
  if (
    input.state === 'unpublished' &&
    input.draftId !== undefined &&
    input.deploymentId === undefined
  ) {
    return Object.freeze({
      format: input.format,
      state: 'unpublished',
      draftId: text(input.draftId),
      manifestDigest
    });
  }
  if (
    input.state === 'deployed' &&
    input.deploymentId !== undefined &&
    input.draftId === undefined
  ) {
    return Object.freeze({
      format: input.format,
      state: 'deployed',
      deploymentId: text(input.deploymentId),
      manifestDigest
    });
  }
  fail('unsupported');
}

function tuple(value: unknown): DesignRevisionTuple {
  const input = exact(value, [
    'bindingDigest',
    'commandLogDigest',
    'compiler',
    'deployment',
    'designSystemLockDigest',
    'graphDigest',
    'preview',
    'sourceDigest'
  ]);
  const preview = exact(input.preview, ['buildId', 'format', 'previewDigest']);
  const compiler = exact(input.compiler, ['compilerDigest', 'compilerId', 'format']);
  if (
    preview.format !== 'selene-compiled-preview-identity/v1' ||
    compiler.format !== 'selene-compiler-identity/v1'
  )
    fail('unsupported');
  return Object.freeze({
    sourceDigest: digest(input.sourceDigest),
    graphDigest: digest(input.graphDigest),
    bindingDigest: digest(input.bindingDigest),
    commandLogDigest: digest(input.commandLogDigest),
    designSystemLockDigest: digest(input.designSystemLockDigest),
    deployment: deployment(input.deployment),
    preview: Object.freeze({
      format: preview.format,
      buildId: text(preview.buildId),
      previewDigest: digest(preview.previewDigest)
    }),
    compiler: Object.freeze({
      format: compiler.format,
      compilerId: text(compiler.compilerId),
      compilerDigest: digest(compiler.compilerDigest)
    })
  });
}

function createDesignRevisionTupleBindingFromParsed(tupleValue: DesignRevisionTuple): string {
  const deploymentBinding =
    tupleValue.deployment.state === 'unpublished'
      ? ['unpublished', tupleValue.deployment.draftId, tupleValue.deployment.manifestDigest]
      : ['deployed', tupleValue.deployment.deploymentId, tupleValue.deployment.manifestDigest];
  return tupleBinding(
    JSON.stringify([
      'selene-design-revision-tuple-binding/v1',
      tupleValue.sourceDigest,
      tupleValue.graphDigest,
      tupleValue.bindingDigest,
      tupleValue.commandLogDigest,
      tupleValue.designSystemLockDigest,
      ...deploymentBinding,
      tupleValue.preview.buildId,
      tupleValue.preview.previewDigest,
      tupleValue.compiler.compilerId,
      tupleValue.compiler.compilerDigest
    ])
  );
}

function createDesignRevisionCommitmentFromParsed(
  revision: Omit<DesignRevision, 'revisionCommitment'>
): string {
  const audit = revision.privacy.lifecycleAudit;
  return revisionCommitment(
    JSON.stringify([
      'selene-design-revision-commitment/v1',
      revision.format,
      revision.tenantId,
      revision.projectId,
      revision.revisionId,
      revision.parentRevisionId ?? null,
      revision.sequence,
      revision.createdAt,
      revision.tupleBinding,
      createDesignRevisionPrivacyBindingFromParsed(revision.privacy),
      revision.privacy.lifecycle,
      audit === undefined
        ? null
        : [
            audit.format,
            audit.from,
            audit.to,
            audit.occurredAt,
            audit.auditCorrelationId,
            audit.priorRevisionId ?? null,
            audit.priorTupleBinding ?? null,
            audit.priorPrivacyBinding ?? null,
            audit.tombstoneDigest ?? null
          ]
    ])
  );
}

/**
 * Canonically binds a bounded JSON privacy payload. Object values are deliberately not accepted at
 * this public boundary: JavaScript Proxy meta-traps cannot be detected without invoking them.
 */
export function createDesignRevisionPrivacyBinding(serializedPrivacy: string): string {
  return createDesignRevisionPrivacyBindingFromParsed(
    privacy(serializedBindingInput(serializedPrivacy))
  );
}

/**
 * Canonically binds a bounded JSON tuple payload. Object values are deliberately not accepted at
 * this public boundary: JavaScript Proxy meta-traps cannot be detected without invoking them.
 */
export function createDesignRevisionTupleBinding(serializedTuple: string): string {
  return createDesignRevisionTupleBindingFromParsed(tuple(serializedBindingInput(serializedTuple)));
}

/** Canonically binds every immutable revision field from bounded serialized JSON. */
export function createDesignRevisionCommitment(serializedRevision: string): string {
  return parseDesignRevision(serializedBindingInput(serializedRevision)).revisionCommitment;
}

export function parseDesignRevisionTrustAnchor(value: unknown): DesignRevisionTrustAnchor {
  const input = exact(snapshot(value), [
    'audience',
    'commandsDigest',
    'format',
    'grantId',
    'issuer',
    'schemaRevision'
  ]);
  if (input.format !== 'selene-design-revision-trust-anchor/v1') fail('unsupported');
  return Object.freeze({
    format: input.format,
    issuer: text(input.issuer),
    audience: text(input.audience),
    grantId: text(input.grantId),
    schemaRevision: integer(input.schemaRevision),
    commandsDigest: digest(input.commandsDigest)
  });
}

export function parseDesignRevisionGrantStatus(value: unknown): DesignRevisionGrantStatus {
  const input = exact(snapshot(value), ['epoch', 'format', 'grantId', 'state'], ['revokedAt']);
  if (input.format !== 'selene-design-revision-grant-status/v1') fail('unsupported');
  const grantId = text(input.grantId);
  const epoch = integer(input.epoch);
  if (input.state === 'active' && input.revokedAt === undefined) {
    return Object.freeze({ format: input.format, grantId, epoch, state: 'active' });
  }
  if (input.state === 'revoked' && input.revokedAt !== undefined) {
    return Object.freeze({
      format: input.format,
      grantId,
      epoch,
      state: 'revoked',
      revokedAt: instant(input.revokedAt)
    });
  }
  fail('invalid');
}

export function compileDesignRevisionPolicy(value: unknown): DesignRevisionPolicy {
  const input = exact(snapshot(value), [
    'capabilities',
    'digest',
    'format',
    'policyId',
    'projectId',
    'revision',
    'tenantId',
    'trustAnchor'
  ]);
  if (
    input.format !== 'selene-design-revision-policy/v1' &&
    input.format !== 'selene-design-revision-policy/v2'
  )
    fail('unsupported');
  const acceptedCapabilities = capabilities(input.capabilities);
  if (
    input.format === 'selene-design-revision-policy/v1' &&
    (acceptedCapabilities.length !== 1 || acceptedCapabilities[0] !== 'design:revision.commit')
  )
    fail('unsupported');
  return Object.freeze({
    format: 'selene-design-revision-policy/v2',
    tenantId: text(input.tenantId),
    projectId: text(input.projectId),
    policyId: text(input.policyId),
    revision: integer(input.revision),
    digest: digest(input.digest),
    capabilities: acceptedCapabilities,
    trustAnchor: parseDesignRevisionTrustAnchor(input.trustAnchor)
  });
}

export function parseDesignRevision(value: unknown): DesignRevision {
  const input = exact(
    snapshot(value),
    ['createdAt', 'format', 'privacy', 'projectId', 'revisionId', 'sequence', 'tenantId', 'tuple'],
    ['parentRevisionId', 'revisionCommitment', 'tupleBinding']
  );
  if (input.format !== 'selene-design-revision/v2') fail('unsupported');
  const parsedTuple = tuple(input.tuple);
  const parentRevisionId =
    input.parentRevisionId === undefined ? undefined : text(input.parentRevisionId);
  const computedTupleBinding = createDesignRevisionTupleBindingFromParsed(parsedTuple);
  if (input.tupleBinding !== undefined && tupleBinding(input.tupleBinding) !== computedTupleBinding)
    fail('conflict');
  const parsed = Object.freeze({
    format: 'selene-design-revision/v2' as const,
    tenantId: text(input.tenantId),
    projectId: text(input.projectId),
    revisionId: text(input.revisionId),
    ...(parentRevisionId === undefined ? {} : { parentRevisionId }),
    sequence: integer(input.sequence),
    createdAt: instant(input.createdAt),
    tuple: parsedTuple,
    tupleBinding: computedTupleBinding,
    privacy: privacy(input.privacy)
  });
  const computedRevisionCommitment = createDesignRevisionCommitmentFromParsed(parsed);
  if (
    input.revisionCommitment !== undefined &&
    revisionCommitment(input.revisionCommitment) !== computedRevisionCommitment
  )
    fail('conflict');
  return Object.freeze({
    ...parsed,
    revisionCommitment: computedRevisionCommitment
  });
}

/** Explicitly migrates a bounded legacy identity; callers must persist the receipt before use. */
export function migrateDesignRevisionV1(value: unknown): DesignRevisionV1MigrationReceipt {
  const input = exact(
    snapshot(value),
    ['createdAt', 'format', 'privacy', 'projectId', 'revisionId', 'sequence', 'tenantId', 'tuple'],
    ['parentRevisionId', 'tupleBinding']
  );
  if (input.format !== 'selene-design-revision/v1') fail('unsupported');
  const parsedTuple = tuple(input.tuple);
  const computedTupleBinding = createDesignRevisionTupleBindingFromParsed(parsedTuple);
  if (input.tupleBinding !== undefined && tupleBinding(input.tupleBinding) !== computedTupleBinding)
    fail('conflict');
  const tenantId = text(input.tenantId);
  const projectId = text(input.projectId);
  const revisionId = text(input.revisionId);
  const parentRevisionId =
    input.parentRevisionId === undefined ? undefined : text(input.parentRevisionId);
  const sequence = integer(input.sequence);
  const createdAt = instant(input.createdAt);
  const migratedPrivacy = migrateDesignPrivacyV1(input.privacy);
  const sourceCommitment = migrationSourceCommitment(
    JSON.stringify([
      'selene-design-revision-v1-source-commitment/v1',
      tenantId,
      projectId,
      revisionId,
      parentRevisionId ?? null,
      sequence,
      createdAt,
      computedTupleBinding,
      migratedPrivacy.sourceBinding
    ])
  );
  const migratedRevision = parseDesignRevision({
    format: 'selene-design-revision/v2',
    tenantId,
    projectId,
    revisionId,
    ...(parentRevisionId === undefined ? {} : { parentRevisionId }),
    sequence,
    createdAt,
    tuple: parsedTuple,
    tupleBinding: computedTupleBinding,
    privacy: migratedPrivacy.privacy
  });
  return Object.freeze({
    format: 'selene-design-revision-v1-migration-receipt/v1',
    sourceFormat: 'selene-design-revision/v1',
    sourceCommitment,
    migratedRevision,
    migratedCommitment: migratedRevision.revisionCommitment,
    persistence: Object.freeze({
      decision: 'host-must-persist-before-use',
      requiredStateFormat: 'selene-design-revision-state/v2'
    })
  });
}

/** Creates the only valid form of a node operation target: revision identity plus compiler node. */
export function createDesignRevisionOperationTarget(
  revisionValue: unknown,
  nodeValue: unknown
): DesignRevisionOperationTarget {
  const revision = parseDesignRevision(revisionValue);
  const node = parseCompilerIssuedNodeIdentity(nodeValue);
  const { instanceDigest: issuedInstanceDigest, ...instanceDescriptor } = node.instance;
  if (
    node.projectId !== revision.projectId ||
    node.compilerDigest !== revision.tuple.compiler.compilerDigest ||
    node.source.sourceDigest !== revision.tuple.sourceDigest ||
    node.source.bindingDigest !== revision.tuple.bindingDigest ||
    issuedInstanceDigest !==
      createCompilerRenderedInstanceDigest(revision, node.source, instanceDescriptor)
  )
    fail('conflict');
  return Object.freeze({
    format: 'selene-design-revision-operation-target/v2',
    tenantId: revision.tenantId,
    projectId: revision.projectId,
    revisionId: revision.revisionId,
    tupleBinding: revision.tupleBinding,
    revisionCommitment: revision.revisionCommitment,
    node
  });
}

/** Validates an externally transported target against its owning immutable revision. */
export function parseDesignRevisionOperationTarget(
  value: unknown,
  revisionValue: unknown
): DesignRevisionOperationTarget {
  const revision = parseDesignRevision(revisionValue);
  const input = exact(
    snapshotRejectingLegacyFormat(value, 'selene-design-revision-operation-target/v1'),
    ['format', 'node', 'projectId', 'revisionCommitment', 'revisionId', 'tenantId', 'tupleBinding']
  );
  if (input.format !== 'selene-design-revision-operation-target/v2') fail('unsupported');
  if (
    text(input.tenantId) !== revision.tenantId ||
    text(input.projectId) !== revision.projectId ||
    text(input.revisionId) !== revision.revisionId ||
    tupleBinding(input.tupleBinding) !== revision.tupleBinding ||
    revisionCommitment(input.revisionCommitment) !== revision.revisionCommitment
  )
    fail('conflict');
  return createDesignRevisionOperationTarget(revision, input.node);
}

export function createDesignRevisionOperationReference(
  revisionValue: unknown,
  authorityValue: unknown,
  kindValue: unknown,
  stateValue: unknown,
  now: string
): DesignRevisionOperationReference {
  const revision = parseDesignRevision(revisionValue);
  const authority = parseDesignRevisionAuthority(authorityValue);
  const kind = operationKind(kindValue);
  const state = parseDesignRevisionState(stateValue);
  const at = instant(now);
  const requiredCapability = designRevisionOperationCapabilities[kind];
  const trustAnchor = state.policy.trustAnchor;
  if (
    state.head === undefined ||
    state.head.revisionId !== revision.revisionId ||
    state.head.tupleBinding !== revision.tupleBinding ||
    state.head.revisionCommitment !== revision.revisionCommitment ||
    state.tenantId !== revision.tenantId ||
    state.projectId !== revision.projectId ||
    authority.tenantId !== revision.tenantId ||
    authority.projectId !== revision.projectId ||
    authority.revisionId !== revision.revisionId ||
    authority.tupleBinding !== revision.tupleBinding ||
    authority.revisionCommitment !== revision.revisionCommitment ||
    authority.policyId !== state.policy.policyId ||
    authority.policyRevision !== state.policy.revision ||
    authority.policyDigest !== state.policy.digest ||
    !state.policy.capabilities.includes(requiredCapability) ||
    !authority.capabilities.includes(requiredCapability) ||
    authority.capabilities.some(
      (capabilityValue) => !state.policy.capabilities.includes(capabilityValue)
    ) ||
    authority.issuer !== trustAnchor.issuer ||
    authority.audience !== trustAnchor.audience ||
    authority.grantId !== trustAnchor.grantId ||
    authority.schemaRevision !== trustAnchor.schemaRevision ||
    authority.commandsDigest !== trustAnchor.commandsDigest ||
    state.grantStatus.state !== 'active' ||
    authority.grantId !== state.grantStatus.grantId ||
    authority.grantEpoch !== state.grantStatus.epoch ||
    (authority.revokedAt !== undefined && authority.revokedAt <= at) ||
    at < authority.issuedAt ||
    at > authority.expiresAt ||
    state.processedCommandIds.includes(authority.commandId) ||
    revision.privacy.lifecycle === 'tombstoned' ||
    revision.privacy.lifecycle === 'expired' ||
    at >= revision.privacy.retention.deleteAfter
  )
    fail('unauthorized');
  return Object.freeze({
    format: 'selene-design-revision-operation-reference/v2',
    kind,
    tenantId: revision.tenantId,
    projectId: revision.projectId,
    actorId: authority.actorId,
    commandId: authority.commandId,
    revisionId: revision.revisionId,
    tupleBinding: revision.tupleBinding,
    revisionCommitment: revision.revisionCommitment
  });
}

export function parseDesignRevisionOperationReference(
  value: unknown,
  revisionValue: unknown,
  authorityValue: unknown,
  stateValue: unknown,
  now: string
): DesignRevisionOperationReference {
  const input = exact(snapshot(value), [
    'actorId',
    'commandId',
    'format',
    'kind',
    'projectId',
    'revisionCommitment',
    'revisionId',
    'tenantId',
    'tupleBinding'
  ]);
  if (input.format !== 'selene-design-revision-operation-reference/v2') fail('unsupported');
  const expected = createDesignRevisionOperationReference(
    revisionValue,
    authorityValue,
    operationKind(input.kind),
    stateValue,
    now
  );
  if (
    text(input.tenantId) !== expected.tenantId ||
    text(input.projectId) !== expected.projectId ||
    text(input.actorId) !== expected.actorId ||
    text(input.commandId) !== expected.commandId ||
    text(input.revisionId) !== expected.revisionId ||
    tupleBinding(input.tupleBinding) !== expected.tupleBinding ||
    revisionCommitment(input.revisionCommitment) !== expected.revisionCommitment
  )
    fail('unauthorized');
  return expected;
}

export function parseDesignRevisionAuthority(value: unknown): DesignRevisionAuthority {
  const input = exact(
    snapshotRejectingLegacyFormat(value, 'selene-design-revision-authority/v1'),
    [
      'actorId',
      'audience',
      'capabilities',
      'commandId',
      'commandsDigest',
      'expiresAt',
      'format',
      'grantId',
      'grantEpoch',
      'issuedAt',
      'issuer',
      'policyDigest',
      'policyId',
      'policyRevision',
      'projectId',
      'revisionCommitment',
      'revisionId',
      'schemaRevision',
      'tenantId',
      'tupleBinding'
    ],
    ['revokedAt']
  );
  if (input.format !== 'selene-design-revision-authority/v2') fail('unsupported');
  const issuedAt = instant(input.issuedAt);
  const expiresAt = instant(input.expiresAt);
  if (expiresAt <= issuedAt) fail('unauthorized');
  return Object.freeze({
    format: input.format,
    tenantId: text(input.tenantId),
    projectId: text(input.projectId),
    actorId: text(input.actorId),
    commandId: text(input.commandId),
    policyId: text(input.policyId),
    policyRevision: integer(input.policyRevision),
    policyDigest: digest(input.policyDigest),
    revisionId: text(input.revisionId),
    tupleBinding: tupleBinding(input.tupleBinding),
    revisionCommitment: revisionCommitment(input.revisionCommitment),
    capabilities: capabilities(input.capabilities),
    grantId: text(input.grantId),
    grantEpoch: integer(input.grantEpoch),
    issuer: text(input.issuer),
    audience: text(input.audience),
    schemaRevision: integer(input.schemaRevision),
    commandsDigest: digest(input.commandsDigest),
    issuedAt,
    expiresAt,
    ...(input.revokedAt === undefined ? {} : { revokedAt: instant(input.revokedAt) })
  });
}

export function parseDesignRevisionState(value: unknown): DesignRevisionState {
  const input = exact(
    snapshot(
      value,
      0,
      new WeakSet<object>(),
      { bytes: 0, nodes: 0, stateCommandBytes: 0, stateCommandNodes: 0 },
      false,
      true
    ),
    ['format', 'grantStatus', 'policy', 'processedCommandIds', 'projectId', 'tenantId'],
    ['head']
  );
  const isLegacyState = input.format === 'selene-design-revision-state/v1';
  if (!isLegacyState && input.format !== 'selene-design-revision-state/v2') fail('unsupported');
  if (!Array.isArray(input.processedCommandIds) || input.processedCommandIds.length > maxCommands)
    fail();
  if (
    isLegacyState &&
    (input.head !== undefined ||
      (Array.isArray(input.processedCommandIds) && input.processedCommandIds.length > 0))
  )
    fail('unsupported');
  const processedCommandIds = input.processedCommandIds.map(text);
  if (new Set(processedCommandIds).size !== processedCommandIds.length) fail();
  const head =
    input.head === undefined
      ? undefined
      : (() => {
          const headInput = exact(input.head, [
            'createdAt',
            'format',
            'privacy',
            'privacyBinding',
            'revision',
            'revisionCommitment',
            'revisionId',
            'sequence',
            'tupleBinding'
          ]);
          if (headInput.format !== 'selene-design-revision-head/v2') fail('unsupported');
          const headPrivacy = privacy(headInput.privacy);
          const headPrivacyBinding = privacyBinding(headInput.privacyBinding);
          const headRevision = parseDesignRevision(headInput.revision);
          const headRevisionCommitment = revisionCommitment(headInput.revisionCommitment);
          if (headPrivacyBinding !== createDesignRevisionPrivacyBindingFromParsed(headPrivacy))
            fail('conflict');
          if (
            headRevisionCommitment !== headRevision.revisionCommitment ||
            text(headInput.revisionId) !== headRevision.revisionId ||
            integer(headInput.sequence) !== headRevision.sequence ||
            instant(headInput.createdAt) !== headRevision.createdAt ||
            tupleBinding(headInput.tupleBinding) !== headRevision.tupleBinding ||
            headPrivacyBinding !==
              createDesignRevisionPrivacyBindingFromParsed(headRevision.privacy) ||
            JSON.stringify(headPrivacy) !== JSON.stringify(headRevision.privacy)
          )
            fail('conflict');
          return Object.freeze({
            format: 'selene-design-revision-head/v2' as const,
            revisionId: headRevision.revisionId,
            sequence: headRevision.sequence,
            createdAt: headRevision.createdAt,
            tupleBinding: headRevision.tupleBinding,
            privacy: headPrivacy,
            privacyBinding: headPrivacyBinding,
            revision: headRevision,
            revisionCommitment: headRevisionCommitment
          });
        })();
  const policy = compileDesignRevisionPolicy(input.policy);
  const grantStatus = parseDesignRevisionGrantStatus(input.grantStatus);
  const tenantId = text(input.tenantId);
  const projectId = text(input.projectId);
  if (
    policy.tenantId !== tenantId ||
    policy.projectId !== projectId ||
    policy.trustAnchor.grantId !== grantStatus.grantId ||
    (head !== undefined &&
      (head.revision.tenantId !== tenantId || head.revision.projectId !== projectId))
  )
    fail('conflict');
  return Object.freeze({
    format: 'selene-design-revision-state/v2',
    tenantId,
    projectId,
    policy,
    grantStatus,
    processedCommandIds: Object.freeze([...processedCommandIds]),
    ...(head === undefined ? {} : { head })
  });
}

function canTransitionPrivacyLifecycle(
  from: DesignPrivacyLifecycle,
  to: DesignPrivacyLifecycle
): boolean {
  return (
    (from === 'active' && (to === 'redacted' || to === 'tombstoned' || to === 'expired')) ||
    (from === 'redacted' && (to === 'tombstoned' || to === 'expired')) ||
    (from === 'tombstoned' && to === 'expired')
  );
}

/** Pure transition: stale/replay/cross-scope results are classified without message inspection. */
export function commitDesignRevision(
  stateValue: unknown,
  commandValue: unknown,
  now: string
): DesignRevisionState {
  const state = parseDesignRevisionState(stateValue);
  const input = exact(snapshot(commandValue), ['authority', 'format', 'revision']);
  if (input.format !== 'selene-design-revision-command/v2') fail('unsupported');
  const authority = parseDesignRevisionAuthority(input.authority);
  const revision = parseDesignRevision(input.revision);
  const at = instant(now);
  if (
    authority.tenantId !== state.tenantId ||
    authority.projectId !== state.projectId ||
    revision.tenantId !== state.tenantId ||
    revision.projectId !== state.projectId
  )
    fail('unauthorized');
  if (
    authority.policyId !== state.policy.policyId ||
    authority.policyRevision !== state.policy.revision ||
    authority.policyDigest !== state.policy.digest ||
    !authority.capabilities.includes('design:revision.commit') ||
    !state.policy.capabilities.includes('design:revision.commit') ||
    authority.capabilities.some(
      (capabilityValue) => !state.policy.capabilities.includes(capabilityValue)
    )
  )
    fail('stale');
  const trustAnchor = state.policy.trustAnchor;
  if (
    authority.issuer !== trustAnchor.issuer ||
    authority.audience !== trustAnchor.audience ||
    authority.grantId !== trustAnchor.grantId ||
    authority.schemaRevision !== trustAnchor.schemaRevision ||
    authority.commandsDigest !== trustAnchor.commandsDigest
  )
    fail('unauthorized');
  if (
    state.grantStatus.state !== 'active' ||
    authority.grantId !== state.grantStatus.grantId ||
    authority.grantEpoch !== state.grantStatus.epoch
  )
    fail('unauthorized');
  if (
    authority.revisionId !== revision.revisionId ||
    authority.tupleBinding !== revision.tupleBinding ||
    authority.revisionCommitment !== revision.revisionCommitment
  )
    fail('unauthorized');
  if (
    (authority.revokedAt !== undefined && authority.revokedAt <= at) ||
    at < authority.issuedAt ||
    at > authority.expiresAt ||
    revision.createdAt < authority.issuedAt ||
    revision.createdAt > authority.expiresAt
  )
    fail('unauthorized');
  if (
    state.head !== undefined &&
    (state.head.privacy.lifecycle === 'tombstoned' || state.head.privacy.lifecycle === 'expired')
  )
    fail('unauthorized');
  if (
    revision.createdAt >= revision.privacy.retention.deleteAfter ||
    at >= revision.privacy.retention.deleteAfter
  )
    fail('unauthorized');
  if (state.processedCommandIds.includes(authority.commandId)) fail('replay');
  if (state.processedCommandIds.length >= maxCommands) fail('recovery');
  if (
    state.head === undefined
      ? revision.sequence !== 1 || revision.parentRevisionId !== undefined
      : revision.sequence !== state.head.sequence + 1 ||
        revision.revisionId === state.head.revisionId ||
        revision.parentRevisionId !== state.head.revisionId ||
        revision.createdAt < state.head.createdAt
  )
    fail('conflict');
  const nextPrivacyBinding = createDesignRevisionPrivacyBindingFromParsed(revision.privacy);
  if (state.head === undefined) {
    if (revision.privacy.lifecycle !== 'active' || revision.privacy.lifecycleAudit !== undefined)
      fail('unauthorized');
  } else {
    const transition = revision.privacy.lifecycleAudit;
    if (nextPrivacyBinding !== state.head.privacyBinding) fail('conflict');
    if (revision.privacy.lifecycle === state.head.privacy.lifecycle) {
      if (transition !== undefined) fail('conflict');
    } else if (
      transition === undefined ||
      transition.priorRevisionId !== state.head.revisionId ||
      transition.priorTupleBinding !== state.head.tupleBinding ||
      transition.priorPrivacyBinding !== state.head.privacyBinding ||
      transition.from !== state.head.privacy.lifecycle ||
      transition.to !== revision.privacy.lifecycle ||
      !canTransitionPrivacyLifecycle(transition.from, transition.to) ||
      transition.auditCorrelationId !== state.head.privacy.auditCorrelationId ||
      transition.occurredAt < state.head.createdAt ||
      transition.occurredAt > revision.createdAt ||
      transition.occurredAt > at
    )
      fail('unauthorized');
  }
  const head = Object.freeze({
    format: 'selene-design-revision-head/v2' as const,
    revisionId: revision.revisionId,
    sequence: revision.sequence,
    createdAt: revision.createdAt,
    tupleBinding: revision.tupleBinding,
    privacy: revision.privacy,
    privacyBinding: nextPrivacyBinding,
    revision,
    revisionCommitment: revision.revisionCommitment
  });
  return Object.freeze({
    ...state,
    processedCommandIds: Object.freeze([...state.processedCommandIds, authority.commandId]),
    head
  });
}

function parseDesignRevisionHostCapabilities(value: unknown): DesignRevisionHostCapabilities {
  const input = exact(
    snapshotRejectingLegacyFormat(value, 'selene-design-revision-host-capabilities/v1'),
    [
      'audience',
      'capabilities',
      'commandsDigest',
      'expiresAt',
      'format',
      'grantId',
      'grantEpoch',
      'issuedAt',
      'issuer',
      'policyRevision',
      'projectId',
      'revisionCommitment',
      'revisionId',
      'schemaRevision',
      'tenantId',
      'tupleBinding'
    ],
    ['revokedAt']
  );
  if (input.format !== 'selene-design-revision-host-capabilities/v2') fail('unsupported');
  const accepted = capabilities(input.capabilities);
  const issuedAt = instant(input.issuedAt);
  const expiresAt = instant(input.expiresAt);
  if (expiresAt <= issuedAt) fail('unauthorized');
  return Object.freeze({
    format: input.format,
    issuer: text(input.issuer),
    audience: text(input.audience),
    tenantId: text(input.tenantId),
    projectId: text(input.projectId),
    grantId: text(input.grantId),
    grantEpoch: integer(input.grantEpoch),
    schemaRevision: integer(input.schemaRevision),
    commandsDigest: digest(input.commandsDigest),
    revisionId: text(input.revisionId),
    tupleBinding: tupleBinding(input.tupleBinding),
    revisionCommitment: revisionCommitment(input.revisionCommitment),
    policyRevision: integer(input.policyRevision),
    issuedAt,
    expiresAt,
    ...(input.revokedAt === undefined ? {} : { revokedAt: instant(input.revokedAt) }),
    capabilities: accepted
  });
}

function parseDesignRevisionHostNegotiationExpectation(
  value: unknown
): DesignRevisionHostNegotiationExpectation {
  const input = exact(
    snapshotRejectingLegacyFormat(value, 'selene-design-revision-host-negotiation-expectation/v1'),
    [
      'capabilities',
      'format',
      'grantStatus',
      'policyRevision',
      'projectId',
      'revisionCommitment',
      'revisionId',
      'tenantId',
      'trustAnchor',
      'tupleBinding'
    ]
  );
  if (input.format !== 'selene-design-revision-host-negotiation-expectation/v2')
    fail('unsupported');
  return Object.freeze({
    format: input.format,
    tenantId: text(input.tenantId),
    projectId: text(input.projectId),
    trustAnchor: parseDesignRevisionTrustAnchor(input.trustAnchor),
    grantStatus: parseDesignRevisionGrantStatus(input.grantStatus),
    policyRevision: integer(input.policyRevision),
    revisionId: text(input.revisionId),
    tupleBinding: tupleBinding(input.tupleBinding),
    revisionCommitment: revisionCommitment(input.revisionCommitment),
    capabilities: capabilities(input.capabilities)
  });
}

/** Negotiates exact host grant terms at an explicit instant; no ambient host authority is used. */
export function negotiateDesignRevisionHostCapabilities(
  offeredValue: unknown,
  expectationValue: unknown,
  now: string
): DesignRevisionHostNegotiationOutcome {
  return withContractErrorScope((scope) => {
    try {
      const offered = parseDesignRevisionHostCapabilities(offeredValue);
      const expectation = parseDesignRevisionHostNegotiationExpectation(expectationValue);
      const at = instant(now);
      if (
        (offered.revokedAt !== undefined && offered.revokedAt <= at) ||
        at < offered.issuedAt ||
        at > offered.expiresAt ||
        offered.issuer !== expectation.trustAnchor.issuer ||
        offered.audience !== expectation.trustAnchor.audience ||
        offered.grantId !== expectation.trustAnchor.grantId ||
        offered.schemaRevision !== expectation.trustAnchor.schemaRevision ||
        offered.commandsDigest !== expectation.trustAnchor.commandsDigest ||
        offered.tenantId !== expectation.tenantId ||
        offered.projectId !== expectation.projectId ||
        expectation.grantStatus.state !== 'active' ||
        offered.grantId !== expectation.grantStatus.grantId ||
        offered.grantEpoch !== expectation.grantStatus.epoch ||
        offered.policyRevision !== expectation.policyRevision ||
        offered.revisionId !== expectation.revisionId ||
        offered.tupleBinding !== expectation.tupleBinding ||
        offered.revisionCommitment !== expectation.revisionCommitment
      )
        return Object.freeze({ kind: 'unauthorized', code: 'unauthorized' });
      if (
        expectation.capabilities.length !== offered.capabilities.length ||
        expectation.capabilities.some(
          (capabilityValue, index) => capabilityValue !== offered.capabilities[index]
        )
      )
        return Object.freeze({ kind: 'unsupported', code: 'unsupported' });
      return Object.freeze({ kind: 'accepted', capabilities: offered });
    } catch (error) {
      if (!isInternalContractError(error, scope))
        return Object.freeze({ kind: 'invalid', code: 'invalid' });
      switch (error.code) {
        case 'invalid':
          return Object.freeze({ kind: 'invalid', code: 'invalid' });
        case 'unsupported':
          return Object.freeze({ kind: 'unsupported', code: 'unsupported' });
        case 'unauthorized':
        case 'stale':
        case 'conflict':
        case 'replay':
        case 'recovery':
          return Object.freeze({ kind: 'unauthorized', code: 'unauthorized' });
      }
    }
  });
}

function exportCapabilities(value: unknown): readonly DesignRevisionExportCapability[] {
  if (!Array.isArray(value) || value.length !== 1 || value[0] !== 'design:revision.export') fail();
  return Object.freeze(['design:revision.export'] as const);
}

function parseDesignRevisionExportGrantStatus(value: unknown): DesignRevisionExportGrantStatus {
  const input = exact(snapshot(value), ['authorityId', 'epoch', 'format', 'state'], ['revokedAt']);
  if (input.format !== 'selene-design-revision-export-grant-status/v1') fail('unsupported');
  const authorityId = text(input.authorityId);
  const epoch = integer(input.epoch);
  if (input.state === 'active' && input.revokedAt === undefined)
    return Object.freeze({ format: input.format, authorityId, epoch, state: 'active' });
  if (input.state === 'revoked' && input.revokedAt !== undefined)
    return Object.freeze({
      format: input.format,
      authorityId,
      epoch,
      state: 'revoked',
      revokedAt: instant(input.revokedAt)
    });
  fail('invalid');
}

function parseDesignRevisionExportAuthority(value: unknown): DesignRevisionExportAuthority {
  const input = exact(
    snapshotRejectingLegacyFormat(value, 'selene-design-revision-export-authority/v1'),
    [
      'audience',
      'authorityId',
      'capabilities',
      'epoch',
      'expiresAt',
      'exportPolicyDigest',
      'format',
      'issuedAt',
      'issuer',
      'lifecycle',
      'privacyBinding',
      'projectId',
      'policyDigest',
      'retentionDeleteAfter',
      'revisionCommitment',
      'revisionId',
      'tenantId',
      'tupleBinding'
    ]
  );
  if (input.format !== 'selene-design-revision-export-authority/v2') fail('unsupported');
  const issuedAt = instant(input.issuedAt);
  const expiresAt = instant(input.expiresAt);
  if (expiresAt <= issuedAt) fail('unauthorized');
  return Object.freeze({
    format: input.format,
    authorityId: text(input.authorityId),
    epoch: integer(input.epoch),
    issuer: text(input.issuer),
    audience: text(input.audience),
    tenantId: text(input.tenantId),
    projectId: text(input.projectId),
    revisionId: text(input.revisionId),
    tupleBinding: tupleBinding(input.tupleBinding),
    revisionCommitment: revisionCommitment(input.revisionCommitment),
    privacyBinding: privacyBinding(input.privacyBinding),
    lifecycle:
      input.lifecycle === 'active' ||
      input.lifecycle === 'redacted' ||
      input.lifecycle === 'tombstoned' ||
      input.lifecycle === 'expired'
        ? input.lifecycle
        : fail('unsupported'),
    retentionDeleteAfter: instant(input.retentionDeleteAfter),
    policyDigest: digest(input.policyDigest),
    exportPolicyDigest: digest(input.exportPolicyDigest),
    issuedAt,
    expiresAt,
    capabilities: exportCapabilities(input.capabilities)
  });
}

function exportAuthorityBinding(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 4_096 ||
    !value.startsWith('["selene-design-revision-export-authority-binding/v2",')
  )
    fail();
  return value;
}

/** Canonical full-authority commitment supplied to the host before atomic consumption. */
export function createDesignRevisionExportAuthorityBinding(value: unknown): string {
  const authority = parseDesignRevisionExportAuthority(value);
  return exportAuthorityBinding(
    JSON.stringify([
      'selene-design-revision-export-authority-binding/v2',
      authority.authorityId,
      authority.epoch,
      authority.issuer,
      authority.audience,
      authority.tenantId,
      authority.projectId,
      authority.revisionId,
      authority.tupleBinding,
      authority.revisionCommitment,
      authority.privacyBinding,
      authority.lifecycle,
      authority.retentionDeleteAfter,
      authority.policyDigest,
      authority.exportPolicyDigest,
      authority.issuedAt,
      authority.expiresAt,
      authority.capabilities[0]
    ])
  );
}

function parseDesignRevisionExportHostState(value: unknown): DesignRevisionExportHostState {
  const input = exact(
    snapshotRejectingLegacyFormat(value, 'selene-design-revision-export-host-state/v1'),
    [
      'audience',
      'authorityId',
      'authorityBinding',
      'capabilities',
      'epoch',
      'expiresAt',
      'exportPolicyDigest',
      'format',
      'grantStatus',
      'issuedAt',
      'issuer',
      'lifecycle',
      'privacyBinding',
      'projectId',
      'policyDigest',
      'retentionDeleteAfter',
      'revisionCommitment',
      'revisionId',
      'tenantId',
      'tupleBinding'
    ]
  );
  if (input.format !== 'selene-design-revision-export-host-state/v2') fail('unsupported');
  const issuedAt = instant(input.issuedAt);
  const expiresAt = instant(input.expiresAt);
  if (expiresAt <= issuedAt) fail('unauthorized');
  return Object.freeze({
    format: input.format,
    authorityId: text(input.authorityId),
    epoch: integer(input.epoch),
    issuer: text(input.issuer),
    audience: text(input.audience),
    tenantId: text(input.tenantId),
    projectId: text(input.projectId),
    revisionId: text(input.revisionId),
    tupleBinding: tupleBinding(input.tupleBinding),
    revisionCommitment: revisionCommitment(input.revisionCommitment),
    privacyBinding: privacyBinding(input.privacyBinding),
    lifecycle:
      input.lifecycle === 'active' ||
      input.lifecycle === 'redacted' ||
      input.lifecycle === 'tombstoned' ||
      input.lifecycle === 'expired'
        ? input.lifecycle
        : fail('unsupported'),
    retentionDeleteAfter: instant(input.retentionDeleteAfter),
    policyDigest: digest(input.policyDigest),
    exportPolicyDigest: digest(input.exportPolicyDigest),
    authorityBinding: exportAuthorityBinding(input.authorityBinding),
    issuedAt,
    expiresAt,
    capabilities: exportCapabilities(input.capabilities),
    grantStatus: parseDesignRevisionExportGrantStatus(input.grantStatus)
  });
}

function parseDesignRevisionExportVerificationResult(
  value: unknown
): DesignRevisionExportVerificationResult {
  const input = exact(snapshot(value), ['kind'], ['code', 'commitment']);
  if (
    (input.kind === 'unauthorized' || input.kind === 'replay' || input.kind === 'unsupported') &&
    input.code === undefined &&
    input.commitment === undefined
  )
    return Object.freeze({ kind: input.kind });
  if (input.kind === 'accepted' && input.code === undefined && input.commitment !== undefined)
    return Object.freeze({
      kind: 'accepted',
      commitment: parseDesignRevisionExportHostState(input.commitment)
    });
  if (
    input.kind === 'ineligible' &&
    (input.code === 'lifecycle' || input.code === 'retention') &&
    input.commitment !== undefined
  )
    return Object.freeze({
      kind: 'ineligible',
      code: input.code,
      commitment: parseDesignRevisionExportHostState(input.commitment)
    });
  fail('invalid');
}

function exportIneligibilityCode(
  revision: DesignRevision,
  at: string
): 'lifecycle' | 'retention' | undefined {
  if (revision.privacy.lifecycle !== 'active') return 'lifecycle';
  if (
    revision.createdAt >= revision.privacy.retention.deleteAfter ||
    at >= revision.privacy.retention.deleteAfter
  )
    return 'retention';
  return undefined;
}

function matchesExportCommitment(
  authority: DesignRevisionExportAuthority,
  hostState: DesignRevisionExportHostState,
  revision: DesignRevision,
  revisionPrivacyBinding: string,
  authorityBinding: string,
  at: string
): boolean {
  return !(
    authority.authorityId !== hostState.authorityId ||
    authority.epoch !== hostState.epoch ||
    authority.issuer !== hostState.issuer ||
    authority.audience !== hostState.audience ||
    authority.tenantId !== hostState.tenantId ||
    authority.projectId !== hostState.projectId ||
    authority.revisionId !== hostState.revisionId ||
    authority.tupleBinding !== hostState.tupleBinding ||
    authority.revisionCommitment !== hostState.revisionCommitment ||
    authority.privacyBinding !== hostState.privacyBinding ||
    authority.lifecycle !== hostState.lifecycle ||
    authority.retentionDeleteAfter !== hostState.retentionDeleteAfter ||
    authority.policyDigest !== hostState.policyDigest ||
    authority.exportPolicyDigest !== hostState.exportPolicyDigest ||
    authorityBinding !== hostState.authorityBinding ||
    authority.issuedAt !== hostState.issuedAt ||
    authority.expiresAt !== hostState.expiresAt ||
    authority.capabilities[0] !== hostState.capabilities[0] ||
    hostState.grantStatus.state !== 'active' ||
    hostState.grantStatus.authorityId !== authority.authorityId ||
    hostState.grantStatus.epoch !== authority.epoch ||
    authority.tenantId !== revision.tenantId ||
    authority.projectId !== revision.projectId ||
    authority.revisionId !== revision.revisionId ||
    authority.tupleBinding !== revision.tupleBinding ||
    authority.revisionCommitment !== revision.revisionCommitment ||
    authority.privacyBinding !== revisionPrivacyBinding ||
    authority.lifecycle !== revision.privacy.lifecycle ||
    authority.retentionDeleteAfter !== revision.privacy.retention.deleteAfter ||
    authority.exportPolicyDigest !== revision.privacy.exportPolicyDigest ||
    at < authority.issuedAt ||
    at > authority.expiresAt
  );
}

/** Decides export eligibility only from a host-verified authority which consumes eligible grants atomically. */
export function evaluateDesignRevisionExportEligibility(
  revisionValue: unknown,
  authorityValue: unknown,
  verificationPort: unknown,
  now: string
): DesignRevisionExportEligibility {
  try {
    const revision = parseDesignRevision(revisionValue);
    const authority = parseDesignRevisionExportAuthority(authorityValue);
    const at = instant(now);
    const verifier = verificationFunction(verificationPort, 'verifyAndConsume');
    if (verifier === undefined)
      return Object.freeze({ kind: 'unauthorized', code: 'unauthorized' });
    const revisionPrivacyBinding = createDesignRevisionPrivacyBindingFromParsed(revision.privacy);
    const authorityBinding = createDesignRevisionExportAuthorityBinding(authority);
    const request = Object.freeze({
      format: 'selene-design-revision-export-verification-request/v2' as const,
      authorityId: authority.authorityId,
      epoch: authority.epoch,
      audience: authority.audience,
      tenantId: revision.tenantId,
      projectId: revision.projectId,
      revisionId: revision.revisionId,
      tupleBinding: revision.tupleBinding,
      revisionCommitment: revision.revisionCommitment,
      privacyBinding: revisionPrivacyBinding,
      lifecycle: revision.privacy.lifecycle,
      retentionDeleteAfter: revision.privacy.retention.deleteAfter,
      authorityBinding,
      now: at
    });
    let verification: DesignRevisionExportVerificationResult;
    try {
      verification = parseDesignRevisionExportVerificationResult(verifier.invoke(request));
    } catch {
      return Object.freeze({ kind: 'unauthorized', code: 'unauthorized' });
    }
    if (verification.kind === 'replay') return Object.freeze({ kind: 'replay', code: 'replay' });
    if (verification.kind !== 'accepted' && verification.kind !== 'ineligible')
      return Object.freeze({ kind: 'unauthorized', code: 'unauthorized' });
    const hostState = verification.commitment;
    if (
      !matchesExportCommitment(
        authority,
        hostState,
        revision,
        revisionPrivacyBinding,
        authorityBinding,
        at
      )
    )
      return Object.freeze({ kind: 'unauthorized', code: 'unauthorized' });
    const ineligibility = exportIneligibilityCode(revision, at);
    if (verification.kind === 'ineligible') {
      if (ineligibility !== verification.code)
        return Object.freeze({ kind: 'unauthorized', code: 'unauthorized' });
      return Object.freeze({ kind: 'ineligible', code: verification.code });
    }
    if (ineligibility !== undefined)
      return Object.freeze({ kind: 'unauthorized', code: 'unauthorized' });
    return Object.freeze({
      kind: 'eligible',
      authorityId: authority.authorityId,
      lifecycle: 'active'
    });
  } catch {
    return Object.freeze({ kind: 'unauthorized', code: 'unauthorized' });
  }
}

function parseDesignPrivacyTransition(value: unknown): DesignPrivacyTransition {
  const input = exact(
    snapshot(value),
    ['auditCorrelationId', 'format', 'from', 'occurredAt', 'to'],
    ['priorPrivacyBinding', 'priorRevisionId', 'priorTupleBinding', 'tombstoneDigest']
  );
  if (
    input.format !== 'selene-design-privacy-transition/v1' ||
    (input.from !== 'active' &&
      input.from !== 'redacted' &&
      input.from !== 'tombstoned' &&
      input.from !== 'expired') ||
    (input.to !== 'active' &&
      input.to !== 'redacted' &&
      input.to !== 'tombstoned' &&
      input.to !== 'expired')
  )
    fail('unsupported');
  const tombstoneDigest =
    input.tombstoneDigest === undefined ? undefined : digest(input.tombstoneDigest);
  const priorRevisionId =
    input.priorRevisionId === undefined ? undefined : text(input.priorRevisionId);
  const priorTupleBinding =
    input.priorTupleBinding === undefined ? undefined : tupleBinding(input.priorTupleBinding);
  const priorPrivacyBinding =
    input.priorPrivacyBinding === undefined ? undefined : privacyBinding(input.priorPrivacyBinding);
  if (
    (priorRevisionId === undefined ||
      priorTupleBinding === undefined ||
      priorPrivacyBinding === undefined) &&
    (priorRevisionId !== undefined ||
      priorTupleBinding !== undefined ||
      priorPrivacyBinding !== undefined)
  )
    fail('conflict');
  if ((input.to === 'tombstoned') !== (tombstoneDigest !== undefined)) fail('conflict');
  return Object.freeze({
    format: input.format,
    from: input.from,
    to: input.to,
    occurredAt: instant(input.occurredAt),
    auditCorrelationId: text(input.auditCorrelationId),
    ...(priorRevisionId === undefined ? {} : { priorRevisionId }),
    ...(priorTupleBinding === undefined ? {} : { priorTupleBinding }),
    ...(priorPrivacyBinding === undefined ? {} : { priorPrivacyBinding }),
    ...(tombstoneDigest === undefined ? {} : { tombstoneDigest })
  });
}

/**
 * Preflights raw privacy data only. It never mutates trusted revision state; commitDesignRevision
 * is the sole authority that binds a transition to the prior trusted head.
 */
export function transitionDesignPrivacyLifecycle(
  privacyValue: unknown,
  transitionValue: unknown
): DesignPrivacyTransitionOutcome {
  return withContractErrorScope((scope) => {
    try {
      const current = privacy(snapshot(privacyValue));
      const transition = parseDesignPrivacyTransition(transitionValue);
      const isAllowed =
        (current.lifecycle === 'active' &&
          (transition.to === 'redacted' ||
            transition.to === 'tombstoned' ||
            transition.to === 'expired')) ||
        (current.lifecycle === 'redacted' &&
          (transition.to === 'tombstoned' || transition.to === 'expired')) ||
        (current.lifecycle === 'tombstoned' && transition.to === 'expired');
      if (
        transition.from !== current.lifecycle ||
        !isAllowed ||
        transition.auditCorrelationId !== current.auditCorrelationId
      )
        return Object.freeze({ kind: 'conflict', code: 'conflict' });
      if (
        transition.to === 'tombstoned' &&
        transition.tombstoneDigest !== current.deletion.tombstoneDigest
      )
        return Object.freeze({ kind: 'unauthorized', code: 'unauthorized' });
      const next = Object.freeze({
        ...current,
        lifecycle: transition.to,
        lifecycleAudit: transition
      });
      return Object.freeze({ kind: 'preflight', privacy: next, audit: transition });
    } catch (error) {
      if (!isInternalContractError(error, scope))
        return Object.freeze({ kind: 'unauthorized', code: 'unauthorized' });
      switch (error.code) {
        case 'conflict':
          return Object.freeze({ kind: 'conflict', code: 'conflict' });
        case 'invalid':
        case 'unsupported':
        case 'unauthorized':
        case 'stale':
        case 'replay':
        case 'recovery':
          return Object.freeze({ kind: 'unauthorized', code: 'unauthorized' });
      }
    }
  });
}

export function commitDesignRevisionOutcome(
  state: unknown,
  command: unknown,
  now: string
): DesignRevisionOutcome {
  return withContractErrorScope((scope) => {
    try {
      return Object.freeze({ kind: 'accepted', state: commitDesignRevision(state, command, now) });
    } catch (error) {
      if (!isInternalContractError(error, scope))
        return Object.freeze({ kind: 'invalid', code: 'invalid' });
      switch (error.code) {
        case 'conflict':
          return Object.freeze({ kind: 'conflict', code: 'conflict' });
        case 'replay':
          return Object.freeze({ kind: 'replay', code: 'replay' });
        case 'unauthorized':
          return Object.freeze({ kind: 'unauthorized', code: 'unauthorized' });
        case 'recovery':
          return Object.freeze({ kind: 'recovery', code: 'recovery' });
        case 'unsupported':
          return Object.freeze({ kind: 'unsupported', code: 'unsupported' });
        case 'stale':
          return Object.freeze({ kind: 'stale', code: 'stale' });
        case 'invalid':
          return Object.freeze({ kind: 'invalid', code: 'invalid' });
      }
    }
  });
}
