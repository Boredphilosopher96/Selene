import { createHash, randomUUID } from 'node:crypto';
import { basename, extname, isAbsolute } from 'node:path';
import * as ts from '@selene/tsx-compiler-api';

import {
  applyAgentSourcePatch,
  applyDesignEditProposal,
  createFederatedDesignHandoff,
  createCompilerRenderedInstanceDigest,
  createGeneratedDesignHandoff,
  enterpriseScenarioFixtures,
  executeDesignBaselineCommand,
  migrateDesignRevisionV1,
  parseDesignRevision,
  parseDesignEditProposal,
  parsePrototypeGraph,
  projectComponentCatalogManifest,
  projectComponentCatalogUsage,
  projectFederatedComponentCatalogs,
  PrototypeRuntime,
  serializeCanonicalData,
  serializeGeneratedDesignHandoff,
  validateReactBindingManifest,
  validateReactSourceWorkspace,
  type AgentSourcePatch,
  type BaselineIntent,
  type CanonicalStoryReference,
  type DesignBaselineState,
  type DesignEditProposal,
  type DesignEditResult,
  type DesignEditReceipt,
  type EnterpriseScenario,
  type GeneratedDesignHandoff,
  type GeneratedDesignReviewThread,
  type ReactBindingManifest,
  type ReactBindingCompilerEvidence,
  type ReactBuildArtifact,
  type ReactSourceWorkspace,
  type PrototypeGraph
} from '@selene/core';
import {
  parseSnapshot,
  serializeSnapshot,
  type CollaborationSnapshot,
  type ReviewThread as CollaborationReviewThread
} from '@selene/collaboration';

import {
  DESIGNER_API_VERSION,
  type DesignerAgentSummary,
  type DesignSystemComponentInsertCapability,
  type DesignSystemComponentInsertUnavailable,
  type DesignSystemComponentReplaceCapability,
  type DesignSystemComponentReplaceUnavailable,
  type DesignSystemComponentProperty,
  type DesignSystemComponentPropertyValue,
  type DesignSystemInputSelection,
  type DesignSystemIntakeReceipt,
  type DesignLanguageInputSelection,
  type OrderedDesignSystemInput,
  type OrderedDesignLanguageInput,
  type DesignerPublishConsentInput,
  type DesignerPublishInput,
  type MarkdownIntakeReceipt,
  type MarkdownSourceRefreshResult,
  MANUAL_APPEARANCE_PROPERTIES,
  MANUAL_LAYOUT_PROPERTIES,
  type ManualAppearanceEditCapability,
  type ManualAppearanceEditUnavailable,
  type ManualAppearanceProperty,
  type ManualAppearanceValue,
  type ManualLayoutEditCapability,
  type ManualLayoutEditUnavailable,
  type ManualLayoutProperty,
  type ManualLayoutValue,
  type ManualPositionEditCapability,
  type ManualPositionEditUnavailable,
  type ManualStructureEditCapability,
  type ManualStructureEditUnavailable,
  type ManualTextEditCapability,
  type ManualTextEditUnavailable,
  type ManualDesignUndoInput,
  type AIProposalDecisionInput,
  type DesignActivityEntry,
  type DeveloperHandoffAnnotation,
  type DesignerProgress,
  type DesignerSnapshot,
  type DesktopProductMap,
  type GeneratedCodePublishOperation,
  type GeneratedCodePublishReceipt,
  type HostedStakeholderReviewStatus,
  type AIChangeRequest,
  type ArtifactPin,
  type ReviewThread,
  type PreviewBuildTicket,
  type StoryPreviewTicket,
  type PrototypeFlowGraph,
  validateDeveloperAnnotation,
  validateAIChangeRequest,
  validateAIChangeUndo,
  validateManualDesignUndo,
  validateAIProposalDecision,
  validateDesignerIdentifier,
  validateDesignerPublish,
  validateDesignerPublishConsent,
  validatePrototypeRunAction,
  validatePrototypeScenarioStart,
  validateProductShellConfiguration,
  validateReviewThread,
  validateReviewThreadResolution,
  validateReviewThreadReply,
  validateStoryPreviewTicket
} from '../shared/designer-api';
import type { CrashDiagnosticSink } from './crash-diagnostics';
import type { DesktopDesignSystemIntake } from './designer-setup-host';
import type {
  LocalDesignerState,
  LocalProductHandoffProject,
  LocalManualReactEditAuthority,
  LocalManualReactEditJournalEntry,
  LocalPendingAIProposal
} from './project-lifecycle';
import { migrateLegacyLocalCollaborationAttribution } from './local-collaboration-attribution';
import { issueReactBindingCompilerEvidence } from './react-binding-evidence';
import {
  UnavailableManualReactEditTransactionPort,
  type ManualReactEditTransactionPort,
  type ManualReactEditAtomicPersistencePort,
  type ManualReactEditAtomicCommitOutcome
} from './manual-react-edit-transaction';
import { digestReactBuildOutput } from './react-build-output-digest';
import { validateLocalCollaborationAuthorId } from './local-collaboration-author';
import {
  DeterministicLocalPublishAdapter,
  FixturePublishConsentPort,
  PublishAdapterError,
  UnconfiguredHostedStakeholderReviewPort,
  createHostedStakeholderReviewPublication,
  createImmutablePublishBundle,
  publishConsentDigest,
  PublishAdapterRegistry,
  PrototypeGraphPersistenceError,
  type GeneratedCodePublishPort,
  type GeneratedCodePublishRequest,
  type HostedStakeholderReviewPort,
  type ImmutablePublishBundle,
  type PublishConsentBinding,
  type PrototypeGraphPersistencePort,
  type TrustedPublishConsentPort
} from './designer-host-ports';
import {
  BunViteReactGeneratedProjectTemplate,
  type GeneratedProjectFilePlan,
  type GeneratedProjectTemplatePort
} from './generated-project-template';
import { createEmbeddedGeneratedProjectToolchainPort } from './generated-project-toolchain';

export interface DesignerAgentAdapter {
  readonly descriptor: DesignerAgentSummary;
  propose(input: {
    readonly instruction: string;
    readonly target: AIChangeRequest['target'];
    readonly workspace: ReactSourceWorkspace;
    readonly scenario: EnterpriseScenario;
    readonly generationContext?: DesignerGenerationContext;
    readonly signal: AbortSignal;
    readonly progress: (message: string) => void;
  }): Promise<AgentSourcePatch>;
}

export interface DesignerGenerationContext {
  readonly packages: readonly {
    readonly packageName: string;
    readonly version: string;
    readonly exports: readonly string[];
    readonly artifactDigest: string;
    readonly provenance: { readonly provider: string; readonly location: string };
  }[];
  readonly guidance: readonly {
    readonly artifactDigest: string;
    readonly markdown: string;
  }[];
}

/** Host-only storage boundary for raw design-language guidance. */
export interface DesignLanguageGuidancePort {
  store(
    projectId: string,
    artifactDigest: string,
    markdown: string,
    sourceLocator?: string
  ): Promise<void>;
  storeBatch(
    projectId: string,
    entries: readonly {
      readonly artifactDigest: string;
      readonly markdown: string;
      readonly sourceLocator?: string;
    }[]
  ): Promise<void>;
  resolve(projectId: string, artifactDigest: string): Promise<string | undefined>;
  sourceLocator(projectId: string, artifactDigest: string): Promise<string | undefined>;
  remove(projectId: string, artifactDigest: string): Promise<void>;
  removeBatch(projectId: string, artifactDigests: readonly string[]): Promise<void>;
}

export class InMemoryDesignLanguageGuidancePort implements DesignLanguageGuidancePort {
  private readonly projects = new Map<
    string,
    Map<string, Readonly<{ markdown: string; sourceLocator?: string }>>
  >();
  public async store(
    projectId: string,
    artifactDigest: string,
    markdown: string,
    sourceLocator?: string
  ): Promise<void> {
    await this.storeBatch(projectId, [
      { artifactDigest, markdown, ...(sourceLocator === undefined ? {} : { sourceLocator }) }
    ]);
  }
  public async storeBatch(
    projectId: string,
    entries: readonly {
      readonly artifactDigest: string;
      readonly markdown: string;
      readonly sourceLocator?: string;
    }[]
  ): Promise<void> {
    if (
      entries.length === 0 ||
      entries.length > 32 ||
      new Set(entries.map((entry) => entry.artifactDigest)).size !== entries.length
    )
      throw new DesignerApplicationError('Design-language guidance is invalid.');
    const pending = entries.map((entry) => {
      const bytes = Buffer.byteLength(entry.markdown, 'utf8');
      if (
        !/^[a-f0-9]{64}$/.test(entry.artifactDigest) ||
        bytes === 0 ||
        bytes > 256 * 1024 ||
        createHash('sha256').update(entry.markdown).digest('hex') !== entry.artifactDigest ||
        (entry.sourceLocator !== undefined &&
          (!isAbsolute(entry.sourceLocator) ||
            entry.sourceLocator.includes('\0') ||
            Buffer.byteLength(entry.sourceLocator, 'utf8') > 4096))
      )
        throw new DesignerApplicationError('Design-language guidance is invalid.');
      return Object.freeze({
        artifactDigest: entry.artifactDigest,
        markdown: entry.markdown,
        ...(entry.sourceLocator === undefined ? {} : { sourceLocator: entry.sourceLocator })
      });
    });
    const next = new Map(this.projects.get(projectId) ?? []);
    for (const entry of pending)
      next.set(
        entry.artifactDigest,
        Object.freeze({
          markdown: entry.markdown,
          ...(entry.sourceLocator === undefined ? {} : { sourceLocator: entry.sourceLocator })
        })
      );
    if (
      next.size > 32 ||
      [...next.values()].reduce(
        (total, entry) => total + Buffer.byteLength(entry.markdown, 'utf8'),
        0
      ) >
        256 * 1024
    )
      throw new DesignerApplicationError('Design-language guidance exceeds its bounded limit.');
    this.projects.set(projectId, next);
  }
  public async resolve(projectId: string, artifactDigest: string): Promise<string | undefined> {
    return this.projects.get(projectId)?.get(artifactDigest)?.markdown;
  }
  public async sourceLocator(
    projectId: string,
    artifactDigest: string
  ): Promise<string | undefined> {
    return this.projects.get(projectId)?.get(artifactDigest)?.sourceLocator;
  }
  public async remove(projectId: string, artifactDigest: string): Promise<void> {
    await this.removeBatch(projectId, [artifactDigest]);
  }
  public async removeBatch(projectId: string, artifactDigests: readonly string[]): Promise<void> {
    if (
      artifactDigests.length === 0 ||
      artifactDigests.length > 32 ||
      artifactDigests.some((artifactDigest) => !/^[a-f0-9]{64}$/.test(artifactDigest))
    )
      throw new DesignerApplicationError('Design-language guidance is invalid.');
    const next = new Map(this.projects.get(projectId) ?? []);
    for (const artifactDigest of artifactDigests) next.delete(artifactDigest);
    if (next.size === 0) this.projects.delete(projectId);
    else this.projects.set(projectId, next);
  }
}

class UnconfiguredDesignLanguageGuidancePort implements DesignLanguageGuidancePort {
  public async store(): Promise<void> {
    throw new DesignerApplicationError('Design-language guidance storage is unavailable.');
  }
  public async resolve(): Promise<string | undefined> {
    return undefined;
  }
  public async sourceLocator(): Promise<string | undefined> {
    return undefined;
  }
  public async storeBatch(): Promise<void> {
    throw new DesignerApplicationError('Design-language guidance storage is unavailable.');
  }
  public async removeBatch(): Promise<void> {
    throw new DesignerApplicationError('Design-language guidance storage is unavailable.');
  }
  public async remove(): Promise<void> {
    throw new DesignerApplicationError('Design-language guidance storage is unavailable.');
  }
}

export interface HandoffMetadataPort {
  load(): Promise<{
    readonly packageManager: string;
    readonly lockfile: { readonly path: string; readonly checksum: string };
    readonly packages: readonly { readonly name: string; readonly version: string }[];
    readonly dependencies: readonly { readonly name: string; readonly version: string }[];
  }>;
}

type PublishOperationErrorCode = NonNullable<GeneratedCodePublishOperation['error']>['code'];
interface PublishOperationState {
  readonly request: DesignerPublishInput;
  readonly controller: AbortController;
  status: GeneratedCodePublishOperation['status'];
  progress: readonly string[];
  cancellationRequested?: boolean;
  receipt?: GeneratedCodePublishReceipt;
  error?: NonNullable<GeneratedCodePublishOperation['error']>;
}
function publishOperationErrorCode(error: unknown): PublishOperationErrorCode {
  if (error === null || typeof error !== 'object') return 'UNKNOWN';
  let candidate: unknown;
  try {
    candidate = Reflect.get(error, 'code');
  } catch {
    return 'UNKNOWN';
  }
  switch (candidate) {
    case 'OFFLINE':
    case 'AUTH_REQUIRED':
    case 'CONFLICT':
    case 'CANCELLED':
    case 'CLEANUP_FAILED':
    case 'TOOL_UNAVAILABLE':
    case 'SETUP_REQUIRED':
    case 'TIMEOUT':
    case 'PROCESS_FAILED':
    case 'PROCESS_ORPHANED':
    case 'INTEGRITY':
      return candidate;
    default:
      return 'UNKNOWN';
  }
}
const publishOperationErrorMessages: Readonly<Record<PublishOperationErrorCode, string>> =
  Object.freeze({
    OFFLINE: 'The configured host registry is unavailable.',
    AUTH_REQUIRED: 'Explicit host publish consent is required.',
    CONFLICT: 'The immutable publish inputs no longer match.',
    CANCELLED: 'Publish was cancelled.',
    CLEANUP_FAILED: 'Temporary generated project cleanup requires host recovery.',
    TOOL_UNAVAILABLE: 'The verified local Bun tool is unavailable.',
    SETUP_REQUIRED: 'Verified Bun development setup is required. Restart Selene and retry.',
    TIMEOUT: 'Local generated project validation timed out.',
    PROCESS_FAILED: 'Local generated project validation failed.',
    PROCESS_ORPHANED:
      'Local generated project termination could not be confirmed; host recovery is required.',
    INTEGRITY: 'Local generated project validation integrity check failed.',
    UNKNOWN: 'Publish failed before a stable host outcome was available.'
  });

function isPlainDataRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
function hasExactDataKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** The local lifecycle is the only desktop persistence authority for collaboration state. */
export interface DesignerProjectStatePort {
  designerState(projectId: string): Promise<LocalDesignerState | undefined>;
  saveDesignerState(projectId: string, state: LocalDesignerState): Promise<void>;
  saveDesignerStateWithGuidance(
    projectId: string,
    state: LocalDesignerState,
    guidance: readonly {
      readonly digest: string;
      readonly markdown: string;
      readonly sourceLocator?: string;
    }[]
  ): Promise<void>;
  commitDesignerRevision(
    projectId: string,
    workspace: ReactSourceWorkspace,
    state: LocalDesignerState
  ): Promise<unknown>;
  /** Optional portfolio projection; absent adapters retain standalone behavior. */
  productMap?(currentProjectId: string): Promise<DesktopProductMap>;
  /** Host-owned membership mutation; child source remains outside this capability. */
  configureProductShell?(
    shellProjectId: string,
    childProjectIds: readonly string[]
  ): Promise<DesktopProductMap>;
  /** Host-only complete project material; never projected through preload. */
  productHandoffProjects?(shellProjectId: string): Promise<readonly LocalProductHandoffProject[]>;
}

/** Host-only catalog source; raw manifests and their source/Storybook paths never reach preload. */
export interface ComponentCatalogManifestPort {
  /**
   * Returns the host-owned catalog for a project. A trusted local adapter may
   * synchronize from the exact canonical workspace before returning it; the
   * raw manifest and workspace never cross preload.
   */
  current(
    projectId: string,
    workspace?: ReactSourceWorkspace,
    graph?: PrototypeGraph
  ): unknown | undefined;
  /** Optional compatible executable prototype; raw traceability remains host-owned. */
  currentPrototype?(projectId: string): unknown | undefined;
  /** Optional host-owned shell aggregation; implementations return inert manifests only. */
  currentFederation?(projectIds: readonly string[]): readonly unknown[];
}

export class UnconfiguredComponentCatalogManifestPort implements ComponentCatalogManifestPort {
  public current(): undefined {
    return undefined;
  }
}

export interface StoryPreviewCapabilityPort {
  issue(input: {
    readonly projectId: string;
    readonly sourceRevisionId: string;
    readonly catalogRevision: string;
    readonly buildId: string;
    readonly componentId: string;
    readonly storyId: string;
  }): StoryPreviewTicket | undefined;
}

export class UnconfiguredStoryPreviewCapabilityPort implements StoryPreviewCapabilityPort {
  public issue(): undefined {
    return undefined;
  }
}

function currentComponentCatalogArtifacts(
  port: ComponentCatalogManifestPort,
  workspace: ReactSourceWorkspace,
  graph?: PrototypeGraph
): { readonly catalog: unknown; readonly prototype: unknown } {
  let catalog: unknown;
  try {
    catalog = port.current(workspace.projectId, workspace, graph);
  } catch {
    // Host adapter failures become the same bounded renderer state as malformed input.
    catalog = null;
  }
  let prototype: unknown;
  try {
    prototype = port.currentPrototype?.(workspace.projectId);
  } catch {
    prototype = null;
  }
  return { catalog, prototype };
}

function canonicalStoryReferencesFor(
  workspace: ReactSourceWorkspace,
  catalogValue: unknown
): readonly CanonicalStoryReference[] {
  const catalog = projectComponentCatalogManifest(catalogValue, {
    projectId: workspace.projectId,
    prototypeRevision: workspace.revision.id
  });
  if (catalog.state !== 'ready') return [];
  return catalog.components.flatMap((component) =>
    component.stories.map((story) => ({
      format: 'selene-canonical-story-reference/v1' as const,
      projectId: catalog.projectId,
      catalogRevision: catalog.catalogRevision,
      buildId: catalog.buildId,
      componentId: component.id,
      storyId: story.id
    }))
  );
}

function currentFederatedComponentCatalog(
  port: ComponentCatalogManifestPort,
  productMap: DesktopProductMap | undefined
): DesignerSnapshot['componentCatalog']['federation'] | undefined {
  if (productMap?.scope.kind !== 'federation') return undefined;
  const shellProjectId = productMap.scope.shellProjectId;
  const projectIds = productMap.projects
    .filter((project) => project.shellProjectId === shellProjectId)
    .map((project) => project.projectId);
  let manifests: readonly unknown[];
  try {
    manifests = port.currentFederation?.(projectIds) ?? [];
  } catch {
    manifests = [null];
  }
  return projectFederatedComponentCatalogs(manifests);
}

function issueStoryPreview(
  port: StoryPreviewCapabilityPort,
  input: Parameters<StoryPreviewCapabilityPort['issue']>[0]
): StoryPreviewTicket | undefined {
  try {
    const ticket = port.issue(input);
    return ticket === undefined ? undefined : validateStoryPreviewTicket(ticket);
  } catch {
    return undefined;
  }
}

export class DesignerApplicationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DesignerApplicationError';
  }
}

interface PreviewScreenData {
  readonly id: string;
  readonly route: string;
  readonly title: string;
  readonly summary: string;
  readonly action: string;
  readonly actionPort: string;
  readonly nextScreenId: string;
}

/** Typed boundary for content that must remain data, never executable TSX. */
interface PreviewDataArtifact {
  readonly format: 'selene-desktop-preview-data/v1';
  readonly initialScreenId: string;
  readonly screens: readonly PreviewScreenData[];
}

/** Source exports and sanitized package manifests define the portable, execution-free catalog. */
function componentCatalogFor(
  source: ReactSourceWorkspace,
  setup: DesignerSnapshot['setup'] | undefined,
  artifacts: { readonly catalog: unknown; readonly prototype: unknown },
  storyPreviews: StoryPreviewCapabilityPort,
  federation?: DesignerSnapshot['componentCatalog']['federation']
): DesignerSnapshot['componentCatalog'] {
  const manifest = projectComponentCatalogManifest(artifacts.catalog, {
    projectId: source.projectId,
    prototypeRevision: source.revision.id
  });
  const usage = projectComponentCatalogUsage(artifacts.prototype, artifacts.catalog, {
    projectId: source.projectId,
    prototypeRevision: source.revision.id
  });
  const usageByComponent =
    usage.state === 'ready'
      ? new Map(usage.components.map((component) => [component.componentId, component.screens]))
      : new Map();
  const entries = new Map<string, DesignerSnapshot['componentCatalog']['entries'][number]>();
  for (const node of source.nodes) {
    const key = `${node.path}\u0000${node.exportName}`;
    if (entries.has(key)) continue;
    const component =
      node.exportName === 'default' ? basename(node.path, extname(node.path)) : node.exportName;
    entries.set(key, {
      component,
      href: `${node.path}#${node.exportName}`,
      origin: 'project'
    });
  }
  const designSystems =
    setup?.designSystems ??
    (setup?.designSystem === undefined
      ? []
      : [
          {
            id: setup.designSystem.artifactDigest,
            enabled: true,
            receipt: setup.designSystem
          }
        ]);
  for (const input of designSystems) {
    if (!input.enabled || input.receipt.catalog === undefined) continue;
    for (const component of input.receipt.catalog.components) {
      const key = `${input.receipt.packageName}\u0000${input.receipt.version}\u0000${component.entrypoint}\u0000${component.exportName}`;
      entries.set(key, {
        component: component.name,
        href: `npm:${input.receipt.packageName}@${input.receipt.version}/${component.entrypoint}#${component.exportName}`,
        origin: 'design-system',
        packageName: input.receipt.packageName,
        version: input.receipt.version,
        exportName: component.exportName,
        entrypoint: component.entrypoint,
        artifactDigest: input.receipt.artifactDigest,
        ...(component.properties === undefined ? {} : { properties: component.properties }),
        ...(component.slots === undefined ? {} : { slots: component.slots })
      });
    }
    for (const pattern of input.receipt.catalog.patterns ?? []) {
      const component = input.receipt.catalog.components.find(
        (candidate) =>
          candidate.entrypoint === pattern.component.entrypoint &&
          candidate.exportName === pattern.component.exportName
      );
      if (component === undefined) continue;
      const key = `${input.receipt.packageName}\u0000${input.receipt.version}\u0000pattern\u0000${pattern.id}`;
      entries.set(key, {
        component: pattern.label,
        href: `npm:${input.receipt.packageName}@${input.receipt.version}/${component.entrypoint}#${component.exportName}?pattern=${pattern.id}`,
        origin: 'design-system',
        packageName: input.receipt.packageName,
        version: input.receipt.version,
        exportName: component.exportName,
        entrypoint: component.entrypoint,
        artifactDigest: input.receipt.artifactDigest,
        patternId: pattern.id,
        ...(pattern.description === undefined ? {} : { description: pattern.description }),
        ...(component.properties === undefined ? {} : { properties: component.properties })
      });
    }
    for (const template of input.receipt.catalog.templates ?? []) {
      const component = input.receipt.catalog.components.find(
        (candidate) =>
          candidate.entrypoint === template.component.entrypoint &&
          candidate.exportName === template.component.exportName
      );
      if (component === undefined) continue;
      const key = `${input.receipt.packageName}\u0000${input.receipt.version}\u0000template\u0000${template.id}`;
      entries.set(key, {
        component: template.label,
        href: `npm:${input.receipt.packageName}@${input.receipt.version}/${component.entrypoint}#${component.exportName}?template=${template.id}`,
        origin: 'design-system',
        packageName: input.receipt.packageName,
        version: input.receipt.version,
        exportName: component.exportName,
        entrypoint: component.entrypoint,
        artifactDigest: input.receipt.artifactDigest,
        templateId: template.id,
        templateKind: template.kind,
        ...(template.propertyValues === undefined
          ? {}
          : { presetProperties: template.propertyValues }),
        ...(template.description === undefined ? {} : { description: template.description }),
        ...(component.properties === undefined ? {} : { properties: component.properties })
      });
    }
  }
  if (manifest.state === 'ready') {
    for (const component of manifest.components) {
      for (const [key, entry] of entries) {
        if (
          entry.origin === 'project' &&
          entry.catalogComponentId === undefined &&
          entry.component === component.id
        )
          entries.delete(key);
      }
      entries.set(`manifest\u0000${component.id}`, {
        component: component.id,
        href: `catalog:${encodeURIComponent(manifest.projectId)}/${encodeURIComponent(component.id)}`,
        origin: 'project',
        catalogComponentId: component.id,
        owner: component.owner,
        declaredProps: component.props,
        requiredCoverage: component.requiredCoverage,
        screenUsage: usageByComponent.get(component.id) ?? [],
        stories: component.stories.map((story) => {
          const previewTicket = issueStoryPreview(storyPreviews, {
            projectId: manifest.projectId,
            sourceRevisionId: source.revision.id,
            catalogRevision: manifest.catalogRevision,
            buildId: manifest.buildId,
            componentId: component.id,
            storyId: story.id
          });
          return {
            ...story,
            ...(previewTicket === undefined ? {} : { previewTicket })
          };
        }),
        description: `Validated catalog component owned by ${component.owner}.`
      });
    }
  }
  if (federation?.state === 'ready') {
    for (const project of federation.projects) {
      if (project.projectId === source.projectId) continue;
      for (const component of project.components) {
        entries.set(`federated\u0000${project.projectId}\u0000${component.id}`, {
          component: component.id,
          href: `catalog:${encodeURIComponent(project.projectId)}/${encodeURIComponent(component.id)}`,
          origin: 'federated',
          owningProjectId: project.projectId,
          catalogRevision: project.catalogRevision,
          buildId: project.buildId,
          catalogComponentId: component.id,
          owner: component.owner,
          canonicalStories: component.stories,
          description: `Federated component owned by ${component.owner} in ${project.projectId}.`
        });
      }
    }
  }
  return {
    manifest,
    ...(federation === undefined ? {} : { federation }),
    entries: [...entries.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, entry]) => entry)
  };
}

const previewAppSource = `import { useEffect, useLayoutEffect, useState } from 'react';
import './preview.css';
import data from './preview-data.json';

export default function App() {
  const descriptorScreenId = document.documentElement.dataset.previewScreenId;
  const initialScreenId =
    typeof descriptorScreenId === 'string' &&
    data.screens.some((screen) => screen.id === descriptorScreenId)
      ? descriptorScreenId
      : data.initialScreenId;
  const [screenId, setScreenId] = useState(initialScreenId);

  const navigateTo = (nextScreenId: string) => {
    const next = data.screens.find((screen) => screen.id === nextScreenId);
    if (next === undefined) return;
    window.history.pushState({ screen: next.id }, '', next.route);
    setScreenId(next.id);
  };

  useLayoutEffect(() => {
    const initial = data.screens.find((screen) => screen.id === initialScreenId);
    if (initial !== undefined)
      window.history.replaceState({ screen: initial.id }, '', initial.route);
  }, [initialScreenId]);

  useEffect(() => {
    const onRuntime = (event: Event) => {
      const activeNodeId = (event as CustomEvent<{ activeNodeId?: unknown }>).detail?.activeNodeId;
      if (typeof activeNodeId !== 'string') return;
      const next = data.screens.find((screen) => screen.id === activeNodeId);
      if (next === undefined) return;
      window.history.replaceState({ screen: activeNodeId }, '', next.route);
      setScreenId(activeNodeId);
    };

    window.addEventListener('selene-runtime-state', onRuntime);
    return () => window.removeEventListener('selene-runtime-state', onRuntime);
  }, []);

  useEffect(() => {
    const onPopState = () => {
      const next = data.screens.find((screen) => screen.route === window.location.pathname);
      if (next !== undefined) setScreenId(next.id);
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const screen = data.screens.find((item) => item.id === screenId) ?? data.screens[0];
  if (!screen) throw new Error('Preview data is missing a screen');

  return (
    <main data-selene-node-id="designer.root">
      <h1 data-selene-node-id="designer.title">{screen.title}</h1>
      <p data-selene-node-id="designer.summary">{screen.summary}</p>
      <button
        data-selene-flow-node={screen.id}
        data-selene-action-port={screen.actionPort}
        data-selene-node-id="designer.action"
        onClick={() => navigateTo(screen.nextScreenId)}
      >
        {screen.action}
      </button>
    </main>
  );
}
`;

function serializePreviewData(data: PreviewDataArtifact): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function previewDataFor(
  instruction: string,
  scenario: {
    readonly state: string;
    readonly fixture: Pick<EnterpriseScenario['fixture'], 'heading' | 'summary'>;
  }
): string {
  return serializePreviewData({
    format: 'selene-desktop-preview-data/v1',
    initialScreenId: 'dashboard',
    screens: [
      {
        id: 'dashboard',
        route: '/',
        title: scenario.fixture.heading,
        summary: `${scenario.state}: ${scenario.fixture.summary}`,
        action: instruction,
        actionPort: 'open-orders',
        nextScreenId: 'orders'
      },
      {
        id: 'orders',
        route: '/orders',
        title: 'Orders',
        summary: 'Deterministic fixture: no orders need attention.',
        action: 'Back to dashboard',
        actionPort: 'back',
        nextScreenId: 'dashboard'
      }
    ]
  });
}

export function createInitialWorkspace(projectId = 'desktop-designer'): ReactSourceWorkspace {
  return {
    format: 'selene-react-workspace/v1',
    projectId,
    entrypoint: 'src/App.tsx',
    files: [
      {
        path: 'src/App.tsx',
        language: 'tsx',
        content: previewAppSource
      },
      {
        path: 'src/preview-data.json',
        language: 'json',
        content: previewDataFor('Open orders', {
          state: 'default',
          fixture: {
            heading: 'Dashboard',
            summary: 'Deterministic fixture: 12 orders need attention.'
          }
        })
      },
      {
        path: 'src/preview.css',
        language: 'css',
        content:
          'main{font-family:system-ui;padding:2rem;max-width:48rem}button{padding:.6rem 1rem}\n'
      }
    ],
    dependencies: ['react', 'react-dom', 'react-dom/client'],
    nodes: [
      { nodeId: 'designer.action', path: 'src/App.tsx', exportName: 'default' },
      { nodeId: 'designer.root', path: 'src/App.tsx', exportName: 'default' },
      { nodeId: 'designer.summary', path: 'src/App.tsx', exportName: 'default' },
      { nodeId: 'designer.title', path: 'src/App.tsx', exportName: 'default' }
    ],
    revision: {
      id: `${projectId}-r1`,
      createdAt: '2026-07-24T00:00:00.000Z',
      summary: 'Initial desktop designer source'
    }
  };
}

function initialBaseline(projectId: string): DesignBaselineState {
  return {
    projectId,
    readiness: 'draft',
    currency: 'none',
    changesSinceBaseline: [],
    approvalsStale: false
  };
}

const localCollaborationOrganizationId = 'local-desktop';

function collaborationAnchor(
  anchor: DesignerSnapshot['reviewThreads'][number]['anchor'],
  revisionFingerprint: string
) {
  const target =
    anchor.width !== undefined && anchor.height !== undefined
      ? {
          kind: 'region' as const,
          region: { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height }
        }
      : { kind: 'point' as const, point: { x: anchor.x, y: anchor.y } };
  return {
    evidence: {
      artifactId: anchor.artifactId,
      screenId: anchor.screenId,
      revisionId: anchor.revisionId,
      revisionFingerprint,
      viewport: { ...anchor.viewport, zoom: 1 },
      scenarioId: anchor.scenarioId,
      stateId: anchor.state,
      ...(anchor.nodeRef === undefined ? {} : { nodeId: anchor.nodeRef })
    },
    target,
    lifecycle: 'current' as const
  };
}

function desktopAnchor(
  anchor: CollaborationReviewThread['anchor']
): DesignerSnapshot['reviewThreads'][number]['anchor'] {
  const target =
    anchor.target.kind === 'point'
      ? { x: anchor.target.point.x, y: anchor.target.point.y }
      : anchor.target.region;
  return {
    ...target,
    artifactId: anchor.evidence.artifactId,
    screenId: anchor.evidence.screenId,
    scenarioId: anchor.evidence.scenarioId ?? 'owner-loading-desktop',
    state: anchor.evidence.stateId ?? 'default',
    revisionId: anchor.evidence.revisionId,
    viewport: {
      width: anchor.evidence.viewport.width,
      height: anchor.evidence.viewport.height
    },
    ...(anchor.evidence.nodeId === undefined ? {} : { nodeRef: anchor.evidence.nodeId })
  };
}

function currentAnchor(
  source: ReactSourceWorkspace
): DesignerSnapshot['reviewThreads'][number]['anchor'] {
  return {
    x: 0,
    y: 0,
    artifactId: source.projectId,
    screenId: 'desktop-designer',
    scenarioId: enterpriseScenarioFixtures[0]?.id ?? 'owner-loading-desktop',
    state: enterpriseScenarioFixtures[0]?.state ?? 'default',
    revisionId: source.revision.id,
    viewport: { width: 1, height: 1 },
    nodeRef: 'designer.root'
  };
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function strictlyLaterTimestamp(...timestamps: readonly string[]): string {
  const latest = Math.max(...timestamps.map((value) => Date.parse(value)), Date.now());
  return new Date(latest + 1).toISOString();
}

function toCollaborationDesignReviewState(
  state: DesignBaselineState
): NonNullable<CollaborationSnapshot['designReviewState']> {
  return {
    format: 'selene-design-review-state/v1',
    projectId: state.projectId,
    readiness: state.readiness,
    ...(state.baseline === undefined ? {} : { baseline: state.baseline }),
    currency: state.currency,
    approvalsStale: state.approvalsStale,
    changesSinceBaseline: state.changesSinceBaseline
  };
}

function fromCollaborationDesignReviewState(
  state: CollaborationSnapshot['designReviewState'] | undefined,
  projectId: string
): DesignBaselineState {
  if (state === undefined) return initialBaseline(projectId);
  return {
    projectId: state.projectId,
    readiness: state.readiness,
    ...(state.baseline === undefined ? {} : { baseline: state.baseline }),
    currency: state.currency,
    approvalsStale: state.approvalsStale,
    changesSinceBaseline: state.changesSinceBaseline
  };
}

function createCollaborationSnapshot(
  source: ReactSourceWorkspace,
  baseline: DesignBaselineState,
  authorId: string
): CollaborationSnapshot {
  return {
    format: 'selene-collaboration/v2',
    project: {
      id: source.projectId,
      organizationId: localCollaborationOrganizationId,
      name: source.projectId
    },
    revisions: [
      {
        id: source.revision.id,
        projectId: source.projectId,
        sequence: 1,
        content: source,
        contentSha256: digest(source),
        scenarioIds: enterpriseScenarioFixtures.map((scenario) => scenario.id),
        createdBy: authorId,
        createdAt: source.revision.createdAt
      }
    ],
    threads: [],
    comments: [],
    reactions: [],
    approvals: [],
    reviewThreads: [],
    aiChangeRequests: [],
    developerAnnotations: [],
    designReviewState: toCollaborationDesignReviewState(baseline)
  };
}

interface HydratedDesignerState {
  readonly baseline: DesignBaselineState;
  readonly reviewThreads: readonly ReviewThread[];
  readonly artifactPins: readonly ArtifactPin[];
  readonly aiChangeRequests: readonly AIChangeRequest[];
  readonly developerAnnotations: readonly DeveloperHandoffAnnotation[];
}

function projectAIChangeRequest(
  request: CollaborationSnapshot['aiChangeRequests'][number]
): AIChangeRequest {
  const status: AIChangeRequest['status'] = request.lifecycle;
  const result = request.lifecycle === 'undone' ? request.undoResult : request.result;
  return {
    id: request.id,
    agentId: request.provider.providerId,
    instruction: request.instruction,
    target: desktopAnchor(request.anchor),
    status,
    createdAt: request.createdAt,
    ...(result === undefined ? {} : { resultingRevisionId: result.revisionId }),
    ...(request.failureReason === undefined ? {} : { error: request.failureReason })
  };
}

function projectRendererState(snapshot: CollaborationSnapshot): HydratedDesignerState {
  const reviewThreads: ReviewThread[] = snapshot.reviewThreads.map((thread) => {
    const [first, ...replies] = thread.messages;
    if (first === undefined)
      throw new DesignerApplicationError('Saved review thread has no opening message.');
    return {
      id: thread.id,
      status: thread.lifecycle,
      anchor: desktopAnchor(thread.anchor),
      body: first.body,
      replies: replies.map((reply) => ({
        id: reply.id,
        body: reply.body,
        author: reply.createdBy,
        createdAt: reply.createdAt
      })),
      author: thread.createdBy,
      createdAt: thread.createdAt,
      ...(thread.resolvedAt === undefined ? {} : { resolvedAt: thread.resolvedAt })
    };
  });
  const aiChangeRequests = snapshot.aiChangeRequests.map(projectAIChangeRequest);
  const developerAnnotations: DeveloperHandoffAnnotation[] = snapshot.developerAnnotations.map(
    (annotation) => ({
      id: annotation.id,
      category:
        annotation.category === 'development'
          ? 'implementation'
          : annotation.category === 'interaction'
            ? 'behavior'
            : annotation.category === 'content'
              ? 'visual'
              : 'accessibility',
      body: annotation.body,
      ...(annotation.anchor.evidence.nodeId === undefined
        ? {}
        : { nodeRef: annotation.anchor.evidence.nodeId }),
      createdAt: annotation.createdAt
    })
  );
  const artifactPins: ArtifactPin[] = snapshot.reviewThreads.map((thread) => ({
    id: thread.id,
    label: thread.messages[0]?.body ?? 'Review anchor',
    anchor: desktopAnchor(thread.anchor),
    createdAt: thread.createdAt
  }));
  return {
    baseline: fromCollaborationDesignReviewState(snapshot.designReviewState, snapshot.project.id),
    reviewThreads,
    artifactPins,
    aiChangeRequests,
    developerAnnotations
  };
}

function handoffReviewThreads(
  threads: readonly ReviewThread[],
  workspace: ReactSourceWorkspace
): readonly GeneratedDesignReviewThread[] {
  const nodeIds = new Set(workspace.nodes.map((node) => node.nodeId));
  return threads.map((thread) => ({
    id: thread.id,
    status: thread.status,
    anchor: {
      artifactId: thread.anchor.artifactId,
      screenId: thread.anchor.screenId,
      scenarioId: thread.anchor.scenarioId,
      state: thread.anchor.state,
      revisionId: thread.anchor.revisionId,
      x: thread.anchor.x,
      y: thread.anchor.y,
      ...(thread.anchor.width === undefined ? {} : { width: thread.anchor.width }),
      ...(thread.anchor.height === undefined ? {} : { height: thread.anchor.height }),
      ...(thread.anchor.nodeRef === undefined || !nodeIds.has(thread.anchor.nodeRef)
        ? {}
        : { nodeId: thread.anchor.nodeRef })
    },
    messages: [
      { body: thread.body, author: thread.author, createdAt: thread.createdAt },
      ...thread.replies.map((reply) => ({
        body: reply.body,
        author: reply.author,
        createdAt: reply.createdAt
      }))
    ]
  }));
}

function localProjectGeneratedHandoff(
  project: LocalProductHandoffProject,
  reproducibility: Awaited<ReturnType<HandoffMetadataPort['load']>>,
  componentCatalogManifests: ComponentCatalogManifestPort
): GeneratedDesignHandoff {
  if (project.workspace.projectId !== project.projectId)
    throw new DesignerApplicationError('Product handoff workspace identity is invalid.');
  if (project.designerState?.pendingAIProposal !== undefined)
    throw new DesignerApplicationError(
      `Accept or reject the staged AI proposal in ${project.name} before exporting the product handoff.`
    );
  const projected =
    project.designerState === undefined
      ? {
          baseline: initialBaseline(project.projectId),
          reviewThreads: [] as readonly ReviewThread[],
          developerAnnotations: [] as readonly DeveloperHandoffAnnotation[]
        }
      : projectRendererState(parseSnapshot(project.designerState.collaborationSnapshot));
  const reviewThreads = handoffReviewThreads(projected.reviewThreads, project.workspace);
  const catalog = currentComponentCatalogArtifacts(
    componentCatalogManifests,
    project.workspace
  ).catalog;
  return createGeneratedDesignHandoff({
    workspace: project.workspace,
    baseline: projected.baseline,
    comments: reviewThreads.flatMap((thread) =>
      thread.anchor.nodeId === undefined
        ? []
        : [{ nodeId: thread.anchor.nodeId, body: thread.messages[0]?.body ?? '' }]
    ),
    reviewThreads,
    developerDirections: projected.developerAnnotations.map(
      (annotation) => `[${annotation.category}] ${annotation.body}`
    ),
    reproducibility,
    project: {
      id: project.projectId,
      owner: project.name,
      status: projected.baseline.readiness,
      routes: ['/'],
      storybook: project.workspace.nodes.map((node) => ({
        component: node.exportName,
        url: `local://component-catalog/${encodeURIComponent(node.nodeId)}`
      })),
      storyReferences: canonicalStoryReferencesFor(project.workspace, catalog),
      acceptanceCriteria: [
        'Render validated TSX',
        'Preserve stable component-node metadata',
        'Re-check every exact post-baseline design change'
      ]
    },
    agentInstructions: [
      'Preserve stable node IDs and project ownership.',
      'Use the selected scenarios and verify every stale baseline delta before implementation.'
    ]
  });
}

const prototypeFlow: PrototypeFlowGraph = {
  format: 'selene-prototype-flow/v1',
  nodes: [
    { id: 'dashboard', kind: 'screen', title: 'Dashboard', states: ['default'] },
    { id: 'orders', kind: 'screen', title: 'Orders', states: ['empty'] }
  ],
  connections: [
    {
      id: 'dashboard-to-orders',
      fromNodeId: 'dashboard',
      actionPort: 'designer.action',
      transition: { kind: 'navigate', toScreenId: 'orders' }
    }
  ]
};

const editablePrototype = parsePrototypeGraph({
  format: 'selene-prototype-graph/v1',
  id: 'desktop-designer-flow',
  name: 'Desktop designer review flow',
  project: { projectId: 'desktop-designer', owner: 'Desktop design' },
  revision: {
    id: 'desktop-flow-r1',
    createdAt: '2026-07-24T00:00:00.000Z',
    summary: 'Desktop flow'
  },
  handoff: { status: 'draft', owner: 'Desktop design', summary: 'Local editable product flow' },
  initialNodeId: 'dashboard',
  nodes: [
    {
      id: 'dashboard',
      kind: 'screen',
      label: 'Dashboard',
      route: '/',
      position: { x: 0, y: 0 },
      ports: [
        { id: 'open-orders', label: 'Open orders', trigger: 'click' },
        { id: 'open-review', label: 'Review details', trigger: 'click' }
      ]
    },
    {
      id: 'orders',
      kind: 'screen',
      label: 'Orders',
      route: '/orders',
      position: { x: 440, y: 0 },
      ports: [{ id: 'back', label: 'Back', trigger: 'click' }]
    },
    {
      id: 'review-overlay',
      kind: 'overlay',
      label: 'Review details',
      dismissible: true,
      position: { x: 260, y: 260 },
      ports: [{ id: 'dismiss', label: 'Dismiss', trigger: 'click' }]
    },
    {
      id: 'loading',
      kind: 'state',
      label: 'Loading',
      parentId: 'dashboard',
      position: { x: 0, y: 260 },
      ports: []
    }
  ],
  transitions: [
    {
      id: 'dashboard-orders',
      kind: 'navigate',
      from: { nodeId: 'dashboard', portId: 'open-orders' },
      to: { nodeId: 'orders' }
    },
    {
      id: 'dashboard-review',
      kind: 'open-overlay',
      from: { nodeId: 'dashboard', portId: 'open-review' },
      to: { nodeId: 'review-overlay' }
    },
    { id: 'orders-back', kind: 'back', from: { nodeId: 'orders', portId: 'back' } },
    {
      id: 'review-close',
      kind: 'close-overlay',
      from: { nodeId: 'review-overlay', portId: 'dismiss' },
      to: { nodeId: 'review-overlay' }
    }
  ],
  scenarios: [
    {
      id: 'desktop-review',
      name: 'Desktop review',
      startNodeId: 'dashboard',
      initialStateId: 'loading',
      expectedPath: ['dashboard', 'review-overlay']
    },
    {
      id: 'orders-default',
      name: 'Orders default',
      startNodeId: 'orders',
      expectedPath: ['orders']
    }
  ],
  fixtures: { owner: 'Desktop design' }
});

/**
 * The fixture supplies topology only. A missing persisted graph must inherit the
 * active React workspace identity before the renderer can submit its first save.
 * Persisted graphs are deliberately never rebound: a mismatched document is a
 * recovery condition, not a migration.
 */
function freshPrototypeGraphForWorkspace(workspace: ReactSourceWorkspace) {
  return parsePrototypeGraph({
    ...editablePrototype,
    project: { ...editablePrototype.project, projectId: workspace.projectId },
    revision: { ...workspace.revision }
  });
}

const manualLayoutLengthValue =
  /^(?:auto|fit-content|min-content|max-content|0|(?:\d+(?:\.\d+)?)(?:px|rem|em|%|vw|vh))$/u;

function supportedManualLayoutValue(
  property: ManualLayoutProperty,
  value: unknown
): value is ManualLayoutValue {
  if (property === 'order')
    return (
      (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000) ||
      (typeof value === 'string' && /^(?:0|[1-9]\d{0,3})$/u.test(value))
    );
  if (
    property === 'width' ||
    property === 'height' ||
    property === 'minWidth' ||
    property === 'minHeight' ||
    property === 'maxWidth' ||
    property === 'maxHeight' ||
    property === 'gap'
  )
    return (
      (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100_000) ||
      (typeof value === 'string' && value.length <= 128 && manualLayoutLengthValue.test(value))
    );
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false;
  if (property === 'display')
    return ['block', 'flex', 'grid', 'inline-flex', 'inline-grid', 'none'].includes(value);
  if (property === 'flexDirection')
    return ['row', 'column', 'row-reverse', 'column-reverse'].includes(value);
  if (property === 'justifyContent')
    return [
      'flex-start',
      'center',
      'flex-end',
      'space-between',
      'space-around',
      'space-evenly'
    ].includes(value);
  if (property === 'alignItems')
    return ['stretch', 'flex-start', 'center', 'flex-end', 'baseline'].includes(value);
  return false;
}

function inlineStyleLiterals(
  element: ts.JsxElement
): readonly Readonly<{ property: string; value: string | number }>[] | undefined {
  const styleAttributes = element.openingElement.attributes.properties.filter(
    (attribute): attribute is ts.JsxAttribute =>
      ts.isJsxAttribute(attribute) &&
      ts.isIdentifier(attribute.name) &&
      attribute.name.text === 'style'
  );
  if (styleAttributes.length > 1) return undefined;
  const styleAttribute = styleAttributes[0];
  if (styleAttribute === undefined) return Object.freeze([]);
  if (
    styleAttribute.initializer === undefined ||
    !ts.isJsxExpression(styleAttribute.initializer) ||
    styleAttribute.initializer.expression === undefined ||
    !ts.isObjectLiteralExpression(styleAttribute.initializer.expression)
  )
    return undefined;
  const values: Readonly<{ property: string; value: string | number }>[] = [];
  for (const candidate of styleAttribute.initializer.expression.properties) {
    if (
      !ts.isPropertyAssignment(candidate) ||
      !ts.isIdentifier(candidate.name) ||
      (!ts.isStringLiteral(candidate.initializer) && !ts.isNumericLiteral(candidate.initializer))
    )
      return undefined;
    const value = ts.isStringLiteral(candidate.initializer)
      ? candidate.initializer.text
      : Number(candidate.initializer.text);
    values.push(Object.freeze({ property: candidate.name.text, value }));
  }
  return Object.freeze(values);
}

function currentManualLayoutValues(
  element: ts.JsxElement
): Readonly<Partial<Record<ManualLayoutProperty, ManualLayoutValue>>> | undefined {
  const literals = inlineStyleLiterals(element);
  if (literals === undefined) return undefined;
  const values: Partial<Record<ManualLayoutProperty, ManualLayoutValue>> = {};
  const seen = new Set<ManualLayoutProperty>();
  for (const candidate of literals) {
    if (!MANUAL_LAYOUT_PROPERTIES.includes(candidate.property as ManualLayoutProperty)) continue;
    const property = candidate.property as ManualLayoutProperty;
    if (seen.has(property)) return undefined;
    seen.add(property);
    if (supportedManualLayoutValue(property, candidate.value)) values[property] = candidate.value;
  }
  return Object.freeze(values);
}

const manualAppearanceToken = /^var\(--[a-z][a-z0-9_-]{0,63}\)$/iu;
const manualAppearanceLength = /^(?:0|\d+(?:\.\d+)?(?:px|rem|em|%))$/u;
const manualAppearanceSignedLength = /^(?:0|-?\d+(?:\.\d+)?(?:px|rem|em))$/u;

function supportedAppearanceSpacing(value: string, allowAuto: boolean): boolean {
  const parts = value.split(' ');
  return (
    parts.length >= 1 &&
    parts.length <= 4 &&
    parts.every(
      (part) =>
        manualAppearanceLength.test(part) ||
        manualAppearanceToken.test(part) ||
        (allowAuto && part === 'auto')
    )
  );
}

function supportedManualAppearanceValue(
  property: ManualAppearanceProperty,
  value: unknown
): value is ManualAppearanceValue {
  if (property === 'opacity') {
    const opacity = typeof value === 'string' && value.length <= 8 ? Number(value) : value;
    return typeof opacity === 'number' && Number.isFinite(opacity) && opacity >= 0 && opacity <= 1;
  }
  if (property === 'fontWeight') {
    if (typeof value === 'number')
      return Number.isInteger(value) && value >= 100 && value <= 900 && value % 100 === 0;
    return (
      typeof value === 'string' &&
      (value === 'normal' ||
        value === 'bold' ||
        /^(?:100|200|300|400|500|600|700|800|900)$/u.test(value))
    );
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false;
  if (property === 'color' || property === 'backgroundColor')
    return (
      /^#(?:[a-f0-9]{3}|[a-f0-9]{4}|[a-f0-9]{6}|[a-f0-9]{8})$/iu.test(value) ||
      value === 'transparent' ||
      value === 'currentColor' ||
      manualAppearanceToken.test(value)
    );
  if (property === 'fontFamily')
    return (
      /^[a-z0-9 '"_,.-]+$/iu.test(value) &&
      !value.toLowerCase().includes('url(') &&
      !value.toLowerCase().includes('var(')
    );
  if (property === 'fontSize' || property === 'borderRadius')
    return manualAppearanceLength.test(value) || manualAppearanceToken.test(value);
  if (property === 'letterSpacing')
    return manualAppearanceSignedLength.test(value) || manualAppearanceToken.test(value);
  if (property === 'lineHeight')
    return (
      /^(?:0\.[5-9]|[1-3](?:\.\d+)?|4(?:\.0+)?)$/u.test(value) ||
      manualAppearanceLength.test(value) ||
      manualAppearanceToken.test(value)
    );
  if (property === 'textAlign')
    return ['start', 'center', 'end', 'left', 'right', 'justify'].includes(value);
  if (property === 'padding') return supportedAppearanceSpacing(value, false);
  if (property === 'margin') return supportedAppearanceSpacing(value, true);
  return false;
}

function currentManualAppearanceValues(
  element: ts.JsxElement
): Readonly<Partial<Record<ManualAppearanceProperty, ManualAppearanceValue>>> | undefined {
  const literals = inlineStyleLiterals(element);
  if (literals === undefined) return undefined;
  const values: Partial<Record<ManualAppearanceProperty, ManualAppearanceValue>> = {};
  const seen = new Set<ManualAppearanceProperty>();
  for (const candidate of literals) {
    if (!MANUAL_APPEARANCE_PROPERTIES.includes(candidate.property as ManualAppearanceProperty))
      continue;
    const property = candidate.property as ManualAppearanceProperty;
    if (seen.has(property)) return undefined;
    seen.add(property);
    if (supportedManualAppearanceValue(property, candidate.value))
      values[property] = candidate.value;
  }
  return Object.freeze(values);
}

/** Numeric negatives in TSX are prefix expressions; only an authored unary minus is accepted. */
function boundedSignedNumericLiteralValue(
  expression: ts.Expression | undefined
): number | undefined {
  if (expression === undefined) return undefined;
  const value = ts.isNumericLiteral(expression)
    ? Number(expression.text)
    : ts.isPrefixUnaryExpression(expression) &&
        expression.operator === ts.SyntaxKind.MinusToken &&
        ts.isNumericLiteral(expression.operand)
      ? -Number(expression.operand.text)
      : undefined;
  return value !== undefined && Number.isFinite(value) && Math.abs(value) <= 100_000
    ? value
    : undefined;
}

function currentManualPositionValues(element: ts.JsxElement):
  | Readonly<{
      readonly position: 'absolute' | 'fixed';
      readonly left: number;
      readonly top: number;
    }>
  | undefined {
  const styleAttributes = element.openingElement.attributes.properties.filter(
    (attribute): attribute is ts.JsxAttribute =>
      ts.isJsxAttribute(attribute) &&
      ts.isIdentifier(attribute.name) &&
      attribute.name.text === 'style'
  );
  if (styleAttributes.length !== 1) return undefined;
  const styleAttribute = styleAttributes[0];
  if (
    styleAttribute?.initializer === undefined ||
    !ts.isJsxExpression(styleAttribute.initializer) ||
    styleAttribute.initializer.expression === undefined ||
    !ts.isObjectLiteralExpression(styleAttribute.initializer.expression)
  )
    return undefined;
  const values = new Map<string, ts.Expression>();
  for (const candidate of styleAttribute.initializer.expression.properties) {
    if (!ts.isPropertyAssignment(candidate) || !ts.isIdentifier(candidate.name)) return undefined;
    const property = candidate.name.text;
    if (!['position', 'left', 'top'].includes(property)) continue;
    if (values.has(property)) return undefined;
    values.set(property, candidate.initializer);
  }
  const positionInitializer = values.get('position');
  const leftInitializer = values.get('left');
  const topInitializer = values.get('top');
  const position =
    positionInitializer !== undefined && ts.isStringLiteral(positionInitializer)
      ? positionInitializer.text
      : undefined;
  const left = boundedSignedNumericLiteralValue(leftInitializer);
  const top = boundedSignedNumericLiteralValue(topInitializer);
  if (
    (position !== 'absolute' && position !== 'fixed') ||
    typeof left !== 'number' ||
    typeof top !== 'number' ||
    !Number.isFinite(left) ||
    !Number.isFinite(top) ||
    Math.abs(left) > 100_000 ||
    Math.abs(top) > 100_000
  )
    return undefined;
  return Object.freeze({ position, left, top });
}

/**
 * Main-process application layer. It depends on agent and handoff ports, never
 * Electron, Vite, or a particular agent vendor, so it is directly testable.
 */
export class DesktopDesignerApplicationService {
  private readonly agents = new Map<string, DesignerAgentAdapter>();
  private readonly listeners = new Set<(event: DesignerProgress) => void>();
  private readonly reviewThreads: ReviewThread[] = [];
  private readonly artifactPins: ArtifactPin[] = [];
  private readonly aiChangeRequests: AIChangeRequest[] = [];
  private readonly developerAnnotations: DeveloperHandoffAnnotation[] = [
    {
      id: 'annotation-1',
      category: 'accessibility',
      body: 'Keep the primary action reachable by keyboard after source revisions.',
      nodeRef: 'designer.action',
      createdAt: '2026-07-24T00:00:00.000Z'
    }
  ];
  private readonly activity: string[] = ['Validated React workspace is ready for review.'];
  private source = createInitialWorkspace();
  private baseline = initialBaseline(this.source.projectId);
  /** Canonical collaboration data is retained verbatim; desktop arrays are projections only. */
  private collaboration: CollaborationSnapshot;
  private selectedAgentId: string | undefined;
  private selectedNodeId: string | undefined;
  private selectedScenarioId = enterpriseScenarioFixtures[0]?.id ?? '';
  private active: { readonly id: string; readonly controller: AbortController } | undefined;
  private undoActive = false;
  private sequence = 0;
  private readonly publishOperations = new Map<string, PublishOperationState>();
  private designSystemCompilerActivation:
    { activate(artifactDigests: readonly string[]): void } | undefined;
  /** One native-consent/start sequence survives renderer panel unmounts and duplicate IPC calls. */
  private publishConsentRequestActive = false;
  private pendingPublishConsent:
    { readonly consentId: string; readonly digest: string; readonly expiresAt: number } | undefined;
  private graph = editablePrototype;
  private graphMode: 'edit' | 'run' = 'edit';
  private graphRevision = 0;
  /** Never sent to preload/renderer; persisted manifest remains inert until host revalidates it. */
  private reactBinding: ReactBindingManifest | undefined;
  /** Host-only immutable manual-edit authority; never included in DesignerSnapshot. */
  private manualReactEditAuthority: LocalManualReactEditAuthority | undefined;
  /** Digest-only, lifecycle-owned manual edit replay records. */
  private manualReactEditJournal: readonly LocalManualReactEditJournalEntry[] | undefined;
  /** Sole host-owned agent candidate awaiting an explicit designer decision. */
  private pendingAIProposal: LocalPendingAIProposal | undefined;
  /** Ephemeral host grants. They are deliberately neither durable state nor renderer snapshot data. */
  private readonly manualTextEditCapabilities = new Map<
    string,
    {
      readonly projectId: string;
      readonly nodeId: string;
      readonly revisionId: string;
      readonly expiresAt: number;
      readonly proposal: DesignEditProposal;
      consumedContent?: string;
    }
  >();
  private readonly manualLayoutEditCapabilities = new Map<
    string,
    {
      readonly projectId: string;
      readonly nodeId: string;
      readonly revisionId: string;
      readonly expiresAt: number;
      readonly proposal: DesignEditProposal;
      consumedEdit?: string;
    }
  >();
  private readonly manualAppearanceEditCapabilities = new Map<
    string,
    {
      readonly projectId: string;
      readonly nodeId: string;
      readonly revisionId: string;
      readonly expiresAt: number;
      readonly proposal: DesignEditProposal;
      consumedEdit?: string;
    }
  >();
  /** Position grants exist only for authored inline absolute/fixed left/top declarations. */
  private readonly manualPositionEditCapabilities = new Map<
    string,
    {
      readonly projectId: string;
      readonly nodeId: string;
      readonly revisionId: string;
      readonly expiresAt: number;
      readonly proposal: DesignEditProposal;
      consumedEdit?: string;
    }
  >();
  /** Structural grants pin one host-derived sibling insertion, never DOM geometry. */
  private readonly manualStructureEditCapabilities = new Map<
    string,
    {
      readonly projectId: string;
      readonly nodeId: string;
      readonly revisionId: string;
      readonly targetNodeId: string;
      readonly operation: 'reorder' | 'reparent';
      readonly proposal: DesignEditProposal;
      readonly expiresAt: number;
      consumed?: boolean;
    }
  >();
  /** Host-minted package insertion grants; package receipts and source anchors never leave this process. */
  private readonly designSystemComponentInsertCapabilities = new Map<
    string,
    {
      readonly projectId: string;
      readonly nodeId: string;
      readonly revisionId: string;
      readonly expiresAt: number;
      readonly proposal: DesignEditProposal;
      consumed?: boolean;
    }
  >();
  /** Host-minted replacement grants preserve the selected stable node and its children. */
  private readonly designSystemComponentReplaceCapabilities = new Map<
    string,
    {
      readonly projectId: string;
      readonly nodeId: string;
      readonly revisionId: string;
      readonly expiresAt: number;
      readonly proposal: DesignEditProposal;
      consumed?: boolean;
    }
  >();
  /** Untrusted persisted data until source, graph, and freshly issued host evidence agree. */
  private pendingReactBinding: ReactBindingManifest | undefined;
  /** A migrated collaboration snapshot is persisted only after host binding revalidation. */
  private pendingProjectStateMigration = false;
  private prototypeRuntime: PrototypeRuntime | undefined;
  private graphHydration: DesignerSnapshot['prototypeGraphHydration'] = { state: 'missing' };
  private graphOperation: Promise<void> = Promise.resolve();
  private projectGeneration = 0;
  /** Cached host projection refreshed at project-open boundaries. */
  private productMap: DesktopProductMap | undefined;
  private readonly publishers: PublishAdapterRegistry;
  /** Host-composed opaque author identity; never accepted from IPC or display text. */
  private readonly collaborationAuthorId: string;
  private static readonly maximumPublishOperations = 32;
  private static readonly maximumPublishProgress = 64;
  private static readonly maximumPublishConsentLifetimeMs = 10 * 60_000;
  /** In-memory, versioned staging provenance for the currently open lifecycle workspace. */
  private designInputProvenance: {
    readonly format: 'selene-desktop-current-workspace-design-inputs/v1';
    readonly projectId: string;
    readonly designSystems?: readonly OrderedDesignSystemInput[];
    readonly designSystem?: DesignSystemIntakeReceipt;
    readonly designLanguages?: readonly OrderedDesignLanguageInput[];
    readonly designLanguage?: MarkdownIntakeReceipt;
  } = {
    format: 'selene-desktop-current-workspace-design-inputs/v1',
    projectId: this.source.projectId
  };

  /**
   * Mints a deliberately narrow, short-lived edit grant. Source paths, operation
   * identities, digests, and the proposal stay in the main process.
   */
  public async requestManualTextEditCapability(
    value: unknown
  ): Promise<ManualTextEditCapability | ManualTextEditUnavailable> {
    const unavailable = (code: ManualTextEditUnavailable['code']): ManualTextEditUnavailable => ({
      kind: 'unavailable',
      code
    });
    const input = this.manualTextCapabilityRequest(value);
    if (input === undefined) return unavailable('MAPPED_TEXT_UNAVAILABLE');
    if (input.projectId !== this.source.projectId) return unavailable('PROJECT_MISMATCH');
    if (input.revisionId !== this.source.revision.id) return unavailable('STALE_SELECTION');
    return this.enqueueGraphOperation(async () => {
      if (input.projectId !== this.source.projectId) return unavailable('PROJECT_MISMATCH');
      if (input.revisionId !== this.source.revision.id) return unavailable('STALE_SELECTION');
      const prepared = this.manualTextProposal(input.nodeId);
      if (prepared === undefined) return unavailable('MAPPED_TEXT_UNAVAILABLE');
      const capabilityId = `manual-text-${randomUUID()}`;
      const expiresAt = Date.now() + 5 * 60_000;
      this.manualTextEditCapabilities.set(capabilityId, {
        projectId: this.source.projectId,
        nodeId: input.nodeId,
        revisionId: this.source.revision.id,
        expiresAt,
        proposal: prepared.proposal
      });
      this.pruneManualTextEditCapabilities();
      return Object.freeze({
        kind: 'available' as const,
        capabilityId,
        nodeId: input.nodeId,
        revisionId: this.source.revision.id,
        currentContent: prepared.currentContent,
        maxLength: 32_768,
        expiresAt: new Date(expiresAt).toISOString()
      });
    });
  }

  /** Host-only transaction evaluation; the renderer cannot supply a proposal. */
  public async applyManualTextEdit(value: unknown): Promise<DesignEditResult> {
    const rejected = (code: string): DesignEditResult => ({
      format: 'selene-design-edit-result/v1',
      kind: 'rejected',
      diagnostics: [{ code }]
    });
    const input = this.manualTextApplyRequest(value);
    if (input === undefined) return rejected('INVALID_REQUEST');
    if (input.projectId !== this.source.projectId) return rejected('PROJECT_MISMATCH');
    return this.enqueueGraphOperation(async () => {
      this.pruneManualTextEditCapabilities();
      const capability = this.manualTextEditCapabilities.get(input.capabilityId);
      if (capability === undefined) return rejected('CAPABILITY_UNAVAILABLE');
      if (capability.projectId !== this.source.projectId) return rejected('PROJECT_MISMATCH');
      if (
        capability.revisionId !== this.source.revision.id &&
        capability.consumedContent === undefined
      )
        return rejected('STALE_SELECTION');
      if (capability.consumedContent !== undefined && capability.consumedContent !== input.content)
        return rejected('CAPABILITY_CONSUMED');
      const command = capability.proposal.commands[0];
      if (command?.kind !== 'set-content') return rejected('CAPABILITY_UNAVAILABLE');
      if (capability.consumedContent === undefined) capability.consumedContent = input.content;
      const proposal = Object.freeze({
        ...capability.proposal,
        commands: Object.freeze([Object.freeze({ ...command, content: input.content })])
      });
      if (proposal.base.projectId !== this.source.projectId) return rejected('PROJECT_MISMATCH');
      return this.evaluateManualProposal(proposal, 'set-content');
    });
  }

  /** Mints a narrow grant for the layout controls exposed by the visual inspector. */
  public async requestManualLayoutEditCapability(
    value: unknown
  ): Promise<ManualLayoutEditCapability | ManualLayoutEditUnavailable> {
    const unavailable = (
      code: ManualLayoutEditUnavailable['code']
    ): ManualLayoutEditUnavailable => ({ kind: 'unavailable', code });
    const input = this.manualTextCapabilityRequest(value);
    if (input === undefined) return unavailable('MAPPED_LAYOUT_UNAVAILABLE');
    if (input.projectId !== this.source.projectId) return unavailable('PROJECT_MISMATCH');
    if (input.revisionId !== this.source.revision.id) return unavailable('STALE_SELECTION');
    return this.enqueueGraphOperation(async () => {
      if (input.projectId !== this.source.projectId) return unavailable('PROJECT_MISMATCH');
      if (input.revisionId !== this.source.revision.id) return unavailable('STALE_SELECTION');
      const prepared = this.manualLayoutProposal(input.nodeId);
      if (prepared === undefined) return unavailable('MAPPED_LAYOUT_UNAVAILABLE');
      const capabilityId = `manual-layout-${randomUUID()}`;
      const expiresAt = Date.now() + 5 * 60_000;
      this.manualLayoutEditCapabilities.set(capabilityId, {
        projectId: this.source.projectId,
        nodeId: input.nodeId,
        revisionId: this.source.revision.id,
        expiresAt,
        proposal: prepared.proposal
      });
      this.pruneManualLayoutEditCapabilities();
      return Object.freeze({
        kind: 'available' as const,
        capabilityId,
        nodeId: input.nodeId,
        revisionId: this.source.revision.id,
        properties: MANUAL_LAYOUT_PROPERTIES,
        currentValues: prepared.currentValues,
        expiresAt: new Date(expiresAt).toISOString()
      });
    });
  }

  /** Applies one source-backed layout value through the same atomic compiler transaction as AI. */
  public async applyManualLayoutEdit(value: unknown): Promise<DesignEditResult> {
    const rejected = (code: string): DesignEditResult => ({
      format: 'selene-design-edit-result/v1',
      kind: 'rejected',
      diagnostics: [{ code }]
    });
    const input = this.manualLayoutApplyRequest(value);
    if (input === undefined) return rejected('INVALID_REQUEST');
    if (input.projectId !== this.source.projectId) return rejected('PROJECT_MISMATCH');
    return this.enqueueGraphOperation(async () => {
      this.pruneManualLayoutEditCapabilities();
      const capability = this.manualLayoutEditCapabilities.get(input.capabilityId);
      if (capability === undefined) return rejected('CAPABILITY_UNAVAILABLE');
      if (capability.projectId !== this.source.projectId) return rejected('PROJECT_MISMATCH');
      if (
        capability.revisionId !== this.source.revision.id &&
        capability.consumedEdit === undefined
      )
        return rejected('STALE_SELECTION');
      const fingerprint = `${input.property}\u0000${String(input.value)}`;
      if (capability.consumedEdit !== undefined && capability.consumedEdit !== fingerprint)
        return rejected('CAPABILITY_CONSUMED');
      const command = capability.proposal.commands[0];
      if (command?.kind !== 'set-layout') return rejected('CAPABILITY_UNAVAILABLE');
      if (capability.consumedEdit === undefined) capability.consumedEdit = fingerprint;
      const proposal = Object.freeze({
        ...capability.proposal,
        commands: Object.freeze([
          Object.freeze({ ...command, property: input.property, value: input.value })
        ])
      });
      return this.evaluateManualProposal(proposal, 'set-layout');
    });
  }

  /** Mints a narrow grant for approved color, type, radius, opacity, and spacing controls. */
  public async requestManualAppearanceEditCapability(
    value: unknown
  ): Promise<ManualAppearanceEditCapability | ManualAppearanceEditUnavailable> {
    const unavailable = (
      code: ManualAppearanceEditUnavailable['code']
    ): ManualAppearanceEditUnavailable => ({ kind: 'unavailable', code });
    const input = this.manualTextCapabilityRequest(value);
    if (input === undefined) return unavailable('MAPPED_APPEARANCE_UNAVAILABLE');
    if (input.projectId !== this.source.projectId) return unavailable('PROJECT_MISMATCH');
    if (input.revisionId !== this.source.revision.id) return unavailable('STALE_SELECTION');
    return this.enqueueGraphOperation(async () => {
      if (input.projectId !== this.source.projectId) return unavailable('PROJECT_MISMATCH');
      if (input.revisionId !== this.source.revision.id) return unavailable('STALE_SELECTION');
      const prepared = this.manualAppearanceProposal(input.nodeId);
      if (prepared === undefined) return unavailable('MAPPED_APPEARANCE_UNAVAILABLE');
      const capabilityId = `manual-appearance-${randomUUID()}`;
      const expiresAt = Date.now() + 5 * 60_000;
      this.manualAppearanceEditCapabilities.set(capabilityId, {
        projectId: this.source.projectId,
        nodeId: input.nodeId,
        revisionId: this.source.revision.id,
        expiresAt,
        proposal: prepared.proposal
      });
      this.pruneManualAppearanceEditCapabilities();
      return Object.freeze({
        kind: 'available' as const,
        capabilityId,
        nodeId: input.nodeId,
        revisionId: this.source.revision.id,
        properties: MANUAL_APPEARANCE_PROPERTIES,
        currentValues: prepared.currentValues,
        expiresAt: new Date(expiresAt).toISOString()
      });
    });
  }

  /** Applies one approved visual value through the same atomic compiler transaction as AI. */
  public async applyManualAppearanceEdit(value: unknown): Promise<DesignEditResult> {
    const rejected = (code: string): DesignEditResult => ({
      format: 'selene-design-edit-result/v1',
      kind: 'rejected',
      diagnostics: [{ code }]
    });
    const input = this.manualAppearanceApplyRequest(value);
    if (input === undefined) return rejected('INVALID_REQUEST');
    if (input.projectId !== this.source.projectId) return rejected('PROJECT_MISMATCH');
    return this.enqueueGraphOperation(async () => {
      this.pruneManualAppearanceEditCapabilities();
      const capability = this.manualAppearanceEditCapabilities.get(input.capabilityId);
      if (capability === undefined) return rejected('CAPABILITY_UNAVAILABLE');
      if (capability.projectId !== this.source.projectId) return rejected('PROJECT_MISMATCH');
      if (
        capability.revisionId !== this.source.revision.id &&
        capability.consumedEdit === undefined
      )
        return rejected('STALE_SELECTION');
      const fingerprint = `${input.property}\u0000${String(input.value)}`;
      if (capability.consumedEdit !== undefined && capability.consumedEdit !== fingerprint)
        return rejected('CAPABILITY_CONSUMED');
      const command = capability.proposal.commands[0];
      if (command?.kind !== 'set-style') return rejected('CAPABILITY_UNAVAILABLE');
      const proposal = Object.freeze({
        ...capability.proposal,
        commands: Object.freeze([
          Object.freeze({ ...command, property: input.property, value: input.value })
        ])
      });
      const result = await this.evaluateManualProposal(proposal, 'set-style');
      if (result.kind === 'applied' || result.kind === 'replayed')
        capability.consumedEdit = fingerprint;
      return result;
    });
  }

  /** Mints a position-only grant; it never creates a positioning model for an element. */
  public async requestManualPositionEditCapability(
    value: unknown
  ): Promise<ManualPositionEditCapability | ManualPositionEditUnavailable> {
    const unavailable = (
      code: ManualPositionEditUnavailable['code']
    ): ManualPositionEditUnavailable => ({ kind: 'unavailable', code });
    const input = this.manualTextCapabilityRequest(value);
    if (input === undefined) return unavailable('MAPPED_POSITION_UNAVAILABLE');
    if (input.projectId !== this.source.projectId) return unavailable('PROJECT_MISMATCH');
    if (input.revisionId !== this.source.revision.id) return unavailable('STALE_SELECTION');
    return this.enqueueGraphOperation(async () => {
      if (input.projectId !== this.source.projectId) return unavailable('PROJECT_MISMATCH');
      if (input.revisionId !== this.source.revision.id) return unavailable('STALE_SELECTION');
      const prepared = this.manualPositionProposal(input.nodeId);
      if (prepared === undefined) return unavailable('MAPPED_POSITION_UNAVAILABLE');
      const capabilityId = `manual-position-${randomUUID()}`;
      const expiresAt = Date.now() + 5 * 60_000;
      this.manualPositionEditCapabilities.set(capabilityId, {
        projectId: this.source.projectId,
        nodeId: input.nodeId,
        revisionId: this.source.revision.id,
        expiresAt,
        proposal: prepared.proposal
      });
      this.pruneManualPositionEditCapabilities();
      return Object.freeze({
        kind: 'available' as const,
        capabilityId,
        nodeId: input.nodeId,
        revisionId: this.source.revision.id,
        position: prepared.currentValues.position,
        currentValues: Object.freeze({
          left: prepared.currentValues.left,
          top: prepared.currentValues.top
        }),
        expiresAt: new Date(expiresAt).toISOString()
      });
    });
  }

  /** Applies both authored coordinates together through the atomic source transaction. */
  public async applyManualPositionEdit(value: unknown): Promise<DesignEditResult> {
    const rejected = (code: string): DesignEditResult => ({
      format: 'selene-design-edit-result/v1',
      kind: 'rejected',
      diagnostics: [{ code }]
    });
    const input = this.manualPositionApplyRequest(value);
    if (input === undefined) return rejected('INVALID_REQUEST');
    if (input.projectId !== this.source.projectId) return rejected('PROJECT_MISMATCH');
    return this.enqueueGraphOperation(async () => {
      this.pruneManualPositionEditCapabilities();
      const capability = this.manualPositionEditCapabilities.get(input.capabilityId);
      if (capability === undefined) return rejected('CAPABILITY_UNAVAILABLE');
      if (capability.projectId !== this.source.projectId) return rejected('PROJECT_MISMATCH');
      if (
        capability.revisionId !== this.source.revision.id &&
        capability.consumedEdit === undefined
      )
        return rejected('STALE_SELECTION');
      const fingerprint = `${input.left}\u0000${input.top}`;
      if (capability.consumedEdit !== undefined && capability.consumedEdit !== fingerprint)
        return rejected('CAPABILITY_CONSUMED');
      const [left, top] = capability.proposal.commands;
      if (
        left?.kind !== 'set-style' ||
        top?.kind !== 'set-style' ||
        left.property !== 'left' ||
        top.property !== 'top'
      )
        return rejected('CAPABILITY_UNAVAILABLE');
      const proposal = Object.freeze({
        ...capability.proposal,
        commands: Object.freeze([
          Object.freeze({ ...left, value: input.left }),
          Object.freeze({ ...top, value: input.top })
        ])
      });
      const result = await this.evaluateManualProposal(proposal, 'set-style');
      if (result.kind === 'applied' || result.kind === 'replayed')
        capability.consumedEdit = fingerprint;
      return result;
    });
  }

  /** Mints a host-derived semantic sibling insertion or compatible-parent move. */
  public async requestManualStructureEditCapability(
    value: unknown
  ): Promise<ManualStructureEditCapability | ManualStructureEditUnavailable> {
    const unavailable = (
      code: ManualStructureEditUnavailable['code']
    ): ManualStructureEditUnavailable => ({ kind: 'unavailable', code });
    const input = this.manualStructureCapabilityRequest(value);
    if (input === undefined) return unavailable('MAPPED_STRUCTURE_UNAVAILABLE');
    if (input.projectId !== this.source.projectId) return unavailable('PROJECT_MISMATCH');
    if (input.revisionId !== this.source.revision.id) return unavailable('STALE_SELECTION');
    return this.enqueueGraphOperation(async () => {
      if (input.projectId !== this.source.projectId) return unavailable('PROJECT_MISMATCH');
      if (input.revisionId !== this.source.revision.id) return unavailable('STALE_SELECTION');
      const prepared = this.manualStructureProposal(input.nodeId, input.targetNodeId);
      if (typeof prepared === 'string') return unavailable(prepared);
      const capabilityId = `manual-structure-${randomUUID()}`;
      const expiresAt = Date.now() + 5 * 60_000;
      this.manualStructureEditCapabilities.set(capabilityId, {
        projectId: this.source.projectId,
        nodeId: input.nodeId,
        revisionId: this.source.revision.id,
        targetNodeId: input.targetNodeId,
        operation: prepared.operation,
        proposal: prepared.proposal,
        expiresAt
      });
      this.pruneManualStructureEditCapabilities();
      return Object.freeze({
        kind: 'available' as const,
        capabilityId,
        nodeId: input.nodeId,
        revisionId: this.source.revision.id,
        targetNodeId: input.targetNodeId,
        operation: prepared.operation,
        expiresAt: new Date(expiresAt).toISOString()
      });
    });
  }

  /** Applies exactly the host-issued semantic source edit and nothing from the iframe. */
  public async applyManualStructureEdit(value: unknown): Promise<DesignEditResult> {
    const rejected = (code: string): DesignEditResult => ({
      format: 'selene-design-edit-result/v1',
      kind: 'rejected',
      diagnostics: [{ code }]
    });
    const input = this.manualStructureApplyRequest(value);
    if (input === undefined) return rejected('INVALID_REQUEST');
    if (input.projectId !== this.source.projectId) return rejected('PROJECT_MISMATCH');
    return this.enqueueGraphOperation(async () => {
      this.pruneManualStructureEditCapabilities();
      const capability = this.manualStructureEditCapabilities.get(input.capabilityId);
      if (capability === undefined) return rejected('CAPABILITY_UNAVAILABLE');
      if (capability.projectId !== this.source.projectId) return rejected('PROJECT_MISMATCH');
      if (capability.revisionId !== this.source.revision.id && !capability.consumed)
        return rejected('STALE_SELECTION');
      if (capability.consumed) return rejected('CAPABILITY_CONSUMED');
      capability.consumed = true;
      return this.evaluateManualProposal(
        capability.proposal,
        capability.proposal.commands[0]!.kind
      );
    });
  }

  /**
   * Creates one opaque, revision-bound capability for inserting an approved
   * design-system component into an exact mapped React container. The caller
   * supplies the renderer-safe catalog identity; the host resolves it against
   * the enabled receipt and owns the operation target and new source anchor.
   */
  public async requestDesignSystemComponentInsertCapability(
    value: unknown
  ): Promise<DesignSystemComponentInsertCapability | DesignSystemComponentInsertUnavailable> {
    const unavailable = (
      code: DesignSystemComponentInsertUnavailable['code']
    ): DesignSystemComponentInsertUnavailable => ({ kind: 'unavailable', code });
    const input = this.designSystemComponentInsertCapabilityRequest(value);
    if (input === undefined) return unavailable('MANUAL_EDIT_UNAVAILABLE');
    if (input.projectId !== this.source.projectId) return unavailable('PROJECT_MISMATCH');
    if (input.revisionId !== this.source.revision.id) return unavailable('STALE_SELECTION');
    return this.enqueueGraphOperation(async () => {
      if (input.projectId !== this.source.projectId) return unavailable('PROJECT_MISMATCH');
      if (input.revisionId !== this.source.revision.id) return unavailable('STALE_SELECTION');
      const prepared = this.designSystemComponentInsertProposal(
        input.nodeId,
        input.component,
        input.props
      );
      if (prepared === 'component-unavailable') return unavailable('COMPONENT_NOT_APPROVED');
      if (prepared === 'configuration-unavailable')
        return unavailable('COMPONENT_CONFIGURATION_INVALID');
      if (prepared === undefined) return unavailable('MAPPED_INSERTION_UNAVAILABLE');
      const capabilityId = `design-system-insert-${randomUUID()}`;
      const expiresAt = Date.now() + 5 * 60_000;
      this.designSystemComponentInsertCapabilities.set(capabilityId, {
        projectId: this.source.projectId,
        nodeId: input.nodeId,
        revisionId: this.source.revision.id,
        expiresAt,
        proposal: prepared
      });
      this.pruneDesignSystemComponentInsertCapabilities();
      return Object.freeze({
        kind: 'available' as const,
        capabilityId,
        nodeId: input.nodeId,
        revisionId: this.source.revision.id,
        component: input.component,
        expiresAt: new Date(expiresAt).toISOString()
      });
    });
  }

  /** Applies only the source insertion frozen into a host-issued capability. */
  public async applyDesignSystemComponentInsert(value: unknown): Promise<DesignEditResult> {
    const rejected = (code: string): DesignEditResult => ({
      format: 'selene-design-edit-result/v1',
      kind: 'rejected',
      diagnostics: [{ code }]
    });
    const input = this.designSystemComponentInsertApplyRequest(value);
    if (input === undefined) return rejected('INVALID_REQUEST');
    if (input.projectId !== this.source.projectId) return rejected('PROJECT_MISMATCH');
    return this.enqueueGraphOperation(async () => {
      this.pruneDesignSystemComponentInsertCapabilities();
      const capability = this.designSystemComponentInsertCapabilities.get(input.capabilityId);
      if (capability === undefined) return rejected('CAPABILITY_UNAVAILABLE');
      if (capability.projectId !== this.source.projectId) return rejected('PROJECT_MISMATCH');
      if (capability.revisionId !== this.source.revision.id && !capability.consumed)
        return rejected('STALE_SELECTION');
      if (capability.consumed) return rejected('CAPABILITY_CONSUMED');
      if (
        capability.proposal.commands.length !== 1 ||
        capability.proposal.commands[0]?.kind !== 'insert-child'
      )
        return rejected('CAPABILITY_UNAVAILABLE');
      const result = await this.evaluateManualProposal(capability.proposal, 'insert-child');
      if (result.kind === 'applied' || result.kind === 'replayed') capability.consumed = true;
      return result;
    });
  }

  /** Issues one exact revision-fenced replacement from the approved catalog. */
  public async requestDesignSystemComponentReplaceCapability(
    value: unknown
  ): Promise<DesignSystemComponentReplaceCapability | DesignSystemComponentReplaceUnavailable> {
    const unavailable = (
      code: DesignSystemComponentReplaceUnavailable['code']
    ): DesignSystemComponentReplaceUnavailable => ({ kind: 'unavailable', code });
    const input = this.designSystemComponentInsertCapabilityRequest(value);
    if (input === undefined) return unavailable('MANUAL_EDIT_UNAVAILABLE');
    if (input.projectId !== this.source.projectId) return unavailable('PROJECT_MISMATCH');
    if (input.revisionId !== this.source.revision.id) return unavailable('STALE_SELECTION');
    return this.enqueueGraphOperation(async () => {
      if (input.projectId !== this.source.projectId) return unavailable('PROJECT_MISMATCH');
      if (input.revisionId !== this.source.revision.id) return unavailable('STALE_SELECTION');
      const prepared = this.designSystemComponentReplaceProposal(
        input.nodeId,
        input.component,
        input.props
      );
      if (prepared === 'component-unavailable') return unavailable('COMPONENT_NOT_APPROVED');
      if (prepared === 'configuration-unavailable')
        return unavailable('COMPONENT_CONFIGURATION_INVALID');
      if (prepared === undefined) return unavailable('MAPPED_REPLACEMENT_UNAVAILABLE');
      const capabilityId = `design-system-replace-${randomUUID()}`;
      const expiresAt = Date.now() + 5 * 60_000;
      this.designSystemComponentReplaceCapabilities.set(capabilityId, {
        projectId: this.source.projectId,
        nodeId: input.nodeId,
        revisionId: this.source.revision.id,
        expiresAt,
        proposal: prepared
      });
      this.pruneDesignSystemComponentReplaceCapabilities();
      return Object.freeze({
        kind: 'available' as const,
        capabilityId,
        nodeId: input.nodeId,
        revisionId: this.source.revision.id,
        component: input.component,
        expiresAt: new Date(expiresAt).toISOString()
      });
    });
  }

  /** Applies only the exact replacement frozen into a host-issued capability. */
  public async applyDesignSystemComponentReplace(value: unknown): Promise<DesignEditResult> {
    const rejected = (code: string): DesignEditResult => ({
      format: 'selene-design-edit-result/v1',
      kind: 'rejected',
      diagnostics: [{ code }]
    });
    const input = this.designSystemComponentReplaceApplyRequest(value);
    if (input === undefined) return rejected('INVALID_REQUEST');
    if (input.projectId !== this.source.projectId) return rejected('PROJECT_MISMATCH');
    return this.enqueueGraphOperation(async () => {
      this.pruneDesignSystemComponentReplaceCapabilities();
      const capability = this.designSystemComponentReplaceCapabilities.get(input.capabilityId);
      if (capability === undefined) return rejected('CAPABILITY_UNAVAILABLE');
      if (capability.projectId !== this.source.projectId) return rejected('PROJECT_MISMATCH');
      if (capability.revisionId !== this.source.revision.id && !capability.consumed)
        return rejected('STALE_SELECTION');
      if (capability.consumed) return rejected('CAPABILITY_CONSUMED');
      if (
        capability.proposal.commands.length !== 1 ||
        capability.proposal.commands[0]?.kind !== 'replace-component'
      )
        return rejected('CAPABILITY_UNAVAILABLE');
      const result = await this.evaluateManualProposal(capability.proposal, 'replace-component');
      if (result.kind === 'applied' || result.kind === 'replayed') capability.consumed = true;
      return result;
    });
  }

  private async evaluateManualProposal(
    proposal: DesignEditProposal,
    commandKind: DesignEditProposal['commands'][number]['kind']
  ): Promise<DesignEditResult> {
    const rejected = (code: string): DesignEditResult => ({
      format: 'selene-design-edit-result/v1',
      kind: 'rejected',
      diagnostics: [{ code }]
    });
    if (this.pendingAIProposal !== undefined) return rejected('AI_PROPOSAL_REVIEW_REQUIRED');
    try {
      const context = {
        workspace: this.source,
        designSystemLockDigest: digest(this.designInputProvenance),
        approvedComponents: Object.freeze(
          (
            this.designInputProvenance.designSystems ??
            (this.designInputProvenance.designSystem === undefined
              ? []
              : [
                  {
                    id: this.designInputProvenance.designSystem.artifactDigest,
                    enabled: true,
                    receipt: this.designInputProvenance.designSystem
                  }
                ])
          ).flatMap((input) =>
            !input.enabled || input.receipt.catalog === undefined
              ? []
              : input.receipt.catalog.components.map((component) =>
                  Object.freeze({
                    packageName: input.receipt.packageName,
                    entrypoint: component.entrypoint,
                    exportName: component.exportName,
                    version: input.receipt.version,
                    artifactDigest: input.receipt.artifactDigest
                  })
                )
          )
        ),
        ...(this.manualReactEditAuthority === undefined
          ? {}
          : { designRevision: this.manualReactEditAuthority.designRevision })
      };
      const detailed = this.manualEditTransaction.evaluateDetailed;
      const evaluation =
        detailed === undefined
          ? { result: await this.manualEditTransaction.evaluate(proposal, context) }
          : await detailed.call(this.manualEditTransaction, proposal, context);
      if (
        evaluation.adoption !== undefined &&
        (evaluation.result.kind === 'applied' || evaluation.result.kind === 'replayed')
      )
        this.adoptDurableManualEdit(
          evaluation.adoption.workspace,
          evaluation.adoption.designRevision,
          evaluation.adoption.journal,
          commandKind
        );
      return evaluation.result;
    } catch {
      return rejected('MANUAL_EDIT_AUTHORITY_UNAVAILABLE');
    }
  }

  private manualTextCapabilityRequest(
    value: unknown
  ): Readonly<{ projectId: string; nodeId: string; revisionId: string }> | undefined {
    const input = this.manualTextRequestRecord(value, ['projectId', 'nodeId', 'revisionId']);
    if (input === undefined) return undefined;
    try {
      return Object.freeze({
        projectId: validateDesignerIdentifier(input.projectId, 'projectId'),
        nodeId: validateDesignerIdentifier(input.nodeId, 'nodeId'),
        revisionId: validateDesignerIdentifier(input.revisionId, 'revisionId')
      });
    } catch {
      return undefined;
    }
  }

  private manualLayoutApplyRequest(value: unknown):
    | Readonly<{
        projectId: string;
        capabilityId: string;
        property: ManualLayoutProperty;
        value: ManualLayoutValue;
      }>
    | undefined {
    const input = this.manualTextRequestRecord(value, [
      'format',
      'projectId',
      'capabilityId',
      'property',
      'value'
    ]);
    const supportedProperty =
      typeof input?.property === 'string' &&
      MANUAL_LAYOUT_PROPERTIES.includes(input.property as ManualLayoutProperty);
    if (
      input === undefined ||
      input.format !== 'selene-desktop-manual-layout-edit-apply/v1' ||
      !supportedProperty ||
      !supportedManualLayoutValue(input.property as ManualLayoutProperty, input.value)
    )
      return undefined;
    try {
      return Object.freeze({
        projectId: validateDesignerIdentifier(input.projectId, 'projectId'),
        capabilityId: validateDesignerIdentifier(input.capabilityId, 'capabilityId'),
        property: input.property as ManualLayoutProperty,
        value: input.value as ManualLayoutValue
      });
    } catch {
      return undefined;
    }
  }

  private manualAppearanceApplyRequest(value: unknown):
    | Readonly<{
        projectId: string;
        capabilityId: string;
        property: ManualAppearanceProperty;
        value: ManualAppearanceValue;
      }>
    | undefined {
    const input = this.manualTextRequestRecord(value, [
      'format',
      'projectId',
      'capabilityId',
      'property',
      'value'
    ]);
    const supportedProperty =
      typeof input?.property === 'string' &&
      MANUAL_APPEARANCE_PROPERTIES.includes(input.property as ManualAppearanceProperty);
    if (
      input === undefined ||
      input.format !== 'selene-desktop-manual-appearance-edit-apply/v1' ||
      !supportedProperty ||
      !supportedManualAppearanceValue(input.property as ManualAppearanceProperty, input.value)
    )
      return undefined;
    try {
      return Object.freeze({
        projectId: validateDesignerIdentifier(input.projectId, 'projectId'),
        capabilityId: validateDesignerIdentifier(input.capabilityId, 'capabilityId'),
        property: input.property as ManualAppearanceProperty,
        value: input.value as ManualAppearanceValue
      });
    } catch {
      return undefined;
    }
  }

  private manualPositionApplyRequest(
    value: unknown
  ): Readonly<{ projectId: string; capabilityId: string; left: number; top: number }> | undefined {
    const input = this.manualTextRequestRecord(value, [
      'format',
      'projectId',
      'capabilityId',
      'left',
      'top'
    ]);
    if (
      input === undefined ||
      input.format !== 'selene-desktop-manual-position-edit-apply/v1' ||
      typeof input.left !== 'number' ||
      typeof input.top !== 'number' ||
      !Number.isFinite(input.left) ||
      !Number.isFinite(input.top) ||
      Math.abs(input.left) > 100_000 ||
      Math.abs(input.top) > 100_000
    )
      return undefined;
    try {
      return Object.freeze({
        projectId: validateDesignerIdentifier(input.projectId, 'projectId'),
        capabilityId: validateDesignerIdentifier(input.capabilityId, 'capabilityId'),
        left: Math.round(input.left * 100) / 100,
        top: Math.round(input.top * 100) / 100
      });
    } catch {
      return undefined;
    }
  }

  private manualStructureCapabilityRequest(
    value: unknown
  ):
    | Readonly<{ projectId: string; nodeId: string; revisionId: string; targetNodeId: string }>
    | undefined {
    const input = this.manualTextRequestRecord(value, [
      'projectId',
      'nodeId',
      'revisionId',
      'targetNodeId'
    ]);
    if (input === undefined) return undefined;
    try {
      return Object.freeze({
        projectId: validateDesignerIdentifier(input.projectId, 'projectId'),
        nodeId: validateDesignerIdentifier(input.nodeId, 'nodeId'),
        revisionId: validateDesignerIdentifier(input.revisionId, 'revisionId'),
        targetNodeId: validateDesignerIdentifier(input.targetNodeId, 'targetNodeId')
      });
    } catch {
      return undefined;
    }
  }

  private manualStructureApplyRequest(
    value: unknown
  ): Readonly<{ projectId: string; capabilityId: string }> | undefined {
    const input = this.manualTextRequestRecord(value, ['format', 'projectId', 'capabilityId']);
    if (input === undefined || input.format !== 'selene-desktop-manual-structure-edit-apply/v1')
      return undefined;
    try {
      return Object.freeze({
        projectId: validateDesignerIdentifier(input.projectId, 'projectId'),
        capabilityId: validateDesignerIdentifier(input.capabilityId, 'capabilityId')
      });
    } catch {
      return undefined;
    }
  }

  private manualTextApplyRequest(
    value: unknown
  ): Readonly<{ projectId: string; capabilityId: string; content: string }> | undefined {
    const input = this.manualTextRequestRecord(value, [
      'format',
      'projectId',
      'capabilityId',
      'content'
    ]);
    if (
      input === undefined ||
      input.format !== 'selene-desktop-manual-text-edit-apply/v1' ||
      typeof input.content !== 'string' ||
      input.content.length > 32_768
    )
      return undefined;
    try {
      return Object.freeze({
        projectId: validateDesignerIdentifier(input.projectId, 'projectId'),
        capabilityId: validateDesignerIdentifier(input.capabilityId, 'capabilityId'),
        content: input.content
      });
    } catch {
      return undefined;
    }
  }

  private designSystemComponentInsertCapabilityRequest(value: unknown):
    | Readonly<{
        projectId: string;
        nodeId: string;
        revisionId: string;
        component: {
          readonly packageName: string;
          readonly version: string;
          readonly entrypoint: string;
          readonly exportName: string;
          readonly artifactDigest: string;
        };
        props?: Readonly<Record<string, DesignSystemComponentPropertyValue>>;
      }>
    | undefined {
    const input = this.manualTextRequestRecord(
      value,
      ['projectId', 'nodeId', 'revisionId', 'component'],
      ['props']
    );
    const component =
      input === undefined
        ? undefined
        : this.manualTextRequestRecord(input.component, [
            'packageName',
            'version',
            'entrypoint',
            'exportName',
            'artifactDigest'
          ]);
    const hasProps = input !== undefined && Object.hasOwn(input, 'props');
    const props = hasProps ? this.designSystemComponentInsertProps(input.props) : undefined;
    if (
      input === undefined ||
      component === undefined ||
      (hasProps && props === undefined) ||
      typeof component.packageName !== 'string' ||
      typeof component.version !== 'string' ||
      typeof component.entrypoint !== 'string' ||
      typeof component.exportName !== 'string' ||
      typeof component.artifactDigest !== 'string' ||
      component.packageName.length > 256 ||
      component.version.length > 128 ||
      component.entrypoint.length > 258 ||
      component.exportName.length > 128 ||
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(component.packageName) ||
      !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
        component.version
      ) ||
      !/^(?:\.|\.\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)$/.test(component.entrypoint) ||
      !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(component.exportName) ||
      !/^[a-f0-9]{64}$/.test(component.artifactDigest)
    )
      return undefined;
    try {
      return Object.freeze({
        projectId: validateDesignerIdentifier(input.projectId, 'projectId'),
        nodeId: validateDesignerIdentifier(input.nodeId, 'nodeId'),
        revisionId: validateDesignerIdentifier(input.revisionId, 'revisionId'),
        component: Object.freeze({
          packageName: component.packageName,
          version: component.version,
          entrypoint: component.entrypoint,
          exportName: component.exportName,
          artifactDigest: component.artifactDigest
        }),
        ...(props === undefined ? {} : { props })
      });
    } catch {
      return undefined;
    }
  }

  private designSystemComponentInsertProps(
    value: unknown
  ): Readonly<Record<string, DesignSystemComponentPropertyValue>> | undefined {
    try {
      if (
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype
      )
        return undefined;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.length > 32 || keys.some((key) => typeof key !== 'string')) return undefined;
      const props: Record<string, DesignSystemComponentPropertyValue> = Object.create(null);
      for (const key of keys) {
        if (
          typeof key !== 'string' ||
          !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(key) ||
          /^(?:children|key|ref|dangerouslysetinnerhtml|data-selene-node-id)$/iu.test(key)
        )
          return undefined;
        const descriptor = descriptors[key];
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor))
          return undefined;
        const candidate = descriptor.value;
        if (typeof candidate === 'string') {
          if (candidate.length > 256) return undefined;
        } else if (typeof candidate === 'number') {
          if (!Number.isFinite(candidate) || Math.abs(candidate) > 1_000_000) return undefined;
        } else if (typeof candidate !== 'boolean') return undefined;
        props[key] = candidate;
      }
      return Object.freeze(props);
    } catch {
      return undefined;
    }
  }

  private designSystemComponentInsertApplyRequest(
    value: unknown
  ): Readonly<{ projectId: string; capabilityId: string }> | undefined {
    const input = this.manualTextRequestRecord(value, ['format', 'projectId', 'capabilityId']);
    if (
      input === undefined ||
      input.format !== 'selene-desktop-design-system-component-insert-apply/v1'
    )
      return undefined;
    try {
      return Object.freeze({
        projectId: validateDesignerIdentifier(input.projectId, 'projectId'),
        capabilityId: validateDesignerIdentifier(input.capabilityId, 'capabilityId')
      });
    } catch {
      return undefined;
    }
  }

  private designSystemComponentReplaceApplyRequest(
    value: unknown
  ): Readonly<{ projectId: string; capabilityId: string }> | undefined {
    const input = this.manualTextRequestRecord(value, ['format', 'projectId', 'capabilityId']);
    if (
      input === undefined ||
      input.format !== 'selene-desktop-design-system-component-replace-apply/v1'
    )
      return undefined;
    try {
      return Object.freeze({
        projectId: validateDesignerIdentifier(input.projectId, 'projectId'),
        capabilityId: validateDesignerIdentifier(input.capabilityId, 'capabilityId')
      });
    } catch {
      return undefined;
    }
  }

  private manualTextRequestRecord(
    value: unknown,
    requiredKeys: readonly string[],
    optionalKeys: readonly string[] = []
  ): Readonly<Record<string, unknown>> | undefined {
    try {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const actual = Reflect.ownKeys(descriptors);
      const allowed = new Set([...requiredKeys, ...optionalKeys]);
      if (
        requiredKeys.some((key) => !Object.hasOwn(descriptors, key)) ||
        actual.some((key) => typeof key !== 'string' || !allowed.has(key))
      )
        return undefined;
      const copy: Record<string, unknown> = Object.create(null);
      for (const key of actual) {
        if (typeof key !== 'string') return undefined;
        const descriptor = descriptors[key];
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor))
          return undefined;
        copy[key] = descriptor.value;
      }
      return Object.freeze(copy);
    } catch {
      return undefined;
    }
  }

  private manualTextProposal(
    nodeId: string
  ): Readonly<{ proposal: DesignEditProposal; currentContent: string }> | undefined {
    const context = this.manualMappedEditContext(nodeId);
    if (context === undefined) return undefined;
    const { source, element, revision, operationTarget } = context;
    if (!ts.isJsxElement(element)) return undefined;
    const child = element.children[0];
    if (element.children.length !== 1 || child === undefined || !ts.isJsxText(child))
      return undefined;
    const currentContent = child.getText(source);
    if (currentContent.length > 32_768) return undefined;
    const commandId = `manual-text-command-${randomUUID()}`;
    const proposal: DesignEditProposal = {
      format: 'selene-design-edit-proposal/v1',
      schemaVersion: 1,
      proposalId: `manual-text-proposal-${randomUUID()}`,
      commandId,
      actorId: this.collaborationAuthorId,
      origin: 'manual-canvas',
      operation: {
        format: 'selene-design-revision-operation-reference/v2',
        kind: 'edit',
        tenantId: revision.tenantId,
        projectId: revision.projectId,
        actorId: this.collaborationAuthorId,
        commandId,
        revisionId: revision.revisionId,
        tupleBinding: revision.tupleBinding,
        revisionCommitment: revision.revisionCommitment
      },
      base: revision,
      commands: [
        {
          kind: 'set-content',
          target: {
            format: 'selene-design-edit-target/v1',
            operation: operationTarget,
            sourceAnchorId: nodeId
          },
          content: currentContent
        }
      ],
      preconditions: [
        { kind: 'source-revision', sourceDigest: revision.tuple.sourceDigest },
        { kind: 'binding-revision', bindingDigest: revision.tuple.bindingDigest },
        {
          kind: 'design-system-lock',
          designSystemLockDigest: revision.tuple.designSystemLockDigest
        },
        { kind: 'node-exists', sourceAnchorId: nodeId }
      ],
      requestedAt: new Date().toISOString()
    };
    try {
      return Object.freeze({ proposal: parseDesignEditProposal(proposal), currentContent });
    } catch {
      return undefined;
    }
  }

  private resolvedDesignSystemComponentProps(
    properties: readonly DesignSystemComponentProperty[],
    requested: Readonly<Record<string, DesignSystemComponentPropertyValue>> | undefined
  ): Readonly<Record<string, DesignSystemComponentPropertyValue>> | undefined {
    const definitions = new Map(properties.map((property) => [property.name, property]));
    if (definitions.size !== properties.length) return undefined;
    if (requested !== undefined && Object.keys(requested).some((name) => !definitions.has(name)))
      return undefined;
    // Core's hostile-data parser accepts only an ordinary plain record. Values
    // are copied from the separately validated request and catalog definitions.
    const result: Record<string, DesignSystemComponentPropertyValue> = {};
    for (const property of properties) {
      if (
        !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(property.name) ||
        /^(?:children|key|ref|dangerouslysetinnerhtml|data-selene-node-id)$/iu.test(property.name)
      )
        return undefined;
      const value =
        requested !== undefined && Object.hasOwn(requested, property.name)
          ? requested[property.name]
          : property.defaultValue;
      if (value === undefined) {
        if (property.required) return undefined;
        continue;
      }
      const valid =
        property.control === 'boolean'
          ? typeof value === 'boolean'
          : property.control === 'number'
            ? typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000
            : property.control === 'text'
              ? typeof value === 'string' && value.length <= 256
              : property.control === 'select'
                ? property.values?.some((candidate) => Object.is(candidate, value)) === true
                : false;
      if (!valid) return undefined;
      result[property.name] = value;
    }
    return Object.freeze(result);
  }

  private resolvedApprovedDesignSystemComponent(
    requestedComponent: Readonly<{
      readonly packageName: string;
      readonly version: string;
      readonly entrypoint: string;
      readonly exportName: string;
      readonly artifactDigest: string;
    }>,
    requestedProps: Readonly<Record<string, DesignSystemComponentPropertyValue>> | undefined
  ):
    | Readonly<{
        component: {
          readonly packageName: string;
          readonly entrypoint: string;
          readonly exportName: string;
          readonly version: string;
          readonly artifactDigest: string;
        };
        props: Readonly<Record<string, DesignSystemComponentPropertyValue>>;
      }>
    | 'component-unavailable'
    | 'configuration-unavailable' {
    const approved = (
      this.designInputProvenance.designSystems ??
      (this.designInputProvenance.designSystem === undefined
        ? []
        : [
            {
              id: this.designInputProvenance.designSystem.artifactDigest,
              enabled: true,
              receipt: this.designInputProvenance.designSystem
            }
          ])
    ).flatMap((input) =>
      !input.enabled || input.receipt.catalog === undefined
        ? []
        : input.receipt.catalog.components.map((component) => ({
            packageName: input.receipt.packageName,
            entrypoint: component.entrypoint,
            exportName: component.exportName,
            version: input.receipt.version,
            artifactDigest: input.receipt.artifactDigest,
            properties: component.properties ?? Object.freeze([])
          }))
    );
    const components = approved.filter(
      (component) =>
        component.packageName === requestedComponent.packageName &&
        component.version === requestedComponent.version &&
        component.entrypoint === requestedComponent.entrypoint &&
        component.exportName === requestedComponent.exportName &&
        component.artifactDigest === requestedComponent.artifactDigest
    );
    if (components.length !== 1 || components[0] === undefined) return 'component-unavailable';
    const { properties, ...component } = components[0];
    const props = this.resolvedDesignSystemComponentProps(properties, requestedProps);
    return props === undefined
      ? 'configuration-unavailable'
      : Object.freeze({ component: Object.freeze(component), props });
  }

  private designSystemComponentInsertProposal(
    nodeId: string,
    requestedComponent: Readonly<{
      readonly packageName: string;
      readonly version: string;
      readonly entrypoint: string;
      readonly exportName: string;
      readonly artifactDigest: string;
    }>,
    requestedProps: Readonly<Record<string, DesignSystemComponentPropertyValue>> | undefined
  ): DesignEditProposal | 'component-unavailable' | 'configuration-unavailable' | undefined {
    const context = this.manualMappedEditContext(nodeId);
    if (context === undefined) return undefined;
    if (!ts.isJsxElement(context.element)) return undefined;
    const display = currentManualLayoutValues(context.element)?.display;
    if (display !== 'flex' && display !== 'grid') return undefined;
    const resolved = this.resolvedApprovedDesignSystemComponent(requestedComponent, requestedProps);
    if (typeof resolved === 'string') return resolved;
    const { component, props } = resolved;
    const { revision, operationTarget } = context;
    const commandId = `design-system-insert-command-${randomUUID()}`;
    const proposal: DesignEditProposal = {
      format: 'selene-design-edit-proposal/v1',
      schemaVersion: 1,
      proposalId: `design-system-insert-proposal-${randomUUID()}`,
      commandId,
      actorId: this.collaborationAuthorId,
      origin: 'manual-canvas',
      operation: {
        format: 'selene-design-revision-operation-reference/v2',
        kind: 'edit',
        tenantId: revision.tenantId,
        projectId: revision.projectId,
        actorId: this.collaborationAuthorId,
        commandId,
        revisionId: revision.revisionId,
        tupleBinding: revision.tupleBinding,
        revisionCommitment: revision.revisionCommitment
      },
      base: revision,
      commands: [
        {
          kind: 'insert-child',
          target: {
            format: 'selene-design-edit-target/v1',
            operation: operationTarget,
            sourceAnchorId: nodeId
          },
          component,
          ...(Object.keys(props).length === 0 ? {} : { props }),
          newSourceAnchorId: `design-system-component-${randomUUID()}`,
          position: 'last'
        }
      ],
      preconditions: [
        { kind: 'source-revision', sourceDigest: revision.tuple.sourceDigest },
        { kind: 'binding-revision', bindingDigest: revision.tuple.bindingDigest },
        {
          kind: 'design-system-lock',
          designSystemLockDigest: revision.tuple.designSystemLockDigest
        },
        { kind: 'node-exists', sourceAnchorId: nodeId }
      ],
      requestedAt: new Date().toISOString()
    };
    try {
      return parseDesignEditProposal(proposal);
    } catch {
      return undefined;
    }
  }

  private designSystemComponentReplaceProposal(
    nodeId: string,
    requestedComponent: Readonly<{
      readonly packageName: string;
      readonly version: string;
      readonly entrypoint: string;
      readonly exportName: string;
      readonly artifactDigest: string;
    }>,
    requestedProps: Readonly<Record<string, DesignSystemComponentPropertyValue>> | undefined
  ): DesignEditProposal | 'component-unavailable' | 'configuration-unavailable' | undefined {
    const context = this.manualMappedEditContext(nodeId);
    if (context === undefined) return undefined;
    const resolved = this.resolvedApprovedDesignSystemComponent(requestedComponent, requestedProps);
    if (typeof resolved === 'string') return resolved;
    const { component, props } = resolved;
    const { revision, operationTarget } = context;
    const commandId = `design-system-replace-command-${randomUUID()}`;
    const proposal: DesignEditProposal = {
      format: 'selene-design-edit-proposal/v1',
      schemaVersion: 1,
      proposalId: `design-system-replace-proposal-${randomUUID()}`,
      commandId,
      actorId: this.collaborationAuthorId,
      origin: 'manual-canvas',
      operation: {
        format: 'selene-design-revision-operation-reference/v2',
        kind: 'edit',
        tenantId: revision.tenantId,
        projectId: revision.projectId,
        actorId: this.collaborationAuthorId,
        commandId,
        revisionId: revision.revisionId,
        tupleBinding: revision.tupleBinding,
        revisionCommitment: revision.revisionCommitment
      },
      base: revision,
      commands: [
        {
          kind: 'replace-component',
          target: {
            format: 'selene-design-edit-target/v1',
            operation: operationTarget,
            sourceAnchorId: nodeId
          },
          component,
          ...(Object.keys(props).length === 0 ? {} : { props })
        }
      ],
      preconditions: [
        { kind: 'source-revision', sourceDigest: revision.tuple.sourceDigest },
        { kind: 'binding-revision', bindingDigest: revision.tuple.bindingDigest },
        {
          kind: 'design-system-lock',
          designSystemLockDigest: revision.tuple.designSystemLockDigest
        },
        { kind: 'node-exists', sourceAnchorId: nodeId }
      ],
      requestedAt: new Date().toISOString()
    };
    try {
      return parseDesignEditProposal(proposal);
    } catch {
      return undefined;
    }
  }

  private manualMappedEditContext(nodeId: string) {
    const authority = this.manualReactEditAuthority;
    const node = this.source.nodes.find((candidate) => candidate.nodeId === nodeId);
    if (
      authority === undefined ||
      authority.workspaceRevisionId !== this.source.revision.id ||
      authority.designRevision.revisionId !== this.source.revision.id ||
      node === undefined
    )
      return undefined;
    const files = this.source.files.filter(
      (file) => file.path === node.path && file.language === 'tsx'
    );
    if (files.length !== 1 || node.exportName !== 'default') return undefined;
    const file = files[0]!;
    const source = ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    if (
      (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics
        ?.length
    )
      return undefined;
    const scopes = source.statements.filter(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) &&
        statement.body !== undefined &&
        statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ===
          true &&
        statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
          true
    );
    if (scopes.length !== 1) return undefined;
    const matching: (ts.JsxElement | ts.JsxSelfClosingElement)[] = [];
    const visit = (candidate: ts.Node): void => {
      const opening = ts.isJsxElement(candidate)
        ? candidate.openingElement
        : ts.isJsxSelfClosingElement(candidate)
          ? candidate
          : undefined;
      if (
        opening?.attributes.properties.some(
          (attribute) =>
            ts.isJsxAttribute(attribute) &&
            ts.isIdentifier(attribute.name) &&
            attribute.name.text === 'data-selene-node-id' &&
            attribute.initializer !== undefined &&
            ((ts.isStringLiteral(attribute.initializer) && attribute.initializer.text === nodeId) ||
              (ts.isJsxExpression(attribute.initializer) &&
                attribute.initializer.expression !== undefined &&
                ts.isStringLiteral(attribute.initializer.expression) &&
                attribute.initializer.expression.text === nodeId))
        ) === true
      )
        matching.push(candidate as ts.JsxElement | ts.JsxSelfClosingElement);
      ts.forEachChild(candidate, visit);
    };
    visit(scopes[0]!);
    const element = matching[0];
    if (matching.length !== 1 || element === undefined) return undefined;
    const revision = authority.designRevision;
    const sourceIdentity = {
      format: 'selene-compiler-source-identity/v1' as const,
      moduleId: `selene-compiler:${createHash('sha256')
        .update(`${node.path}\u0000${node.exportName}`)
        .digest('hex')
        .slice(0, 32)}`,
      exportName: node.exportName,
      astNodeId: nodeId,
      sourceDigest: revision.tuple.sourceDigest,
      bindingDigest: revision.tuple.bindingDigest
    };
    const instance = {
      format: 'selene-compiler-rendered-instance-identity/v1' as const,
      instanceId: `manual-text-instance-${nodeId}`,
      ancestry: [nodeId],
      repeat: { kind: 'singleton' as const }
    };
    const operationTarget = {
      format: 'selene-design-revision-operation-target/v2' as const,
      tenantId: revision.tenantId,
      projectId: revision.projectId,
      revisionId: revision.revisionId,
      tupleBinding: revision.tupleBinding,
      revisionCommitment: revision.revisionCommitment,
      node: {
        format: 'selene-compiler-node-identity/v2' as const,
        projectId: revision.projectId,
        nodeId,
        compilerDigest: revision.tuple.compiler.compilerDigest,
        source: sourceIdentity,
        instance: {
          ...instance,
          instanceDigest: createCompilerRenderedInstanceDigest(revision, sourceIdentity, instance)
        }
      }
    };
    return Object.freeze({ source, element, revision, operationTarget });
  }

  /** Source-proven catalog target; computed preview CSS is never insertion authority. */
  private selectedCatalogInsertTarget():
    Readonly<{ nodeId: string; layout: 'flex' | 'grid' }> | undefined {
    if (this.selectedNodeId === undefined) return undefined;
    const context = this.manualMappedEditContext(this.selectedNodeId);
    if (context === undefined) return undefined;
    if (!ts.isJsxElement(context.element)) return undefined;
    const display = currentManualLayoutValues(context.element)?.display;
    return display === 'flex' || display === 'grid'
      ? Object.freeze({ nodeId: this.selectedNodeId, layout: display })
      : undefined;
  }

  private selectedCatalogReplaceTarget(): Readonly<{ nodeId: string }> | undefined {
    if (this.selectedNodeId === undefined) return undefined;
    return this.manualMappedEditContext(this.selectedNodeId) === undefined
      ? undefined
      : Object.freeze({ nodeId: this.selectedNodeId });
  }

  private manualLayoutProposal(nodeId: string):
    | Readonly<{
        proposal: DesignEditProposal;
        currentValues: Readonly<Partial<Record<ManualLayoutProperty, ManualLayoutValue>>>;
      }>
    | undefined {
    const context = this.manualMappedEditContext(nodeId);
    if (context === undefined) return undefined;
    const { revision, operationTarget, element } = context;
    if (!ts.isJsxElement(element)) return undefined;
    const currentValues = currentManualLayoutValues(element);
    if (currentValues === undefined) return undefined;
    const commandId = `manual-layout-command-${randomUUID()}`;
    const proposal: DesignEditProposal = {
      format: 'selene-design-edit-proposal/v1',
      schemaVersion: 1,
      proposalId: `manual-layout-proposal-${randomUUID()}`,
      commandId,
      actorId: this.collaborationAuthorId,
      origin: 'manual-canvas',
      operation: {
        format: 'selene-design-revision-operation-reference/v2',
        kind: 'edit',
        tenantId: revision.tenantId,
        projectId: revision.projectId,
        actorId: this.collaborationAuthorId,
        commandId,
        revisionId: revision.revisionId,
        tupleBinding: revision.tupleBinding,
        revisionCommitment: revision.revisionCommitment
      },
      base: revision,
      commands: [
        {
          kind: 'set-layout',
          target: {
            format: 'selene-design-edit-target/v1',
            operation: operationTarget,
            sourceAnchorId: nodeId
          },
          property: 'width',
          value: 'auto'
        }
      ],
      preconditions: [
        { kind: 'source-revision', sourceDigest: revision.tuple.sourceDigest },
        { kind: 'binding-revision', bindingDigest: revision.tuple.bindingDigest },
        {
          kind: 'design-system-lock',
          designSystemLockDigest: revision.tuple.designSystemLockDigest
        },
        { kind: 'node-exists', sourceAnchorId: nodeId }
      ],
      requestedAt: new Date().toISOString()
    };
    try {
      return Object.freeze({
        proposal: parseDesignEditProposal(proposal),
        currentValues
      });
    } catch {
      return undefined;
    }
  }

  private manualAppearanceProposal(nodeId: string):
    | Readonly<{
        proposal: DesignEditProposal;
        currentValues: Readonly<Partial<Record<ManualAppearanceProperty, ManualAppearanceValue>>>;
      }>
    | undefined {
    const context = this.manualMappedEditContext(nodeId);
    if (context === undefined) return undefined;
    const { revision, operationTarget, element } = context;
    if (!ts.isJsxElement(element)) return undefined;
    const currentValues = currentManualAppearanceValues(element);
    if (currentValues === undefined) return undefined;
    const commandId = `manual-appearance-command-${randomUUID()}`;
    const proposal: DesignEditProposal = {
      format: 'selene-design-edit-proposal/v1',
      schemaVersion: 1,
      proposalId: `manual-appearance-proposal-${randomUUID()}`,
      commandId,
      actorId: this.collaborationAuthorId,
      origin: 'manual-canvas',
      operation: {
        format: 'selene-design-revision-operation-reference/v2',
        kind: 'edit',
        tenantId: revision.tenantId,
        projectId: revision.projectId,
        actorId: this.collaborationAuthorId,
        commandId,
        revisionId: revision.revisionId,
        tupleBinding: revision.tupleBinding,
        revisionCommitment: revision.revisionCommitment
      },
      base: revision,
      commands: [
        {
          kind: 'set-style',
          target: {
            format: 'selene-design-edit-target/v1',
            operation: operationTarget,
            sourceAnchorId: nodeId
          },
          property: 'color',
          value: 'currentColor',
          risk: 'raw-style',
          policyDigest: createHash('sha256')
            .update(
              `selene-approved-appearance/v1\u0000${revision.tuple.designSystemLockDigest}\u0000${MANUAL_APPEARANCE_PROPERTIES.join('\u0000')}`
            )
            .digest('hex'),
          provenanceDigest: createHash('sha256')
            .update(
              `${nodeId}\u0000${revision.revisionCommitment}\u0000${this.collaborationAuthorId}`
            )
            .digest('hex')
        }
      ],
      preconditions: [
        { kind: 'source-revision', sourceDigest: revision.tuple.sourceDigest },
        { kind: 'binding-revision', bindingDigest: revision.tuple.bindingDigest },
        {
          kind: 'design-system-lock',
          designSystemLockDigest: revision.tuple.designSystemLockDigest
        },
        { kind: 'node-exists', sourceAnchorId: nodeId }
      ],
      requestedAt: new Date().toISOString()
    };
    try {
      return Object.freeze({
        proposal: parseDesignEditProposal(proposal),
        currentValues
      });
    } catch {
      return undefined;
    }
  }

  private manualPositionProposal(nodeId: string):
    | Readonly<{
        proposal: DesignEditProposal;
        currentValues: Readonly<{
          readonly position: 'absolute' | 'fixed';
          readonly left: number;
          readonly top: number;
        }>;
      }>
    | undefined {
    const context = this.manualMappedEditContext(nodeId);
    if (context === undefined) return undefined;
    const { revision, operationTarget, element } = context;
    if (!ts.isJsxElement(element)) return undefined;
    const currentValues = currentManualPositionValues(element);
    if (currentValues === undefined) return undefined;
    const commandId = `manual-position-command-${randomUUID()}`;
    const policyDigest = createHash('sha256')
      .update(
        `selene-authored-position/v1\u0000${revision.tuple.designSystemLockDigest}\u0000absolute\u0000fixed\u0000left\u0000top`
      )
      .digest('hex');
    const provenanceDigest = createHash('sha256')
      .update(`${nodeId}\u0000${revision.revisionCommitment}\u0000${this.collaborationAuthorId}`)
      .digest('hex');
    const target = {
      format: 'selene-design-edit-target/v1' as const,
      operation: operationTarget,
      sourceAnchorId: nodeId
    };
    const proposal: DesignEditProposal = {
      format: 'selene-design-edit-proposal/v1',
      schemaVersion: 1,
      proposalId: `manual-position-proposal-${randomUUID()}`,
      commandId,
      actorId: this.collaborationAuthorId,
      origin: 'manual-canvas',
      operation: {
        format: 'selene-design-revision-operation-reference/v2',
        kind: 'edit',
        tenantId: revision.tenantId,
        projectId: revision.projectId,
        actorId: this.collaborationAuthorId,
        commandId,
        revisionId: revision.revisionId,
        tupleBinding: revision.tupleBinding,
        revisionCommitment: revision.revisionCommitment
      },
      base: revision,
      commands: [
        {
          kind: 'set-style',
          target,
          property: 'left',
          value: currentValues.left,
          risk: 'raw-style',
          policyDigest,
          provenanceDigest
        },
        {
          kind: 'set-style',
          target,
          property: 'top',
          value: currentValues.top,
          risk: 'raw-style',
          policyDigest,
          provenanceDigest
        }
      ],
      preconditions: [
        { kind: 'source-revision', sourceDigest: revision.tuple.sourceDigest },
        { kind: 'binding-revision', bindingDigest: revision.tuple.bindingDigest },
        {
          kind: 'design-system-lock',
          designSystemLockDigest: revision.tuple.designSystemLockDigest
        },
        { kind: 'node-exists', sourceAnchorId: nodeId }
      ],
      requestedAt: new Date().toISOString()
    };
    try {
      return Object.freeze({ proposal: parseDesignEditProposal(proposal), currentValues });
    } catch {
      return undefined;
    }
  }

  private manualStructureProposal(
    nodeId: string,
    targetNodeId: string
  ):
    | Readonly<{ proposal: DesignEditProposal; operation: 'reorder' | 'reparent' }>
    | ManualStructureEditUnavailable['code'] {
    if (nodeId === targetNodeId) return 'MAPPED_STRUCTURE_UNAVAILABLE';
    const selected = this.manualMappedEditContext(nodeId);
    const target = this.manualMappedEditContext(targetNodeId);
    if (
      selected === undefined ||
      target === undefined ||
      !ts.isJsxElement(selected.element) ||
      !ts.isJsxElement(target.element) ||
      selected.source.fileName !== target.source.fileName ||
      selected.source.text !== target.source.text
    )
      return 'MAPPED_STRUCTURE_UNAVAILABLE';
    const anchor = (element: ts.JsxElement | undefined): string | undefined => {
      if (element === undefined) return undefined;
      const matches = element.openingElement.attributes.properties.filter(
        (attribute): attribute is ts.JsxAttribute =>
          ts.isJsxAttribute(attribute) &&
          ts.isIdentifier(attribute.name) &&
          attribute.name.text === 'data-selene-node-id' &&
          attribute.initializer !== undefined &&
          (ts.isStringLiteral(attribute.initializer) ||
            (ts.isJsxExpression(attribute.initializer) &&
              attribute.initializer.expression !== undefined &&
              ts.isStringLiteral(attribute.initializer.expression)))
      );
      const value = matches[0]?.initializer;
      if (matches.length !== 1 || value === undefined) return undefined;
      return ts.isStringLiteral(value)
        ? value.text
        : ts.isJsxExpression(value) &&
            value.expression !== undefined &&
            ts.isStringLiteral(value.expression)
          ? value.expression.text
          : undefined;
    };
    const directParent = (element: ts.JsxElement): ts.JsxElement | undefined =>
      ts.isJsxElement(element.parent) && element.parent.children.includes(element)
        ? element.parent
        : undefined;
    const selectedParent = directParent(selected.element);
    const targetParent = directParent(target.element);
    const selectedParentId = anchor(selectedParent);
    const targetParentId = anchor(targetParent);
    if (
      selectedParent === undefined ||
      targetParent === undefined ||
      selectedParentId === undefined ||
      targetParentId === undefined ||
      selectedParentId === nodeId ||
      targetParentId === nodeId
    )
      return 'MAPPED_STRUCTURE_UNAVAILABLE';
    const policyUnavailable = this.manualStructurePolicyUnavailable(
      selected.source,
      selected.element,
      selectedParent,
      targetParent
    );
    if (policyUnavailable !== undefined) return policyUnavailable;
    const { revision, operationTarget } = selected;
    const commandId = `manual-structure-command-${randomUUID()}`;
    const base = {
      format: 'selene-design-edit-proposal/v1' as const,
      schemaVersion: 1 as const,
      proposalId: `manual-structure-proposal-${randomUUID()}`,
      commandId,
      actorId: this.collaborationAuthorId,
      origin: 'manual-canvas' as const,
      operation: {
        format: 'selene-design-revision-operation-reference/v2' as const,
        kind: 'edit' as const,
        tenantId: revision.tenantId,
        projectId: revision.projectId,
        actorId: this.collaborationAuthorId,
        commandId,
        revisionId: revision.revisionId,
        tupleBinding: revision.tupleBinding,
        revisionCommitment: revision.revisionCommitment
      },
      base: revision,
      preconditions: [
        { kind: 'source-revision' as const, sourceDigest: revision.tuple.sourceDigest },
        { kind: 'binding-revision' as const, bindingDigest: revision.tuple.bindingDigest },
        {
          kind: 'design-system-lock' as const,
          designSystemLockDigest: revision.tuple.designSystemLockDigest
        },
        { kind: 'node-exists' as const, sourceAnchorId: targetParentId },
        {
          kind: 'parent-is' as const,
          sourceAnchorId: nodeId,
          parentSourceAnchorId: selectedParentId
        },
        {
          kind: 'parent-is' as const,
          sourceAnchorId: targetNodeId,
          parentSourceAnchorId: targetParentId
        }
      ],
      requestedAt: new Date().toISOString()
    };
    const editTarget = {
      format: 'selene-design-edit-target/v1' as const,
      operation: operationTarget,
      sourceAnchorId: nodeId,
      parentSourceAnchorId: selectedParentId
    };
    try {
      if (selectedParentId === targetParentId)
        return Object.freeze({
          operation: 'reorder' as const,
          proposal: parseDesignEditProposal({
            ...base,
            commands: [
              {
                kind: 'reorder-child',
                target: editTarget,
                position: { beforeSourceAnchorId: targetNodeId }
              }
            ]
          })
        });
      return Object.freeze({
        operation: 'reparent' as const,
        proposal: parseDesignEditProposal({
          ...base,
          commands: [
            {
              kind: 'reparent-child',
              target: editTarget,
              newParentSourceAnchorId: targetParentId,
              position: { beforeSourceAnchorId: targetNodeId }
            }
          ]
        })
      });
    } catch {
      return 'MAPPED_STRUCTURE_UNAVAILABLE';
    }
  }

  /**
   * Applies only package-declared composition policy. DOM ancestry, computed
   * styles, and renderer catalog projections are never treated as slot truth.
   */
  private manualStructurePolicyUnavailable(
    source: ts.SourceFile,
    selected: ts.JsxElement,
    selectedParent: ts.JsxElement,
    targetParent: ts.JsxElement
  ): ManualStructureEditUnavailable['code'] | undefined {
    type Slot = NonNullable<
      DesignerSnapshot['componentCatalog']['entries'][number]['slots']
    >[number];
    type ApprovedSourceComponent = Readonly<{
      packageName: string;
      entrypoint: string;
      exportName: string;
      slots?: readonly Slot[];
    }>;
    const approved = (
      this.designInputProvenance.designSystems ??
      (this.designInputProvenance.designSystem === undefined
        ? []
        : [
            {
              id: this.designInputProvenance.designSystem.artifactDigest,
              enabled: true,
              receipt: this.designInputProvenance.designSystem
            }
          ])
    ).flatMap((input): readonly ApprovedSourceComponent[] =>
      !input.enabled || input.receipt.catalog === undefined
        ? []
        : input.receipt.catalog.components.map((component) =>
            Object.freeze({
              packageName: input.receipt.packageName,
              entrypoint: component.entrypoint,
              exportName: component.exportName,
              ...(component.slots === undefined ? {} : { slots: component.slots })
            })
          )
    );
    const moduleSpecifier = (component: ApprovedSourceComponent): string =>
      component.entrypoint === '.'
        ? component.packageName
        : `${component.packageName}/${component.entrypoint.slice(2)}`;
    const resolve = (element: ts.JsxElement): ApprovedSourceComponent | undefined => {
      const tag = element.openingElement.tagName;
      if (!ts.isIdentifier(tag)) return undefined;
      const imported = source.statements.flatMap((statement) => {
        if (
          !ts.isImportDeclaration(statement) ||
          !ts.isStringLiteral(statement.moduleSpecifier) ||
          statement.importClause?.namedBindings === undefined ||
          !ts.isNamedImports(statement.importClause.namedBindings)
        )
          return [];
        return statement.importClause.namedBindings.elements
          .filter((binding) => binding.name.text === tag.text)
          .map((binding) => ({
            moduleSpecifier: statement.moduleSpecifier.text,
            exportName: binding.propertyName?.text ?? binding.name.text
          }));
      });
      if (imported.length !== 1 || imported[0] === undefined) return undefined;
      const matches = approved.filter(
        (component) =>
          component.exportName === imported[0]!.exportName &&
          moduleSpecifier(component) === imported[0]!.moduleSpecifier
      );
      return matches.length === 1 ? matches[0] : undefined;
    };
    const selectedParentComponent = resolve(selectedParent);
    const targetParentComponent = resolve(targetParent);
    const sourceSlots = selectedParentComponent?.slots;
    const targetSlots = targetParentComponent?.slots;
    const sameParent = selectedParent === targetParent;
    if (sourceSlots === undefined && targetSlots === undefined) return undefined;
    const sourceSlot = sourceSlots?.find((slot) => slot.kind === 'children');
    const targetSlot = targetSlots?.find((slot) => slot.kind === 'children');
    if (!sameParent && sourceSlots !== undefined && sourceSlot === undefined)
      return 'COMPONENT_SLOT_REQUIRED';
    if (targetSlots === undefined || targetSlot === undefined) return 'COMPONENT_SLOT_REQUIRED';
    const selectedComponent = resolve(selected);
    if (targetSlot.accepts !== undefined) {
      if (selectedComponent === undefined) return 'UNMAPPED_COMPONENT_CHILD';
      if (
        selectedComponent.packageName !== targetParentComponent?.packageName ||
        !targetSlot.accepts.some(
          (accepted) =>
            accepted.entrypoint === selectedComponent.entrypoint &&
            accepted.exportName === selectedComponent.exportName
        )
      )
        return 'INCOMPATIBLE_COMPONENT_SLOT';
    }
    if (sameParent) return undefined;
    const sourceCount = selectedParent.children.filter(ts.isJsxElement).length;
    const targetCount = targetParent.children.filter(ts.isJsxElement).length;
    if (sourceSlot?.minItems !== undefined && sourceCount - 1 < sourceSlot.minItems)
      return 'SLOT_CARDINALITY_VIOLATION';
    if (targetSlot.maxItems !== undefined && targetCount + 1 > targetSlot.maxItems)
      return 'SLOT_CARDINALITY_VIOLATION';
    return undefined;
  }

  private pruneManualTextEditCapabilities(): void {
    const now = Date.now();
    for (const [id, capability] of this.manualTextEditCapabilities) {
      if (capability.expiresAt <= now) this.manualTextEditCapabilities.delete(id);
    }
  }

  private pruneManualLayoutEditCapabilities(): void {
    const now = Date.now();
    for (const [id, capability] of this.manualLayoutEditCapabilities) {
      if (capability.expiresAt <= now) this.manualLayoutEditCapabilities.delete(id);
    }
  }

  private pruneManualAppearanceEditCapabilities(): void {
    const now = Date.now();
    for (const [id, capability] of this.manualAppearanceEditCapabilities) {
      if (capability.expiresAt <= now) this.manualAppearanceEditCapabilities.delete(id);
    }
  }

  private pruneManualPositionEditCapabilities(): void {
    const now = Date.now();
    for (const [id, capability] of this.manualPositionEditCapabilities) {
      if (capability.expiresAt <= now) this.manualPositionEditCapabilities.delete(id);
    }
  }

  private pruneManualStructureEditCapabilities(): void {
    const now = Date.now();
    for (const [id, capability] of this.manualStructureEditCapabilities) {
      if (capability.expiresAt <= now) this.manualStructureEditCapabilities.delete(id);
    }
  }

  private pruneDesignSystemComponentInsertCapabilities(): void {
    const now = Date.now();
    for (const [id, capability] of this.designSystemComponentInsertCapabilities) {
      if (capability.expiresAt <= now) this.designSystemComponentInsertCapabilities.delete(id);
    }
  }

  private pruneDesignSystemComponentReplaceCapabilities(): void {
    const now = Date.now();
    for (const [id, capability] of this.designSystemComponentReplaceCapabilities) {
      if (capability.expiresAt <= now) this.designSystemComponentReplaceCapabilities.delete(id);
    }
  }

  /** Durable commit precedes this in-memory adoption; it performs no I/O. */
  private manualEditBaseline(
    previous: ReactSourceWorkspace,
    current: ReactSourceWorkspace,
    commandKind: DesignEditProposal['commands'][number]['kind']
  ): DesignBaselineState {
    return executeDesignBaselineCommand(this.baseline, {
      type: 'apply-design-mutation',
      change: {
        id: `design-manual-${current.revision.id}`,
        kind: 'source',
        beforeRevision: { id: previous.revision.id, fingerprint: digest(previous) },
        currentRevision: { id: current.revision.id, fingerprint: digest(current) },
        affected: {
          projectId: current.projectId,
          screenIds: ['desktop-designer'],
          routePaths: ['/'],
          scenarioIds: enterpriseScenarioFixtures.map((item) => item.id),
          componentIds: ['App'],
          stableNodeIds: current.nodes.map((node) => node.nodeId)
        },
        evidence: [
          {
            description:
              commandKind === 'set-layout'
                ? 'Compiled and validated a direct canvas layout edit.'
                : commandKind === 'set-style'
                  ? 'Compiled and validated a direct canvas appearance edit.'
                  : commandKind === 'reorder-child' || commandKind === 'reparent-child'
                    ? 'Compiled and validated a semantic canvas structure edit.'
                    : commandKind === 'insert-child'
                      ? 'Compiled and validated an approved catalog component insertion.'
                      : commandKind === 'replace-component'
                        ? 'Compiled and validated an approved catalog component replacement.'
                        : 'Compiled and validated a direct canvas text edit.'
          }
        ],
        provenance: { kind: 'actor', actorId: this.collaborationAuthorId },
        occurredAt: current.revision.createdAt,
        reason: current.revision.summary
      }
    });
  }

  private manualUndoBaseline(
    previous: ReactSourceWorkspace,
    current: ReactSourceWorkspace,
    entry: LocalManualReactEditJournalEntry
  ): DesignBaselineState {
    return executeDesignBaselineCommand(this.baseline, {
      type: 'apply-design-mutation',
      change: {
        id: `design-manual-undo-${current.revision.id}`,
        kind: 'source',
        beforeRevision: { id: previous.revision.id, fingerprint: digest(previous) },
        currentRevision: { id: current.revision.id, fingerprint: digest(current) },
        affected: {
          projectId: current.projectId,
          screenIds: ['desktop-designer'],
          routePaths: ['/'],
          scenarioIds: enterpriseScenarioFixtures.map((item) => item.id),
          componentIds: ['App'],
          stableNodeIds: current.nodes.map((node) => node.nodeId)
        },
        evidence: [
          {
            description: `Compiled and validated a compensating revision for manual edit ${entry.commandId}.`
          }
        ],
        provenance: { kind: 'actor', actorId: this.collaborationAuthorId },
        occurredAt: current.revision.createdAt,
        reason: current.revision.summary
      }
    });
  }

  /** Durable commit precedes this in-memory adoption; it performs no I/O. */
  private adoptDurableManualEdit(
    workspace: ReactSourceWorkspace,
    designRevision: LocalManualReactEditAuthority['designRevision'],
    journal: readonly unknown[] | undefined,
    commandKind: DesignEditProposal['commands'][number]['kind']
  ): void {
    if (
      workspace.projectId !== this.source.projectId ||
      designRevision.projectId !== workspace.projectId ||
      designRevision.revisionId !== workspace.revision.id
    )
      throw new DesignerApplicationError('Durable manual edit adoption is invalid.');
    if (workspace.revision.id === this.source.revision.id) {
      if (journal !== undefined)
        this.manualReactEditJournal = Object.freeze(
          journal.map((entry) => structuredClone(entry) as LocalManualReactEditJournalEntry)
        );
      return;
    }
    if (workspace.revision.parentId !== this.source.revision.id)
      throw new DesignerApplicationError('Durable manual edit adoption is stale.');
    const previous = this.source;
    this.source = workspace;
    this.baseline = this.manualEditBaseline(previous, workspace, commandKind);
    this.reactBinding = undefined;
    this.pendingReactBinding = undefined;
    this.manualReactEditAuthority = Object.freeze({
      format: 'selene-local-manual-react-edit-authority/v1',
      workspaceRevisionId: workspace.revision.id,
      designRevision
    });
    if (journal !== undefined)
      this.manualReactEditJournal = Object.freeze(
        journal.map((entry) => structuredClone(entry) as LocalManualReactEditJournalEntry)
      );
    this.replaceCollaboration({
      ...this.collaboration,
      revisions: [
        ...this.collaboration.revisions,
        {
          id: workspace.revision.id,
          projectId: workspace.projectId,
          sequence: this.collaboration.revisions.length + 1,
          parentRevisionId: previous.revision.id,
          content: workspace,
          contentSha256: digest(workspace),
          scenarioIds: enterpriseScenarioFixtures.map((item) => item.id),
          createdBy: this.collaborationAuthorId,
          createdAt: workspace.revision.createdAt
        }
      ],
      designReviewState: toCollaborationDesignReviewState(this.baseline)
    });
    this.activity.unshift('Applied a durable manual React design edit.');
  }

  /**
   * Main-process factory used by the runtime to bind the compiler transaction
   * to this service's one-record lifecycle authority. It is intentionally not
   * part of preload, renderer snapshots, or @selene/core.
   */
  public createManualEditPersistencePort(): ManualReactEditAtomicPersistencePort {
    const port: ManualReactEditAtomicPersistencePort = {
      replay: async ({
        proposal,
        proposalDigest,
        baseRevision: _baseRevision,
        workspace: _workspace
      }) => {
        const entry = this.manualReactEditJournal?.find(
          (candidate) =>
            candidate.commandId === proposal.commandId &&
            candidate.proposalDigest === proposalDigest
        );
        if (entry === undefined) return undefined;
        if ((entry.lifecycle ?? 'applied') !== 'applied') return undefined;
        if (proposal.base.revisionId !== entry.baseRevisionId) return undefined;
        return Object.freeze({
          kind: 'replayed' as const,
          receipt: entry.receipt
        });
      },
      commit: async ({
        proposal,
        proposalDigest,
        baseRevision,
        baseWorkspace,
        candidateWorkspace,
        candidateEvidence,
        patch
      }) => {
        const command = proposal.commands[0];
        const pairedCommand = proposal.commands[1];
        const singleCommand =
          proposal.commands.length === 1 &&
          command !== undefined &&
          (command.kind === 'set-content' ||
            command.kind === 'set-layout' ||
            command.kind === 'set-style');
        const pairedPositionCommand =
          proposal.commands.length === 2 &&
          command?.kind === 'set-style' &&
          pairedCommand?.kind === 'set-style' &&
          command.property === 'left' &&
          pairedCommand.property === 'top' &&
          command.risk === 'raw-style' &&
          pairedCommand.risk === 'raw-style' &&
          typeof command.value === 'number' &&
          Number.isFinite(command.value) &&
          Math.abs(command.value) <= 100_000 &&
          typeof pairedCommand.value === 'number' &&
          Number.isFinite(pairedCommand.value) &&
          Math.abs(pairedCommand.value) <= 100_000 &&
          command.policyDigest === pairedCommand.policyDigest &&
          command.provenanceDigest === pairedCommand.provenanceDigest &&
          serializeCanonicalData(command.target) === serializeCanonicalData(pairedCommand.target);
        const structuralCommand =
          proposal.commands.length === 1 &&
          (command?.kind === 'insert-child' ||
            command?.kind === 'reorder-child' ||
            command?.kind === 'reparent-child');
        if (
          this.projectState === undefined ||
          (!singleCommand && !pairedPositionCommand && !structuralCommand) ||
          command === undefined ||
          baseWorkspace.revision.id !== this.source.revision.id ||
          baseRevision.revisionId !== this.manualReactEditAuthority?.designRevision.revisionId ||
          candidateWorkspace.revision.parentId !== baseWorkspace.revision.id ||
          candidateEvidence.sourceDigest.length !== 64 ||
          candidateEvidence.bindingDigest.length !== 64
        )
          throw new DesignerApplicationError('Manual edit commit authority is unavailable.');
        const appliedAt = new Date(
          Math.max(Date.now(), Date.parse(candidateWorkspace.revision.createdAt))
        ).toISOString();
        const inverse = Object.freeze({
          format: 'selene-local-manual-react-edit-inverse/v1' as const,
          patchDigest: createHash('sha256')
            .update(`${patch.path}\u0000${patch.previousContent}\u0000${patch.nextContent}`)
            .digest('hex'),
          previousContentDigest: createHash('sha256').update(patch.previousContent).digest('hex'),
          nextContentDigest: createHash('sha256').update(patch.nextContent).digest('hex')
        });
        const nextRevision = this.manualDesignRevision(
          baseRevision,
          candidateWorkspace,
          candidateEvidence,
          proposalDigest,
          inverse.patchDigest
        );
        const receipt: DesignEditReceipt = Object.freeze({
          format: 'selene-design-edit-receipt/v1',
          proposalId: proposal.proposalId,
          baseRevisionId: baseRevision.revisionId,
          targetRevisionId: nextRevision.revisionId,
          targetRevision: nextRevision,
          proposalDigest: Object.freeze({ format: 'sha256', value: proposalDigest }),
          sourceDigest: candidateEvidence.sourceDigest,
          bindingDigest: candidateEvidence.bindingDigest,
          bindingRemaps: Object.freeze([]),
          formatReceipt: Object.freeze({
            status: 'formatted',
            formatterId:
              command.kind === 'set-layout'
                ? 'selene-tsx-direct-layout-v1'
                : pairedPositionCommand
                  ? 'selene-tsx-direct-position-v1'
                  : structuralCommand
                    ? 'selene-tsx-semantic-structure-v1'
                    : command.kind === 'set-style'
                      ? 'selene-tsx-direct-appearance-v1'
                      : 'selene-tsx-direct-text-v1',
            digest: createHash('sha256').update(patch.nextContent).digest('hex')
          }),
          compileReceipt: Object.freeze({
            status: 'compiled',
            compilerId: candidateEvidence.compilerId,
            digest: candidateEvidence.previewDigest
          }),
          undo: Object.freeze({
            format: 'selene-design-edit-undo/v1',
            undoId: `undo-${randomUUID()}`,
            proposalDigest: Object.freeze({ format: 'sha256', value: proposalDigest }),
            targetRevisionId: nextRevision.revisionId
          }),
          commandSummary: Object.freeze([{ kind: command.kind, count: proposal.commands.length }]),
          appliedAt
        });
        const journalEntry: LocalManualReactEditJournalEntry = Object.freeze({
          format: 'selene-local-manual-react-edit-journal-entry/v1',
          commandId: proposal.commandId,
          proposalId: proposal.proposalId,
          proposalDigest,
          baseRevisionId: baseRevision.revisionId,
          targetRevisionId: nextRevision.revisionId,
          receipt,
          lifecycle: 'applied',
          inverse
        });
        const journal = Object.freeze(
          [...(this.manualReactEditJournal ?? []), journalEntry].slice(-32)
        );
        const collaboration = {
          ...this.collaboration,
          revisions: [
            ...this.collaboration.revisions,
            {
              id: candidateWorkspace.revision.id,
              projectId: candidateWorkspace.projectId,
              sequence: this.collaboration.revisions.length + 1,
              parentRevisionId: baseWorkspace.revision.id,
              content: candidateWorkspace,
              contentSha256: digest(candidateWorkspace),
              scenarioIds: enterpriseScenarioFixtures.map((item) => item.id),
              createdBy: this.collaborationAuthorId,
              createdAt: candidateWorkspace.revision.createdAt
            }
          ],
          designReviewState: toCollaborationDesignReviewState(
            this.manualEditBaseline(baseWorkspace, candidateWorkspace, command.kind)
          )
        };
        const baseline = fromCollaborationDesignReviewState(
          collaboration.designReviewState,
          candidateWorkspace.projectId
        );
        const state: LocalDesignerState = {
          ...this.guidanceState(),
          baseline,
          collaborationSnapshot: serializeSnapshot(collaboration),
          manualReactEditAuthority: Object.freeze({
            format: 'selene-local-manual-react-edit-authority/v1',
            workspaceRevisionId: candidateWorkspace.revision.id,
            designRevision: nextRevision
          }),
          manualReactEditJournal: journal
        };
        // Validate the exact receipt and candidate evidence before the one
        // durable write. Nothing after commit may need compilation or core
        // parsing before the service adopts the outcome in memory.
        const validated = await applyDesignEditProposal(
          proposal,
          {
            apply: async () => ({
              format: 'selene-design-edit-result/v1' as const,
              kind: 'applied' as const,
              receipt
            })
          },
          { sha256: (value) => createHash('sha256').update(value).digest('hex') }
        );
        if (
          validated.kind !== 'applied' ||
          validated.receipt.targetRevisionId !== candidateWorkspace.revision.id ||
          validated.receipt.sourceDigest !== candidateEvidence.sourceDigest ||
          validated.receipt.bindingDigest !== candidateEvidence.bindingDigest ||
          validated.receipt.targetRevision.tuple.sourceDigest !== candidateEvidence.sourceDigest ||
          validated.receipt.targetRevision.tuple.bindingDigest !== candidateEvidence.bindingDigest
        )
          throw new DesignerApplicationError('Manual edit receipt validation failed.');
        await this.projectState.commitDesignerRevision(
          candidateWorkspace.projectId,
          candidateWorkspace,
          state
        );
        return Object.freeze({
          kind: 'applied' as const,
          receipt,
          workspace: candidateWorkspace,
          adoption: Object.freeze({
            workspace: candidateWorkspace,
            designRevision: nextRevision,
            journal
          })
        }) satisfies ManualReactEditAtomicCommitOutcome;
      }
    };
    return Object.freeze(port);
  }

  private manualDesignRevision(
    base: LocalManualReactEditAuthority['designRevision'],
    workspace: ReactSourceWorkspace,
    evidence: Readonly<{
      readonly sourceDigest: string;
      readonly bindingDigest: string;
      readonly compilerId: string;
      readonly compilerDigest: string;
      readonly previewDigest: string;
    }>,
    proposalDigest: string,
    patchDigest: string
  ): LocalManualReactEditAuthority['designRevision'] {
    const deleteAfter = base.privacy.retention.deleteAfter;
    return migrateDesignRevisionV1({
      format: 'selene-design-revision/v1',
      tenantId: base.tenantId,
      projectId: workspace.projectId,
      revisionId: workspace.revision.id,
      parentRevisionId: base.revisionId,
      sequence: base.sequence + 1,
      createdAt: workspace.revision.createdAt,
      tuple: {
        sourceDigest: evidence.sourceDigest,
        graphDigest: base.tuple.graphDigest,
        bindingDigest: evidence.bindingDigest,
        commandLogDigest: createHash('sha256')
          .update(
            serializeCanonicalData([
              base.tuple.commandLogDigest,
              proposalDigest,
              patchDigest,
              workspace.revision.id
            ])
          )
          .digest('hex'),
        designSystemLockDigest: base.tuple.designSystemLockDigest,
        deployment: base.tuple.deployment,
        preview: {
          format: 'selene-compiled-preview-identity/v1',
          buildId: workspace.revision.id,
          previewDigest: evidence.previewDigest
        },
        compiler: {
          format: 'selene-compiler-identity/v1',
          compilerId: evidence.compilerId,
          compilerDigest: evidence.compilerDigest
        }
      },
      privacy: {
        format: 'selene-design-privacy/v1',
        classification: base.privacy.classification,
        contentDigest: evidence.sourceDigest,
        lifecycle: 'active',
        fields: [],
        retention: { deleteAfter },
        deletion: { action: 'tombstone', tombstoneDigest: evidence.bindingDigest },
        exportPolicyDigest: base.privacy.exportPolicyDigest,
        auditCorrelationId: `local-audit-${workspace.revision.id}`,
        exclusions: []
      }
    }).migratedRevision;
  }

  private setupReceipts(): NonNullable<DesignerSnapshot['setup']> | undefined {
    const { designLanguage, designLanguages, designSystem, designSystems } =
      this.designInputProvenance;
    const ordered =
      designSystems ??
      (designSystem === undefined
        ? []
        : [{ id: designSystem.artifactDigest, enabled: true, receipt: designSystem }]);
    const orderedLanguages =
      designLanguages ??
      (designLanguage === undefined
        ? []
        : [{ id: designLanguage.artifactDigest, enabled: true, receipt: designLanguage }]);
    if (ordered.length === 0 && orderedLanguages.length === 0) return undefined;
    return {
      ...(ordered.length === 0 ? {} : { designSystems: structuredClone(ordered) }),
      ...(ordered[0] === undefined ? {} : { designSystem: structuredClone(ordered[0].receipt) }),
      ...(orderedLanguages.length === 0
        ? {}
        : { designLanguages: structuredClone(orderedLanguages) }),
      ...(orderedLanguages[0] === undefined
        ? {}
        : { designLanguage: structuredClone(orderedLanguages[0].receipt) })
    };
  }

  public constructor(
    private readonly handoffMetadata: HandoffMetadataPort,
    private readonly diagnostics: CrashDiagnosticSink | undefined,
    private readonly graphPersistence: PrototypeGraphPersistencePort,
    private readonly setupIntake: DesktopDesignSystemIntake,
    collaborationAuthorId: string,
    publisher:
      | GeneratedCodePublishPort
      | readonly GeneratedCodePublishPort[] = new DeterministicLocalPublishAdapter(),
    private readonly publishConsent: TrustedPublishConsentPort = new FixturePublishConsentPort(),
    private readonly projectState: DesignerProjectStatePort | undefined = undefined,
    private readonly projectTemplate: GeneratedProjectTemplatePort = new BunViteReactGeneratedProjectTemplate(
      createEmbeddedGeneratedProjectToolchainPort()
    ),
    private readonly hostedStakeholderReview: HostedStakeholderReviewPort = new UnconfiguredHostedStakeholderReviewPort(),
    private readonly designLanguageGuidance: DesignLanguageGuidancePort = new UnconfiguredDesignLanguageGuidancePort(),
    private manualEditTransaction: ManualReactEditTransactionPort = new UnavailableManualReactEditTransactionPort(),
    private readonly componentCatalogManifests: ComponentCatalogManifestPort = new UnconfiguredComponentCatalogManifestPort(),
    private readonly storyPreviews: StoryPreviewCapabilityPort = new UnconfiguredStoryPreviewCapabilityPort()
  ) {
    this.collaborationAuthorId = validateLocalCollaborationAuthorId(collaborationAuthorId);
    this.collaboration = createCollaborationSnapshot(
      this.source,
      this.baseline,
      this.collaborationAuthorId
    );
    this.publishers = new PublishAdapterRegistry(
      Array.isArray(publisher) ? publisher : [publisher]
    );
  }

  /** Startup-only host wiring; renderer code cannot replace this authority. */
  public bindManualEditTransaction(transaction: ManualReactEditTransactionPort): void {
    if (!(this.manualEditTransaction instanceof UnavailableManualReactEditTransactionPort))
      throw new DesignerApplicationError('Manual edit transaction authority is already bound.');
    this.manualEditTransaction = transaction;
  }

  /** Startup-only compiler policy wiring; renderer code cannot activate package modules. */
  public bindDesignSystemCompilerActivation(port: {
    activate(artifactDigests: readonly string[]): void;
  }): void {
    if (this.designSystemCompilerActivation !== undefined)
      throw new DesignerApplicationError(
        'Design-system compiler activation authority is already bound.'
      );
    this.designSystemCompilerActivation = port;
  }

  private async synchronizeHostedStakeholderReview(
    bundle: ImmutablePublishBundle,
    plan: GeneratedProjectFilePlan,
    receipt: Extract<
      Awaited<ReturnType<GeneratedCodePublishPort['publish']>>,
      { readonly mode: 'github-remote' }
    >,
    signal: AbortSignal
  ): Promise<HostedStakeholderReviewStatus> {
    let publication: ReturnType<typeof createHostedStakeholderReviewPublication>;
    try {
      publication = createHostedStakeholderReviewPublication(bundle, plan.filePlanDigest, receipt);
    } catch {
      return Object.freeze({
        status: 'integrity-error' as const,
        reason: 'ARTIFACT_RECEIPT_INVALID' as const
      });
    }
    try {
      const result: unknown = structuredClone(
        await this.hostedStakeholderReview.synchronize(publication, signal)
      );
      if (!isPlainDataRecord(result))
        return Object.freeze({
          status: 'integrity-error' as const,
          reason: 'BACKEND_RESPONSE_INVALID' as const
        });
      const state = result;
      if (state.manifestDigest !== publication.manifestDigest)
        return Object.freeze({
          status: 'integrity-error' as const,
          reason: 'BACKEND_RESPONSE_INVALID' as const
        });
      if (
        state.status === 'unconfigured' &&
        state.reason === 'COLLABORATION_BACKEND_UNCONFIGURED' &&
        hasExactDataKeys(state, ['manifestDigest', 'reason', 'status'])
      )
        return Object.freeze({
          status: 'unconfigured' as const,
          reason: 'COLLABORATION_BACKEND_UNCONFIGURED' as const,
          manifestDigest: publication.manifestDigest
        });
      if (
        state.status === 'offline' &&
        state.reason === 'BACKEND_OFFLINE' &&
        state.retryable === true &&
        hasExactDataKeys(state, ['manifestDigest', 'reason', 'retryable', 'status'])
      )
        return Object.freeze({
          status: 'offline' as const,
          reason: 'BACKEND_OFFLINE' as const,
          manifestDigest: publication.manifestDigest,
          retryable: true as const
        });
      if (
        state.status === 'conflict' &&
        state.reason === 'ARTIFACT_CONFLICT' &&
        state.retryable === true &&
        hasExactDataKeys(state, ['manifestDigest', 'reason', 'retryable', 'status'])
      )
        return Object.freeze({
          status: 'conflict' as const,
          reason: 'ARTIFACT_CONFLICT' as const,
          manifestDigest: publication.manifestDigest,
          retryable: true as const
        });
      if (
        state.status === 'permission-required' &&
        state.reason === 'BACKEND_PERMISSION_REQUIRED' &&
        state.retryable === false &&
        hasExactDataKeys(state, ['manifestDigest', 'reason', 'retryable', 'status'])
      )
        return Object.freeze({
          status: 'permission-required' as const,
          reason: 'BACKEND_PERMISSION_REQUIRED' as const,
          manifestDigest: publication.manifestDigest,
          retryable: false as const
        });
      if (
        state.status === 'ready' &&
        typeof state.url === 'string' &&
        state.url.length <= 2_048 &&
        hasExactDataKeys(state, ['manifestDigest', 'status', 'url'])
      ) {
        try {
          const url = new URL(state.url);
          if (
            url.protocol === 'https:' &&
            url.hostname.length > 0 &&
            url.username === '' &&
            url.password === ''
          )
            return Object.freeze({
              status: 'ready' as const,
              url: state.url,
              manifestDigest: publication.manifestDigest
            });
        } catch {
          /* The bounded terminal integrity state below is intentional. */
        }
      }
      return Object.freeze({
        status: 'integrity-error' as const,
        reason: 'BACKEND_RESPONSE_INVALID' as const
      });
    } catch (error) {
      const code = error instanceof PublishAdapterError ? error.code : 'INTEGRITY';
      if (code === 'OFFLINE' || code === 'TIMEOUT')
        return Object.freeze({
          status: 'offline' as const,
          reason: 'BACKEND_OFFLINE' as const,
          manifestDigest: publication.manifestDigest,
          retryable: true as const
        });
      if (code === 'CONFLICT')
        return Object.freeze({
          status: 'conflict' as const,
          reason: 'ARTIFACT_CONFLICT' as const,
          manifestDigest: publication.manifestDigest,
          retryable: true as const
        });
      if (code === 'AUTH_REQUIRED')
        return Object.freeze({
          status: 'permission-required' as const,
          reason: 'BACKEND_PERMISSION_REQUIRED' as const,
          manifestDigest: publication.manifestDigest,
          retryable: false as const
        });
      if (code === 'CANCELLED' || signal.aborted)
        return Object.freeze({
          status: 'cancelled' as const,
          reason: 'SYNCHRONIZATION_CANCELLED' as const,
          manifestDigest: publication.manifestDigest
        });
      return Object.freeze({
        status: 'integrity-error' as const,
        reason: 'BACKEND_RESPONSE_INVALID' as const
      });
    }
  }

  public inspectDesignSystem(value: unknown): Promise<DesignSystemIntakeReceipt> {
    return this.enqueueGraphOperation(async () => {
      const receipt = await this.setupIntake.inspectPackage(value);
      const existing =
        this.designInputProvenance.designSystems ??
        (this.designInputProvenance.designSystem === undefined
          ? []
          : [
              {
                id: this.designInputProvenance.designSystem.artifactDigest,
                enabled: true,
                receipt: this.designInputProvenance.designSystem
              }
            ]);
      const conflicting = existing.find(
        (input) =>
          input.receipt.packageName === receipt.packageName && input.id !== receipt.artifactDigest
      );
      if (conflicting !== undefined)
        throw new DesignerApplicationError(
          `${receipt.packageName} is already staged with a different receipt; remove it before staging a replacement.`
        );
      const next = existing.some((input) => input.id === receipt.artifactDigest)
        ? existing
        : [...existing, { id: receipt.artifactDigest, enabled: true, receipt }];
      this.designSystemCompilerActivation?.activate(
        next.filter((input) => input.enabled).map((input) => input.id)
      );
      const previous = this.designInputProvenance;
      this.designInputProvenance = {
        format: 'selene-desktop-current-workspace-design-inputs/v1',
        projectId: this.source.projectId,
        designSystems: structuredClone(next),
        ...(next[0] === undefined ? {} : { designSystem: structuredClone(next[0].receipt) }),
        ...(this.designInputProvenance.designLanguage === undefined
          ? {}
          : { designLanguage: this.designInputProvenance.designLanguage }),
        ...(this.designInputProvenance.designLanguages === undefined
          ? {}
          : { designLanguages: this.designInputProvenance.designLanguages })
      };
      try {
        await this.persistProjectState();
      } catch (error) {
        this.designInputProvenance = previous;
        this.designSystemCompilerActivation?.activate(
          existing.filter((input) => input.enabled).map((input) => input.id)
        );
        throw error;
      }
      return receipt;
    });
  }
  public setDesignSystemInputs(value: unknown): Promise<DesignerSnapshot> {
    return this.enqueueGraphOperation(async () => {
      if (!isPlainDataRecord(value) || !hasExactDataKeys(value, ['inputs']))
        throw new DesignerApplicationError('Design-system input selection is invalid.');
      const values = value.inputs;
      if (!Array.isArray(values) || values.length > 32)
        throw new DesignerApplicationError('Design-system input selection is invalid.');
      const existing =
        this.designInputProvenance.designSystems ??
        (this.designInputProvenance.designSystem === undefined
          ? []
          : [
              {
                id: this.designInputProvenance.designSystem.artifactDigest,
                enabled: true,
                receipt: this.designInputProvenance.designSystem
              }
            ]);
      const known = new Map(existing.map((input) => [input.id, input]));
      const selections: DesignSystemInputSelection[] = values.map((candidate) => {
        if (!isPlainDataRecord(candidate) || !hasExactDataKeys(candidate, ['id', 'enabled']))
          throw new DesignerApplicationError('Design-system input selection is invalid.');
        if (
          typeof candidate.id !== 'string' ||
          !/^[a-f0-9]{64}$/.test(candidate.id) ||
          typeof candidate.enabled !== 'boolean'
        )
          throw new DesignerApplicationError('Design-system input selection is invalid.');
        return { id: candidate.id, enabled: candidate.enabled };
      });
      if (
        new Set(selections.map((selection) => selection.id)).size !== selections.length ||
        selections.some((selection) => !known.has(selection.id))
      )
        throw new DesignerApplicationError(
          'Design-system input selection does not match staged inputs.'
        );
      const next = selections.map((selection) => {
        const input = known.get(selection.id);
        if (input === undefined)
          throw new DesignerApplicationError('Design-system input is unavailable.');
        return Object.freeze({ ...input, enabled: selection.enabled });
      });
      const previous = this.designInputProvenance;
      this.designSystemCompilerActivation?.activate(
        next.filter((input) => input.enabled).map((input) => input.id)
      );
      this.designInputProvenance = {
        format: 'selene-desktop-current-workspace-design-inputs/v1',
        projectId: this.source.projectId,
        ...(next.length === 0 ? {} : { designSystems: next }),
        ...(next[0] === undefined ? {} : { designSystem: next[0].receipt }),
        ...(this.designInputProvenance.designLanguage === undefined
          ? {}
          : { designLanguage: this.designInputProvenance.designLanguage }),
        ...(this.designInputProvenance.designLanguages === undefined
          ? {}
          : { designLanguages: this.designInputProvenance.designLanguages })
      };
      try {
        await this.persistProjectState();
      } catch (error) {
        this.designInputProvenance = previous;
        this.designSystemCompilerActivation?.activate(
          existing.filter((input) => input.enabled).map((input) => input.id)
        );
        throw error;
      }
      return this.snapshot();
    });
  }
  private async ingestDesignLanguageMarkdown(
    markdown: string,
    displayLabel?: string
  ): Promise<MarkdownIntakeReceipt> {
    const value = Object.freeze({ markdown });
    const stagedReceipt = await this.setupIntake.ingestMarkdown(value);
    const receipt: MarkdownIntakeReceipt = {
      ...stagedReceipt,
      ...(displayLabel === undefined ? {} : { displayLabel })
    };
    if (
      Buffer.byteLength(markdown, 'utf8') === 0 ||
      Buffer.byteLength(markdown, 'utf8') > 256 * 1024 ||
      createHash('sha256').update(markdown).digest('hex') !== receipt.artifactDigest
    )
      throw new DesignerApplicationError('Staged design-language guidance could not be verified.');
    const projectId = this.source.projectId;
    const generation = this.projectGeneration;
    if (this.projectGeneration !== generation || this.source.projectId !== projectId) {
      throw new DesignerApplicationError(
        'Project changed while design-language guidance was staged.'
      );
    }
    const existing =
      this.designInputProvenance.designLanguages ??
      (this.designInputProvenance.designLanguage === undefined
        ? []
        : [
            {
              id: this.designInputProvenance.designLanguage.artifactDigest,
              enabled: true,
              receipt: this.designInputProvenance.designLanguage
            }
          ]);
    const matched = existing.find((input) => input.id === receipt.artifactDigest);
    const effectiveReceipt =
      matched?.receipt.displayLabel !== undefined || receipt.displayLabel === undefined
        ? (matched?.receipt ?? receipt)
        : receipt;
    const next =
      matched === undefined
        ? [...existing, { id: receipt.artifactDigest, enabled: true, receipt }]
        : existing.map((input) =>
            input.id === receipt.artifactDigest && input.receipt !== effectiveReceipt
              ? Object.freeze({ ...input, receipt: effectiveReceipt })
              : input
          );
    const previous = this.designInputProvenance;
    this.designInputProvenance = {
      format: 'selene-desktop-current-workspace-design-inputs/v1',
      projectId: this.source.projectId,
      ...(this.designInputProvenance.designSystems === undefined
        ? {}
        : { designSystems: this.designInputProvenance.designSystems }),
      ...(this.designInputProvenance.designSystem === undefined
        ? {}
        : { designSystem: this.designInputProvenance.designSystem }),
      designLanguages: structuredClone(next),
      ...(next[0] === undefined ? {} : { designLanguage: structuredClone(next[0].receipt) })
    };
    try {
      await this.persistGuidanceState([{ digest: receipt.artifactDigest, markdown }]);
    } catch (error) {
      this.designInputProvenance = previous;
      throw error;
    }
    return effectiveReceipt;
  }
  public ingestDesignLanguage(value: unknown): Promise<MarkdownIntakeReceipt> {
    return this.enqueueGraphOperation(async () => {
      if (
        !isPlainDataRecord(value) ||
        !hasExactDataKeys(value, ['markdown']) ||
        typeof value.markdown !== 'string'
      )
        throw new DesignerApplicationError('Design-language guidance is invalid.');
      return this.ingestDesignLanguageMarkdown(value.markdown);
    });
  }
  /** File paths stay in the main process; renderer callers receive only a receipt. */
  public async importDesignLanguageFile(
    path: string,
    projectId: string
  ): Promise<MarkdownIntakeReceipt> {
    const receipts = await this.importDesignLanguageFiles([path], projectId);
    const receipt = receipts[0];
    if (receipt === undefined)
      throw new DesignerApplicationError('The Markdown import produced no receipt.');
    return receipt;
  }
  /** Atomically stage a chooser-ordered batch; duplicate content retains its first receipt. */
  public importDesignLanguageFiles(
    paths: readonly string[],
    projectId: string
  ): Promise<readonly MarkdownIntakeReceipt[]> {
    return this.enqueueGraphOperation(async () => {
      const expectedProjectId = validateDesignerIdentifier(projectId, 'projectId');
      if (expectedProjectId !== this.source.projectId)
        throw new DesignerApplicationError('Project changed before the Markdown import began.');
      const generation = this.projectGeneration;
      const imported = await this.setupIntake.readMarkdownFiles(paths);
      if (this.projectGeneration !== generation || expectedProjectId !== this.source.projectId)
        throw new DesignerApplicationError('Project changed while Markdown files were being read.');
      const staged = await Promise.all(
        imported.map(async (entry) => ({
          entry,
          receipt: await this.setupIntake.ingestMarkdown(
            Object.freeze({ markdown: entry.markdown })
          )
        }))
      );
      const unique = staged.filter(
        ({ receipt }, index) =>
          staged.findIndex((item) => item.receipt.artifactDigest === receipt.artifactDigest) ===
          index
      );
      const existing =
        this.designInputProvenance.designLanguages ??
        (this.designInputProvenance.designLanguage === undefined
          ? []
          : [
              {
                id: this.designInputProvenance.designLanguage.artifactDigest,
                enabled: true,
                receipt: this.designInputProvenance.designLanguage
              }
            ]);
      const additions = unique.filter(
        ({ receipt }) => !existing.some((item) => item.id === receipt.artifactDigest)
      );
      if (existing.length + additions.length > 32)
        throw new DesignerApplicationError('Design-language guidance exceeds its bounded limit.');
      const next = [
        ...existing,
        ...additions.map(({ entry, receipt }) =>
          Object.freeze({
            id: receipt.artifactDigest,
            enabled: true,
            receipt: { ...receipt, displayLabel: entry.displayLabel }
          })
        )
      ];
      const previous = this.designInputProvenance;
      this.designInputProvenance = {
        format: 'selene-desktop-current-workspace-design-inputs/v1',
        projectId: expectedProjectId,
        ...(this.designInputProvenance.designSystems === undefined
          ? {}
          : { designSystems: this.designInputProvenance.designSystems }),
        ...(this.designInputProvenance.designSystem === undefined
          ? {}
          : { designSystem: this.designInputProvenance.designSystem }),
        designLanguages: structuredClone(next),
        ...(next[0] === undefined ? {} : { designLanguage: structuredClone(next[0].receipt) })
      };
      try {
        await this.persistGuidanceState(
          additions.map(({ entry, receipt }) => ({
            digest: receipt.artifactDigest,
            markdown: entry.markdown,
            sourceLocator: entry.sourceLocator
          }))
        );
      } catch (error) {
        this.designInputProvenance = previous;
        throw error;
      }
      return Object.freeze(
        unique.map(
          ({ entry, receipt }) =>
            existing.find((input) => input.id === receipt.artifactDigest)?.receipt ?? {
              ...receipt,
              displayLabel: entry.displayLabel
            }
        )
      );
    });
  }
  /** Runs inside the graph operation chosen by refresh/relink; it must never enqueue itself. */
  private async replaceDesignLanguageSource(
    artifactDigest: string,
    projectId: string,
    requestedLocator?: string
  ): Promise<MarkdownSourceRefreshResult> {
    const expectedProjectId = validateDesignerIdentifier(projectId, 'projectId');
    if (expectedProjectId !== this.source.projectId || !/^[a-f0-9]{64}$/.test(artifactDigest))
      throw new DesignerApplicationError('Design-language source refresh is unavailable.');
    const inputs =
      this.designInputProvenance.designLanguages ??
      (this.designInputProvenance.designLanguage === undefined
        ? []
        : [
            {
              id: this.designInputProvenance.designLanguage.artifactDigest,
              enabled: true,
              receipt: this.designInputProvenance.designLanguage
            }
          ]);
    const existing = inputs.find((item) => item.id === artifactDigest);
    const locator =
      requestedLocator ??
      (await this.designLanguageGuidance.sourceLocator(expectedProjectId, artifactDigest));
    if (existing === undefined || locator === undefined)
      return Object.freeze({ status: 'unavailable' });
    let imported: Awaited<ReturnType<DesktopDesignSystemIntake['readMarkdownFile']>>;
    let staged: MarkdownIntakeReceipt;
    try {
      imported = await this.setupIntake.readMarkdownFile(locator);
      staged = await this.setupIntake.ingestMarkdown(
        Object.freeze({ markdown: imported.markdown })
      );
    } catch {
      return Object.freeze({ status: 'unavailable' });
    }
    if (staged.artifactDigest === artifactDigest) {
      if (requestedLocator === undefined)
        return Object.freeze({ status: 'unchanged', receipt: existing.receipt });
      await this.persistGuidanceState([
        {
          digest: artifactDigest,
          markdown: imported.markdown,
          sourceLocator: imported.sourceLocator
        }
      ]);
      return Object.freeze({ status: 'relinked', receipt: existing.receipt });
    }
    const receipt = Object.freeze({
      ...staged,
      ...(existing.receipt.displayLabel === undefined
        ? {}
        : { displayLabel: existing.receipt.displayLabel })
    });
    const next = inputs.map((item) =>
      item.id === artifactDigest
        ? Object.freeze({ id: staged.artifactDigest, enabled: item.enabled, receipt })
        : item
    );
    if (new Set(next.map((item) => item.id)).size !== next.length)
      throw new DesignerApplicationError('Refreshed guidance duplicates an existing source.');
    const previous = this.designInputProvenance;
    this.designInputProvenance = {
      ...previous,
      designLanguages: next,
      ...(next[0] === undefined ? {} : { designLanguage: next[0].receipt })
    };
    try {
      await this.persistGuidanceState(
        [
          {
            digest: staged.artifactDigest,
            markdown: imported.markdown,
            sourceLocator: imported.sourceLocator
          }
        ],
        [artifactDigest]
      );
    } catch (error) {
      this.designInputProvenance = previous;
      throw error;
    }
    return Object.freeze({ status: 'replaced', receipt });
  }
  public refreshDesignLanguageSource(
    artifactDigest: string,
    projectId: string
  ): Promise<MarkdownSourceRefreshResult> {
    return this.enqueueGraphOperation(() =>
      this.replaceDesignLanguageSource(artifactDigest, projectId)
    );
  }
  /** Host-only locator supplied after the main process picker; it is never a renderer argument. */
  public relinkDesignLanguageSource(
    artifactDigest: string,
    projectId: string,
    sourceLocator?: string
  ): Promise<MarkdownSourceRefreshResult> {
    return this.enqueueGraphOperation(() =>
      sourceLocator === undefined
        ? Promise.resolve(Object.freeze({ status: 'cancelled' as const }))
        : this.replaceDesignLanguageSource(artifactDigest, projectId, sourceLocator)
    );
  }
  public setDesignLanguageInputs(value: unknown): Promise<DesignerSnapshot> {
    return this.enqueueGraphOperation(async () => {
      if (!isPlainDataRecord(value) || !hasExactDataKeys(value, ['inputs']))
        throw new DesignerApplicationError('Design-language input selection is invalid.');
      const values = value.inputs;
      if (!Array.isArray(values) || values.length > 32)
        throw new DesignerApplicationError('Design-language input selection is invalid.');
      const existing =
        this.designInputProvenance.designLanguages ??
        (this.designInputProvenance.designLanguage === undefined
          ? []
          : [
              {
                id: this.designInputProvenance.designLanguage.artifactDigest,
                enabled: true,
                receipt: this.designInputProvenance.designLanguage
              }
            ]);
      const known = new Map(existing.map((input) => [input.id, input]));
      const selections: DesignLanguageInputSelection[] = values.map((candidate) => {
        if (!isPlainDataRecord(candidate) || !hasExactDataKeys(candidate, ['id', 'enabled']))
          throw new DesignerApplicationError('Design-language input selection is invalid.');
        if (
          typeof candidate.id !== 'string' ||
          !/^[a-f0-9]{64}$/.test(candidate.id) ||
          typeof candidate.enabled !== 'boolean'
        )
          throw new DesignerApplicationError('Design-language input selection is invalid.');
        return { id: candidate.id, enabled: candidate.enabled };
      });
      if (
        new Set(selections.map((selection) => selection.id)).size !== selections.length ||
        selections.some((selection) => !known.has(selection.id))
      )
        throw new DesignerApplicationError(
          'Design-language input selection does not match staged inputs.'
        );
      const next = selections.map((selection) => {
        const input = known.get(selection.id);
        if (input === undefined)
          throw new DesignerApplicationError('Design-language input is unavailable.');
        return Object.freeze({ ...input, enabled: selection.enabled });
      });
      const previous = this.designInputProvenance;
      this.designInputProvenance = {
        format: 'selene-desktop-current-workspace-design-inputs/v1',
        projectId: this.source.projectId,
        ...(this.designInputProvenance.designSystems === undefined
          ? {}
          : { designSystems: this.designInputProvenance.designSystems }),
        ...(this.designInputProvenance.designSystem === undefined
          ? {}
          : { designSystem: this.designInputProvenance.designSystem }),
        ...(next.length === 0 ? {} : { designLanguages: next }),
        ...(next[0] === undefined ? {} : { designLanguage: next[0].receipt })
      };
      try {
        await this.persistGuidanceState(
          [],
          existing
            .filter((removed) => !next.some((input) => input.id === removed.id))
            .map((removed) => removed.id)
        );
      } catch (error) {
        this.designInputProvenance = previous;
        throw error;
      }
      return this.snapshot();
    });
  }

  /** Switch only at the host lifecycle boundary; renderers cannot choose a filesystem path. */
  private enqueueGraphOperation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.graphOperation.catch(() => undefined).then(operation);
    this.graphOperation = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private async persistProjectState(): Promise<void> {
    if (this.projectState === undefined) return;
    const projectId = this.source.projectId;
    const generation = this.projectGeneration;
    const setup = this.setupReceipts();
    await this.projectState.saveDesignerState(projectId, {
      format: 'selene-local-designer-state/v1',
      version: 1,
      baseline: this.baseline,
      collaborationSnapshot: serializeSnapshot(this.collaboration),
      ...(this.reactBinding === undefined ? {} : { reactBinding: this.reactBinding }),
      ...(this.manualReactEditAuthority === undefined
        ? {}
        : { manualReactEditAuthority: this.manualReactEditAuthority }),
      ...(this.manualReactEditJournal === undefined
        ? {}
        : { manualReactEditJournal: this.manualReactEditJournal }),
      ...(this.pendingAIProposal === undefined
        ? {}
        : { pendingAIProposal: this.pendingAIProposal }),
      ...(setup === undefined ? {} : { setup })
    });
    if (this.projectGeneration !== generation || this.source.projectId !== projectId)
      throw new DesignerApplicationError(
        'Project changed while its local collaboration state was being saved.'
      );
  }
  private guidanceState(): LocalDesignerState {
    const setup = this.setupReceipts();
    return {
      format: 'selene-local-designer-state/v1',
      version: 1,
      baseline: this.baseline,
      collaborationSnapshot: serializeSnapshot(this.collaboration),
      ...(this.reactBinding === undefined ? {} : { reactBinding: this.reactBinding }),
      ...(this.manualReactEditAuthority === undefined
        ? {}
        : { manualReactEditAuthority: this.manualReactEditAuthority }),
      ...(this.manualReactEditJournal === undefined
        ? {}
        : { manualReactEditJournal: this.manualReactEditJournal }),
      ...(this.pendingAIProposal === undefined
        ? {}
        : { pendingAIProposal: this.pendingAIProposal }),
      ...(setup === undefined ? {} : { setup })
    };
  }
  private async persistGuidanceState(
    pending: readonly {
      readonly digest: string;
      readonly markdown: string;
      readonly sourceLocator?: string;
    }[] = [],
    removedDigests: readonly string[] = []
  ): Promise<void> {
    const projectId = this.source.projectId;
    if (
      new Set(pending.map((entry) => entry.digest)).size !== pending.length ||
      new Set(removedDigests).size !== removedDigests.length ||
      pending.some((entry) => removedDigests.includes(entry.digest))
    )
      throw new DesignerApplicationError('Design-language guidance transaction is invalid.');
    const overrides = new Map(pending.map((entry) => [entry.digest, entry]));
    const inputs = this.designInputProvenance.designLanguages ?? [];
    const guidance = await Promise.all(
      inputs.map(async (input) => {
        const override = overrides.get(input.id);
        const markdown =
          override?.markdown ?? (await this.designLanguageGuidance.resolve(projectId, input.id));
        if (markdown === undefined)
          throw new DesignerApplicationError('Design-language guidance is unavailable.');
        const sourceLocator =
          override?.sourceLocator ??
          (await this.designLanguageGuidance.sourceLocator(projectId, input.id));
        return {
          digest: input.id,
          markdown,
          ...(sourceLocator === undefined ? {} : { sourceLocator })
        };
      })
    );
    if (this.projectState === undefined) {
      if (guidance.length > 0)
        await this.designLanguageGuidance.storeBatch(
          projectId,
          guidance.map((entry) => ({
            artifactDigest: entry.digest,
            markdown: entry.markdown,
            ...(entry.sourceLocator === undefined ? {} : { sourceLocator: entry.sourceLocator })
          }))
        );
      if (removedDigests.length > 0)
        await this.designLanguageGuidance.removeBatch(projectId, removedDigests);
      return;
    }
    await this.projectState.saveDesignerStateWithGuidance(
      projectId,
      this.guidanceState(),
      guidance
    );
  }

  private async persistAppliedRevision(): Promise<void> {
    if (this.projectState === undefined) return;
    const setup = this.setupReceipts();
    await this.projectState.commitDesignerRevision(this.source.projectId, this.source, {
      format: 'selene-local-designer-state/v1',
      version: 1,
      baseline: this.baseline,
      collaborationSnapshot: serializeSnapshot(this.collaboration),
      ...(this.manualReactEditAuthority === undefined
        ? {}
        : { manualReactEditAuthority: this.manualReactEditAuthority }),
      ...(this.manualReactEditJournal === undefined
        ? {}
        : { manualReactEditJournal: this.manualReactEditJournal }),
      ...(this.pendingAIProposal === undefined
        ? {}
        : { pendingAIProposal: this.pendingAIProposal }),
      ...(setup === undefined ? {} : { setup })
    });
  }

  /** User-visible success is withheld until the lifecycle's serialized durable commit succeeds. */
  private persistProjectStateSerialized(): Promise<void> {
    return this.enqueueGraphOperation(() => this.persistProjectState());
  }

  private async hydrateProjectState(projectId: string): Promise<void> {
    if (this.projectState === undefined) return;
    const stored = await this.projectState.designerState(projectId);
    if (stored === undefined) return;
    const migration = migrateLegacyLocalCollaborationAttribution(
      parseSnapshot(stored.collaborationSnapshot),
      this.collaborationAuthorId
    );
    const snapshot = migration.snapshot;
    if (snapshot.project.id !== projectId)
      throw new DesignerApplicationError('Saved collaboration state belongs to another project.');
    const latest = snapshot.revisions.reduce(
      (current, revision) =>
        current === undefined || revision.sequence > current.sequence ? revision : current,
      undefined as CollaborationSnapshot['revisions'][number] | undefined
    );
    if (
      latest !== undefined &&
      (latest.id !== this.source.revision.id || latest.contentSha256 !== digest(this.source))
    )
      throw new DesignerApplicationError(
        'Saved collaboration revision does not match the lifecycle workspace.'
      );
    this.collaboration = snapshot;
    this.designInputProvenance = {
      format: 'selene-desktop-current-workspace-design-inputs/v1',
      projectId,
      ...(stored.setup?.designSystems === undefined
        ? stored.setup?.designSystem === undefined
          ? {}
          : {
              designSystems: [
                {
                  id: stored.setup.designSystem.artifactDigest,
                  enabled: true,
                  receipt: structuredClone(stored.setup.designSystem)
                }
              ]
            }
        : { designSystems: structuredClone(stored.setup.designSystems) }),
      ...(stored.setup?.designSystem === undefined
        ? {}
        : { designSystem: structuredClone(stored.setup.designSystem) }),
      ...(stored.setup?.designLanguages === undefined
        ? stored.setup?.designLanguage === undefined
          ? {}
          : {
              designLanguages: [
                {
                  id: stored.setup.designLanguage.artifactDigest,
                  enabled: true,
                  receipt: structuredClone(stored.setup.designLanguage)
                }
              ]
            }
        : { designLanguages: structuredClone(stored.setup.designLanguages) }),
      ...(stored.setup?.designLanguage === undefined
        ? {}
        : { designLanguage: structuredClone(stored.setup.designLanguage) })
    };
    const hydrated = projectRendererState(snapshot);
    this.baseline = hydrated.baseline;
    this.reviewThreads.splice(0, this.reviewThreads.length, ...hydrated.reviewThreads);
    this.artifactPins.splice(0, this.artifactPins.length, ...hydrated.artifactPins);
    this.pendingAIProposal = stored.pendingAIProposal;
    this.aiChangeRequests.splice(
      0,
      this.aiChangeRequests.length,
      ...hydrated.aiChangeRequests.map((request) =>
        request.id === this.pendingAIProposal?.requestId
          ? { ...request, status: 'reviewing' as const }
          : request
      )
    );
    this.developerAnnotations.splice(
      0,
      this.developerAnnotations.length,
      ...hydrated.developerAnnotations
    );
    // Compiler evidence is intentionally absent; reopen retains only parsed inert authority data.
    this.reactBinding = undefined;
    this.manualReactEditAuthority = stored.manualReactEditAuthority;
    this.manualReactEditJournal = stored.manualReactEditJournal;
    this.pendingReactBinding = stored.reactBinding;
    this.pendingProjectStateMigration = migration.migrated;
  }

  private replaceCollaboration(snapshot: CollaborationSnapshot): void {
    this.collaboration = snapshot;
    this.baseline = fromCollaborationDesignReviewState(
      snapshot.designReviewState,
      this.source.projectId
    );
  }

  private revalidateReactBindingAfterGraphHydration(): void {
    const candidate = this.pendingReactBinding;
    if (candidate === undefined) return;
    // The lifecycle never persists compiler output. A reopened manifest remains
    // inert until the preview host has produced a fresh matched build receipt.
    this.reactBinding = undefined;
    this.activity.unshift('Saved React binding requires a fresh host build receipt.');
  }

  private previewBuildTicket(): PreviewBuildTicket {
    const bindingId = createHash('sha256')
      .update(
        serializeCanonicalData({
          source: this.source,
          graph: this.graph,
          graphRevision: this.graphRevision,
          binding: this.reactBinding ?? this.pendingReactBinding ?? null
        })
      )
      .digest('hex');
    return Object.freeze({
      format: 'selene-preview-build-ticket/v1',
      projectId: this.source.projectId,
      sourceRevisionId: this.source.revision.id,
      graphRevision: this.graphRevision,
      bindingId
    });
  }

  /**
   * Mints an inert local authority only from fresh compiler evidence. It carries
   * digests and opaque IDs, never source, prompts, paths, URLs, or telemetry.
   */
  private mintManualReactEditAuthority(
    evidence: ReactBindingCompilerEvidence,
    artifact: ReactBuildArtifact
  ): LocalManualReactEditAuthority {
    const receipt = artifact.receipt;
    if (receipt === undefined)
      throw new DesignerApplicationError('A host build receipt is required.');
    const sourceDigest = receipt.sourceSha256;
    const bindingDigest = createHash('sha256')
      .update(serializeCanonicalData(evidence))
      .digest('hex');
    const graphDigest = createHash('sha256')
      .update(serializeCanonicalData(this.graph))
      .digest('hex');
    const commandLogDigest = createHash('sha256').update(serializeCanonicalData([])).digest('hex');
    const designSystemLockDigest = digest(this.designInputProvenance);
    const createdAt = this.source.revision.createdAt;
    const retentionBase = Math.max(Date.now(), Date.parse(createdAt));
    if (!Number.isFinite(retentionBase))
      throw new DesignerApplicationError('Current source revision timestamp is invalid.');
    const retentionDeleteAfter = new Date(retentionBase + 3650 * 24 * 60 * 60 * 1000).toISOString();
    let designRevision: LocalManualReactEditAuthority['designRevision'];
    try {
      designRevision = parseDesignRevision(
        migrateDesignRevisionV1({
          format: 'selene-design-revision/v1',
          tenantId: 'local-profile',
          projectId: this.source.projectId,
          revisionId: this.source.revision.id,
          sequence: Math.max(1, this.collaboration.revisions.length),
          createdAt,
          tuple: {
            sourceDigest,
            graphDigest,
            bindingDigest,
            commandLogDigest,
            designSystemLockDigest,
            deployment: {
              format: 'selene-deployment-identity/v1',
              state: 'unpublished',
              draftId: `local-draft-${sourceDigest.slice(0, 32)}`,
              manifestDigest: sourceDigest
            },
            preview: {
              format: 'selene-compiled-preview-identity/v1',
              buildId: this.source.revision.id,
              previewDigest: receipt.outputSha256
            },
            compiler: {
              format: 'selene-compiler-identity/v1',
              compilerId: 'selene-vite-react-compiler-v1',
              compilerDigest: createHash('sha256').update(receipt.compilerIdentity).digest('hex')
            }
          },
          privacy: {
            format: 'selene-design-privacy/v1',
            classification: 'internal',
            contentDigest: sourceDigest,
            lifecycle: 'active',
            fields: [],
            retention: { deleteAfter: retentionDeleteAfter },
            deletion: { action: 'tombstone', tombstoneDigest: bindingDigest },
            exportPolicyDigest: designSystemLockDigest,
            auditCorrelationId: `local-audit-${sourceDigest.slice(0, 32)}`,
            exclusions: []
          }
        }).migratedRevision
      );
    } catch {
      throw new DesignerApplicationError('Local manual edit authority could not be created.');
    }
    return Object.freeze({
      format: 'selene-local-manual-react-edit-authority/v1',
      workspaceRevisionId: this.source.revision.id,
      designRevision
    });
  }

  /** Main-process-only promotion after the preview compiler emits exact evidence. */
  public activateReactBindingReceipt(
    artifact: ReactBuildArtifact
  ): Promise<Readonly<{ status: 'activated' | 'unavailable' }>> {
    return this.enqueueGraphOperation(() =>
      this.mutateDurably(async () => {
        const candidate = this.pendingReactBinding;
        const receipt = artifact.receipt;
        if (receipt === undefined || artifact.diagnostics.length !== 0) {
          if (candidate === undefined) {
            this.activity.unshift(
              'No persisted React binding is available for this compiled workspace.'
            );
            return { status: 'unavailable' as const };
          }
          throw new DesignerApplicationError('A successful host preview artifact is required.');
        }
        const outputSha256 = digestReactBuildOutput(artifact);
        if (receipt.outputSha256 !== outputSha256) {
          if (candidate === undefined) {
            this.activity.unshift(
              'No persisted React binding is available for this compiled workspace.'
            );
            return { status: 'unavailable' as const };
          }
          throw new DesignerApplicationError(
            'React build receipt does not match emitted preview output.'
          );
        }
        let evidence: ReactBindingCompilerEvidence;
        try {
          evidence = issueReactBindingCompilerEvidence(this.source, receipt);
        } catch (error) {
          if (candidate !== undefined) throw error;
          this.activity.unshift(
            'No persisted React binding is available for this compiled workspace.'
          );
          return { status: 'unavailable' as const };
        }
        this.manualReactEditAuthority = this.mintManualReactEditAuthority(evidence, artifact);
        if (candidate === undefined) {
          await this.persistProjectState();
          this.activity.unshift(
            'Activated compiler-backed manual editing for the current React workspace.'
          );
          this.activity.unshift(
            'No persisted React binding is available for this compiled workspace.'
          );
          return { status: 'unavailable' as const };
        }
        this.reactBinding = validateReactBindingManifest(candidate, {
          graph: this.graph,
          graphRevision: this.graphRevision,
          workspace: this.source,
          compilerEvidence: evidence
        });
        this.pendingReactBinding = undefined;
        await this.persistProjectState();
        this.activity.unshift('Activated React binding from the current host build receipt.');
        return { status: 'activated' as const };
      })
    );
  }

  private appendCanonicalReview(thread: ReviewThread): void {
    const canonical: CollaborationReviewThread = {
      id: thread.id,
      projectId: this.source.projectId,
      anchor: this.canonicalAnchor(thread.anchor),
      messages: [
        {
          id: `${thread.id}:message`,
          body: thread.body,
          createdBy: thread.author,
          createdAt: thread.createdAt,
          mentionedUserIds: [],
          reactions: [],
          readBy: []
        }
      ],
      deepLink: `/projects/${encodeURIComponent(this.source.projectId)}/reviews/${encodeURIComponent(thread.id)}`,
      lifecycle: 'open',
      createdBy: thread.author,
      createdAt: thread.createdAt
    };
    this.replaceCollaboration({
      ...this.collaboration,
      reviewThreads: [...this.collaboration.reviewThreads, canonical]
    });
  }

  private updateCanonicalBaseline(): void {
    this.replaceCollaboration({
      ...this.collaboration,
      designReviewState: toCollaborationDesignReviewState(this.baseline)
    });
  }

  private canonicalAnchor(anchor: DesignerSnapshot['reviewThreads'][number]['anchor']) {
    const revision = this.collaboration.revisions.find((item) => item.id === anchor.revisionId);
    if (revision === undefined)
      throw new DesignerApplicationError(
        'Collaboration anchor references a revision that is not retained.'
      );
    return collaborationAnchor(anchor, revision.contentSha256);
  }

  private captureMutationState() {
    return {
      source: this.source,
      baseline: this.baseline,
      collaboration: this.collaboration,
      reviewThreads: [...this.reviewThreads],
      artifactPins: [...this.artifactPins],
      aiChangeRequests: [...this.aiChangeRequests],
      developerAnnotations: [...this.developerAnnotations],
      activity: [...this.activity],
      active: this.active,
      reactBinding: this.reactBinding,
      manualReactEditAuthority: this.manualReactEditAuthority,
      manualReactEditJournal: this.manualReactEditJournal,
      pendingAIProposal: this.pendingAIProposal,
      pendingReactBinding: this.pendingReactBinding,
      pendingProjectStateMigration: this.pendingProjectStateMigration
    };
  }

  /** Authority and its replay journal are one invariant and must be revoked together. */
  private revokeManualReactEditAuthority(): void {
    this.manualReactEditAuthority = undefined;
    this.manualReactEditJournal = undefined;
  }

  private restoreMutationState(
    state: ReturnType<DesktopDesignerApplicationService['captureMutationState']>
  ): void {
    this.source = state.source;
    this.baseline = state.baseline;
    this.collaboration = state.collaboration;
    this.reviewThreads.splice(0, this.reviewThreads.length, ...state.reviewThreads);
    this.artifactPins.splice(0, this.artifactPins.length, ...state.artifactPins);
    this.aiChangeRequests.splice(0, this.aiChangeRequests.length, ...state.aiChangeRequests);
    this.developerAnnotations.splice(
      0,
      this.developerAnnotations.length,
      ...state.developerAnnotations
    );
    this.activity.splice(0, this.activity.length, ...state.activity);
    this.active = state.active;
    this.reactBinding = state.reactBinding;
    this.manualReactEditAuthority = state.manualReactEditAuthority;
    this.manualReactEditJournal = state.manualReactEditJournal;
    this.pendingAIProposal = state.pendingAIProposal;
    this.pendingReactBinding = state.pendingReactBinding;
    this.pendingProjectStateMigration = state.pendingProjectStateMigration;
  }

  private async mutateDurably<T>(operation: () => Promise<T>): Promise<T> {
    const before = this.captureMutationState();
    try {
      return await operation();
    } catch (error) {
      this.restoreMutationState(before);
      throw error;
    }
  }

  public openProjectWorkspace(value: unknown): Promise<DesignerSnapshot> {
    return this.enqueueGraphOperation(async () => {
      try {
        validateReactSourceWorkspace(value as ReactSourceWorkspace);
      } catch {
        throw new DesignerApplicationError('Project workspace is invalid.');
      }
      const workspace = structuredClone(value as ReactSourceWorkspace);
      if (this.active !== undefined)
        throw new DesignerApplicationError(
          'Cancel the active agent request before switching projects.'
        );
      if (this.pendingAIProposal !== undefined)
        throw new DesignerApplicationError(
          'Accept or reject the staged AI proposal before switching projects.'
        );
      if (this.graphHydration.state === 'recovery-required')
        throw new DesignerApplicationError(
          'Resolve the current graph recovery before opening another project.'
        );
      const prior = {
        source: this.source,
        collaboration: this.collaboration,
        baseline: this.baseline,
        reviewThreads: [...this.reviewThreads],
        artifactPins: [...this.artifactPins],
        aiChangeRequests: [...this.aiChangeRequests],
        developerAnnotations: [...this.developerAnnotations],
        selectedNodeId: this.selectedNodeId,
        selectedScenarioId: this.selectedScenarioId,
        graph: this.graph,
        graphRevision: this.graphRevision,
        graphHydration: this.graphHydration,
        graphMode: this.graphMode,
        prototypeRuntime: this.prototypeRuntime,
        reactBinding: this.reactBinding,
        manualReactEditAuthority: this.manualReactEditAuthority,
        manualReactEditJournal: this.manualReactEditJournal,
        pendingAIProposal: this.pendingAIProposal,
        pendingReactBinding: this.pendingReactBinding,
        pendingProjectStateMigration: this.pendingProjectStateMigration,
        generation: this.projectGeneration,
        productMap: this.productMap,
        designInputProvenance: this.designInputProvenance,
        activity: [...this.activity]
      };
      try {
        this.projectGeneration += 1;
        this.source = workspace;
        this.manualTextEditCapabilities.clear();
        this.manualLayoutEditCapabilities.clear();
        this.manualAppearanceEditCapabilities.clear();
        this.manualPositionEditCapabilities.clear();
        this.designSystemComponentInsertCapabilities.clear();
        this.designSystemComponentReplaceCapabilities.clear();
        this.reactBinding = undefined;
        this.revokeManualReactEditAuthority();
        this.pendingAIProposal = undefined;
        this.pendingReactBinding = undefined;
        this.pendingProjectStateMigration = false;
        // Collaboration is project-scoped. Until the host persistence adapter hydrates a
        // project record, never carry pins, threads, AI history, or annotations across projects.
        this.reviewThreads.splice(0);
        this.artifactPins.splice(0);
        this.aiChangeRequests.splice(0);
        this.developerAnnotations.splice(0);
        this.baseline = initialBaseline(workspace.projectId);
        this.collaboration = createCollaborationSnapshot(
          workspace,
          this.baseline,
          this.collaborationAuthorId
        );
        this.designInputProvenance = {
          format: 'selene-desktop-current-workspace-design-inputs/v1',
          projectId: workspace.projectId
        };
        this.selectedNodeId = undefined;
        this.selectedScenarioId = enterpriseScenarioFixtures[0]?.id ?? '';
        this.graphMode = 'edit';
        this.prototypeRuntime = undefined;
        await this.hydrateProjectState(workspace.projectId);
        try {
          this.productMap = await this.projectState?.productMap?.(workspace.projectId);
        } catch {
          // Portfolio context is informative and must not make an otherwise
          // healthy local project impossible to open.
          this.productMap = undefined;
          this.activity.unshift('Local project portfolio status is temporarily unavailable.');
        }
        // Hydration has just loaded an inert persisted binding. Keep it only
        // through this same-project graph reload so host evidence can validate
        // the complete authority tuple before any activation.
        await this.hydratePrototypeGraphUnlocked(true);
        this.revalidateReactBindingAfterGraphHydration();
        if (this.pendingProjectStateMigration) {
          await this.persistProjectState();
          this.pendingProjectStateMigration = false;
        }
        this.activity.unshift(`Opened lifecycle project ${workspace.projectId}.`);
        return this.snapshot();
      } catch (error) {
        this.source = prior.source;
        this.collaboration = prior.collaboration;
        this.baseline = prior.baseline;
        this.reviewThreads.splice(0, this.reviewThreads.length, ...prior.reviewThreads);
        this.artifactPins.splice(0, this.artifactPins.length, ...prior.artifactPins);
        this.aiChangeRequests.splice(0, this.aiChangeRequests.length, ...prior.aiChangeRequests);
        this.developerAnnotations.splice(
          0,
          this.developerAnnotations.length,
          ...prior.developerAnnotations
        );
        this.selectedNodeId = prior.selectedNodeId;
        this.selectedScenarioId = prior.selectedScenarioId;
        this.graph = prior.graph;
        this.graphRevision = prior.graphRevision;
        this.graphHydration = prior.graphHydration;
        this.graphMode = prior.graphMode;
        this.prototypeRuntime = prior.prototypeRuntime;
        this.reactBinding = prior.reactBinding;
        this.manualReactEditAuthority = prior.manualReactEditAuthority;
        this.manualReactEditJournal = prior.manualReactEditJournal;
        this.pendingAIProposal = prior.pendingAIProposal;
        this.pendingReactBinding = prior.pendingReactBinding;
        this.pendingProjectStateMigration = prior.pendingProjectStateMigration;
        this.projectGeneration = prior.generation;
        this.productMap = prior.productMap;
        this.designInputProvenance = prior.designInputProvenance;
        this.activity.splice(0, this.activity.length, ...prior.activity);
        this.activity.unshift(
          `Project persistence recovery is required: ${error instanceof Error ? error.message : 'unknown error.'}`
        );
        throw error;
      }
    });
  }

  /** Main-process composition can register any adapter implementing this narrow port. */
  public registerAgent(adapter: DesignerAgentAdapter): void {
    const id = validateDesignerIdentifier(adapter.descriptor.id, 'agent id');
    if (!adapter.descriptor.label.trim())
      throw new DesignerApplicationError('agent label is required');
    if (this.agents.has(id)) throw new DesignerApplicationError(`agent already registered: ${id}`);
    this.agents.set(id, adapter);
    this.selectedAgentId ??= id;
  }
  private async hydratePrototypeGraphUnlocked(
    preservePendingBinding = false
  ): Promise<DesignerSnapshot['prototypeGraphHydration']> {
    // A graph replacement changes the binding authority tuple. Never retain a
    // prior binding while a new graph is being loaded or recovered.
    this.reactBinding = undefined;
    this.revokeManualReactEditAuthority();
    if (!preservePendingBinding) this.pendingReactBinding = undefined;
    try {
      const saved = await this.graphPersistence.read(this.source.projectId);
      if (saved) {
        if (saved.graph.project.projectId !== this.source.projectId)
          throw new DesignerApplicationError(
            'Saved graph belongs to a project that is no longer active.'
          );
        this.graph = saved.graph;
        this.graphRevision = saved.revision;
        this.graphHydration = { state: 'persisted' };
        this.activity.unshift(`Hydrated saved flow graph revision ${saved.revision}.`);
        return this.graphHydration;
      }
      this.graph = freshPrototypeGraphForWorkspace(this.source);
      this.graphRevision = 0;
      this.graphHydration = { state: 'missing' };
      this.activity.unshift(
        'No saved flow graph exists; initialized the local fixture at revision 0.'
      );
      return this.graphHydration;
    } catch (error) {
      this.graph = freshPrototypeGraphForWorkspace(this.source);
      this.graphRevision = 0;
      const message = error instanceof Error ? error.message : 'Saved graph could not be read.';
      this.graphHydration = {
        state: 'recovery-required',
        message,
        ...(error instanceof PrototypeGraphPersistenceError && typeof error.recoveryId === 'string'
          ? { recovery: { recoveryId: error.recoveryId } }
          : {})
      };
      this.activity.unshift(`Saved flow graph needs recovery. ${message}`);
      return this.graphHydration;
    }
  }

  public hydratePrototypeGraph(): Promise<DesignerSnapshot['prototypeGraphHydration']> {
    return this.enqueueGraphOperation(async () => {
      const hydration = await this.hydratePrototypeGraphUnlocked();
      if (hydration.state !== 'recovery-required') this.revalidateReactBindingAfterGraphHydration();
      return hydration;
    });
  }

  public subscribe(listener: (event: DesignerProgress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private designActivity(projected: {
    readonly aiChangeRequests: readonly AIChangeRequest[];
  }): readonly DesignActivityEntry[] {
    const agentActivity: DesignActivityEntry[] = projected.aiChangeRequests.map((request) => ({
      id: `agent:${request.id}`,
      origin: 'agent',
      kind: 'ai-change',
      label: request.instruction,
      actorLabel: this.agents.get(request.agentId)?.descriptor.label ?? request.agentId,
      createdAt: request.createdAt,
      status: request.status,
      referenceId: request.id,
      ...(request.resultingRevisionId === undefined
        ? {}
        : { resultingRevisionId: request.resultingRevisionId })
    }));
    const latestManual = this.manualReactEditJournal?.at(-1);
    const manualActivity: DesignActivityEntry[] = (this.manualReactEditJournal ?? []).map(
      (entry) => {
        const command = entry.receipt.commandSummary[0];
        const kind: DesignActivityEntry['kind'] =
          command?.kind === 'set-layout'
            ? 'layout'
            : command?.kind === 'set-style' && command.count === 2
              ? 'position'
              : command?.kind === 'set-style'
                ? 'appearance'
                : command?.kind === 'reorder-child'
                  ? 'reorder'
                  : command?.kind === 'reparent-child'
                    ? 'reparent'
                    : 'content';
        const label =
          kind === 'layout'
            ? 'Adjusted element layout'
            : kind === 'position'
              ? 'Moved element on the artboard'
              : kind === 'appearance'
                ? 'Updated element appearance'
                : kind === 'reorder'
                  ? 'Reordered element'
                  : kind === 'reparent'
                    ? 'Moved element into another container'
                    : 'Edited element text';
        const lifecycle = entry.lifecycle ?? 'applied';
        const current =
          latestManual === entry &&
          lifecycle === 'applied' &&
          this.manualReactEditAuthority?.workspaceRevisionId === this.source.revision.id &&
          this.manualReactEditAuthority.designRevision.revisionId === entry.targetRevisionId;
        const disabledReason: NonNullable<DesignActivityEntry['undo']>['disabledReason'] =
          lifecycle === 'undone'
            ? 'ALREADY_UNDONE'
            : latestManual !== entry
              ? 'NOT_LATEST'
              : 'SOURCE_CHANGED';
        return {
          id: `manual:${entry.receipt.undo.undoId}`,
          origin: 'manual',
          kind,
          label,
          actorLabel: 'You',
          createdAt: entry.receipt.appliedAt,
          status: lifecycle,
          referenceId: entry.commandId,
          resultingRevisionId: entry.undoResult?.workspaceRevisionId ?? entry.targetRevisionId,
          undo: {
            undoId: entry.receipt.undo.undoId,
            targetRevisionId: entry.targetRevisionId,
            available: current,
            ...(current ? {} : { disabledReason })
          }
        };
      }
    );
    return Object.freeze(
      [...agentActivity, ...manualActivity]
        .sort(
          (left, right) =>
            Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
            left.id.localeCompare(right.id)
        )
        .slice(-32)
    );
  }

  public snapshot(): DesignerSnapshot {
    if (this.selectedAgentId === undefined)
      throw new DesignerApplicationError('no agents are registered');
    const projected = projectRendererState(this.collaboration);
    const setup = this.setupReceipts();
    const cachedCurrentProduct = this.productMap?.projects.find(
      (project) => project.projectId === this.source.projectId
    );
    const currentProductProject = Object.freeze({
      projectId: this.source.projectId,
      name: cachedCurrentProduct?.name ?? this.source.projectId,
      role: cachedCurrentProduct?.role ?? ('standalone' as const),
      ...(cachedCurrentProduct?.shellProjectId === undefined
        ? {}
        : { shellProjectId: cachedCurrentProduct.shellProjectId }),
      lifecycle: 'active',
      readiness: this.baseline.readiness,
      currency: this.baseline.currency,
      changesSinceBaseline: this.baseline.changesSinceBaseline.length
    });
    const productProjects = [
      currentProductProject,
      ...(this.productMap?.projects ?? []).filter(
        (project) => project.projectId !== currentProductProject.projectId
      )
    ];
    const aiChangeRequests = projected.aiChangeRequests.map((request) =>
      request.id === this.pendingAIProposal?.requestId
        ? { ...request, status: 'reviewing' as const }
        : request
    );
    const catalogInsertTarget = this.selectedCatalogInsertTarget();
    const catalogReplaceTarget = this.selectedCatalogReplaceTarget();
    return structuredClone({
      apiVersion: DESIGNER_API_VERSION,
      agents: [...this.agents.values()].map((agent) => agent.descriptor),
      selectedAgentId: this.selectedAgentId,
      source: this.source,
      nodes: this.source.nodes,
      ...(this.selectedNodeId === undefined ? {} : { selectedNodeId: this.selectedNodeId }),
      ...(catalogInsertTarget === undefined ? {} : { catalogInsertTarget }),
      ...(catalogReplaceTarget === undefined ? {} : { catalogReplaceTarget }),
      reviewThreads: projected.reviewThreads,
      artifactPins: projected.artifactPins,
      aiChangeRequests,
      designActivity: this.designActivity({ aiChangeRequests }),
      ...(this.pendingAIProposal === undefined
        ? {}
        : {
            pendingAIProposal: {
              requestId: this.pendingAIProposal.requestId,
              agentId: this.pendingAIProposal.agentId,
              baseRevisionId: this.pendingAIProposal.baseRevisionId,
              candidateRevisionId: this.pendingAIProposal.candidateWorkspace.revision.id,
              summary: this.pendingAIProposal.summary,
              createdAt: this.pendingAIProposal.createdAt
            }
          }),
      developerAnnotations: projected.developerAnnotations,
      scenarios: enterpriseScenarioFixtures,
      selectedScenarioId: this.selectedScenarioId,
      baseline: projected.baseline,
      prototype: { flow: prototypeFlow, currentScreenId: 'dashboard' },
      editablePrototype: {
        graph: this.graph,
        mode: this.graphMode,
        revision: this.graphRevision,
        previewTicket: this.previewBuildTicket(),
        ...(this.prototypeRuntime ? { runtime: this.prototypeRuntime.snapshot() } : {})
      },
      prototypeGraphHydration: this.graphHydration,
      componentCatalog: componentCatalogFor(
        this.source,
        setup,
        currentComponentCatalogArtifacts(this.componentCatalogManifests, this.source, this.graph),
        this.storyPreviews,
        currentFederatedComponentCatalog(this.componentCatalogManifests, this.productMap)
      ),
      ...(setup === undefined ? {} : { setup }),
      productMap: {
        format: 'selene-desktop-product-map/v1',
        currentProjectId: this.source.projectId,
        scope: this.productMap?.scope ?? { kind: 'standalone' },
        projects: productProjects
      },
      activity: [...this.activity]
    });
  }

  public selectAgent(value: unknown): DesignerSnapshot {
    const id = validateDesignerIdentifier(value, 'agentId');
    if (!this.agents.has(id)) throw new DesignerApplicationError(`unknown agent: ${id}`);
    this.selectedAgentId = id;
    this.activity.unshift(`Selected ${id}.`);
    return this.snapshot();
  }

  public selectScenario(value: unknown): DesignerSnapshot {
    const id = validateDesignerIdentifier(value, 'scenarioId');
    if (!enterpriseScenarioFixtures.some((scenario) => scenario.id === id))
      throw new DesignerApplicationError(`unknown scenario: ${id}`);
    this.selectedScenarioId = id;
    this.activity.unshift(`Loaded scenario ${id}.`);
    return this.snapshot();
  }

  public selectNode(value: unknown): DesignerSnapshot {
    const nodeId = validateDesignerIdentifier(value, 'nodeId');
    if (!this.source.nodes.some((node) => node.nodeId === nodeId))
      throw new DesignerApplicationError(`unknown source node: ${nodeId}`);
    this.selectedNodeId = nodeId;
    return this.snapshot();
  }

  /** Renderer submits a complete portable graph; parsing rejects malformed ports and edges atomically. */
  public savePrototypeGraph(value: unknown): Promise<DesignerSnapshot> {
    return this.enqueueGraphOperation(async () => {
      if (this.graphHydration.state === 'recovery-required')
        throw new DesignerApplicationError(
          'Saved graph recovery is required before edits can be persisted.'
        );
      const graph = parsePrototypeGraph(value);
      const projectId = this.source.projectId;
      if (graph.project.projectId !== projectId)
        throw new DesignerApplicationError(
          'Saved graph belongs to a project that is no longer active.'
        );
      const revision = this.graphRevision;
      const generation = this.projectGeneration;
      const saved = await this.graphPersistence.compareAndSwap(projectId, revision, graph);
      if (
        this.projectGeneration !== generation ||
        this.source.projectId !== projectId ||
        this.graphRevision !== revision
      )
        throw new DesignerApplicationError(
          'Saved graph belongs to a project that is no longer active.'
        );
      this.graph = saved.graph;
      this.graphRevision = saved.revision;
      this.reactBinding = undefined;
      this.revokeManualReactEditAuthority();
      this.pendingReactBinding = undefined;
      this.graphHydration = { state: 'persisted' };
      this.prototypeRuntime = undefined;
      this.activity.unshift(`Saved flow graph revision ${this.graphRevision}.`);
      return this.snapshot();
    });
  }

  public retryPrototypeGraphHydration(): Promise<DesignerSnapshot> {
    return this.enqueueGraphOperation(async () => {
      await this.hydratePrototypeGraphUnlocked(true);
      return this.snapshot();
    });
  }

  public recoverPrototypeGraphFromFixture(): Promise<DesignerSnapshot> {
    return this.enqueueGraphOperation(async () => {
      if (this.graphHydration.state !== 'recovery-required')
        throw new DesignerApplicationError('No graph recovery is required.');
      const result = await this.graphPersistence.recoverFromFixture(
        this.source.projectId,
        freshPrototypeGraphForWorkspace(this.source)
      );
      this.graph = result.saved.graph;
      this.graphRevision = result.saved.revision;
      this.reactBinding = undefined;
      this.revokeManualReactEditAuthority();
      this.pendingReactBinding = undefined;
      this.prototypeRuntime = undefined;
      this.graphMode = 'edit';
      this.graphHydration = {
        state: 'persisted',
        recovery: result.receipt
      };
      this.activity.unshift(
        `Recovered the fixture at revision ${result.saved.revision}; preserved ${result.receipt.recoveryId}.`
      );
      return this.snapshot();
    });
  }

  public setPrototypeMode(value: unknown): DesignerSnapshot {
    if (value !== 'edit' && value !== 'run')
      throw new DesignerApplicationError('prototype mode is invalid');
    this.graphMode = value;
    this.prototypeRuntime = value === 'run' ? new PrototypeRuntime(this.graph) : undefined;
    this.activity.unshift(`${value === 'run' ? 'Running' : 'Editing'} the host-owned flow graph.`);
    return this.snapshot();
  }
  /** Starts a declared graph scenario; node selection remains flow-owned by PrototypeRuntime. */
  public startPrototypeScenario(value: unknown): Promise<DesignerSnapshot> {
    return this.enqueueGraphOperation(async () => {
      if (this.graphHydration.state === 'recovery-required')
        throw new DesignerApplicationError('Recover the saved graph before starting a scenario.');
      const request = validatePrototypeScenarioStart(value);
      if (request.projectId !== this.source.projectId)
        throw new DesignerApplicationError(
          'Scenario start belongs to a project that is no longer active.'
        );
      if (request.graphRevision !== this.graphRevision)
        throw new DesignerApplicationError(
          'Scenario start is stale for the current saved graph revision.'
        );
      // Construct before assigning either field so malformed or stale scenario IDs cannot
      // partially switch the service into run mode.
      const runtime = new PrototypeRuntime(this.graph, request.scenarioId);
      this.graphMode = 'run';
      this.prototypeRuntime = runtime;
      this.activity.unshift(`Started saved graph scenario ${request.scenarioId}.`);
      return this.snapshot();
    });
  }
  public runPrototypeAction(value: unknown): DesignerSnapshot {
    if (this.graphMode !== 'run' || !this.prototypeRuntime)
      throw new DesignerApplicationError('prototype is not in run mode');
    const action = validatePrototypeRunAction(value);
    this.prototypeRuntime.dispatch({ type: 'trigger', ...action });
    return this.snapshot();
  }
  public resetPrototypeRun(): DesignerSnapshot {
    if (this.graphMode !== 'run' || !this.prototypeRuntime)
      throw new DesignerApplicationError('prototype is not in run mode');
    const { scenarioId } = this.prototypeRuntime.snapshot();
    this.prototypeRuntime = new PrototypeRuntime(this.graph, scenarioId);
    return this.snapshot();
  }

  /**
   * Review anchors belong to the rendered screen, never to a renderer-supplied
   * identifier. States inherit their parent screen; overlays leave the current
   * screen unchanged in PrototypeRuntime, so the active node remains the
   * authoritative screen identity.
   */
  private currentRenderedArtifactIdentity(): {
    readonly screenId: string;
    readonly scenarioId: string;
    readonly state: string;
  } {
    const runtime = this.prototypeRuntime?.snapshot();
    const activeNodeId = runtime?.activeNodeId ?? this.graph.initialNodeId;
    const activeNode = this.graph.nodes.find((node) => node.id === activeNodeId);
    const screenId =
      activeNode?.kind === 'state'
        ? activeNode.parentId
        : activeNode?.kind === 'screen' || activeNode?.kind === 'page'
          ? activeNode.id
          : this.graph.initialNodeId;
    const scenarioId = runtime?.scenarioId ?? this.selectedScenarioId;
    const scenario = enterpriseScenarioFixtures.find((item) => item.id === scenarioId);
    return {
      screenId,
      scenarioId,
      state: runtime?.activeStateId ?? scenario?.state ?? 'default'
    };
  }

  /** Capability/consent-gated adapter owns publication; renderer receives an immutable receipt only. */
  private async captureImmutablePublishBundle(): Promise<ImmutablePublishBundle> {
    const metadata = await this.handoffMetadata.load();
    return createImmutablePublishBundle({
      projectId: this.source.projectId,
      source: this.source,
      prototype: { graph: this.graph, revision: this.graphRevision },
      scenarios: enterpriseScenarioFixtures,
      collaborationSnapshot: serializeSnapshot(this.collaboration),
      designInputProvenance: this.designInputProvenance,
      componentCatalog: componentCatalogFor(
        this.source,
        this.setupReceipts(),
        currentComponentCatalogArtifacts(this.componentCatalogManifests, this.source, this.graph),
        this.storyPreviews,
        currentFederatedComponentCatalog(this.componentCatalogManifests, this.productMap)
      ),
      packageProvenance: metadata
    });
  }
  private async captureImmutablePublishPlan(): Promise<{
    readonly bundle: ImmutablePublishBundle;
    readonly plan: import('./generated-project-template').GeneratedProjectFilePlan;
  }> {
    const bundle = await this.captureImmutablePublishBundle();
    return { bundle, plan: this.projectTemplate.create(bundle) };
  }
  private publishConsentBinding(
    request: DesignerPublishConsentInput | DesignerPublishInput,
    bundle: ImmutablePublishBundle,
    plan: import('./generated-project-template').GeneratedProjectFilePlan,
    adapter: GeneratedCodePublishPort
  ): PublishConsentBinding {
    const common = {
      title: request.title,
      projectId: bundle.projectId,
      sourceRevisionId: bundle.sourceRevisionId,
      graphRevision: bundle.graphRevision,
      bundleDigest: bundle.bundleDigest,
      filePlanDigest: plan.filePlanDigest,
      adapterId: adapter.id
    } as const;
    return request.mode === 'github-remote'
      ? {
          ...common,
          mode: 'github-remote',
          repository: request.repository,
          ...(request.provisioning === undefined ? {} : { provisioning: request.provisioning })
        }
      : { ...common, mode: 'local-preview' };
  }
  public requestGeneratedCodePublishConsent(
    value: unknown
  ): Promise<{ readonly consentId: string }> {
    const request = validateDesignerPublishConsent(value);
    if (this.pendingAIProposal !== undefined)
      return Promise.reject(
        new DesignerApplicationError(
          'Accept or reject the staged AI proposal before publishing this design.'
        )
      );
    if (
      this.publishConsentRequestActive ||
      [...this.publishOperations.values()].some((operation) => operation.status === 'running')
    )
      return Promise.reject(new DesignerApplicationError('a publish start is already active'));
    this.publishConsentRequestActive = true;
    return this.enqueueGraphOperation(async () => {
      const adapter = this.publishers.select(request.mode);
      const { bundle, plan } = await this.captureImmutablePublishPlan();
      const binding = this.publishConsentBinding(request, bundle, plan, adapter);
      const consentDigest = publishConsentDigest(binding);
      const now = Date.now();
      const pending = this.pendingPublishConsent;
      if (pending !== undefined && pending.expiresAt > now) {
        if (pending.digest === consentDigest) return { consentId: pending.consentId };
        throw new DesignerApplicationError(
          'a different publish target is already awaiting consent consumption'
        );
      }
      this.pendingPublishConsent = undefined;
      const grant = await this.publishConsent.request(binding);
      const grantedAt = Date.now();
      if (
        typeof grant.consentId !== 'string' ||
        grant.consentId.length === 0 ||
        !Number.isFinite(grant.expiresAt) ||
        grant.expiresAt <= grantedAt ||
        grant.expiresAt >
          grantedAt + DesktopDesignerApplicationService.maximumPublishConsentLifetimeMs
      )
        throw new DesignerApplicationError('trusted publish consent grant is invalid');
      this.pendingPublishConsent = Object.freeze({
        consentId: grant.consentId,
        digest: consentDigest,
        expiresAt: grant.expiresAt
      });
      return { consentId: grant.consentId };
    }).finally(() => {
      this.publishConsentRequestActive = false;
    });
  }

  public publishGeneratedCode(value: unknown): { readonly id: string; readonly status: 'running' } {
    const request = validateDesignerPublish(value);
    if (this.pendingAIProposal !== undefined)
      throw new DesignerApplicationError(
        'Accept or reject the staged AI proposal before publishing this design.'
      );
    if ([...this.publishOperations.values()].some((operation) => operation.status === 'running'))
      throw new DesignerApplicationError('a publish operation is already active');
    const pendingConsent = this.pendingPublishConsent;
    if (
      pendingConsent === undefined ||
      pendingConsent.consentId !== request.consentId ||
      pendingConsent.expiresAt <= Date.now()
    ) {
      this.pendingPublishConsent = undefined;
      throw new DesignerApplicationError('publish consent is missing or expired');
    }
    for (const [existingId, existing] of this.publishOperations) {
      if (this.publishOperations.size < DesktopDesignerApplicationService.maximumPublishOperations)
        break;
      if (existing.status !== 'running') this.publishOperations.delete(existingId);
    }
    if (this.publishOperations.size >= DesktopDesignerApplicationService.maximumPublishOperations)
      throw new DesignerApplicationError('too many active or retained publish operations');
    const id = `publish-${++this.sequence}`;
    const controller = new AbortController();
    const operation: PublishOperationState = {
      request,
      controller,
      status: 'running' as const,
      progress: ['Queued host-owned publish.']
    };
    this.publishOperations.set(id, operation);
    void (async () => {
      try {
        const prepared = await this.enqueueGraphOperation(async () => {
          const adapter = this.publishers.select(request.mode);
          const { bundle, plan } = await this.captureImmutablePublishPlan();
          try {
            await this.publishConsent.consume(
              request.consentId,
              this.publishConsentBinding(request, bundle, plan, adapter)
            );
          } finally {
            if (this.pendingPublishConsent?.consentId === request.consentId)
              this.pendingPublishConsent = undefined;
          }
          return { adapter, bundle, plan };
        });
        const publishRequest: GeneratedCodePublishRequest =
          request.mode === 'github-remote'
            ? {
                repository: request.repository,
                title: request.title,
                mode: 'github-remote',
                bundle: prepared.bundle,
                plan: prepared.plan,
                ...(request.provisioning === undefined
                  ? {}
                  : { provisioning: request.provisioning })
              }
            : {
                title: request.title,
                mode: 'local-preview',
                bundle: prepared.bundle,
                plan: prepared.plan
              };
        let receipt = await prepared.adapter.publish(publishRequest, {
          signal: controller.signal,
          progress: (message) => {
            operation.progress = [...operation.progress, message.slice(0, 512)].slice(
              -DesktopDesignerApplicationService.maximumPublishProgress
            );
          }
        });
        if (receipt.mode === 'github-remote') {
          operation.progress = [
            ...operation.progress,
            'Preparing immutable stakeholder-review synchronization.'
          ].slice(-DesktopDesignerApplicationService.maximumPublishProgress);
          const collaboration = await this.synchronizeHostedStakeholderReview(
            prepared.bundle,
            prepared.plan,
            receipt,
            controller.signal
          );
          receipt = Object.freeze({
            ...receipt,
            hostedReview: Object.freeze({ ...receipt.hostedReview, collaboration })
          });
        }
        operation.status = 'succeeded';
        operation.receipt = receipt;
        this.activity.unshift(
          receipt.mode === 'github-remote'
            ? receipt.hostedReview.collaboration.status === 'ready'
              ? `Remote publish ${receipt.immutableId} completed with stakeholder review ready.`
              : `Remote publish ${receipt.immutableId} completed; stakeholder collaboration is ${receipt.hostedReview.collaboration.status}.`
            : receipt.validation === 'materialized-lock'
              ? `Local generated project ${receipt.immutableId} was materialized and lock-validated; its temporary lease was removed while the isolated app cache remains.`
              : `Local immutable bundle ${receipt.immutableId} was fixture-validated without project materialization.`
        );
      } catch (error) {
        const code = publishOperationErrorCode(error);
        operation.status =
          code === 'CANCELLED' || (controller.signal.aborted && code === 'UNKNOWN')
            ? 'cancelled'
            : 'failed';
        operation.error = {
          code,
          message: publishOperationErrorMessages[code],
          retryable: code === 'SETUP_REQUIRED'
        };
      }
    })();
    return { id, status: 'running' };
  }

  public cancelGeneratedCodePublish(value: unknown): void {
    const id = validateDesignerIdentifier(value, 'publishId');
    const operation = this.publishOperations.get(id);
    if (operation?.status !== 'running')
      throw new DesignerApplicationError(`no active publish: ${id}`);
    operation.cancellationRequested = true;
    operation.progress = [...operation.progress, 'Cancellation requested.'].slice(
      -DesktopDesignerApplicationService.maximumPublishProgress
    );
    operation.controller.abort();
  }
  public publishOperation(value: unknown) {
    const id = validateDesignerIdentifier(value, 'publishId');
    const operation = this.publishOperations.get(id);
    if (!operation) throw new DesignerApplicationError(`unknown publish: ${id}`);
    return structuredClone({
      id,
      status: operation.status,
      progress: operation.progress,
      cancellationRequested: operation.cancellationRequested,
      receipt: operation.receipt,
      error: operation.error
    });
  }

  /** Review threads are distinct deployed-artifact discussion data; node metadata is optional. */
  public addReviewThread(value: unknown): Promise<DesignerSnapshot> {
    return this.enqueueGraphOperation(() =>
      this.mutateDurably(async () => {
        const discussion = validateReviewThread(value);
        if (
          discussion.anchor.nodeRef !== undefined &&
          !this.source.nodes.some((node) => node.nodeId === discussion.anchor.nodeRef)
        )
          throw new DesignerApplicationError(
            `discussion references unknown node: ${discussion.anchor.nodeRef}`
          );
        const scenario = enterpriseScenarioFixtures.find(
          (item) => item.id === this.selectedScenarioId
        );
        if (scenario === undefined)
          throw new DesignerApplicationError('selected scenario is unavailable');
        const artifact = this.currentRenderedArtifactIdentity();
        this.reviewThreads.push({
          id: `review-${this.reviewThreads.length + 1}`,
          status: 'open',
          body: discussion.body,
          replies: [],
          author: this.collaborationAuthorId,
          createdAt: new Date().toISOString(),
          anchor: {
            ...discussion.anchor,
            artifactId: this.source.projectId,
            screenId: artifact.screenId,
            scenarioId: artifact.scenarioId,
            state: artifact.state,
            revisionId: this.source.revision.id
          }
        });
        this.activity.unshift('Added a spatial discussion thread.');
        this.appendCanonicalReview(this.reviewThreads.at(-1)!);
        await this.persistProjectState();
        return this.snapshot();
      })
    );
  }
  /** Resolution is explicit and reversible; it never mutates an artifact pin or AI target. */
  public resolveReviewThread(value: unknown): Promise<DesignerSnapshot> {
    return this.enqueueGraphOperation(() =>
      this.mutateDurably(async () => {
        const request = validateReviewThreadResolution(value);
        const projectedThreads = projectRendererState(this.collaboration).reviewThreads;
        const index = projectedThreads.findIndex((thread) => thread.id === request.id);
        if (index < 0) throw new DesignerApplicationError(`unknown review thread: ${request.id}`);
        const thread = projectedThreads[index]!;
        if ((thread.status === 'resolved') === request.resolved) return this.snapshot();
        const canonical = this.collaboration.reviewThreads.find((item) => item.id === request.id);
        if (canonical !== undefined)
          this.replaceCollaboration({
            ...this.collaboration,
            reviewThreads: this.collaboration.reviewThreads.map((item) => {
              if (item.id !== request.id) return item;
              if (request.resolved) {
                const resolvedAt = strictlyLaterTimestamp(item.reopenedAt ?? item.createdAt);
                return {
                  ...item,
                  lifecycle: 'resolved',
                  resolvedAt,
                  resolvedBy: this.collaborationAuthorId
                };
              }
              if (item.resolvedAt === undefined)
                throw new DesignerApplicationError(
                  'Resolved review thread is missing canonical resolution time.'
                );
              const { resolvedAt: _resolvedAt, resolvedBy: _resolvedBy, ...open } = item;
              return {
                ...open,
                lifecycle: 'open',
                reopenedAt: strictlyLaterTimestamp(item.resolvedAt),
                reopenedBy: this.collaborationAuthorId
              };
            })
          });
        this.activity.unshift(
          `${request.resolved ? 'Resolved' : 'Reopened'} spatial discussion ${request.id}.`
        );
        await this.persistProjectState();
        return this.snapshot();
      })
    );
  }
  public replyToReviewThread(value: unknown): Promise<DesignerSnapshot> {
    return this.enqueueGraphOperation(() =>
      this.mutateDurably(async () => {
        const request = validateReviewThreadReply(value);
        const projectedThreads = projectRendererState(this.collaboration).reviewThreads;
        const index = projectedThreads.findIndex((thread) => thread.id === request.id);
        if (index < 0) throw new DesignerApplicationError(`unknown review thread: ${request.id}`);
        const thread = projectedThreads[index]!;
        if (thread.status === 'resolved')
          throw new DesignerApplicationError('Reopen the review thread before replying.');
        const reply = {
          id: `${thread.id}-reply-${thread.replies.length + 1}`,
          body: request.body,
          author: this.collaborationAuthorId,
          createdAt: new Date().toISOString()
        };
        this.replaceCollaboration({
          ...this.collaboration,
          reviewThreads: this.collaboration.reviewThreads.map((item) =>
            item.id !== request.id
              ? item
              : {
                  ...item,
                  messages: [
                    ...item.messages,
                    {
                      id: reply.id,
                      body: reply.body,
                      createdBy: reply.author,
                      createdAt: reply.createdAt,
                      parentMessageId: item.messages[0]!.id,
                      mentionedUserIds: [],
                      reactions: [],
                      readBy: []
                    }
                  ]
                }
          )
        });
        this.activity.unshift(`Replied to spatial discussion ${request.id}.`);
        await this.persistProjectState();
        return this.snapshot();
      })
    );
  }
  /** Developer annotations are categorised handoff directions, distinct from discussion threads. */
  public addDeveloperAnnotation(value: unknown): Promise<DesignerSnapshot> {
    return this.enqueueGraphOperation(() =>
      this.mutateDurably(async () => {
        const annotation = validateDeveloperAnnotation(value);
        if (
          annotation.nodeRef !== undefined &&
          !this.source.nodes.some((node) => node.nodeId === annotation.nodeRef)
        )
          throw new DesignerApplicationError(
            `annotation references unknown node: ${annotation.nodeRef}`
          );
        this.developerAnnotations.push({
          id: `annotation-${this.developerAnnotations.length + 1}`,
          ...annotation,
          createdAt: new Date().toISOString()
        });
        const saved = this.developerAnnotations.at(-1)!;
        const category =
          saved.category === 'implementation'
            ? 'development'
            : saved.category === 'behavior'
              ? 'interaction'
              : saved.category === 'visual'
                ? 'content'
                : 'accessibility';
        this.replaceCollaboration({
          ...this.collaboration,
          developerAnnotations: [
            ...this.collaboration.developerAnnotations,
            {
              id: saved.id,
              projectId: this.source.projectId,
              anchor: this.canonicalAnchor(currentAnchor(this.source)),
              category,
              body: saved.body,
              createdBy: this.collaborationAuthorId,
              createdAt: saved.createdAt
            }
          ]
        });
        this.activity.unshift(`Added ${annotation.category} developer annotation.`);
        await this.persistProjectState();
        return this.snapshot();
      })
    );
  }

  private async resolveGenerationContext(
    projectId: string,
    generation: number
  ): Promise<DesignerGenerationContext> {
    if (this.designInputProvenance.projectId !== projectId)
      throw new DesignerApplicationError('Design inputs belong to another project.');
    const packages = (this.designInputProvenance.designSystems ?? [])
      .filter((input) => input.enabled)
      .map((input) => input.receipt)
      .map(({ packageName, version, exports, artifactDigest, provenance }) =>
        Object.freeze({
          packageName,
          version,
          exports: Object.freeze([...exports]),
          artifactDigest,
          provenance: Object.freeze({ ...provenance })
        })
      );
    const languages = (this.designInputProvenance.designLanguages ?? []).filter(
      (input) => input.enabled
    );
    let totalBytes = 0;
    const guidance = [];
    for (const language of languages) {
      // eslint-disable-next-line no-await-in-loop -- Guidance resolution preserves enabled order.
      const markdown = await this.designLanguageGuidance.resolve(projectId, language.id);
      if (
        markdown === undefined ||
        createHash('sha256').update(markdown).digest('hex') !== language.receipt.artifactDigest
      )
        throw new DesignerApplicationError(
          'Active design-language guidance is unavailable or invalid.'
        );
      totalBytes += Buffer.byteLength(markdown, 'utf8');
      if (totalBytes > 256 * 1024)
        throw new DesignerApplicationError(
          'Active design-language guidance exceeds the bounded limit.'
        );
      guidance.push(Object.freeze({ artifactDigest: language.id, markdown }));
    }
    if (this.projectGeneration !== generation || this.source.projectId !== projectId)
      throw new DesignerApplicationError(
        'Project changed while design-language guidance was resolved.'
      );
    return Object.freeze({ packages: Object.freeze(packages), guidance: Object.freeze(guidance) });
  }

  /** Runs a local AI request through the selected adapter and records its complete lifecycle. */
  public async requestAIChange(value: unknown): Promise<DesignerSnapshot> {
    const start = await this.enqueueGraphOperation(() =>
      this.mutateDurably(async () => {
        const input = validateAIChangeRequest(value);
        if (this.active !== undefined)
          throw new DesignerApplicationError('an agent request is already running');
        if (this.pendingAIProposal !== undefined)
          throw new DesignerApplicationError(
            'Accept or reject the current AI proposal before starting another request'
          );
        const selected = this.agents.get(input.agentId);
        if (selected === undefined)
          throw new DesignerApplicationError(`unknown agent: ${input.agentId}`);
        const selectedScenario = enterpriseScenarioFixtures.find(
          (item) => item.id === this.selectedScenarioId
        );
        if (selectedScenario === undefined)
          throw new DesignerApplicationError('selected scenario is unavailable');
        const id = `desktop-request-${randomUUID()}`;
        const controller = new AbortController();
        const projectId = this.source.projectId;
        const generation = this.projectGeneration;
        const sourceRevisionId = this.source.revision.id;
        const target = {
          ...input.target,
          artifactId: projectId,
          screenId: 'desktop-designer',
          scenarioId: selectedScenario.id,
          state: selectedScenario.state,
          revisionId: sourceRevisionId
        };
        this.active = { id, controller };
        const createdAt = new Date().toISOString();
        this.aiChangeRequests.push({
          id,
          agentId: input.agentId,
          instruction: input.instruction,
          target,
          status: 'running',
          createdAt
        });
        this.replaceCollaboration({
          ...this.collaboration,
          aiChangeRequests: [
            ...this.collaboration.aiChangeRequests,
            {
              id,
              projectId,
              anchor: this.canonicalAnchor(target),
              instruction: input.instruction,
              provider: { providerId: input.agentId, capability: 'react.revise' },
              baseRevision: { id: sourceRevisionId, fingerprint: digest(this.source) },
              lifecycle: 'running',
              createdBy: this.collaborationAuthorId,
              createdAt,
              updatedAt: createdAt
            }
          ]
        });
        await this.persistProjectState();
        return {
          input,
          adapter: selected,
          scenario: selectedScenario,
          id,
          controller,
          projectId,
          generation,
          sourceRevisionId,
          target
        };
      })
    );
    const {
      input,
      adapter,
      scenario,
      id,
      controller,
      projectId,
      generation,
      sourceRevisionId,
      target
    } = start;
    this.emit({
      requestId: id,
      agentId: input.agentId,
      stage: 'started',
      message: 'Agent request started.'
    });
    try {
      const proposal = {
        instruction: input.instruction,
        target,
        workspace: this.source,
        scenario,
        signal: controller.signal,
        progress: (message: string) =>
          this.emit({ requestId: id, agentId: input.agentId, stage: 'thinking', message })
      };
      const generationContext = await this.resolveGenerationContext(projectId, generation);
      const patch = await adapter.propose({ ...proposal, generationContext });
      if (controller.signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
      if (
        this.projectGeneration !== generation ||
        this.source.projectId !== projectId ||
        this.source.revision.id !== sourceRevisionId
      )
        throw new DesignerApplicationError(
          'Agent result belongs to a project that is no longer active.'
        );
      this.emit({
        requestId: id,
        agentId: input.agentId,
        stage: 'applying',
        message: 'Validating source patch.'
      });
      return await this.enqueueGraphOperation(() =>
        this.mutateDurably(async () => {
          if (
            this.projectGeneration !== generation ||
            this.source.projectId !== projectId ||
            this.source.revision.id !== sourceRevisionId
          )
            throw new DesignerApplicationError(
              'Agent result belongs to a project that is no longer active.'
            );
          const candidateWorkspace = applyAgentSourcePatch(this.source, patch, {
            id: `desktop-proposal-${id}`,
            createdAt: new Date().toISOString()
          });
          const evidence = await this.manualEditTransaction.compileWorkspace?.(candidateWorkspace);
          if (evidence === undefined)
            throw new DesignerApplicationError('Agent proposal did not compile successfully.');
          const candidateFingerprint = digest(candidateWorkspace);
          this.pendingAIProposal = Object.freeze({
            format: 'selene-local-pending-ai-proposal/v1',
            requestId: id,
            agentId: input.agentId,
            scenarioId: scenario.id,
            baseRevisionId: this.source.revision.id,
            baseFingerprint: digest(this.source),
            candidateWorkspace,
            candidateFingerprint,
            summary: patch.summary.slice(0, 1_000),
            createdAt: candidateWorkspace.revision.createdAt
          });
          this.replaceCollaboration({
            ...this.collaboration,
            aiChangeRequests: this.collaboration.aiChangeRequests.map((request) =>
              request.id !== id
                ? request
                : {
                    ...request,
                    updatedAt: candidateWorkspace.revision.createdAt
                  }
            )
          });
          this.updateRequest(id, { status: 'reviewing' });
          await this.persistProjectState();
          this.activity.unshift(`Staged ${candidateWorkspace.revision.id}: ${patch.summary}`);
          this.emit({
            requestId: id,
            agentId: input.agentId,
            stage: 'completed',
            message: 'Compiled proposal ready for review.'
          });
          return this.snapshot();
        })
      );
    } catch (error) {
      // The diagnostics boundary receives the hostile error object only to discard it.
      // Persisting diagnostic failures must never replace the original operation result.
      try {
        await this.diagnostics?.capture('service', 'operation-failure', error);
      } catch {
        // Local recovery remains available even when its optional persistence is unavailable.
      }
      const cancelled =
        controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
      this.updateRequest(id, {
        status: cancelled ? 'cancelled' : 'failed',
        ...(cancelled
          ? {}
          : { error: error instanceof Error ? error.message : 'Agent request failed.' })
      });
      this.replaceCollaboration({
        ...this.collaboration,
        aiChangeRequests: this.collaboration.aiChangeRequests.map((request) =>
          request.id !== id
            ? request
            : {
                ...request,
                lifecycle: cancelled ? 'cancelled' : 'failed',
                updatedAt: new Date().toISOString(),
                ...(cancelled
                  ? {}
                  : {
                      failureReason:
                        error instanceof Error ? error.message : 'Agent request failed.'
                    })
              }
        )
      });
      await this.persistProjectStateSerialized();
      this.emit({
        requestId: id,
        agentId: input.agentId,
        stage: cancelled ? 'cancelled' : 'error',
        message: cancelled
          ? 'Agent request cancelled.'
          : error instanceof Error
            ? error.message
            : 'Agent request failed.'
      });
      throw error;
    } finally {
      this.active = undefined;
    }
  }

  private requirePendingAIProposal(value: unknown): {
    readonly input: AIProposalDecisionInput;
    readonly proposal: LocalPendingAIProposal;
  } {
    const input = validateAIProposalDecision(value);
    const proposal = this.pendingAIProposal;
    if (
      proposal === undefined ||
      input.projectId !== this.source.projectId ||
      proposal.requestId !== input.requestId ||
      proposal.candidateWorkspace.revision.id !== input.candidateRevisionId
    )
      throw new DesignerApplicationError(
        'AI proposal is unavailable or belongs to another revision'
      );
    if (
      proposal.baseRevisionId !== this.source.revision.id ||
      proposal.baseFingerprint !== digest(this.source) ||
      proposal.candidateWorkspace.projectId !== this.source.projectId ||
      proposal.candidateWorkspace.revision.parentId !== this.source.revision.id ||
      proposal.candidateFingerprint !== digest(proposal.candidateWorkspace)
    )
      throw new DesignerApplicationError('AI proposal base revision is stale');
    return { input, proposal };
  }

  /** Host-only candidate lookup used by the preview compiler IPC adapter. */
  public pendingAIProposalWorkspace(value: unknown): ReactSourceWorkspace {
    return structuredClone(this.requirePendingAIProposal(value).proposal.candidateWorkspace);
  }

  public acceptPendingAIProposal(value: unknown): Promise<DesignerSnapshot> {
    return this.enqueueGraphOperation(() =>
      this.mutateDurably(async () => {
        if (this.active !== undefined)
          throw new DesignerApplicationError('an agent request is already running');
        const { input, proposal } = this.requirePendingAIProposal(value);
        const request = this.collaboration.aiChangeRequests.find(
          (candidate) => candidate.id === input.requestId
        );
        if (request === undefined || request.lifecycle !== 'running')
          throw new DesignerApplicationError('AI proposal request lifecycle is invalid');
        const previous = this.source;
        this.source = proposal.candidateWorkspace;
        this.reactBinding = undefined;
        this.revokeManualReactEditAuthority();
        this.pendingReactBinding = undefined;
        this.pendingAIProposal = undefined;
        this.baseline = executeDesignBaselineCommand(this.baseline, {
          type: 'apply-design-mutation',
          change: {
            id: `design-change-${proposal.requestId}`,
            kind: 'source',
            beforeRevision: { id: previous.revision.id, fingerprint: digest(previous) },
            currentRevision: { id: this.source.revision.id, fingerprint: digest(this.source) },
            affected: {
              projectId: this.source.projectId,
              screenIds: ['desktop-designer'],
              routePaths: ['/'],
              scenarioIds: [proposal.scenarioId],
              componentIds: ['App'],
              stableNodeIds: this.source.nodes.map((node) => node.nodeId)
            },
            evidence: [{ description: 'Designer accepted a compiled agent proposal.' }],
            provenance: {
              kind: 'agent',
              agentId: proposal.agentId,
              promptDigest: `local:${proposal.requestId}`
            },
            occurredAt: this.source.revision.createdAt,
            reason: proposal.summary
          }
        });
        const revision = {
          id: this.source.revision.id,
          projectId: this.source.projectId,
          sequence: this.collaboration.revisions.length + 1,
          parentRevisionId: previous.revision.id,
          content: this.source,
          contentSha256: digest(this.source),
          scenarioIds: enterpriseScenarioFixtures.map((item) => item.id),
          createdBy: this.collaborationAuthorId,
          createdAt: this.source.revision.createdAt
        };
        this.replaceCollaboration({
          ...this.collaboration,
          revisions: [...this.collaboration.revisions, revision],
          designReviewState: toCollaborationDesignReviewState(this.baseline),
          aiChangeRequests: this.collaboration.aiChangeRequests.map((candidate) =>
            candidate.id !== input.requestId
              ? candidate
              : {
                  ...candidate,
                  lifecycle: 'applied',
                  updatedAt: this.source.revision.createdAt,
                  result: {
                    revisionId: revision.id,
                    revisionFingerprint: revision.contentSha256,
                    diff: proposal.summary,
                    completedAt: this.source.revision.createdAt
                  }
                }
          )
        });
        this.updateRequest(input.requestId, {
          status: 'applied',
          resultingRevisionId: revision.id
        });
        await this.persistAppliedRevision();
        this.activity.unshift(`Accepted ${revision.id}: ${proposal.summary}`);
        return this.snapshot();
      })
    );
  }

  public rejectPendingAIProposal(value: unknown): Promise<DesignerSnapshot> {
    return this.enqueueGraphOperation(() =>
      this.mutateDurably(async () => {
        if (this.active !== undefined)
          throw new DesignerApplicationError('an agent request is already running');
        const { input } = this.requirePendingAIProposal(value);
        const rejectedAt = new Date().toISOString();
        this.pendingAIProposal = undefined;
        this.replaceCollaboration({
          ...this.collaboration,
          aiChangeRequests: this.collaboration.aiChangeRequests.map((candidate) =>
            candidate.id !== input.requestId
              ? candidate
              : { ...candidate, lifecycle: 'cancelled', updatedAt: rejectedAt }
          )
        });
        this.updateRequest(input.requestId, { status: 'cancelled' });
        await this.persistProjectState();
        this.activity.unshift(`Rejected AI proposal ${input.requestId}.`);
        return this.snapshot();
      })
    );
  }

  /**
   * Compensates the current manual edit with a new compiled child revision.
   * The renderer supplies only receipt identity; source recovery stays host-owned.
   */
  public async undoLatestManualDesignEdit(value: unknown): Promise<DesignerSnapshot> {
    if (this.undoActive) throw new DesignerApplicationError('a design undo is already running');
    this.undoActive = true;
    try {
      return await this.enqueueGraphOperation(() =>
        this.mutateDurably(async () => {
          const input: ManualDesignUndoInput = validateManualDesignUndo(value);
          if (this.active !== undefined)
            throw new DesignerApplicationError('an agent request is already running');
          if (this.pendingAIProposal !== undefined)
            throw new DesignerApplicationError(
              'Accept or reject the staged AI proposal before undoing a manual change.'
            );
          if (input.projectId !== this.source.projectId)
            throw new DesignerApplicationError(
              'manual undo request belongs to a different project'
            );
          if (this.projectState === undefined)
            throw new DesignerApplicationError('manual undo persistence is unavailable');
          const authority = this.manualReactEditAuthority;
          const entry = this.manualReactEditJournal?.at(-1);
          if (
            authority === undefined ||
            entry === undefined ||
            (entry.lifecycle ?? 'applied') !== 'applied' ||
            entry.receipt.undo.undoId !== input.undoId ||
            entry.targetRevisionId !== input.targetRevisionId
          )
            throw new DesignerApplicationError('only the latest applied manual edit may be undone');
          if (
            authority.workspaceRevisionId !== this.source.revision.id ||
            authority.designRevision.revisionId !== entry.targetRevisionId ||
            entry.receipt.targetRevision.revisionCommitment !==
              authority.designRevision.revisionCommitment
          )
            throw new DesignerApplicationError(
              'manual edit is no longer the current design revision'
            );
          const latestCanonical = this.collaboration.revisions.at(-1);
          const base = this.collaboration.revisions.find(
            (revision) => revision.id === latestCanonical?.parentRevisionId
          );
          if (
            latestCanonical === undefined ||
            base === undefined ||
            latestCanonical.id !== this.source.revision.id ||
            latestCanonical.contentSha256 !== digest(this.source) ||
            latestCanonical.parentRevisionId !== this.source.revision.parentId ||
            base.projectId !== input.projectId
          )
            throw new DesignerApplicationError(
              'manual edit base revision is unavailable or invalid'
            );
          let latestContent: ReactSourceWorkspace;
          let baseContent: ReactSourceWorkspace;
          try {
            validateReactSourceWorkspace(latestCanonical.content as ReactSourceWorkspace);
            validateReactSourceWorkspace(base.content as ReactSourceWorkspace);
            latestContent = latestCanonical.content as ReactSourceWorkspace;
            baseContent = base.content as ReactSourceWorkspace;
          } catch {
            throw new DesignerApplicationError(
              'manual edit base revision is unavailable or invalid'
            );
          }
          if (
            latestContent.revision.id !== this.source.revision.id ||
            digest(latestContent) !== latestCanonical.contentSha256 ||
            baseContent.projectId !== input.projectId ||
            baseContent.revision.id !== base.id ||
            digest(baseContent) !== base.contentSha256
          )
            throw new DesignerApplicationError(
              'manual edit base revision is unavailable or invalid'
            );
          const createdAt = strictlyLaterTimestamp(
            this.source.revision.createdAt,
            latestCanonical.createdAt,
            entry.receipt.appliedAt
          );
          const restored = Object.freeze({
            ...baseContent,
            revision: Object.freeze({
              id: `manual-undo-${randomUUID()}`,
              parentId: this.source.revision.id,
              createdAt,
              summary: 'Undo latest manual design edit'
            })
          });
          validateReactSourceWorkspace(restored);
          const evidence = await this.manualEditTransaction.compileWorkspace?.(restored);
          if (evidence === undefined)
            throw new DesignerApplicationError(
              'manual undo could not compile the compensating revision'
            );
          const undoDigest = createHash('sha256')
            .update(
              serializeCanonicalData([
                'selene-manual-design-undo/v1',
                input.undoId,
                input.targetRevisionId,
                this.source.revision.id,
                restored.revision.id
              ])
            )
            .digest('hex');
          const contentDeltaDigest = createHash('sha256')
            .update(`${digest(this.source)}\u0000${digest(baseContent)}`)
            .digest('hex');
          const nextDesignRevision = this.manualDesignRevision(
            authority.designRevision,
            restored,
            evidence,
            undoDigest,
            contentDeltaDigest
          );
          const journal = Object.freeze(
            (this.manualReactEditJournal ?? []).map((candidate, index, entries) =>
              index !== entries.length - 1
                ? candidate
                : Object.freeze({
                    ...candidate,
                    lifecycle: 'undone' as const,
                    undoResult: Object.freeze({
                      workspaceRevisionId: restored.revision.id,
                      designRevision: nextDesignRevision,
                      completedAt: createdAt
                    })
                  })
            )
          );
          const baseline = this.manualUndoBaseline(this.source, restored, entry);
          const collaboration = {
            ...this.collaboration,
            revisions: [
              ...this.collaboration.revisions,
              {
                id: restored.revision.id,
                projectId: restored.projectId,
                sequence: this.collaboration.revisions.length + 1,
                parentRevisionId: this.source.revision.id,
                content: restored,
                contentSha256: digest(restored),
                scenarioIds: enterpriseScenarioFixtures.map((item) => item.id),
                createdBy: this.collaborationAuthorId,
                createdAt
              }
            ],
            designReviewState: toCollaborationDesignReviewState(baseline)
          };
          const nextAuthority: LocalManualReactEditAuthority = Object.freeze({
            format: 'selene-local-manual-react-edit-authority/v1',
            workspaceRevisionId: restored.revision.id,
            designRevision: nextDesignRevision
          });
          const state: LocalDesignerState = {
            ...this.guidanceState(),
            baseline,
            collaborationSnapshot: serializeSnapshot(collaboration),
            manualReactEditAuthority: nextAuthority,
            manualReactEditJournal: journal
          };
          await this.projectState.commitDesignerRevision(restored.projectId, restored, state);
          this.source = restored;
          this.baseline = baseline;
          this.replaceCollaboration(collaboration);
          this.manualReactEditAuthority = nextAuthority;
          this.manualReactEditJournal = journal;
          this.reactBinding = undefined;
          this.pendingReactBinding = undefined;
          this.activity.unshift('Undid the latest manual design edit with a compiled revision.');
          return this.snapshot();
        })
      );
    } finally {
      this.undoActive = false;
    }
  }

  /** Compensates only the current latest applied AI result; it never invokes project-lifecycle undo. */
  public async undoLastAppliedAIChange(value: unknown): Promise<DesignerSnapshot> {
    if (this.undoActive) throw new DesignerApplicationError('an AI undo is already running');
    this.undoActive = true;
    try {
      return await this.enqueueGraphOperation(() =>
        this.mutateDurably(async () => {
          const input = validateAIChangeUndo(value);
          if (this.active !== undefined)
            throw new DesignerApplicationError('an agent request is already running');
          if (this.pendingAIProposal !== undefined)
            throw new DesignerApplicationError(
              'Accept or reject the staged AI proposal before undoing an AI change.'
            );
          if (input.projectId !== this.source.projectId)
            throw new DesignerApplicationError('AI undo request belongs to a different project');
          const applied = this.collaboration.aiChangeRequests.filter(
            (request) => request.lifecycle === 'applied'
          );
          const request = applied.at(-1);
          if (request === undefined || request.id !== input.requestId)
            throw new DesignerApplicationError('only the latest applied AI request may be undone');
          if (
            request.result === undefined ||
            request.result.revisionId !== this.source.revision.id ||
            request.result.revisionFingerprint !== digest(this.source)
          )
            throw new DesignerApplicationError(
              'AI request result is no longer the current source revision'
            );
          const latestCanonical = this.collaboration.revisions.at(-1);
          const resultRevision = this.collaboration.revisions.find(
            (revision) => revision.id === request.result?.revisionId
          );
          const base = this.collaboration.revisions.find(
            (revision) => revision.id === request.baseRevision.id
          );
          if (
            latestCanonical === undefined ||
            base === undefined ||
            latestCanonical.id !== request.result.revisionId ||
            latestCanonical.contentSha256 !== request.result.revisionFingerprint ||
            latestCanonical.contentSha256 !== digest(this.source) ||
            resultRevision !== latestCanonical ||
            latestCanonical.parentRevisionId !== request.baseRevision.id ||
            base.projectId !== input.projectId ||
            base.id !== request.baseRevision.id ||
            base.contentSha256 !== request.baseRevision.fingerprint
          )
            throw new DesignerApplicationError(
              'AI request base revision is unavailable or invalid'
            );
          let latestCanonicalContent: ReactSourceWorkspace;
          let baseContent: ReactSourceWorkspace;
          try {
            validateReactSourceWorkspace(latestCanonical.content as ReactSourceWorkspace);
            validateReactSourceWorkspace(base.content as ReactSourceWorkspace);
            latestCanonicalContent = latestCanonical.content as ReactSourceWorkspace;
            baseContent = base.content as ReactSourceWorkspace;
          } catch {
            throw new DesignerApplicationError(
              'AI request base revision is unavailable or invalid'
            );
          }
          if (
            latestCanonicalContent.revision.id !== this.source.revision.id ||
            baseContent.projectId !== input.projectId ||
            digest(baseContent) !== base.contentSha256 ||
            baseContent.revision.id !== base.id
          )
            throw new DesignerApplicationError(
              'AI request base revision is unavailable or invalid'
            );
          const beforeUndo = this.captureMutationState();
          const previous = this.source;
          const createdAt = strictlyLaterTimestamp(
            this.source.revision.createdAt,
            latestCanonical.createdAt,
            request.createdAt,
            request.updatedAt,
            request.result.completedAt
          );
          const appendSequence = this.collaboration.revisions.length + 1;
          const revisionId = `desktop-undo-${request.id}-${appendSequence}`;
          const baselineChangeId = `design-undo-${request.id}-${appendSequence}`;
          if (
            this.collaboration.revisions.some((revision) => revision.id === revisionId) ||
            this.baseline.changesSinceBaseline.some((change) => change.id === baselineChangeId)
          )
            throw new DesignerApplicationError('AI undo revision identifiers already exist');
          try {
            const restored = {
              ...baseContent,
              revision: {
                id: revisionId,
                parentId: previous.revision.id,
                createdAt,
                summary: `Undo AI request ${request.id}`
              }
            };
            validateReactSourceWorkspace(restored);
            this.source = restored;
            this.reactBinding = undefined;
            this.revokeManualReactEditAuthority();
            this.pendingReactBinding = undefined;
            this.baseline = executeDesignBaselineCommand(this.baseline, {
              type: 'apply-design-mutation',
              change: {
                id: baselineChangeId,
                kind: 'source',
                beforeRevision: { id: previous.revision.id, fingerprint: digest(previous) },
                currentRevision: { id: this.source.revision.id, fingerprint: digest(this.source) },
                affected: {
                  projectId: this.source.projectId,
                  screenIds: ['desktop-designer'],
                  routePaths: ['/'],
                  scenarioIds: enterpriseScenarioFixtures.map((item) => item.id),
                  componentIds: ['App'],
                  stableNodeIds: this.source.nodes.map((node) => node.nodeId)
                },
                evidence: [{ description: `Compensated AI request ${request.id}.` }],
                provenance: {
                  kind: 'agent',
                  agentId: request.provider.providerId,
                  promptDigest: `undo:${request.id}`
                },
                occurredAt: createdAt,
                reason: `Undo AI request ${request.id}`
              }
            });
            const revision = {
              id: this.source.revision.id,
              projectId: this.source.projectId,
              sequence: appendSequence,
              parentRevisionId: previous.revision.id,
              content: this.source,
              contentSha256: digest(this.source),
              scenarioIds: enterpriseScenarioFixtures.map((item) => item.id),
              createdBy: this.collaborationAuthorId,
              createdAt
            };
            const diff = `Restored canonical base ${base.id} after AI request ${request.id}.`;
            this.replaceCollaboration({
              ...this.collaboration,
              revisions: [...this.collaboration.revisions, revision],
              designReviewState: toCollaborationDesignReviewState(this.baseline),
              aiChangeRequests: this.collaboration.aiChangeRequests.map((item) =>
                item.id !== request.id
                  ? item
                  : {
                      ...item,
                      lifecycle: 'undone',
                      updatedAt: createdAt,
                      undoResult: {
                        revisionId: revision.id,
                        revisionFingerprint: revision.contentSha256,
                        diff,
                        completedAt: createdAt
                      }
                    }
              )
            });
            this.updateRequest(request.id, { status: 'undone', resultingRevisionId: revision.id });
            await this.persistAppliedRevision();
            this.activity.unshift(`Undid AI request ${request.id} with ${revision.id}.`);
            return this.snapshot();
          } catch (error) {
            this.restoreMutationState(beforeUndo);
            throw error;
          }
        })
      );
    } finally {
      this.undoActive = false;
    }
  }

  public cancel(value: unknown): void {
    const id = validateDesignerIdentifier(value, 'requestId');
    if (this.active?.id !== id) throw new DesignerApplicationError(`no active request: ${id}`);
    this.active.controller.abort();
  }

  public configureProductShell(value: unknown): Promise<DesignerSnapshot> {
    return this.enqueueGraphOperation(async () => {
      const input = validateProductShellConfiguration(value);
      if (input.projectId !== this.source.projectId)
        throw new DesignerApplicationError(
          'Only the currently open project can become or update a product shell.'
        );
      if (this.projectState?.configureProductShell === undefined)
        throw new DesignerApplicationError(
          'Product structure configuration is unavailable for this workspace.'
        );
      this.productMap = await this.projectState.configureProductShell(
        input.projectId,
        input.childProjectIds
      );
      this.activity.unshift(
        input.childProjectIds.length === 0
          ? `Removed product shell membership from ${input.projectId}.`
          : `Configured ${input.projectId} as a product shell with ${input.childProjectIds.length} child projects.`
      );
      return this.snapshot();
    });
  }

  public markReadyForReview(): Promise<DesignerSnapshot> {
    return this.markReady('review');
  }

  public markReadyForHandoff(): Promise<DesignerSnapshot> {
    return this.markReady('handoff');
  }

  /** A review and a developer handoff are distinct immutable design baselines. */
  private markReady(intent: BaselineIntent): Promise<DesignerSnapshot> {
    return this.enqueueGraphOperation(() =>
      this.mutateDurably(async () => {
        if (this.pendingAIProposal !== undefined)
          throw new DesignerApplicationError(
            'Accept or reject the staged AI proposal before marking this design ready.'
          );
        this.baseline = executeDesignBaselineCommand(this.baseline, {
          type: 'mark-ready',
          intent,
          baseline: {
            id: `baseline-${intent}-${this.source.revision.id}`,
            projectId: this.source.projectId,
            revision: { id: this.source.revision.id, fingerprint: digest(this.source) },
            intent,
            createdAt: new Date().toISOString(),
            createdBy: this.collaborationAuthorId
          }
        });
        this.activity.unshift(`Marked ${this.source.revision.id} ready for ${intent}.`);
        this.updateCanonicalBaseline();
        await this.persistProjectState();
        return this.snapshot();
      })
    );
  }

  public async exportHandoff(): Promise<string> {
    if (this.pendingAIProposal !== undefined)
      throw new DesignerApplicationError(
        'Accept or reject the staged AI proposal before exporting developer handoff.'
      );
    const metadata = await this.handoffMetadata.load();
    const reviewThreads = handoffReviewThreads(this.snapshot().reviewThreads, this.source);
    const catalog = currentComponentCatalogArtifacts(
      this.componentCatalogManifests,
      this.source,
      this.graph
    ).catalog;
    return serializeGeneratedDesignHandoff(
      createGeneratedDesignHandoff({
        workspace: this.source,
        baseline: this.baseline,
        comments: reviewThreads.flatMap((thread) =>
          thread.anchor.nodeId === undefined
            ? []
            : [{ nodeId: thread.anchor.nodeId, body: thread.messages[0]?.body ?? '' }]
        ),
        reviewThreads,
        developerDirections: this.developerAnnotations.map(
          (annotation) => `[${annotation.category}] ${annotation.body}`
        ),
        reproducibility: metadata,
        project: {
          id: this.source.projectId,
          owner: 'desktop-design',
          status: this.baseline.readiness,
          routes: ['/'],
          storybook: [{ component: 'App', url: 'local://component-catalog/App' }],
          storyReferences: canonicalStoryReferencesFor(this.source, catalog),
          acceptanceCriteria: ['Render validated TSX', 'Preserve stable component-node metadata']
        },
        agentInstructions: ['Use the selected scenario and preserve stable node IDs.']
      })
    );
  }

  public async exportProductHandoff(): Promise<string> {
    if (
      this.productMap?.scope.kind !== 'federation' ||
      this.productMap.scope.shellProjectId !== this.source.projectId
    )
      throw new DesignerApplicationError(
        'Configure the current project as a product shell before exporting a product handoff.'
      );
    if (this.projectState?.productHandoffProjects === undefined)
      throw new DesignerApplicationError(
        'Product handoff export is unavailable for this workspace.'
      );
    const projects = await this.projectState.productHandoffProjects(this.source.projectId);
    if (
      projects.length < 3 ||
      !projects.some((project) => project.projectId === this.source.projectId) ||
      new Set(projects.map((project) => project.projectId)).size !== projects.length
    )
      throw new DesignerApplicationError(
        'A product handoff requires the shell and at least two independently owned child projects.'
      );
    const metadata = await this.handoffMetadata.load();
    const handoff = createFederatedDesignHandoff(
      this.source.projectId,
      projects.map((project) => ({
        projectId: project.projectId,
        owner: project.name,
        handoff: localProjectGeneratedHandoff(project, metadata, this.componentCatalogManifests)
      }))
    );
    return `${JSON.stringify(handoff, null, 2)}\n`;
  }

  private emit(event: DesignerProgress): void {
    for (const listener of this.listeners) listener(event);
  }

  private updateRequest(
    id: string,
    updates: Pick<AIChangeRequest, 'status'> &
      Partial<Pick<AIChangeRequest, 'resultingRevisionId' | 'error'>>
  ): void {
    const index = this.aiChangeRequests.findIndex((request) => request.id === id);
    if (index >= 0) {
      const current = this.aiChangeRequests[index];
      if (current === undefined) return;
      this.aiChangeRequests[index] = {
        id: current.id,
        agentId: current.agentId,
        instruction: current.instruction,
        target: current.target,
        createdAt: current.createdAt,
        status: updates.status,
        ...(updates.resultingRevisionId === undefined
          ? current.resultingRevisionId === undefined
            ? {}
            : { resultingRevisionId: current.resultingRevisionId }
          : { resultingRevisionId: updates.resultingRevisionId }),
        ...(updates.error === undefined
          ? current.error === undefined
            ? {}
            : { error: current.error }
          : { error: updates.error })
      };
    }
  }
}

/** Deterministic adapter for local demos and tests; it uses the same service boundary as any custom adapter. */
export class DeterministicDesignerFixtureAdapter implements DesignerAgentAdapter {
  public readonly descriptor: DesignerAgentSummary = {
    id: 'fixture-designer',
    label: 'Deterministic fixture designer',
    capabilities: ['react.revise', 'scenario-aware']
  };

  public async propose(
    input: Parameters<DesignerAgentAdapter['propose']>[0]
  ): Promise<AgentSourcePatch> {
    input.progress(`Using ${input.scenario.title}.`);
    await Promise.resolve();
    if (input.signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
    return {
      summary: `Fixture agent revised the design for ${input.scenario.id}.`,
      operations: [
        {
          type: 'write',
          path: 'src/App.tsx',
          content: previewAppSource
        },
        {
          type: 'write',
          path: 'src/preview-data.json',
          content: previewDataFor(input.instruction, input.scenario)
        }
      ]
    };
  }
}
