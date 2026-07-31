import {
  createDeveloperRecheckManifest,
  type DesignBaselineState,
  type DeveloperRecheckManifest
} from './design-baseline.js';
import {
  exportReactSourceWorkspace,
  validateReactSourceWorkspace,
  type ReactBuildArtifact,
  type ReactSourceWorkspace
} from './generation.js';
import type { CanonicalStoryReference } from './artifact-manifests.js';
import { parseReactBindingManifest, type ReactBindingManifest } from './react-binding-manifest.js';

export type EnterpriseScenarioState = 'loading' | 'empty' | 'error' | 'success';
export type TokenMode = 'semantic' | 'raw';

export interface EnterpriseScenario {
  readonly id: string;
  readonly title: string;
  readonly state: EnterpriseScenarioState;
  readonly role: 'owner' | 'admin' | 'editor' | 'commenter' | 'viewer' | 'guest';
  readonly permissions: readonly string[];
  readonly featureFlags: Readonly<Record<string, boolean>>;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly locale: string;
  readonly theme: 'light' | 'dark';
  readonly brand: string;
  readonly tokenMode: TokenMode;
  readonly accessibility: {
    readonly initialFocus: string;
    readonly reducedMotion: boolean;
    readonly keyboardPath: readonly string[];
  };
  /** Ordered, reproducible navigation interactions. */
  readonly navigation: readonly { readonly action: string; readonly route: string }[];
  /** Realistic deterministic fixture data; UI states must not rely on placeholder copy alone. */
  readonly fixture: {
    readonly heading: string;
    readonly summary: string;
    readonly rows: readonly {
      readonly id: string;
      readonly label: string;
      readonly value: string;
    }[];
    readonly primaryAction?: string;
    readonly errorCode?: string;
  };
}

/** Cover the states and environment axes a design handoff must reproduce. */
export const enterpriseScenarioFixtures: readonly EnterpriseScenario[] = [
  {
    id: 'owner-loading-desktop',
    title: 'Owner loading dashboard',
    state: 'loading',
    role: 'owner',
    permissions: ['read', 'edit', 'approve', 'merge'],
    featureFlags: { approvals: true, federation: true },
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    theme: 'light',
    brand: 'selene',
    tokenMode: 'semantic',
    accessibility: {
      initialFocus: 'main',
      reducedMotion: false,
      keyboardPath: ['skip-link', 'main']
    },
    navigation: [
      { action: 'open shell', route: '/' },
      { action: 'open orders', route: '/orders' }
    ],
    fixture: {
      heading: 'Orders',
      summary: 'Syncing 12 orders',
      rows: [],
      primaryAction: 'Create order'
    }
  },
  {
    id: 'editor-empty-mobile',
    title: 'Editor empty orders',
    state: 'empty',
    role: 'editor',
    permissions: ['read', 'edit'],
    featureFlags: { bulkActions: false, federation: true },
    viewport: { width: 375, height: 812 },
    locale: 'fr-FR',
    theme: 'dark',
    brand: 'northstar',
    tokenMode: 'semantic',
    accessibility: {
      initialFocus: 'create-order',
      reducedMotion: true,
      keyboardPath: ['main', 'create-order']
    },
    navigation: [
      { action: 'open orders', route: '/orders' },
      { action: 'create order', route: '/orders/new' }
    ],
    fixture: {
      heading: 'No orders yet',
      summary: 'Start with an order or import a CSV.',
      rows: [],
      primaryAction: 'Create order'
    }
  },
  {
    id: 'commenter-error-tablet',
    title: 'Commenter error recovery',
    state: 'error',
    role: 'commenter',
    permissions: ['read', 'comment'],
    featureFlags: { retry: true, federation: false },
    viewport: { width: 834, height: 1112 },
    locale: 'ja-JP',
    theme: 'light',
    brand: 'support',
    tokenMode: 'raw',
    accessibility: {
      initialFocus: 'retry',
      reducedMotion: true,
      keyboardPath: ['main', 'retry', 'support-link']
    },
    navigation: [
      { action: 'open support', route: '/support' },
      { action: 'retry', route: '/support?retry=1' }
    ],
    fixture: {
      heading: 'Support queue unavailable',
      summary: 'Your saved filters are preserved.',
      rows: [],
      primaryAction: 'Retry',
      errorCode: 'SUPPORT_UPSTREAM_TIMEOUT'
    }
  },
  {
    id: 'viewer-success-desktop',
    title: 'Viewer success history',
    state: 'success',
    role: 'viewer',
    permissions: ['read'],
    featureFlags: { history: true, approvals: true },
    viewport: { width: 1280, height: 800 },
    locale: 'ar',
    theme: 'dark',
    brand: 'commerce',
    tokenMode: 'semantic',
    accessibility: {
      initialFocus: 'history',
      reducedMotion: false,
      keyboardPath: ['skip-link', 'history', 'revision-2']
    },
    navigation: [
      { action: 'open history', route: '/history' },
      { action: 'compare revision', route: '/history/r2?compare=r1' }
    ],
    fixture: {
      heading: 'Orders',
      summary: '2 orders need attention',
      rows: [
        { id: '1048', label: 'Olivia Parker', value: '$240.00' },
        { id: '1047', label: 'Amir Cooper', value: '$96.00' }
      ]
    }
  }
];

export interface GeneratedDesignHandoff {
  readonly format: 'selene-generated-design-handoff/v2';
  readonly source: string;
  readonly revision: ReactSourceWorkspace['revision'];
  readonly nodeMap: readonly ReactSourceWorkspace['nodes'][number][];
  /**
   * The exact host-validated graph-to-source manifest used by the compiled preview.
   * Draft exports without current compiler authority say `null`; ready handoffs may not.
   */
  readonly reactBinding: ReactBindingManifest | null;
  readonly sourceMap?: string;
  readonly comments: readonly { readonly nodeId: string; readonly body: string }[];
  /** Spatial artifact discussions remain distinct from legacy node-only comments. */
  readonly reviewThreads?: readonly GeneratedDesignReviewThread[];
  readonly developerDirections: readonly string[];
  readonly scenarios: readonly EnterpriseScenario[];
  readonly baseline: DeveloperRecheckManifest;
  readonly reproducibility: {
    readonly packageManager: string;
    readonly lockfile: { readonly path: string; readonly checksum: string };
    readonly packages: readonly { readonly name: string; readonly version: string }[];
    readonly dependencies: readonly { readonly name: string; readonly version: string }[];
  };
  readonly project: {
    readonly id: string;
    readonly owner: string;
    readonly status: string;
    readonly routes: readonly string[];
    readonly storybook: readonly { readonly component: string; readonly url: string }[];
    /** Authoritative story identities; URLs above are optional deployment hints only. */
    readonly storyReferences: readonly CanonicalStoryReference[];
    readonly acceptanceCriteria: readonly string[];
  };
  readonly agentInstructions: readonly string[];
}

export interface GeneratedDesignReviewThread {
  readonly id: string;
  readonly status: 'open' | 'resolved';
  readonly anchor: {
    readonly artifactId: string;
    readonly screenId: string;
    readonly scenarioId: string;
    readonly state: string;
    readonly revisionId: string;
    readonly x: number;
    readonly y: number;
    readonly width?: number;
    readonly height?: number;
    readonly nodeId?: string;
  };
  readonly messages: readonly {
    readonly body: string;
    readonly author: string;
    readonly createdAt: string;
  }[];
}

export interface GeneratedDesignHandoffInput {
  readonly workspace: ReactSourceWorkspace;
  /** Current host-validated preview authority; inert persisted candidates are not accepted here. */
  readonly reactBinding?: ReactBindingManifest;
  readonly build?: Pick<ReactBuildArtifact, 'sourceMap'>;
  readonly baseline: DesignBaselineState;
  readonly comments: readonly { readonly nodeId: string; readonly body: string }[];
  readonly reviewThreads?: readonly GeneratedDesignReviewThread[];
  readonly developerDirections: readonly string[];
  readonly scenarios?: readonly EnterpriseScenario[];
  readonly reproducibility: GeneratedDesignHandoff['reproducibility'];
  readonly project: GeneratedDesignHandoff['project'];
  readonly agentInstructions: readonly string[];
}

const sha256Pattern = /^[a-f0-9]{64}$/;
const exactSemverPattern =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireExactSha256(value: string, field: string): void {
  if (!sha256Pattern.test(value)) throw new Error(`${field} must be a lowercase SHA-256 checksum`);
}

function requireExactSemver(value: string, field: string): void {
  if (!exactSemverPattern.test(value))
    throw new Error(`${field} must be an exact semantic version`);
}

function assertScenario(scenario: EnterpriseScenario): void {
  if (
    !scenario.id ||
    !scenario.title ||
    scenario.viewport.width < 1 ||
    scenario.viewport.height < 1
  )
    throw new Error('Scenario requires id, title, and a positive viewport');
  if (!scenario.locale || !scenario.brand || !scenario.accessibility.initialFocus)
    throw new Error('Scenario requires locale, brand, and focus target');
  if (scenario.navigation.length < 2) throw new Error('Scenario requires multi-step navigation');
}

function assertCanonicalStoryReferences(
  value: unknown,
  projectId: string
): asserts value is readonly CanonicalStoryReference[] {
  if (!Array.isArray(value)) throw new Error('Handoff canonical story references are malformed');
  const references = value as readonly unknown[];
  if (references.length > 4_096)
    throw new Error('Handoff canonical story reference list exceeds its bound');
  const identities = new Set<string>();
  for (const reference of references) {
    if (
      !isRecord(reference) ||
      reference.format !== 'selene-canonical-story-reference/v1' ||
      reference.projectId !== projectId ||
      typeof reference.catalogRevision !== 'string' ||
      !reference.catalogRevision ||
      typeof reference.buildId !== 'string' ||
      !reference.buildId ||
      typeof reference.componentId !== 'string' ||
      !reference.componentId ||
      typeof reference.storyId !== 'string' ||
      !reference.storyId ||
      [
        reference.projectId,
        reference.catalogRevision,
        reference.buildId,
        reference.componentId,
        reference.storyId
      ].some((part) => part.length > 256)
    )
      throw new Error('Handoff canonical story reference is invalid');
    const identity = [
      reference.projectId,
      reference.catalogRevision,
      reference.buildId,
      reference.componentId,
      reference.storyId
    ].join('\u0000');
    if (identities.has(identity))
      throw new Error('Handoff canonical story references must be unique');
    identities.add(identity);
  }
}

function handoffReactBinding(
  value: unknown,
  workspace: ReactSourceWorkspace
): ReactBindingManifest {
  const binding = parseReactBindingManifest(value);
  if (
    binding.projectId !== workspace.projectId ||
    binding.sourceRevisionId !== workspace.revision.id
  )
    throw new Error('Handoff React binding does not match the exported source revision');
  const sourceNodeIds = new Set(workspace.nodes.map((node) => node.nodeId));
  if (
    binding.nodeBindings.some((entry) => !sourceNodeIds.has(entry.sourceNodeId)) ||
    binding.actionBindings.some((entry) => !sourceNodeIds.has(entry.sourceNodeId))
  )
    throw new Error('Handoff React binding references source nodes outside the exported workspace');
  return binding;
}

/** Creates the agent-readable handoff developers can round-trip without hidden state. */
export function createGeneratedDesignHandoff(
  input: GeneratedDesignHandoffInput
): GeneratedDesignHandoff {
  validateReactSourceWorkspace(input.workspace);
  const reactBinding =
    input.reactBinding === undefined
      ? null
      : handoffReactBinding(input.reactBinding, input.workspace);
  if (
    input.baseline.readiness === 'ready-for-handoff' &&
    input.baseline.currency === 'current' &&
    reactBinding === null
  )
    throw new Error('Current ready developer handoff requires a validated React binding');
  const nodeIds = new Set(input.workspace.nodes.map((node) => node.nodeId));
  for (const comment of input.comments) {
    if (!nodeIds.has(comment.nodeId))
      throw new Error(`Comment references unknown stable node ${comment.nodeId}`);
    if (!comment.body.trim()) throw new Error('Handoff comment must not be empty');
  }
  for (const thread of input.reviewThreads ?? []) {
    if (
      !thread.id ||
      !thread.anchor.artifactId ||
      !thread.anchor.screenId ||
      !thread.anchor.scenarioId ||
      !thread.anchor.state ||
      !thread.anchor.revisionId ||
      thread.messages.length === 0 ||
      thread.messages.some(
        (message) =>
          !message.body.trim() ||
          !message.author.trim() ||
          Number.isNaN(Date.parse(message.createdAt))
      )
    )
      throw new Error('Handoff review thread is invalid');
    if (
      ![thread.anchor.x, thread.anchor.y, thread.anchor.width, thread.anchor.height]
        .filter((value): value is number => value !== undefined)
        .every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
    )
      throw new Error('Handoff review thread geometry is invalid');
    if (thread.anchor.nodeId !== undefined && !nodeIds.has(thread.anchor.nodeId))
      throw new Error(`Review thread references unknown stable node ${thread.anchor.nodeId}`);
  }
  for (const direction of input.developerDirections)
    if (!direction.trim()) throw new Error('Developer direction must not be empty');
  const scenarios = input.scenarios ?? enterpriseScenarioFixtures;
  for (const scenario of scenarios) assertScenario(scenario);
  if (
    !input.reproducibility.packageManager ||
    !input.reproducibility.lockfile.path ||
    !input.reproducibility.lockfile.checksum
  )
    throw new Error('Handoff requires exact package manager and lockfile reproducibility');
  requireExactSha256(input.reproducibility.lockfile.checksum, 'Handoff lockfile checksum');
  const [managerName, managerVersion, extra] = input.reproducibility.packageManager.split('@');
  if (!managerName || !managerVersion || extra !== undefined)
    throw new Error('Handoff package manager must include an exact semantic version');
  requireExactSemver(managerVersion, 'Handoff package manager version');
  for (const item of [...input.reproducibility.packages, ...input.reproducibility.dependencies]) {
    if (!item.name) throw new Error('Handoff package and dependency names must not be empty');
    requireExactSemver(item.version, `Handoff version for ${item.name}`);
  }
  if (
    !input.project.id ||
    !input.project.owner ||
    input.project.routes.length === 0 ||
    input.project.storybook.length === 0 ||
    input.project.acceptanceCriteria.length === 0
  )
    throw new Error(
      'Handoff requires project ownership, routes, Storybook, and acceptance criteria'
    );
  if (
    input.agentInstructions.length === 0 ||
    input.agentInstructions.some((instruction) => !instruction.trim())
  )
    throw new Error('Handoff requires agent-readable instructions');
  if (input.workspace.projectId !== input.project.id)
    throw new Error('Handoff workspace and project identities must match');
  if (input.baseline.projectId !== input.project.id)
    throw new Error('Handoff baseline and project identities must match');
  assertCanonicalStoryReferences(input.project.storyReferences, input.project.id);
  return {
    format: 'selene-generated-design-handoff/v2',
    source: exportReactSourceWorkspace(input.workspace),
    revision: input.workspace.revision,
    nodeMap: [...input.workspace.nodes].sort((left, right) =>
      left.nodeId.localeCompare(right.nodeId)
    ),
    reactBinding,
    ...(input.build?.sourceMap === undefined ? {} : { sourceMap: input.build.sourceMap }),
    comments: [...input.comments],
    ...(input.reviewThreads === undefined
      ? {}
      : { reviewThreads: structuredClone(input.reviewThreads) }),
    developerDirections: [...input.developerDirections],
    scenarios: [...scenarios],
    baseline: createDeveloperRecheckManifest(input.baseline),
    reproducibility: input.reproducibility,
    project: input.project,
    agentInstructions: [...input.agentInstructions]
  };
}

/** Revalidates the durable source and all node-bound collaboration context after import. */
export function parseGeneratedDesignHandoff(serialized: string): GeneratedDesignHandoff {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('Malformed generated design handoff JSON');
  }
  if (!isRecord(value)) throw new Error('Malformed generated design handoff');
  const parsed = value as unknown as GeneratedDesignHandoff;
  if (parsed.format !== 'selene-generated-design-handoff/v2')
    throw new Error('Unsupported generated design handoff');
  if (
    typeof parsed.source !== 'string' ||
    !Array.isArray(parsed.nodeMap) ||
    (parsed.reactBinding !== null && !isRecord(parsed.reactBinding)) ||
    !Array.isArray(parsed.comments) ||
    (parsed.reviewThreads !== undefined && !Array.isArray(parsed.reviewThreads)) ||
    !Array.isArray(parsed.developerDirections) ||
    !Array.isArray(parsed.scenarios) ||
    !isRecord(parsed.reproducibility) ||
    !isRecord(parsed.reproducibility.lockfile) ||
    !Array.isArray(parsed.reproducibility.packages) ||
    !Array.isArray(parsed.reproducibility.dependencies) ||
    !isRecord(parsed.project) ||
    !Array.isArray(parsed.project.storyReferences) ||
    !Array.isArray(parsed.agentInstructions) ||
    !isRecord(parsed.baseline)
  ) {
    throw new Error('Malformed generated design handoff');
  }
  const workspace = JSON.parse(parsed.source) as ReactSourceWorkspace;
  validateReactSourceWorkspace(workspace);
  const reactBinding =
    parsed.reactBinding === null ? null : handoffReactBinding(parsed.reactBinding, workspace);
  if (
    parsed.project.status === 'ready-for-handoff' &&
    parsed.baseline.currency === 'current' &&
    reactBinding === null
  )
    throw new Error('Current ready developer handoff requires a validated React binding');
  const nodes = new Set(workspace.nodes.map((node) => node.nodeId));
  if (parsed.nodeMap.some((node) => !nodes.has(node.nodeId)))
    throw new Error('Handoff node map is not present in source');
  if (parsed.comments.some((comment) => !nodes.has(comment.nodeId)))
    throw new Error('Handoff comment is not present in node map');
  for (const thread of parsed.reviewThreads ?? []) {
    const anchorGeometry =
      isRecord(thread) && isRecord(thread.anchor)
        ? [thread.anchor.x, thread.anchor.y, thread.anchor.width, thread.anchor.height]
        : [];
    if (
      !isRecord(thread) ||
      !isRecord(thread.anchor) ||
      !Array.isArray(thread.messages) ||
      typeof thread.id !== 'string' ||
      !thread.id.trim() ||
      (thread.status !== 'open' && thread.status !== 'resolved') ||
      typeof thread.anchor.artifactId !== 'string' ||
      !thread.anchor.artifactId.trim() ||
      typeof thread.anchor.screenId !== 'string' ||
      !thread.anchor.screenId.trim() ||
      typeof thread.anchor.scenarioId !== 'string' ||
      !thread.anchor.scenarioId.trim() ||
      typeof thread.anchor.state !== 'string' ||
      !thread.anchor.state.trim() ||
      typeof thread.anchor.revisionId !== 'string' ||
      !thread.anchor.revisionId.trim() ||
      typeof thread.anchor.x !== 'number' ||
      typeof thread.anchor.y !== 'number' ||
      (thread.anchor.width !== undefined && typeof thread.anchor.width !== 'number') ||
      (thread.anchor.height !== undefined && typeof thread.anchor.height !== 'number') ||
      !anchorGeometry
        .filter((coordinate): coordinate is number => coordinate !== undefined)
        .every((coordinate) => Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1) ||
      (thread.anchor.nodeId !== undefined &&
        (typeof thread.anchor.nodeId !== 'string' || !nodes.has(thread.anchor.nodeId))) ||
      thread.messages.length === 0 ||
      thread.messages.some(
        (message) =>
          !isRecord(message) ||
          typeof message.body !== 'string' ||
          !message.body.trim() ||
          typeof message.author !== 'string' ||
          !message.author.trim() ||
          typeof message.createdAt !== 'string' ||
          Number.isNaN(Date.parse(message.createdAt))
      )
    )
      throw new Error('Handoff review thread is malformed');
  }
  for (const scenario of parsed.scenarios) assertScenario(scenario);
  if (
    typeof parsed.reproducibility.packageManager !== 'string' ||
    typeof parsed.reproducibility.lockfile.path !== 'string' ||
    typeof parsed.reproducibility.lockfile.checksum !== 'string' ||
    typeof parsed.project.id !== 'string' ||
    typeof parsed.baseline.projectId !== 'string' ||
    !Array.isArray(parsed.baseline.exactChangesToRecheck) ||
    parsed.agentInstructions.length === 0
  )
    throw new Error('Handoff is missing reproducibility or agent instructions');
  requireExactSha256(parsed.reproducibility.lockfile.checksum, 'Handoff lockfile checksum');
  const [managerName, managerVersion, extra] = parsed.reproducibility.packageManager.split('@');
  if (!managerName || !managerVersion || extra !== undefined)
    throw new Error('Handoff package manager must include an exact semantic version');
  requireExactSemver(managerVersion, 'Handoff package manager version');
  for (const item of [...parsed.reproducibility.packages, ...parsed.reproducibility.dependencies]) {
    if (!isRecord(item) || typeof item.name !== 'string' || typeof item.version !== 'string')
      throw new Error('Handoff package entry is malformed');
    requireExactSemver(item.version, `Handoff version for ${item.name}`);
  }
  if (workspace.projectId !== parsed.project.id || parsed.baseline.projectId !== parsed.project.id)
    throw new Error('Handoff project identities must match');
  assertCanonicalStoryReferences(parsed.project.storyReferences, parsed.project.id);
  return { ...parsed, reactBinding };
}

export function serializeGeneratedDesignHandoff(handoff: GeneratedDesignHandoff): string {
  return `${JSON.stringify(handoff, null, 2)}\n`;
}
