import {
  validateHostedReviewBinding,
  validateHostedReviewOperation,
  validateHostedReviewThread,
  type HostedReviewActor,
  type HostedReviewBinding,
  type HostedReviewOperation,
  type HostedReviewOperationResult,
  type HostedReviewProviderPort,
  type HostedReviewProviderState,
  type HostedReviewThread
} from '@selene/collaboration/hosted-review';

export interface HostedReviewHttpProviderOptions {
  /** HTTPS origin owned by the authenticated collaboration host or OIDC BFF. */
  readonly serviceUrl: string;
  /** Public reviewed artifact URL accepted by the service's deep-link policy. */
  readonly reviewUrl: string;
  /** Immutable fingerprint registered by the host for this reviewed revision. */
  readonly revisionFingerprint: string;
  readonly screenId: string;
  readonly fetch?: typeof fetch;
}

interface ServiceReviewMessage {
  readonly id: string;
  readonly body: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

interface ServiceReviewThread {
  readonly id: string;
  readonly projectId: string;
  readonly deepLink: string;
  readonly lifecycle: 'open' | 'resolved';
  readonly createdBy: string;
  readonly createdAt: string;
  readonly resolvedAt?: string;
  readonly resolvedBy?: string;
  readonly reopenedAt?: string;
  readonly reopenedBy?: string;
  readonly messages: readonly ServiceReviewMessage[];
  readonly anchor: {
    readonly evidence: {
      readonly artifactId: string;
      readonly revisionId: string;
      readonly screenId: string;
    };
    readonly target:
      | { readonly kind: 'point'; readonly point: { readonly x: number; readonly y: number } }
      | {
          readonly kind: 'region';
          readonly region: {
            readonly x: number;
            readonly y: number;
            readonly width: number;
            readonly height: number;
          };
        };
  };
}

interface StoredReviewIdentity {
  readonly tenantId: string;
  readonly baselineId: string;
  readonly version: number;
  readonly selector: string;
  readonly component: string;
}

function actor(id: string): HostedReviewActor {
  return { id, displayName: id };
}

function reviewVersion(thread: ServiceReviewThread): number {
  const timestamps = [
    thread.createdAt,
    ...thread.messages.map((message) => message.createdAt),
    thread.resolvedAt,
    thread.reopenedAt
  ].filter((value): value is string => value !== undefined);
  const time = Math.max(...timestamps.map((value) => Date.parse(value)).filter(Number.isFinite));
  return Number.isSafeInteger(time) && time >= 0 ? time : 0;
}

function exactIdentity(thread: ServiceReviewThread): StoredReviewIdentity | undefined {
  try {
    const value = new URL(thread.deepLink).hash.slice(1);
    const payload = new URLSearchParams(value).get('selene-review');
    if (payload === null) return undefined;
    const parsed: unknown = JSON.parse(decodeURIComponent(payload));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const identity = parsed as Partial<StoredReviewIdentity>;
    if (
      typeof identity.tenantId !== 'string' ||
      typeof identity.baselineId !== 'string' ||
      typeof identity.version !== 'number' ||
      !Number.isSafeInteger(identity.version) ||
      typeof identity.selector !== 'string' ||
      typeof identity.component !== 'string'
    )
      return undefined;
    return identity as StoredReviewIdentity;
  } catch {
    return undefined;
  }
}

function matchesBinding(thread: ServiceReviewThread, binding: HostedReviewBinding): boolean {
  const identity = exactIdentity(thread);
  return (
    thread.projectId === binding.projectId &&
    thread.anchor.evidence.artifactId === binding.artifactId &&
    thread.anchor.evidence.revisionId === binding.revisionId &&
    identity?.tenantId === binding.tenantId &&
    identity?.baselineId === binding.baselineId &&
    identity.version === binding.version
  );
}

function asHosted(thread: ServiceReviewThread, binding: HostedReviewBinding): HostedReviewThread {
  const identity = exactIdentity(thread);
  const target = thread.anchor.target;
  const point = target.kind === 'point' ? target.point : { x: target.region.x, y: target.region.y };
  const region =
    target.kind === 'region' ? target.region : { x: point.x, y: point.y, width: 0, height: 0 };
  const hosted: HostedReviewThread = {
    id: thread.id,
    binding,
    anchor: {
      selector:
        identity?.selector ??
        `service://${thread.anchor.evidence.artifactId}/${thread.anchor.evidence.screenId}`,
      component: identity?.component ?? thread.anchor.evidence.screenId,
      point,
      region
    },
    replies: thread.messages.map((message) => ({
      id: message.id,
      body: message.body,
      actor: actor(message.createdBy),
      createdAt: message.createdAt,
      version: Date.parse(message.createdAt)
    })),
    lifecycle: thread.lifecycle,
    actor: actor(thread.createdBy),
    createdAt: thread.createdAt,
    version: reviewVersion(thread),
    ...(thread.lifecycle === 'resolved' &&
    thread.resolvedAt !== undefined &&
    thread.resolvedBy !== undefined
      ? { resolvedAt: thread.resolvedAt, resolvedBy: actor(thread.resolvedBy) }
      : {})
  };
  validateHostedReviewThread(hosted, binding);
  return hosted;
}

function identityUrl(
  options: HostedReviewHttpProviderOptions,
  binding: HostedReviewBinding,
  operation: HostedReviewOperation
): string {
  const url = new URL(options.reviewUrl);
  url.hash = new URLSearchParams({
    'selene-review': encodeURIComponent(
      JSON.stringify({
        tenantId: binding.tenantId,
        baselineId: binding.baselineId,
        version: binding.version,
        selector: operation.type === 'create' ? operation.anchor.selector : '',
        component: operation.type === 'create' ? operation.anchor.component : ''
      })
    )
  }).toString();
  return url.toString();
}

/**
 * Browser requests carry only authenticated cookies to the host/BFF. This
 * adapter never sends a principal or proxy credential. It uses current-state
 * replay: an old resolve after a reopen is returned as a conflict, never an
 * misleading success with an open thread.
 */
export function createHostedReviewHttpProvider(
  options: HostedReviewHttpProviderOptions
): HostedReviewProviderPort {
  const request = options.fetch ?? fetch;
  const api = (path: string) => new URL(path, options.serviceUrl).toString();
  const read = async (binding: HostedReviewBinding): Promise<readonly HostedReviewThread[]> => {
    const url = new URL(
      api(`/v1/projects/${encodeURIComponent(binding.projectId)}/review-threads`)
    );
    url.searchParams.set('revisionId', binding.revisionId);
    const response = await request(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`review-list:${response.status}`);
    const value = (await response.json()) as { threads?: unknown };
    if (!Array.isArray(value.threads)) throw new Error('review-list:invalid');
    return (value.threads as ServiceReviewThread[])
      .filter((thread) => matchesBinding(thread, binding))
      .map((thread) => asHosted(thread, binding));
  };
  const conflict = (thread: HostedReviewThread | undefined): HostedReviewOperationResult => ({
    ok: false,
    code: 'conflict',
    currentVersion: thread?.version ?? 0,
    ...(thread === undefined ? {} : { thread })
  });
  return Object.freeze({
    async state(binding) {
      validateHostedReviewBinding(binding);
      await read(binding);
      return Object.freeze({
        provider: 'hosted',
        identity: 'verified',
        sync: 'idle'
      }) satisfies HostedReviewProviderState;
    },
    async list(binding) {
      validateHostedReviewBinding(binding);
      return read(binding);
    },
    async mutate(operation) {
      validateHostedReviewOperation(operation);
      const current = await read(operation.binding);
      const thread = current.find((item) => item.id === operation.threadId);
      if (
        (operation.type === 'create' &&
          (thread !== undefined || operation.expectedVersion !== 0)) ||
        (operation.type !== 'create' &&
          (thread === undefined || thread.version !== operation.expectedVersion))
      )
        return conflict(thread);
      const headers = {
        'content-type': 'application/json',
        'idempotency-key': operation.operationId
      };
      let response: Response;
      if (operation.type === 'create') {
        response = await request(
          api(`/v1/projects/${encodeURIComponent(operation.binding.projectId)}/review-threads`),
          {
            method: 'POST',
            credentials: 'include',
            headers,
            body: JSON.stringify({
              id: operation.threadId,
              messageId: `${operation.operationId}:message`,
              body: operation.body,
              mentionedUserIds: [],
              deepLink: identityUrl(options, operation.binding, operation),
              anchor: {
                evidence: {
                  artifactId: operation.binding.artifactId,
                  screenId: options.screenId,
                  revisionId: operation.binding.revisionId,
                  revisionFingerprint: options.revisionFingerprint,
                  viewport: { width: 1440, height: 900, zoom: 1 }
                },
                lifecycle: 'current',
                target:
                  operation.anchor.region.width === 0 && operation.anchor.region.height === 0
                    ? { kind: 'point', point: operation.anchor.point }
                    : { kind: 'region', region: operation.anchor.region }
              }
            })
          }
        );
      } else if (operation.type === 'reply') {
        response = await request(
          api(`/v1/review-threads/${encodeURIComponent(operation.threadId)}/messages`),
          {
            method: 'POST',
            credentials: 'include',
            headers,
            body: JSON.stringify({
              id: `${operation.operationId}:reply`,
              body: operation.body,
              mentionedUserIds: []
            })
          }
        );
      } else {
        response = await request(
          api(`/v1/review-threads/${encodeURIComponent(operation.threadId)}/${operation.type}`),
          {
            method: 'POST',
            credentials: 'include',
            headers
          }
        );
      }
      if (response.status === 401 || response.status === 403)
        return { ok: false, code: 'forbidden' };
      if (!response.ok && response.status !== 409) return { ok: false, code: 'error' };
      const refreshed = await read(operation.binding);
      const authoritative = refreshed.find((item) => item.id === operation.threadId);
      if (authoritative === undefined) return { ok: false, code: 'error' };
      if (operation.type === 'resolve' && authoritative.lifecycle !== 'resolved')
        return conflict(authoritative);
      if (operation.type === 'reopen' && authoritative.lifecycle !== 'open')
        return conflict(authoritative);
      if (
        operation.type === 'reply' &&
        !authoritative.replies.some((reply) => reply.id === `${operation.operationId}:reply`)
      )
        return conflict(authoritative);
      return { ok: true, thread: authoritative };
    }
  });
}
