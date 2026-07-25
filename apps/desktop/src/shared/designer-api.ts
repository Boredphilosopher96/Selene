import type {
  DesignBaselineState,
  EnterpriseScenario,
  NodeMetadata,
  PrototypeGraph,
  PrototypeRuntimeSnapshot,
  ReactSourceWorkspace
} from '@selene/core';

/** Versioned, data-only contract exposed by the Electron preload bridge. */
export const DESIGNER_API_VERSION = 'selene-desktop-designer/v3' as const;

/** Fail clearly when a renderer and host from different desktop releases are mixed. */
export function assertDesignerApiVersion(
  value: unknown
): asserts value is typeof DESIGNER_API_VERSION {
  if (value !== DESIGNER_API_VERSION) {
    throw new Error(`Unsupported desktop designer API version: ${String(value)}`);
  }
}

export interface DesignerAgentSummary {
  readonly id: string;
  readonly label: string;
  readonly capabilities: readonly string[];
}

export interface ReviewThread {
  readonly id: string;
  /** Coordinates are normalized to the rendered artifact, not browser pixels. */
  readonly anchor: {
    readonly x: number;
    readonly y: number;
    readonly width?: number;
    readonly height?: number;
    readonly artifactId: string;
    readonly screenId: string;
    readonly scenarioId: string;
    readonly state: string;
    readonly revisionId: string;
    readonly viewport: { readonly width: number; readonly height: number };
    readonly nodeRef?: string;
  };
  readonly body: string;
  readonly author: string;
  readonly createdAt: string;
}

export interface DeveloperHandoffAnnotation {
  readonly id: string;
  readonly category: 'implementation' | 'accessibility' | 'behavior' | 'visual';
  readonly body: string;
  readonly nodeRef?: string;
  readonly createdAt: string;
}

export interface DesignerProgress {
  readonly requestId: string;
  readonly agentId: string;
  readonly stage: 'started' | 'thinking' | 'applying' | 'completed' | 'cancelled' | 'error';
  readonly message: string;
}

export type PrototypeTransition =
  | { readonly kind: 'navigate'; readonly toScreenId: string }
  | { readonly kind: 'back' }
  | { readonly kind: 'set-state'; readonly state: string }
  | { readonly kind: 'open-overlay'; readonly overlayId: string }
  | { readonly kind: 'close-overlay'; readonly overlayId: string };

export interface PrototypeFlowGraph {
  readonly format: 'selene-prototype-flow/v1';
  readonly nodes: readonly {
    readonly id: string;
    readonly kind: 'screen' | 'overlay';
    readonly title: string;
    readonly states: readonly string[];
  }[];
  readonly connections: readonly {
    readonly id: string;
    readonly fromNodeId: string;
    readonly actionPort: string;
    readonly transition: PrototypeTransition;
  }[];
}

export interface DesignerSnapshot {
  readonly apiVersion: typeof DESIGNER_API_VERSION;
  readonly agents: readonly DesignerAgentSummary[];
  readonly selectedAgentId: string;
  readonly source: ReactSourceWorkspace;
  readonly nodes: readonly NodeMetadata[];
  readonly selectedNodeId?: string;
  /** Deployed-artifact human review data. Local persistence/lifecycle is a later slice. */
  readonly reviewThreads: readonly ReviewThread[];
  /** Local Claude Design-style changes, including their durable request lifecycle. */
  readonly aiChangeRequests: readonly AIChangeRequest[];
  readonly developerAnnotations: readonly DeveloperHandoffAnnotation[];
  readonly scenarios: readonly EnterpriseScenario[];
  readonly selectedScenarioId: string;
  readonly baseline: DesignBaselineState;
  readonly prototype: { readonly flow: PrototypeFlowGraph; readonly currentScreenId: string };
  /** Editable graph is host-owned data; the renderer receives no filesystem authority. */
  readonly editablePrototype: {
    readonly graph: PrototypeGraph;
    readonly mode: 'edit' | 'run';
    readonly revision: number;
    readonly runtime?: PrototypeRuntimeSnapshot;
  };
  readonly componentCatalog: {
    readonly entries: readonly { readonly component: string; readonly href: string }[];
  };
  readonly activity: readonly string[];
}

export interface PrototypeRunAction { readonly nodeId: string; readonly portId: string; }
export function validatePrototypeRunAction(value: unknown): PrototypeRunAction {
  const input = record(value, 'prototype run action');
  return { nodeId: validateDesignerIdentifier(input.nodeId, 'nodeId'), portId: validateDesignerIdentifier(input.portId, 'portId') };
}

export interface AIChangeRequestInput {
  readonly agentId: string;
  readonly instruction: string;
  readonly target: SpatialTargetInput;
}

export interface SpatialTargetInput {
  readonly x: number;
  readonly y: number;
  readonly width?: number;
  readonly height?: number;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly nodeRef?: string;
}

export interface ReviewThreadInput {
  readonly body: string;
  readonly anchor: SpatialTargetInput;
}

export interface DesignerPublishInput {
  readonly repository: string;
  readonly title: string;
  readonly consentId: string;
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
export interface GeneratedCodePublishOperation {
  readonly id: string;
  readonly status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly progress: readonly string[];
  readonly receipt?: GeneratedCodePublishReceipt;
  readonly error?: { readonly code: 'OFFLINE' | 'AUTH_REQUIRED' | 'CONFLICT' | 'CANCELLED' | 'UNKNOWN'; readonly message: string };
}
export interface GeneratedCodePublishStart { readonly id: string; readonly status: 'running'; }

export interface AIChangeRequest {
  readonly id: string;
  readonly agentId: string;
  readonly instruction: string;
  readonly target: SpatialTargetInput & {
    readonly artifactId: string;
    readonly screenId: string;
    readonly scenarioId: string;
    readonly state: string;
    readonly revisionId: string;
  };
  readonly status: 'queued' | 'running' | 'applied' | 'failed' | 'cancelled';
  readonly createdAt: string;
  readonly resultingRevisionId?: string;
  readonly error?: string;
}

export interface LegacySpatialTarget {
  readonly anchor: {
    readonly x: number;
    readonly y: number;
    readonly width?: number;
    readonly height?: number;
    readonly viewport: { readonly width: number; readonly height: number };
    readonly nodeRef?: string;
  };
}

export interface DeveloperAnnotationInput {
  readonly category: 'implementation' | 'accessibility' | 'behavior' | 'visual';
  readonly body: string;
  readonly nodeRef?: string;
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

/** Reject renderer-controlled identifiers before they reach an application service or IPC adapter. */
export function validateDesignerIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !identifier.test(value))
    throw new Error(`${name} must be a valid identifier`);
  return value;
}

function instruction(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 4_000)
    throw new Error(`${name} must be between 1 and 4000 characters`);
  return value.trim();
}

export function validateAIChangeRequest(value: unknown): AIChangeRequestInput {
  const input = record(value, 'AI change request');
  const agentId = validateDesignerIdentifier(input.agentId, 'agentId');
  return {
    agentId,
    instruction: instruction(input.instruction, 'instruction'),
    target: validateSpatialTarget(input.target)
  };
}

function boundedCoordinate(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    throw new Error(`${name} must be a normalized coordinate`);
  return value;
}

function boundedViewport(value: unknown): { readonly width: number; readonly height: number } {
  const viewport = record(value, 'viewport');
  if (
    typeof viewport.width !== 'number' ||
    !Number.isSafeInteger(viewport.width) ||
    viewport.width < 1 ||
    viewport.width > 8_192 ||
    typeof viewport.height !== 'number' ||
    !Number.isSafeInteger(viewport.height) ||
    viewport.height < 1 ||
    viewport.height > 8_192
  )
    throw new Error('viewport dimensions must be positive bounded integers');
  return { width: viewport.width, height: viewport.height };
}

function body(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 4_000)
    throw new Error(`${name} body must be between 1 and 4000 characters`);
  return value.trim();
}

export function validateSpatialTarget(value: unknown): SpatialTargetInput {
  const anchor = record(value, 'spatial target');
  const x = boundedCoordinate(anchor.x, 'anchor.x');
  const y = boundedCoordinate(anchor.y, 'anchor.y');
  const width =
    anchor.width === undefined ? undefined : boundedCoordinate(anchor.width, 'anchor.width');
  const height =
    anchor.height === undefined ? undefined : boundedCoordinate(anchor.height, 'anchor.height');
  if ((width === undefined) !== (height === undefined))
    throw new Error('anchor.width and anchor.height must be provided together');
  if (width !== undefined && height !== undefined) {
    if (width === 0 || height === 0)
      throw new Error('spatial regions must have non-zero dimensions');
    if (x + width > 1 || y + height > 1)
      throw new Error('spatial region must remain within normalized bounds');
  }
  const nodeRef =
    anchor.nodeRef === undefined
      ? undefined
      : validateDesignerIdentifier(anchor.nodeRef, 'anchor.nodeRef');
  return {
    x,
    y,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    viewport: boundedViewport(anchor.viewport),
    ...(nodeRef === undefined ? {} : { nodeRef })
  };
}

export function validateReviewThread(value: unknown): ReviewThreadInput {
  const input = record(value, 'review thread');
  return { body: body(input.body, 'review thread'), anchor: validateSpatialTarget(input.anchor) };
}

export function validateDesignerPublish(value: unknown): DesignerPublishInput {
  const input = record(value, 'GitHub publish request');
  const repository = instruction(input.repository, 'repository');
  const title = instruction(input.title, 'title');
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository))
    throw new Error('repository must use owner/name form');
  if (title.length > 240) throw new Error('title must be at most 240 characters');
  return { repository, title, consentId: validateDesignerIdentifier(input.consentId, 'consentId') };
}

export function validatePrototypeTransition(value: unknown): PrototypeTransition {
  const transition = record(value, 'prototype transition');
  switch (transition.kind) {
    case 'navigate':
      return {
        kind: 'navigate',
        toScreenId: validateDesignerIdentifier(transition.toScreenId, 'toScreenId')
      };
    case 'back':
      return { kind: 'back' };
    case 'set-state':
      return { kind: 'set-state', state: validateDesignerIdentifier(transition.state, 'state') };
    case 'open-overlay':
    case 'close-overlay':
      return {
        kind: transition.kind,
        overlayId: validateDesignerIdentifier(transition.overlayId, 'overlayId')
      };
    default:
      throw new Error('unknown prototype transition');
  }
}

export function validateDeveloperAnnotation(value: unknown): DeveloperAnnotationInput {
  const input = record(value, 'developer annotation');
  if (
    input.category !== 'implementation' &&
    input.category !== 'accessibility' &&
    input.category !== 'behavior' &&
    input.category !== 'visual'
  )
    throw new Error('developer annotation category is invalid');
  const nodeRef =
    input.nodeRef === undefined ? undefined : validateDesignerIdentifier(input.nodeRef, 'nodeRef');
  return {
    category: input.category,
    body: body(input.body, 'developer annotation'),
    ...(nodeRef === undefined ? {} : { nodeRef })
  };
}
