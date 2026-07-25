import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

import { parsePrototypeGraph, type PrototypeGraph } from '@selene/core';

export interface PersistedPrototypeGraph {
  readonly revision: number;
  readonly graph: PrototypeGraph;
}

/** Main-owned CAS boundary; renderers submit data but never select a disk path. */
export interface PrototypeGraphPersistencePort {
  read(projectId: string): Promise<PersistedPrototypeGraph | undefined>;
  compareAndSwap(projectId: string, expectedRevision: number, graph: PrototypeGraph): Promise<PersistedPrototypeGraph>;
}

export class PrototypeGraphConflictError extends Error {
  public readonly code = 'GRAPH_CONFLICT' as const;
  public constructor() { super('The flow graph changed in another workspace. Reload and retry.'); }
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
  public constructor(private readonly directory: string) {}
  private path(projectId: string): string {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(projectId)) throw new Error('project ID is invalid');
    const root = resolve(this.directory); const candidate = resolve(root, `${encodeURIComponent(projectId)}.json`);
    if (relative(root, candidate).startsWith('..')) throw new Error('project path escaped persistence root');
    return candidate;
  }
  public async read(projectId: string): Promise<PersistedPrototypeGraph | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.path(projectId), 'utf8')) as PersistedPrototypeGraph;
      if (!Number.isSafeInteger(parsed.revision) || parsed.revision < 1) throw new Error('invalid graph revision');
      return { revision: parsed.revision, graph: parsePrototypeGraph(parsed.graph) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  public async compareAndSwap(projectId: string, expectedRevision: number, graph: PrototypeGraph): Promise<PersistedPrototypeGraph> {
    return graphLock(this.path(projectId), async () => {
      const current = await this.read(projectId);
      if ((current?.revision ?? 0) !== expectedRevision) throw new PrototypeGraphConflictError();
      const next = { revision: expectedRevision + 1, graph: parsePrototypeGraph(graph) };
      const path = this.path(projectId); await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`; const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(next), 'utf8'); await file.sync(); } finally { await file.close(); }
      try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
      return next;
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
