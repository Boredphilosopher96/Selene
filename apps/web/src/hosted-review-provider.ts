import {
  createHostedReviewCollaboration,
  canonicalArtifactPinId,
  type ArtifactAnchor,
  type ReviewArtifactBinding,
  type ReviewStoragePort,
  type ReviewThread
} from './hosted-review-collaboration';
import {
  validateHostedReviewBinding,
  validateHostedReviewOperation,
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
  return thread.messages.length + (thread.status === 'resolved' ? 1 : 0);
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
  const state: HostedReviewProviderState = Object.freeze({
    provider: 'browser-local',
    identity: 'local-only',
    sync: 'offline'
  });
  const load = (binding: HostedReviewBinding) => local.load(legacyBinding(binding));
  const save = (binding: HostedReviewBinding, threads: readonly ReviewThread[]) =>
    local.save(legacyBinding(binding), threads);
  const operationKey = (operation: {
    readonly binding: HostedReviewBinding;
    readonly operationId: string;
  }) =>
    `${operation.binding.tenantId}:${operation.binding.projectId}:${operation.binding.artifactId}:${operation.binding.revisionId}:${operation.operationId}`;
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
    async state() {
      return state;
    },
    async list(binding) {
      validateHostedReviewBinding(binding);
      return load(binding).map((thread) => asHosted(thread, binding));
    },
    async mutate(operation) {
      validateHostedReviewOperation(operation);
      const key = operationKey(operation);
      const previous = completed.get(key);
      if (previous !== undefined) return previous;
      const threads = load(operation.binding);
      const current = threads.find((thread) => thread.id === operation.threadId);
      if (
        (operation.type === 'create' &&
          (current !== undefined || operation.expectedVersion !== 0)) ||
        (operation.type !== 'create' &&
          (current === undefined || localVersion(current) !== operation.expectedVersion))
      ) {
        const result = conflict(operation.binding, current);
        completed.set(key, result);
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
              ? { ...thread, status: 'resolved', resolvedAt: now }
              : (() => {
                  const { resolvedAt: _resolvedAt, ...open } = thread;
                  return { ...open, status: 'open' as const };
                })()
        );
      }
      const saved = save(operation.binding, next);
      if (!saved.ok) return { ok: false, code: 'error' };
      const updated = next.find((thread) => thread.id === operation.threadId);
      if (updated === undefined) return { ok: false, code: 'error' };
      const result: HostedReviewOperationResult = {
        ok: true,
        thread: asHosted(updated, operation.binding)
      };
      completed.set(key, result);
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
