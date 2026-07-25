import { constants } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

import { parsePrototypeGraph, validateReactSourceWorkspace, type EnterpriseScenario, type PrototypeGraph, type ReactSourceWorkspace } from '@selene/core';
import { parseSnapshot } from '@selene/collaboration';
import type { GeneratedCodePublishReceipt } from '../shared/designer-api';
import type { GeneratedProjectFilePlan } from './generated-project-template';

export interface PersistedPrototypeGraph {
  readonly revision: number;
  readonly graph: PrototypeGraph;
}

export interface PrototypeGraphRecoveryReceipt {
  readonly recoveryId: string;
  readonly originalBytes: number;
  readonly capturedBytes: number;
  readonly capturedSha256: string;
}

/** Main-owned CAS boundary; renderers submit data but never select a disk path. */
export interface PrototypeGraphPersistencePort {
  read(projectId: string): Promise<PersistedPrototypeGraph | undefined>;
  compareAndSwap(projectId: string, expectedRevision: number, graph: PrototypeGraph): Promise<PersistedPrototypeGraph>;
  recoverFromFixture(projectId: string, graph: PrototypeGraph): Promise<{
    readonly saved: PersistedPrototypeGraph;
    readonly receipt: PrototypeGraphRecoveryReceipt;
  }>;
}

export class PrototypeGraphConflictError extends Error {
  public readonly code = 'GRAPH_CONFLICT' as const;
  public constructor() { super('The flow graph changed in another workspace. Reload and retry.'); }
}

export class PrototypeGraphPersistenceError extends Error {
  public constructor(
    public readonly code:
      | 'GRAPH_PERSISTENCE_READ'
      | 'GRAPH_PERSISTENCE_CORRUPT'
      | 'GRAPH_PERSISTENCE_UNSAFE',
    message: string,
    public readonly recoveryId?: string
  ) {
    super(message);
  }
}

const graphLocks = new Map<string, Promise<void>>();
async function graphLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prior = graphLocks.get(key) ?? Promise.resolve(); let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const chain = prior.then(() => gate);
  graphLocks.set(key, chain);
  await prior; try { return await work(); } finally { release(); if (graphLocks.get(key) === chain) graphLocks.delete(key); }
}

export class JsonPrototypeGraphPersistencePort implements PrototypeGraphPersistencePort {
  private static readonly maxGraphBytes = 256 * 1024;
  public constructor(private readonly directory: string) {}
  private path(projectId: string): string {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(projectId)) throw new Error('project ID is invalid');
    const root = resolve(this.directory); const candidate = resolve(root, `${encodeURIComponent(projectId)}.json`);
    if (relative(root, candidate).startsWith('..')) throw new Error('project path escaped persistence root');
    return candidate;
  }
  private recoveryPath(projectId: string, recoveryId: string): string {
    const root = resolve(this.directory, 'recovery');
    const candidate = resolve(root, `${encodeURIComponent(projectId)}-${recoveryId}.json`);
    if (relative(root, candidate).startsWith('..')) throw new Error('recovery path escaped persistence root');
    return candidate;
  }
  private recoveryMarkerPath(projectId: string): string {
    const root = resolve(this.directory, 'recovery');
    const candidate = resolve(root, `${encodeURIComponent(projectId)}.pending.json`);
    if (relative(root, candidate).startsWith('..')) throw new Error('recovery marker escaped persistence root');
    return candidate;
  }
  private static isRecoveryId(value: unknown): value is string {
    return typeof value === 'string' && /^graph-recovery-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
  }
  private async writeAtomically(path: string, value: string, directoryMode = 0o700): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: directoryMode });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(value, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  private async openNoFollow(path: string) {
    if (typeof constants.O_NOFOLLOW !== 'number')
      throw new PrototypeGraphPersistenceError('GRAPH_PERSISTENCE_UNSAFE', 'This platform cannot safely open saved graph files.');
    try {
      return await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ELOOP' || code === 'ENOTSUP' || code === 'EOPNOTSUPP')
        throw new PrototypeGraphPersistenceError('GRAPH_PERSISTENCE_UNSAFE', 'Saved graph path is unsafe or no-follow is unsupported.');
      throw error;
    }
  }
  private async boundedRaw(path: string): Promise<{ readonly bytes: Buffer; readonly originalBytes: number }> {
    const file = await this.openNoFollow(path);
    try {
      const metadata = await file.stat();
      if (!metadata.isFile())
        throw new PrototypeGraphPersistenceError('GRAPH_PERSISTENCE_CORRUPT', 'Saved graph is not a regular file.');
      if (metadata.size > JsonPrototypeGraphPersistencePort.maxGraphBytes)
        throw new PrototypeGraphPersistenceError('GRAPH_PERSISTENCE_CORRUPT', 'Saved graph exceeds the 256 KiB parsing limit.');
      const bytes = Buffer.alloc(metadata.size);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== bytes.length)
        throw new PrototypeGraphPersistenceError('GRAPH_PERSISTENCE_READ', 'Saved graph changed while being read.');
      return { bytes, originalBytes: metadata.size };
    } finally {
      await file.close();
    }
  }
  private async recoveryMarker(projectId: string): Promise<{ readonly recoveryId: string } | undefined> {
    try {
      const raw = await this.boundedRaw(this.recoveryMarkerPath(projectId));
      const value = JSON.parse(raw.bytes.toString('utf8')) as unknown;
      if (
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        Object.keys(value).length !== 3 ||
        (value as Record<string, unknown>).format !== 'selene-prototype-graph-recovery/v1' ||
        (value as Record<string, unknown>).projectId !== projectId ||
        !JsonPrototypeGraphPersistencePort.isRecoveryId((value as Record<string, unknown>).recoveryId)
      )
        throw new PrototypeGraphPersistenceError('GRAPH_PERSISTENCE_CORRUPT', 'Saved graph recovery marker is invalid.');
      return { recoveryId: (value as Record<string, unknown>).recoveryId as string };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof PrototypeGraphPersistenceError) throw error;
      throw new PrototypeGraphPersistenceError('GRAPH_PERSISTENCE_READ', 'Saved graph recovery status could not be read.');
    }
  }
  private async recoveryEvidence(path: string): Promise<{
    readonly prefix: Buffer;
    readonly originalBytes: number;
    readonly sha256: string;
  }> {
    const file = await this.openNoFollow(path);
    try {
      const metadata = await file.stat();
      if (!metadata.isFile())
        throw new PrototypeGraphPersistenceError('GRAPH_PERSISTENCE_CORRUPT', 'Recovered graph is not a regular file.');
      const prefix = Buffer.alloc(Math.min(metadata.size, JsonPrototypeGraphPersistencePort.maxGraphBytes));
      const first = await file.read(prefix, 0, prefix.length, 0);
      if (first.bytesRead !== prefix.length)
        throw new PrototypeGraphPersistenceError('GRAPH_PERSISTENCE_READ', 'Recovered graph changed while being recorded.');
      const hash = createHash('sha256');
      const chunk = Buffer.alloc(64 * 1024);
      for (let offset = 0; offset < metadata.size; offset += chunk.length) {
        const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, metadata.size - offset), offset);
        if (bytesRead === 0)
          throw new PrototypeGraphPersistenceError('GRAPH_PERSISTENCE_READ', 'Recovered graph changed while hashing.');
        hash.update(chunk.subarray(0, bytesRead));
      }
      return { prefix, originalBytes: metadata.size, sha256: hash.digest('hex') };
    } finally {
      await file.close();
    }
  }
  public async read(projectId: string): Promise<PersistedPrototypeGraph | undefined> {
    try {
      const marker = await this.recoveryMarker(projectId);
      if (marker)
        throw new PrototypeGraphPersistenceError(
          'GRAPH_PERSISTENCE_CORRUPT',
          'Saved graph recovery is incomplete and requires explicit attention.',
          marker.recoveryId
        );
      const raw = await this.boundedRaw(this.path(projectId));
      const parsed = JSON.parse(raw.bytes.toString('utf8')) as PersistedPrototypeGraph;
      if (!Number.isSafeInteger(parsed.revision) || parsed.revision < 1)
        throw new PrototypeGraphPersistenceError('GRAPH_PERSISTENCE_CORRUPT', 'Saved graph revision is invalid.');
      try {
        return { revision: parsed.revision, graph: parsePrototypeGraph(parsed.graph) };
      } catch {
        throw new PrototypeGraphPersistenceError('GRAPH_PERSISTENCE_CORRUPT', 'Saved graph contents are invalid.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof PrototypeGraphPersistenceError) throw error;
      throw new PrototypeGraphPersistenceError('GRAPH_PERSISTENCE_READ', 'Saved graph could not be read.');
    }
  }
  public async compareAndSwap(projectId: string, expectedRevision: number, graph: PrototypeGraph): Promise<PersistedPrototypeGraph> {
    return graphLock(this.path(projectId), async () => {
      const current = await this.read(projectId);
      if ((current?.revision ?? 0) !== expectedRevision) throw new PrototypeGraphConflictError();
      const next = { revision: expectedRevision + 1, graph: parsePrototypeGraph(graph) };
      await this.writeAtomically(this.path(projectId), JSON.stringify(next));
      return next;
    });
  }
  public async recoverFromFixture(projectId: string, graph: PrototypeGraph): Promise<{ readonly saved: PersistedPrototypeGraph; readonly receipt: PrototypeGraphRecoveryReceipt }> {
    const path = this.path(projectId);
    return graphLock(path, async () => {
      const prior = await this.recoveryMarker(projectId);
      const recoveryId = prior?.recoveryId ?? `graph-recovery-${randomUUID()}`;
      const recovery = this.recoveryPath(projectId, recoveryId);
      const markerPath = this.recoveryMarkerPath(projectId);
      if (!prior) {
        await mkdir(dirname(recovery), { recursive: true, mode: 0o700 });
        await this.writeAtomically(
          markerPath,
          JSON.stringify({
            format: 'selene-prototype-graph-recovery/v1',
            projectId,
            recoveryId
          }),
          0o700
        );
      }
      // A marker can survive a process interruption before its initial rename.
      // Resume only renames if the validated quarantine is not already present.
      let evidence: { readonly prefix: Buffer; readonly originalBytes: number; readonly sha256: string };
      try {
        evidence = await this.recoveryEvidence(recovery);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        try {
          await rename(path, recovery);
        } catch {
          throw new PrototypeGraphPersistenceError(
            'GRAPH_PERSISTENCE_READ',
            'Saved graph recovery is pending; its active artifact could not be quarantined.',
            recoveryId
          );
        }
        evidence = await this.recoveryEvidence(recovery);
      }
      // Rename is the recovery boundary. Evidence is bounded, while the
      // immutable quarantine remains intact if fixture replacement fails.
      await this.writeAtomically(
        `${recovery}.receipt.json`,
        JSON.stringify({
          recoveryId,
          originalBytes: evidence.originalBytes,
          capturedBytes: evidence.prefix.byteLength,
          capturedSha256: evidence.sha256,
          capturedPrefixBase64: evidence.prefix.toString('base64')
        }),
        0o700
      );
      const saved = { revision: 1, graph: parsePrototypeGraph(graph) };
      try {
        await this.writeAtomically(path, JSON.stringify(saved));
      } catch (error) {
        // The marker and quarantine remain durable, so the next open cannot
        // mistake this interrupted recovery for a missing project.
        throw error;
      }
      await rm(markerPath, { force: true });
      return {
        saved,
        receipt: {
          recoveryId,
          originalBytes: evidence.originalBytes,
          capturedBytes: evidence.prefix.byteLength,
          capturedSha256: evidence.sha256
        }
      };
    });
  }
}

export type PublishAdapterErrorCode = 'OFFLINE' | 'AUTH_REQUIRED' | 'CONFLICT' | 'CANCELLED' | 'CLEANUP_FAILED' | 'TOOL_UNAVAILABLE' | 'TIMEOUT' | 'PROCESS_FAILED' | 'PROCESS_ORPHANED' | 'INTEGRITY';
export class PublishAdapterError extends Error {
  public constructor(public readonly code: PublishAdapterErrorCode, message: string) { super(message); }
}
export interface ImmutablePublishBundleInput {
  readonly projectId: string;
  readonly source: ReactSourceWorkspace;
  readonly prototype: { readonly graph: PrototypeGraph; readonly revision: number };
  readonly scenarios: readonly EnterpriseScenario[];
  /** Canonical collaboration v2 serialization is the single review/pin/baseline truth. */
  readonly collaborationSnapshot: string;
  /** Versioned, current-workspace staging receipts; they are inert provenance, never package code. */
  readonly designInputProvenance: {
    readonly format: 'selene-desktop-current-workspace-design-inputs/v1';
    readonly projectId: string;
    readonly designSystem?: { readonly status: 'staged'; readonly packageName: string; readonly version: string; readonly exports: readonly string[]; readonly peerCompatibility: 'compatible'; readonly provenance: { readonly provider: string; readonly location: string }; readonly artifactDigest: string; readonly fixture?: string };
    readonly designLanguage?: { readonly status: 'staged'; readonly provenance: { readonly provider: string; readonly location: string }; readonly artifactDigest: string; readonly sectionCount: number };
  };
  readonly componentCatalog: { readonly entries: readonly { readonly component: string; readonly href: string }[] };
  readonly packageProvenance: {
    readonly packageManager: string;
    readonly lockfile: { readonly path: string; readonly checksum: string };
    readonly packages: readonly { readonly name: string; readonly version: string }[];
    readonly dependencies: readonly { readonly name: string; readonly version: string }[];
  };
}
export interface ImmutablePublishBundle extends ImmutablePublishBundleInput {
  readonly format: 'selene-generated-code-publish-bundle/v1';
  readonly sourceRevisionId: string;
  readonly graphRevision: number;
  readonly bundleDigest: string;
  readonly immutableId: string;
}
function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('immutable publish bundle cannot contain a non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'undefined' || typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol')
    throw new Error('immutable publish bundle must contain only JSON data');
  if (seen.has(value)) throw new Error('immutable publish bundle cannot contain cycles');
  seen.add(value);
  if (Array.isArray(value)) {
    const serialized = `[${value.map((entry) => canonicalJson(entry, seen)).join(',')}]`;
    seen.delete(value);
    return serialized;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw new Error('immutable publish bundle must contain plain data objects');
  const record = value as Record<string, unknown>;
  const serialized = `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return serialized;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
/** Canonical serialization prevents adapter-specific or mutable publish payloads. */
export function serializeImmutablePublishBundle(bundle: Omit<ImmutablePublishBundle, 'bundleDigest' | 'immutableId'>): string {
  return canonicalJson(bundle);
}
function validateImmutablePublishBundleInput(input: ImmutablePublishBundleInput): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.projectId)) throw new Error('publish bundle project ID is invalid');
  validateReactSourceWorkspace(input.source);
  if (input.source.projectId !== input.projectId) throw new Error('publish bundle workspace project does not match project ID');
  if (!Number.isSafeInteger(input.prototype.revision) || input.prototype.revision < 0) throw new Error('publish bundle graph revision is invalid');
  parsePrototypeGraph(input.prototype.graph);
  if (!Array.isArray(input.scenarios) || input.scenarios.length > 256) throw new Error('publish bundle scenarios are invalid');
  const collaboration = parseSnapshot(input.collaborationSnapshot);
  if (collaboration.project.id !== input.projectId) throw new Error('publish bundle collaboration project does not match project ID');
  if (input.designInputProvenance.format !== 'selene-desktop-current-workspace-design-inputs/v1' || input.designInputProvenance.projectId !== input.projectId)
    throw new Error('publish bundle design-input provenance does not match the current project');
  const digest = (value: unknown, name: string) => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`publish bundle ${name} digest is invalid`); };
  const text = (value: unknown, name: string, maximum: number) => { if (typeof value !== 'string' || value.length === 0 || value.length > maximum) throw new Error(`publish bundle ${name} is invalid`); };
  const stagedSystem = input.designInputProvenance.designSystem;
  if (stagedSystem !== undefined) {
    if (stagedSystem.status !== 'staged' || stagedSystem.peerCompatibility !== 'compatible') throw new Error('publish bundle design-system receipt is invalid');
    text(stagedSystem.packageName, 'design-system package name', 256); text(stagedSystem.version, 'design-system version', 128); digest(stagedSystem.artifactDigest, 'design-system');
    if (!Array.isArray(stagedSystem.exports) || stagedSystem.exports.length > 1_024) throw new Error('publish bundle design-system exports are invalid');
    for (const entry of stagedSystem.exports) text(entry, 'design-system export', 512);
    text(stagedSystem.provenance.provider, 'design-system provider', 256); text(stagedSystem.provenance.location, 'design-system location', 2_048);
    if (stagedSystem.fixture !== undefined) text(stagedSystem.fixture, 'design-system fixture', 256);
  }
  const stagedLanguage = input.designInputProvenance.designLanguage;
  if (stagedLanguage !== undefined) {
    if (stagedLanguage.status !== 'staged') throw new Error('publish bundle design-language receipt is invalid');
    digest(stagedLanguage.artifactDigest, 'design-language'); text(stagedLanguage.provenance.provider, 'design-language provider', 256); text(stagedLanguage.provenance.location, 'design-language location', 2_048);
    if (!Number.isSafeInteger(stagedLanguage.sectionCount) || stagedLanguage.sectionCount < 0 || stagedLanguage.sectionCount > 65_536) throw new Error('publish bundle design-language section count is invalid');
  }
  if (!Array.isArray(input.componentCatalog.entries) || input.componentCatalog.entries.length > 4_096) throw new Error('publish bundle component catalog is invalid');
  for (const entry of input.componentCatalog.entries)
    if (!entry || typeof entry.component !== 'string' || entry.component.length === 0 || entry.component.length > 256 || typeof entry.href !== 'string' || entry.href.length > 2_048)
      throw new Error('publish bundle component catalog entry is invalid');
  text(input.packageProvenance.packageManager, 'package manager', 128);
  text(input.packageProvenance.lockfile.path, 'lockfile path', 2_048);
  if (!/^[a-f0-9]{64}$/.test(input.packageProvenance.lockfile.checksum)) throw new Error('publish bundle lockfile checksum is invalid');
  const packageList = (entries: readonly { readonly name: string; readonly version: string }[], name: string) => {
    if (!Array.isArray(entries) || entries.length > 16_384) throw new Error(`publish bundle ${name} is invalid`);
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') throw new Error(`publish bundle ${name} entry is invalid`);
      text(entry.name, `${name} package name`, 256);
      text(entry.version, `${name} package version`, 128);
    }
  };
  packageList(input.packageProvenance.packages, 'packages');
  packageList(input.packageProvenance.dependencies, 'dependencies');
  canonicalJson(input);
}
export function createImmutablePublishBundle(input: ImmutablePublishBundleInput): ImmutablePublishBundle {
  const snapshot = structuredClone(input);
  validateImmutablePublishBundleInput(snapshot);
  const content = {
    format: 'selene-generated-code-publish-bundle/v1' as const,
    ...snapshot,
    sourceRevisionId: snapshot.source.revision.id,
    graphRevision: snapshot.prototype.revision
  };
  const bundleDigest = createHash('sha256').update(serializeImmutablePublishBundle(content)).digest('hex');
  return deepFreeze({ ...content, bundleDigest, immutableId: `bundle-sha256-${bundleDigest}` });
}
export type GeneratedCodePublishRequest =
  | {
  /** A local capture is intentionally repository-free and cannot impersonate a remote outcome. */
  readonly mode: 'local-preview';
  readonly title: string;
  readonly bundle: ImmutablePublishBundle;
  readonly plan: GeneratedProjectFilePlan;
  readonly repository?: never;
}
  | {
  readonly mode: 'github-remote';
  readonly repository: string;
  readonly title: string;
  readonly bundle: ImmutablePublishBundle;
  readonly plan: GeneratedProjectFilePlan;
  readonly provisioning?: import('../shared/designer-api').GitHubRepositoryProvisioningInput;
};
export interface GeneratedCodePublishPort {
  /** Stable host composition identity; never renderer-controlled. */
  readonly id: string;
  readonly mode: 'local-preview' | 'github-remote';
  publish(request: GeneratedCodePublishRequest, options: { readonly signal: AbortSignal; readonly progress: (message: string) => void }): Promise<GeneratedCodePublishReceipt>;
}
/** Main-process composition selects a capability by explicit mode; renderers never receive adapters. */
export class PublishAdapterRegistry {
  private readonly adapters = new Map<GeneratedCodePublishPort['mode'], GeneratedCodePublishPort>();
  public constructor(adapters: readonly GeneratedCodePublishPort[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.mode)) throw new Error(`duplicate publish adapter mode: ${adapter.mode}`);
      this.adapters.set(adapter.mode, adapter);
    }
  }
  public select(mode: GeneratedCodePublishPort['mode']): GeneratedCodePublishPort {
    const adapter = this.adapters.get(mode);
    if (!adapter) throw new PublishAdapterError('CONFLICT', `No host publish adapter is configured for ${mode}.`);
    return adapter;
  }
}
export interface TrustedPublishConsentPort {
  request(binding: PublishConsentBinding): Promise<{ readonly consentId: string; readonly expiresAt: number }>;
  consume(consentId: string, binding: PublishConsentBinding): Promise<void>;
}
export type PublishConsentBinding =
  | {
  readonly mode: 'local-preview';
  readonly title: string;
  readonly projectId: string;
  readonly sourceRevisionId: string;
  readonly graphRevision: number;
  readonly bundleDigest: string;
  readonly filePlanDigest: string;
  readonly adapterId: string;
  readonly repository?: never;
}
  | {
  readonly mode: 'github-remote';
  readonly repository: string;
  readonly title: string;
  readonly projectId: string;
  readonly sourceRevisionId: string;
  readonly graphRevision: number;
  readonly bundleDigest: string;
  readonly filePlanDigest: string;
  readonly adapterId: string;
  readonly provisioning?: import('../shared/designer-api').GitHubRepositoryProvisioningInput;
};
/** Consent is bound to canonical data, not JS insertion order or optional undefined fields. */
export function publishConsentDigest(binding: PublishConsentBinding): string { return createHash('sha256').update(canonicalJson(binding)).digest('hex'); }
export class FixturePublishConsentPort implements TrustedPublishConsentPort {
  private readonly grants = new Map<string, string>();
  public async request(binding: PublishConsentBinding): Promise<{ readonly consentId: string; readonly expiresAt: number }> {
    const consentId = `local-consent-${crypto.randomUUID()}`;
    this.grants.set(consentId, publishConsentDigest(binding));
    return { consentId, expiresAt: Date.now() + 10 * 60_000 };
  }
  public async consume(consentId: string, binding: PublishConsentBinding): Promise<void> {
    if (this.grants.get(consentId) !== publishConsentDigest(binding)) throw new PublishAdapterError('AUTH_REQUIRED', 'Explicit host publish consent is required.');
    this.grants.delete(consentId);
  }
}

/** Development-only, adapter-swappable host fixture; it validates only and retains no output. */
export class DeterministicLocalPublishAdapter implements GeneratedCodePublishPort {
  public readonly id = 'deterministic-local-bundle-v1';
  public readonly mode = 'local-preview' as const;
  public async publish(request: GeneratedCodePublishRequest, options: { readonly signal: AbortSignal; readonly progress: (message: string) => void }): Promise<GeneratedCodePublishReceipt> {
    if (request.mode !== this.mode) throw new PublishAdapterError('CONFLICT', 'The selected publish adapter does not support this mode.');
    if (options.signal.aborted) throw new PublishAdapterError('CANCELLED', 'Publish cancelled.');
    options.progress('Fixture-validated the immutable local publish bundle without project materialization.');
    await Promise.resolve();
    if (options.signal.aborted) throw new PublishAdapterError('CANCELLED', 'Publish cancelled.');
    const artifactDigest = createHash('sha256').update(`${request.bundle.bundleDigest}\u0000${request.plan.filePlanDigest}\u0000fixture`).digest('hex');
    return { mode: 'local-preview', status: 'local-bundle-validated', bundleDigest: request.bundle.bundleDigest, filePlanDigest: request.plan.filePlanDigest, artifactDigest, validation: 'fixture', immutableId: request.bundle.immutableId };
  }
}
