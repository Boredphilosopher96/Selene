/**
 * A deterministic, data-only extension planner. All effects are host ports;
 * this package has no runtime imports, process, filesystem, or network access.
 */
import { streamValidatedEvents, validateAdapter, validateExecution } from '@selene/agent-sdk';
import type {
  AgentAdapter,
  AgentCapability,
  AgentExecution,
  AgentProviderCallContext,
  AgentProviderRuntime,
  AgentProviderRuntimeCallOptions,
  EventEnvelope
} from '@selene/agent-sdk';
import type {
  DesignContext,
  DesignInputPort,
  DesignInputLoader,
  DesignInputRequest,
  ResolvedDesignLanguage,
  ResolvedDesignPackage
} from '@selene/design-inputs';

export const extensionKernelPackageName = '@selene/extension-kernel';
export const EXTENSION_MANIFEST_VERSION = '1.0' as const;

export type ExtensionKind =
  | 'agent'
  | 'design-library'
  | 'exporter'
  | 'policy'
  | 'preview-decorator'
  | 'react-template'
  | 'validator';
export type Permission =
  'agent.execute' | 'design-input.read' | 'export.write' | 'preview.decorate';
export type TrustLevel = 'trusted' | 'verified' | 'untrusted';
export type LifecycleEvent = 'install' | 'configure' | 'activate' | 'deactivate';

export interface ExtensionDependency {
  readonly id: string;
  readonly range: string;
  readonly optional?: boolean;
}
export interface ExtensionIntegrity {
  readonly sha256: string;
  readonly source: string;
}
export interface ExtensionProvenance {
  readonly publisher: string;
  readonly source: string;
  readonly receivedAt?: string;
}
export interface ExtensionTrust {
  readonly level: TrustLevel;
  readonly provenance: ExtensionProvenance;
  readonly integrity: ExtensionIntegrity;
}
export interface ExtensionConfiguration {
  readonly defaults?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  /** A deliberately small, JSON-schema-like object validator for host config. */
  readonly schema?: ConfigurationSchema;
}
export type ConfigurationValueType =
  'array' | 'boolean' | 'integer' | 'null' | 'number' | 'object' | 'string';
export interface ConfigurationSchema {
  readonly type: 'object';
  readonly properties?: Readonly<Record<string, ConfigurationPropertySchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}
export interface ConfigurationPropertySchema {
  readonly type: ConfigurationValueType;
  readonly enum?: readonly (boolean | number | string | null)[];
  readonly minimum?: number;
  readonly items?: ConfigurationPropertySchema;
  readonly properties?: Readonly<Record<string, ConfigurationPropertySchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}
export interface LifecycleCommand {
  readonly id: string;
  readonly event: LifecycleEvent;
  readonly capability?: string;
  readonly input?: Readonly<Record<string, unknown>>;
}
export interface ExtensionContributions {
  readonly templates?: readonly string[];
  readonly generators?: readonly string[];
  readonly validators?: readonly string[];
  readonly exporters?: readonly string[];
  readonly previewDecorators?: readonly string[];
  readonly policies?: readonly string[];
  readonly designSystem?: DesignSystemContribution;
}
export type DesignModeKind = 'brand' | 'locale' | 'theme' | 'viewport';
export interface DesignMode {
  readonly kind: DesignModeKind;
  readonly id: string;
  readonly label: string;
}
export interface DesignTokenAlias {
  readonly target: string;
}
export interface DesignToken {
  readonly id: string;
  readonly value: boolean | number | string;
  readonly aliases?: readonly DesignTokenAlias[];
  /** Values keyed by a declared mode id, for example dark or mobile. */
  readonly modes?: Readonly<Record<string, boolean | number | string>>;
}
export interface DesignTokenCollection {
  readonly id: string;
  readonly modes: readonly DesignMode[];
  readonly tokens: readonly DesignToken[];
}
export interface DesignComponentSlot {
  readonly id: string;
  readonly required?: boolean;
}
export interface DesignComponentVariant {
  readonly id: string;
  readonly values: readonly string[];
}
export interface DesignComponent {
  readonly id: string;
  readonly exportName: string;
  readonly variants: readonly DesignComponentVariant[];
  readonly slots: readonly DesignComponentSlot[];
}
export interface DesignSystemContribution {
  readonly tokenCollections: readonly DesignTokenCollection[];
  readonly components: readonly DesignComponent[];
}
export interface ExtensionManifest {
  readonly manifestVersion: typeof EXTENSION_MANIFEST_VERSION;
  readonly id: string;
  readonly version: string;
  readonly kind: ExtensionKind;
  readonly capabilities: readonly string[];
  readonly permissions: readonly Permission[];
  readonly trust: ExtensionTrust;
  readonly dependencies?: readonly ExtensionDependency[];
  readonly conflicts?: readonly string[];
  readonly configuration?: ExtensionConfiguration;
  readonly lifecycle?: readonly LifecycleCommand[];
  readonly contributes?: ExtensionContributions;
}
export interface ExtensionPolicy {
  readonly allowedPermissions: readonly Permission[];
  readonly minimumTrust: TrustLevel;
  readonly requiredPublishers?: readonly string[];
  readonly requireIntegrity?: boolean;
}
export interface ExtensionIntegrityPort {
  verify(manifest: ExtensionManifest): Promise<boolean> | boolean;
}
/** Adapter-shaped aliases keep agent and design input integrations at a host port. */
export interface ExtensionHostPorts {
  readonly integrity?: ExtensionIntegrityPort;
  readonly agent?: {
    readonly adapter: AgentAdapter;
    execute(execution: AgentExecution): AsyncIterable<EventEnvelope>;
  };
  readonly designInputs?: {
    readonly port: DesignInputPort;
    load(request: DesignInputRequest): Promise<DesignContext>;
    readonly artifacts?: {
      resolvePackage(request: DesignInputRequest['package']): Promise<ResolvedDesignPackage>;
      readDesignLanguage(
        request: DesignInputRequest['designLanguage']
      ): Promise<ResolvedDesignLanguage>;
    };
  };
  emit(event: ExtensionLifecycleEvent): Promise<void> | void;
}
export interface ExtensionLifecycleEvent {
  readonly extensionId: string;
  readonly event: LifecycleEvent;
  readonly commandId: string;
  readonly capability?: string;
  readonly input: Readonly<Record<string, unknown>>;
}
export type ExtensionIssueCode =
  | 'conflict'
  | 'cycle'
  | 'duplicate-extension'
  | 'integrity-failed'
  | 'invalid-config'
  | 'invalid-manifest'
  | 'missing-dependency'
  | 'permission-denied'
  | 'trust-denied'
  | 'unsupported-version'
  | 'version-mismatch';
export interface ExtensionIssue {
  readonly code: ExtensionIssueCode;
  readonly extensionIds: readonly string[];
  readonly message: string;
}
export class ExtensionValidationError extends Error {
  public readonly issues: readonly ExtensionIssue[];

  public constructor(issues: unknown) {
    const normalized = normalizeErrorIssues(issues);
    super(normalized.map((entry) => entry.message).join('\n'));
    this.name = 'ExtensionValidationError';
    this.issues = normalized;
  }
}
export interface ResolvedExtension {
  readonly manifest: ExtensionManifest;
  readonly configuration: Readonly<Record<string, unknown>>;
}
export interface ExtensionPlan {
  readonly extensions: readonly ResolvedExtension[];
  readonly lifecycle: readonly ExtensionLifecycleEvent[];
}
export interface AgentExtensionBridge {
  readonly capabilities: readonly AgentCapability[];
  supports(capability: AgentCapability): boolean;
  stream(execution: AgentExecution): AsyncIterable<EventEnvelope>;
}
/** Host-owned supervision required to create a provider stream. */
export interface AgentExtensionBridgeOptions {
  readonly runtime: AgentProviderRuntime;
  readonly timeoutMs?: number;
}
export interface ResolvedDesignInputArtifacts {
  readonly packageArtifact: ResolvedDesignPackage;
  readonly designLanguageArtifact: ResolvedDesignLanguage;
}
export interface DesignInputExtensionBridge {
  resolve(request: DesignInputRequest): Promise<ResolvedDesignInputArtifacts>;
  toContext(request: DesignInputRequest, artifacts: ResolvedDesignInputArtifacts): DesignContext;
}

export const MAX_EXTENSION_MANIFESTS = 64;
export const MAX_EXTENSION_LIFECYCLE_EVENTS = 256;
export const MAX_EXTENSION_ISSUES = 64;
export const MAX_EXTENSION_AGENT_TIMEOUT_MS = 5 * 60 * 1000;

const MAX_SNAPSHOT_DEPTH = 16;
const MAX_SNAPSHOT_ARRAY_ITEMS = 256;
const MAX_SNAPSHOT_OBJECT_KEYS = 128;
const MAX_SNAPSHOT_STRING_LENGTH = 16 * 1024;
const MAX_SNAPSHOT_BYTES = 64 * 1024;
const MAX_SNAPSHOT_CODE_UNITS = 64 * 1024;
const MAX_SNAPSHOT_VALUES = 4_096;
const MAX_EXTENSION_STREAM_BYTES = 64 * 1024;
const MAX_EXTENSION_STREAM_VALUES = 4_096;
const MAX_ISSUE_MESSAGE_LENGTH = 1024;
const MAX_ISSUE_EXTENSION_IDS = 16;
const reservedDataKeys = new Set(['__proto__', 'constructor', 'prototype']);
const idPattern = /^[a-z][a-z0-9-]{0,62}(?:\.[a-z][a-z0-9-]{0,62})*$/;
const capabilityPattern = /^[a-z][a-z0-9.-]{0,127}$/;
const sriPattern = /^sha256-[A-Za-z0-9+/]{43}=$/;
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;
const rangeTokenPattern = /^(\^|~|>=|<=|>|<|=)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const trustRank: Readonly<Record<TrustLevel, number>> = { untrusted: 0, verified: 1, trusted: 2 };
const extensionKinds: readonly ExtensionKind[] = [
  'agent',
  'design-library',
  'exporter',
  'policy',
  'preview-decorator',
  'react-template',
  'validator'
];
const permissions: readonly Permission[] = [
  'agent.execute',
  'design-input.read',
  'export.write',
  'preview.decorate'
];
const lifecycleEvents: readonly LifecycleEvent[] = [
  'install',
  'configure',
  'activate',
  'deactivate'
];
const designModeKinds: readonly DesignModeKind[] = ['brand', 'locale', 'theme', 'viewport'];
const configurationValueTypes: readonly ConfigurationValueType[] = [
  'array',
  'boolean',
  'integer',
  'null',
  'number',
  'object',
  'string'
];
const extensionPlans = new WeakSet<object>();
const issuedErrors = new WeakSet<object>();
const issuedIssues = new WeakSet<object>();
const planPolicies = new WeakMap<object, ExtensionPolicy>();
const planRecords = new WeakMap<
  object,
  { readonly plan: ExtensionPlan; readonly policy: ExtensionPolicy }
>();

interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease?: string;
}
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function policiesEqual(left: ExtensionPolicy, right: ExtensionPolicy): boolean {
  return (
    left.minimumTrust === right.minimumTrust &&
    left.requireIntegrity === right.requireIntegrity &&
    left.allowedPermissions.length === right.allowedPermissions.length &&
    left.allowedPermissions.every((value, index) => value === right.allowedPermissions[index]) &&
    left.requiredPublishers?.length === right.requiredPublishers?.length &&
    left.requiredPublishers?.every(
      (value, index) => value === right.requiredPublishers?.[index]
    ) !== false
  );
}
function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareText);
}
function boundedText(value: unknown, maximum = MAX_SNAPSHOT_STRING_LENGTH): string | undefined {
  return typeof value === 'string' && value.length <= maximum ? value : undefined;
}
function parseVersion(value: unknown): Semver | undefined {
  const text = boundedText(value);
  if (text === undefined) return undefined;
  const match = versionPattern.exec(text);
  return match === null
    ? undefined
    : {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        ...(match[4] === undefined ? {} : { prerelease: match[4] })
      };
}
function compareVersion(left: Semver, right: Semver): number {
  for (const key of ['major', 'minor', 'patch'] as const)
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === undefined) return 1;
  if (right.prerelease === undefined) return -1;
  return compareText(left.prerelease, right.prerelease);
}
/** Exact, ^, ~, and conjunctions of <, <=, >, >= comparator ranges. */
export function satisfiesSemver(version: unknown, range: unknown): boolean {
  const parsed = parseVersion(version);
  const rawRange = boundedText(range);
  if (parsed === undefined || rawRange === undefined || rawRange.length === 0) return false;
  const rangeText = rawRange.trim();
  if (rangeText.length === 0 || rangeText.length > MAX_SNAPSHOT_STRING_LENGTH) return false;
  return rangeText.split(/\s+/).every((token) => {
    const match = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(token);
    const wanted = match === null ? undefined : parseVersion(match[2] ?? '');
    if (wanted === undefined) return false;
    const relation = compareVersion(parsed, wanted);
    const operator = match?.[1] ?? '=';
    switch (operator) {
      case '^':
        if (relation < 0 || parsed.major !== wanted.major) return false;
        if (wanted.major > 0) return true;
        if (parsed.minor !== wanted.minor) return false;
        return wanted.minor > 0 || parsed.patch === wanted.patch;
      case '~':
        return relation >= 0 && parsed.major === wanted.major && parsed.minor === wanted.minor;
      case '>=':
        return relation >= 0;
      case '<=':
        return relation <= 0;
      case '>':
        return relation > 0;
      case '<':
        return relation < 0;
      default:
        return relation === 0;
    }
  });
}
function issue(
  code: ExtensionIssueCode,
  extensionIds: readonly string[],
  message: string
): ExtensionIssue {
  const result = Object.freeze({
    code,
    extensionIds: Object.freeze(uniqueSorted(extensionIds).slice(0, MAX_ISSUE_EXTENSION_IDS)),
    message: message.slice(0, MAX_ISSUE_MESSAGE_LENGTH)
  });
  issuedIssues.add(result);
  return result;
}
function isExtensionIssue(value: unknown): value is ExtensionIssue {
  return typeof value === 'object' && value !== null && issuedIssues.has(value);
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
/**
 * Copies data at the extension boundary without invoking getters later in the
 * planner. Extension manifests, policy, configuration, and lifecycle inputs
 * are data, never host objects. The limits keep hostile JSON-shaped input from
 * turning validation into an allocation or recursion oracle.
 */
function snapshotData(value: unknown): unknown {
  const active = new WeakSet<object>();
  let bytes = 0;
  let values = 0;
  const countBytes = (text: string) => {
    if (text.length > MAX_SNAPSHOT_STRING_LENGTH)
      throw new TypeError('input string limit exceeded');
    codeUnits += text.length;
    if (codeUnits > MAX_SNAPSHOT_CODE_UNITS) throw new TypeError('input code-unit budget exceeded');
    const length = new TextEncoder().encode(text).length;
    bytes += length;
    if (length > MAX_SNAPSHOT_STRING_LENGTH || bytes > MAX_SNAPSHOT_BYTES)
      throw new TypeError('input string byte budget exceeded');
  };
  let codeUnits = 0;
  const copy = (candidate: unknown, depth: number): unknown => {
    values += 1;
    if (values > MAX_SNAPSHOT_VALUES) throw new TypeError('input value count exceeded');
    if (candidate === null || typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new TypeError('numbers must be finite');
      return candidate;
    }
    if (typeof candidate === 'string') {
      countBytes(candidate);
      return candidate;
    }
    if (depth >= MAX_SNAPSHOT_DEPTH) throw new TypeError('input nesting exceeds limit');
    if (typeof candidate !== 'object' || candidate === null)
      throw new TypeError('input must contain JSON data only');
    if (active.has(candidate)) throw new TypeError('cycles are not supported');
    active.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (Object.getPrototypeOf(candidate) !== Array.prototype)
          throw new TypeError('array must use the exact Array prototype');
        const lengthDescriptor = Object.getOwnPropertyDescriptor(candidate, 'length');
        if (
          lengthDescriptor === undefined ||
          !('value' in lengthDescriptor) ||
          !Number.isSafeInteger(lengthDescriptor.value) ||
          lengthDescriptor.value < 0 ||
          lengthDescriptor.value > MAX_SNAPSHOT_ARRAY_ITEMS
        )
          throw new TypeError('array length is outside limits');
        const length = lengthDescriptor.value;
        // Read and enforce the cheap length cap before any operation that can
        // enumerate an attacker-controlled array (or allocate its key list).
        const keys = Reflect.ownKeys(candidate);
        if (keys.length > length + 1 || keys.some((key) => typeof key === 'symbol'))
          throw new TypeError('array symbol keys or extras are not supported');
        if (keys.length !== length + 1)
          throw new TypeError('array must have dense own data entries only');
        const result: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
          if (!keys.includes(String(index)))
            throw new TypeError('arrays must not contain holes or extras');
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable)
            throw new TypeError('arrays must not contain holes or accessors');
          result.push(copy(descriptor.value, depth + 1));
        }
        return Object.freeze(result);
      }
      if (!isRecord(candidate)) throw new TypeError('input must contain plain JSON data');
      const keys = Reflect.ownKeys(candidate);
      if (keys.length > MAX_SNAPSHOT_OBJECT_KEYS) throw new TypeError('object exceeds key limit');
      const copyableKeys = keys.sort((left, right) => compareText(String(left), String(right)));
      const result: Record<string, unknown> = Object.create(null);
      for (const key of copyableKeys) {
        if (typeof key !== 'string') throw new TypeError('symbol keys are not supported');
        if (reservedDataKeys.has(key)) throw new TypeError('reserved keys are not supported');
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable)
          throw new TypeError('accessor and hidden properties are not supported');
        Object.defineProperty(result, key, {
          value: copy(descriptor.value, depth + 1),
          enumerable: true,
          configurable: false,
          writable: false
        });
      }
      return Object.freeze(result);
    } finally {
      active.delete(candidate);
    }
  };
  return copy(value, 0);
}
function snap<T>(value: T): T {
  return snapshotData(value) as T;
}
function normalizeErrorIssues(value: unknown): readonly ExtensionIssue[] {
  try {
    const snapshot = snapshotData(value);
    if (!Array.isArray(snapshot) || snapshot.length === 0)
      return Object.freeze([issue('invalid-manifest', [], 'validation failed')]);
    const normalized: ExtensionIssue[] = [];
    for (const candidate of snapshot.slice(0, MAX_EXTENSION_ISSUES)) {
      if (!isRecord(candidate))
        return Object.freeze([issue('invalid-manifest', [], 'validation failed')]);
      const code = candidate.code;
      const extensionIds = candidate.extensionIds;
      const message = candidate.message;
      if (
        typeof code !== 'string' ||
        typeof message !== 'string' ||
        !Array.isArray(extensionIds) ||
        !extensionIds.every((id) => typeof id === 'string')
      )
        return Object.freeze([issue('invalid-manifest', [], 'validation failed')]);
      normalized.push(
        issue(
          (
            [
              'conflict',
              'cycle',
              'duplicate-extension',
              'integrity-failed',
              'invalid-config',
              'invalid-manifest',
              'missing-dependency',
              'permission-denied',
              'trust-denied',
              'unsupported-version',
              'version-mismatch'
            ] as const
          ).includes(code as ExtensionIssueCode)
            ? (code as ExtensionIssueCode)
            : 'invalid-manifest',
          extensionIds,
          message
        )
      );
    }
    return Object.freeze(normalized);
  } catch {
    return Object.freeze([issue('invalid-manifest', [], 'validation failed')]);
  }
}
function isIssuedError(value: unknown): value is ExtensionValidationError {
  return typeof value === 'object' && value !== null && issuedErrors.has(value);
}
function issuedError(issues: unknown): ExtensionValidationError {
  const error = new ExtensionValidationError(issues);
  issuedErrors.add(error);
  return error;
}
function boundedIssues(issues: readonly ExtensionIssue[]): readonly ExtensionIssue[] {
  return issues.slice(0, MAX_EXTENSION_ISSUES);
}
function invalidAgentBridge(message: string): ExtensionValidationError {
  return issuedError([issue('invalid-manifest', [], message)]);
}
function bridgeDataDescriptors(
  value: unknown,
  allowed: readonly string[],
  message: string
): Readonly<Record<string, PropertyDescriptor>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw invalidAgentBridge(message);
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw invalidAgentBridge(message);
    const descriptors: Record<string, PropertyDescriptor> = Object.create(null);
    // Known host records are intentionally captured by named descriptor
    // reads. This bounds work to the schema even when a proxy reports a huge
    // own-key list; callers cannot make us enumerate arbitrary properties.
    for (const key of allowed) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined) {
        if (!('value' in descriptor) || !descriptor.enumerable)
          throw invalidAgentBridge(message);
        descriptors[key] = descriptor;
      }
    }
    return Object.freeze(descriptors);
  } catch (error) {
    if (isIssuedError(error)) throw error;
    throw invalidAgentBridge(message);
  }
}
function captureAgentRuntime(value: unknown): AgentProviderRuntime {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw invalidAgentBridge('Agent bridge runtime must be an object');
  const readMethod = (key: 'run' | 'runCleanup' | 'replaceGeneration' | 'recover') => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'function'
    )
      throw invalidAgentBridge(`Agent bridge runtime must expose ${key}`);
    return descriptor.value as (...arguments_: unknown[]) => unknown;
  };
  const run = readMethod('run');
  const runCleanup = readMethod('runCleanup');
  const replaceGeneration = readMethod('replaceGeneration');
  const recover = readMethod('recover');
  return Object.freeze({
    run: <T>(
      owner: object,
      effect: (context: AgentProviderCallContext) => T,
      options?: AgentProviderRuntimeCallOptions
    ) => Reflect.apply(run, value, [owner, effect, options]) as Promise<T>,
    runCleanup: <T>(
      owner: object,
      effect: (context: AgentProviderCallContext) => T,
      options?: AgentProviderRuntimeCallOptions
    ) => Reflect.apply(runCleanup, value, [owner, effect, options]) as Promise<T>,
    replaceGeneration: (owner: object) => {
      Reflect.apply(replaceGeneration, value, [owner]);
    },
    recover: (owner: object) => {
      Reflect.apply(recover, value, [owner]);
    }
  });
}
function captureAgentBridgeOptions(
  value: AgentExtensionBridgeOptions
): AgentExtensionBridgeOptions {
  const descriptors = bridgeDataDescriptors(
    value,
    ['runtime', 'timeoutMs'],
    'Agent bridge options must be a plain data object with known fields'
  );
  const runtime = descriptors.runtime?.value;
  if (runtime === undefined) throw invalidAgentBridge('Agent bridge options require a runtime');
  const timeoutMs = descriptors.timeoutMs?.value;
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > MAX_EXTENSION_AGENT_TIMEOUT_MS)
  )
    throw invalidAgentBridge('Agent bridge timeout is outside the supported range');
  return Object.freeze({
    runtime: captureAgentRuntime(runtime),
    ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number })
  });
}
function captureActivationPorts(value: unknown): {
  readonly emit: (event: ExtensionLifecycleEvent) => Promise<void> | void;
  readonly verify?: (manifest: ExtensionManifest) => Promise<boolean> | boolean;
} {
  const descriptors = bridgeDataDescriptors(
    value,
    ['integrity', 'emit'],
    'Extension activation ports must be a plain data object with known fields'
  );
  const emit = descriptors.emit;
  if (emit === undefined || !('value' in emit) || typeof emit.value !== 'function')
    throw invalidAgentBridge('an event host port is required');
  let verify: ((manifest: ExtensionManifest) => Promise<boolean> | boolean) | undefined;
  const integrity = descriptors.integrity?.value;
  if (integrity !== undefined) {
    const integrityDescriptors = bridgeDataDescriptors(
      integrity,
      ['verify'],
      'integrity host port must be a plain data object with verify'
    );
    const candidate = integrityDescriptors.verify;
    if (candidate === undefined || !('value' in candidate) || typeof candidate.value !== 'function')
      throw invalidAgentBridge('integrity host port must provide verify');
    verify = (manifest) =>
      Reflect.apply(candidate.value as (...arguments_: unknown[]) => unknown, integrity, [
        manifest
      ]) as Promise<boolean> | boolean;
  }
  return Object.freeze({
    emit: (event) =>
      Reflect.apply(emit.value as (...arguments_: unknown[]) => unknown, value, [
        event
      ]) as Promise<void> | void,
    ...(verify === undefined ? {} : { verify })
  });
}
function captureCallback(value: unknown, message: string): (...arguments_: unknown[]) => unknown {
  try {
    if (typeof value !== 'function' || Object.getPrototypeOf(value) !== Function.prototype)
      throw new TypeError(message);
    return value as (...arguments_: unknown[]) => unknown;
  } catch {
    throw invalidAgentBridge(message);
  }
}
function captureDesignLoader(value: unknown): (request: DesignInputRequest) => Promise<unknown> {
  const descriptors = bridgeDataDescriptors(
    value,
    ['load', 'resolveArtifacts', 'ingest'],
    'design input loader must be a plain object with known methods'
  );
  const resolve = descriptors.resolveArtifacts;
  if (resolve === undefined || !('value' in resolve))
    throw invalidAgentBridge('design input loader must provide resolveArtifacts');
  const method = captureCallback(resolve.value, 'design input resolver must be a data function');
  return (request) => Promise.resolve(Reflect.apply(method, value, [request]));
}
function isConfigurationValueType(value: unknown): value is ConfigurationValueType {
  return configurationValueTypes.includes(value as ConfigurationValueType);
}
function hasValidConfigurationSchema(schema: unknown): schema is ConfigurationPropertySchema {
  if (!isRecord(schema) || !isConfigurationValueType(schema.type)) return false;
  if (
    schema.enum !== undefined &&
    (!Array.isArray(schema.enum) ||
      schema.enum.some(
        (value) =>
          value !== null &&
          typeof value !== 'boolean' &&
          (typeof value !== 'number' || !Number.isFinite(value)) &&
          typeof value !== 'string'
      ))
  )
    return false;
  if (
    (schema.minimum !== undefined &&
      (typeof schema.minimum !== 'number' ||
        !Number.isFinite(schema.minimum) ||
        !['integer', 'number'].includes(schema.type))) ||
    (schema.items !== undefined &&
      (schema.type !== 'array' || !hasValidConfigurationSchema(schema.items))) ||
    (schema.properties !== undefined &&
      (schema.type !== 'object' ||
        !isRecord(schema.properties) ||
        !Object.values(schema.properties).every(hasValidConfigurationSchema))) ||
    (schema.required !== undefined &&
      (schema.type !== 'object' ||
        !Array.isArray(schema.required) ||
        !schema.required.every((key) => typeof key === 'string') ||
        new Set(schema.required).size !== schema.required.length)) ||
    (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean')
  )
    return false;
  // Do not accept caller-supplied regular expressions. They are difficult to
  // bound and can turn configuration validation into a ReDoS surface.
  if (Object.hasOwn(schema, 'pattern')) return false;
  return true;
}
function hasValidExtensionConfiguration(
  configuration: unknown
): configuration is ExtensionConfiguration {
  return (
    isRecord(configuration) &&
    (configuration.defaults === undefined || isRecord(configuration.defaults)) &&
    (configuration.required === undefined ||
      (Array.isArray(configuration.required) &&
        configuration.required.every((key) => typeof key === 'string'))) &&
    (configuration.additionalProperties === undefined ||
      typeof configuration.additionalProperties === 'boolean') &&
    (configuration.schema === undefined || hasValidConfigurationSchema(configuration.schema))
  );
}
function configurationTypeMatches(value: unknown, type: ConfigurationValueType): boolean {
  switch (type) {
    case 'array':
      return Array.isArray(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'null':
      return value === null;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'object':
      return isRecord(value);
    case 'string':
      return typeof value === 'string';
  }
}
function validateConfigurationValue(
  value: unknown,
  schema: ConfigurationPropertySchema,
  path: string
): string | undefined {
  if (!configurationTypeMatches(value, schema.type)) return `${path} must be ${schema.type}`;
  if (schema.enum !== undefined && !schema.enum.some((candidate) => candidate === value))
    return `${path} must be an allowed value`;
  if (schema.minimum !== undefined && (typeof value !== 'number' || value < schema.minimum))
    return `${path} is below its minimum`;
  if (schema.type === 'array' && schema.items !== undefined && Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const error = validateConfigurationValue(item, schema.items, `${path}[${index}]`);
      if (error !== undefined) return error;
    }
  }
  if (schema.type === 'object' && isRecord(value)) {
    const required = schema.required ?? [];
    if (required.some((key) => !(key in value))) return `${path} is missing required keys`;
    const properties = schema.properties ?? {};
    if (
      schema.additionalProperties !== true &&
      Object.keys(value).some((key) => !(key in properties))
    )
      return `${path} has unknown keys`;
    for (const [key, child] of Object.entries(properties)) {
      if (key in value) {
        const error = validateConfigurationValue(value[key], child, `${path}.${key}`);
        if (error !== undefined) return error;
      }
    }
  }
  return undefined;
}
function hasUniqueIds(values: readonly { readonly id: string }[]): boolean {
  return (
    new Set(values.map((value) => value.id)).size === values.length &&
    values.every((value) => idPattern.test(value.id))
  );
}
function sortIssues(issues: readonly ExtensionIssue[]): readonly ExtensionIssue[] {
  return [...issues].sort(
    (left, right) =>
      compareText(left.code, right.code) ||
      compareText(left.extensionIds.join(','), right.extensionIds.join(','))
  );
}
function asStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) &&
    value.length <= MAX_SNAPSHOT_ARRAY_ITEMS &&
    value.every((item) => typeof item === 'string' && item.length <= MAX_SNAPSHOT_STRING_LENGTH)
    ? value
    : undefined;
}
function asManifest(value: unknown): ExtensionManifest | ExtensionIssue {
  let data: Readonly<Record<string, unknown>>;
  try {
    const snapshot = snapshotData(value);
    if (!isRecord(snapshot))
      return issue('invalid-manifest', [], 'manifest must be a plain data object with an id');
    data = snapshot;
  } catch {
    return issue('invalid-manifest', [], 'manifest must be bounded plain JSON data');
  }
  if (typeof data.id !== 'string')
    return issue('invalid-manifest', [], 'manifest must be an object with an id');
  const version = data.manifestVersion;
  if (version !== '1.0' && version !== '0.9')
    return issue(
      'unsupported-version',
      [data.id],
      `unsupported manifest version: ${String(version)}`
    );
  const kind = version === '0.9' ? data.type : data.kind;
  const capabilities = asStringArray(data.capabilities);
  const declaredPermissions = asStringArray(data.permissions);
  if (
    typeof data.version !== 'string' ||
    typeof kind !== 'string' ||
    capabilities === undefined ||
    declaredPermissions === undefined ||
    !isRecord(data.trust) ||
    !isRecord(data.trust.provenance) ||
    !isRecord(data.trust.integrity)
  )
    return issue('invalid-manifest', [data.id], 'manifest has invalid required fields');
  return snap({
    ...(data as unknown as ExtensionManifest),
    manifestVersion: EXTENSION_MANIFEST_VERSION,
    kind: kind as ExtensionKind,
    capabilities,
    permissions: declaredPermissions as readonly Permission[]
  });
}
/** Migrates the supported v0.9 `type` field to v1 `kind` and rejects every other version. */
export function migrateExtensionManifest(value: unknown): ExtensionManifest {
  const manifest = asManifest(value);
  if (isExtensionIssue(manifest)) throw issuedError([manifest]);
  try {
    const issues = validateManifestShape(manifest);
    if (issues.length > 0) throw issuedError(issues);
    const migrated = { ...manifest } as ExtensionManifest & { type?: unknown };
    delete migrated.type;
    return snap(migrated);
  } catch (error) {
    if (isIssuedError(error)) throw error;
    throw issuedError([
      issue('invalid-manifest', [manifest.id], 'manifest contains an invalid value')
    ]);
  }
}
function validRange(range: unknown): boolean {
  const text = boundedText(range);
  if (text === undefined || text.length === 0) return false;
  const normalized = text.trim();
  if (normalized.length === 0 || normalized.length > MAX_SNAPSHOT_STRING_LENGTH) return false;
  return normalized.split(/\s+/).every((token) => rangeTokenPattern.test(token));
}
function normalizePolicy(value: unknown): ExtensionPolicy | ExtensionIssue {
  let policy: Readonly<Record<string, unknown>>;
  try {
    const snapshot = snapshotData(value);
    if (!isRecord(snapshot))
      return issue('invalid-manifest', [], 'policy must be a plain data object');
    policy = snapshot;
  } catch {
    return issue('invalid-manifest', [], 'policy must be bounded plain JSON data');
  }
  const allowedPermissions = asStringArray(policy.allowedPermissions);
  const minimumTrust = policy.minimumTrust;
  const requiredPublishers =
    policy.requiredPublishers === undefined ? undefined : asStringArray(policy.requiredPublishers);
  if (
    allowedPermissions === undefined ||
    !allowedPermissions.every((permission) => permissions.includes(permission as Permission)) ||
    new Set(allowedPermissions).size !== allowedPermissions.length ||
    typeof minimumTrust !== 'string' ||
    !Object.hasOwn(trustRank, minimumTrust) ||
    (policy.requiredPublishers !== undefined &&
      (requiredPublishers === undefined ||
        new Set(requiredPublishers).size !== requiredPublishers.length ||
        !requiredPublishers.every((publisher) => idPattern.test(publisher)))) ||
    (policy.requireIntegrity !== undefined && typeof policy.requireIntegrity !== 'boolean')
  )
    return issue('invalid-manifest', [], 'policy has invalid fields');
  return snap({
    allowedPermissions: allowedPermissions as readonly Permission[],
    minimumTrust: minimumTrust as TrustLevel,
    ...(requiredPublishers === undefined ? {} : { requiredPublishers }),
    ...(policy.requireIntegrity === undefined ? {} : { requireIntegrity: policy.requireIntegrity })
  });
}
function normalizeManifests(values: unknown): {
  readonly manifests: readonly ExtensionManifest[];
  readonly issues: readonly ExtensionIssue[];
} {
  let snapshot: unknown;
  try {
    snapshot = snapshotData(values);
  } catch {
    return {
      manifests: [],
      issues: [issue('invalid-manifest', [], 'manifests must be bounded data')]
    };
  }
  if (!Array.isArray(snapshot))
    return { manifests: [], issues: [issue('invalid-manifest', [], 'manifests must be an array')] };
  if (snapshot.length > MAX_EXTENSION_MANIFESTS)
    return {
      manifests: [],
      issues: [
        issue(
          'invalid-manifest',
          [],
          `at most ${MAX_EXTENSION_MANIFESTS} manifests may be planned at once`
        )
      ]
    };
  const manifests: ExtensionManifest[] = [];
  const issues: ExtensionIssue[] = [];
  for (const value of snapshot)
    try {
      manifests.push(migrateExtensionManifest(value));
    } catch (error) {
      if (isIssuedError(error)) issues.push(...error.issues);
      else issues.push(issue('invalid-manifest', [], 'manifest could not be normalized'));
    }
  return { manifests, issues: boundedIssues(issues) };
}
function validateManifestShape(manifest: ExtensionManifest): readonly ExtensionIssue[] {
  const issues: ExtensionIssue[] = [];
  if (manifest.manifestVersion !== EXTENSION_MANIFEST_VERSION)
    issues.push(issue('unsupported-version', [manifest.id], 'manifestVersion must be "1.0"'));
  if (!idPattern.test(manifest.id))
    issues.push(issue('invalid-manifest', [manifest.id], 'id is invalid'));
  if (parseVersion(manifest.version) === undefined)
    issues.push(issue('invalid-manifest', [manifest.id], 'version must be semantic versioning'));
  if (!extensionKinds.includes(manifest.kind))
    issues.push(issue('invalid-manifest', [manifest.id], 'kind is not supported'));
  if (
    new Set(manifest.capabilities).size !== manifest.capabilities.length ||
    !manifest.capabilities.every((value) => capabilityPattern.test(value))
  )
    issues.push(
      issue('invalid-manifest', [manifest.id], 'capabilities must be unique, valid identifiers')
    );
  if (
    new Set(manifest.permissions).size !== manifest.permissions.length ||
    !manifest.permissions.every((permission) => permissions.includes(permission))
  )
    issues.push(
      issue('invalid-manifest', [manifest.id], 'permissions must be unique and supported')
    );
  if (
    !Object.hasOwn(trustRank, manifest.trust.level) ||
    !idPattern.test(manifest.trust.provenance.publisher) ||
    manifest.trust.provenance.source.length === 0 ||
    !sriPattern.test(manifest.trust.integrity.sha256) ||
    manifest.trust.integrity.source.length === 0
  )
    issues.push(
      issue(
        'invalid-manifest',
        [manifest.id],
        'trust provenance and SHA-256 SRI integrity are required'
      )
    );
  const dependencies = manifest.dependencies ?? [];
  if (
    new Set(dependencies.map((dependency) => dependency.id)).size !== dependencies.length ||
    dependencies.some(
      (dependency) => !idPattern.test(dependency.id) || !validRange(dependency.range)
    )
  )
    issues.push(
      issue(
        'invalid-manifest',
        [manifest.id],
        'dependencies must have unique ids and supported semver ranges'
      )
    );
  if (
    new Set(manifest.conflicts ?? []).size !== (manifest.conflicts ?? []).length ||
    (manifest.conflicts ?? []).some((conflict) => !idPattern.test(conflict))
  )
    issues.push(issue('invalid-manifest', [manifest.id], 'conflicts must be unique extension ids'));
  if (
    manifest.configuration !== undefined &&
    !hasValidExtensionConfiguration(manifest.configuration)
  )
    issues.push(issue('invalid-manifest', [manifest.id], 'configuration schema is invalid'));
  const lifecycle = manifest.lifecycle ?? [];
  if (
    new Set(lifecycle.map((command) => command.id)).size !== lifecycle.length ||
    lifecycle.some(
      (command) =>
        !idPattern.test(command.id) ||
        !lifecycleEvents.includes(command.event) ||
        (command.capability !== undefined && !manifest.capabilities.includes(command.capability)) ||
        (command.input !== undefined && !isRecord(command.input))
    )
  )
    issues.push(
      issue(
        'invalid-manifest',
        [manifest.id],
        'lifecycle command ids must be unique and capabilities declared'
      )
    );
  const designSystem = manifest.contributes?.designSystem;
  if (
    designSystem !== undefined &&
    (!hasUniqueIds(designSystem.tokenCollections) ||
      !hasUniqueIds(designSystem.components) ||
      designSystem.tokenCollections.some(
        (collection) =>
          !hasUniqueIds(collection.modes) ||
          !hasUniqueIds(collection.tokens) ||
          collection.modes.some(
            (mode) =>
              !designModeKinds.includes(mode.kind) ||
              typeof mode.label !== 'string' ||
              mode.label.trim().length === 0
          ) ||
          collection.tokens.some(
            (token) =>
              !['boolean', 'number', 'string'].includes(typeof token.value) ||
              (token.modes !== undefined &&
                Object.keys(token.modes).some(
                  (mode) => !collection.modes.some((candidate) => candidate.id === mode)
                )) ||
              (token.aliases ?? []).some(
                (alias) =>
                  !idPattern.test(alias.target) ||
                  !collection.tokens.some((candidate) => candidate.id === alias.target)
              )
          )
      ) ||
      designSystem.components.some(
        (component) =>
          !hasUniqueIds(component.variants) ||
          !hasUniqueIds(component.slots) ||
          typeof component.exportName !== 'string' ||
          component.exportName.trim().length === 0 ||
          component.variants.some(
            (variant) =>
              variant.values.length === 0 ||
              new Set(variant.values).size !== variant.values.length ||
              variant.values.some((value) => typeof value !== 'string' || value.length === 0)
          )
      ))
  )
    issues.push(
      issue(
        'invalid-manifest',
        [manifest.id],
        'design-system contributions need unique ids, declared modes, aliases, variants, and slots'
      )
    );
  return issues;
}
function mergeConfiguration(
  manifest: ExtensionManifest,
  supplied: Readonly<Record<string, unknown>> | undefined
): Readonly<Record<string, unknown>> | ExtensionIssue {
  const configuration = manifest.configuration;
  if (configuration !== undefined && !hasValidExtensionConfiguration(configuration))
    return issue(
      'invalid-config',
      [manifest.id],
      `configuration schema is invalid for ${manifest.id}`
    );
  const result = { ...(configuration?.defaults ?? {}), ...(supplied ?? {}) };
  const required = configuration?.required ?? [];
  if (required.some((key) => !(key in result)))
    return issue(
      'invalid-config',
      [manifest.id],
      `configuration is missing required keys for ${manifest.id}`
    );
  const allowed = new Set([...Object.keys(configuration?.defaults ?? {}), ...required]);
  if (
    configuration?.schema === undefined &&
    configuration?.additionalProperties !== true &&
    Object.keys(result).some((key) => !allowed.has(key))
  )
    return issue(
      'invalid-config',
      [manifest.id],
      `configuration has unknown keys for ${manifest.id}`
    );
  if (configuration?.schema !== undefined) {
    const schema = configuration.schema;
    const schemaRequired = schema.required ?? [];
    if (schemaRequired.some((key) => !(key in result)))
      return issue(
        'invalid-config',
        [manifest.id],
        `configuration is missing schema-required keys for ${manifest.id}`
      );
    const properties = schema.properties ?? {};
    if (
      schema.additionalProperties !== true &&
      Object.keys(result).some((key) => !(key in properties))
    )
      return issue(
        'invalid-config',
        [manifest.id],
        `configuration has schema-unknown keys for ${manifest.id}`
      );
    for (const [key, schemaValue] of Object.entries(properties)) {
      if (key in result) {
        const error = validateConfigurationValue(result[key], schemaValue, `configuration.${key}`);
        if (error !== undefined) return issue('invalid-config', [manifest.id], error);
      }
    }
  }
  return snap(
    Object.fromEntries(Object.entries(result).sort(([left], [right]) => compareText(left, right)))
  );
}
function topologicalOrder(
  manifests: ReadonlyMap<string, ExtensionManifest>
): readonly string[] | ExtensionIssue {
  const state = new Map<string, 'visiting' | 'visited'>();
  const order: string[] = [];
  const visit = (id: string, path: readonly string[]): ExtensionIssue | undefined => {
    const status = state.get(id);
    if (status === 'visited') return undefined;
    if (status === 'visiting')
      return issue(
        'cycle',
        [...path, id],
        `extension dependency cycle: ${[...path, id].join(' -> ')}`
      );
    state.set(id, 'visiting');
    const manifest = manifests.get(id);
    for (const dependency of [...(manifest?.dependencies ?? [])].sort((left, right) =>
      compareText(left.id, right.id)
    ))
      if (manifests.has(dependency.id)) {
        const found = visit(dependency.id, [...path, id]);
        if (found !== undefined) return found;
      }
    state.set(id, 'visited');
    order.push(id);
    return undefined;
  };
  for (const id of [...manifests.keys()].sort(compareText)) {
    const found = visit(id, []);
    if (found !== undefined) return found;
  }
  return order;
}
/** Validates manifests, policy permissions/trust, dependencies/conflicts/cycles, and config without effects. */
export function validateExtensions(
  manifests: readonly ExtensionManifest[],
  policy: ExtensionPolicy,
  configurations: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {}
): readonly ExtensionIssue[] {
  const normalizedPolicy = normalizePolicy(policy);
  const normalizedManifests = normalizeManifests(manifests);
  const issues: ExtensionIssue[] = [...normalizedManifests.issues];
  if (isExtensionIssue(normalizedPolicy))
    return sortIssues(boundedIssues([...issues, normalizedPolicy]));
  const normalizedConfigurations = (() => {
    try {
      const snapshot = snapshotData(configurations);
      return isRecord(snapshot) ? snapshot : undefined;
    } catch {
      return undefined;
    }
  })();
  if (normalizedConfigurations === undefined)
    return sortIssues(
      boundedIssues([
        ...issues,
        issue('invalid-config', [], 'configurations must be bounded plain JSON data')
      ])
    );
  const byId = new Map<string, ExtensionManifest>();
  for (const manifest of normalizedManifests.manifests) {
    if (byId.has(manifest.id))
      issues.push(
        issue('duplicate-extension', [manifest.id], `duplicate extension: ${manifest.id}`)
      );
    byId.set(manifest.id, manifest);
    issues.push(...validateManifestShape(manifest));
    if (trustRank[manifest.trust.level] < trustRank[normalizedPolicy.minimumTrust])
      issues.push(
        issue('trust-denied', [manifest.id], `trust level is too low for ${manifest.id}`)
      );
    if (
      normalizedPolicy.requiredPublishers !== undefined &&
      !normalizedPolicy.requiredPublishers.includes(manifest.trust.provenance.publisher)
    )
      issues.push(
        issue('trust-denied', [manifest.id], `publisher is not permitted for ${manifest.id}`)
      );
    for (const permission of manifest.permissions)
      if (!normalizedPolicy.allowedPermissions.includes(permission))
        issues.push(
          issue(
            'permission-denied',
            [manifest.id],
            `permission ${permission} is not permitted for ${manifest.id}`
          )
        );
    const supplied = normalizedConfigurations[manifest.id];
    if (supplied !== undefined && !isRecord(supplied))
      issues.push(
        issue('invalid-config', [manifest.id], `configuration for ${manifest.id} must be an object`)
      );
    else {
      const configuration = mergeConfiguration(manifest, supplied);
      if (isExtensionIssue(configuration)) issues.push(configuration);
    }
  }
  for (const manifest of normalizedManifests.manifests) {
    for (const dependency of manifest.dependencies ?? []) {
      const actual = byId.get(dependency.id);
      if (actual === undefined) {
        if (!dependency.optional)
          issues.push(
            issue(
              'missing-dependency',
              [manifest.id, dependency.id],
              `${manifest.id} requires ${dependency.id}`
            )
          );
      } else if (!satisfiesSemver(actual.version, dependency.range))
        issues.push(
          issue(
            'version-mismatch',
            [manifest.id, dependency.id],
            `${manifest.id} requires ${dependency.id} ${dependency.range}, found ${actual.version}`
          )
        );
    }
    for (const conflict of manifest.conflicts ?? [])
      if (byId.has(conflict))
        issues.push(
          issue('conflict', [manifest.id, conflict], `${manifest.id} conflicts with ${conflict}`)
        );
  }
  const order = topologicalOrder(byId);
  if (isExtensionIssue(order)) issues.push(order);
  return sortIssues(boundedIssues(issues));
}
/** Builds a deterministic data-only lifecycle plan; invalid input fails closed. */
export function createExtensionPlan(
  manifests: readonly ExtensionManifest[],
  policy: ExtensionPolicy,
  configurations: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {}
): ExtensionPlan {
  const issues = validateExtensions(manifests, policy, configurations);
  if (issues.length > 0) throw issuedError(issues);
  const normalizedManifests = normalizeManifests(manifests);
  const normalizedPolicy = normalizePolicy(policy);
  if (isExtensionIssue(normalizedPolicy) || normalizedManifests.issues.length > 0)
    throw issuedError(
      boundedIssues([
        ...normalizedManifests.issues,
        ...(isExtensionIssue(normalizedPolicy) ? [normalizedPolicy] : [])
      ])
    );
  let normalizedConfigurations: Readonly<Record<string, unknown>>;
  try {
    const snapshot = snapshotData(configurations);
    if (!isRecord(snapshot)) throw new TypeError('configuration map is not an object');
    normalizedConfigurations = snapshot;
  } catch {
    throw issuedError([
      issue('invalid-config', [], 'configurations must be bounded plain JSON data')
    ]);
  }
  const byId = new Map(normalizedManifests.manifests.map((manifest) => [manifest.id, manifest]));
  const orderedIds = topologicalOrder(byId);
  if (isExtensionIssue(orderedIds)) throw issuedError([orderedIds]);
  const extensions = orderedIds.map((id) => {
    const manifest = byId.get(id);
    if (manifest === undefined) throw new Error(`missing planned extension ${id}`);
    const supplied = normalizedConfigurations[id];
    if (supplied !== undefined && !isRecord(supplied))
      throw issuedError([
        issue('invalid-config', [id], `configuration for ${id} must be an object`)
      ]);
    const configuration = mergeConfiguration(manifest, supplied);
    if (isExtensionIssue(configuration)) throw issuedError([configuration]);
    return { manifest, configuration };
  });
  const lifecycle = extensions.flatMap(({ manifest, configuration }) =>
    [...(manifest.lifecycle ?? [])]
      .sort((left, right) => compareText(left.id, right.id))
      .map((command) => ({
        extensionId: manifest.id,
        event: command.event,
        commandId: command.id,
        ...(command.capability === undefined ? {} : { capability: command.capability }),
        input: { ...configuration, ...(command.input ?? {}) }
      }))
  );
  if (lifecycle.length > MAX_EXTENSION_LIFECYCLE_EVENTS)
    throw issuedError([
      issue(
        'invalid-manifest',
        [],
        `at most ${MAX_EXTENSION_LIFECYCLE_EVENTS} lifecycle events may be planned at once`
      )
    ]);
  const plan = snap({ extensions, lifecycle }) as ExtensionPlan;
  extensionPlans.add(plan);
  planPolicies.set(plan, normalizedPolicy);
  planRecords.set(plan, Object.freeze({ plan, policy: normalizedPolicy }));
  return plan;
}
/** Verifies artifacts through a host port, then emits declarative lifecycle events in plan order. */
export async function activateExtensionPlan(
  plan: ExtensionPlan,
  policy: ExtensionPolicy,
  ports: ExtensionHostPorts
): Promise<void> {
  const record = typeof plan === 'object' && plan !== null ? planRecords.get(plan) : undefined;
  if (!extensionPlans.has(plan) || record === undefined)
    throw issuedError([
      issue('invalid-manifest', [], 'extension plan was not created by this kernel instance')
    ]);
  const normalizedPolicy = normalizePolicy(policy);
  if (isExtensionIssue(normalizedPolicy)) throw issuedError([normalizedPolicy]);
  const boundPolicy = planPolicies.get(plan);
  if (boundPolicy === undefined || !policiesEqual(boundPolicy, normalizedPolicy))
    throw issuedError([
      issue('permission-denied', [], 'activation policy must exactly match the plan policy')
    ]);
  const activationIssues = validateExtensions(
    record.plan.extensions.map((extension) => extension.manifest),
    normalizedPolicy,
    Object.fromEntries(
      record.plan.extensions.map((extension) => [extension.manifest.id, extension.configuration])
    )
  );
  if (activationIssues.length > 0) throw issuedError(activationIssues);
  let capturedPorts: ReturnType<typeof captureActivationPorts>;
  try {
    capturedPorts = captureActivationPorts(ports);
  } catch (error) {
    if (isIssuedError(error)) throw error;
    throw issuedError([issue('invalid-manifest', [], 'invalid activation ports')]);
  }
  if (normalizedPolicy.requireIntegrity !== false && capturedPorts.verify === undefined)
    throw issuedError([
      issue('integrity-failed', [], 'an integrity host port is required')
    ]);
  for (const extension of record.plan.extensions) {
    if (normalizedPolicy.requireIntegrity === false) continue;
    let verified: unknown;
    try {
      // Sequential verification bounds host concurrency and stops before any
      // lifecycle event can be emitted when an artifact fails integrity.
      // eslint-disable-next-line no-await-in-loop
      verified = await capturedPorts.verify?.(extension.manifest);
    } catch {
      throw issuedError([
        issue(
          'integrity-failed',
          [extension.manifest.id],
          `integrity verification failed for ${extension.manifest.id}`
        )
      ]);
    }
    if (verified !== true)
      throw issuedError([
        issue(
          'integrity-failed',
          [extension.manifest.id],
          `integrity verification failed for ${extension.manifest.id}`
        )
      ]);
  }
  for (const event of record.plan.lifecycle) {
    // Lifecycle order is part of the deterministic extension-host contract.
    // eslint-disable-next-line no-await-in-loop
    await capturedPorts.emit(event);
  }
}
/**
 * A concrete bridge to the existing provider-neutral agent SDK. It adds
 * deterministic capability guarding but does not spawn or otherwise host agents.
 */
export function createAgentExtensionBridge(
  adapter: AgentAdapter,
  options: AgentExtensionBridgeOptions
): AgentExtensionBridge {
  let validatedAdapter;
  let capturedOptions: AgentExtensionBridgeOptions;
  try {
    validatedAdapter = validateAdapter(adapter);
    capturedOptions = captureAgentBridgeOptions(options);
  } catch {
    throw invalidAgentBridge('agent adapter and runtime must be safe host ports');
  }
  const capabilities = Object.freeze(uniqueSorted(validatedAdapter.capabilities));
  return Object.freeze({
    capabilities: Object.freeze([...capabilities]),
    supports: (capability: AgentCapability) => capabilities.includes(capability),
    stream: (execution: AgentExecution) => {
      let safeExecution: AgentExecution;
      try {
        safeExecution = validateExecution(execution);
      } catch {
        throw invalidAgentBridge('agent execution must be bounded plain data');
      }
      if (!capabilities.includes(safeExecution.capability))
        throw invalidAgentBridge(
          `agent adapter does not declare capability ${safeExecution.capability}`
        );
      return (async function* boundedStream(): AsyncIterable<EventEnvelope> {
        let count = 0;
        let bytes = 0;
        let values = 0;
        try {
          for await (const event of streamValidatedEvents(
            validatedAdapter,
            safeExecution,
            capturedOptions
          )) {
            if (count >= MAX_EXTENSION_LIFECYCLE_EVENTS)
              throw invalidAgentBridge('agent stream exceeded its event limit');
            const serialized = JSON.stringify(event);
            if (serialized.length > MAX_EXTENSION_STREAM_BYTES)
              throw invalidAgentBridge('agent stream event exceeds its byte limit');
            const eventBytes = new TextEncoder().encode(serialized).length;
            bytes += eventBytes;
            values += 1;
            if (bytes > MAX_EXTENSION_STREAM_BYTES || values > MAX_EXTENSION_STREAM_VALUES)
              throw invalidAgentBridge('agent stream exceeded its aggregate budget');
            count += 1;
            yield snap(event) as EventEnvelope;
          }
        } catch (error) {
          if (isIssuedError(error)) throw error;
          throw invalidAgentBridge('agent adapter yielded an invalid event');
        }
      })();
    }
  });
}
/**
 * A concrete bridge to the existing design-input port. A host supplies the
 * context decoder (normally its approved ingest adapter), keeping crypto and
 * artifact interpretation outside this data-only kernel.
 */
export function createDesignInputExtensionBridge(
  loader: DesignInputLoader,
  toContext: (
    request: DesignInputRequest,
    packageArtifact: ResolvedDesignPackage,
    designLanguageArtifact: ResolvedDesignLanguage
  ) => DesignContext
): DesignInputExtensionBridge {
  let resolveArtifacts: (request: DesignInputRequest) => Promise<unknown>;
  let contextDecoder: (...arguments_: unknown[]) => unknown;
  try {
    resolveArtifacts = captureDesignLoader(loader);
    contextDecoder = captureCallback(toContext, 'design context decoder must be a data function');
  } catch {
    throw issuedError([
      issue(
        'invalid-manifest',
        [],
        'design input host port must provide safe resolvers and decoder'
      )
    ]);
  }
  const normalizeRequest = (request: DesignInputRequest): DesignInputRequest => {
    try {
      const snapshot = snapshotData(request);
      if (!isRecord(snapshot) || !isRecord(snapshot.package) || !isRecord(snapshot.designLanguage))
        throw new TypeError('request shape');
      const packageName = snapshot.package.name;
      const packageVersion = snapshot.package.version;
      const location = snapshot.designLanguage.location;
      if (
        typeof packageName !== 'string' ||
        !idPattern.test(packageName.replace('@', '').replace('/', '.')) ||
        parseVersion(packageVersion as string) === undefined ||
        typeof location !== 'string' ||
        location.length === 0
      )
        throw new TypeError('request fields');
      return snapshot as unknown as DesignInputRequest;
    } catch {
      throw issuedError([
        issue('invalid-manifest', [], 'design input request must be bounded plain data')
      ]);
    }
  };
  const normalizeArtifacts = (
    packageArtifact: ResolvedDesignPackage,
    designLanguageArtifact: ResolvedDesignLanguage
  ): ResolvedDesignInputArtifacts => {
    try {
      const packageSnapshot = snapshotData(packageArtifact);
      const languageSnapshot = snapshotData(designLanguageArtifact);
      if (
        !isRecord(packageSnapshot) ||
        !Array.isArray(packageSnapshot.files) ||
        !isRecord(packageSnapshot.provenance) ||
        !isRecord(languageSnapshot) ||
        !isRecord(languageSnapshot.provenance) ||
        typeof languageSnapshot.markdown !== 'string' ||
        typeof packageSnapshot.provenance.provider !== 'string' ||
        packageSnapshot.provenance.provider.length === 0 ||
        typeof packageSnapshot.provenance.location !== 'string' ||
        packageSnapshot.provenance.location.length === 0 ||
        typeof languageSnapshot.provenance.provider !== 'string' ||
        languageSnapshot.provenance.provider.length === 0 ||
        typeof languageSnapshot.provenance.location !== 'string' ||
        languageSnapshot.provenance.location.length === 0 ||
        !packageSnapshot.files.every(
          (file) =>
            isRecord(file) && typeof file.path === 'string' && typeof file.content === 'string'
        )
      )
        throw new TypeError('artifact shape');
      return {
        packageArtifact: packageSnapshot as unknown as ResolvedDesignPackage,
        designLanguageArtifact: languageSnapshot as unknown as ResolvedDesignLanguage
      };
    } catch {
      throw issuedError([
        issue('invalid-manifest', [], 'design input host returned invalid artifacts')
      ]);
    }
  };
  const artifactRequests = new WeakMap<object, DesignInputRequest>();
  return Object.freeze({
    async resolve(request: DesignInputRequest): Promise<ResolvedDesignInputArtifacts> {
      const safeRequest = normalizeRequest(request);
      try {
        const resolved = await resolveArtifacts(safeRequest);
        const resolvedSnapshot = snapshotData(resolved);
        if (!isRecord(resolvedSnapshot)) throw new TypeError('resolved artifacts shape');
        const artifacts = Object.freeze(
          normalizeArtifacts(
            resolvedSnapshot.packageArtifact as ResolvedDesignPackage,
            resolvedSnapshot.designLanguageArtifact as ResolvedDesignLanguage
          )
        );
        artifactRequests.set(
          artifacts,
          normalizeRequest(resolvedSnapshot.request as DesignInputRequest)
        );
        return artifacts;
      } catch {
        throw issuedError([
          issue('invalid-manifest', [], 'design input host returned invalid artifacts')
        ]);
      }
    },
    toContext(
      _request: DesignInputRequest,
      artifacts: ResolvedDesignInputArtifacts
    ): DesignContext {
      const safeRequest = artifactRequests.get(artifacts);
      if (safeRequest === undefined)
        throw issuedError([
          issue('invalid-manifest', [], 'design input artifacts were not resolved by this bridge')
        ]);
      const safeArtifacts = normalizeArtifacts(
        artifacts.packageArtifact,
        artifacts.designLanguageArtifact
      );
      try {
        const context = snapshotData(
          Reflect.apply(contextDecoder, undefined, [
            safeRequest,
            safeArtifacts.packageArtifact,
            safeArtifacts.designLanguageArtifact
          ])
        );
        if (
          !isRecord(context) ||
          context.format !== 'selene-design-context/v1' ||
          !isRecord(context.library) ||
          !isRecord(context.language) ||
          !Array.isArray(context.records) ||
          typeof context.sha256 !== 'string'
        )
          throw new TypeError('context shape');
        return context as unknown as DesignContext;
      } catch {
        throw issuedError([
          issue('invalid-manifest', [], 'design context decoder returned invalid data')
        ]);
      }
    }
  });
}
export function agentCapability(capability: unknown): AgentCapability {
  const text = boundedText(capability, 128);
  if (text === undefined || !capabilityPattern.test(text))
    throw issuedError([issue('invalid-manifest', [], 'invalid agent capability')]);
  return text;
}
