import type {
  ComponentCatalogProjectionResult,
  DesignBaselineState,
  EnterpriseScenario,
  FederatedComponentCatalogProjectionResult,
  NodeMetadata,
  PrototypeGraph,
  PrototypeRuntimeSnapshot,
  ReactSourceWorkspace
} from '@selene/core';

import { canonicalGitHubOwnerLogin, canonicalGitHubRepository } from './github-repository';

/** Versioned, data-only contract exposed by the Electron preload bridge. */
export const DESIGNER_API_VERSION = 'selene-desktop-designer/v17' as const;

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
  readonly inspectorTab: 'inspect' | 'flow' | 'handoff' | 'setup';
}
/**
 * The desktop shell keeps both rails within this range so every persisted,
 * pointer, keyboard, and accessibility value has a visible counterpart.
 */
export const workspaceCockpitRailMinimum = 220;
export const workspaceCockpitRailMaximum = 340;
const legacyWorkspaceCockpitRailMaximum = 520;
export const defaultWorkspaceCockpitPreferences: WorkspaceCockpitPreferences = Object.freeze({
  format: 'selene-workspace-cockpit-preferences/v1',
  leftRailWidth: 300,
  rightRailWidth: 340,
  leftRailCollapsed: true,
  rightRailCollapsed: true,
  inspectorTab: 'inspect'
});
export function validateWorkspaceCockpitPreferences(value: unknown): WorkspaceCockpitPreferences {
  const input = record(value, 'workspace cockpit preferences');
  const width = (name: 'leftRailWidth' | 'rightRailWidth') => {
    const candidate = input[name];
    if (
      typeof candidate !== 'number' ||
      !Number.isInteger(candidate) ||
      candidate < workspaceCockpitRailMinimum ||
      candidate > workspaceCockpitRailMaximum
    )
      throw new Error(
        `${name} must be an integer from ${workspaceCockpitRailMinimum} to ${workspaceCockpitRailMaximum}`
      );
    return candidate;
  };
  const bool = (name: 'leftRailCollapsed' | 'rightRailCollapsed') => {
    if (typeof input[name] !== 'boolean') throw new Error(`${name} must be boolean`);
    return input[name];
  };
  const tab = input.inspectorTab;
  if (tab !== 'inspect' && tab !== 'flow' && tab !== 'handoff' && tab !== 'setup')
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

/**
 * Normalizes persisted v1 preferences from releases that allowed 341–520px
 * rails. This runs only while reading local storage; writes remain subject to
 * the strict visible-range validator above.
 */
export function migrateWorkspaceCockpitPreferencesV1(value: unknown): WorkspaceCockpitPreferences {
  const input = record(value, 'workspace cockpit preferences');
  const legacyWidth = (name: 'leftRailWidth' | 'rightRailWidth') => {
    const candidate = input[name];
    if (
      typeof candidate !== 'number' ||
      !Number.isInteger(candidate) ||
      candidate < workspaceCockpitRailMinimum ||
      candidate > legacyWorkspaceCockpitRailMaximum
    )
      throw new Error(
        `${name} must be an integer from ${workspaceCockpitRailMinimum} to ${legacyWorkspaceCockpitRailMaximum}`
      );
    return Math.min(candidate, workspaceCockpitRailMaximum);
  };
  return validateWorkspaceCockpitPreferences({
    format: input.format,
    leftRailWidth: legacyWidth('leftRailWidth'),
    rightRailWidth: legacyWidth('rightRailWidth'),
    leftRailCollapsed: input.leftRailCollapsed,
    rightRailCollapsed: input.rightRailCollapsed,
    // Retire the former reviews destination while preserving old local preferences.
    inspectorTab: input.inspectorTab === 'reviews' ? 'inspect' : input.inspectorTab
  });
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
  /** Sanitized package-owned catalog data. It contains no component implementation or executable code. */
  readonly catalog?: {
    readonly format: 'selene-design-system-catalog-projection/v1';
    readonly components: readonly {
      readonly name: string;
      readonly exportName: string;
      readonly entrypoint: string;
      readonly properties?: readonly DesignSystemComponentProperty[];
      readonly slots?: readonly DesignSystemComponentSlot[];
    }[];
    readonly patterns?: readonly DesignSystemComponentPattern[];
    readonly templates?: readonly DesignSystemComponentTemplate[];
    readonly tokens?: readonly DesignSystemTokenDefinition[];
  };
  readonly fixture?: string;
}

export type DesignSystemComponentPropertyValue = string | number | boolean;

/** Sanitized, declarative component variants. This is metadata only, never executable package code. */
export interface DesignSystemComponentProperty {
  readonly name: string;
  readonly label: string;
  readonly control: 'boolean' | 'number' | 'text' | 'select';
  readonly required?: boolean;
  readonly defaultValue?: DesignSystemComponentPropertyValue;
  readonly values?: readonly (string | number)[];
}

/** A bounded package-declared React composition contract; never executable package code. */
export interface DesignSystemComponentSlot {
  readonly id: string;
  readonly label: string;
  readonly kind: 'children';
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly accepts?: readonly {
    readonly entrypoint: string;
    readonly exportName: string;
  }[];
}

/** A curated catalog alias for one declared component export; it carries no JSX or source. */
export interface DesignSystemComponentPattern {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly component: {
    readonly entrypoint: string;
    readonly exportName: string;
  };
}
/** A package-curated React composition preset; it references an approved export only. */
export interface DesignSystemComponentTemplate {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly kind: 'screen' | 'section';
  readonly component: {
    readonly entrypoint: string;
    readonly exportName: string;
  };
  readonly propertyValues?: Readonly<Record<string, DesignSystemComponentPropertyValue>>;
}

export const MANUAL_APPEARANCE_TOKEN_PROPERTIES = [
  'color',
  'backgroundColor',
  'fontSize',
  'lineHeight',
  'letterSpacing',
  'borderRadius',
  'padding',
  'margin'
] as const;
export type ManualAppearanceTokenProperty = (typeof MANUAL_APPEARANCE_TOKEN_PROPERTIES)[number];

/** Data-only package declaration for one source-safe CSS custom-property reference. */
export interface DesignSystemTokenDefinition {
  readonly name: string;
  readonly label: string;
  readonly cssVariable: `--${string}`;
  readonly properties: readonly ManualAppearanceTokenProperty[];
  readonly description?: string;
}

/** Host-projected token identity with exact enabled-package provenance. */
export interface DesignSystemTokenReference extends DesignSystemTokenDefinition {
  /** Opaque, capability-scoped identity used to authorize this exact token application. */
  readonly tokenId: string;
  readonly packageName: string;
  readonly version: string;
  readonly artifactDigest: string;
  readonly value: `var(--${string})`;
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

/**
 * Host-derived, data-only product portfolio metadata. Project membership is
 * descriptive context, never authorization to read, mutate, or execute another
 * project's source.
 */
export interface DesktopProductMapProject {
  readonly projectId: string;
  readonly name: string;
  readonly role: 'standalone' | 'shell' | 'child';
  /** Present for shell and child entries; membership remains descriptive, not authorization. */
  readonly shellProjectId?: string;
  readonly lifecycle: 'active' | 'archived';
  readonly readiness: DesignBaselineState['readiness'];
  readonly currency: DesignBaselineState['currency'];
  readonly changesSinceBaseline: number;
}

export interface DesktopProductMap {
  readonly format: 'selene-desktop-product-map/v1';
  readonly currentProjectId: string;
  readonly scope:
    | { readonly kind: 'standalone' }
    | { readonly kind: 'federation'; readonly shellProjectId: string };
  readonly projects: readonly DesktopProductMapProject[];
}

/** Renderer intent only; the host resolves all project identities and ownership conflicts. */
export interface ProductShellConfigurationInput {
  readonly projectId: string;
  readonly childProjectIds: readonly string[];
}

export function validateProductShellConfiguration(value: unknown): ProductShellConfigurationInput {
  const input = record(value, 'product shell configuration');
  const keys = Object.keys(input).sort();
  if (keys.length !== 2 || keys[0] !== 'childProjectIds' || keys[1] !== 'projectId')
    throw new Error('product shell configuration keys are invalid');
  const project = input.projectId;
  const children = input.childProjectIds;
  if (typeof project !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(project))
    throw new Error('product shell projectId is invalid');
  if (
    !Array.isArray(children) ||
    children.length > 64 ||
    children.some(
      (child) =>
        typeof child !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(child) || child === project
    ) ||
    new Set(children).size !== children.length
  )
    throw new Error('product shell childProjectIds are invalid');
  return Object.freeze({
    projectId: project,
    childProjectIds: Object.freeze([...children].sort())
  });
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

/**
 * Renderer-safe identity for one exact host-resolved product preview.
 * Source, graph data, binding manifests, and compiler inputs stay in Electron main.
 */
export interface PreviewBuildTicket {
  readonly format: 'selene-preview-build-ticket/v1';
  readonly projectId: string;
  readonly sourceRevisionId: string;
  readonly graphRevision: number;
  /** Commitment to the exact source, graph, and compiler-binding state owned by the host. */
  readonly bindingId: string;
}

export interface PreviewBuildResult {
  readonly url: string;
  readonly revisionId: string;
  readonly projectId: string;
  readonly sourceRevisionId: string;
  readonly graphRevision: number;
  readonly bindingId: string;
  readonly policy: {
    readonly origin: string;
    readonly nonce: string;
    readonly maxMessageBytes: number;
    readonly csp: string;
  };
}

export function validatePreviewBuildTicket(value: unknown): PreviewBuildTicket {
  const input = record(value, 'preview build ticket');
  const expected = ['bindingId', 'format', 'graphRevision', 'projectId', 'sourceRevisionId'];
  if (
    Object.keys(input).sort().join('\u0000') !== expected.sort().join('\u0000') ||
    input.format !== 'selene-preview-build-ticket/v1' ||
    typeof input.projectId !== 'string' ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(input.projectId) ||
    typeof input.sourceRevisionId !== 'string' ||
    input.sourceRevisionId.length === 0 ||
    input.sourceRevisionId.length > 128 ||
    !Number.isSafeInteger(input.graphRevision) ||
    (input.graphRevision as number) < 0 ||
    typeof input.bindingId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.bindingId)
  )
    throw new Error('preview build ticket is invalid');
  return Object.freeze({
    format: 'selene-preview-build-ticket/v1',
    projectId: input.projectId,
    sourceRevisionId: input.sourceRevisionId,
    graphRevision: input.graphRevision as number,
    bindingId: input.bindingId
  });
}

/**
 * Opaque renderer-safe authority for one exact canonical Storybook story.
 * It contains identity only; URLs, source paths, CSF files, and build inputs stay host-owned.
 */
export interface StoryPreviewTicket {
  readonly format: 'selene-story-preview-ticket/v1';
  readonly capabilityId: string;
  readonly projectId: string;
  readonly sourceRevisionId: string;
  readonly catalogRevision: string;
  readonly buildId: string;
  readonly componentId: string;
  readonly storyId: string;
}

export interface StoryPreviewBuildResult {
  readonly url: string;
  readonly revisionId: string;
  readonly projectId: string;
  readonly sourceRevisionId: string;
  readonly catalogRevision: string;
  readonly buildId: string;
  readonly componentId: string;
  readonly storyId: string;
  readonly policy: {
    readonly origin: string;
    readonly nonce: string;
    readonly maxMessageBytes: number;
    readonly csp: string;
  };
}

export function validateStoryPreviewTicket(value: unknown): StoryPreviewTicket {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error('story preview ticket must be a plain data object');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const input: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error('story preview ticket fields are invalid');
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    )
      throw new Error('story preview ticket fields are invalid');
    input[key] = descriptor.value;
  }
  const keys = [
    'format',
    'capabilityId',
    'projectId',
    'sourceRevisionId',
    'catalogRevision',
    'buildId',
    'componentId',
    'storyId'
  ] as const;
  if (
    Object.keys(input).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(input, key))
  )
    throw new Error('story preview ticket fields are invalid');
  const text = (name: Exclude<(typeof keys)[number], 'format'>, maximum = 256): string => {
    const candidate = input[name];
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > maximum)
      throw new Error(`story preview ticket ${name} is invalid`);
    return candidate;
  };
  if (input.format !== 'selene-story-preview-ticket/v1')
    throw new Error('story preview ticket format is invalid');
  const capabilityId = text('capabilityId', 128);
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(capabilityId))
    throw new Error('story preview ticket capabilityId is invalid');
  return Object.freeze({
    format: 'selene-story-preview-ticket/v1',
    capabilityId,
    projectId: text('projectId'),
    sourceRevisionId: text('sourceRevisionId'),
    catalogRevision: text('catalogRevision'),
    buildId: text('buildId'),
    componentId: text('componentId'),
    storyId: text('storyId')
  });
}

export interface DesignerSnapshot {
  readonly apiVersion: typeof DESIGNER_API_VERSION;
  readonly agents: readonly DesignerAgentSummary[];
  readonly selectedAgentId: string;
  readonly source: ReactSourceWorkspace;
  readonly nodes: readonly NodeMetadata[];
  readonly selectedNodeId?: string;
  /**
   * Exact source-proven insertion target for the current selection. Absence
   * means the selected node is not an authored inline flex/grid container.
   */
  readonly catalogInsertTarget?: {
    readonly nodeId: string;
    readonly layout: 'flex' | 'grid';
  };
  /** Exact source-proven mapped element that may be replaced while preserving its stable marker. */
  readonly catalogReplaceTarget?: {
    readonly nodeId: string;
  };
  /** Deployed-artifact human review data. Local persistence/lifecycle is a later slice. */
  readonly reviewThreads: readonly ReviewThread[];
  readonly artifactPins: readonly ArtifactPin[];
  /** Local Claude Design-style changes, including their durable request lifecycle. */
  readonly aiChangeRequests: readonly AIChangeRequest[];
  /** Bounded, source-free activity across direct designer and configured-agent changes. */
  readonly designActivity: readonly DesignActivityEntry[];
  /** Source-free identity for the sole host-owned candidate awaiting designer review. */
  readonly pendingAIProposal?: PendingAIProposal;
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
    /** Exact current host identity; no compiler input or source authority crosses preload. */
    readonly previewTicket?: PreviewBuildTicket;
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
    /** Redacted projection of the exact validated manifest, or one bounded unavailable reason. */
    readonly manifest: ComponentCatalogProjectionResult;
    /** Source-free shell aggregation; absent for standalone projects. */
    readonly federation?: FederatedComponentCatalogProjectionResult;
    readonly entries: readonly {
      readonly component: string;
      readonly href: string;
      readonly origin: 'project' | 'design-system' | 'federated';
      readonly owningProjectId?: string;
      readonly catalogRevision?: string;
      readonly buildId?: string;
      readonly packageName?: string;
      readonly version?: string;
      readonly exportName?: string;
      readonly entrypoint?: string;
      /** Immutable identity for an approved design-system catalog artifact. */
      readonly artifactDigest?: string;
      readonly properties?: readonly DesignSystemComponentProperty[];
      /** Data-only package policy; the host remains the sole move authority. */
      readonly slots?: readonly DesignSystemComponentSlot[];
      readonly patternId?: string;
      readonly templateId?: string;
      readonly templateKind?: 'screen' | 'section';
      readonly presetProperties?: Readonly<Record<string, DesignSystemComponentPropertyValue>>;
      readonly description?: string;
      readonly catalogComponentId?: string;
      readonly owner?: string;
      readonly declaredProps?: readonly {
        readonly name: string;
        readonly type: string;
        readonly required: boolean;
        readonly description?: string;
      }[];
      readonly requiredCoverage?: readonly (
        'loading' | 'empty' | 'error' | 'disabled' | 'responsive' | 'accessibility'
      )[];
      /** Compatible executable-prototype traceability only; never inferred from source paths. */
      readonly screenUsage?: readonly {
        readonly screenId: string;
        readonly route: string;
        readonly storyIds: readonly string[];
      }[];
      readonly stories?: readonly {
        readonly id: string;
        readonly exportName: string;
        readonly coverage: readonly (
          'loading' | 'empty' | 'error' | 'disabled' | 'responsive' | 'accessibility'
        )[];
        readonly previewTicket?: StoryPreviewTicket;
      }[];
      readonly canonicalStories?: readonly {
        readonly format: 'selene-canonical-story-reference/v1';
        readonly projectId: string;
        readonly catalogRevision: string;
        readonly buildId: string;
        readonly componentId: string;
        readonly storyId: string;
      }[];
    }[];
  };
  /** Staged setup provenance only; package source and filesystem access stay host-owned. */
  readonly setup?: DesignerSetupReceipts;
  /** Host-owned portfolio context; it contains no source, credentials, or runtime module URLs. */
  readonly productMap?: DesktopProductMap;
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

/** Exact renderer request for starting one declared scenario on the current persisted graph. */
export interface PrototypeScenarioStartInput {
  readonly projectId: string;
  readonly graphRevision: number;
  readonly scenarioId: string;
}
export function validatePrototypeScenarioStart(value: unknown): PrototypeScenarioStartInput {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error('prototype scenario start request must be a plain object');
  const input = record(value, 'prototype scenario start request');
  const keys = Object.keys(input);
  const expected = ['projectId', 'graphRevision', 'scenarioId'];
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key)))
    throw new Error(
      'prototype scenario start request must contain only projectId, graphRevision, and scenarioId'
    );
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      !descriptor.enumerable ||
      !descriptor.configurable ||
      !descriptor.writable
    )
      throw new Error(
        `prototype scenario start request ${key} must be an own writable data property`
      );
  }
  if (
    typeof input.graphRevision !== 'number' ||
    !Number.isSafeInteger(input.graphRevision) ||
    input.graphRevision < 0
  )
    throw new Error('graphRevision must be a non-negative safe integer');
  return {
    projectId: validateDesignerIdentifier(input.projectId, 'projectId'),
    graphRevision: input.graphRevision,
    scenarioId: validateDesignerIdentifier(input.scenarioId, 'scenarioId')
  };
}

export interface AIChangeRequestInput {
  readonly agentId: string;
  readonly instruction: string;
  readonly target: SpatialTargetInput;
}
export interface AIChangeUndoInput {
  readonly projectId: string;
  readonly requestId: string;
}

export interface PendingAIProposal {
  readonly requestId: string;
  readonly agentId: string;
  readonly baseRevisionId: string;
  readonly candidateRevisionId: string;
  readonly summary: string;
  readonly createdAt: string;
}

export interface AIProposalDecisionInput {
  readonly projectId: string;
  readonly requestId: string;
  readonly candidateRevisionId: string;
}

export interface ManualDesignUndoInput {
  readonly projectId: string;
  readonly undoId: string;
  readonly targetRevisionId: string;
}

export interface DesignActivityEntry {
  readonly id: string;
  readonly origin: 'manual' | 'agent';
  readonly kind:
    'ai-change' | 'content' | 'layout' | 'appearance' | 'position' | 'reorder' | 'reparent';
  readonly label: string;
  readonly actorLabel: string;
  readonly createdAt: string;
  readonly status:
    'queued' | 'running' | 'reviewing' | 'applied' | 'failed' | 'cancelled' | 'undone';
  readonly referenceId: string;
  readonly resultingRevisionId?: string;
  readonly undo?: Readonly<{
    readonly undoId: string;
    readonly targetRevisionId: string;
    readonly available: boolean;
    readonly disabledReason?: 'NOT_LATEST' | 'SOURCE_CHANGED' | 'ALREADY_UNDONE';
  }>;
}

/** A short-lived host grant for one plain JSX text-child replacement. */
export interface ManualTextEditCapability {
  readonly kind: 'available';
  readonly capabilityId: string;
  readonly nodeId: string;
  readonly revisionId: string;
  readonly currentContent: string;
  readonly maxLength: number;
  readonly expiresAt: string;
}

/** Deliberately bounded: unsafe, stale, and unmapped selections disclose no source detail. */
export interface ManualTextEditUnavailable {
  readonly kind: 'unavailable';
  readonly code:
    'PROJECT_MISMATCH' | 'STALE_SELECTION' | 'MAPPED_TEXT_UNAVAILABLE' | 'MANUAL_EDIT_UNAVAILABLE';
}

export interface ManualTextEditCapabilityRequest {
  readonly projectId: string;
  readonly nodeId: string;
  readonly revisionId: string;
}

/** Renderer supplies only an opaque capability and replacement text, never a source proposal. */
export interface ManualTextEditApplyRequest {
  readonly format: 'selene-desktop-manual-text-edit-apply/v1';
  readonly projectId: string;
  readonly capabilityId: string;
  readonly content: string;
}

export const MANUAL_LAYOUT_PROPERTIES = [
  'display',
  'flexDirection',
  'justifyContent',
  'alignItems',
  'gap',
  'order',
  'width',
  'height',
  'minWidth',
  'minHeight',
  'maxWidth',
  'maxHeight'
] as const;
export type ManualLayoutProperty = (typeof MANUAL_LAYOUT_PROPERTIES)[number];
export type ManualLayoutValue = number | string;

/** A short-lived host grant for bounded, source-backed inline layout controls. */
export interface ManualLayoutEditCapability {
  readonly kind: 'available';
  readonly capabilityId: string;
  readonly nodeId: string;
  readonly revisionId: string;
  readonly properties: readonly ManualLayoutProperty[];
  readonly currentValues: Readonly<Partial<Record<ManualLayoutProperty, ManualLayoutValue>>>;
  readonly expiresAt: string;
}

/** Unsafe, stale, and unmapped selections disclose no source layout detail. */
export interface ManualLayoutEditUnavailable {
  readonly kind: 'unavailable';
  readonly code:
    | 'PROJECT_MISMATCH'
    | 'STALE_SELECTION'
    | 'MAPPED_LAYOUT_UNAVAILABLE'
    | 'MANUAL_EDIT_UNAVAILABLE';
}

export interface ManualLayoutEditCapabilityRequest {
  readonly projectId: string;
  readonly nodeId: string;
  readonly revisionId: string;
}

/** Renderer supplies only an opaque capability and one bounded layout value. */
export interface ManualLayoutEditApplyRequest {
  readonly format: 'selene-desktop-manual-layout-edit-apply/v1';
  readonly projectId: string;
  readonly capabilityId: string;
  readonly property: ManualLayoutProperty;
  readonly value: ManualLayoutValue;
}

export const MANUAL_APPEARANCE_PROPERTIES = [
  'color',
  'backgroundColor',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'textAlign',
  'borderRadius',
  'opacity',
  'padding',
  'margin'
] as const;
export type ManualAppearanceProperty = (typeof MANUAL_APPEARANCE_PROPERTIES)[number];
export type ManualAppearanceValue = number | string;

/** A short-lived host grant for an approved, source-backed visual style control. */
export interface ManualAppearanceEditCapability {
  readonly kind: 'available';
  readonly capabilityId: string;
  readonly nodeId: string;
  readonly revisionId: string;
  readonly properties: readonly ManualAppearanceProperty[];
  readonly currentValues: Readonly<
    Partial<Record<ManualAppearanceProperty, ManualAppearanceValue>>
  >;
  readonly tokens: readonly DesignSystemTokenReference[];
  readonly expiresAt: string;
}

/** Unsafe, stale, and unmapped selections disclose no source appearance detail. */
export interface ManualAppearanceEditUnavailable {
  readonly kind: 'unavailable';
  readonly code:
    | 'PROJECT_MISMATCH'
    | 'STALE_SELECTION'
    | 'MAPPED_APPEARANCE_UNAVAILABLE'
    | 'MANUAL_EDIT_UNAVAILABLE';
}

export interface ManualAppearanceEditCapabilityRequest {
  readonly projectId: string;
  readonly nodeId: string;
  readonly revisionId: string;
}

/** Renderer supplies only an opaque grant plus one approved property value. */
export interface ManualAppearanceEditApplyRequest {
  readonly format: 'selene-desktop-manual-appearance-edit-apply/v1';
  readonly projectId: string;
  readonly capabilityId: string;
  readonly property: ManualAppearanceProperty;
  readonly value: ManualAppearanceValue;
  /** Required when value is a CSS custom-property reference. */
  readonly tokenId?: string;
}

/** A short-lived host grant for moving an already absolutely positioned TSX element. */
export interface ManualPositionEditCapability {
  readonly kind: 'available';
  readonly capabilityId: string;
  readonly nodeId: string;
  readonly revisionId: string;
  readonly position: 'absolute' | 'fixed';
  readonly currentValues: Readonly<{ readonly left: number; readonly top: number }>;
  readonly expiresAt: string;
}

/** No fallback positioning is created for static, flex, grid, or dynamic styles. */
export interface ManualPositionEditUnavailable {
  readonly kind: 'unavailable';
  readonly code:
    | 'PROJECT_MISMATCH'
    | 'STALE_SELECTION'
    | 'MAPPED_POSITION_UNAVAILABLE'
    | 'MANUAL_EDIT_UNAVAILABLE';
}

export interface ManualPositionEditCapabilityRequest {
  readonly projectId: string;
  readonly nodeId: string;
  readonly revisionId: string;
}

/** Renderer supplies only the opaque grant and bounded authored pixel coordinates. */
export interface ManualPositionEditApplyRequest {
  readonly format: 'selene-desktop-manual-position-edit-apply/v1';
  readonly projectId: string;
  readonly capabilityId: string;
  readonly left: number;
  readonly top: number;
}

/** A short-lived host grant for one compiler-proven semantic JSX move. */
export interface ManualStructureEditCapability {
  readonly kind: 'available';
  readonly capabilityId: string;
  readonly nodeId: string;
  readonly revisionId: string;
  readonly operation: 'reorder' | 'reparent';
  readonly targetNodeId: string;
  readonly expiresAt: string;
}

/** Structural moves never fall back to DOM mutation or inferred source paths. */
export interface ManualStructureEditUnavailable {
  readonly kind: 'unavailable';
  readonly code:
    | 'PROJECT_MISMATCH'
    | 'STALE_SELECTION'
    | 'MAPPED_STRUCTURE_UNAVAILABLE'
    | 'COMPONENT_SLOT_REQUIRED'
    | 'INCOMPATIBLE_COMPONENT_SLOT'
    | 'SLOT_CARDINALITY_VIOLATION'
    | 'UNMAPPED_COMPONENT_CHILD'
    | 'MANUAL_EDIT_UNAVAILABLE';
}

export interface ManualStructureEditCapabilityRequest {
  readonly projectId: string;
  readonly nodeId: string;
  readonly revisionId: string;
  /** A host-confirmed rendered peer that supplies a deterministic insertion point. */
  readonly targetNodeId: string;
}

/** Renderer may submit only the opaque host grant; all source intent stays in main. */
export interface ManualStructureEditApplyRequest {
  readonly format: 'selene-desktop-manual-structure-edit-apply/v1';
  readonly projectId: string;
  readonly capabilityId: string;
}

/**
 * Exact approved catalog identity. The renderer can request this tuple but
 * cannot infer a package import or substitute a different catalog revision.
 */
export interface DesignSystemComponentIdentity {
  readonly packageName: string;
  readonly version: string;
  readonly entrypoint: string;
  readonly exportName: string;
  readonly artifactDigest: string;
}

/** A short-lived host grant to insert one exact approved design-system component. */
export interface DesignSystemComponentInsertCapability {
  readonly kind: 'available';
  readonly capabilityId: string;
  readonly nodeId: string;
  readonly revisionId: string;
  readonly component: DesignSystemComponentIdentity;
  readonly expiresAt: string;
}

/** Insertion never guesses imports, entrypoints, or package versions. */
export interface DesignSystemComponentInsertUnavailable {
  readonly kind: 'unavailable';
  readonly code:
    | 'PROJECT_MISMATCH'
    | 'STALE_SELECTION'
    | 'COMPONENT_NOT_APPROVED'
    | 'COMPONENT_CONFIGURATION_INVALID'
    | 'MAPPED_INSERTION_UNAVAILABLE'
    | 'MANUAL_EDIT_UNAVAILABLE';
}

/** Renderer supplies a mapped insertion anchor and the exact catalog identity. */
export interface DesignSystemComponentInsertCapabilityRequest {
  readonly projectId: string;
  readonly nodeId: string;
  readonly revisionId: string;
  readonly component: DesignSystemComponentIdentity;
  /** Literal, catalog-declared values only; the host revalidates every property. */
  readonly props?: Readonly<Record<string, DesignSystemComponentPropertyValue>>;
}

/** Source intent and import resolution remain host-owned behind the opaque grant. */
export interface DesignSystemComponentInsertApplyRequest {
  readonly format: 'selene-desktop-design-system-component-insert-apply/v1';
  readonly projectId: string;
  readonly capabilityId: string;
}

/** A short-lived host grant to replace one mapped element with one approved component. */
export interface DesignSystemComponentReplaceCapability {
  readonly kind: 'available';
  readonly capabilityId: string;
  readonly nodeId: string;
  readonly revisionId: string;
  readonly component: DesignSystemComponentIdentity;
  readonly expiresAt: string;
}

export interface DesignSystemComponentReplaceUnavailable {
  readonly kind: 'unavailable';
  readonly code:
    | 'PROJECT_MISMATCH'
    | 'STALE_SELECTION'
    | 'COMPONENT_NOT_APPROVED'
    | 'COMPONENT_CONFIGURATION_INVALID'
    | 'MAPPED_REPLACEMENT_UNAVAILABLE'
    | 'MANUAL_EDIT_UNAVAILABLE';
}

/** Replacement keeps children and stable identity; main owns the exact source rewrite. */
export interface DesignSystemComponentReplaceCapabilityRequest {
  readonly projectId: string;
  readonly nodeId: string;
  readonly revisionId: string;
  readonly component: DesignSystemComponentIdentity;
  readonly props?: Readonly<Record<string, DesignSystemComponentPropertyValue>>;
}

export interface DesignSystemComponentReplaceApplyRequest {
  readonly format: 'selene-desktop-design-system-component-replace-apply/v1';
  readonly projectId: string;
  readonly capabilityId: string;
}

/** Host-resolved controls for the exact selected imported React component. */
export interface DesignSystemComponentPropertyEditCapability {
  readonly kind: 'available';
  readonly capabilityId: string;
  readonly nodeId: string;
  readonly revisionId: string;
  readonly component: DesignSystemComponentIdentity;
  readonly componentName: string;
  readonly properties: readonly DesignSystemComponentProperty[];
  readonly currentValues: Readonly<Partial<Record<string, DesignSystemComponentPropertyValue>>>;
  readonly expiresAt: string;
}

export interface DesignSystemComponentPropertyEditUnavailable {
  readonly kind: 'unavailable';
  readonly code:
    | 'PROJECT_MISMATCH'
    | 'STALE_SELECTION'
    | 'COMPONENT_NOT_APPROVED'
    | 'COMPONENT_PROPERTIES_UNAVAILABLE'
    | 'MAPPED_COMPONENT_UNAVAILABLE'
    | 'MANUAL_EDIT_UNAVAILABLE';
}

/** Selection identity only; main reparses the exact source and resolves its named import. */
export interface DesignSystemComponentPropertyEditCapabilityRequest {
  readonly projectId: string;
  readonly nodeId: string;
  readonly revisionId: string;
}

/** Renderer submits one declared literal value through an opaque, revision-fenced grant. */
export interface DesignSystemComponentPropertyEditApplyRequest {
  readonly format: 'selene-desktop-design-system-component-property-edit-apply/v1';
  readonly projectId: string;
  readonly capabilityId: string;
  readonly property: string;
  readonly value: DesignSystemComponentPropertyValue;
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
      | 'SETUP_REQUIRED'
      | 'TIMEOUT'
      | 'PROCESS_FAILED'
      | 'PROCESS_ORPHANED'
      | 'INTEGRITY'
      | 'UNKNOWN';
    readonly message: string;
    /** Only setup-required failures become retryable after restarting the prepared desktop host. */
    readonly retryable: boolean;
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
  readonly status:
    'queued' | 'running' | 'reviewing' | 'applied' | 'failed' | 'cancelled' | 'undone';
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

/** Strict renderer boundary for a single, current-project compensating AI revision. */
export function validateAIChangeUndo(value: unknown): AIChangeUndoInput {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error('AI change undo request must be a plain object');
  const input = record(value, 'AI change undo request');
  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.includes('projectId') || !keys.includes('requestId'))
    throw new Error('AI change undo request must contain only projectId and requestId');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      !descriptor.enumerable ||
      !descriptor.configurable ||
      !descriptor.writable
    )
      throw new Error(`AI change undo request ${key} must be an own writable data property`);
  }
  return {
    projectId: validateDesignerIdentifier(input.projectId, 'projectId'),
    requestId: validateDesignerIdentifier(input.requestId, 'requestId')
  };
}

/** Strict renderer boundary for one current manual-edit compensating revision. */
export function validateManualDesignUndo(value: unknown): ManualDesignUndoInput {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error('manual design undo request must be a plain object');
  const input = record(value, 'manual design undo request');
  const keys = Object.keys(input);
  if (
    keys.length !== 3 ||
    !keys.includes('projectId') ||
    !keys.includes('undoId') ||
    !keys.includes('targetRevisionId')
  )
    throw new Error(
      'manual design undo request must contain only projectId, undoId, and targetRevisionId'
    );
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      !descriptor.enumerable ||
      !descriptor.configurable ||
      !descriptor.writable
    )
      throw new Error(`manual design undo request ${key} must be an own writable data property`);
  }
  return {
    projectId: validateDesignerIdentifier(input.projectId, 'projectId'),
    undoId: validateDesignerIdentifier(input.undoId, 'undoId'),
    targetRevisionId: validateDesignerIdentifier(input.targetRevisionId, 'targetRevisionId')
  };
}

/** Strict identity-only boundary for accepting or rejecting one staged agent candidate. */
export function validateAIProposalDecision(value: unknown): AIProposalDecisionInput {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error('AI proposal decision must be a plain object');
  const input = record(value, 'AI proposal decision');
  const keys = Object.keys(input);
  if (
    keys.length !== 3 ||
    !keys.includes('projectId') ||
    !keys.includes('requestId') ||
    !keys.includes('candidateRevisionId')
  )
    throw new Error(
      'AI proposal decision must contain only projectId, requestId, and candidateRevisionId'
    );
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      !descriptor.enumerable ||
      !descriptor.configurable ||
      !descriptor.writable
    )
      throw new Error(`AI proposal decision ${key} must be an own writable data property`);
  }
  return {
    projectId: validateDesignerIdentifier(input.projectId, 'projectId'),
    requestId: validateDesignerIdentifier(input.requestId, 'requestId'),
    candidateRevisionId: validateDesignerIdentifier(
      input.candidateRevisionId,
      'candidateRevisionId'
    )
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
