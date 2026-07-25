import type {
  DesignBaselineState,
  EnterpriseScenario,
  NodeMetadata,
  PrototypeGraph,
  PrototypeRuntimeSnapshot,
  ReactSourceWorkspace
} from '@selene/core';

import { canonicalGitHubOwnerLogin, canonicalGitHubRepository } from './github-repository';

/** Versioned, data-only contract exposed by the Electron preload bridge. */
export const DESIGNER_API_VERSION = 'selene-desktop-designer/v4' as const;

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

/** Renderer workspace chrome only; source, collaboration, and project state never pass through this preference boundary. */
export interface WorkspaceCockpitPreferences {
  readonly format: 'selene-workspace-cockpit-preferences/v1';
  readonly leftRailWidth: number;
  readonly rightRailWidth: number;
  readonly leftRailCollapsed: boolean;
  readonly rightRailCollapsed: boolean;
  readonly inspectorTab: 'inspect' | 'flow' | 'reviews' | 'handoff' | 'setup';
}
export const defaultWorkspaceCockpitPreferences: WorkspaceCockpitPreferences = Object.freeze({
  format: 'selene-workspace-cockpit-preferences/v1',
  leftRailWidth: 300,
  rightRailWidth: 340,
  leftRailCollapsed: false,
  rightRailCollapsed: false,
  inspectorTab: 'inspect'
});
export function validateWorkspaceCockpitPreferences(value: unknown): WorkspaceCockpitPreferences {
  const input = record(value, 'workspace cockpit preferences');
  const width = (name: 'leftRailWidth' | 'rightRailWidth') => {
    const candidate = input[name];
    if (
      typeof candidate !== 'number' ||
      !Number.isInteger(candidate) ||
      candidate < 220 ||
      candidate > 520
    )
      throw new Error(`${name} must be an integer from 220 to 520`);
    return candidate;
  };
  const bool = (name: 'leftRailCollapsed' | 'rightRailCollapsed') => {
    if (typeof input[name] !== 'boolean') throw new Error(`${name} must be boolean`);
    return input[name];
  };
  const tab = input.inspectorTab;
  if (
    tab !== 'inspect' &&
    tab !== 'flow' &&
    tab !== 'reviews' &&
    tab !== 'handoff' &&
    tab !== 'setup'
  )
    throw new Error('inspectorTab is invalid');
  if (input.format !== 'selene-workspace-cockpit-preferences/v1')
    throw new Error('workspace cockpit preference format is invalid');
  return {
    format: 'selene-workspace-cockpit-preferences/v1',
    leftRailWidth: width('leftRailWidth'),
    rightRailWidth: width('rightRailWidth'),
    leftRailCollapsed: bool('leftRailCollapsed'),
    rightRailCollapsed: bool('rightRailCollapsed'),
    inspectorTab: tab
  };
}

export interface ReviewThread {
  readonly id: string;
  readonly status: 'open' | 'resolved';
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
  readonly replies: readonly {
    readonly id: string;
    readonly body: string;
    readonly author: string;
    readonly createdAt: string;
  }[];
  readonly author: string;
  readonly createdAt: string;
  readonly resolvedAt?: string;
}
export interface ArtifactPin {
  readonly id: string;
  readonly anchor: ReviewThread['anchor'];
  readonly label: string;
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
export interface DesignSystemIntakeReceipt {
  /** A staged package has not been installed, approved, or activated. */
  readonly status: 'staged';
  readonly packageName: string;
  readonly version: string;
  readonly exports: readonly string[];
  readonly peerCompatibility: 'compatible';
  readonly provenance: { readonly provider: string; readonly location: string };
  readonly artifactDigest: string;
  readonly fixture?: string;
}
export interface MarkdownIntakeReceipt {
  readonly status: 'staged';
  readonly provenance: { readonly provider: string; readonly location: string };
  readonly artifactDigest: string;
  readonly sectionCount: number;
  /** Sanitized filename only; imported Markdown and absolute paths remain host-owned. */
  readonly displayLabel?: string;
}
export type MarkdownSourceRefreshResult =
  | { readonly status: 'unchanged'; readonly receipt: MarkdownIntakeReceipt }
  | { readonly status: 'replaced'; readonly receipt: MarkdownIntakeReceipt }
  | { readonly status: 'relinked'; readonly receipt: MarkdownIntakeReceipt }
  | { readonly status: 'unavailable' }
  | { readonly status: 'cancelled' };

export const MAX_DESIGN_LANGUAGE_DISPLAY_LABEL_BYTES = 160;

/** Shared host/persistence policy for a renderer-safe basename, never a source path. */
export function isSafeDesignLanguageDisplayLabel(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.normalize('NFC').trim() ||
    new TextEncoder().encode(value).byteLength > MAX_DESIGN_LANGUAGE_DISPLAY_LABEL_BYTES
  )
    return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      character === '/' ||
      character === '\\' ||
      codePoint === undefined ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x061c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    )
      return false;
  }
  return true;
}
/** A staged package may be included in generation without installing or executing it. */
export interface OrderedDesignSystemInput {
  /** Stable receipt digest; the renderer cannot mint a package input. */
  readonly id: string;
  /** Disabled inputs remain staged and persisted, but are omitted from the active generation set. */
  readonly enabled: boolean;
  readonly receipt: DesignSystemIntakeReceipt;
}
/** Data-only ordered update. Omitting an existing input removes it from this project only. */
export interface DesignSystemInputSelection {
  readonly id: string;
  readonly enabled: boolean;
}
/** Markdown remains host-staged provenance; this record never contains its source text. */
export interface OrderedDesignLanguageInput {
  readonly id: string;
  readonly enabled: boolean;
  readonly receipt: MarkdownIntakeReceipt;
}
export interface DesignLanguageInputSelection {
  readonly id: string;
  readonly enabled: boolean;
}
/** Inert, host-validated receipts for the setup currently configured on this project. */
export interface DesignerSetupReceipts {
  /** Ordered package inputs. This is the authoritative multi-package surface. */
  readonly designSystems?: readonly OrderedDesignSystemInput[];
  /** Legacy single-package projection retained for existing consumers. */
  readonly designSystem?: DesignSystemIntakeReceipt;
  /** Ordered Markdown receipts; only enabled entries become generation guidance. */
  readonly designLanguages?: readonly OrderedDesignLanguageInput[];
  /** Legacy single-language projection retained for existing consumers. */
  readonly designLanguage?: MarkdownIntakeReceipt;
}
export interface ProjectSetupReceipt {
  readonly projectId: string;
  readonly name: string;
  readonly origin: 'created' | 'template' | 'imported' | 'sample' | 'duplicated';
  readonly revisionId: string;
}
/** The minimal local-project inventory allowed to cross the preload boundary. */
export interface RecentProject {
  readonly id: string;
  readonly name: string;
}
export interface ProjectOpenResult {
  readonly receipt: ProjectSetupReceipt;
  readonly snapshot: DesignerSnapshot;
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
  readonly artifactPins: readonly ArtifactPin[];
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
  readonly prototypeGraphHydration: {
    readonly state: 'persisted' | 'missing' | 'recovery-required';
    readonly message?: string;
    readonly recovery?: {
      readonly recoveryId: string;
      readonly originalBytes?: number;
      readonly capturedBytes?: number;
      readonly capturedSha256?: string;
    };
  };
  readonly componentCatalog: {
    readonly entries: readonly { readonly component: string; readonly href: string }[];
  };
  /** Staged setup provenance only; package source and filesystem access stay host-owned. */
  readonly setup?: DesignerSetupReceipts;
  readonly activity: readonly string[];
}

export interface PrototypeRunAction {
  readonly nodeId: string;
  readonly portId: string;
}
export function validatePrototypeRunAction(value: unknown): PrototypeRunAction {
  const input = record(value, 'prototype run action');
  return {
    nodeId: validateDesignerIdentifier(input.nodeId, 'nodeId'),
    portId: validateDesignerIdentifier(input.portId, 'portId')
  };
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
export interface ReviewThreadResolutionInput {
  readonly id: string;
  readonly resolved: boolean;
}
export interface ReviewThreadReplyInput {
  readonly id: string;
  readonly body: string;
}
export type DesignerPublishInput =
  | {
      /** Local validation has no repository target. */
      readonly mode: 'local-preview';
      readonly title: string;
      readonly consentId: string;
      readonly repository?: never;
    }
  | {
      readonly mode: 'github-remote';
      readonly repository: string;
      readonly title: string;
      readonly consentId: string;
      readonly provisioning?: GitHubRepositoryProvisioningInput;
    };
export type DesignerPublishConsentInput =
  | { readonly mode: 'local-preview'; readonly title: string; readonly repository?: never }
  | {
      readonly mode: 'github-remote';
      readonly repository: string;
      readonly title: string;
      readonly provisioning?: GitHubRepositoryProvisioningInput;
    };
export interface GitHubRepositoryProvisioningInput {
  readonly create: true;
  readonly owner:
    | { readonly kind: 'current-user'; readonly login: string }
    | { readonly kind: 'organization'; readonly login: string };
  readonly visibility: 'public' | 'private';
  readonly visibilityConfirmed: true;
}
/** Sanitized host setup state; it contains neither executable paths nor credentials. */
export type GitHubPublishSetup =
  | { readonly status: 'unavailable'; readonly reason: 'TOOL_UNAVAILABLE' }
  | { readonly status: 'available'; readonly authentication: 'required' }
  | {
      readonly status: 'available';
      readonly authentication: 'authenticated';
      readonly account: string;
    }
  | { readonly status: 'offline'; readonly reason: 'OFFLINE' | 'RATE_LIMIT' }
  | { readonly status: 'recovery-required'; readonly reason: 'PROCESS_ORPHANED' };
/**
 * Data-only readiness for stakeholder review of one immutable published artifact.
 * `ready` is reserved for a host adapter that has actually synchronized a review
 * backend; a GitHub commit or draft PR alone never implies it.
 */
export type HostedStakeholderReviewStatus =
  | { readonly status: 'pending'; readonly reason: 'SYNCHRONIZATION_QUEUED' }
  | {
      readonly status: 'unconfigured';
      readonly reason: 'COLLABORATION_BACKEND_UNCONFIGURED';
      readonly manifestDigest: string;
    }
  | { readonly status: 'ready'; readonly url: string; readonly manifestDigest: string }
  | {
      readonly status: 'offline';
      readonly reason: 'BACKEND_OFFLINE';
      readonly manifestDigest: string;
      readonly retryable: true;
    }
  | {
      readonly status: 'conflict';
      readonly reason: 'ARTIFACT_CONFLICT';
      readonly manifestDigest: string;
      readonly retryable: true;
    }
  | {
      readonly status: 'permission-required';
      readonly reason: 'BACKEND_PERMISSION_REQUIRED';
      readonly manifestDigest: string;
      readonly retryable: false;
    }
  | {
      readonly status: 'cancelled';
      readonly reason: 'SYNCHRONIZATION_CANCELLED';
      readonly manifestDigest: string;
    }
  | {
      readonly status: 'integrity-error';
      readonly reason: 'BACKEND_RESPONSE_INVALID' | 'ARTIFACT_RECEIPT_INVALID';
    };
/** Static review delivery is independent from synchronized team discussion. */
export type HostedStaticReviewStatus =
  | { readonly status: 'not-generated'; readonly reason: 'STATIC_REVIEW_NOT_GENERATED' }
  | { readonly status: 'ready'; readonly url: string };
export interface HostedReviewReadiness {
  readonly staticReview: HostedStaticReviewStatus;
  readonly collaboration: HostedStakeholderReviewStatus;
}
export type GeneratedCodePublishReceipt =
  | {
      readonly mode: 'local-preview';
      readonly status: 'local-bundle-validated';
      readonly bundleDigest: string;
      readonly filePlanDigest: string;
      readonly artifactDigest: string;
      readonly validation: 'fixture' | 'materialized-lock';
      readonly immutableId: string;
    }
  | {
      readonly mode: 'github-remote';
      readonly status: 'remote-published';
      readonly repository: string;
      readonly bundleDigest: string;
      readonly filePlanDigest: string;
      readonly lockDigest: string;
      readonly artifactDigest: string;
      readonly treeSha: string;
      readonly commitSha: string;
      readonly ref: string;
      readonly pullRequestUrl: string;
      readonly immutableId: string;
      readonly hostedReview: HostedReviewReadiness;
    };
export interface GeneratedCodePublishOperation {
  readonly id: string;
  readonly status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly progress: readonly string[];
  readonly receipt?: GeneratedCodePublishReceipt;
  readonly cancellationRequested?: boolean;
  readonly error?: {
    readonly code:
      | 'OFFLINE'
      | 'AUTH_REQUIRED'
      | 'CONFLICT'
      | 'CANCELLED'
      | 'CLEANUP_FAILED'
      | 'TOOL_UNAVAILABLE'
      | 'TIMEOUT'
      | 'PROCESS_FAILED'
      | 'PROCESS_ORPHANED'
      | 'INTEGRITY'
      | 'UNKNOWN';
    readonly message: string;
  };
}
export interface GeneratedCodePublishStart {
  readonly id: string;
  readonly status: 'running';
}

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
  readonly status: 'queued' | 'running' | 'applied' | 'failed' | 'cancelled' | 'undone';
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
export function validateReviewThreadResolution(value: unknown): ReviewThreadResolutionInput {
  const input = record(value, 'review thread resolution');
  if (typeof input.resolved !== 'boolean')
    throw new Error('review thread resolution must be boolean');
  return { id: validateDesignerIdentifier(input.id, 'review thread id'), resolved: input.resolved };
}
export function validateReviewThreadReply(value: unknown): ReviewThreadReplyInput {
  const input = record(value, 'review thread reply');
  return {
    id: validateDesignerIdentifier(input.id, 'review thread id'),
    body: body(input.body, 'review thread reply')
  };
}

export function validateDesignerPublish(value: unknown): DesignerPublishInput {
  const input = record(value, 'generated code publish request');
  const target = validateDesignerPublishConsent(input);
  const consentId = validateDesignerIdentifier(input.consentId, 'consentId');
  return { ...target, consentId };
}

function containsAsciiControl(value: string): boolean {
  const firstControl = '\u0000'.charCodeAt(0);
  const lastControl = '\u001F'.charCodeAt(0);
  const deleteControl = '\u007F'.charCodeAt(0);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if ((codeUnit >= firstControl && codeUnit <= lastControl) || codeUnit === deleteControl)
      return true;
  }
  return false;
}

/** Consent is requested against the same mode-specific target shape as publication. */
export function validateDesignerPublishConsent(value: unknown): DesignerPublishConsentInput {
  const input = record(value, 'generated code publish consent request');
  const title = instruction(input.title, 'title');
  if (title.length > 240) throw new Error('title must be at most 240 characters');
  if (containsAsciiControl(title)) throw new Error('title must not contain control characters');
  if (input.mode !== 'local-preview' && input.mode !== 'github-remote')
    throw new Error('publish mode must be local-preview or github-remote');
  if (input.mode === 'github-remote') {
    const repository = canonicalGitHubRepository(instruction(input.repository, 'repository'));
    const repositoryOwner = repository.slice(0, repository.indexOf('/'));
    let provisioning: GitHubRepositoryProvisioningInput | undefined;
    if (input.provisioning !== undefined) {
      const provisioningRecord = record(input.provisioning, 'repository provisioning');
      if (
        provisioningRecord.create !== true ||
        provisioningRecord.visibilityConfirmed !== true ||
        (provisioningRecord.visibility !== 'public' && provisioningRecord.visibility !== 'private')
      )
        throw new Error('repository provisioning consent is invalid');
      const owner = record(provisioningRecord.owner, 'repository owner');
      if (
        (owner.kind === 'current-user' || owner.kind === 'organization') &&
        typeof owner.login === 'string'
      ) {
        const login = canonicalGitHubOwnerLogin(owner.login);
        if (login !== repositoryOwner)
          throw new Error('repository provisioning owner must match the repository owner');
        provisioning = {
          create: true,
          owner: { kind: owner.kind, login },
          visibility: provisioningRecord.visibility,
          visibilityConfirmed: true
        };
      } else throw new Error('repository owner is invalid');
    }
    return {
      repository,
      title,
      mode: 'github-remote',
      ...(provisioning === undefined ? {} : { provisioning })
    };
  }
  if (input.repository !== undefined)
    throw new Error('local-preview publish must not include a repository');
  return { title, mode: 'local-preview' };
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
