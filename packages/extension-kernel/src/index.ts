/**
 * A deterministic, data-only extension planner. All effects are host ports;
 * this package has no runtime imports, process, filesystem, or network access.
 */
import { streamValidatedEvents, validateAdapter, validateExecution } from '@selene/agent-sdk';
import type {
  AgentAdapter,
  AgentCapability,
  AgentProviderCallContext,
  AgentExecution,
  AgentProviderRuntimeCallOptions,
  AgentProviderRuntime,
  EventEnvelope
} from '@selene/agent-sdk';
import {
  type DesignContext,
  type DesignInputLoader,
  type DesignInputPort,
  type DesignInputRequest,
  type ResolvedDesignLanguage,
  type ResolvedDesignPackage
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
  readonly pattern?: string;
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
  public constructor(public readonly issues: readonly ExtensionIssue[]) {
    super(issues.map((entry) => entry.message).join('\n'));
    this.name = 'ExtensionValidationError';
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

/** Host-owned provider runtime port; the data-only kernel never constructs effects itself. */
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

interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease?: string;
}
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareText);
}
function parseVersion(value: string): Semver | undefined {
  const match = versionPattern.exec(value);
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
export function satisfiesSemver(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  if (parsed === undefined || range.trim().length === 0) return false;
  return range
    .trim()
    .split(/\s+/)
    .every((token) => {
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
  return { code, extensionIds: uniqueSorted(extensionIds), message };
}
function isExtensionIssue(value: unknown): value is ExtensionIssue {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'extensionIds' in value &&
    'message' in value
  );
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidAgentBridge(message: string): ExtensionValidationError {
  return new ExtensionValidationError([issue('invalid-manifest', [], message)]);
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
    const keys = Reflect.ownKeys(value);
    if (
      keys.length > allowed.length ||
      keys.some((key) => typeof key !== 'string' || !allowed.includes(key))
    )
      throw invalidAgentBridge(message);
    const descriptors: Record<string, PropertyDescriptor> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string') throw invalidAgentBridge(message);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) throw invalidAgentBridge(message);
      descriptors[key] = descriptor;
    }
    return Object.freeze(descriptors);
  } catch (error) {
    if (error instanceof ExtensionValidationError) throw error;
    throw invalidAgentBridge(message);
  }
}

function captureAgentRuntime(value: unknown): AgentProviderRuntime {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw invalidAgentBridge('Agent bridge runtime must be an object');
  const target = value;
  const readMethod = (key: 'run' | 'runCleanup' | 'replaceGeneration' | 'recover') => {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(target, key);
    } catch {
      throw invalidAgentBridge('Agent bridge runtime cannot be inspected safely');
    }
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
  const captured: AgentProviderRuntime = {
    run: <T>(
      owner: object,
      effect: (context: AgentProviderCallContext) => T,
      options?: AgentProviderRuntimeCallOptions
    ): Promise<T> => Reflect.apply(run, target, [owner, effect, options]) as Promise<T>,
    runCleanup: <T>(
      owner: object,
      effect: (context: AgentProviderCallContext) => T,
      options?: AgentProviderRuntimeCallOptions
    ): Promise<T> => Reflect.apply(runCleanup, target, [owner, effect, options]) as Promise<T>,
    replaceGeneration: (owner: object): void => {
      Reflect.apply(replaceGeneration, target, [owner]);
    },
    recover: (owner: object): void => {
      Reflect.apply(recover, target, [owner]);
    }
  };
  return Object.freeze(captured);
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
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0))
    throw invalidAgentBridge('Agent bridge timeout is outside the supported range');
  return Object.freeze({
    runtime: captureAgentRuntime(runtime),
    ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number })
  });
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
          typeof value !== 'number' &&
          typeof value !== 'string'
      ))
  )
    return false;
  if (
    (schema.pattern !== undefined &&
      (typeof schema.pattern !== 'string' || schema.type !== 'string')) ||
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
        !schema.required.every((key) => typeof key === 'string'))) ||
    (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean')
  )
    return false;
  if (typeof schema.pattern === 'string')
    try {
      RegExp(schema.pattern);
    } catch {
      return false;
    }
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
  if (
    schema.pattern !== undefined &&
    (typeof value !== 'string' || !new RegExp(schema.pattern).test(value))
  )
    return `${path} does not match its pattern`;
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
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}
function asManifest(value: unknown): ExtensionManifest | ExtensionIssue {
  if (!isRecord(value) || typeof value.id !== 'string')
    return issue('invalid-manifest', [], 'manifest must be an object with an id');
  const version = value.manifestVersion;
  if (version !== '1.0' && version !== '0.9')
    return issue(
      'unsupported-version',
      [value.id],
      `unsupported manifest version: ${String(version)}`
    );
  const kind = version === '0.9' ? value.type : value.kind;
  const capabilities = asStringArray(value.capabilities);
  const declaredPermissions = asStringArray(value.permissions);
  if (
    typeof value.version !== 'string' ||
    typeof kind !== 'string' ||
    capabilities === undefined ||
    declaredPermissions === undefined ||
    !isRecord(value.trust) ||
    !isRecord(value.trust.provenance) ||
    !isRecord(value.trust.integrity)
  )
    return issue('invalid-manifest', [value.id], 'manifest has invalid required fields');
  return {
    ...(value as unknown as ExtensionManifest),
    manifestVersion: EXTENSION_MANIFEST_VERSION,
    kind: kind as ExtensionKind,
    capabilities,
    permissions: declaredPermissions as readonly Permission[]
  };
}
/** Migrates the supported v0.9 `type` field to v1 `kind` and rejects every other version. */
export function migrateExtensionManifest(value: unknown): ExtensionManifest {
  const manifest = asManifest(value);
  if (isExtensionIssue(manifest)) throw new ExtensionValidationError([manifest]);
  try {
    const issues = validateManifestShape(manifest);
    if (issues.length > 0) throw new ExtensionValidationError(issues);
    const migrated = { ...manifest } as ExtensionManifest & { type?: unknown };
    delete migrated.type;
    return migrated;
  } catch (error) {
    if (error instanceof ExtensionValidationError) throw error;
    throw new ExtensionValidationError([
      issue('invalid-manifest', [manifest.id], 'manifest contains an invalid value')
    ]);
  }
}
function validRange(range: string): boolean {
  return range
    .trim()
    .split(/\s+/)
    .every((token) => rangeTokenPattern.test(token));
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
        (command.capability !== undefined && !manifest.capabilities.includes(command.capability))
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
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => compareText(left, right))
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
  const issues: ExtensionIssue[] = [];
  const byId = new Map<string, ExtensionManifest>();
  for (const manifest of manifests) {
    if (byId.has(manifest.id))
      issues.push(
        issue('duplicate-extension', [manifest.id], `duplicate extension: ${manifest.id}`)
      );
    byId.set(manifest.id, manifest);
    issues.push(...validateManifestShape(manifest));
    if (trustRank[manifest.trust.level] < trustRank[policy.minimumTrust])
      issues.push(
        issue('trust-denied', [manifest.id], `trust level is too low for ${manifest.id}`)
      );
    if (
      policy.requiredPublishers !== undefined &&
      !policy.requiredPublishers.includes(manifest.trust.provenance.publisher)
    )
      issues.push(
        issue('trust-denied', [manifest.id], `publisher is not permitted for ${manifest.id}`)
      );
    for (const permission of manifest.permissions)
      if (!policy.allowedPermissions.includes(permission))
        issues.push(
          issue(
            'permission-denied',
            [manifest.id],
            `permission ${permission} is not permitted for ${manifest.id}`
          )
        );
    const configuration = mergeConfiguration(manifest, configurations[manifest.id]);
    if (isExtensionIssue(configuration)) issues.push(configuration);
  }
  for (const manifest of manifests) {
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
  return sortIssues(issues);
}
/** Builds a deterministic data-only lifecycle plan; invalid input fails closed. */
export function createExtensionPlan(
  manifests: readonly ExtensionManifest[],
  policy: ExtensionPolicy,
  configurations: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {}
): ExtensionPlan {
  const issues = validateExtensions(manifests, policy, configurations);
  if (issues.length > 0) throw new ExtensionValidationError(issues);
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  const orderedIds = topologicalOrder(byId);
  if (isExtensionIssue(orderedIds)) throw new ExtensionValidationError([orderedIds]);
  const extensions = orderedIds.map((id) => {
    const manifest = byId.get(id);
    if (manifest === undefined) throw new Error(`missing planned extension ${id}`);
    const configuration = mergeConfiguration(manifest, configurations[id]);
    if (isExtensionIssue(configuration)) throw new ExtensionValidationError([configuration]);
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
  return { extensions, lifecycle };
}
/** Verifies artifacts through a host port, then emits declarative lifecycle events in plan order. */
export async function activateExtensionPlan(
  plan: ExtensionPlan,
  policy: ExtensionPolicy,
  ports: ExtensionHostPorts
): Promise<void> {
  if (policy.requireIntegrity !== false && ports.integrity === undefined)
    throw new ExtensionValidationError([
      issue('integrity-failed', [], 'an integrity host port is required')
    ]);
  const integrityResults = await Promise.all(
    plan.extensions.map(async (extension) => ({
      extension,
      verified:
        policy.requireIntegrity === false || (await ports.integrity?.verify(extension.manifest))
    }))
  );
  for (const { extension, verified } of integrityResults)
    if (!verified)
      throw new ExtensionValidationError([
        issue(
          'integrity-failed',
          [extension.manifest.id],
          `integrity verification failed for ${extension.manifest.id}`
        )
      ]);
  for (const event of plan.lifecycle) {
    // Lifecycle order is part of the deterministic extension-host contract.
    // eslint-disable-next-line no-await-in-loop
    await ports.emit(event);
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
  const validatedAdapter = validateAdapter(adapter);
  const capturedOptions = captureAgentBridgeOptions(options);
  const capabilities = Object.freeze(uniqueSorted(validatedAdapter.capabilities));
  return Object.freeze({
    capabilities: Object.freeze([...capabilities]),
    supports: (capability: AgentCapability) => capabilities.includes(capability),
    stream: (execution: AgentExecution) => {
      const capturedExecution = validateExecution(execution);
      if (!capabilities.includes(capturedExecution.capability))
        throw new ExtensionValidationError([
          issue(
            'invalid-manifest',
            [],
            `agent adapter does not declare capability ${capturedExecution.capability}`
          )
        ]);
      return streamValidatedEvents(validatedAdapter, capturedExecution, capturedOptions);
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
  const artifactRequests = new WeakMap<object, DesignInputRequest>();
  return {
    async resolve(request) {
      const resolved = await loader.resolveArtifacts(request);
      const artifacts = Object.freeze({
        packageArtifact: resolved.packageArtifact,
        designLanguageArtifact: resolved.designLanguageArtifact
      });
      artifactRequests.set(artifacts, resolved.request);
      return artifacts;
    },
    toContext(_request, artifacts) {
      const safeRequest = artifactRequests.get(artifacts);
      if (safeRequest === undefined)
        throw new ExtensionValidationError([
          issue('invalid-manifest', [], 'design input artifacts were not resolved by this bridge')
        ]);
      return toContext(safeRequest, artifacts.packageArtifact, artifacts.designLanguageArtifact);
    }
  };
}
export function agentCapability(capability: AgentCapability): AgentCapability {
  if (!capabilityPattern.test(capability))
    throw new ExtensionValidationError([issue('invalid-manifest', [], 'invalid agent capability')]);
  return capability;
}
