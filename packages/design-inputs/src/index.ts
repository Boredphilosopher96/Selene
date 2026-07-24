export const designInputsPackageName = '@selene/design-inputs';

export interface DesignPackageRequest {
  readonly name: string;
  readonly version: string;
  readonly expectedSha256?: string;
}

export interface DesignLanguageRequest {
  /** An adapter-defined, opaque identifier; it is never treated as a filesystem path. */
  readonly location: string;
  readonly expectedSha256?: string;
}

export interface DesignInputRequest {
  readonly package: DesignPackageRequest;
  readonly designLanguage: DesignLanguageRequest;
  /** Peer ranges the consuming host requires. Only compatible major versions are accepted. */
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

export interface ResolvedDesignPackage {
  readonly packageJson: unknown;
  readonly files: readonly PackageFile[];
  readonly provenance: InputProvenance;
}

export interface ResolvedDesignLanguage {
  readonly markdown: string;
  readonly provenance: InputProvenance;
}

/**
 * Host-owned integrity primitive. It is for content-addressed SHA-256
 * verification only, never authentication, signatures, or MACs.
 */
export interface DesignInputIntegrityPort {
  sha256(value: string): Promise<string>;
}

/**
 * The sole side-effect boundary. Hosts may implement this with a cache,
 * registry, archive, or filesystem, but this package never installs or imports
 * a dependency and never dereferences paths itself.
 */
export interface DesignInputPort extends DesignInputIntegrityPort {
  resolvePackage(request: DesignPackageRequest): Promise<ResolvedDesignPackage>;
  readDesignLanguage(request: DesignLanguageRequest): Promise<ResolvedDesignLanguage>;
}

export type DesignInputIssueCode =
  | 'incompatible-input'
  | 'malformed-markdown'
  | 'malformed-package'
  | 'missing-input'
  | 'unsafe-input';

export interface DesignInputIssue {
  readonly code: DesignInputIssueCode;
  readonly message: string;
}

export class DesignInputValidationError extends Error {
  public constructor(readonly issues: readonly DesignInputIssue[]) {
    super(issues.map((issue) => issue.message).join('\n'));
    this.name = 'DesignInputValidationError';
  }
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

interface ParsedPackage {
  readonly library: DesignLibrary;
  readonly filesByPath: ReadonlyMap<string, PackageFile>;
}

const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const forbiddenPackageKeys = new Set([
  'bin',
  'hooks',
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublishOnly',
  'scripts'
]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function safeRelativePath(value: string, path: string): string {
  if (
    !value.startsWith('./') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.split('/').some((segment) => segment === '..' || segment.length === 0)
  ) {
    throw new Error(`${path} must be a normalized relative path beginning with ./`);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!isRecord(value)) throw new Error('metadata must be JSON data');
  return `{${Object.keys(value)
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function hashMatches(expected: string | undefined, actual: string, label: string): void {
  if (expected !== undefined && (!sha256Pattern.test(expected) || expected !== actual)) {
    throw new Error(`${label} checksum does not match the requested SHA-256`);
  }
}

async function digest(integrity: DesignInputIntegrityPort, value: string): Promise<string> {
  const valueDigest = await integrity.sha256(value);
  if (!sha256Pattern.test(valueDigest))
    throw new Error('Design input integrity port must return a lowercase SHA-256 digest');
  return valueDigest;
}

function peerMajor(range: string): string | undefined {
  return /^(?:\^|~|>=)?(\d+)\./.exec(range)?.[1];
}

function parsePeerDependencies(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) throw new Error('package.json.peerDependencies must be an object');
  const entries = Object.entries(value).sort(([left], [right]) => compareText(left, right));
  if (entries.length === 0) throw new Error('package.json.peerDependencies must not be empty');
  const peers: Record<string, string> = {};
  for (const [name, range] of entries) {
    if (
      !packageNamePattern.test(name) ||
      typeof range !== 'string' ||
      peerMajor(range) === undefined
    ) {
      throw new Error(`package.json.peerDependencies.${name} must use a supported semver range`);
    }
    peers[name] = range;
  }
  return peers;
}

function parseExportTargets(value: unknown, path: string): readonly string[] {
  if (typeof value === 'string') return [safeRelativePath(value, path)];
  if (!isRecord(value)) throw new Error(`${path} must be a path or supported condition map`);
  const conditions = Object.keys(value).sort(compareText);
  if (
    conditions.length === 0 ||
    conditions.some((condition) => !['default', 'import', 'types'].includes(condition))
  ) {
    throw new Error(`${path} has an unsupported export condition`);
  }
  return conditions.flatMap((condition) =>
    parseExportTargets(value[condition], `${path}.${condition}`)
  );
}

function parseExports(value: unknown): Readonly<Record<string, readonly string[]>> {
  if (!isRecord(value)) throw new Error('package.json.exports must be an object');
  const exports: Record<string, readonly string[]> = {};
  for (const key of Object.keys(value).sort(compareText)) {
    if (key !== '.' && (!key.startsWith('./') || key.includes('..') || key.includes('\\'))) {
      throw new Error(`package.json.exports.${key} is not a safe export key`);
    }
    exports[key] = [...new Set(parseExportTargets(value[key], `package.json.exports.${key}`))].sort(
      compareText
    );
  }
  if (Object.keys(exports).length === 0) throw new Error('package.json.exports must not be empty');
  return exports;
}

function parseSeleneMetadata(value: unknown): DesignSystemMetadata {
  if (!isRecord(value) || !isRecord(value.designSystem)) {
    throw new Error('package.json.selene.designSystem is required');
  }
  const metadata = value.designSystem;
  if (metadata.schemaVersion !== '1')
    throw new Error('selene.designSystem.schemaVersion must be "1"');
  if (!Array.isArray(metadata.tokenFiles) || metadata.tokenFiles.length === 0) {
    throw new Error('selene.designSystem.tokenFiles must be a non-empty array');
  }
  const tokenFiles = metadata.tokenFiles.map((item, index) =>
    safeRelativePath(
      requiredString(item, `selene.designSystem.tokenFiles.${index}`),
      'selene token file'
    )
  );
  if (!Array.isArray(metadata.components)) {
    throw new Error('selene.designSystem.components must be an array');
  }
  const components = metadata.components.map((component, index) => {
    if (!isRecord(component))
      throw new Error(`selene.designSystem.components.${index} must be an object`);
    return {
      name: requiredString(component.name, `selene.designSystem.components.${index}.name`),
      exportName: requiredString(
        component.exportName,
        `selene.designSystem.components.${index}.exportName`
      ),
      entrypoint: requiredString(
        component.entrypoint,
        `selene.designSystem.components.${index}.entrypoint`
      )
    };
  });
  const designLanguagePath = safeRelativePath(
    requiredString(metadata.designLanguagePath, 'selene.designSystem.designLanguagePath'),
    'selene.designSystem.designLanguagePath'
  );
  return {
    schemaVersion: '1',
    tokenFiles: [...new Set(tokenFiles)].sort(compareText),
    components: [...components].sort((left, right) => compareText(left.name, right.name)),
    designLanguagePath
  };
}

async function parsePackage(
  artifact: ResolvedDesignPackage,
  request: DesignPackageRequest,
  integrity: DesignInputIntegrityPort
): Promise<ParsedPackage> {
  if (!isRecord(artifact.packageJson)) throw new Error('package.json must be an object');
  for (const key of forbiddenPackageKeys) {
    if (Object.hasOwn(artifact.packageJson, key)) {
      throw new Error(
        `package.json.${key} is forbidden because design inputs cannot expose executable hooks`
      );
    }
  }
  const name = requiredString(artifact.packageJson.name, 'package.json.name');
  const version = requiredString(artifact.packageJson.version, 'package.json.version');
  if (!packageNamePattern.test(name) || !versionPattern.test(version)) {
    throw new Error('package.json name or version is malformed');
  }
  if (name !== request.name || version !== request.version) {
    throw new Error('resolved package name and version must match the requested package');
  }
  const filesByPath = new Map<string, PackageFile>();
  for (const file of artifact.files) {
    const path = safeRelativePath(file.path, 'package file path');
    if (filesByPath.has(path)) throw new Error(`duplicate package file ${path}`);
    filesByPath.set(path, { path, content: file.content });
  }
  const library: DesignLibrary = {
    name,
    version,
    peerDependencies: parsePeerDependencies(artifact.packageJson.peerDependencies),
    exports: parseExports(artifact.packageJson.exports),
    selene: parseSeleneMetadata(artifact.packageJson.selene)
  };
  const requiredFiles = [
    ...Object.values(library.exports).flat(),
    ...library.selene.tokenFiles,
    library.selene.designLanguagePath
  ];
  for (const path of requiredFiles) {
    if (!filesByPath.has(path)) throw new Error(`required declared artifact ${path} is missing`);
  }
  for (const component of library.selene.components) {
    if (!(component.entrypoint in library.exports)) {
      throw new Error(
        `component ${component.name} references unknown export ${component.entrypoint}`
      );
    }
  }
  hashMatches(
    request.expectedSha256,
    await digest(integrity, canonicalJson(artifact.packageJson)),
    'package metadata'
  );
  return { library, filesByPath };
}

function validatePeerCompatibility(
  peers: Readonly<Record<string, string>>,
  requiredPeers: Readonly<Record<string, string>> | undefined
): void {
  if (requiredPeers === undefined) return;
  for (const [name, required] of Object.entries(requiredPeers).sort(([left], [right]) =>
    compareText(left, right)
  )) {
    const actual = peers[name];
    if (actual === undefined || peerMajor(actual) !== peerMajor(required)) {
      throw new Error(`peer dependency ${name} is incompatible with required range ${required}`);
    }
  }
}

function parseMarkdown(markdown: string): DesignLanguage {
  if (markdown.trim().length === 0) throw new Error('DESIGN.md must not be empty');
  if (
    /<\/?(?:script|iframe|object|embed)\b/i.test(markdown) ||
    /\]\(\s*javascript:/i.test(markdown)
  ) {
    throw new Error('DESIGN.md contains executable or unsafe markup');
  }
  const sections: MarkdownSection[] = [];
  let current: MarkdownSection | undefined;
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      current = { heading: heading[2], level: heading[1].length, body: '' };
      sections.push(current);
    } else if (current !== undefined) {
      current = { ...current, body: current.body.length === 0 ? line : `${current.body}\n${line}` };
      sections[sections.length - 1] = current;
    }
  }
  if (sections.length === 0) throw new Error('DESIGN.md must contain at least one heading');
  return { sections: sections.map((section) => ({ ...section, body: section.body.trimEnd() })) };
}

function classifyError(error: unknown): DesignInputIssueCode {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('missing') || message.includes('required declared artifact'))
    return 'missing-input';
  if (message.includes('incompatible') || message.includes('must match'))
    return 'incompatible-input';
  if (
    message.includes('forbidden') ||
    message.includes('unsafe') ||
    message.includes('normalized relative')
  ) {
    return 'unsafe-input';
  }
  if (message.includes('DESIGN.md')) return 'malformed-markdown';
  return 'malformed-package';
}

function issueFrom(error: unknown): DesignInputIssue {
  const message = error instanceof Error ? error.message : String(error);
  return { code: classifyError(error), message };
}

async function recordsFor(
  packageArtifact: ResolvedDesignPackage,
  languageArtifact: ResolvedDesignLanguage,
  files: ReadonlyMap<string, PackageFile>,
  integrity: DesignInputIntegrityPort
): Promise<readonly DesignInputRecord[]> {
  const sortedFiles = [...files.values()].sort((left, right) => compareText(left.path, right.path));
  const [metadata, language, ...fileHashes] = await Promise.all([
    digest(integrity, canonicalJson(packageArtifact.packageJson)),
    digest(integrity, languageArtifact.markdown),
    ...sortedFiles.map((file) => digest(integrity, file.content))
  ]);
  const records: DesignInputRecord[] = [
    {
      kind: 'package-metadata',
      location: packageArtifact.provenance.location,
      sha256: metadata,
      provenance: packageArtifact.provenance
    },
    {
      kind: 'design-language',
      location: languageArtifact.provenance.location,
      sha256: language,
      provenance: languageArtifact.provenance
    }
  ];
  for (const [index, file] of sortedFiles.entries()) {
    const sha256 = fileHashes[index];
    if (sha256 === undefined) throw new Error(`Missing integrity digest for ${file.path}`);
    records.push({
      kind: 'package-file',
      location: file.path,
      sha256,
      provenance: packageArtifact.provenance
    });
  }
  return records;
}

/** Parse supplied artifacts into a stable, data-only context. No package code is ever loaded. */
export function ingestDesignInputs(
  request: DesignInputRequest,
  packageArtifact: ResolvedDesignPackage,
  languageArtifact: ResolvedDesignLanguage,
  integrity: DesignInputIntegrityPort
): Promise<DesignContext> {
  return ingestDesignInputsUnchecked(request, packageArtifact, languageArtifact, integrity).catch(
    (error: unknown) => {
      throw new DesignInputValidationError([issueFrom(error)]);
    }
  );
}

async function ingestDesignInputsUnchecked(
  request: DesignInputRequest,
  packageArtifact: ResolvedDesignPackage,
  languageArtifact: ResolvedDesignLanguage,
  integrity: DesignInputIntegrityPort
): Promise<DesignContext> {
  const parsed = await parsePackage(packageArtifact, request.package, integrity);
  validatePeerCompatibility(parsed.library.peerDependencies, request.requiredPeerDependencies);
  const languagePath = parsed.library.selene.designLanguagePath;
  const embeddedLanguage = parsed.filesByPath.get(languagePath);
  const language = parseMarkdown(languageArtifact.markdown);
  if (embeddedLanguage?.content !== languageArtifact.markdown) {
    throw new Error(`DESIGN.md content must match declared package artifact ${languagePath}`);
  }
  hashMatches(
    request.designLanguage.expectedSha256,
    await digest(integrity, languageArtifact.markdown),
    'DESIGN.md'
  );
  const records = await recordsFor(
    packageArtifact,
    languageArtifact,
    parsed.filesByPath,
    integrity
  );
  const contextWithoutHash = {
    format: 'selene-design-context/v1' as const,
    library: parsed.library,
    language,
    records
  };
  return {
    ...contextWithoutHash,
    sha256: await digest(integrity, canonicalJson(contextWithoutHash))
  };
}

/** Resolve artifacts through the host port, then apply the same pure validation. */
export async function loadDesignContext(
  port: DesignInputPort,
  request: DesignInputRequest
): Promise<DesignContext> {
  const [packageArtifact, languageArtifact] = await Promise.all([
    port.resolvePackage(request.package),
    port.readDesignLanguage(request.designLanguage)
  ]);
  return ingestDesignInputs(request, packageArtifact, languageArtifact, port);
}
