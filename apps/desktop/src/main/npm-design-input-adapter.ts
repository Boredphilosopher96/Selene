import { createHash, timingSafeEqual } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import {
  DEFAULT_DESIGN_INPUT_LIMITS,
  type DesignInputCallContext,
  type DesignInputPort,
  type DesignLanguageRequest,
  type DesignPackageRequest,
  type PackageFile,
  type ResolvedDesignLanguage,
  type ResolvedDesignPackage
} from '@selene/design-inputs';

const registryOrigin = 'https://registry.npmjs.org';
const maxCompressedBytes = 2 * 1024 * 1024;
const maxTarBytes = 4 * 1024 * 1024;
const maxEntries = 256;
const receiptPath = './selene-npm-receipt.json';
const namePattern = /^(?:@[a-z0-9][a-z0-9._-]{0,127}\/)?[a-z0-9][a-z0-9._-]{0,127}$/;
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z.-]+)?$/;
const approvedLicenses = [
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'Unlicense',
  'CC0-1.0'
];
const decoder = new TextDecoder('utf-8', { fatal: true });

export type NpmDesignInputErrorCode =
  | 'INVALID_REQUEST'
  | 'CANCELLED'
  | 'REGISTRY_UNAVAILABLE'
  | 'INVALID_METADATA'
  | 'INTEGRITY_FAILED'
  | 'LICENSE_UNAPPROVED'
  | 'BUDGET_EXCEEDED'
  | 'UNSAFE_ARCHIVE'
  | 'INCOMPATIBLE_PACKAGE';

const messages: Record<NpmDesignInputErrorCode, string> = {
  INVALID_REQUEST: 'Choose an exact npm package version.',
  CANCELLED: 'Npm package inspection was cancelled.',
  REGISTRY_UNAVAILABLE: 'The npm registry is unavailable. Retry package inspection.',
  INVALID_METADATA: 'The npm registry returned invalid package metadata.',
  INTEGRITY_FAILED: 'The npm package archive did not match its registry integrity.',
  LICENSE_UNAPPROVED: 'The npm package license is missing or is not approved by this host.',
  BUDGET_EXCEEDED: 'The npm package exceeds the supported inspection limits.',
  UNSAFE_ARCHIVE: 'The npm package contains unsafe or unsupported archive entries.',
  INCOMPATIBLE_PACKAGE:
    'The npm package does not declare a compatible Selene design-system catalog.'
};

export class NpmDesignInputError extends Error {
  public constructor(public readonly code: NpmDesignInputErrorCode) {
    super(messages[code]);
    this.name = 'NpmDesignInputError';
  }
}

export interface NpmPackageReceipt {
  readonly format: 'selene-npm-package-receipt/v1';
  readonly name: string;
  readonly version: string;
  readonly registry: typeof registryOrigin;
  readonly archiveUrl: string;
  readonly integrity: string;
  readonly archiveSha256: string;
  readonly license: string;
  readonly retrievedAt: string;
  readonly fileCount: number;
  readonly unpackedBytes: number;
}

export interface RetrievedNpmPackage {
  readonly packageJson: Readonly<Record<string, unknown>>;
  readonly files: readonly PackageFile[];
  readonly receipt: NpmPackageReceipt;
}

export interface NpmDesignInputAdapterOptions {
  /** Trusted host transport override; package metadata cannot choose a registry or transport. */
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  /** Exact license strings explicitly approved by the host. Defaults to common permissive licenses. */
  readonly allowedLicenses?: readonly string[];
}

function fail(code: NpmDesignInputErrorCode): never {
  throw new NpmDesignInputError(code);
}

function cancelled(context: DesignInputCallContext): void {
  if (context.cancellation.isCancellationRequested()) fail('CANCELLED');
}

function packageRequest(request: DesignPackageRequest): void {
  if (
    !namePattern.test(request.name) ||
    request.name.length > 214 ||
    !versionPattern.test(request.version) ||
    request.version.length > 128 ||
    (request.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(request.expectedSha256))
  )
    fail('INVALID_REQUEST');
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('INVALID_METADATA');
  return value as Record<string, unknown>;
}

function text(value: unknown, maximum = 512): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > maximum)
    fail('INVALID_METADATA');
  return value;
}

function json(bytes: Uint8Array): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    fail('INVALID_METADATA');
  }
  const pending = [{ value: parsed, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (++nodes > DEFAULT_DESIGN_INPUT_LIMITS.maxJsonNodes || current.depth > 32)
      fail('BUDGET_EXCEEDED');
    if (current.value !== null && typeof current.value === 'object') {
      for (const [key, value] of Object.entries(current.value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('INVALID_METADATA');
        pending.push({ value, depth: current.depth + 1 });
      }
      Object.freeze(current.value);
    } else if (typeof current.value === 'number' && !Number.isFinite(current.value)) {
      fail('INVALID_METADATA');
    }
  }
  return object(parsed);
}

async function download(
  transport: typeof fetch,
  context: DesignInputCallContext,
  url: string,
  maximum: number,
  accept: string
): Promise<Buffer> {
  cancelled(context);
  const controller = new AbortController();
  const unsubscribe = context.cancellation.subscribe(() => controller.abort());
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (context.cancellation.isCancellationRequested()) controller.abort();
    const response = await transport(url, {
      redirect: 'error',
      credentials: 'omit',
      headers: { accept },
      signal: controller.signal
    });
    cancelled(context);
    if (!response.ok || response.redirected || !response.body) fail('REGISTRY_UNAVAILABLE');
    if (response.url && response.url !== url) fail('INVALID_METADATA');
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum))
      fail('BUDGET_EXCEEDED');
    reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- The stream byte budget is checked before reading its next chunk.
      const next = await reader.read();
      cancelled(context);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximum) fail('BUDGET_EXCEEDED');
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    cancelled(context);
    if (error instanceof NpmDesignInputError) throw error;
    return fail('REGISTRY_UNAVAILABLE');
  } finally {
    controller.abort();
    unsubscribe();
    try {
      await reader?.cancel();
    } catch {
      // A failed transport cleanup cannot replace the bounded inspection outcome.
    }
    reader?.releaseLock();
  }
}

function verifyIntegrity(archive: Buffer, value: unknown): string {
  const integrity = text(value, 1024);
  const candidates = integrity
    .trim()
    .split(/\s+/)
    .map((token) => {
      const match = /^(sha512|sha256)-([A-Za-z0-9+/]+={0,2})$/.exec(token);
      if (!match?.[1] || !match[2]) fail('INTEGRITY_FAILED');
      const digest = Buffer.from(match[2], 'base64');
      if (
        digest.toString('base64') !== match[2] ||
        digest.length !== (match[1] === 'sha512' ? 64 : 32)
      )
        fail('INTEGRITY_FAILED');
      return { algorithm: match[1], digest };
    });
  const strongest = candidates.some((candidate) => candidate.algorithm === 'sha512')
    ? 'sha512'
    : 'sha256';
  const actual = createHash(strongest).update(archive).digest();
  if (
    !candidates.some(
      (candidate) => candidate.algorithm === strongest && timingSafeEqual(actual, candidate.digest)
    )
  )
    fail('INTEGRITY_FAILED');
  return integrity;
}

function tarString(block: Buffer, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const terminator = field.indexOf(0);
  const value = terminator < 0 ? field : field.subarray(0, terminator);
  if (terminator >= 0 && field.subarray(terminator).some((byte) => byte !== 0))
    fail('UNSAFE_ARCHIVE');
  try {
    return decoder.decode(value);
  } catch {
    fail('UNSAFE_ARCHIVE');
  }
}

function tarNumber(block: Buffer, offset: number, length: number): number {
  const value = block
    .subarray(offset, offset + length)
    .toString('ascii')
    .split('\0')
    .join(' ')
    .trim();
  if (!/^[0-7]+$/.test(value)) fail('UNSAFE_ARCHIVE');
  const result = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(result)) fail('UNSAFE_ARCHIVE');
  return result;
}

function safeArchivePath(path: string): string {
  if (
    path.length > 512 ||
    path.includes('\\') ||
    path.includes('\0') ||
    path
      .split('/')
      .some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(part) || part === '..')
  )
    fail('UNSAFE_ARCHIVE');
  return path;
}

function paxPath(bytes: Buffer): string | undefined {
  let offset = 0;
  let path: string | undefined;
  const seen = new Set<string>();
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0 || space - offset > 8) fail('UNSAFE_ARCHIVE');
    const lengthValue = bytes.subarray(offset, space).toString('ascii');
    if (!/^[1-9]\d*$/.test(lengthValue)) fail('UNSAFE_ARCHIVE');
    const length = Number(lengthValue);
    if (length <= space - offset + 2 || offset + length > bytes.length) fail('UNSAFE_ARCHIVE');
    const record = bytes.subarray(space + 1, offset + length);
    if (record.at(-1) !== 10) fail('UNSAFE_ARCHIVE');
    const equals = record.indexOf(61);
    if (equals < 1) fail('UNSAFE_ARCHIVE');
    const key = record.subarray(0, equals).toString('ascii');
    if (
      seen.has(key) ||
      !['path', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname'].includes(key)
    )
      fail('UNSAFE_ARCHIVE');
    seen.add(key);
    if (key === 'path') {
      try {
        path = decoder.decode(record.subarray(equals + 1, -1));
      } catch {
        fail('UNSAFE_ARCHIVE');
      }
    }
    offset += length;
  }
  return path;
}

function unpack(archive: Buffer): readonly PackageFile[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: maxTarBytes });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE')
      fail('BUDGET_EXCEEDED');
    fail('UNSAFE_ARCHIVE');
  }
  if (tar.length % 512 !== 0) fail('UNSAFE_ARCHIVE');
  const files: PackageFile[] = [];
  const paths = new Set<string>();
  let bytes = 0;
  let entries = 0;
  let pendingPath: string | undefined;
  for (let offset = 0; offset < tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (
        pendingPath !== undefined ||
        tar.length - offset < 1024 ||
        tar.subarray(offset).some((byte) => byte !== 0)
      )
        fail('UNSAFE_ARCHIVE');
      return Object.freeze(files);
    }
    if (++entries > maxEntries) fail('BUDGET_EXCEEDED');
    const expected = tarNumber(header, 148, 8);
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0
    );
    if (checksum !== expected) fail('UNSAFE_ARCHIVE');
    const magic = tarString(header, 257, 6);
    if (magic !== '' && magic !== 'ustar' && magic !== 'ustar ') fail('UNSAFE_ARCHIVE');
    const prefix = magic === 'ustar' ? tarString(header, 345, 155) : '';
    const name = tarString(header, 0, 100);
    const headerPath = prefix === '' ? name : `${prefix}/${name}`;
    const type = header[156];
    const size = tarNumber(header, 124, 12);
    if (size > DEFAULT_DESIGN_INPUT_LIMITS.maxFileBytes) fail('BUDGET_EXCEEDED');
    const end = offset + 512 + size;
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (next > tar.length || tarString(header, 157, 100) !== '') fail('UNSAFE_ARCHIVE');
    const body = tar.subarray(offset + 512, end);
    safeArchivePath(headerPath.replace(/\/$/, ''));
    if (type === 120 || type === 76) {
      if (pendingPath !== undefined || size > 16 * 1024) fail('UNSAFE_ARCHIVE');
      pendingPath = type === 120 ? paxPath(body) : tarString(body, 0, body.length);
      if (pendingPath !== undefined) safeArchivePath(pendingPath.replace(/\/$/, ''));
    } else {
      const path = (pendingPath ?? headerPath).replace(/\/$/, '');
      pendingPath = undefined;
      if (path !== 'package' && !path.startsWith('package/')) fail('UNSAFE_ARCHIVE');
      safeArchivePath(path);
      if (paths.has(path)) fail('UNSAFE_ARCHIVE');
      paths.add(path);
      if (type === 53) {
        if (size !== 0) fail('UNSAFE_ARCHIVE');
      } else if (type === 0 || type === 48) {
        if (path === 'package') fail('UNSAFE_ARCHIVE');
        bytes += size;
        if (
          bytes > DEFAULT_DESIGN_INPUT_LIMITS.maxArtifactBytes ||
          files.length >= DEFAULT_DESIGN_INPUT_LIMITS.maxFiles - 1
        )
          fail('BUDGET_EXCEEDED');
        let content: string;
        try {
          content = decoder.decode(body);
        } catch {
          fail('UNSAFE_ARCHIVE');
        }
        files.push(Object.freeze({ path: `./${path.slice('package/'.length)}`, content }));
      } else {
        fail('UNSAFE_ARCHIVE');
      }
    }
    offset = next;
  }
  fail('UNSAFE_ARCHIVE');
}

function requiredExportFiles(value: unknown, depth = 0): readonly string[] {
  if (depth > 8) fail('INCOMPATIBLE_PACKAGE');
  if (typeof value === 'string') {
    if (!value.startsWith('./')) fail('INCOMPATIBLE_PACKAGE');
    safeArchivePath(value.slice(2));
    return [value];
  }
  const conditions = object(value);
  const keys = Object.keys(conditions);
  if (keys.length === 0 || keys.some((key) => !['import', 'default', 'types'].includes(key)))
    fail('INCOMPATIBLE_PACKAGE');
  return Object.values(conditions).flatMap((target) => requiredExportFiles(target, depth + 1));
}

/** Reads public npm archives as data. It never installs, imports, writes, or evaluates package code. */
export class NpmDesignInputAdapter implements DesignInputPort {
  private readonly transport: typeof fetch;
  private readonly now: () => Date;
  private readonly licenses: ReadonlySet<string>;
  private readonly packages = new Map<string, RetrievedNpmPackage>();

  public constructor(options: NpmDesignInputAdapterOptions = {}) {
    this.transport = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    const licenses = options.allowedLicenses ?? approvedLicenses;
    if (
      licenses.length === 0 ||
      licenses.length > 32 ||
      licenses.some((license) => !/^[A-Za-z0-9.+() -]{1,256}$/.test(license))
    )
      fail('LICENSE_UNAPPROVED');
    this.licenses = new Set(licenses);
  }

  /** The portable loader accepts only a plain, exact method record, not an adapter instance. */
  public port(): DesignInputPort {
    return Object.freeze({
      resolvePackage: (context: DesignInputCallContext, request: DesignPackageRequest) =>
        this.resolvePackage(context, request),
      readDesignLanguage: (context: DesignInputCallContext, request: DesignLanguageRequest) =>
        this.readDesignLanguage(context, request),
      sha256: (context: DesignInputCallContext, value: string) => this.sha256(context, value)
    });
  }

  public async retrievePackage(
    context: DesignInputCallContext,
    request: DesignPackageRequest
  ): Promise<RetrievedNpmPackage> {
    packageRequest(request);
    const metadataUrl = `${registryOrigin}/${encodeURIComponent(request.name)}/${encodeURIComponent(request.version)}`;
    const metadata = json(
      await download(
        this.transport,
        context,
        metadataUrl,
        DEFAULT_DESIGN_INPUT_LIMITS.maxManifestBytes,
        'application/json'
      )
    );
    if (metadata.name !== request.name || metadata.version !== request.version)
      fail('INVALID_METADATA');
    const dist = object(metadata.dist);
    const archiveUrl = text(dist.tarball);
    let archiveLocation: URL;
    try {
      archiveLocation = new URL(archiveUrl);
    } catch {
      fail('INVALID_METADATA');
    }
    if (
      archiveLocation.origin !== registryOrigin ||
      archiveLocation.username ||
      archiveLocation.password ||
      archiveLocation.search ||
      archiveLocation.hash ||
      !archiveLocation.pathname.startsWith('/') ||
      !archiveLocation.pathname.endsWith('.tgz')
    )
      fail('INVALID_METADATA');
    const archive = await download(
      this.transport,
      context,
      archiveUrl,
      maxCompressedBytes,
      'application/octet-stream'
    );
    const integrity = verifyIntegrity(archive, dist.integrity);
    cancelled(context);
    const files = unpack(archive);
    const manifest = files.find((file) => file.path === './package.json');
    if (
      !manifest ||
      Buffer.byteLength(manifest.content) > DEFAULT_DESIGN_INPUT_LIMITS.maxManifestBytes
    )
      fail('INVALID_METADATA');
    const packageJson = json(Buffer.from(manifest.content));
    if (packageJson.name !== request.name || packageJson.version !== request.version)
      fail('INVALID_METADATA');
    if (typeof packageJson.license !== 'string' || packageJson.license.length > 256)
      fail('LICENSE_UNAPPROVED');
    const license = packageJson.license;
    if (
      !this.licenses.has(license) ||
      (metadata.license !== undefined && metadata.license !== license)
    )
      fail('LICENSE_UNAPPROVED');
    if (files.some((file) => file.path === receiptPath)) fail('UNSAFE_ARCHIVE');
    const retrievedAt = this.now().toISOString();
    const receipt: NpmPackageReceipt = Object.freeze({
      format: 'selene-npm-package-receipt/v1',
      name: request.name,
      version: request.version,
      registry: registryOrigin,
      archiveUrl,
      integrity,
      archiveSha256: createHash('sha256').update(archive).digest('hex'),
      license,
      retrievedAt,
      fileCount: files.length,
      unpackedBytes: files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0)
    });
    return Object.freeze({ packageJson: Object.freeze(packageJson), files, receipt });
  }

  public async resolvePackage(
    context: DesignInputCallContext,
    request: DesignPackageRequest
  ): Promise<ResolvedDesignPackage> {
    const retrieved = await this.retrievePackage(context, request);
    const {
      name,
      version,
      peerDependencies,
      exports: exportsValue,
      selene
    } = retrieved.packageJson;
    if (typeof selene !== 'object' || selene === null || Array.isArray(selene))
      fail('INCOMPATIBLE_PACKAGE');
    const metadata = object(selene);
    const designSystem = object(metadata.designSystem);
    if (
      designSystem.schemaVersion !== '1' ||
      !Array.isArray(designSystem.components) ||
      designSystem.components.length === 0
    )
      fail('INCOMPATIBLE_PACKAGE');
    const exports = object(exportsValue);
    const files = new Set(retrieved.files.map((file) => file.path));
    for (const [entrypoint, target] of Object.entries(exports)) {
      if (entrypoint !== '.' && !/^\.\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entrypoint))
        fail('INCOMPATIBLE_PACKAGE');
      for (const path of requiredExportFiles(target))
        if (!files.has(path)) fail('INCOMPATIBLE_PACKAGE');
    }
    if (Object.keys(exports).length === 0 || Object.keys(object(peerDependencies)).length === 0)
      fail('INCOMPATIBLE_PACKAGE');
    const location = `npm:${request.name}@${request.version}`;
    // Content-addressed intake receipts must stay identical across retrieval times.
    const stableReceipt = Object.fromEntries(
      Object.entries(retrieved.receipt).filter(([key]) => key !== 'retrievedAt')
    );
    const receiptFile = Object.freeze({
      path: receiptPath,
      content: `${JSON.stringify(stableReceipt)}\n`
    });
    if (
      retrieved.receipt.unpackedBytes +
        Buffer.byteLength(receiptFile.content) +
        Buffer.byteLength(JSON.stringify({ name, version, peerDependencies, exports, selene })) >
      DEFAULT_DESIGN_INPUT_LIMITS.maxArtifactBytes
    )
      fail('BUDGET_EXCEEDED');
    cancelled(context);
    if (!this.packages.has(location) && this.packages.size >= 4)
      this.packages.delete(this.packages.keys().next().value ?? '');
    this.packages.set(location, retrieved);
    return Object.freeze({
      packageJson: Object.freeze({ name, version, peerDependencies, exports, selene }),
      files: Object.freeze([...retrieved.files, receiptFile]),
      provenance: Object.freeze({
        provider: 'npm-registry',
        location
      })
    });
  }

  public async readDesignLanguage(
    context: DesignInputCallContext,
    request: DesignLanguageRequest
  ): Promise<ResolvedDesignLanguage> {
    cancelled(context);
    const match = /^npm:((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@([^/]+)\/(.+)$/.exec(
      request.location
    );
    if (!match?.[1] || !match[2] || !match[3]) fail('INVALID_REQUEST');
    const location = `npm:${match[1]}@${match[2]}`;
    const path = `./${safeArchivePath(match[3])}`;
    const retrieved =
      this.packages.get(location) ??
      (await this.retrievePackage(context, { name: match[1], version: match[2] }));
    const system = object(object(retrieved.packageJson.selene).designSystem);
    if (path !== system.designLanguagePath) fail('INCOMPATIBLE_PACKAGE');
    const file = retrieved.files.find((candidate) => candidate.path === path);
    if (!file || Buffer.byteLength(file.content) > DEFAULT_DESIGN_INPUT_LIMITS.maxMarkdownBytes)
      fail('INCOMPATIBLE_PACKAGE');
    if (
      request.expectedSha256 !== undefined &&
      createHash('sha256').update(file.content).digest('hex') !== request.expectedSha256
    )
      fail('INTEGRITY_FAILED');
    return Object.freeze({
      markdown: file.content,
      provenance: Object.freeze({
        provider: 'npm-registry',
        location: request.location
      })
    });
  }

  public async sha256(context: DesignInputCallContext, value: string): Promise<string> {
    cancelled(context);
    if (Buffer.byteLength(value) > DEFAULT_DESIGN_INPUT_LIMITS.maxArtifactBytes)
      fail('BUDGET_EXCEEDED');
    return createHash('sha256').update(value).digest('hex');
  }
}

export function createNpmDesignInputPort(
  options: NpmDesignInputAdapterOptions = {}
): DesignInputPort {
  return new NpmDesignInputAdapter(options).port();
}
