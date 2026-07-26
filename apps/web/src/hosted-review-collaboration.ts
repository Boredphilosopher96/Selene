export interface ReviewArtifactBinding {
  readonly projectId: string;
  readonly revisionId: string;
  readonly baselineId: string;
  readonly artifactId: string;
}

export interface ArtifactPoint {
  readonly x: number;
  readonly y: number;
}

export interface ArtifactRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ArtifactAnchor {
  readonly selector: string;
  readonly component: string;
  readonly point: ArtifactPoint;
  readonly region: ArtifactRegion;
}

export interface ArtifactPinInput extends ReviewArtifactBinding {
  readonly orderId: string;
  readonly anchor: ArtifactAnchor;
}

export interface ArtifactPin extends ArtifactPinInput {
  readonly id: string;
}

export interface ThreadMessage {
  readonly id: string;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface ReviewThread {
  readonly id: string;
  readonly version?: number;
  readonly pin: ArtifactPin;
  readonly messages: readonly ThreadMessage[];
  readonly status: 'open' | 'resolved';
  readonly resolvedAt?: string;
}

export type CollaborationSaveResult =
  { readonly ok: true } | { readonly ok: false; readonly code: 'invalid' | 'oversize' | 'quota' };

export interface ReviewStoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface HostedReviewCollaborationPort {
  load(binding: ReviewArtifactBinding): readonly ReviewThread[];
  save(binding: ReviewArtifactBinding, threads: readonly ReviewThread[]): CollaborationSaveResult;
}

const storagePrefix = 'selene.hosted-review-collaboration.v2.';
const maxThreads = 100;
const maxMessagesPerThread = 100;
const maxTextLength = 4_000;
const maxSelectorLength = 512;
const maxStorageBytes = 250 * 1024;
const maxAggregateMessageCharacters = 512 * 1024;
const stableThreadId = /^thread-[a-z0-9-]{1,120}$/;
const stableMessageId = /^(?:message|reply)-[a-z0-9-]{1,120}$/;
const canonicalPinId = /^pin-v1-[0-9a-f]{16}$/;

export function reviewStorageKey(binding: ReviewArtifactBinding): string {
  return `${storagePrefix}${binding.projectId}.${binding.revisionId}.${binding.baselineId}.${binding.artifactId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function stringWithin(value: unknown, maximum = maxTextLength): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function stableIdentifier(value: unknown, pattern: RegExp): value is string {
  return stringWithin(value, 128) && pattern.test(value);
}

function relativeCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function hashPart(value: string, seed: number): string {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** The one canonical, bounded identity grammar for an artifact pin. */
export function canonicalArtifactPinId(pin: ArtifactPinInput): string {
  const { anchor } = pin;
  const payload = JSON.stringify([
    pin.projectId,
    pin.revisionId,
    pin.baselineId,
    pin.artifactId,
    pin.orderId,
    anchor.selector,
    anchor.component,
    anchor.point.x,
    anchor.point.y,
    anchor.region.x,
    anchor.region.y,
    anchor.region.width,
    anchor.region.height
  ]);
  return `pin-v1-${hashPart(payload, 0x811c9dc5)}${hashPart(`selene:${payload}`, 0x01000193)}`;
}

export function isCanonicalArtifactPinId(value: unknown): value is string {
  return typeof value === 'string' && canonicalPinId.test(value);
}

function parsePoint(value: unknown): ArtifactPoint | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['x', 'y'])) return undefined;
  if (!relativeCoordinate(value.x) || !relativeCoordinate(value.y)) return undefined;
  return { x: value.x, y: value.y };
}

function parseRegion(value: unknown): ArtifactRegion | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['x', 'y', 'width', 'height'])) return undefined;
  if (
    !relativeCoordinate(value.x) ||
    !relativeCoordinate(value.y) ||
    !relativeCoordinate(value.width) ||
    !relativeCoordinate(value.height) ||
    value.x + value.width > 1 ||
    value.y + value.height > 1
  ) {
    return undefined;
  }
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

function parseAnchor(value: unknown): ArtifactAnchor | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['selector', 'component', 'point', 'region'])) {
    return undefined;
  }
  const point = parsePoint(value.point);
  const region = parseRegion(value.region);
  if (!stringWithin(value.selector, maxSelectorLength) || !stringWithin(value.component, 160)) {
    return undefined;
  }
  if (point === undefined || region === undefined) return undefined;
  return { selector: value.selector, component: value.component, point, region };
}

function matchesBinding(pin: ArtifactPin, binding: ReviewArtifactBinding): boolean {
  return (
    pin.projectId === binding.projectId &&
    pin.revisionId === binding.revisionId &&
    pin.baselineId === binding.baselineId &&
    pin.artifactId === binding.artifactId
  );
}

function parsePin(value: unknown, binding: ReviewArtifactBinding): ArtifactPin | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'id',
      'projectId',
      'revisionId',
      'baselineId',
      'artifactId',
      'orderId',
      'anchor'
    ])
  ) {
    return undefined;
  }
  const anchor = parseAnchor(value.anchor);
  if (
    !isCanonicalArtifactPinId(value.id) ||
    !stringWithin(value.projectId, 160) ||
    !stringWithin(value.revisionId, 160) ||
    !stringWithin(value.baselineId, 160) ||
    !stringWithin(value.artifactId, 160) ||
    !stringWithin(value.orderId, 160) ||
    anchor === undefined
  ) {
    return undefined;
  }
  const input: ArtifactPinInput = {
    projectId: value.projectId,
    revisionId: value.revisionId,
    baselineId: value.baselineId,
    artifactId: value.artifactId,
    orderId: value.orderId,
    anchor
  };
  if (value.id !== canonicalArtifactPinId(input)) return undefined;
  const pin: ArtifactPin = { id: value.id, ...input };
  return matchesBinding(pin, binding) ? pin : undefined;
}

function parseMessage(value: unknown): ThreadMessage | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'author', 'body', 'createdAt'])) {
    return undefined;
  }
  if (
    !stableIdentifier(value.id, stableMessageId) ||
    !stringWithin(value.author, 160) ||
    !stringWithin(value.body) ||
    !stringWithin(value.createdAt, 64) ||
    Number.isNaN(Date.parse(value.createdAt))
  ) {
    return undefined;
  }
  return { id: value.id, author: value.author, body: value.body, createdAt: value.createdAt };
}

function parseThread(value: unknown, binding: ReviewArtifactBinding): ReviewThread | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['id', 'version', 'pin', 'messages', 'status', 'resolvedAt'])
  ) {
    return undefined;
  }
  const pin = parsePin(value.pin, binding);
  if (
    !stableIdentifier(value.id, stableThreadId) ||
    pin === undefined ||
    !Array.isArray(value.messages)
  ) {
    return undefined;
  }
  if (value.messages.length === 0 || value.messages.length > maxMessagesPerThread) return undefined;
  if (value.version !== undefined && (!Number.isSafeInteger(value.version) || value.version < 0)) {
    return undefined;
  }
  const messages = value.messages.map(parseMessage);
  if (messages.some((message) => message === undefined)) return undefined;
  const completeMessages = messages.filter(
    (message): message is ThreadMessage => message !== undefined
  );
  if (value.status !== 'open' && value.status !== 'resolved') return undefined;
  if (value.status === 'resolved') {
    if (!stringWithin(value.resolvedAt, 64) || Number.isNaN(Date.parse(value.resolvedAt))) {
      return undefined;
    }
    return {
      id: value.id,
      ...(value.version === undefined ? {} : { version: value.version }),
      pin,
      messages: completeMessages,
      status: 'resolved',
      resolvedAt: value.resolvedAt
    };
  }
  if (value.resolvedAt !== undefined) return undefined;
  return {
    id: value.id,
    ...(value.version === undefined ? {} : { version: value.version }),
    pin,
    messages: completeMessages,
    status: 'open'
  };
}

function parseThreads(value: unknown, binding: ReviewArtifactBinding): readonly ReviewThread[] {
  if (!Array.isArray(value) || value.length > maxThreads) return [];
  const threads = value.map((thread) => parseThread(thread, binding));
  if (threads.some((thread) => thread === undefined)) return [];
  const completeThreads = threads.filter((thread): thread is ReviewThread => thread !== undefined);
  if (new Set(completeThreads.map((thread) => thread.id)).size !== completeThreads.length) {
    return [];
  }
  const aggregateMessageCharacters = completeThreads.reduce(
    (total, thread) =>
      total +
      thread.messages.reduce((messageTotal, message) => messageTotal + message.body.length, 0),
    0
  );
  return aggregateMessageCharacters <= maxAggregateMessageCharacters ? completeThreads : [];
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function createHostedReviewCollaboration(
  storage: ReviewStoragePort
): HostedReviewCollaborationPort {
  return {
    load(binding) {
      try {
        const serialized = storage.getItem(reviewStorageKey(binding));
        if (serialized === null || byteLength(serialized) > maxStorageBytes) return [];
        return parseThreads(JSON.parse(serialized), binding);
      } catch {
        return [];
      }
    },
    save(binding, threads) {
      const boundedThreads = parseThreads(threads, binding);
      if (boundedThreads.length !== threads.length) return { ok: false, code: 'invalid' };
      const serialized = JSON.stringify(boundedThreads);
      if (byteLength(serialized) > maxStorageBytes) return { ok: false, code: 'oversize' };
      try {
        storage.setItem(reviewStorageKey(binding), serialized);
        return { ok: true };
      } catch {
        return { ok: false, code: 'quota' };
      }
    }
  };
}

/** Durable browser-local collaboration for a static artifact; no remote provider is present. */
export const browserHostedReviewCollaboration = createHostedReviewCollaboration({
  getItem(key) {
    return window.localStorage.getItem(key);
  },
  setItem(key, value) {
    window.localStorage.setItem(key, value);
  }
});
