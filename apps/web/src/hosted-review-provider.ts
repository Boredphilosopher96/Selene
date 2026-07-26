import {
  createHostedReviewCollaboration,
  canonicalArtifactPinId,
  reviewStorageKey,
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
const recordFormat = 'selene-browser-review-provider/v2';
const legacyRecordFormat = 'selene-browser-review-provider/v1';
const maxReceipts = 100;
const maxLegacyStorageBytes = 250 * 1024;
const maxRecordBytes = 288 * 1024;
const maxCompletedBytes = 128 * 1024;
const utf8 = new TextEncoder();

type StoredReceipt =
  | { readonly kind: 'success'; readonly threadId: string }
  | { readonly kind: 'conflict'; readonly threadId?: string };

/** Host-only composition options for the isolated browser-local adapter. */
export interface BrowserLocalHostedReviewProviderOptions {
  /**
   * An old browser record had no tenant or contract version. A host may opt in
   * to read it only for this one exact binding; it is never inferred from a
   * renderer request or reused for another tenant/version.
   */
  readonly legacyBinding?: HostedReviewBinding;
}

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
  const pinInput = {
    ...legacyBinding(thread.binding),
    orderId: 'anchor',
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

/**
 * The static deployment's provider is deliberately offline and process-local.
 * localStorage does not offer cross-tab compare-and-swap, so a host must not
 * present this adapter as shared synchronization; shared review requires a
 * host provider with authoritative CAS.
 */
export function createBrowserLocalHostedReviewProvider(
  storage: ReviewStoragePort,
  options: BrowserLocalHostedReviewProviderOptions = {}
): HostedReviewProviderPort {
  const local = createHostedReviewCollaboration(storage);
  const legacyMigrationBinding = options.legacyBinding;
  if (legacyMigrationBinding !== undefined) validateHostedReviewBinding(legacyMigrationBinding);
  const completed = new Map<string, StoredReceipt>();
  const completedSizes = new Map<string, number>();
  let completedBytes = 0;
  const bindingKey = (binding: HostedReviewBinding) =>
    JSON.stringify([
      binding.tenantId,
      binding.projectId,
      binding.artifactId,
      binding.revisionId,
      binding.baselineId,
      binding.version
    ]);
  const sameBinding = (left: HostedReviewBinding, right: HostedReviewBinding) =>
    bindingKey(left) === bindingKey(right);
  const recordKey = (binding: HostedReviewBinding) =>
    `${reviewStorageKey(legacyBinding(binding))}.provider-state.v2.${encodeURIComponent(
      bindingKey(binding)
    )}`;
  const legacyRecordKey = (binding: HostedReviewBinding) =>
    `${reviewStorageKey(legacyBinding(binding))}.provider-state.v1`;
  const byteLength = (value: string) => utf8.encode(value).byteLength;
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
    const actual = Object.keys(value);
    return actual.length === keys.length && actual.every((key) => keys.includes(key));
  };
  const exactBinding = (value: unknown): HostedReviewBinding | undefined => {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'tenantId',
        'projectId',
        'artifactId',
        'revisionId',
        'baselineId',
        'version'
      ])
    )
      return undefined;
    validateHostedReviewBinding(value as HostedReviewBinding);
    return value as HostedReviewBinding;
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
      if (byteLength(serialized) > maxLegacyStorageBytes) return undefined;
      const value: unknown = JSON.parse(serialized);
      if (!Array.isArray(value)) return undefined;
      const threads = local.load(legacyBinding(binding));
      return threads.length === value.length ? threads : undefined;
    } catch {
      return undefined;
    }
  };
  const storedIdentifier = (value: unknown): value is string =>
    typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
  const validateStoredReceipt = (value: unknown): StoredReceipt | undefined => {
    if (!isRecord(value) || typeof value.kind !== 'string') return undefined;
    if (
      value.kind === 'success' &&
      hasExactKeys(value, ['kind', 'threadId']) &&
      storedIdentifier(value.threadId)
    ) {
      return value as StoredReceipt;
    }
    if (
      value.kind === 'conflict' &&
      (hasExactKeys(value, ['kind']) || hasExactKeys(value, ['kind', 'threadId'])) &&
      (value.threadId === undefined || storedIdentifier(value.threadId))
    ) {
      return value as StoredReceipt;
    }
    return undefined;
  };
  const receiptResult = (
    receipt: StoredReceipt,
    threads: readonly ReviewThread[],
    binding: HostedReviewBinding
  ): HostedReviewOperationResult | undefined => {
    const thread =
      receipt.threadId === undefined
        ? undefined
        : threads.find((item) => item.id === receipt.threadId);
    if (receipt.kind === 'success') {
      return thread === undefined ? undefined : { ok: true, thread: asHosted(thread, binding) };
    }
    return conflict(binding, thread);
  };
  const boundedReceipts = (receipts: Readonly<Record<string, StoredReceipt>>) => {
    const entries = Object.entries(receipts);
    return Object.fromEntries(entries.slice(Math.max(0, entries.length - maxReceipts))) as Record<
      string,
      StoredReceipt
    >;
  };
  const rememberCompleted = (key: string, receipt: StoredReceipt) => {
    const size = byteLength(JSON.stringify([key, receipt]));
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
    completed.set(key, receipt);
    completedSizes.set(key, size);
    completedBytes += size;
  };
  const readRecord = (binding: HostedReviewBinding) => {
    try {
      const serialized = storage.getItem(recordKey(binding));
      if (serialized === null) return readLegacyRecord(binding);
      if (byteLength(serialized) > maxRecordBytes) return undefined;
      const value: unknown = JSON.parse(serialized);
      if (!isRecord(value) || !hasExactKeys(value, ['format', 'binding', 'threads', 'receipts']))
        return undefined;
      const record = value as {
        format?: unknown;
        binding?: unknown;
        threads?: unknown;
        receipts?: unknown;
      };
      const persistedBinding = exactBinding(record.binding);
      if (persistedBinding === undefined || !sameBinding(persistedBinding, binding))
        return undefined;
      const threads = decodeThreads(binding, record.threads);
      if (record.format !== recordFormat || threads === undefined || !isRecord(record.receipts))
        return undefined;
      const receipts = record.receipts as Record<string, StoredReceipt>;
      const entries = Object.entries(receipts);
      if (entries.length > maxReceipts || entries.some(([key]) => byteLength(key) > 1024))
        return undefined;
      for (const [, result] of entries) {
        const receipt = validateStoredReceipt(result);
        if (
          receipt === undefined ||
          (receipt.threadId !== undefined &&
            !threads.some((thread) => thread.id === receipt.threadId))
        )
          return undefined;
      }
      return { threads, receipts };
    } catch {
      return undefined;
    }
  };
  function readLegacyRecord(binding: HostedReviewBinding) {
    if (legacyMigrationBinding === undefined || !sameBinding(legacyMigrationBinding, binding)) {
      return { threads: [], receipts: {} as Record<string, StoredReceipt> };
    }
    try {
      const serialized = storage.getItem(legacyRecordKey(binding));
      if (serialized === null) {
        const threads = readLegacyThreads(binding);
        return threads === undefined
          ? undefined
          : { threads, receipts: {} as Record<string, StoredReceipt> };
      }
      if (byteLength(serialized) > maxRecordBytes) return undefined;
      const value: unknown = JSON.parse(serialized);
      if (!isRecord(value) || !hasExactKeys(value, ['format', 'threads', 'receipts']))
        return undefined;
      if (value.format !== legacyRecordFormat || !isRecord(value.receipts)) return undefined;
      const threads = decodeThreads(binding, value.threads);
      if (threads === undefined) return undefined;
      const migrated: Record<string, StoredReceipt> = {};
      for (const [key, result] of Object.entries(value.receipts)) {
        if (byteLength(key) > 1024 || !isRecord(result)) return undefined;
        if (result.ok === true && hasExactKeys(result, ['ok', 'thread'])) {
          validateHostedReviewThread(result.thread as HostedReviewThread, binding);
          if (!threads.some((thread) => thread.id === (result.thread as HostedReviewThread).id))
            return undefined;
          migrated[key] = { kind: 'success', threadId: (result.thread as HostedReviewThread).id };
          continue;
        }
        if (result.ok === false && result.code === 'conflict') {
          const keys =
            result.thread === undefined
              ? ['ok', 'code', 'currentVersion']
              : ['ok', 'code', 'currentVersion', 'thread'];
          if (
            !hasExactKeys(result, keys) ||
            !Number.isSafeInteger(result.currentVersion) ||
            (result.currentVersion as number) < 0
          )
            return undefined;
          if (result.thread !== undefined)
            validateHostedReviewThread(result.thread as HostedReviewThread, binding);
          if (
            result.thread !== undefined &&
            !threads.some((thread) => thread.id === (result.thread as HostedReviewThread).id)
          )
            return undefined;
          migrated[key] =
            result.thread === undefined
              ? { kind: 'conflict' }
              : { kind: 'conflict', threadId: (result.thread as HostedReviewThread).id };
          continue;
        }
        return undefined;
      }
      return Object.keys(migrated).length > maxReceipts
        ? undefined
        : { threads, receipts: migrated };
    } catch {
      return undefined;
    }
  }
  const writeRecord = (
    binding: HostedReviewBinding,
    threads: readonly ReviewThread[],
    receipts: Readonly<Record<string, StoredReceipt>>
  ) => {
    const bounded = boundedReceipts(receipts);
    const serialized = JSON.stringify({
      format: recordFormat,
      binding,
      threads,
      receipts: bounded
    });
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
  function conflict(
    binding: HostedReviewBinding,
    thread: ReviewThread | undefined
  ): HostedReviewOperationResult {
    return {
      ok: false,
      code: 'conflict',
      currentVersion: thread === undefined ? 0 : localVersion(thread),
      ...(thread === undefined ? {} : { thread: asHosted(thread, binding) })
    };
  }
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
      const persisted = readRecord(operation.binding);
      if (persisted === undefined) return { ok: false, code: 'error' };
      const previous = completed.get(key);
      if (previous !== undefined) {
        const replay = receiptResult(previous, persisted.threads, operation.binding);
        return replay ?? { ok: false, code: 'error' };
      }
      const durable = persisted.receipts[key];
      if (durable !== undefined) {
        const replay = receiptResult(durable, persisted.threads, operation.binding);
        if (replay === undefined) return { ok: false, code: 'error' };
        rememberCompleted(key, durable);
        return replay;
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
        const receipt: StoredReceipt =
          current === undefined ? { kind: 'conflict' } : { kind: 'conflict', threadId: current.id };
        if (!writeRecord(operation.binding, threads, { ...persisted.receipts, [key]: receipt }))
          return { ok: false, code: 'error' };
        rememberCompleted(key, receipt);
        return result;
      }
      const now = new Date().toISOString();
      let next: readonly ReviewThread[];
      if (operation.type === 'create') {
        const pinInput = {
          ...legacyBinding(operation.binding),
          orderId: 'anchor',
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
      const receipt: StoredReceipt = { kind: 'success', threadId: updated.id };
      if (!writeRecord(operation.binding, next, { ...persisted.receipts, [key]: receipt }))
        return { ok: false, code: 'error' };
      rememberCompleted(key, receipt);
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
