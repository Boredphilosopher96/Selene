/**
 * Data-only MessageChannel contract between the trusted designer renderer and
 * a generated preview. Both ends validate this shape before acting on it.
 */
export const PREVIEW_FRAME_MESSAGE_TYPES = [
  'ready',
  'select-node',
  'trigger-action',
  'target-cancel',
  'canvas-gesture',
  'rendered',
  'runtime-error'
] as const;

export type PreviewFrameMessageType = (typeof PREVIEW_FRAME_MESSAGE_TYPES)[number];
export type PreviewCanvasGestureKind = 'pan' | 'zoom';

/**
 * Bounded, read-only values measured inside the authenticated preview frame.
 * Empty accessibility strings mean that the corresponding explicit attribute
 * was not present; they must not be presented as inferred browser semantics.
 */
export interface PreviewElementTelemetry {
  readonly width: number;
  readonly height: number;
  readonly display: string;
  readonly position: string;
  readonly boxSizing: string;
  readonly margin: string;
  readonly padding: string;
  readonly gap: string;
  readonly flexDirection: string;
  readonly alignItems: string;
  readonly justifyContent: string;
  readonly gridTemplateColumns: string;
  readonly gridTemplateRows: string;
  readonly overflow: string;
  readonly fontFamily: string;
  readonly fontSize: string;
  readonly fontWeight: string;
  readonly lineHeight: string;
  readonly letterSpacing: string;
  readonly textAlign: string;
  readonly textDecoration: string;
  readonly color: string;
  readonly backgroundColor: string;
  readonly border: string;
  readonly borderRadius: string;
  readonly boxShadow: string;
  readonly opacity: string;
  /** The actual HTML tag, kept separate from any explicit ARIA role. */
  readonly semanticTag: string;
  /** Empty when the selected element has no explicit role attribute. */
  readonly explicitAriaRole: string;
  /** Empty when the selected element has no explicit aria-label attribute. */
  readonly ariaLabel: string;
  /** Empty when neither aria-description nor title is explicitly present. */
  readonly accessibleDescription: string;
  readonly ariaDisabled: string;
  readonly ariaExpanded: string;
  readonly ariaPressed: string;
  readonly ariaChecked: string;
  readonly ariaSelected: string;
  readonly ariaHidden: string;
  readonly tabIndex: number;
}

/**
 * Renderer-local provenance attached only after the trusted host confirms that
 * its durable selection still matches the authenticated frame and revision.
 */
export interface PreviewElementTelemetrySelection {
  readonly provenance: 'authenticated-preview';
  readonly nodeId: string;
  readonly revisionId: string;
  readonly values: PreviewElementTelemetry;
}

export interface PreviewCanvasGesture {
  readonly gesture: PreviewCanvasGestureKind;
  readonly deltaX: number;
  readonly deltaY: number;
  /** Horizontal pointer position normalized to the preview viewport. */
  readonly x: number;
  /** Vertical pointer position normalized to the preview viewport. */
  readonly y: number;
}

interface PreviewFrameEnvelope {
  readonly nonce: string;
  readonly origin: string;
  readonly revisionId: string;
}

export type PreviewFrameMessage =
  | (PreviewFrameEnvelope & { readonly type: 'ready' | 'rendered' })
  | (PreviewFrameEnvelope & {
      readonly type: 'select-node';
      readonly nodeId: string;
      readonly telemetry: PreviewElementTelemetry;
    })
  | (PreviewFrameEnvelope & {
      readonly type: 'trigger-action';
      readonly nodeId: string;
      readonly portId: string;
    })
  /** A capability-gated Escape intent; it carries no DOM, key, or source data. */
  | (PreviewFrameEnvelope & { readonly type: 'target-cancel' })
  | (PreviewFrameEnvelope & { readonly type: 'canvas-gesture' } & PreviewCanvasGesture)
  | (PreviewFrameEnvelope & { readonly type: 'runtime-error'; readonly message: string });

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

export interface PreviewCanvasNavigationMessage {
  readonly type: 'canvas-navigation';
  readonly nonce: string;
  readonly origin: string;
  readonly revisionId: string;
  readonly enabled: boolean;
}

/** Host-to-preview gate for the sole cross-document Escape intent. */
export interface PreviewTargetCancelMessage {
  readonly type: 'target-cancel';
  readonly nonce: string;
  readonly origin: string;
  readonly revisionId: string;
  readonly enabled: boolean;
}

export interface PreviewChannelInitMessage {
  readonly type: 'selene-preview-init';
  readonly nonce: string;
  readonly revisionId: string;
}

export const PREVIEW_CANVAS_GESTURE_EVENT = 'selene-preview-canvas-gesture';
export const PREVIEW_CANVAS_NAVIGATION_EVENT = 'selene-preview-canvas-navigation';
export const PREVIEW_TARGET_CANCEL_EVENT = 'selene-preview-target-cancel';
export const PREVIEW_CANVAS_GESTURE_DELTA_LIMIT = 512;

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function dataRecord(
  value: unknown,
  allowed: readonly string[]
): Readonly<Record<string, unknown>> | undefined {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some((key) => typeof key !== 'string' || !allowed.includes(key)) ||
      keys.some((key) => {
        const descriptor = descriptors[key as string];
        return (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        );
      })
    )
      return undefined;
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) result[key as string] = descriptors[key as string]!.value;
    return Object.freeze(result);
  } catch {
    return undefined;
  }
}

function stringArray(value: unknown, limit: number): readonly string[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      length === undefined ||
      !Object.prototype.hasOwnProperty.call(length, 'value') ||
      length.enumerable ||
      typeof length.value !== 'number' ||
      !Number.isSafeInteger(length.value) ||
      length.value < 0 ||
      length.value > limit
    )
      return undefined;
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== length.value + 1) return undefined;
    const result: string[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
        typeof descriptor.value !== 'string' ||
        !identifier.test(descriptor.value)
      )
        return undefined;
      result.push(descriptor.value);
    }
    return Object.freeze(result);
  } catch {
    return undefined;
  }
}

function stringField(
  value: Readonly<Record<string, unknown>>,
  key: string,
  limit: number
): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field.length > 0 && field.length <= limit ? field : undefined;
}

function identifierField(
  value: Readonly<Record<string, unknown>>,
  key: string
): string | undefined {
  const field = stringField(value, key, 128);
  return field !== undefined && identifier.test(field) ? field : undefined;
}

function finiteNumberField(
  value: Readonly<Record<string, unknown>>,
  key: string,
  minimum: number,
  maximum: number
): number | undefined {
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) && field >= minimum && field <= maximum
    ? field
    : undefined;
}

function boundedTextField(
  value: Readonly<Record<string, unknown>>,
  key: string,
  limit = 256
): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field.length <= limit ? field : undefined;
}

function previewElementTelemetry(value: unknown): PreviewElementTelemetry | undefined {
  const keys = [
    'width',
    'height',
    'display',
    'position',
    'boxSizing',
    'margin',
    'padding',
    'gap',
    'flexDirection',
    'alignItems',
    'justifyContent',
    'gridTemplateColumns',
    'gridTemplateRows',
    'overflow',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'letterSpacing',
    'textAlign',
    'textDecoration',
    'color',
    'backgroundColor',
    'border',
    'borderRadius',
    'boxShadow',
    'opacity',
    'semanticTag',
    'explicitAriaRole',
    'ariaLabel',
    'accessibleDescription',
    'ariaDisabled',
    'ariaExpanded',
    'ariaPressed',
    'ariaChecked',
    'ariaSelected',
    'ariaHidden',
    'tabIndex'
  ] as const;
  const record = dataRecord(value, keys);
  if (!record) return undefined;
  const width = finiteNumberField(record, 'width', 0, 100_000);
  const height = finiteNumberField(record, 'height', 0, 100_000);
  const tabIndex = finiteNumberField(record, 'tabIndex', -1, 32_767);
  const text = Object.fromEntries(
    keys
      .filter((key) => key !== 'width' && key !== 'height' && key !== 'tabIndex')
      .map((key) => [key, boundedTextField(record, key, key === 'boxShadow' ? 512 : 256)])
  ) as Readonly<Record<string, string | undefined>>;
  if (
    width === undefined ||
    height === undefined ||
    tabIndex === undefined ||
    !Number.isSafeInteger(tabIndex) ||
    Object.values(text).some((field) => field === undefined) ||
    !/^[a-z][a-z0-9-]{0,127}$/.test(text.semanticTag ?? '')
  )
    return undefined;
  return {
    width,
    height,
    display: text.display!,
    position: text.position!,
    boxSizing: text.boxSizing!,
    margin: text.margin!,
    padding: text.padding!,
    gap: text.gap!,
    flexDirection: text.flexDirection!,
    alignItems: text.alignItems!,
    justifyContent: text.justifyContent!,
    gridTemplateColumns: text.gridTemplateColumns!,
    gridTemplateRows: text.gridTemplateRows!,
    overflow: text.overflow!,
    fontFamily: text.fontFamily!,
    fontSize: text.fontSize!,
    fontWeight: text.fontWeight!,
    lineHeight: text.lineHeight!,
    letterSpacing: text.letterSpacing!,
    textAlign: text.textAlign!,
    textDecoration: text.textDecoration!,
    color: text.color!,
    backgroundColor: text.backgroundColor!,
    border: text.border!,
    borderRadius: text.borderRadius!,
    boxShadow: text.boxShadow!,
    opacity: text.opacity!,
    semanticTag: text.semanticTag!,
    explicitAriaRole: text.explicitAriaRole!,
    ariaLabel: text.ariaLabel!,
    accessibleDescription: text.accessibleDescription!,
    ariaDisabled: text.ariaDisabled!,
    ariaExpanded: text.ariaExpanded!,
    ariaPressed: text.ariaPressed!,
    ariaChecked: text.ariaChecked!,
    ariaSelected: text.ariaSelected!,
    ariaHidden: text.ariaHidden!,
    tabIndex
  };
}

export function previewCanvasGesture(value: unknown): PreviewCanvasGesture | undefined {
  const record = dataRecord(value, ['gesture', 'deltaX', 'deltaY', 'x', 'y']);
  if (!record || (record.gesture !== 'pan' && record.gesture !== 'zoom')) return undefined;
  const deltaX = finiteNumberField(
    record,
    'deltaX',
    -PREVIEW_CANVAS_GESTURE_DELTA_LIMIT,
    PREVIEW_CANVAS_GESTURE_DELTA_LIMIT
  );
  const deltaY = finiteNumberField(
    record,
    'deltaY',
    -PREVIEW_CANVAS_GESTURE_DELTA_LIMIT,
    PREVIEW_CANVAS_GESTURE_DELTA_LIMIT
  );
  const x = finiteNumberField(record, 'x', 0, 1);
  const y = finiteNumberField(record, 'y', 0, 1);
  if (deltaX === undefined || deltaY === undefined || x === undefined || y === undefined)
    return undefined;
  return { gesture: record.gesture, deltaX, deltaY, x, y };
}

export function validatePreviewFrameMessage(
  value: unknown,
  expected: Readonly<{ nonce: string; origin: string; revisionId: string }>
): PreviewFrameMessage | undefined {
  const record = dataRecord(value, [
    'type',
    'nonce',
    'origin',
    'revisionId',
    'nodeId',
    'portId',
    'message',
    'telemetry',
    'gesture',
    'deltaX',
    'deltaY',
    'x',
    'y'
  ]);
  if (!record) return undefined;
  const type = stringField(record, 'type', 32) as PreviewFrameMessageType | undefined;
  if (!type || !PREVIEW_FRAME_MESSAGE_TYPES.includes(type)) return undefined;
  if (
    record.nonce !== expected.nonce ||
    record.origin !== expected.origin ||
    record.revisionId !== expected.revisionId
  )
    return undefined;
  const nodeId = record.nodeId === undefined ? undefined : identifierField(record, 'nodeId');
  const portId = record.portId === undefined ? undefined : identifierField(record, 'portId');
  const message = record.message === undefined ? undefined : stringField(record, 'message', 4_000);
  const telemetry =
    record.telemetry === undefined ? undefined : previewElementTelemetry(record.telemetry);
  const canvasGesture =
    type === 'canvas-gesture'
      ? previewCanvasGesture({
          gesture: record.gesture,
          deltaX: record.deltaX,
          deltaY: record.deltaY,
          x: record.x,
          y: record.y
        })
      : undefined;
  const hasCanvasGestureFields =
    record.gesture !== undefined ||
    record.deltaX !== undefined ||
    record.deltaY !== undefined ||
    record.x !== undefined ||
    record.y !== undefined;
  if (
    (record.nodeId !== undefined && !nodeId) ||
    (record.portId !== undefined && !portId) ||
    (record.message !== undefined && !message) ||
    (record.telemetry !== undefined && !telemetry)
  )
    return undefined;
  if (
    (type === 'select-node' && (!nodeId || !telemetry)) ||
    (type === 'trigger-action' && (!nodeId || !portId)) ||
    (type === 'runtime-error' && !message) ||
    (type === 'canvas-gesture' && !canvasGesture)
  )
    return undefined;
  if (
    (type === 'canvas-gesture' && (nodeId || portId || message || telemetry)) ||
    (type !== 'canvas-gesture' && hasCanvasGestureFields) ||
    (type === 'select-node' && (portId || message)) ||
    (type === 'trigger-action' && (message || telemetry)) ||
    (type === 'runtime-error' && (nodeId || portId || telemetry)) ||
    ((type === 'ready' || type === 'rendered' || type === 'target-cancel') &&
      (nodeId || portId || message || telemetry))
  )
    return undefined;
  const envelope = {
    nonce: expected.nonce,
    origin: expected.origin,
    revisionId: expected.revisionId
  };
  if (type === 'select-node' && nodeId && telemetry)
    return { ...envelope, type, nodeId, telemetry };
  if (type === 'trigger-action' && nodeId && portId) return { ...envelope, type, nodeId, portId };
  if (type === 'canvas-gesture' && canvasGesture) return { ...envelope, type, ...canvasGesture };
  if (type === 'runtime-error' && message) return { ...envelope, type, message };
  if (type === 'ready' || type === 'rendered' || type === 'target-cancel')
    return { ...envelope, type };
  return undefined;
}

export function validatePreviewRuntimeState(value: unknown): PreviewRuntimeState | undefined {
  const record = dataRecord(value, [
    'activeNodeId',
    'activeStateId',
    'activeOverlayId',
    'activePathTransitionIds'
  ]);
  if (!record) return undefined;
  const activeNodeId = identifierField(record, 'activeNodeId');
  const activeStateId =
    record.activeStateId === undefined ? undefined : identifierField(record, 'activeStateId');
  const activeOverlayId =
    record.activeOverlayId === undefined ? undefined : identifierField(record, 'activeOverlayId');
  if (
    !activeNodeId ||
    (record.activeStateId !== undefined && !activeStateId) ||
    (record.activeOverlayId !== undefined && !activeOverlayId)
  )
    return undefined;
  try {
    const activePathTransitionIds = stringArray(record.activePathTransitionIds, 256);
    return activePathTransitionIds === undefined
      ? undefined
      : {
          activeNodeId,
          ...(activeStateId ? { activeStateId } : {}),
          ...(activeOverlayId ? { activeOverlayId } : {}),
          activePathTransitionIds
        };
  } catch {
    return undefined;
  }
}

export function validatePreviewRuntimeStateMessage(
  value: unknown,
  expected: Readonly<{ nonce: string; origin: string; revisionId: string }>
): PreviewRuntimeStateMessage | undefined {
  const record = dataRecord(value, ['type', 'nonce', 'origin', 'revisionId', 'state']);
  if (
    !record ||
    record.type !== 'runtime-state' ||
    record.nonce !== expected.nonce ||
    record.origin !== expected.origin ||
    record.revisionId !== expected.revisionId
  )
    return undefined;
  const state = validatePreviewRuntimeState(record.state);
  return state
    ? {
        type: 'runtime-state',
        nonce: expected.nonce,
        origin: expected.origin,
        revisionId: expected.revisionId,
        state
      }
    : undefined;
}
