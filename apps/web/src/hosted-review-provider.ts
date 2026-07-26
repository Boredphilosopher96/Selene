import {
  createHostedReviewCollaboration,
  canonicalArtifactPinId,
  reviewStorageKey,
  type ArtifactAnchor,
  type ReviewArtifactBinding,
  type ReviewStoragePort,
  type ReviewThread
} from './hosted-review-collaboration';
import {
  validateHostedReviewBinding,
  validateHostedReviewOperation,
  validateHostedReviewThread,
  type HostedReviewActor,
  type HostedReviewBinding,
  type HostedReviewOperationResult,
  type HostedReviewProviderPort,
  type HostedReviewProviderState,
  type HostedReviewThread
} from '@selene/collaboration/hosted-review';
import type { CollaborationHostContext } from '@selene/collaboration';

const localActor: HostedReviewActor = Object.freeze({
  id: 'browser-local-reviewer',
  displayName: 'Local reviewer'
});
const recordFormat = 'selene-browser-review-provider/v1';
const maxReceipts = 100;
const maxRecordBytes = 256 * 1024;
const maxCompletedBytes = 128 * 1024;
const utf8 = new TextEncoder();

export const browserLocalHostedReviewState: HostedReviewProviderState = Object.freeze({
  provider: 'browser-local',
  identity: 'local-only',
  sync: 'offline'
});

export function browserLocalHostedReviewBinding(input: {
  readonly tenantId: string;
  readonly projectId: string;
  readonly artifactId: string;
  readonly revisionId: string;
  readonly baselineId: string;
  readonly version: number;
}): HostedReviewBinding {
  const binding: HostedReviewBinding = { ...input };
  validateHostedReviewBinding(binding);
  return Object.freeze(binding);
}

function legacyBinding(binding: HostedReviewBinding): ReviewArtifactBinding {
  return {
    projectId: binding.projectId,
    artifactId: binding.artifactId,
    revisionId: binding.revisionId,
    baselineId: binding.baselineId
  };
}

function localVersion(thread: ReviewThread): number {
  return thread.version ?? thread.messages.length + (thread.status === 'resolved' ? 1 : 0);
}

function asHosted(thread: ReviewThread, binding: HostedReviewBinding): HostedReviewThread {
  return {
    id: thread.id,
    binding,
    anchor: thread.pin.anchor,
    replies: thread.messages.map((message, index) => ({
      id: message.id,
      body: message.body,
      actor: localActor,
      createdAt: message.createdAt,
      version: index + 1
    })),
    lifecycle: thread.status,
    actor: localActor,
    createdAt: thread.messages[0]?.createdAt ?? new Date(0).toISOString(),
    version: localVersion(thread),
    ...(thread.resolvedAt === undefined
      ? {}
      : { resolvedAt: thread.resolvedAt, resolvedBy: localActor })
  };
}

export function browserLocalReviewThread(thread: HostedReviewThread): ReviewThread {
  const id = orderId(thread.anchor) ?? 'unavailable-order';
  const pinInput = {
    ...legacyBinding(thread.binding),
    orderId: id,
    anchor: thread.anchor
  };
  return {
    id: thread.id,
    version: thread.version,
    pin: { id: canonicalArtifactPinId(pinInput), ...pinInput },
    messages: thread.replies.map((reply) => ({
      id: reply.id,
      author: reply.actor.displayName,
      body: reply.body,
      createdAt: reply.createdAt
    })),
    status: thread.lifecycle,
    ...(thread.resolvedAt === undefined ? {} : { resolvedAt: thread.resolvedAt })
  };
}

function orderId(anchor: ArtifactAnchor): string | undefined {
  return anchor.selector.match(/\[data-review-order="([^"]+)"\]/)?.[1];
}

/**
 * The static deployment's provider is deliberately offline. It derives its
 * local principal internally and applies CAS/idempotency before committing the
 * pre-existing browser-local storage format.
 */
export function createBrowserLocalHostedReviewProvider(
  storage: ReviewStoragePort
): HostedReviewProviderPort {
  const local = createHostedReviewCollaboration(storage);
  const completed = new Map<string, HostedReviewOperationResult>();
  const completedSizes = new Map<string, number>();
  let completedBytes = 0;
  const recordKey = (binding: HostedReviewBinding) =>
    `${reviewStorageKey(legacyBinding(binding))}.provider-state.v1`;
  const byteLength = (value: string) => utf8.encode(value).byteLength;
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
    const actual = Object.keys(value);
    return actual.length === keys.length && actual.every((key) => keys.includes(key));
  };
  const decodeThreads = (
    binding: HostedReviewBinding,
    value: unknown
  ): readonly ReviewThread[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const encoded = JSON.stringify(value);
    const parser = createHostedReviewCollaboration({
      getItem: () => encoded,
      setItem: () => undefined
    });
    const threads = parser.load(legacyBinding(binding));
    return threads.length === value.length ? threads : undefined;
  };
  const readLegacyThreads = (binding: HostedReviewBinding): readonly ReviewThread[] | undefined => {
    try {
      const serialized = storage.getItem(reviewStorageKey(legacyBinding(binding)));
      if (serialized === null) return [];
      if (byteLength(serialized) > 250 * 1024) return undefined;
      const value: unknown = JSON.parse(serialized);
      if (!Array.isArray(value)) return undefined;
      const threads = local.load(legacyBinding(binding));
      return threads.length === value.length ? threads : undefined;
    } catch {
      return undefined;
    }
  };
  const validateReceipt = (
    value: unknown,
    binding: HostedReviewBinding
  ): HostedReviewOperationResult | undefined => {
    if (!isRecord(value)) return undefined;
    if (value.ok === true) {
      if (!hasExactKeys(value, ['ok', 'thread'])) return undefined;
      validateHostedReviewThread(value.thread as HostedReviewThread, binding);
      return value as HostedReviewOperationResult;
    }
    if (value.ok !== false || typeof value.code !== 'string') return undefined;
    if (value.code === 'conflict') {
      const keys =
        value.thread === undefined
          ? ['ok', 'code', 'currentVersion']
          : ['ok', 'code', 'currentVersion', 'thread'];
      if (
        !hasExactKeys(value, keys) ||
        !Number.isSafeInteger(value.currentVersion) ||
        (value.currentVersion as number) < 0
      ) {
        return undefined;
      }
      if (value.thread !== undefined)
        validateHostedReviewThread(value.thread as HostedReviewThread, binding);
      return value as HostedReviewOperationResult;
    }
    if (
      !['offline', 'error', 'forbidden'].includes(value.code) ||
      !hasExactKeys(value, ['ok', 'code'])
    ) {
      return undefined;
    }
    return value as HostedReviewOperationResult;
  };
  const boundedReceipts = (receipts: Readonly<Record<string, HostedReviewOperationResult>>) => {
    const entries = Object.entries(receipts);
    return Object.fromEntries(entries.slice(Math.max(0, entries.length - maxReceipts))) as Record<
      string,
      HostedReviewOperationResult
    >;
  };
  const rememberCompleted = (key: string, result: HostedReviewOperationResult) => {
    const size = byteLength(JSON.stringify([key, result]));
    if (size > maxCompletedBytes) return;
    const existing = completedSizes.get(key);
    if (existing !== undefined) completedBytes -= existing;
    completed.delete(key);
    while (
      completed.size > 0 &&
      (completed.size >= maxReceipts || completedBytes + size > maxCompletedBytes)
    ) {
      const oldest = completed.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      completedBytes -= completedSizes.get(oldest) ?? 0;
      completed.delete(oldest);
      completedSizes.delete(oldest);
    }
    if (completedBytes + size > maxCompletedBytes) return;
    completed.set(key, result);
    completedSizes.set(key, size);
    completedBytes += size;
  };
  const readRecord = (binding: HostedReviewBinding) => {
    try {
      const serialized = storage.getItem(recordKey(binding));
      // Legacy discussion storage is read-only until the first successful atomic mutation.
      if (serialized === null) {
        const threads = readLegacyThreads(binding);
        return threads === undefined
          ? undefined
          : { threads, receipts: {} as Record<string, HostedReviewOperationResult> };
      }
      if (byteLength(serialized) > maxRecordBytes) return undefined;
      const value: unknown = JSON.parse(serialized);
      if (!isRecord(value) || !hasExactKeys(value, ['format', 'threads', 'receipts']))
        return undefined;
      const record = value as { format?: unknown; threads?: unknown; receipts?: unknown };
      const threads = decodeThreads(binding, record.threads);
      if (record.format !== recordFormat || threads === undefined || !isRecord(record.receipts))
        return undefined;
      const receipts = record.receipts as Record<string, HostedReviewOperationResult>;
      const entries = Object.entries(receipts);
      if (entries.length > maxReceipts || entries.some(([key]) => byteLength(key) > 1024))
        return undefined;
      for (const [, result] of entries) {
        if (validateReceipt(result, binding) === undefined) return undefined;
      }
      return { threads, receipts };
    } catch {
      return undefined;
    }
  };
  const writeRecord = (
    binding: HostedReviewBinding,
    threads: readonly ReviewThread[],
    receipts: Readonly<Record<string, HostedReviewOperationResult>>
  ) => {
    const bounded = boundedReceipts(receipts);
    const serialized = JSON.stringify({ format: recordFormat, threads, receipts: bounded });
    if (byteLength(serialized) > maxRecordBytes) return false;
    try {
      storage.setItem(recordKey(binding), serialized);
      return true;
    } catch {
      return false;
    }
  };
  const load = (binding: HostedReviewBinding) => readRecord(binding)?.threads;
  const operationKey = (operation: {
    readonly binding: HostedReviewBinding;
    readonly operationId: string;
  }) =>
    JSON.stringify([
      operation.binding.tenantId,
      operation.binding.projectId,
      operation.binding.artifactId,
      operation.binding.revisionId,
      operation.binding.baselineId,
      operation.binding.version,
      operation.operationId
    ]);
  const conflict = (
    binding: HostedReviewBinding,
    thread: ReviewThread | undefined
  ): HostedReviewOperationResult => ({
    ok: false,
    code: 'conflict',
    currentVersion: thread === undefined ? 0 : localVersion(thread),
    ...(thread === undefined ? {} : { thread: asHosted(thread, binding) })
  });
  return Object.freeze({
    async state(binding) {
      validateHostedReviewBinding(binding);
      return browserLocalHostedReviewState;
    },
    async list(binding) {
      validateHostedReviewBinding(binding);
      const threads = load(binding);
      if (threads === undefined) throw new Error('Local review record is unavailable');
      return threads.map((thread) => asHosted(thread, binding));
    },
    async mutate(operation) {
      validateHostedReviewOperation(operation);
      const key = operationKey(operation);
      const previous = completed.get(key);
      if (previous !== undefined) return previous;
      const persisted = readRecord(operation.binding);
      if (persisted === undefined) return { ok: false, code: 'error' };
      const durable = persisted.receipts[key];
      if (durable !== undefined) {
        rememberCompleted(key, durable);
        return durable;
      }
      const threads = persisted.threads;
      const current = threads.find((thread) => thread.id === operation.threadId);
      if (
        (operation.type === 'create' &&
          (current !== undefined || operation.expectedVersion !== 0)) ||
        (operation.type !== 'create' &&
          (current === undefined || localVersion(current) !== operation.expectedVersion))
      ) {
        const result = conflict(operation.binding, current);
        if (!writeRecord(operation.binding, threads, { ...persisted.receipts, [key]: result }))
          return { ok: false, code: 'error' };
        rememberCompleted(key, result);
        return result;
      }
      const now = new Date().toISOString();
      let next: readonly ReviewThread[];
      if (operation.type === 'create') {
        const id = orderId(operation.anchor);
        if (id === undefined) return { ok: false, code: 'error' };
        const pinInput = {
          ...legacyBinding(operation.binding),
          orderId: id,
          anchor: operation.anchor
        };
        next = [
          ...threads,
          {
            id: operation.threadId,
            version: 1,
            pin: { id: canonicalArtifactPinId(pinInput), ...pinInput },
            status: 'open',
            messages: [
              {
                id: `${operation.operationId}:message`,
                author: localActor.displayName,
                body: operation.body,
                createdAt: now
              }
            ]
          }
        ];
      } else if (operation.type === 'reply') {
        next = threads.map((thread) =>
          thread.id === operation.threadId
            ? {
                ...thread,
                version: localVersion(thread) + 1,
                messages: [
                  ...thread.messages,
                  {
                    id: `${operation.operationId}:reply`,
                    author: localActor.displayName,
                    body: operation.body,
                    createdAt: now
                  }
                ]
              }
            : thread
        );
      } else {
        next = threads.map((thread) =>
          thread.id !== operation.threadId
            ? thread
            : operation.type === 'resolve'
              ? {
                  ...thread,
                  status: 'resolved',
                  resolvedAt: now,
                  version: localVersion(thread) + 1
                }
              : (() => {
                  const { resolvedAt: _resolvedAt, ...open } = thread;
                  return { ...open, status: 'open' as const, version: localVersion(thread) + 1 };
                })()
        );
      }
      const updated = next.find((thread) => thread.id === operation.threadId);
      if (updated === undefined) return { ok: false, code: 'error' };
      const result: HostedReviewOperationResult = {
        ok: true,
        thread: asHosted(updated, operation.binding)
      };
      if (!writeRecord(operation.binding, next, { ...persisted.receipts, [key]: result }))
        return { ok: false, code: 'error' };
      rememberCompleted(key, result);
      return result;
    }
  });
}

export const browserLocalHostedReviewProvider = createBrowserLocalHostedReviewProvider({
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value)
});

/** The static adapter owns this local supervisory context; portal code only supplies data. */
export const browserLocalHostedReviewContext: CollaborationHostContext = Object.freeze({
  signal: new AbortController().signal,
  run: async (operation) => operation(browserLocalHostedReviewContext),
  runPort: async (_port, _method, operation) => operation(browserLocalHostedReviewContext),
  dispose: () => undefined
});
