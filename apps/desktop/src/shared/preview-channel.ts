/**
 * Data-only MessageChannel contract between the trusted designer renderer and
 * a generated preview. Both ends validate this shape before acting on it.
 */
export const PREVIEW_FRAME_MESSAGE_TYPES = [
  'ready',
  'select-node',
  'trigger-action',
  'rendered',
  'runtime-error'
] as const;

export type PreviewFrameMessageType = (typeof PREVIEW_FRAME_MESSAGE_TYPES)[number];

export interface PreviewFrameMessage {
  readonly type: PreviewFrameMessageType;
  readonly nonce: string;
  readonly origin: string;
  readonly revisionId: string;
  readonly nodeId?: string;
  readonly portId?: string;
  readonly message?: string;
}

export interface PreviewRuntimeState {
  readonly activeNodeId: string;
  readonly activeStateId?: string;
  readonly activeOverlayId?: string;
  readonly activePathTransitionIds: readonly string[];
}

export interface PreviewRuntimeStateMessage {
  readonly type: 'runtime-state';
  readonly nonce: string;
  readonly origin: string;
  readonly revisionId: string;
  readonly state: PreviewRuntimeState;
}

export interface PreviewChannelInitMessage {
  readonly type: 'selene-preview-init';
  readonly nonce: string;
  readonly revisionId: string;
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function keysAreExact(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  try {
    return Object.keys(value).every((key) => allowed.includes(key));
  } catch {
    return false;
  }
}

function stringField(value: Record<string, unknown>, key: string, limit: number): string | undefined {
  try {
    const field = value[key];
    return typeof field === 'string' && field.length > 0 && field.length <= limit ? field : undefined;
  } catch {
    return undefined;
  }
}

function identifierField(value: Record<string, unknown>, key: string): string | undefined {
  const field = stringField(value, key, 128);
  return field !== undefined && identifier.test(field) ? field : undefined;
}

export function validatePreviewFrameMessage(
  value: unknown,
  expected: Readonly<{ nonce: string; origin: string; revisionId: string }>
): PreviewFrameMessage | undefined {
  const record = plainRecord(value);
  if (!record || !keysAreExact(record, ['type', 'nonce', 'origin', 'revisionId', 'nodeId', 'portId', 'message'])) return undefined;
  const type = stringField(record, 'type', 32) as PreviewFrameMessageType | undefined;
  if (!type || !PREVIEW_FRAME_MESSAGE_TYPES.includes(type)) return undefined;
  if (record.nonce !== expected.nonce || record.origin !== expected.origin || record.revisionId !== expected.revisionId)
    return undefined;
  const nodeId = record.nodeId === undefined ? undefined : identifierField(record, 'nodeId');
  const portId = record.portId === undefined ? undefined : identifierField(record, 'portId');
  const message = record.message === undefined ? undefined : stringField(record, 'message', 4_000);
  if ((record.nodeId !== undefined && !nodeId) || (record.portId !== undefined && !portId) || (record.message !== undefined && !message)) return undefined;
  if ((type === 'select-node' && !nodeId) || (type === 'trigger-action' && (!nodeId || !portId)) || (type === 'runtime-error' && !message)) return undefined;
  if ((type === 'ready' || type === 'rendered') && (nodeId || portId || message)) return undefined;
  return { type, nonce: expected.nonce, origin: expected.origin, revisionId: expected.revisionId, ...(nodeId ? { nodeId } : {}), ...(portId ? { portId } : {}), ...(message ? { message } : {}) };
}

export function validatePreviewRuntimeState(value: unknown): PreviewRuntimeState | undefined {
  const record = plainRecord(value);
  if (!record || !keysAreExact(record, ['activeNodeId', 'activeStateId', 'activeOverlayId', 'activePathTransitionIds'])) return undefined;
  const activeNodeId = identifierField(record, 'activeNodeId');
  const activeStateId = record.activeStateId === undefined ? undefined : identifierField(record, 'activeStateId');
  const activeOverlayId = record.activeOverlayId === undefined ? undefined : identifierField(record, 'activeOverlayId');
  if (!activeNodeId || (record.activeStateId !== undefined && !activeStateId) || (record.activeOverlayId !== undefined && !activeOverlayId)) return undefined;
  try {
    if (!Array.isArray(record.activePathTransitionIds) || record.activePathTransitionIds.length > 256) return undefined;
    const activePathTransitionIds = record.activePathTransitionIds.every((item) => typeof item === 'string' && identifier.test(item))
      ? [...record.activePathTransitionIds]
      : undefined;
    return activePathTransitionIds === undefined ? undefined : { activeNodeId, ...(activeStateId ? { activeStateId } : {}), ...(activeOverlayId ? { activeOverlayId } : {}), activePathTransitionIds };
  } catch {
    return undefined;
  }
}

export function validatePreviewRuntimeStateMessage(
  value: unknown,
  expected: Readonly<{ nonce: string; origin: string; revisionId: string }>
): PreviewRuntimeStateMessage | undefined {
  const record = plainRecord(value);
  if (!record || !keysAreExact(record, ['type', 'nonce', 'origin', 'revisionId', 'state']) || record.type !== 'runtime-state' || record.nonce !== expected.nonce || record.origin !== expected.origin || record.revisionId !== expected.revisionId) return undefined;
  const state = validatePreviewRuntimeState(record.state);
  return state ? { type: 'runtime-state', nonce: expected.nonce, origin: expected.origin, revisionId: expected.revisionId, state } : undefined;
}
