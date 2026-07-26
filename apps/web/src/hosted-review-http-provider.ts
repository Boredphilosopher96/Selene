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
  readonly version: number;
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

/** Client-written deep-link data is presentation evidence only, never binding authority. */
interface StoredReviewPresentation {
  readonly selector: string;
  readonly component: string;
  readonly pointX?: number;
  readonly pointY?: number;
}

function actor(id: string): HostedReviewActor {
  return { id, displayName: id };
}

const maxRemoteThreads = 1_000;
const maxRemoteMessages = 1_000;
const maxRemoteText = 16_384;

/** JSON is hostile at this boundary; reject accessors, prototypes and excess data before mapping it. */
function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !('value' in descriptor))) return undefined;
  return value as Record<string, unknown>;
}

function text(value: unknown, limit = maxRemoteText): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= limit ? value : undefined;
}

function timestamp(value: unknown): string | undefined {
  const candidate = text(value, 128);
  return candidate !== undefined && Number.isFinite(Date.parse(candidate)) ? candidate : undefined;
}

function coordinate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

function parseServiceThread(value: unknown): ServiceReviewThread | undefined {
  const source = record(value);
  if (!source || !Array.isArray(source.messages) || source.messages.length > maxRemoteMessages)
    return undefined;
  const anchor = record(source.anchor);
  const evidence = anchor && record(anchor.evidence);
  const target = anchor && record(anchor.target);
  if (!evidence || !target) return undefined;
  const targetPoint = target.kind === 'point' ? record(target.point) : undefined;
  const targetRegion = target.kind === 'region' ? record(target.region) : undefined;
  const point = targetPoint && { x: coordinate(targetPoint.x), y: coordinate(targetPoint.y) };
  const region = targetRegion && {
    x: coordinate(targetRegion.x),
    y: coordinate(targetRegion.y),
    width: coordinate(targetRegion.width),
    height: coordinate(targetRegion.height)
  };
  const id = text(source.id, 128);
  const projectId = text(source.projectId, 128);
  const deepLink = text(source.deepLink, 2_048);
  const version = source.version;
  const createdBy = text(source.createdBy, 128);
  const createdAt = timestamp(source.createdAt);
  const artifactId = text(evidence.artifactId, 128);
  const revisionId = text(evidence.revisionId, 128);
  const screenId = text(evidence.screenId, 128);
  const resolvedAt = source.resolvedAt === undefined ? undefined : timestamp(source.resolvedAt);
  const resolvedBy = source.resolvedBy === undefined ? undefined : text(source.resolvedBy, 128);
  const reopenedAt = source.reopenedAt === undefined ? undefined : timestamp(source.reopenedAt);
  const reopenedBy = source.reopenedBy === undefined ? undefined : text(source.reopenedBy, 128);
  if (
    !id ||
    !projectId ||
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !deepLink ||
    (source.lifecycle !== 'open' && source.lifecycle !== 'resolved') ||
    !createdBy ||
    !createdAt ||
    !artifactId ||
    !revisionId ||
    !screenId ||
    (target.kind !== 'point' && target.kind !== 'region') ||
    (source.resolvedAt !== undefined && !resolvedAt) ||
    (source.resolvedBy !== undefined && !resolvedBy) ||
    (source.reopenedAt !== undefined && !reopenedAt) ||
    (source.reopenedBy !== undefined && !reopenedBy) ||
    (target.kind === 'point' && (!point || point.x === undefined || point.y === undefined)) ||
    (target.kind === 'region' &&
      (!region ||
        region.x === undefined ||
        region.y === undefined ||
        region.width === undefined ||
        region.height === undefined ||
        region.width <= 0 ||
        region.height <= 0 ||
        region.x + region.width > 1 ||
        region.y + region.height > 1))
  )
    return undefined;
  const messages: ServiceReviewMessage[] = [];
  for (const candidate of source.messages) {
    const message = record(candidate);
    const messageCreatedAt = message === undefined ? undefined : timestamp(message.createdAt);
    if (
      !message ||
      !text(message.id, 128) ||
      !text(message.body) ||
      !text(message.createdBy, 128) ||
      !messageCreatedAt
    )
      return undefined;
    messages.push({
      id: message.id,
      body: message.body,
      createdBy: message.createdBy,
      createdAt: messageCreatedAt
    });
  }
  if (new Set(messages.map((message) => message.id)).size !== messages.length) return undefined;
  return {
    id,
    projectId,
    version,
    deepLink,
    lifecycle: source.lifecycle,
    createdBy,
    createdAt,
    ...(resolvedAt === undefined ? {} : { resolvedAt }),
    ...(resolvedBy === undefined ? {} : { resolvedBy }),
    ...(reopenedAt === undefined ? {} : { reopenedAt }),
    ...(reopenedBy === undefined ? {} : { reopenedBy }),
    messages,
    anchor: {
      evidence: {
        artifactId,
        revisionId,
        screenId
      },
      target:
        target.kind === 'point'
          ? { kind: 'point', point: { x: point!.x ?? 0, y: point!.y ?? 0 } }
          : {
              kind: 'region',
              region: {
                x: region!.x ?? 0,
                y: region!.y ?? 0,
                width: region!.width ?? 0,
                height: region!.height ?? 0
              }
            }
    }
  };
}

function exactPresentation(thread: ServiceReviewThread): StoredReviewPresentation | undefined {
  try {
    const value = new URL(thread.deepLink).hash.slice(1);
    const payload = new URLSearchParams(value).get('selene-review');
    if (payload === null) return undefined;
    const parsed: unknown = JSON.parse(decodeURIComponent(payload));
    const presentation = record(parsed);
    if (!presentation) return undefined;
    if (
      typeof presentation.selector !== 'string' ||
      typeof presentation.component !== 'string' ||
      (presentation.pointX !== undefined &&
        (typeof presentation.pointX !== 'number' ||
          !Number.isFinite(presentation.pointX) ||
          presentation.pointX < 0 ||
          presentation.pointX > 1)) ||
      (presentation.pointY !== undefined &&
        (typeof presentation.pointY !== 'number' ||
          !Number.isFinite(presentation.pointY) ||
          presentation.pointY < 0 ||
          presentation.pointY > 1))
    )
      return undefined;
    return {
      selector: presentation.selector,
      component: presentation.component,
      ...(presentation.pointX === undefined ? {} : { pointX: presentation.pointX }),
      ...(presentation.pointY === undefined ? {} : { pointY: presentation.pointY })
    };
  } catch {
    return undefined;
  }
}

function matchesBinding(thread: ServiceReviewThread, binding: HostedReviewBinding): boolean {
  return (
    thread.projectId === binding.projectId &&
    thread.anchor.evidence.artifactId === binding.artifactId &&
    thread.anchor.evidence.revisionId === binding.revisionId
  );
}

function asHosted(thread: ServiceReviewThread, binding: HostedReviewBinding): HostedReviewThread {
  const presentation = exactPresentation(thread);
  const target = thread.anchor.target;
  const point =
    presentation?.pointX !== undefined && presentation.pointY !== undefined
      ? { x: presentation.pointX, y: presentation.pointY }
      : target.kind === 'point'
        ? target.point
        : { x: target.region.x, y: target.region.y };
  const region =
    target.kind === 'region' ? target.region : { x: point.x, y: point.y, width: 0, height: 0 };
  const hosted: HostedReviewThread = {
    id: thread.id,
    binding,
    anchor: {
      selector:
        presentation?.selector ??
        `service://${thread.anchor.evidence.artifactId}/${thread.anchor.evidence.screenId}`,
      component: presentation?.component ?? thread.anchor.evidence.screenId,
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
    version: thread.version,
    ...(thread.lifecycle === 'resolved' &&
    thread.resolvedAt !== undefined &&
    thread.resolvedBy !== undefined
      ? { resolvedAt: thread.resolvedAt, resolvedBy: actor(thread.resolvedBy) }
      : {})
  };
  validateHostedReviewThread(hosted, binding);
  return hosted;
}

function sameNumber(left: number, right: number): boolean {
  return Object.is(left, right);
}

/** A successful create/replay must prove the actual persisted payload, not just an ID lookup. */
function matchesCreatedOperation(
  thread: HostedReviewThread,
  operation: Extract<HostedReviewOperation, { readonly type: 'create' }>
): boolean {
  const reply = thread.replies.find((item) => item.id === `${operation.operationId}:message`);
  return (
    reply?.body === operation.body &&
    thread.anchor.selector === operation.anchor.selector &&
    thread.anchor.component === operation.anchor.component &&
    sameNumber(thread.anchor.point.x, operation.anchor.point.x) &&
    sameNumber(thread.anchor.point.y, operation.anchor.point.y) &&
    sameNumber(thread.anchor.region.x, operation.anchor.region.x) &&
    sameNumber(thread.anchor.region.y, operation.anchor.region.y) &&
    sameNumber(thread.anchor.region.width, operation.anchor.region.width) &&
    sameNumber(thread.anchor.region.height, operation.anchor.region.height)
  );
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
        selector: operation.type === 'create' ? operation.anchor.selector : '',
        component: operation.type === 'create' ? operation.anchor.component : '',
        ...(operation.type === 'create'
          ? { pointX: operation.anchor.point.x, pointY: operation.anchor.point.y }
          : {})
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
    const value = record(await response.json());
    if (!value || !Array.isArray(value.threads) || value.threads.length > maxRemoteThreads)
      throw new Error('review-list:invalid');
    const threads: ServiceReviewThread[] = [];
    for (const candidate of value.threads) {
      const thread = parseServiceThread(candidate);
      if (!thread) throw new Error('review-list:invalid');
      threads.push(thread);
    }
    return threads
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
              operationId: operation.operationId,
              expectedVersion: operation.expectedVersion,
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
              operationId: operation.operationId,
              expectedVersion: operation.expectedVersion,
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
            headers,
            body: JSON.stringify({
              operationId: operation.operationId,
              expectedVersion: operation.expectedVersion
            })
          }
        );
      }
      if (response.status === 401 || response.status === 403)
        return { ok: false, code: 'forbidden' };
      if (!response.ok && response.status !== 409) return { ok: false, code: 'error' };
      const refreshed = await read(operation.binding);
      const authoritative = refreshed.find((item) => item.id === operation.threadId);
      if (authoritative === undefined) return { ok: false, code: 'error' };
      // A conflict is authoritative even when a same-ID thread exists. The
      // host reached this state only for a stale CAS or changed receipt input.
      if (response.status === 409) return conflict(authoritative);
      if (operation.type === 'create') {
        // The service returns 201 for a mutation and 200 only for its exact
        // canonical-fingerprint receipt replay. The adapter additionally
        // proves the live stable identity and payload before surfacing it.
        if (
          (response.status !== 200 && response.status !== 201) ||
          !matchesCreatedOperation(authoritative, operation)
        )
          return conflict(authoritative);
      }
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
