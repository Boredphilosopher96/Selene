import { constants } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

import { parsePrototypeGraph, type PrototypeGraph } from '@selene/core';

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
    message: string
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
      const recoveryId = `graph-recovery-${randomUUID()}`;
      const recovery = this.recoveryPath(projectId, recoveryId);
      try {
        await mkdir(dirname(recovery), { recursive: true, mode: 0o700 });
        await rename(path, recovery);
      } catch (error) {
        if (error instanceof PrototypeGraphPersistenceError) throw error;
        throw new PrototypeGraphPersistenceError('GRAPH_PERSISTENCE_READ', 'Saved graph cannot be preserved for recovery.');
      }
      // Rename is the recovery boundary. Evidence is bounded, while the
      // immutable quarantine remains intact if fixture replacement fails.
      const evidence = await this.recoveryEvidence(recovery);
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
      await this.writeAtomically(path, JSON.stringify(saved));
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

export type GitHubPublishErrorCode = 'OFFLINE' | 'AUTH_REQUIRED' | 'CONFLICT' | 'CANCELLED';
export class GitHubPublishError extends Error {
  public constructor(public readonly code: GitHubPublishErrorCode, message: string) { super(message); }
}
export interface GeneratedCodePublishRequest {
  readonly repository: string;
  readonly title: string;
  readonly consent: { readonly publishGeneratedCode: true; readonly hostedReview: true };
  readonly graphRevision: number;
}
export interface GeneratedCodePublishReceipt {
  readonly kind: 'local-preview' | 'remote';
  readonly status: 'ready-for-review' | 'published';
  readonly repository: string;
  readonly ref: string;
  readonly commitOrPullRequestUrl: string;
  readonly hostedReviewUrl: string;
  readonly immutableId: string;
}
export interface GeneratedCodePublishPort {
  readonly receiptKind: 'local-preview' | 'remote';
  publish(request: GeneratedCodePublishRequest, options: { readonly signal: AbortSignal; readonly progress: (message: string) => void }): Promise<GeneratedCodePublishReceipt>;
}
export interface TrustedPublishConsentPort {
  request(binding: PublishConsentBinding): Promise<{ readonly consentId: string }>;
  consume(consentId: string, binding: PublishConsentBinding): Promise<void>;
}
export interface PublishConsentBinding { readonly repository: string; readonly title: string; readonly projectId: string; readonly graphRevision: number; readonly adapterKind: 'local-preview' | 'remote'; }
export function publishConsentDigest(binding: PublishConsentBinding): string { return createHash('sha256').update(JSON.stringify(binding)).digest('hex'); }
export class FixturePublishConsentPort implements TrustedPublishConsentPort {
  private readonly grants = new Map<string, string>();
  public async request(binding: PublishConsentBinding): Promise<{ readonly consentId: string }> {
    const consentId = `local-consent-${crypto.randomUUID()}`;
    this.grants.set(consentId, publishConsentDigest(binding));
    return { consentId };
  }
  public async consume(consentId: string, binding: PublishConsentBinding): Promise<void> {
    if (this.grants.get(consentId) !== publishConsentDigest(binding)) throw new GitHubPublishError('AUTH_REQUIRED', 'Explicit host publish consent is required.');
    this.grants.delete(consentId);
  }
}

/** Development-only, adapter-swappable host fixture; it never claims that a remote publish occurred. */
export class DeterministicLocalPublishAdapter implements GeneratedCodePublishPort {
  public readonly receiptKind = 'local-preview' as const;
  public async publish(request: GeneratedCodePublishRequest, options: { readonly signal: AbortSignal; readonly progress: (message: string) => void }): Promise<GeneratedCodePublishReceipt> {
    if (options.signal.aborted) throw new GitHubPublishError('CANCELLED', 'Publish cancelled.');
    options.progress('Preparing an immutable local publish receipt.');
    await Promise.resolve();
    if (options.signal.aborted) throw new GitHubPublishError('CANCELLED', 'Publish cancelled.');
    const ref = `selene/generated/flow-r${request.graphRevision}`;
    const immutableId = `local-${request.graphRevision}-${request.repository.replace(/[^A-Za-z0-9]/g, '-')}`;
    return { kind: 'local-preview', status: 'ready-for-review', repository: request.repository, ref, immutableId, commitOrPullRequestUrl: `local-review://${immutableId}`, hostedReviewUrl: `local-review://${immutableId}/threads` };
  }
}
