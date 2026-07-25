export const designInputsPackageName = '@selene/design-inputs';

export interface DesignPackageRequest {
  readonly name: string;
  readonly version: string;
  readonly expectedSha256?: string;
}

export interface DesignLanguageRequest {
  /** An adapter-defined opaque identifier. It is never used as a filesystem path. */
  readonly location: string;
  readonly expectedSha256?: string;
}

export interface DesignInputRequest {
  readonly package: DesignPackageRequest;
  readonly designLanguage: DesignLanguageRequest;
  readonly requiredPeerDependencies?: Readonly<Record<string, string>>;
}

/** Package-only host inspection intentionally has no independent design-language request. */
export interface DesignPackageInspectionRequest {
  readonly package: DesignPackageRequest;
  readonly requiredPeerDependencies?: Readonly<Record<string, string>>;
}

export interface InputProvenance {
  readonly provider: string;
  readonly location: string;
  readonly retrievedAt?: string;
}

export interface PackageFile {
  readonly path: string;
  readonly content: string;
}

/**
 * Adapters return a bounded data array. Executable iterators are intentionally
 * excluded so no adapter code can run after supervised host resolution.
 */
export type PackageFiles = readonly PackageFile[];

export interface ResolvedDesignPackage {
  readonly packageJson: unknown;
  readonly files: PackageFiles;
  readonly provenance: InputProvenance;
}

export interface ResolvedDesignLanguage {
  readonly markdown: string;
  readonly provenance: InputProvenance;
}

/** Minimal, package-owned view of a supervisor-owned cancellation surface. */
export interface DesignInputCallCancellation {
  isCancellationRequested(): boolean;
  reason(): 'caller-aborted' | 'deadline-exceeded' | undefined;
  subscribe(listener: (reason: 'caller-aborted' | 'deadline-exceeded') => void): () => void;
}

/**
 * Minimal structural context supplied to each host effect. This package owns
 * the public contract; the concrete host-runtime context remains private.
 */
export interface DesignInputCallContext {
  readonly ownerGeneration: number;
  /** Duration remaining when the host call began; absolute host time is private. */
  readonly remainingMs?: number;
  readonly cancellation: DesignInputCallCancellation;
}

export type DesignInputEffectMethod = 'resolvePackage' | 'readDesignLanguage' | 'sha256';
export type DesignInputRuntimeOutcome<T> =
  | Readonly<{ status: 'ok'; value: T }>
  | Readonly<{ status: 'deadline-exceeded' }>
  | Readonly<{ status: 'effect-failed' }>;

/**
 * Narrow trusted-host supervision port. It owns context creation, timeout,
 * cancellation, and admission; this portable package only requests effects.
 */
export interface DesignInputRuntime {
  run<T>(
    owner: object,
    method: DesignInputEffectMethod,
    arguments_: readonly unknown[],
    options: Readonly<{ timeoutMs: number }>
  ): Promise<DesignInputRuntimeOutcome<T>>;
}

/** Host-owned integrity primitive. It is only content addressing, never package execution. */
export interface DesignInputIntegrityPort {
  sha256(context: DesignInputCallContext, value: string): Promise<string>;
}

/**
 * The sole effect boundary. Every call receives a supervisor-owned context,
 * must return data only, and must never install or import package content.
 */
export interface DesignInputPort extends DesignInputIntegrityPort {
  resolvePackage(
    context: DesignInputCallContext,
    request: DesignPackageRequest
  ): Promise<ResolvedDesignPackage>;
  readDesignLanguage(
    context: DesignInputCallContext,
    request: DesignLanguageRequest
  ): Promise<ResolvedDesignLanguage>;
}

/** Explicit aggregate limits for all untrusted requests, artifacts, and host work. */
export interface DesignInputLimits {
  readonly maxRequestBytes: number;
  readonly maxManifestBytes: number;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxArtifactBytes: number;
  readonly maxMarkdownBytes: number;
  readonly maxMarkdownLines: number;
  readonly maxSections: number;
  readonly maxJsonDepth: number;
  readonly maxJsonNodes: number;
  readonly maxStringBytes: number;
  readonly maxTokenFiles: number;
  readonly maxTokenNodes: number;
  readonly maxFrontmatterBytes: number;
  readonly maxFrontmatterEntries: number;
  readonly maxMarkdownTokens: number;
  readonly maxMarkdownSectionBytes: number;
  readonly maxMarkdownImports: number;
  readonly maxIntegrityConcurrency: number;
  readonly portTimeoutMs: number;
}

export const DEFAULT_DESIGN_INPUT_LIMITS: Readonly<DesignInputLimits> = Object.freeze({
  maxRequestBytes: 16 * 1024,
  maxManifestBytes: 256 * 1024,
  maxFiles: 128,
  maxFileBytes: 512 * 1024,
  maxArtifactBytes: 2 * 1024 * 1024,
  maxMarkdownBytes: 256 * 1024,
  maxMarkdownLines: 8_192,
  maxSections: 512,
  maxJsonDepth: 32,
  maxJsonNodes: 16_384,
  maxStringBytes: 16 * 1024,
  maxTokenFiles: 128,
  maxTokenNodes: 16_384,
  maxFrontmatterBytes: 16 * 1024,
  maxFrontmatterEntries: 64,
  maxMarkdownTokens: 32_768,
  maxMarkdownSectionBytes: 64 * 1024,
  maxMarkdownImports: 0,
  maxIntegrityConcurrency: 4,
  portTimeoutMs: 5_000
});

export type DesignInputIssueCode =
  | 'budget-exceeded'
  | 'incompatible-input'
  | 'integrity-failed'
  | 'malformed-markdown'
  | 'malformed-package'
  | 'missing-input'
  | 'port-failed'
  | 'port-timeout'
  | 'unsafe-input';

export interface DesignInputIssue {
  readonly code: DesignInputIssueCode;
  /** A fixed redacted message: never reflects provider, path, artifact, or thrown host text. */
  readonly message: string;
}

export class DesignInputValidationError extends Error {
  public constructor(issues: readonly DesignInputIssue[]) {
    super('Design input validation failed');
    this.name = 'DesignInputValidationError';
    this.issues = freeze(issues.map((issue) => ({ ...issue })));
  }

  public readonly issues: readonly DesignInputIssue[];
}

export interface DesignComponentMetadata {
  readonly name: string;
  readonly exportName: string;
  readonly entrypoint: string;
}

export interface DesignSystemMetadata {
  readonly schemaVersion: '1';
  readonly tokenFiles: readonly string[];
  readonly components: readonly DesignComponentMetadata[];
  readonly designLanguagePath: string;
}

export interface DesignLibrary {
  readonly name: string;
  readonly version: string;
  readonly peerDependencies: Readonly<Record<string, string>>;
  readonly exports: Readonly<Record<string, readonly string[]>>;
  readonly selene: DesignSystemMetadata;
}

export interface MarkdownSection {
  readonly heading: string;
  readonly level: number;
  readonly body: string;
}

export interface DesignLanguage {
  readonly sections: readonly MarkdownSection[];
}

export interface DesignInputRecord {
  readonly kind: 'design-language' | 'package-file' | 'package-metadata';
  readonly location: string;
  readonly sha256: string;
  readonly provenance: InputProvenance;
}

export interface DesignContext {
  readonly format: 'selene-design-context/v1';
  readonly library: DesignLibrary;
  readonly language: DesignLanguage;
  readonly records: readonly DesignInputRecord[];
  readonly sha256: string;
}

/** Supervised raw host artifacts for integrations that own their own decoding step. */
export interface ResolvedDesignInputArtifacts {
  /** The validated immutable request used for both host resolution and decoding. */
  readonly request: DesignInputRequest;
  readonly packageArtifact: ResolvedDesignPackage;
  readonly designLanguageArtifact: ResolvedDesignLanguage;
}

export interface DesignInputLoaderOptions {
  readonly port: DesignInputPort;
  readonly runtime: DesignInputRuntime;
}

export interface DesignInputLoader {
  load(request: DesignInputRequest, overrides?: Partial<DesignInputLimits>): Promise<DesignContext>;
  resolveArtifacts(
    request: DesignInputRequest,
    overrides?: Partial<DesignInputLimits>
  ): Promise<ResolvedDesignInputArtifacts>;
  ingest(
    request: DesignInputRequest,
    packageArtifact: ResolvedDesignPackage,
    languageArtifact: ResolvedDesignLanguage,
    overrides?: Partial<DesignInputLimits>
  ): Promise<DesignContext>;
}

/** Optional extension for trusted hosts that need package validation without a language effect. */
export interface DesignPackageInspector {
  inspectPackage(
    request: DesignPackageInspectionRequest,
    overrides?: Partial<DesignInputLimits>
  ): Promise<ResolvedDesignPackage>;
}

export interface DesignInputLoaderWithPackageInspection
  extends DesignInputLoader, DesignPackageInspector {}

interface ParsedPackage {
  readonly library: DesignLibrary;
  readonly filesByPath: ReadonlyMap<string, PackageFile>;
  readonly fileHashesByPath: ReadonlyMap<string, string>;
  readonly metadataHash: string;
  readonly artifactBytes: number;
  readonly provenance: InputProvenance;
}

class Failure extends Error {
  public constructor(readonly code: DesignInputIssueCode) {
    super(code);
  }
}

const packageNamePattern =
  /^(?:@[a-z0-9][a-z0-9._-]{0,127}\/[a-z0-9][a-z0-9._-]{0,127}|[a-z0-9][a-z0-9._-]{0,127})$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const provenanceProviderPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const segmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;
const semverRangePattern =
  /^(?:\^|~|>=)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z.-]+)?$/;
const forbiddenPackageKeys = new Set([
  'bin',
  'browser',
  'config',
  'imports',
  'main',
  'module',
  'scripts',
  'typesVersions',
  'workspaces'
]);
const issueMessages: Readonly<Record<DesignInputIssueCode, string>> = Object.freeze({
  'budget-exceeded': 'Design input exceeds a configured aggregate budget.',
  'incompatible-input': 'Design input does not satisfy the requested compatibility contract.',
  'integrity-failed': 'Design input integrity verification failed.',
  'malformed-markdown': 'Design language markdown is malformed.',
  'malformed-package': 'Design package metadata is malformed.',
  'missing-input': 'A required design input artifact is missing.',
  'port-failed': 'The design input host failed without exposing provider details.',
  'port-timeout': 'The design input host exceeded its bounded response time.',
  'unsafe-input': 'Design input contains unsafe or executable content.'
});

function fail(code: DesignInputIssueCode): never {
  throw new Failure(code);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Reads only own data properties and rejects accessor objects before interpreting them. */
function dataEntries(value: unknown, code: DesignInputIssueCode): readonly [string, unknown][] {
  try {
    if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) fail(code);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const entries: [string, unknown][] = [];
    for (const key of Object.keys(descriptors).sort(compareText)) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !('value' in descriptor) || key.length > 256) fail(code);
      entries.push([key, descriptor.value]);
    }
    return entries;
  } catch (error) {
    if (error instanceof Failure) throw error;
    fail(code);
  }
}

function dataObject(value: unknown, code: DesignInputIssueCode): Readonly<Record<string, unknown>> {
  return Object.fromEntries(dataEntries(value, code));
}

/** Snapshots an ordinary dense array without invoking element getters. */
function dataArray(value: unknown, code: DesignInputIssueCode): readonly unknown[] {
  try {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0
    )
      fail(code);
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      string,
      PropertyDescriptor
    >;
    const lengthDescriptor = descriptors['length'];
    if (
      lengthDescriptor === undefined ||
      !('value' in lengthDescriptor) ||
      typeof lengthDescriptor.value !== 'number' ||
      !Number.isSafeInteger(lengthDescriptor.value)
    )
      fail(code);
    const length = lengthDescriptor.value;
    const values: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      const descriptor = descriptors[key];
      if (descriptor === undefined || !('value' in descriptor)) fail(code);
      values.push(descriptor.value);
    }
    if (Object.keys(descriptors).some((key) => key !== 'length' && !/^(?:0|[1-9]\d*)$/.test(key)))
      fail(code);
    return values;
  } catch (error) {
    if (error instanceof Failure) throw error;
    fail(code);
  }
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  code: DesignInputIssueCode
): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) fail(code);
}

function stringValue(
  value: unknown,
  maximumBytes: number,
  code: DesignInputIssueCode,
  multiline = false
): string {
  const containsForbiddenControl =
    typeof value === 'string' &&
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint === 0x7f ||
        (codePoint < 0x20 && (!multiline || ![0x09, 0x0a, 0x0d].includes(codePoint)))
      );
    });
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    byteLength(value) > maximumBytes ||
    containsForbiddenControl
  )
    fail(code);
  return value;
}

function optionalDigest(value: unknown, code: DesignInputIssueCode): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !sha256Pattern.test(value)) fail(code);
  return value;
}

function safeRelativePath(value: unknown, code: DesignInputIssueCode): string {
  const path = stringValue(value, 512, code);
  if (!path.startsWith('./') || path.includes('\\') || path.includes('%') || path.endsWith('/'))
    fail('unsafe-input');
  const segments = path.slice(2).split('/');
  if (
    segments.length === 0 ||
    segments.some((segment) => !segmentPattern.test(segment) || segment === '.' || segment === '..')
  )
    fail('unsafe-input');
  return path;
}

function normalizeLimits(overrides: Partial<DesignInputLimits> | undefined): DesignInputLimits {
  const merged = { ...DEFAULT_DESIGN_INPUT_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (key === 'maxMarkdownImports') continue;
    if (!Number.isSafeInteger(value) || value < 1) fail('malformed-package');
  }
  if (
    !Number.isSafeInteger(merged.maxMarkdownImports) ||
    merged.maxMarkdownImports < 0 ||
    merged.maxArtifactBytes < merged.maxFileBytes ||
    merged.maxIntegrityConcurrency > 32 ||
    merged.portTimeoutMs > 60_000
  )
    fail('malformed-package');
  return freeze(merged);
}

/** Deterministic iterative JSON serialization with duplicate/cycle, depth, node, and byte limits. */
function canonicalJson(value: unknown, limits: DesignInputLimits, maximumBytes: number): string {
  type Task =
    | { readonly value: unknown; readonly depth: number }
    | { readonly text: string }
    | { readonly unvisit: object };
  const tasks: Task[] = [{ value, depth: 0 }];
  const output: string[] = [];
  const active = new WeakSet<object>();
  let nodes = 0;
  while (tasks.length > 0) {
    const task = tasks.pop();
    if (task === undefined) break;
    if ('text' in task) {
      output.push(task.text);
      continue;
    }
    if ('unvisit' in task) {
      active.delete(task.unvisit);
      continue;
    }
    nodes += 1;
    if (nodes > limits.maxJsonNodes || task.depth > limits.maxJsonDepth) fail('budget-exceeded');
    const current = task.value;
    if (
      current === null ||
      typeof current === 'boolean' ||
      typeof current === 'string' ||
      typeof current === 'number'
    ) {
      if (typeof current === 'number' && !Number.isFinite(current)) fail('malformed-package');
      if (typeof current === 'string' && byteLength(current) > maximumBytes)
        fail('budget-exceeded');
      output.push(JSON.stringify(current));
      continue;
    }
    if (typeof current !== 'object' || current === null || active.has(current))
      fail('malformed-package');
    active.add(current);
    if (Array.isArray(current)) {
      if (current.length > limits.maxJsonNodes) fail('budget-exceeded');
      tasks.push({ unvisit: current });
      tasks.push({ text: ']' });
      for (let index = current.length - 1; index >= 0; index -= 1) {
        tasks.push({ value: current[index], depth: task.depth + 1 });
        if (index > 0) tasks.push({ text: ',' });
      }
      tasks.push({ text: '[' });
      continue;
    }
    const entries = dataEntries(current, 'malformed-package');
    tasks.push({ unvisit: current });
    tasks.push({ text: '}' });
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry === undefined) fail('malformed-package');
      tasks.push({ value: entry[1], depth: task.depth + 1 });
      tasks.push({ text: ':' });
      tasks.push({ text: JSON.stringify(entry[0]) });
      if (index > 0) tasks.push({ text: ',' });
    }
    tasks.push({ text: '{' });
  }
  const result = output.join('');
  if (byteLength(result) > maximumBytes) fail('budget-exceeded');
  return result;
}

function parseRequest(value: DesignInputRequest, limits: DesignInputLimits): DesignInputRequest {
  const request = dataObject(value, 'malformed-package');
  assertOnlyKeys(
    request,
    ['package', 'designLanguage', 'requiredPeerDependencies'],
    'malformed-package'
  );
  const packageRequest = dataObject(request.package, 'malformed-package');
  const languageRequest = dataObject(request.designLanguage, 'malformed-package');
  assertOnlyKeys(packageRequest, ['name', 'version', 'expectedSha256'], 'malformed-package');
  assertOnlyKeys(languageRequest, ['location', 'expectedSha256'], 'malformed-package');
  const name = stringValue(packageRequest.name, 256, 'malformed-package');
  const version = stringValue(packageRequest.version, 128, 'malformed-package');
  const location = stringValue(languageRequest.location, 2_048, 'malformed-package');
  if (
    !packageNamePattern.test(name) ||
    !semverPattern.test(version) ||
    /(?:^|\/)\.\.?\//.test(location)
  )
    fail('unsafe-input');
  const requiredPeerDependencies =
    request.requiredPeerDependencies === undefined
      ? undefined
      : parsePeerDependencies(request.requiredPeerDependencies, limits, 'incompatible-input');
  const packageExpectedSha256 = optionalDigest(packageRequest.expectedSha256, 'malformed-package');
  const languageExpectedSha256 = optionalDigest(
    languageRequest.expectedSha256,
    'malformed-package'
  );
  const result: DesignInputRequest = {
    package:
      packageExpectedSha256 === undefined
        ? { name, version }
        : { name, version, expectedSha256: packageExpectedSha256 },
    designLanguage:
      languageExpectedSha256 === undefined
        ? { location }
        : { location, expectedSha256: languageExpectedSha256 },
    ...(requiredPeerDependencies === undefined ? {} : { requiredPeerDependencies })
  };
  if (byteLength(canonicalJson(result, limits, limits.maxRequestBytes)) > limits.maxRequestBytes)
    fail('budget-exceeded');
  return freeze(result);
}

function parsePackageInspectionRequest(
  value: DesignPackageInspectionRequest,
  limits: DesignInputLimits
): DesignPackageInspectionRequest {
  const request = dataObject(value, 'malformed-package');
  assertOnlyKeys(request, ['package', 'requiredPeerDependencies'], 'malformed-package');
  const packageRequest = dataObject(request.package, 'malformed-package');
  assertOnlyKeys(packageRequest, ['name', 'version', 'expectedSha256'], 'malformed-package');
  const name = stringValue(packageRequest.name, 256, 'malformed-package');
  const version = stringValue(packageRequest.version, 128, 'malformed-package');
  if (!packageNamePattern.test(name) || !semverPattern.test(version)) fail('unsafe-input');
  const expectedSha256 = optionalDigest(packageRequest.expectedSha256, 'malformed-package');
  const requiredPeerDependencies =
    request.requiredPeerDependencies === undefined
      ? undefined
      : parsePeerDependencies(request.requiredPeerDependencies, limits, 'incompatible-input');
  const result: DesignPackageInspectionRequest = {
    package: expectedSha256 === undefined ? { name, version } : { name, version, expectedSha256 },
    ...(requiredPeerDependencies === undefined ? {} : { requiredPeerDependencies })
  };
  if (byteLength(canonicalJson(result, limits, limits.maxRequestBytes)) > limits.maxRequestBytes)
    fail('budget-exceeded');
  return freeze(result);
}

function parseProvenance(value: unknown): InputProvenance {
  const provenance = dataObject(value, 'unsafe-input');
  assertOnlyKeys(provenance, ['provider', 'location', 'retrievedAt'], 'unsafe-input');
  const provider = stringValue(provenance.provider, 64, 'unsafe-input');
  const location = stringValue(provenance.location, 2_048, 'unsafe-input');
  if (!provenanceProviderPattern.test(provider) || /(?:^|:)\/\/[^/]*@|[\\]/.test(location))
    fail('unsafe-input');
  const retrievedAt =
    provenance.retrievedAt === undefined
      ? undefined
      : stringValue(provenance.retrievedAt, 64, 'unsafe-input');
  if (
    retrievedAt !== undefined &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(retrievedAt) ||
      Number.isNaN(Date.parse(retrievedAt)))
  )
    fail('unsafe-input');
  return freeze({ provider, location, ...(retrievedAt === undefined ? {} : { retrievedAt }) });
}

function parsePeerDependencies(
  value: unknown,
  limits: DesignInputLimits,
  code: DesignInputIssueCode
): Readonly<Record<string, string>> {
  const entries = dataEntries(value, code);
  if (entries.length === 0 || entries.length > 128) fail('budget-exceeded');
  const peers: Record<string, string> = {};
  for (const [name, range] of entries) {
    const versionRange = stringValue(range, 128, code);
    if (!packageNamePattern.test(name) || !semverRangePattern.test(versionRange)) fail(code);
    peers[name] = versionRange;
  }
  canonicalJson(peers, limits, limits.maxRequestBytes);
  return freeze(peers);
}

function semverMajor(range: string): string | undefined {
  return semverRangePattern.exec(range)?.[1];
}

function parseExportTargets(value: unknown, depth: number): readonly string[] {
  if (depth > 8) fail('budget-exceeded');
  if (typeof value === 'string') return [safeRelativePath(value, 'unsafe-input')];
  const conditions = dataEntries(value, 'malformed-package');
  if (
    conditions.length === 0 ||
    conditions.some(([condition]) => !['default', 'import', 'types'].includes(condition))
  )
    fail('unsafe-input');
  return conditions.flatMap(([, target]) => parseExportTargets(target, depth + 1));
}

function parseExports(value: unknown): Readonly<Record<string, readonly string[]>> {
  const entries = dataEntries(value, 'malformed-package');
  if (entries.length === 0 || entries.length > 128) fail('budget-exceeded');
  const exports: Record<string, readonly string[]> = {};
  for (const [key, target] of entries) {
    if (
      key !== '.' &&
      (!key.startsWith('./') || !segmentPattern.test(key.slice(2)) || key.slice(2).includes('/'))
    )
      fail('unsafe-input');
    exports[key] = freeze([...new Set(parseExportTargets(target, 0))].sort(compareText));
  }
  return freeze(exports);
}

function parseSeleneMetadata(value: unknown, limits: DesignInputLimits): DesignSystemMetadata {
  const selene = dataObject(value, 'malformed-package');
  assertOnlyKeys(selene, ['designSystem'], 'malformed-package');
  const metadata = dataObject(selene.designSystem, 'malformed-package');
  assertOnlyKeys(
    metadata,
    ['schemaVersion', 'tokenFiles', 'components', 'designLanguagePath'],
    'malformed-package'
  );
  const tokenFileValues = dataArray(metadata.tokenFiles, 'malformed-package');
  const componentValues = dataArray(metadata.components, 'malformed-package');
  if (
    metadata.schemaVersion !== '1' ||
    tokenFileValues.length === 0 ||
    tokenFileValues.length > limits.maxTokenFiles ||
    componentValues.length > limits.maxSections
  )
    fail('malformed-package');
  const tokenFiles = [
    ...new Set(tokenFileValues.map((file) => safeRelativePath(file, 'unsafe-input')))
  ].sort(compareText);
  const components = componentValues
    .map((component) => {
      const data = dataObject(component, 'malformed-package');
      assertOnlyKeys(data, ['name', 'exportName', 'entrypoint'], 'malformed-package');
      const entrypoint = stringValue(data.entrypoint, 256, 'malformed-package');
      if (
        entrypoint !== '.' &&
        (!entrypoint.startsWith('./') || entrypoint.includes('..') || entrypoint.includes('\\'))
      )
        fail('unsafe-input');
      return freeze({
        name: stringValue(data.name, 256, 'malformed-package'),
        exportName: stringValue(data.exportName, 256, 'malformed-package'),
        entrypoint
      });
    })
    .sort((left, right) => compareText(left.name, right.name));
  if (new Set(components.map((component) => component.name)).size !== components.length)
    fail('malformed-package');
  return freeze({
    schemaVersion: '1',
    tokenFiles: freeze(tokenFiles),
    components: freeze(components),
    designLanguagePath: safeRelativePath(metadata.designLanguagePath, 'unsafe-input')
  });
}

async function callHostEffect<T>(
  runtime: DesignInputRuntime,
  owner: object,
  method: DesignInputEffectMethod,
  arguments_: readonly unknown[],
  limits: DesignInputLimits,
  failureCode: DesignInputIssueCode
): Promise<T> {
  try {
    const outcome = dataObject(
      await runtime.run<T>(
        owner,
        method,
        arguments_,
        Object.freeze({ timeoutMs: limits.portTimeoutMs })
      ),
      'port-failed'
    );
    const status = outcome.status;
    if (status === 'ok') {
      assertOnlyKeys(outcome, ['status', 'value'], 'port-failed');
      return outcome.value as T;
    }
    assertOnlyKeys(outcome, ['status'], 'port-failed');
    if (status === 'deadline-exceeded') fail('port-timeout');
    if (status === 'effect-failed') fail(failureCode);
    fail(failureCode);
  } catch (error) {
    if (error instanceof Failure) throw error;
    fail(failureCode);
  }
}

async function digest(
  runtime: DesignInputRuntime,
  integrity: DesignInputIntegrityPort,
  value: string,
  limits: DesignInputLimits
): Promise<string> {
  const result = await callHostEffect<string>(
    runtime,
    integrity,
    'sha256',
    [value],
    limits,
    'integrity-failed'
  );
  if (typeof result !== 'string' || !sha256Pattern.test(result)) fail('integrity-failed');
  return result;
}

function validateTokenFiles(
  files: ReadonlyMap<string, PackageFile>,
  tokenFiles: readonly string[],
  limits: DesignInputLimits
): void {
  let nodes = 0;
  for (const path of tokenFiles) {
    const file = files.get(path);
    if (file === undefined) fail('missing-input');
    let tokenValue: unknown;
    try {
      tokenValue = JSON.parse(file.content);
    } catch {
      fail('malformed-package');
    }
    canonicalJson(tokenValue, limits, limits.maxFileBytes);
    const pending: unknown[] = [tokenValue];
    while (pending.length > 0) {
      const current = pending.pop();
      nodes += 1;
      if (nodes > limits.maxTokenNodes) fail('budget-exceeded');
      if (Array.isArray(current)) {
        pending.push(...dataArray(current, 'malformed-package'));
      } else if (typeof current === 'object' && current !== null) {
        pending.push(...dataEntries(current, 'malformed-package').map(([, child]) => child));
      }
    }
  }
}

function snapshotPackageFile(value: unknown, limits: DesignInputLimits): PackageFile {
  const input = dataObject(value, 'malformed-package');
  assertOnlyKeys(input, ['path', 'content'], 'malformed-package');
  return freeze({
    path: safeRelativePath(input.path, 'unsafe-input'),
    content: stringValue(input.content, limits.maxFileBytes, 'budget-exceeded', true)
  });
}

function snapshotResolvedPackage(
  value: ResolvedDesignPackage,
  limits: DesignInputLimits
): ResolvedDesignPackage {
  const artifact = dataObject(value, 'malformed-package');
  assertOnlyKeys(artifact, ['packageJson', 'files', 'provenance'], 'malformed-package');
  const packageJson = freeze(
    JSON.parse(canonicalJson(artifact.packageJson, limits, limits.maxManifestBytes)) as unknown
  );
  const arrayFiles = dataArray(artifact.files, 'malformed-package');
  if (arrayFiles.length > limits.maxFiles) fail('budget-exceeded');
  const files: PackageFile[] = [];
  let bytes = 0;
  for (const candidate of arrayFiles) {
    const file = snapshotPackageFile(candidate, limits);
    bytes += byteLength(file.content);
    if (bytes > limits.maxArtifactBytes) fail('budget-exceeded');
    files.push(file);
  }
  return freeze({
    packageJson,
    files: freeze(files),
    provenance: parseProvenance(artifact.provenance)
  });
}

function snapshotResolvedLanguage(
  value: ResolvedDesignLanguage,
  limits: DesignInputLimits
): ResolvedDesignLanguage {
  const artifact = dataObject(value, 'malformed-markdown');
  assertOnlyKeys(artifact, ['markdown', 'provenance'], 'malformed-markdown');
  return freeze({
    markdown: stringValue(artifact.markdown, limits.maxMarkdownBytes, 'malformed-markdown', true),
    provenance: parseProvenance(artifact.provenance)
  });
}

async function parsePackage(
  artifactValue: ResolvedDesignPackage,
  request: DesignPackageRequest,
  runtime: DesignInputRuntime,
  integrity: DesignInputIntegrityPort,
  limits: DesignInputLimits
): Promise<ParsedPackage> {
  const artifact = dataObject(artifactValue, 'malformed-package');
  assertOnlyKeys(artifact, ['packageJson', 'files', 'provenance'], 'malformed-package');
  const provenance = parseProvenance(artifact.provenance);
  const packageJson = dataObject(artifact.packageJson, 'malformed-package');
  assertOnlyKeys(
    packageJson,
    ['name', 'version', 'peerDependencies', 'exports', 'selene', ...forbiddenPackageKeys],
    'malformed-package'
  );
  for (const key of forbiddenPackageKeys) if (Object.hasOwn(packageJson, key)) fail('unsafe-input');
  const name = stringValue(packageJson.name, 256, 'malformed-package');
  const version = stringValue(packageJson.version, 128, 'malformed-package');
  if (!packageNamePattern.test(name) || !semverPattern.test(version)) fail('malformed-package');
  if (name !== request.name || version !== request.version) fail('incompatible-input');
  const library = freeze({
    name,
    version,
    peerDependencies: parsePeerDependencies(
      packageJson.peerDependencies,
      limits,
      'malformed-package'
    ),
    exports: parseExports(packageJson.exports),
    selene: parseSeleneMetadata(packageJson.selene, limits)
  });
  const arrayFiles = dataArray(artifact.files, 'malformed-package').map((file) =>
    snapshotPackageFile(file, limits)
  );
  if (arrayFiles.length > limits.maxFiles) fail('budget-exceeded');
  const canonicalMetadata = canonicalJson(packageJson, limits, limits.maxManifestBytes);
  const metadataHash = await digest(runtime, integrity, canonicalMetadata, limits);
  if (request.expectedSha256 !== undefined && request.expectedSha256 !== metadataHash)
    fail('integrity-failed');

  let aggregateBytes = 0;
  const filesByPath = new Map<string, PackageFile>();
  const fileHashesByPath = new Map<string, string>();
  for (const file of arrayFiles) {
    const path = file.path;
    const content = file.content;
    aggregateBytes += byteLength(content);
    if (aggregateBytes > limits.maxArtifactBytes || filesByPath.has(path))
      fail(filesByPath.has(path) ? 'unsafe-input' : 'budget-exceeded');
    filesByPath.set(path, freeze({ path, content }));
    // eslint-disable-next-line no-await-in-loop
    fileHashesByPath.set(path, await digest(runtime, integrity, content, limits));
  }
  const requiredFiles = [
    ...Object.values(library.exports).flat(),
    ...library.selene.tokenFiles,
    library.selene.designLanguagePath
  ];
  for (const path of requiredFiles) if (!filesByPath.has(path)) fail('missing-input');
  for (const component of library.selene.components)
    if (!Object.hasOwn(library.exports, component.entrypoint)) fail('malformed-package');
  validateTokenFiles(filesByPath, library.selene.tokenFiles, limits);
  const artifactBytes = aggregateBytes + byteLength(canonicalMetadata);
  if (artifactBytes > limits.maxArtifactBytes) fail('budget-exceeded');
  return freeze({
    library,
    filesByPath,
    fileHashesByPath,
    metadataHash,
    artifactBytes,
    provenance
  });
}

function validatePeerCompatibility(
  peers: Readonly<Record<string, string>>,
  required: Readonly<Record<string, string>> | undefined
): void {
  if (required === undefined) return;
  for (const [name, range] of Object.entries(required)) {
    if (peers[name] === undefined || semverMajor(peers[name]) !== semverMajor(range))
      fail('incompatible-input');
  }
}

async function inspectSafePackage(
  request: DesignPackageInspectionRequest,
  packageValue: ResolvedDesignPackage,
  runtime: DesignInputRuntime,
  integrity: DesignInputIntegrityPort,
  limits: DesignInputLimits
): Promise<void> {
  const parsed = await parsePackage(packageValue, request.package, runtime, integrity, limits);
  validatePeerCompatibility(parsed.library.peerDependencies, request.requiredPeerDependencies);
  const embeddedLanguage = parsed.filesByPath.get(parsed.library.selene.designLanguagePath);
  if (embeddedLanguage === undefined) fail('missing-input');
  parseMarkdown(embeddedLanguage.content, limits);
}

function parseMarkdown(markdown: unknown, limits: DesignInputLimits): DesignLanguage {
  const source = stringValue(markdown, limits.maxMarkdownBytes, 'malformed-markdown', true);
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const lowerSource = source.toLowerCase();
  if (
    lines.length > limits.maxMarkdownLines ||
    source.includes('<') ||
    source.includes('{{') ||
    source.includes('{%') ||
    lowerSource.includes('javascript:') ||
    lowerSource.includes('vbscript:') ||
    lowerSource.includes('data:') ||
    lowerSource.includes('file:')
  )
    fail('unsafe-input');
  let tokens = 0;
  let inToken = false;
  for (let index = 0; index < source.length; index += 1) {
    const whitespace = /\s/.test(source[index] ?? '');
    if (!whitespace && !inToken) {
      tokens += 1;
      if (tokens > limits.maxMarkdownTokens) fail('budget-exceeded');
    }
    inToken = !whitespace;
  }
  let firstContentLine = 0;
  if (lines[0] === '---') {
    let frontmatterBytes = byteLength(lines[0]);
    let entries = 0;
    firstContentLine = 1;
    while (firstContentLine < lines.length && lines[firstContentLine] !== '---') {
      const line = lines[firstContentLine] ?? '';
      frontmatterBytes += byteLength(line) + 1;
      entries += 1;
      if (frontmatterBytes > limits.maxFrontmatterBytes || entries > limits.maxFrontmatterEntries)
        fail('budget-exceeded');
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}:[^\r\n]{0,512}$/.test(line)) fail('malformed-markdown');
      firstContentLine += 1;
    }
    if (firstContentLine >= lines.length) fail('malformed-markdown');
    firstContentLine += 1;
  }
  const sections: Array<{
    readonly heading: string;
    readonly level: number;
    readonly body: string[];
    bytes: number;
  }> = [];
  let current:
    | { readonly heading: string; readonly level: number; readonly body: string[]; bytes: number }
    | undefined;
  for (const line of lines.slice(firstContentLine)) {
    if (/^\s*(?:import|export|require)\b/.test(line)) {
      if (limits.maxMarkdownImports === 0) fail('unsafe-input');
      fail('unsafe-input'); // Markdown/MDX imports are never executable design input.
    }
    const heading = /^(#{1,6})[ \t]+([^\r\n]{1,256})[ \t]*$/.exec(line);
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      if (sections.length >= limits.maxSections) fail('budget-exceeded');
      if (byteLength(heading[2]) > limits.maxStringBytes) fail('budget-exceeded');
      current = { heading: heading[2], level: heading[1].length, body: [], bytes: 0 };
      sections.push(current);
    } else if (current !== undefined) {
      current.bytes += byteLength(line) + (current.body.length === 0 ? 0 : 1);
      if (current.bytes > limits.maxMarkdownSectionBytes) fail('budget-exceeded');
      current.body.push(line);
    }
  }
  if (sections.length === 0) fail('malformed-markdown');
  return freeze({
    sections: freeze(
      sections.map((section) =>
        freeze({
          heading: section.heading,
          level: section.level,
          body: section.body.join('\n').trimEnd()
        })
      )
    )
  });
}

function recordsFor(
  parsed: ParsedPackage,
  languageProvenance: InputProvenance,
  languageHash: string
): readonly DesignInputRecord[] {
  const sortedFiles = [...parsed.filesByPath.values()].sort((left, right) =>
    compareText(left.path, right.path)
  );
  const records: DesignInputRecord[] = [
    {
      kind: 'package-metadata',
      location: parsed.provenance.location,
      sha256: parsed.metadataHash,
      provenance: parsed.provenance
    },
    {
      kind: 'design-language',
      location: languageProvenance.location,
      sha256: languageHash,
      provenance: languageProvenance
    }
  ];
  for (const file of sortedFiles) {
    const sha256 = parsed.fileHashesByPath.get(file.path);
    if (sha256 === undefined) fail('integrity-failed');
    records.push({
      kind: 'package-file',
      location: file.path,
      sha256,
      provenance: parsed.provenance
    });
  }
  return freeze(records.map((record) => freeze(record)));
}

function freeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  const pending: object[] = [value as object];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(current))) {
      if (
        'value' in descriptor &&
        descriptor.value !== null &&
        typeof descriptor.value === 'object'
      )
        pending.push(descriptor.value as object);
    }
    Object.freeze(current);
  }
  return value;
}

function issueFrom(error: unknown): DesignInputIssue {
  const code = error instanceof Failure ? error.code : 'port-failed';
  return freeze({ code, message: issueMessages[code] });
}

async function ingestSafeRequest(
  request: DesignInputRequest,
  packageValue: ResolvedDesignPackage,
  languageValue: ResolvedDesignLanguage,
  runtime: DesignInputRuntime,
  integrity: DesignInputIntegrityPort,
  limits: DesignInputLimits
): Promise<DesignContext> {
  const languageArtifact = dataObject(languageValue, 'malformed-markdown');
  assertOnlyKeys(languageArtifact, ['markdown', 'provenance'], 'malformed-markdown');
  const markdown = stringValue(
    languageArtifact.markdown,
    limits.maxMarkdownBytes,
    'malformed-markdown',
    true
  );
  const normalizedLanguageArtifact = freeze({
    markdown,
    provenance: parseProvenance(languageArtifact.provenance)
  });
  const parsed = await parsePackage(packageValue, request.package, runtime, integrity, limits);
  if (parsed.artifactBytes + byteLength(markdown) > limits.maxArtifactBytes)
    fail('budget-exceeded');
  validatePeerCompatibility(parsed.library.peerDependencies, request.requiredPeerDependencies);
  const language = parseMarkdown(markdown, limits);
  const embeddedLanguage = parsed.filesByPath.get(parsed.library.selene.designLanguagePath);
  if (embeddedLanguage === undefined) fail('missing-input');
  if (embeddedLanguage.content !== markdown) fail('incompatible-input');
  const languageHash = await digest(runtime, integrity, markdown, limits);
  if (
    request.designLanguage.expectedSha256 !== undefined &&
    request.designLanguage.expectedSha256 !== languageHash
  )
    fail('integrity-failed');
  const records = recordsFor(parsed, normalizedLanguageArtifact.provenance, languageHash);
  const contextWithoutHash = freeze({
    format: 'selene-design-context/v1' as const,
    library: parsed.library,
    language,
    records
  });
  return freeze({
    ...contextWithoutHash,
    sha256: await digest(
      runtime,
      integrity,
      canonicalJson(contextWithoutHash, limits, limits.maxArtifactBytes),
      limits
    )
  });
}

async function ingestUnchecked(
  requestValue: DesignInputRequest,
  packageValue: ResolvedDesignPackage,
  languageValue: ResolvedDesignLanguage,
  runtime: DesignInputRuntime,
  integrity: DesignInputIntegrityPort,
  limits: DesignInputLimits
): Promise<DesignContext> {
  return await ingestSafeRequest(
    parseRequest(requestValue, limits),
    packageValue,
    languageValue,
    runtime,
    integrity,
    limits
  );
}

/** Parses supplied data into a deterministic, deeply frozen context. No package code is installed, imported, or executed. */
async function ingestDesignInputs(
  request: DesignInputRequest,
  packageArtifact: ResolvedDesignPackage,
  languageArtifact: ResolvedDesignLanguage,
  integrity: DesignInputIntegrityPort,
  runtime: DesignInputRuntime,
  overrides?: Partial<DesignInputLimits>
): Promise<DesignContext> {
  try {
    return await ingestUnchecked(
      request,
      packageArtifact,
      languageArtifact,
      runtime,
      integrity,
      normalizeLimits(overrides)
    );
  } catch (error) {
    if (error instanceof DesignInputValidationError) throw error;
    throw new DesignInputValidationError([issueFrom(error)]);
  }
}

async function resolveSafeDesignInputArtifacts(
  port: DesignInputPort,
  request: DesignInputRequest,
  runtime: DesignInputRuntime,
  limits: DesignInputLimits
): Promise<ResolvedDesignInputArtifacts> {
  const [packageArtifact, languageArtifact] = await Promise.all([
    callHostEffect<ResolvedDesignPackage>(
      runtime,
      port,
      'resolvePackage',
      [request.package],
      limits,
      'port-failed'
    ),
    callHostEffect<ResolvedDesignLanguage>(
      runtime,
      port,
      'readDesignLanguage',
      [request.designLanguage],
      limits,
      'port-failed'
    )
  ]);
  return freeze({
    request,
    packageArtifact: snapshotResolvedPackage(packageArtifact, limits),
    designLanguageArtifact: snapshotResolvedLanguage(languageArtifact, limits)
  });
}

/** Resolves npm and Markdown artifacts through the shared supervised host boundary. */
async function resolveDesignInputArtifacts(
  port: DesignInputPort,
  request: DesignInputRequest,
  runtime: DesignInputRuntime,
  overrides?: Partial<DesignInputLimits>
): Promise<ResolvedDesignInputArtifacts> {
  const limits = normalizeLimits(overrides);
  try {
    return await resolveSafeDesignInputArtifacts(
      port,
      parseRequest(request, limits),
      runtime,
      limits
    );
  } catch (error) {
    if (error instanceof DesignInputValidationError) throw error;
    throw new DesignInputValidationError([issueFrom(error)]);
  }
}

async function inspectDesignPackage(
  port: DesignInputPort,
  request: DesignPackageInspectionRequest,
  runtime: DesignInputRuntime,
  overrides?: Partial<DesignInputLimits>
): Promise<ResolvedDesignPackage> {
  const limits = normalizeLimits(overrides);
  try {
    const parsedRequest = parsePackageInspectionRequest(request, limits);
    const packageArtifact = snapshotResolvedPackage(
      await callHostEffect<ResolvedDesignPackage>(
        runtime,
        port,
        'resolvePackage',
        [parsedRequest.package],
        limits,
        'port-failed'
      ),
      limits
    );
    await inspectSafePackage(parsedRequest, packageArtifact, runtime, port, limits);
    return packageArtifact;
  } catch (error) {
    if (error instanceof DesignInputValidationError) throw error;
    throw new DesignInputValidationError([issueFrom(error)]);
  }
}

/** Resolves data through a bounded host port, then applies the same pure validation. */
async function loadDesignContext(
  port: DesignInputPort,
  request: DesignInputRequest,
  runtime: DesignInputRuntime,
  overrides?: Partial<DesignInputLimits>
): Promise<DesignContext> {
  const limits = normalizeLimits(overrides);
  try {
    const artifacts = await resolveSafeDesignInputArtifacts(
      port,
      parseRequest(request, limits),
      runtime,
      limits
    );
    return await ingestSafeRequest(
      artifacts.request,
      artifacts.packageArtifact,
      artifacts.designLanguageArtifact,
      runtime,
      port,
      limits
    );
  } catch (error) {
    if (error instanceof DesignInputValidationError) throw error;
    throw new DesignInputValidationError([issueFrom(error)]);
  }
}

function capturedMethod(
  value: unknown,
  keys: readonly string[],
  code: DesignInputIssueCode
): Readonly<{ target: object; methods: Readonly<Record<string, (...args: never[]) => unknown>> }> {
  const record = dataObject(value, code);
  assertOnlyKeys(record, keys, code);
  const methods: Record<string, (...args: never[]) => unknown> = {};
  for (const key of keys) {
    if (typeof record[key] !== 'function') fail(code);
    methods[key] = record[key] as (...args: never[]) => unknown;
  }
  return Object.freeze({ target: value as object, methods: Object.freeze(methods) });
}

/**
 * Captures exact own data methods once. The returned loader is the v1
 * replacement for the former positional loadDesignContext port API.
 */
export function createDesignInputLoader(
  value: DesignInputLoaderOptions
): DesignInputLoaderWithPackageInspection {
  try {
    const options = dataObject(value, 'malformed-package');
    assertOnlyKeys(options, ['port', 'runtime'], 'malformed-package');
    const port = capturedMethod(
      options.port,
      ['resolvePackage', 'readDesignLanguage', 'sha256'],
      'port-failed'
    );
    const runtime = capturedMethod(options.runtime, ['run'], 'port-failed');
    const resolvePackage = port.methods.resolvePackage;
    const readDesignLanguage = port.methods.readDesignLanguage;
    const sha256 = port.methods.sha256;
    const run = runtime.methods.run;
    if (
      resolvePackage === undefined ||
      readDesignLanguage === undefined ||
      sha256 === undefined ||
      run === undefined
    )
      fail('port-failed');
    const capturedPort: DesignInputPort = freeze({
      resolvePackage: (context, request) =>
        Promise.resolve(
          Reflect.apply(resolvePackage, port.target, [context, request])
        ) as Promise<ResolvedDesignPackage>,
      readDesignLanguage: (context, request) =>
        Promise.resolve(
          Reflect.apply(readDesignLanguage, port.target, [context, request])
        ) as Promise<ResolvedDesignLanguage>,
      sha256: (context, input) =>
        Promise.resolve(Reflect.apply(sha256, port.target, [context, input])) as Promise<string>
    });
    const capturedRuntime: DesignInputRuntime = freeze({
      run: <T>(
        owner: object,
        method: DesignInputEffectMethod,
        arguments_: readonly unknown[],
        options_: Readonly<{ timeoutMs: number }>
      ) =>
        Promise.resolve(
          Reflect.apply(run, runtime.target, [owner, method, arguments_, options_])
        ) as Promise<DesignInputRuntimeOutcome<T>>
    });
    return freeze({
      load: (request, overrides) =>
        loadDesignContext(capturedPort, request, capturedRuntime, overrides),
      inspectPackage: (request, overrides) =>
        inspectDesignPackage(capturedPort, request, capturedRuntime, overrides),
      resolveArtifacts: (request, overrides) =>
        resolveDesignInputArtifacts(capturedPort, request, capturedRuntime, overrides),
      ingest: (request, packageArtifact, languageArtifact, overrides) =>
        ingestDesignInputs(
          request,
          packageArtifact,
          languageArtifact,
          capturedPort,
          capturedRuntime,
          overrides
        )
    });
  } catch (error) {
    if (error instanceof DesignInputValidationError) throw error;
    throw new DesignInputValidationError([issueFrom(error)]);
  }
}
