import {
  parseDesignRevision,
  parseDesignRevisionOperationTarget,
  type DesignRevision,
  type DesignRevisionOperationReference,
  type DesignRevisionOperationTarget
} from './design-revision.js';
import { serializeCanonicalData } from './canonical-data.js';

/**
 * Portable edit intent. This module deliberately does not parse, write, format, or compile source.
 * Those effects belong to a trusted host adapter which must apply a validated proposal atomically.
 */
export const designEditProposalFormat = 'selene-design-edit-proposal/v1' as const;
export const designEditResultFormat = 'selene-design-edit-result/v1' as const;

export class DesignEditContractError extends Error {
  public constructor(
    readonly code: 'invalid' | 'unsupported',
    message = 'Design edit contract is invalid'
  ) {
    super(message);
    this.name = 'DesignEditContractError';
    Object.defineProperty(this, 'code', { enumerable: true, configurable: false, writable: false });
  }
}
const internalErrors = new WeakSet<object>();
function internalError(code: 'invalid' | 'unsupported' = 'invalid'): never {
  const error = new DesignEditContractError(code);
  internalErrors.add(error);
  throw error;
}

export type DesignEditScalar = string | number | boolean | null;
export type DesignEditValue =
  DesignEditScalar | readonly DesignEditValue[] | { readonly [key: string]: DesignEditValue };
export type DesignEditOrigin = 'manual-canvas' | 'ai-proposal' | 'automation';
export type DesignEditRisk = 'standard' | 'raw-style';

export interface DesignEditTarget {
  readonly format: 'selene-design-edit-target/v1';
  readonly operation: DesignRevisionOperationTarget;
  /** Compiler-issued source anchor; never a CSS selector, DOM path, or file system path. */
  readonly sourceAnchorId: string;
  /** Required for remove/reorder (target is the child); absent for insert (target is the parent container). */
  readonly parentSourceAnchorId?: string;
}

export type DesignEditPrecondition =
  | { readonly kind: 'source-revision'; readonly sourceDigest: string }
  | { readonly kind: 'binding-revision'; readonly bindingDigest: string }
  | { readonly kind: 'design-system-lock'; readonly designSystemLockDigest: string }
  | { readonly kind: 'node-exists'; readonly sourceAnchorId: string }
  | {
      readonly kind: 'parent-is';
      readonly sourceAnchorId: string;
      readonly parentSourceAnchorId: string;
    }
  | {
      readonly kind: 'property-equals';
      readonly sourceAnchorId: string;
      readonly property: string;
      readonly value: DesignEditValue;
    }
  | { readonly kind: 'token-resolves'; readonly token: string; readonly resolvedDigest: string };

export type DesignEditCommand =
  | {
      readonly kind: 'set-content';
      readonly target: DesignEditTarget;
      readonly content: string;
    }
  | {
      readonly kind: 'set-prop';
      readonly target: DesignEditTarget;
      readonly prop: string;
      readonly value: DesignEditValue;
    }
  | {
      readonly kind: 'set-token';
      readonly target: DesignEditTarget;
      readonly token: string;
      readonly value: DesignEditValue;
    }
  | {
      readonly kind: 'set-style';
      readonly target: DesignEditTarget;
      readonly property: string;
      readonly value: DesignEditValue;
      readonly risk: 'raw-style';
      readonly policyDigest: string;
      readonly provenanceDigest: string;
    }
  | {
      readonly kind: 'set-layout';
      readonly target: DesignEditTarget;
      readonly property:
        | 'display'
        | 'flexDirection'
        | 'justifyContent'
        | 'alignItems'
        | 'gap'
        | 'gridTemplateColumns'
        | 'gridTemplateRows'
        | 'order'
        | 'width'
        | 'height'
        | 'minWidth'
        | 'minHeight'
        | 'maxWidth'
        | 'maxHeight';
      readonly value: DesignEditValue;
      readonly breakpoint?: 'base' | 'sm' | 'md' | 'lg' | 'xl';
    }
  | {
      readonly kind: 'replace-component';
      readonly target: DesignEditTarget;
      readonly component: {
        readonly packageName: string;
        readonly entrypoint: string;
        readonly exportName: string;
        readonly version: string;
        readonly artifactDigest: string;
      };
    }
  | {
      readonly kind: 'insert-child';
      readonly target: DesignEditTarget;
      readonly component: {
        readonly packageName: string;
        readonly entrypoint: string;
        readonly exportName: string;
        readonly version: string;
        readonly artifactDigest: string;
      };
      /** Exact bounded literals only; the host owns all generated JSX structure. */
      readonly props?: Readonly<Record<string, string | number | boolean>>;
      /** Host-minted stable marker for the new compiler-bound React instance. */
      readonly newSourceAnchorId: string;
      readonly position: 'first' | 'last' | { readonly beforeSourceAnchorId: string };
    }
  | { readonly kind: 'remove-node'; readonly target: DesignEditTarget }
  | {
      readonly kind: 'reorder-child';
      readonly target: DesignEditTarget;
      readonly position: 'first' | 'last' | { readonly beforeSourceAnchorId: string };
    }
  | {
      /** Moves one compiler-bound child between two compatible host containers. */
      readonly kind: 'reparent-child';
      readonly target: DesignEditTarget;
      readonly newParentSourceAnchorId: string;
      readonly position: 'first' | 'last' | { readonly beforeSourceAnchorId: string };
    };

export interface DesignEditProposal {
  readonly format: typeof designEditProposalFormat;
  readonly schemaVersion: 1;
  readonly proposalId: string;
  readonly commandId: string;
  readonly actorId: string;
  readonly origin: DesignEditOrigin;
  /** Exact host-authorized edit operation fence. The host verifies the authority before applying. */
  readonly operation: DesignRevisionOperationReference;
  readonly base: DesignRevision;
  readonly commands: readonly DesignEditCommand[];
  readonly preconditions: readonly DesignEditPrecondition[];
  readonly requestedAt: string;
}

export interface DesignEditDiagnostic {
  readonly code: string;
  readonly commandIndex?: number;
  readonly preconditionIndex?: number;
}

export interface DesignEditReceipt {
  readonly format: 'selene-design-edit-receipt/v1';
  readonly proposalId: string;
  readonly baseRevisionId: string;
  readonly targetRevisionId: string;
  readonly targetRevision: DesignRevision;
  readonly proposalDigest: { readonly format: 'sha256'; readonly value: string };
  readonly sourceDigest: string;
  readonly bindingDigest: string;
  readonly bindingRemaps: readonly {
    readonly fromSourceAnchorId: string;
    readonly toSourceAnchorId: string;
  }[];
  readonly formatReceipt: {
    readonly status: 'formatted';
    readonly formatterId: string;
    readonly digest: string;
  };
  readonly compileReceipt: {
    readonly status: 'compiled';
    readonly compilerId: string;
    readonly digest: string;
  };
  readonly undo: {
    readonly format: 'selene-design-edit-undo/v1';
    readonly undoId: string;
    readonly proposalDigest: { readonly format: 'sha256'; readonly value: string };
    readonly targetRevisionId: string;
  };
  readonly commandSummary: readonly {
    readonly kind: DesignEditCommand['kind'];
    readonly count: number;
  }[];
  readonly appliedAt: string;
}

export type DesignEditResult =
  | {
      readonly format: typeof designEditResultFormat;
      readonly kind: 'applied';
      readonly receipt: DesignEditReceipt;
    }
  | {
      readonly format: typeof designEditResultFormat;
      readonly kind: 'conflict';
      readonly diagnostics: readonly DesignEditDiagnostic[];
    }
  | {
      readonly format: typeof designEditResultFormat;
      readonly kind: 'rejected';
      readonly diagnostics: readonly DesignEditDiagnostic[];
    }
  | {
      readonly format: typeof designEditResultFormat;
      readonly kind: 'replayed';
      readonly receipt: DesignEditReceipt;
    };

/** Trusted host boundary. Core supplies immutable data only; the adapter owns source, policy, AST, formatting and atomic persistence. */
export interface DesignEditAdapterPort {
  /** Host must re-authorize operation/state/time, atomically persist source+bindings, and retain commandId+digest replay mapping. */
  apply(
    proposal: DesignEditProposal,
    context: Readonly<{
      readonly proposalDigest: Readonly<{ readonly format: 'sha256'; readonly value: string }>;
    }>
  ): Promise<DesignEditResult> | DesignEditResult;
}

/** Host-owned SHA-256 operation; input is ephemeral and must never be persisted as a receipt. */
export interface DesignEditDigestPort {
  sha256(payload: string): Promise<string> | string;
}

const identifier = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const packageEntrypoint = /^(?:\.|\.\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)$/;
const componentExportName = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;
const componentPropName = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;
const lockedVersion =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const cssProperty = /^(?:--[A-Za-z][A-Za-z0-9-]{0,127}|[a-z][A-Za-z0-9-]{0,127})$/;
const token = /^--?[A-Za-z][A-Za-z0-9-]{0,127}$|^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const digest = /^[a-f0-9]{64}$/;
const maxCommands = 128;
const maxText = 32_768;
const maxDepth = 12;
const maxNodes = 2_048;
const maxAggregateProposalBytes = 256_000;
const maxAggregateResultBytes = 256_000;
const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function fail(code: 'invalid' | 'unsupported' = 'invalid'): never {
  return internalError(code);
}
function own(value: unknown): Record<string, unknown> {
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(descriptors).some(
        (key) =>
          typeof key !== 'string' ||
          !('value' in (descriptors as Record<string, PropertyDescriptor>)[key]!) ||
          !(descriptors as Record<string, PropertyDescriptor>)[key]!.enumerable
      )
    )
      fail();
    const copy: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!('value' in descriptor) || !descriptor.enumerable) fail();
      Object.defineProperty(copy, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: false,
        writable: false
      });
    }
    return Object.freeze(copy);
  } catch (error) {
    if (typeof error === 'object' && error !== null && internalErrors.has(error)) throw error;
    fail();
  }
}
function denseArray(value: unknown): readonly unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const length =
      lengthDescriptor !== undefined && 'value' in lengthDescriptor
        ? lengthDescriptor.value
        : undefined;
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > maxNodes ||
      Reflect.ownKeys(value).length !== length + 1
    )
      fail();
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) fail();
      result.push(descriptor.value);
    }
    return Object.freeze(result);
  } catch (error) {
    if (typeof error === 'object' && error !== null && internalErrors.has(error)) throw error;
    fail();
  }
}
function exact(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> {
  try {
    const record = own(value);
    const keys = Object.keys(record);
    if (
      keys.some((key) => !required.includes(key) && !optional.includes(key)) ||
      required.some((key) => !keys.includes(key))
    )
      fail();
    return record;
  } catch (error) {
    if (typeof error === 'object' && error !== null && internalErrors.has(error)) throw error;
    fail();
  }
}
function text(value: unknown, pattern = identifier, limit = 128): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > limit ||
    !pattern.test(value)
  )
    fail();
  return value;
}
function plainText(value: unknown, limit = maxText): string {
  if (typeof value !== 'string' || value.length > limit) fail();
  return value;
}
function timestamp(value: unknown): string {
  const candidate = plainText(value, 32);
  if (!isoTimestamp.test(candidate) || Number.isNaN(Date.parse(candidate))) fail();
  return candidate;
}
function boundedAggregate(value: unknown, maximum: number): void {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > maximum) fail();
}
function frozenValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
  count = { value: 0 }
): DesignEditValue {
  if (++count.value > maxNodes || depth > maxDepth) fail();
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    if (typeof value === 'number' && !Number.isFinite(value)) fail();
    if (typeof value === 'string') plainText(value);
    return value;
  }
  if (typeof value !== 'object' || seen.has(value)) fail();
  seen.add(value);
  let isArray = false;
  try {
    isArray = Array.isArray(value);
  } catch {
    fail();
  }
  if (isArray) {
    const entries = denseArray(value);
    const result = entries.map((entry) => frozenValue(entry, depth + 1, seen, count));
    seen.delete(value);
    return Object.freeze(result);
  }
  const record = own(value);
  const keys = Object.keys(record);
  if (keys.length > maxNodes) fail();
  const result: Record<string, DesignEditValue> = {};
  for (const key of keys.sort()) {
    plainText(key, 128);
    Object.defineProperty(result, key, {
      value: frozenValue(record[key], depth + 1, seen, count),
      enumerable: true,
      configurable: false,
      writable: false
    });
  }
  seen.delete(value);
  return Object.freeze(result);
}
function parseTarget(value: unknown, revision: DesignRevision): DesignEditTarget {
  const input = exact(value, ['format', 'operation', 'sourceAnchorId'], ['parentSourceAnchorId']);
  if (input.format !== 'selene-design-edit-target/v1') fail('unsupported');
  const operation = parseDesignRevisionOperationTarget(input.operation, revision);
  if (
    operation.format !== 'selene-design-revision-operation-target/v2' ||
    operation.projectId !== revision.projectId ||
    operation.tenantId !== revision.tenantId ||
    operation.revisionId !== revision.revisionId ||
    operation.tupleBinding !== revision.tupleBinding ||
    operation.revisionCommitment !== revision.revisionCommitment
  )
    fail();
  const sourceAnchorId = text(input.sourceAnchorId);
  if (sourceAnchorId !== operation.node.source.astNodeId) fail();
  return Object.freeze({
    format: 'selene-design-edit-target/v1' as const,
    operation: Object.freeze({ ...operation }),
    sourceAnchorId,
    ...(input.parentSourceAnchorId === undefined
      ? {}
      : { parentSourceAnchorId: text(input.parentSourceAnchorId) })
  });
}
function parseOperation(
  value: unknown,
  revision: DesignRevision,
  commandId: string,
  actorId: string
): DesignRevisionOperationReference {
  const input = exact(value, [
    'format',
    'kind',
    'tenantId',
    'projectId',
    'actorId',
    'commandId',
    'revisionId',
    'tupleBinding',
    'revisionCommitment'
  ]);
  if (
    input.format !== 'selene-design-revision-operation-reference/v2' ||
    input.kind !== 'edit' ||
    input.tenantId !== revision.tenantId ||
    input.projectId !== revision.projectId ||
    input.actorId !== actorId ||
    input.commandId !== commandId ||
    input.revisionId !== revision.revisionId ||
    input.tupleBinding !== revision.tupleBinding ||
    input.revisionCommitment !== revision.revisionCommitment
  )
    fail();
  return Object.freeze({
    format: 'selene-design-revision-operation-reference/v2' as const,
    kind: 'edit' as const,
    tenantId: revision.tenantId,
    projectId: revision.projectId,
    actorId,
    commandId,
    revisionId: revision.revisionId,
    tupleBinding: revision.tupleBinding,
    revisionCommitment: revision.revisionCommitment
  });
}
function parsePosition(
  value: unknown
): 'first' | 'last' | { readonly beforeSourceAnchorId: string } {
  if (value === 'first' || value === 'last') return value;
  const input = exact(value, ['beforeSourceAnchorId']);
  return Object.freeze({ beforeSourceAnchorId: text(input.beforeSourceAnchorId) });
}
function parseComponent(value: unknown): {
  readonly packageName: string;
  readonly entrypoint: string;
  readonly exportName: string;
  readonly version: string;
  readonly artifactDigest: string;
} {
  const input = exact(value, [
    'packageName',
    'entrypoint',
    'exportName',
    'version',
    'artifactDigest'
  ]);
  const entrypoint = text(input.entrypoint, packageEntrypoint, 258);
  if (
    entrypoint !== '.' &&
    entrypoint
      .slice(2)
      .split('/')
      .some((segment) => segment === '.' || segment === '..')
  )
    fail();
  return Object.freeze({
    packageName: text(input.packageName, packageName),
    entrypoint,
    exportName: text(input.exportName, componentExportName),
    version: text(input.version, lockedVersion, 128),
    artifactDigest: text(input.artifactDigest, digest, 64)
  });
}
function parseInsertProps(value: unknown): Readonly<Record<string, string | number | boolean>> {
  const input = own(value);
  const keys = Object.keys(input);
  if (keys.length > 32) fail();
  // Keep a hostile but otherwise valid object from consuming the proposal
  // budget before the command-level aggregate bound is evaluated.
  boundedAggregate(input, 16_384);
  const props: Record<string, string | number | boolean> = {};
  for (const key of keys.sort()) {
    if (
      !componentPropName.test(key) ||
      /^(?:children|key|ref|dangerouslysetinnerhtml|data-selene-node-id)$/i.test(key)
    )
      fail();
    const literal = input[key];
    if (typeof literal === 'string') {
      if (literal.length > 256) fail();
    } else if (typeof literal === 'number') {
      if (!Number.isFinite(literal) || Math.abs(literal) > 1_000_000) fail();
    } else if (typeof literal !== 'boolean') fail();
    Object.defineProperty(props, key, {
      value: literal,
      enumerable: true,
      configurable: false,
      writable: false
    });
  }
  return Object.freeze(props);
}
function parseCommand(value: unknown, revision: DesignRevision): DesignEditCommand {
  const kind = own(value).kind;
  switch (kind) {
    case 'set-content': {
      const input = exact(value, ['kind', 'target', 'content']);
      const target = parseTarget(input.target, revision);
      return Object.freeze({ kind: 'set-content', target, content: plainText(input.content) });
    }
    case 'set-prop': {
      const input = exact(value, ['kind', 'target', 'prop', 'value']);
      const target = parseTarget(input.target, revision);
      const prop = text(input.prop);
      if (
        /^(?:on|ref$|key$|dangerouslySetInnerHTML$|children$|style$|suppressHydrationWarning$)/i.test(
          prop
        )
      )
        fail();
      return Object.freeze({
        kind: 'set-prop',
        target,
        prop,
        value: frozenValue(input.value)
      });
    }
    case 'set-token': {
      const input = exact(value, ['kind', 'target', 'token', 'value']);
      const target = parseTarget(input.target, revision);
      return Object.freeze({
        kind: 'set-token',
        target,
        token: text(input.token, token),
        value: frozenValue(input.value)
      });
    }
    case 'set-style': {
      const input = exact(value, [
        'kind',
        'target',
        'property',
        'value',
        'risk',
        'policyDigest',
        'provenanceDigest'
      ]);
      const target = parseTarget(input.target, revision);
      if (input.risk !== 'raw-style') fail();
      return Object.freeze({
        kind: 'set-style',
        target,
        property: text(input.property, cssProperty),
        value: frozenValue(input.value),
        risk: 'raw-style',
        policyDigest: text(input.policyDigest, digest, 64),
        provenanceDigest: text(input.provenanceDigest, digest, 64)
      });
    }
    case 'set-layout': {
      const input = exact(value, ['kind', 'target', 'property', 'value'], ['breakpoint']);
      const target = parseTarget(input.target, revision);
      const property = input.property;
      if (
        ![
          'display',
          'flexDirection',
          'justifyContent',
          'alignItems',
          'gap',
          'gridTemplateColumns',
          'gridTemplateRows',
          'order',
          'width',
          'height',
          'minWidth',
          'minHeight',
          'maxWidth',
          'maxHeight'
        ].includes(property as string)
      )
        fail();
      if (
        input.breakpoint !== undefined &&
        !['base', 'sm', 'md', 'lg', 'xl'].includes(input.breakpoint as string)
      )
        fail();
      return Object.freeze({
        kind: 'set-layout',
        target,
        property: property as Extract<DesignEditCommand, { kind: 'set-layout' }>['property'],
        value: frozenValue(input.value),
        ...(input.breakpoint === undefined
          ? {}
          : { breakpoint: input.breakpoint as 'base' | 'sm' | 'md' | 'lg' | 'xl' })
      });
    }
    case 'replace-component': {
      const input = exact(value, ['kind', 'target', 'component']);
      const target = parseTarget(input.target, revision);
      return Object.freeze({
        kind: 'replace-component',
        target,
        component: parseComponent(input.component)
      });
    }
    case 'insert-child': {
      const input = exact(
        value,
        ['kind', 'target', 'component', 'newSourceAnchorId', 'position'],
        ['props']
      );
      const target = parseTarget(input.target, revision);
      return Object.freeze({
        kind: 'insert-child',
        target,
        component: parseComponent(input.component),
        ...(input.props === undefined ? {} : { props: parseInsertProps(input.props) }),
        newSourceAnchorId: text(input.newSourceAnchorId),
        position: parsePosition(input.position)
      });
    }
    case 'remove-node': {
      const input = exact(value, ['kind', 'target']);
      const target = parseTarget(input.target, revision);
      return Object.freeze({ kind: 'remove-node', target });
    }
    case 'reorder-child': {
      const input = exact(value, ['kind', 'target', 'position']);
      const target = parseTarget(input.target, revision);
      return Object.freeze({
        kind: 'reorder-child',
        target,
        position: parsePosition(input.position)
      });
    }
    case 'reparent-child': {
      const input = exact(value, ['kind', 'target', 'newParentSourceAnchorId', 'position']);
      const target = parseTarget(input.target, revision);
      return Object.freeze({
        kind: 'reparent-child',
        target,
        newParentSourceAnchorId: text(input.newParentSourceAnchorId),
        position: parsePosition(input.position)
      });
    }
    default:
      fail('unsupported');
  }
}
function parsePrecondition(value: unknown): DesignEditPrecondition {
  const input = exact(
    value,
    ['kind'],
    [
      'sourceDigest',
      'bindingDigest',
      'designSystemLockDigest',
      'sourceAnchorId',
      'parentSourceAnchorId',
      'property',
      'value',
      'token',
      'resolvedDigest'
    ]
  );
  switch (input.kind) {
    case 'source-revision':
      return Object.freeze({
        kind: 'source-revision',
        sourceDigest: text(input.sourceDigest, digest, 64)
      });
    case 'binding-revision':
      return Object.freeze({
        kind: 'binding-revision',
        bindingDigest: text(input.bindingDigest, digest, 64)
      });
    case 'design-system-lock':
      return Object.freeze({
        kind: 'design-system-lock',
        designSystemLockDigest: text(input.designSystemLockDigest, digest, 64)
      });
    case 'node-exists':
      return Object.freeze({ kind: 'node-exists', sourceAnchorId: text(input.sourceAnchorId) });
    case 'parent-is':
      return Object.freeze({
        kind: 'parent-is',
        sourceAnchorId: text(input.sourceAnchorId),
        parentSourceAnchorId: text(input.parentSourceAnchorId)
      });
    case 'property-equals':
      return Object.freeze({
        kind: 'property-equals',
        sourceAnchorId: text(input.sourceAnchorId),
        property: text(input.property),
        value: frozenValue(input.value)
      });
    case 'token-resolves':
      return Object.freeze({
        kind: 'token-resolves',
        token: text(input.token, token),
        resolvedDigest: text(input.resolvedDigest, digest, 64)
      });
    default:
      fail('unsupported');
  }
}

export function parseDesignEditProposal(value: unknown): DesignEditProposal {
  const input = exact(value, [
    'format',
    'schemaVersion',
    'proposalId',
    'commandId',
    'actorId',
    'origin',
    'operation',
    'base',
    'commands',
    'preconditions',
    'requestedAt'
  ]);
  if (input.format !== designEditProposalFormat || input.schemaVersion !== 1) fail('unsupported');
  if (!['manual-canvas', 'ai-proposal', 'automation'].includes(input.origin as string)) fail();
  const base = parseDesignRevision(input.base);
  const commandId = text(input.commandId);
  const actorId = text(input.actorId);
  const operation = parseOperation(input.operation, base, commandId, actorId);
  const commandInput = denseArray(input.commands);
  const preconditionInput = denseArray(input.preconditions);
  if (
    commandInput.length === 0 ||
    commandInput.length > maxCommands ||
    preconditionInput.length > maxCommands
  )
    fail();
  const commands = commandInput.map((command) => parseCommand(command, base));
  const preconditions = preconditionInput.map(parsePrecondition);
  const has = (kind: DesignEditPrecondition['kind'], expected: string): boolean =>
    preconditions.some(
      (entry) =>
        (entry.kind === 'source-revision' &&
          kind === 'source-revision' &&
          entry.sourceDigest === expected) ||
        (entry.kind === 'binding-revision' &&
          kind === 'binding-revision' &&
          entry.bindingDigest === expected) ||
        (entry.kind === 'design-system-lock' &&
          kind === 'design-system-lock' &&
          entry.designSystemLockDigest === expected)
    );
  if (
    !has('source-revision', base.tuple.sourceDigest) ||
    !has('binding-revision', base.tuple.bindingDigest) ||
    !has('design-system-lock', base.tuple.designSystemLockDigest)
  )
    fail();
  const commandCommitments = commands.map((command) => JSON.stringify(command));
  if (new Set(commandCommitments).size !== commandCommitments.length) fail();
  const preconditionCommitments = preconditions.map((precondition) => JSON.stringify(precondition));
  if (new Set(preconditionCommitments).size !== preconditionCommitments.length) fail();
  /** Host resolves these compiler anchors and applies a structural batch sequentially in one atomic transaction. */
  for (const command of commands) {
    if (command.kind === 'insert-child') {
      if (command.target.parentSourceAnchorId !== undefined) fail();
      if (
        command.newSourceAnchorId === command.target.sourceAnchorId ||
        preconditions.some(
          (precondition) =>
            precondition.kind === 'node-exists' &&
            precondition.sourceAnchorId === command.newSourceAnchorId
        )
      )
        fail();
      if (typeof command.position !== 'string') {
        const before = command.position.beforeSourceAnchorId;
        if (
          before === command.target.sourceAnchorId ||
          !preconditions.some(
            (precondition) =>
              precondition.kind === 'node-exists' && precondition.sourceAnchorId === before
          ) ||
          !preconditions.some(
            (precondition) =>
              precondition.kind === 'parent-is' &&
              precondition.sourceAnchorId === before &&
              precondition.parentSourceAnchorId === command.target.sourceAnchorId
          )
        )
          fail();
      }
    }
    if (
      command.kind === 'remove-node' ||
      command.kind === 'reorder-child' ||
      command.kind === 'reparent-child'
    ) {
      const parent = command.target.parentSourceAnchorId;
      if (
        parent === undefined ||
        !preconditions.some(
          (precondition) =>
            precondition.kind === 'parent-is' &&
            precondition.sourceAnchorId === command.target.sourceAnchorId &&
            precondition.parentSourceAnchorId === parent
        )
      )
        fail();
      if (
        (command.kind === 'reorder-child' || command.kind === 'reparent-child') &&
        typeof command.position !== 'string'
      ) {
        const before = command.position.beforeSourceAnchorId;
        const expectedParent =
          command.kind === 'reparent-child' ? command.newParentSourceAnchorId : parent;
        if (
          before === command.target.sourceAnchorId ||
          !preconditions.some(
            (precondition) =>
              precondition.kind === 'parent-is' &&
              precondition.sourceAnchorId === before &&
              precondition.parentSourceAnchorId === expectedParent
          )
        )
          fail();
      }
      if (command.kind === 'reparent-child') {
        if (command.newParentSourceAnchorId === parent) fail();
        if (
          !preconditions.some(
            (precondition) =>
              precondition.kind === 'node-exists' &&
              precondition.sourceAnchorId === command.newParentSourceAnchorId
          )
        )
          fail();
      }
    }
  }
  const canonicalPreconditions = Object.freeze(
    [...preconditions].sort((left, right) => {
      const leftCommitment = JSON.stringify(left);
      const rightCommitment = JSON.stringify(right);
      return leftCommitment < rightCommitment ? -1 : leftCommitment > rightCommitment ? 1 : 0;
    })
  );
  boundedAggregate({ commands, preconditions: canonicalPreconditions }, maxAggregateProposalBytes);
  return Object.freeze({
    format: designEditProposalFormat,
    schemaVersion: 1,
    proposalId: text(input.proposalId),
    commandId,
    actorId,
    origin: input.origin as DesignEditOrigin,
    operation,
    base,
    commands: Object.freeze(commands),
    preconditions: canonicalPreconditions,
    requestedAt: timestamp(input.requestedAt)
  });
}

/** Ephemeral canonical payload for a trusted host digest only. Never persist or expose it in receipts. */
function createDesignEditDigestPayload(value: unknown): string {
  const proposal = parseDesignEditProposal(value);
  return serializeCanonicalData([
    'selene-design-edit-proposal-digest/v1',
    proposal.proposalId,
    proposal.commandId,
    proposal.actorId,
    proposal.operation,
    proposal.base.revisionCommitment,
    proposal.commands,
    proposal.preconditions,
    proposal.requestedAt
  ]);
}

function diagnostic(value: unknown): DesignEditDiagnostic {
  const input = exact(value, ['code'], ['commandIndex', 'preconditionIndex']);
  const index = (candidate: unknown): number | undefined =>
    candidate === undefined
      ? undefined
      : typeof candidate === 'number' &&
          Number.isSafeInteger(candidate) &&
          candidate >= 0 &&
          candidate < maxCommands
        ? candidate
        : fail();
  const commandIndex = index(input.commandIndex);
  const preconditionIndex = index(input.preconditionIndex);
  return Object.freeze({
    code: text(input.code),
    ...(commandIndex === undefined ? {} : { commandIndex }),
    ...(preconditionIndex === undefined ? {} : { preconditionIndex })
  });
}
function parseDigest(value: unknown): { readonly format: 'sha256'; readonly value: string } {
  const input = exact(value, ['format', 'value']);
  if (input.format !== 'sha256') fail('unsupported');
  return Object.freeze({ format: 'sha256' as const, value: text(input.value, digest, 64) });
}
function captureOwnCallable(
  value: unknown,
  key: 'apply' | 'sha256'
): (...arguments_: readonly unknown[]) => unknown {
  try {
    if (typeof value !== 'object' || value === null) fail();
    let owner: object | null = value;
    let descriptor: PropertyDescriptor | undefined;
    for (let depth = 0; depth < 8 && owner !== null; depth += 1) {
      descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor !== undefined) break;
      owner = Object.getPrototypeOf(owner);
    }
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'function'
    )
      fail();
    const callable = descriptor.value as (...arguments_: readonly unknown[]) => unknown;
    return (...arguments_) => Reflect.apply(callable, value, arguments_);
  } catch (error) {
    if (typeof error === 'object' && error !== null && internalErrors.has(error)) throw error;
    fail();
  }
}
function parseResult(
  value: unknown,
  proposal: DesignEditProposal,
  proposalDigest: string
): DesignEditResult {
  const kind = own(value).kind;
  if (kind === 'applied' || kind === 'replayed') {
    const input = exact(value, ['format', 'kind', 'receipt']);
    if (input.format !== designEditResultFormat) fail('unsupported');
    const receipt = exact(input.receipt, [
      'format',
      'proposalId',
      'baseRevisionId',
      'targetRevisionId',
      'targetRevision',
      'proposalDigest',
      'sourceDigest',
      'bindingDigest',
      'bindingRemaps',
      'formatReceipt',
      'compileReceipt',
      'undo',
      'commandSummary',
      'appliedAt'
    ]);
    if (
      receipt.format !== 'selene-design-edit-receipt/v1' ||
      receipt.proposalId !== proposal.proposalId ||
      receipt.baseRevisionId !== proposal.base.revisionId ||
      !Array.isArray(receipt.commandSummary) ||
      !Array.isArray(receipt.bindingRemaps) ||
      receipt.commandSummary.length === 0
    )
      fail();
    const targetRevision = parseDesignRevision(receipt.targetRevision);
    if (
      targetRevision.tenantId !== proposal.base.tenantId ||
      targetRevision.projectId !== proposal.base.projectId ||
      targetRevision.parentRevisionId !== proposal.base.revisionId ||
      targetRevision.sequence !== proposal.base.sequence + 1 ||
      receipt.targetRevisionId !== targetRevision.revisionId ||
      receipt.sourceDigest !== targetRevision.tuple.sourceDigest ||
      receipt.bindingDigest !== targetRevision.tuple.bindingDigest ||
      targetRevision.tuple.designSystemLockDigest !== proposal.base.tuple.designSystemLockDigest
    )
      fail();
    if (receipt.commandSummary.length > maxCommands || receipt.bindingRemaps.length > maxCommands)
      fail();
    const summary = receipt.commandSummary.map((entry) => {
      const item = exact(entry, ['kind', 'count']);
      if (
        typeof item.kind !== 'string' ||
        typeof item.count !== 'number' ||
        !Number.isSafeInteger(item.count) ||
        item.count < 1
      )
        fail();
      if (!proposal.commands.some((command) => command.kind === item.kind)) fail();
      return Object.freeze({ kind: item.kind as DesignEditCommand['kind'], count: item.count });
    });
    if (
      new Set(summary.map((entry) => entry.kind)).size !== summary.length ||
      summary.reduce((total, entry) => total + entry.count, 0) !== proposal.commands.length ||
      summary.some(
        (entry) =>
          entry.count !== proposal.commands.filter((command) => command.kind === entry.kind).length
      )
    )
      fail();
    const bindingRemaps = receipt.bindingRemaps.map((entry) => {
      const item = exact(entry, ['fromSourceAnchorId', 'toSourceAnchorId']);
      return Object.freeze({
        fromSourceAnchorId: text(item.fromSourceAnchorId),
        toSourceAnchorId: text(item.toSourceAnchorId)
      });
    });
    if (
      new Set(bindingRemaps.map((entry) => entry.fromSourceAnchorId)).size !==
        bindingRemaps.length ||
      new Set(bindingRemaps.map((entry) => entry.toSourceAnchorId)).size !== bindingRemaps.length
    )
      fail();
    const formatReceipt = exact(receipt.formatReceipt, ['status', 'formatterId', 'digest']);
    const compileReceipt = exact(receipt.compileReceipt, ['status', 'compilerId', 'digest']);
    const undo = exact(receipt.undo, ['format', 'undoId', 'proposalDigest', 'targetRevisionId']);
    if (
      formatReceipt.status !== 'formatted' ||
      compileReceipt.status !== 'compiled' ||
      undo.format !== 'selene-design-edit-undo/v1'
    )
      fail();
    const receiptDigest = parseDigest(receipt.proposalDigest);
    const undoDigest = parseDigest(undo.proposalDigest);
    if (receiptDigest.value !== proposalDigest || undoDigest.value !== proposalDigest) fail();
    const parsedReceipt: DesignEditReceipt = Object.freeze({
      format: 'selene-design-edit-receipt/v1' as const,
      proposalId: proposal.proposalId,
      baseRevisionId: proposal.base.revisionId,
      targetRevisionId: targetRevision.revisionId,
      targetRevision,
      proposalDigest: receiptDigest,
      sourceDigest: text(receipt.sourceDigest, digest, 64),
      bindingDigest: text(receipt.bindingDigest, digest, 64),
      bindingRemaps: Object.freeze(bindingRemaps),
      formatReceipt: Object.freeze({
        status: 'formatted' as const,
        formatterId: text(formatReceipt.formatterId),
        digest: text(formatReceipt.digest, digest, 64)
      }),
      compileReceipt: Object.freeze({
        status: 'compiled' as const,
        compilerId: text(compileReceipt.compilerId),
        digest: text(compileReceipt.digest, digest, 64)
      }),
      undo: Object.freeze({
        format: 'selene-design-edit-undo/v1' as const,
        undoId: text(undo.undoId),
        proposalDigest: undoDigest,
        targetRevisionId: text(undo.targetRevisionId)
      }),
      commandSummary: Object.freeze(summary),
      appliedAt: timestamp(receipt.appliedAt)
    });
    if (
      Date.parse(targetRevision.createdAt) <= Date.parse(proposal.base.createdAt) ||
      Date.parse(targetRevision.createdAt) > Date.parse(parsedReceipt.appliedAt) ||
      Date.parse(parsedReceipt.appliedAt) < Date.parse(proposal.requestedAt)
    )
      fail();
    if (
      parsedReceipt.undo.proposalDigest.value !== parsedReceipt.proposalDigest.value ||
      parsedReceipt.undo.targetRevisionId !== parsedReceipt.targetRevisionId
    )
      fail();
    boundedAggregate(parsedReceipt, maxAggregateResultBytes);
    return Object.freeze({
      format: designEditResultFormat,
      kind: input.kind as 'applied' | 'replayed',
      receipt: parsedReceipt
    });
  }
  if (kind !== 'conflict' && kind !== 'rejected') fail('unsupported');
  const input = exact(value, ['format', 'kind', 'diagnostics']);
  if (input.format !== designEditResultFormat) fail('unsupported');
  if (
    !Array.isArray(input.diagnostics) ||
    input.diagnostics.length === 0 ||
    input.diagnostics.length > maxCommands
  )
    fail();
  return Object.freeze({
    format: designEditResultFormat,
    kind,
    diagnostics: Object.freeze(input.diagnostics.map(diagnostic))
  });
}

/** Executes a proposal through a supplied host port. Adapter failures are deliberately reduced to bounded rejections. */
export async function applyDesignEditProposal(
  value: unknown,
  adapter: DesignEditAdapterPort,
  digestPort: DesignEditDigestPort
): Promise<DesignEditResult> {
  const proposal = parseDesignEditProposal(value);
  try {
    const apply = captureOwnCallable(adapter, 'apply');
    const sha256 = captureOwnCallable(digestPort, 'sha256');
    const payload = createDesignEditDigestPayload(proposal);
    const proposalDigest = text(await sha256(payload), digest, 64);
    const context = Object.freeze({
      proposalDigest: Object.freeze({ format: 'sha256' as const, value: proposalDigest })
    });
    return parseResult(await apply(proposal, context), proposal, proposalDigest);
  } catch {
    return Object.freeze({
      format: designEditResultFormat,
      kind: 'rejected' as const,
      diagnostics: Object.freeze([{ code: 'host-apply-failed' }])
    });
  }
}
