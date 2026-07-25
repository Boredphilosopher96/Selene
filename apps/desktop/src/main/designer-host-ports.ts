import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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
  public constructor() { super('The flow graph changed in another workspace. Reload and retry.'); }
}

export class JsonPrototypeGraphPersistencePort implements PrototypeGraphPersistencePort {
  public constructor(private readonly directory: string) {}
  public async read(projectId: string): Promise<PersistedPrototypeGraph | undefined> {
    try {
      const parsed = JSON.parse(await readFile(join(this.directory, `${projectId}.json`), 'utf8')) as PersistedPrototypeGraph;
      if (!Number.isSafeInteger(parsed.revision) || parsed.revision < 1) throw new Error('invalid graph revision');
      return { revision: parsed.revision, graph: parsePrototypeGraph(parsed.graph) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  public async compareAndSwap(projectId: string, expectedRevision: number, graph: PrototypeGraph): Promise<PersistedPrototypeGraph> {
    const current = await this.read(projectId);
    if ((current?.revision ?? 0) !== expectedRevision) throw new PrototypeGraphConflictError();
    const next = { revision: expectedRevision + 1, graph: parsePrototypeGraph(graph) };
    const path = join(this.directory, `${projectId}.json`);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
    return next;
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
  publish(request: GeneratedCodePublishRequest, options: { readonly signal: AbortSignal; readonly progress: (message: string) => void }): Promise<GeneratedCodePublishReceipt>;
}
export interface TrustedPublishConsentPort {
  request(scope: 'publish-generated-code'): Promise<{ readonly consentId: string }>;
  consume(consentId: string, scope: 'publish-generated-code'): Promise<void>;
}
export class LocalTrustedPublishConsentPort implements TrustedPublishConsentPort {
  private readonly grants = new Set<string>();
  public async request(): Promise<{ readonly consentId: string }> {
    const consentId = `local-consent-${crypto.randomUUID()}`;
    this.grants.add(consentId);
    return { consentId };
  }
  public async consume(consentId: string): Promise<void> {
    if (!this.grants.delete(consentId)) throw new GitHubPublishError('AUTH_REQUIRED', 'Explicit host publish consent is required.');
  }
}

/** Development-only, adapter-swappable host fixture; it never claims that a remote publish occurred. */
export class DeterministicLocalPublishAdapter implements GeneratedCodePublishPort {
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
