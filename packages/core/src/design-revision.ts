/** Portable, data-only authority boundary for immutable generated-design revisions. */
export type DesignRevisionValidationCode =
  'invalid' | 'unsupported' | 'unauthorized' | 'stale' | 'conflict' | 'replay' | 'recovery';

export class DesignRevisionContractError extends Error {
  public constructor(
    readonly code: DesignRevisionValidationCode = 'invalid',
    message = 'Design revision contract is invalid'
  ) {
    super(message);
    this.name = 'DesignRevisionContractError';
  }
}

export type DesignRevisionCapability = 'design:revision.commit';
export type DesignPrivacyClassification = 'internal' | 'restricted';
export type DesignPrivacyLifecycle = 'active' | 'redacted' | 'tombstoned' | 'expired';

export interface DesignPrivacyField {
  readonly category: 'personal' | 'secret' | 'prompt';
  readonly mode: 'mask' | 'redact' | 'exclude';
  readonly digest: string;
}

export interface DesignRevisionPrivacy {
  readonly format: 'selene-design-privacy/v1';
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
}

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
  readonly format: 'selene-compiler-node-identity/v1';
  readonly projectId: string;
  readonly nodeId: string;
  readonly compilerDigest: string;
}

export interface DesignRevisionOperationTarget {
  readonly format: 'selene-design-revision-operation-target/v1';
  readonly revisionId: string;
  readonly tupleBinding: string;
  readonly node: CompilerIssuedNodeIdentity;
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
  readonly format: 'selene-design-revision/v1';
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
}

export interface DesignRevisionPolicy {
  readonly format: 'selene-design-revision-policy/v1';
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
  readonly format: 'selene-design-revision-authority/v1';
  readonly tenantId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly commandId: string;
  readonly policyId: string;
  readonly policyRevision: number;
  readonly policyDigest: string;
  readonly revisionId: string;
  readonly tupleBinding: string;
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
  readonly revisionId: string;
  readonly sequence: number;
  readonly createdAt: string;
  readonly tupleBinding: string;
  readonly privacy: DesignRevisionPrivacy;
  readonly privacyBinding: string;
}

export interface DesignRevisionState {
  readonly format: 'selene-design-revision-state/v1';
  readonly tenantId: string;
  readonly projectId: string;
  readonly policy: DesignRevisionPolicy;
  readonly grantStatus: DesignRevisionGrantStatus;
  readonly processedCommandIds: readonly string[];
  readonly head?: DesignRevisionHead;
}

export interface CommitDesignRevisionCommand {
  readonly format: 'selene-design-revision-command/v1';
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
  readonly format: 'selene-design-revision-host-capabilities/v1';
  readonly issuer: string;
  readonly audience: string;
  readonly grantId: string;
  readonly grantEpoch: number;
  readonly schemaRevision: number;
  readonly commandsDigest: string;
  readonly revisionId: string;
  readonly tupleBinding: string;
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
  readonly format: 'selene-design-revision-host-negotiation-expectation/v1';
  readonly trustAnchor: DesignRevisionTrustAnchor;
  readonly grantStatus: DesignRevisionGrantStatus;
  readonly policyRevision: number;
  readonly revisionId: string;
  readonly tupleBinding: string;
  readonly capabilities: readonly DesignRevisionCapability[];
}

export type DesignRevisionExportCapability = 'design:revision.export';

/** Host-issued export grant. It is only valid when it exactly matches host state. */
export interface DesignRevisionExportAuthority {
  readonly format: 'selene-design-revision-export-authority/v1';
  readonly authorityId: string;
  readonly epoch: number;
  readonly issuer: string;
  readonly audience: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly revisionId: string;
  readonly tupleBinding: string;
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
  readonly format: 'selene-design-revision-export-host-state/v1';
  readonly authorityId: string;
  readonly epoch: number;
  readonly issuer: string;
  readonly audience: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly revisionId: string;
  readonly tupleBinding: string;
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
  readonly format: 'selene-design-revision-export-verification-request/v1';
  readonly authorityId: string;
  readonly epoch: number;
  readonly audience: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly revisionId: string;
  readonly tupleBinding: string;
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

/** Host-owned lookup which atomically consumes only an eligible single-use export authority. */
export interface DesignRevisionExportVerificationPort {
  verifyAndConsume(
    request: DesignRevisionExportVerificationRequest
  ): DesignRevisionExportVerificationResult;
}

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

const encoder = new TextEncoder();
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
  throw new DesignRevisionContractError(code, message);
}

function countBytes(value: string, budget: SnapshotBudget, stateCommandScalar = false): void {
  const bytes = encoder.encode(value).byteLength;
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
    if (Object.getOwnPropertySymbols(value).length > 0) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Object.getOwnPropertyNames(value);
    if (
      names.length > (isArray ? maxCommands + 1 : maxCommands) ||
      names.some((name) => name !== 'length' && !descriptors[name]?.enumerable)
    )
      fail();
    if (isArray) {
      const length = descriptors.length?.value;
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > maxCommands ||
        names.length !== length + 1 ||
        names.some((name) => name !== 'length' && !/^(0|[1-9][0-9]*)$/.test(name))
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
        const descriptor = descriptors[String(index)];
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
      const descriptor = descriptors[name];
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
  } catch (error) {
    if (error instanceof DesignRevisionContractError) throw error;
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
    !value.startsWith('["selene-design-revision-privacy-binding/v1",')
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

function capabilities(value: unknown): readonly DesignRevisionCapability[] {
  if (!Array.isArray(value) || value.length !== 1 || value[0] !== 'design:revision.commit') fail();
  return Object.freeze(['design:revision.commit'] as const);
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
      'retention'
    ],
    ['lifecycleAudit', 'promptDigest']
  );
  if (
    input.format !== 'selene-design-privacy/v1' ||
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
  const fields = input.fields.map((field) => {
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
  });
  const retention = exact(input.retention, ['deleteAfter']);
  const deletion = exact(input.deletion, ['action', 'tombstoneDigest']);
  if (deletion.action !== 'tombstone') fail('unsupported');
  return Object.freeze({
    format: input.format,
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
    exclusions: Object.freeze(input.exclusions.map(text))
  });
}

function serializedBindingInput(value: string): unknown {
  if (typeof value !== 'string' || encoder.encode(value).byteLength > maxSnapshotBytes) fail();
  try {
    return snapshot(JSON.parse(value));
  } catch (error) {
    if (error instanceof DesignRevisionContractError) throw error;
    fail();
  }
}

function createDesignRevisionPrivacyBindingFromParsed(parsed: DesignRevisionPrivacy): string {
  return JSON.stringify([
    'selene-design-revision-privacy-binding/v1',
    parsed.classification,
    parsed.contentDigest,
    parsed.promptDigest ?? null,
    parsed.fields.map((field) => [field.category, field.mode, field.digest]),
    parsed.retention.deleteAfter,
    parsed.deletion.action,
    parsed.deletion.tombstoneDigest,
    parsed.exportPolicyDigest,
    parsed.auditCorrelationId,
    [...parsed.exclusions]
  ]);
}

export function parseCompilerIssuedNodeIdentity(value: unknown): CompilerIssuedNodeIdentity {
  const input = exact(snapshot(value), ['compilerDigest', 'format', 'nodeId', 'projectId']);
  if (input.format !== 'selene-compiler-node-identity/v1') fail('unsupported');
  return Object.freeze({
    format: input.format,
    projectId: text(input.projectId),
    nodeId: text(input.nodeId),
    compilerDigest: digest(input.compilerDigest)
  });
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
  return JSON.stringify([
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
  ]);
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
  if (input.format !== 'selene-design-revision-policy/v1') fail('unsupported');
  return Object.freeze({
    format: input.format,
    tenantId: text(input.tenantId),
    projectId: text(input.projectId),
    policyId: text(input.policyId),
    revision: integer(input.revision),
    digest: digest(input.digest),
    capabilities: capabilities(input.capabilities),
    trustAnchor: parseDesignRevisionTrustAnchor(input.trustAnchor)
  });
}

export function parseDesignRevision(value: unknown): DesignRevision {
  const input = exact(
    snapshot(value),
    ['createdAt', 'format', 'privacy', 'projectId', 'revisionId', 'sequence', 'tenantId', 'tuple'],
    ['parentRevisionId', 'tupleBinding']
  );
  if (input.format !== 'selene-design-revision/v1') fail('unsupported');
  const parsedTuple = tuple(input.tuple);
  const parentRevisionId =
    input.parentRevisionId === undefined ? undefined : text(input.parentRevisionId);
  const computedTupleBinding = createDesignRevisionTupleBindingFromParsed(parsedTuple);
  if (input.tupleBinding !== undefined && tupleBinding(input.tupleBinding) !== computedTupleBinding)
    fail('conflict');
  return Object.freeze({
    format: input.format,
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
}

/** Creates the only valid form of a node operation target: revision identity plus compiler node. */
export function createDesignRevisionOperationTarget(
  revisionValue: unknown,
  nodeValue: unknown
): DesignRevisionOperationTarget {
  const revision = parseDesignRevision(revisionValue);
  const node = parseCompilerIssuedNodeIdentity(nodeValue);
  if (
    node.projectId !== revision.projectId ||
    node.compilerDigest !== revision.tuple.compiler.compilerDigest
  )
    fail('conflict');
  return Object.freeze({
    format: 'selene-design-revision-operation-target/v1',
    revisionId: revision.revisionId,
    tupleBinding: revision.tupleBinding,
    node
  });
}

/** Validates an externally transported target against its owning immutable revision. */
export function parseDesignRevisionOperationTarget(
  value: unknown,
  revisionValue: unknown
): DesignRevisionOperationTarget {
  const revision = parseDesignRevision(revisionValue);
  const input = exact(snapshot(value), ['format', 'node', 'revisionId', 'tupleBinding']);
  if (input.format !== 'selene-design-revision-operation-target/v1') fail('unsupported');
  if (
    text(input.revisionId) !== revision.revisionId ||
    tupleBinding(input.tupleBinding) !== revision.tupleBinding
  )
    fail('conflict');
  return createDesignRevisionOperationTarget(revision, input.node);
}

export function parseDesignRevisionAuthority(value: unknown): DesignRevisionAuthority {
  const input = exact(
    snapshot(value),
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
      'revisionId',
      'schemaRevision',
      'tenantId',
      'tupleBinding'
    ],
    ['revokedAt']
  );
  if (input.format !== 'selene-design-revision-authority/v1') fail('unsupported');
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
  if (
    input.format !== 'selene-design-revision-state/v1' ||
    !Array.isArray(input.processedCommandIds) ||
    input.processedCommandIds.length > maxCommands
  )
    fail();
  const processedCommandIds = input.processedCommandIds.map(text);
  if (new Set(processedCommandIds).size !== processedCommandIds.length) fail();
  const head =
    input.head === undefined
      ? undefined
      : (() => {
          const headInput = exact(input.head, [
            'createdAt',
            'privacy',
            'privacyBinding',
            'revisionId',
            'sequence',
            'tupleBinding'
          ]);
          const headPrivacy = privacy(headInput.privacy);
          const headPrivacyBinding = privacyBinding(headInput.privacyBinding);
          if (headPrivacyBinding !== createDesignRevisionPrivacyBindingFromParsed(headPrivacy))
            fail('conflict');
          return Object.freeze({
            revisionId: text(headInput.revisionId),
            sequence: integer(headInput.sequence),
            createdAt: instant(headInput.createdAt),
            tupleBinding: tupleBinding(headInput.tupleBinding),
            privacy: headPrivacy,
            privacyBinding: headPrivacyBinding
          });
        })();
  const policy = compileDesignRevisionPolicy(input.policy);
  const grantStatus = parseDesignRevisionGrantStatus(input.grantStatus);
  const tenantId = text(input.tenantId);
  const projectId = text(input.projectId);
  if (
    policy.tenantId !== tenantId ||
    policy.projectId !== projectId ||
    policy.trustAnchor.grantId !== grantStatus.grantId
  )
    fail('conflict');
  return Object.freeze({
    format: input.format,
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
  if (input.format !== 'selene-design-revision-command/v1') fail('unsupported');
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
    !authority.capabilities.includes('design:revision.commit')
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
    authority.tupleBinding !== revision.tupleBinding
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
    revisionId: revision.revisionId,
    sequence: revision.sequence,
    createdAt: revision.createdAt,
    tupleBinding: revision.tupleBinding,
    privacy: revision.privacy,
    privacyBinding: nextPrivacyBinding
  });
  return Object.freeze({
    ...state,
    processedCommandIds: Object.freeze([...state.processedCommandIds, authority.commandId]),
    head
  });
}

function parseDesignRevisionHostCapabilities(value: unknown): DesignRevisionHostCapabilities {
  const input = exact(
    snapshot(value),
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
      'revisionId',
      'schemaRevision',
      'tupleBinding'
    ],
    ['revokedAt']
  );
  if (input.format !== 'selene-design-revision-host-capabilities/v1') fail('unsupported');
  const accepted = capabilities(input.capabilities);
  const issuedAt = instant(input.issuedAt);
  const expiresAt = instant(input.expiresAt);
  if (expiresAt <= issuedAt) fail('unauthorized');
  return Object.freeze({
    format: input.format,
    issuer: text(input.issuer),
    audience: text(input.audience),
    grantId: text(input.grantId),
    grantEpoch: integer(input.grantEpoch),
    schemaRevision: integer(input.schemaRevision),
    commandsDigest: digest(input.commandsDigest),
    revisionId: text(input.revisionId),
    tupleBinding: tupleBinding(input.tupleBinding),
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
  const input = exact(snapshot(value), [
    'capabilities',
    'format',
    'grantStatus',
    'policyRevision',
    'revisionId',
    'trustAnchor',
    'tupleBinding'
  ]);
  if (input.format !== 'selene-design-revision-host-negotiation-expectation/v1')
    fail('unsupported');
  return Object.freeze({
    format: input.format,
    trustAnchor: parseDesignRevisionTrustAnchor(input.trustAnchor),
    grantStatus: parseDesignRevisionGrantStatus(input.grantStatus),
    policyRevision: integer(input.policyRevision),
    revisionId: text(input.revisionId),
    tupleBinding: tupleBinding(input.tupleBinding),
    capabilities: capabilities(input.capabilities)
  });
}

/** Negotiates exact host grant terms at an explicit instant; no ambient host authority is used. */
export function negotiateDesignRevisionHostCapabilities(
  offeredValue: unknown,
  expectationValue: unknown,
  now: string
): DesignRevisionHostNegotiationOutcome {
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
      expectation.grantStatus.state !== 'active' ||
      offered.grantId !== expectation.grantStatus.grantId ||
      offered.grantEpoch !== expectation.grantStatus.epoch ||
      offered.policyRevision !== expectation.policyRevision ||
      offered.revisionId !== expectation.revisionId ||
      offered.tupleBinding !== expectation.tupleBinding
    )
      return Object.freeze({ kind: 'unauthorized', code: 'unauthorized' });
    if (
      expectation.capabilities.length !== 1 ||
      expectation.capabilities[0] !== offered.capabilities[0]
    )
      return Object.freeze({ kind: 'unsupported', code: 'unsupported' });
    return Object.freeze({ kind: 'accepted', capabilities: offered });
  } catch (error) {
    if (!(error instanceof DesignRevisionContractError)) throw error;
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
  const input = exact(snapshot(value), [
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
    'revisionId',
    'tenantId',
    'tupleBinding'
  ]);
  if (input.format !== 'selene-design-revision-export-authority/v1') fail('unsupported');
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
    !value.startsWith('["selene-design-revision-export-authority-binding/v1",')
  )
    fail();
  return value;
}

/** Canonical full-authority commitment supplied to the host before atomic consumption. */
export function createDesignRevisionExportAuthorityBinding(value: unknown): string {
  const authority = parseDesignRevisionExportAuthority(value);
  return JSON.stringify([
    'selene-design-revision-export-authority-binding/v1',
    authority.authorityId,
    authority.epoch,
    authority.issuer,
    authority.audience,
    authority.tenantId,
    authority.projectId,
    authority.revisionId,
    authority.tupleBinding,
    authority.privacyBinding,
    authority.lifecycle,
    authority.retentionDeleteAfter,
    authority.policyDigest,
    authority.exportPolicyDigest,
    authority.issuedAt,
    authority.expiresAt,
    authority.capabilities[0]
  ]);
}

function parseDesignRevisionExportHostState(value: unknown): DesignRevisionExportHostState {
  const input = exact(snapshot(value), [
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
    'revisionId',
    'tenantId',
    'tupleBinding'
  ]);
  if (input.format !== 'selene-design-revision-export-host-state/v1') fail('unsupported');
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
    if (
      typeof verificationPort !== 'object' ||
      verificationPort === null ||
      typeof (verificationPort as { verifyAndConsume?: unknown }).verifyAndConsume !== 'function'
    )
      return Object.freeze({ kind: 'unauthorized', code: 'unauthorized' });
    const revisionPrivacyBinding = createDesignRevisionPrivacyBindingFromParsed(revision.privacy);
    const authorityBinding = createDesignRevisionExportAuthorityBinding(authority);
    const request = Object.freeze({
      format: 'selene-design-revision-export-verification-request/v1' as const,
      authorityId: authority.authorityId,
      epoch: authority.epoch,
      audience: authority.audience,
      tenantId: revision.tenantId,
      projectId: revision.projectId,
      revisionId: revision.revisionId,
      tupleBinding: revision.tupleBinding,
      privacyBinding: revisionPrivacyBinding,
      lifecycle: revision.privacy.lifecycle,
      retentionDeleteAfter: revision.privacy.retention.deleteAfter,
      authorityBinding,
      now: at
    });
    const verification = (
      verificationPort as DesignRevisionExportVerificationPort
    ).verifyAndConsume(request);
    if (verification.kind === 'replay') return Object.freeze({ kind: 'replay', code: 'replay' });
    if (verification.kind !== 'accepted' && verification.kind !== 'ineligible')
      return Object.freeze({ kind: 'unauthorized', code: 'unauthorized' });
    const hostState = parseDesignRevisionExportHostState(verification.commitment);
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
  } catch (error) {
    if (!(error instanceof DesignRevisionContractError)) throw error;
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
    if (!(error instanceof DesignRevisionContractError)) throw error;
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
}

export function commitDesignRevisionOutcome(
  state: unknown,
  command: unknown,
  now: string
): DesignRevisionOutcome {
  try {
    return Object.freeze({ kind: 'accepted', state: commitDesignRevision(state, command, now) });
  } catch (error) {
    if (!(error instanceof DesignRevisionContractError)) throw error;
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
}
