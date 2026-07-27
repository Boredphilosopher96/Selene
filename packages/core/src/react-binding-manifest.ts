import { reactBindingManifestSchema, type ReactBindingManifest } from '@selene/project-schema';

import {
  createPrototypeRuntime,
  parsePrototypeGraph,
  type PrototypeGraph,
  type PrototypeRuntimeSnapshot
} from './prototype-graph.js';
import {
  validateReactSourceWorkspace,
  type AgentSourcePatch,
  type ReactSourceWorkspace
} from './generation.js';

export { reactBindingManifestFormat, type ReactBindingManifest } from '@selene/project-schema';

export interface ReactBindingContext {
  readonly graph: PrototypeGraph;
  readonly graphRevision: number;
  readonly workspace: ReactSourceWorkspace;
  readonly compilerEvidence: ReactBindingCompilerEvidence;
}

export interface ReactBindingCompilerEvidence {
  readonly format: 'selene-react-binding-evidence/v1';
  /** Host compiler/parser identity, not renderer-provided source authority. */
  /** The host issues this from the pinned TypeScript 6 parser API. */
  readonly parserIdentity: '@typescript/typescript6@6.0.2';
  /** Exact host compiler that issued the matching build receipt. */
  readonly compilerIdentity: 'selene-vite-react-compiler/v1';
  readonly projectId: string;
  readonly sourceRevisionId: string;
  /** Canonical workspace digest stamped by the compiler host. */
  readonly sourceSha256: string;
  /** Digest of the exact emitted preview assets that authorized these markers. */
  readonly outputSha256: string;
  readonly entrypoint: string;
  readonly reachableFiles: readonly string[];
  readonly nodeMarkers: readonly {
    readonly sourceNodeId: string;
    readonly path: string;
    readonly exportName: string;
    readonly guards: readonly ReactBindingRuntimeGuard[];
  }[];
  readonly actionMarkers: readonly {
    readonly graphNodeId: string;
    readonly portId: string;
    readonly sourceNodeId: string;
    readonly path: string;
    readonly exportName: string;
    readonly guards: readonly ReactBindingRuntimeGuard[];
  }[];
}

export interface ReactBindingRuntimeGuard {
  readonly surface: 'node' | 'state' | 'overlay';
  readonly operator: 'equals' | 'not-equals';
  readonly value: string;
}

export type ReactScenarioRenderability =
  | { readonly status: 'renderable'; readonly scenarioId: string }
  | {
      readonly status: 'unrenderable';
      readonly scenarioId: string;
      readonly reason:
        | 'binding-missing'
        | 'binding-stale'
        | 'binding-invalid'
        | 'static-source-missing'
        | 'runtime-guard-mismatch';
      readonly message: string;
    };

/** The graph's initial node has no scenario ID but still needs an explicit preview fence. */
export type ReactDefaultRenderability =
  | { readonly status: 'renderable' }
  | {
      readonly status: 'unrenderable';
      readonly reason:
        | 'binding-missing'
        | 'binding-stale'
        | 'binding-invalid'
        | 'static-source-missing'
        | 'runtime-guard-mismatch';
      readonly message: string;
    };

export type ReactBindingManifestErrorCode =
  | 'INVALID_MANIFEST'
  | 'INVALID_CONTEXT'
  | 'PROJECT_MISMATCH'
  | 'SOURCE_REVISION_MISMATCH'
  | 'GRAPH_REVISION_MISMATCH'
  | 'NODE_UNBOUND'
  | 'SOURCE_NODE_MISSING'
  | 'SOURCE_MARKER_MISSING'
  | 'ACTION_BINDING_MISSING'
  | 'ACTION_BINDING_DANGLING'
  | 'ACTION_BINDING_EXTRA'
  | 'ACTION_MARKER_MISSING'
  | 'RUNTIME_SURFACE_STALE'
  | 'RUNTIME_GUARD_MISMATCH'
  | 'ACTION_NOT_ACTIVE'
  | 'ACTION_PORT_MISSING';

export class ReactBindingManifestError extends Error {
  public constructor(
    public readonly code: ReactBindingManifestErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ReactBindingManifestError';
  }
}

/**
 * This admits every schema-bounded manifest/evidence envelope, including 16k
 * action bindings with their nested guard records, while retaining a hard cap
 * before any schema parser or host operation observes user-owned objects.
 */
const maximumInertOwnDataEntries = 1_000_000;

/** Rejects executable object shapes before schema parsing can observe a getter or proxy trap. */
function assertInertOwnData(value: unknown): void {
  const seen = new Set<object>();
  let entries = 0;
  const inspect = (current: unknown, depth: number): void => {
    if (
      current === null ||
      typeof current === 'string' ||
      typeof current === 'boolean' ||
      (typeof current === 'number' && Number.isFinite(current))
    )
      return;
    if (typeof current !== 'object' || depth > 32)
      throw new ReactBindingManifestError('INVALID_MANIFEST', 'React binding manifest is invalid.');
    try {
      if (seen.has(current))
        throw new ReactBindingManifestError(
          'INVALID_MANIFEST',
          'React binding manifest is invalid.'
        );
      seen.add(current);
      const array = Array.isArray(current);
      if (Object.getPrototypeOf(current) !== (array ? Array.prototype : Object.prototype))
        throw new ReactBindingManifestError(
          'INVALID_MANIFEST',
          'React binding manifest is invalid.'
        );
      if (Object.getOwnPropertySymbols(current).length !== 0)
        throw new ReactBindingManifestError(
          'INVALID_MANIFEST',
          'React binding manifest is invalid.'
        );
      const keys = Object.getOwnPropertyNames(current);
      entries += keys.length;
      if (entries > maximumInertOwnDataEntries)
        throw new ReactBindingManifestError(
          'INVALID_MANIFEST',
          'React binding manifest is invalid.'
        );
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (
          descriptor === undefined ||
          !('value' in descriptor) ||
          !descriptor.enumerable ||
          (array && key === 'length')
        ) {
          if (array && key === 'length' && descriptor !== undefined && 'value' in descriptor)
            continue;
          throw new ReactBindingManifestError(
            'INVALID_MANIFEST',
            'React binding manifest is invalid.'
          );
        }
        inspect(descriptor.value, depth + 1);
      }
      if (array) {
        const length = current.length;
        if (!Number.isSafeInteger(length) || length > 16_000 || keys.length !== length + 1)
          throw new ReactBindingManifestError(
            'INVALID_MANIFEST',
            'React binding manifest is invalid.'
          );
      }
      seen.delete(current);
    } catch (error) {
      if (error instanceof ReactBindingManifestError) throw error;
      throw new ReactBindingManifestError('INVALID_MANIFEST', 'React binding manifest is invalid.');
    }
  };
  inspect(value, 0);
}

export function parseReactBindingManifest(value: unknown): ReactBindingManifest {
  assertInertOwnData(value);
  const result = reactBindingManifestSchema.safeParse(value);
  if (!result.success)
    throw new ReactBindingManifestError('INVALID_MANIFEST', 'React binding manifest is invalid.');
  return structuredClone(result.data);
}

export function parseReactBindingCompilerEvidence(value: unknown): ReactBindingCompilerEvidence {
  assertInertOwnData(value);
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ReactBindingManifestError('INVALID_CONTEXT', 'React compiler evidence is invalid.');
  const evidence = value as ReactBindingCompilerEvidence;
  if (
    evidence.format !== 'selene-react-binding-evidence/v1' ||
    evidence.parserIdentity !== '@typescript/typescript6@6.0.2' ||
    evidence.compilerIdentity !== 'selene-vite-react-compiler/v1' ||
    typeof evidence.projectId !== 'string' ||
    typeof evidence.sourceRevisionId !== 'string' ||
    typeof evidence.sourceSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(evidence.sourceSha256) ||
    typeof evidence.outputSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(evidence.outputSha256) ||
    typeof evidence.entrypoint !== 'string' ||
    !Array.isArray(evidence.reachableFiles) ||
    !Array.isArray(evidence.nodeMarkers) ||
    !Array.isArray(evidence.actionMarkers) ||
    evidence.reachableFiles.length > 500 ||
    evidence.nodeMarkers.length > 500 ||
    evidence.actionMarkers.length > 16_000
  )
    throw new ReactBindingManifestError('INVALID_CONTEXT', 'React compiler evidence is invalid.');
  const boundedText = (item: unknown, maximum = 512): item is string =>
    typeof item === 'string' && item.length > 0 && item.length <= maximum;
  if (
    evidence.projectId.length > 128 ||
    evidence.sourceRevisionId.length > 256 ||
    !boundedText(evidence.entrypoint) ||
    new Set(evidence.reachableFiles).size !== evidence.reachableFiles.length ||
    evidence.reachableFiles.some((item) => !boundedText(item)) ||
    evidence.nodeMarkers.some(
      (item) =>
        typeof item !== 'object' ||
        item === null ||
        !boundedText(item.sourceNodeId, 128) ||
        !boundedText(item.path) ||
        !boundedText(item.exportName, 128) ||
        !Array.isArray(item.guards) ||
        item.guards.length > 8 ||
        item.guards.some(
          (guard: ReactBindingRuntimeGuard) =>
            typeof guard !== 'object' ||
            guard === null ||
            (guard.surface !== 'node' &&
              guard.surface !== 'state' &&
              guard.surface !== 'overlay') ||
            (guard.operator !== 'equals' && guard.operator !== 'not-equals') ||
            !boundedText(guard.value, 128)
        )
    ) ||
    evidence.actionMarkers.some(
      (item) =>
        typeof item !== 'object' ||
        item === null ||
        !boundedText(item.graphNodeId, 128) ||
        !boundedText(item.portId, 128) ||
        !boundedText(item.sourceNodeId, 128) ||
        !boundedText(item.path) ||
        !boundedText(item.exportName, 128) ||
        !Array.isArray(item.guards) ||
        item.guards.length > 8 ||
        item.guards.some(
          (guard: ReactBindingRuntimeGuard) =>
            typeof guard !== 'object' ||
            guard === null ||
            (guard.surface !== 'node' &&
              guard.surface !== 'state' &&
              guard.surface !== 'overlay') ||
            (guard.operator !== 'equals' && guard.operator !== 'not-equals') ||
            !boundedText(guard.value, 128)
        )
    )
  )
    throw new ReactBindingManifestError('INVALID_CONTEXT', 'React compiler evidence is invalid.');
  const nodeKeys = new Set<string>();
  const actionKeys = new Set<string>();
  for (const item of evidence.nodeMarkers) {
    if (nodeKeys.has(item.sourceNodeId))
      throw new ReactBindingManifestError('INVALID_CONTEXT', 'React compiler evidence is invalid.');
    nodeKeys.add(item.sourceNodeId);
  }
  for (const item of evidence.actionMarkers) {
    const key = `${item.graphNodeId}\u0000${item.portId}`;
    if (actionKeys.has(key))
      throw new ReactBindingManifestError('INVALID_CONTEXT', 'React compiler evidence is invalid.');
    actionKeys.add(key);
  }
  return structuredClone(evidence);
}

function renderabilityFailure(
  error: unknown
): Exclude<ReactDefaultRenderability, { readonly status: 'renderable' }> {
  if (error instanceof ReactBindingManifestError)
    return {
      status: 'unrenderable',
      reason: rendererReasonFor(error.code),
      message: error.message
    };
  return {
    status: 'unrenderable',
    reason: 'binding-invalid',
    message: 'React binding is invalid.'
  };
}

function rendererReasonFor(
  code: ReactBindingManifestErrorCode
): Exclude<ReactDefaultRenderability, { readonly status: 'renderable' }>['reason'] {
  switch (code) {
    case 'NODE_UNBOUND':
    case 'SOURCE_NODE_MISSING':
    case 'ACTION_BINDING_MISSING':
    case 'ACTION_BINDING_DANGLING':
      return 'binding-missing';
    case 'PROJECT_MISMATCH':
    case 'SOURCE_REVISION_MISMATCH':
    case 'GRAPH_REVISION_MISMATCH':
    case 'RUNTIME_SURFACE_STALE':
      return 'binding-stale';
    case 'RUNTIME_GUARD_MISMATCH':
      return 'runtime-guard-mismatch';
    case 'SOURCE_MARKER_MISSING':
    case 'ACTION_MARKER_MISSING':
      return 'static-source-missing';
    case 'INVALID_MANIFEST':
    case 'INVALID_CONTEXT':
    case 'ACTION_NOT_ACTIVE':
    case 'ACTION_PORT_MISSING':
    case 'ACTION_BINDING_EXTRA':
      return 'binding-invalid';
  }
}

function parseBindingGraph(value: unknown): PrototypeGraph {
  try {
    return parsePrototypeGraph(value);
  } catch {
    throw new ReactBindingManifestError('INVALID_CONTEXT', 'React binding context is invalid.');
  }
}

function validateBindingWorkspace(value: ReactSourceWorkspace): void {
  try {
    validateReactSourceWorkspace(value);
  } catch {
    throw new ReactBindingManifestError('INVALID_CONTEXT', 'React binding context is invalid.');
  }
}

interface PreparedReactBinding {
  readonly manifest: ReactBindingManifest;
  readonly graph: PrototypeGraph;
  readonly evidenceNodes: ReadonlyMap<string, ReactBindingCompilerEvidence['nodeMarkers'][number]>;
  readonly evidenceActions: ReadonlyMap<
    string,
    ReactBindingCompilerEvidence['actionMarkers'][number]
  >;
}

/** Validates local graph/source correspondence without importing or executing user source. */
function prepareReactBinding(value: unknown, context: ReactBindingContext): PreparedReactBinding {
  const manifest = parseReactBindingManifest(value);
  const graph = parseBindingGraph(context.graph);
  validateBindingWorkspace(context.workspace);
  if (!Number.isSafeInteger(context.graphRevision) || context.graphRevision < 0)
    throw new ReactBindingManifestError('INVALID_CONTEXT', 'React binding context is invalid.');
  if (manifest.projectId !== context.workspace.projectId)
    throw new ReactBindingManifestError(
      'PROJECT_MISMATCH',
      'React binding does not match the active project.'
    );
  if (manifest.sourceRevisionId !== context.workspace.revision.id)
    throw new ReactBindingManifestError(
      'SOURCE_REVISION_MISMATCH',
      'React binding does not match the active source revision.'
    );
  if (manifest.graphId !== graph.id || manifest.graphRevision !== context.graphRevision)
    throw new ReactBindingManifestError(
      'GRAPH_REVISION_MISMATCH',
      'React binding does not match the active graph revision.'
    );
  const bindings = new Map(manifest.nodeBindings.map((binding) => [binding.graphNodeId, binding]));
  const actions = new Map(
    manifest.actionBindings.map((binding) => [
      `${binding.graphNodeId}\u0000${binding.portId}`,
      binding
    ])
  );
  const sourceNodes = new Map(context.workspace.nodes.map((node) => [node.nodeId, node]));
  const evidence = parseReactBindingCompilerEvidence(context.compilerEvidence);
  if (
    evidence.projectId !== context.workspace.projectId ||
    evidence.sourceRevisionId !== context.workspace.revision.id ||
    evidence.entrypoint !== context.workspace.entrypoint ||
    evidence.sourceSha256 === '' ||
    evidence.outputSha256 === '' ||
    !evidence.reachableFiles.includes(context.workspace.entrypoint)
  )
    throw new ReactBindingManifestError(
      'SOURCE_REVISION_MISMATCH',
      'React compiler evidence does not match the active source revision.'
    );
  const evidenceNodes = new Map(evidence.nodeMarkers.map((item) => [item.sourceNodeId, item]));
  const evidenceActions = new Map(
    evidence.actionMarkers.map((item) => [`${item.graphNodeId}\u0000${item.portId}`, item])
  );
  for (const node of graph.nodes) {
    const binding = bindings.get(node.id);
    if (binding === undefined)
      throw new ReactBindingManifestError('NODE_UNBOUND', 'A graph node is not bound to source.');
    const source = sourceNodes.get(binding.sourceNodeId);
    if (source === undefined)
      throw new ReactBindingManifestError(
        'SOURCE_NODE_MISSING',
        'A bound source node is unavailable.'
      );
    const marker = evidenceNodes.get(source.nodeId);
    if (
      marker === undefined ||
      marker.path !== source.path ||
      marker.exportName !== source.exportName ||
      !evidence.reachableFiles.includes(marker.path)
    )
      throw new ReactBindingManifestError(
        'SOURCE_MARKER_MISSING',
        'A bound source node is not present in compiler evidence.'
      );
  }
  if (bindings.size !== graph.nodes.length)
    throw new ReactBindingManifestError('INVALID_MANIFEST', 'React binding manifest is invalid.');
  for (const node of graph.nodes)
    for (const port of node.ports) {
      const action = actions.get(`${node.id}\u0000${port.id}`);
      if (action === undefined)
        throw new ReactBindingManifestError(
          'ACTION_BINDING_MISSING',
          'A graph action is not bound to source.'
        );
      if (!sourceNodes.has(action.sourceNodeId))
        throw new ReactBindingManifestError(
          'ACTION_BINDING_DANGLING',
          'A bound action source node is unavailable.'
        );
      const marker = evidenceActions.get(`${node.id}\u0000${port.id}`);
      const source = sourceNodes.get(action.sourceNodeId);
      if (
        marker === undefined ||
        source === undefined ||
        marker.sourceNodeId !== action.sourceNodeId ||
        marker.path !== source.path ||
        marker.exportName !== source.exportName ||
        !evidence.reachableFiles.includes(marker.path)
      )
        throw new ReactBindingManifestError(
          'ACTION_MARKER_MISSING',
          'A graph action is not present in compiler evidence.'
        );
    }
  if (actions.size !== graph.nodes.reduce((total, node) => total + node.ports.length, 0))
    throw new ReactBindingManifestError(
      'ACTION_BINDING_EXTRA',
      'React binding manifest is invalid.'
    );
  return { manifest, graph, evidenceNodes, evidenceActions };
}

/** Validates local graph/source correspondence without importing or executing user source. */
export function validateReactBindingManifest(
  value: unknown,
  context: ReactBindingContext
): ReactBindingManifest {
  return prepareReactBinding(value, context).manifest;
}

function runtimeValue(
  runtime: Pick<PrototypeRuntimeSnapshot, 'activeNodeId' | 'activeStateId' | 'activeOverlayId'>,
  surface: ReactBindingRuntimeGuard['surface']
): string | undefined {
  return surface === 'node'
    ? runtime.activeNodeId
    : surface === 'state'
      ? runtime.activeStateId
      : runtime.activeOverlayId;
}

function assertRuntimeGuards(
  guards: readonly ReactBindingRuntimeGuard[],
  runtime: Pick<PrototypeRuntimeSnapshot, 'activeNodeId' | 'activeStateId' | 'activeOverlayId'>
): void {
  if (
    !guards.every((guard) => {
      const actual = runtimeValue(runtime, guard.surface);
      return guard.operator === 'equals' ? actual === guard.value : actual !== guard.value;
    })
  )
    throw new ReactBindingManifestError(
      'RUNTIME_GUARD_MISMATCH',
      'A compiler-issued runtime guard does not match the active preview surface.'
    );
}

function activeRuntimeSurfaceIds(
  runtime: Pick<PrototypeRuntimeSnapshot, 'activeNodeId' | 'activeStateId' | 'activeOverlayId'>
): readonly string[] {
  return [runtime.activeNodeId, runtime.activeStateId, runtime.activeOverlayId].filter(
    (id): id is string => id !== undefined
  );
}

function assertPreparedRuntimeSurface(
  prepared: PreparedReactBinding,
  runtime: Pick<PrototypeRuntimeSnapshot, 'activeNodeId' | 'activeStateId' | 'activeOverlayId'>,
  action?: { readonly nodeId: string; readonly portId: string }
): void {
  const activeIds = activeRuntimeSurfaceIds(runtime);
  if (activeIds.some((id) => !prepared.graph.nodes.some((node) => node.id === id)))
    throw new ReactBindingManifestError(
      'RUNTIME_SURFACE_STALE',
      'Runtime surface is not present in the current graph.'
    );
  for (const nodeId of activeIds) {
    const binding = prepared.manifest.nodeBindings.find((item) => item.graphNodeId === nodeId);
    const marker =
      binding === undefined ? undefined : prepared.evidenceNodes.get(binding.sourceNodeId);
    if (marker === undefined)
      throw new ReactBindingManifestError(
        'SOURCE_MARKER_MISSING',
        'An active graph surface is not present in compiler evidence.'
      );
    assertRuntimeGuards(marker.guards, runtime);
  }
  if (action === undefined) return;
  if (!activeIds.includes(action.nodeId))
    throw new ReactBindingManifestError(
      'ACTION_NOT_ACTIVE',
      'Runtime action is not on an active surface.'
    );
  const node = prepared.graph.nodes.find((item) => item.id === action.nodeId);
  if (node === undefined || !node.ports.some((port) => port.id === action.portId))
    throw new ReactBindingManifestError(
      'ACTION_PORT_MISSING',
      'Runtime action port is not present in the current graph.'
    );
  const binding = prepared.manifest.actionBindings.find(
    (item) => item.graphNodeId === action.nodeId && item.portId === action.portId
  );
  const marker = prepared.evidenceActions.get(`${action.nodeId}\u0000${action.portId}`);
  if (binding === undefined || marker?.sourceNodeId !== binding.sourceNodeId)
    throw new ReactBindingManifestError(
      'ACTION_MARKER_MISSING',
      'Runtime action port is not statically rendered.'
    );
  assertRuntimeGuards(marker.guards, runtime);
}

export function evaluateReactScenarioRenderability(
  value: unknown | undefined,
  context: ReactBindingContext,
  scenarioId: string
): ReactScenarioRenderability {
  if (value === undefined)
    return {
      status: 'unrenderable',
      scenarioId,
      reason: 'binding-missing',
      message: 'No React binding is configured for this graph.'
    };
  try {
    const prepared = prepareReactBinding(value, context);
    const scenario = prepared.graph.scenarios.find((item) => item.id === scenarioId);
    if (scenario === undefined)
      return {
        status: 'unrenderable',
        scenarioId,
        reason: 'binding-invalid',
        message: 'Scenario is unavailable.'
      };
    const runtime = createPrototypeRuntime(prepared.graph, scenario.id);
    let snapshot = runtime.snapshot();
    assertPreparedRuntimeSurface(prepared, snapshot);
    for (let index = 1; index < scenario.expectedPath.length; index += 1) {
      const fromNodeId = scenario.expectedPath[index - 1]!;
      const expectedNodeId = scenario.expectedPath[index]!;
      if (!activeRuntimeSurfaceIds(snapshot).includes(fromNodeId))
        throw new ReactBindingManifestError(
          'RUNTIME_GUARD_MISMATCH',
          'Scenario expected path is not active in the compiled preview.'
        );
      const transitions = prepared.graph.transitions.filter(
        (transition) =>
          transition.from.nodeId === fromNodeId &&
          'to' in transition &&
          transition.to.nodeId === expectedNodeId
      );
      if (transitions.length !== 1)
        throw new ReactBindingManifestError(
          'INVALID_CONTEXT',
          'Scenario expected path is not uniquely wired in the active graph.'
        );
      const transition = transitions[0]!;
      assertPreparedRuntimeSurface(prepared, snapshot, transition.from);
      snapshot = runtime.dispatch({ type: 'trigger', ...transition.from });
      if (!activeRuntimeSurfaceIds(snapshot).includes(expectedNodeId))
        throw new ReactBindingManifestError(
          'RUNTIME_GUARD_MISMATCH',
          'Scenario expected path does not reach the declared runtime surface.'
        );
      assertPreparedRuntimeSurface(prepared, snapshot);
    }
    return { status: 'renderable', scenarioId: scenario.id };
  } catch (error) {
    return { ...renderabilityFailure(error), scenarioId };
  }
}

/** Evaluates the scenario-less graph initial entry without treating it as a named scenario. */
export function evaluateReactDefaultRenderability(
  value: unknown | undefined,
  context: ReactBindingContext
): ReactDefaultRenderability {
  if (value === undefined)
    return {
      status: 'unrenderable',
      reason: 'binding-missing',
      message: 'No React binding is configured for this graph.'
    };
  try {
    const prepared = prepareReactBinding(value, context);
    assertPreparedRuntimeSurface(prepared, createPrototypeRuntime(prepared.graph).snapshot());
    return { status: 'renderable' };
  } catch (error) {
    return renderabilityFailure(error);
  }
}

/** Confirms that the host-owned runtime can only dispatch from statically bound surfaces. */
export function validateReactRuntimeSurface(
  value: unknown,
  context: ReactBindingContext,
  runtime: Pick<PrototypeRuntimeSnapshot, 'activeNodeId' | 'activeStateId' | 'activeOverlayId'>,
  action?: { readonly nodeId: string; readonly portId: string }
): ReactBindingManifest {
  const prepared = prepareReactBinding(value, context);
  assertPreparedRuntimeSurface(prepared, runtime, action);
  return prepared.manifest;
}

/** Rebinds only stable source IDs after a validated agent patch; graph IDs and ports never move. */
export function remapReactBindingManifest(
  value: unknown,
  graph: PrototypeGraph,
  graphRevision: number,
  previous: ReactSourceWorkspace,
  next: ReactSourceWorkspace,
  patch: Pick<AgentSourcePatch, 'nodeIdMapping'>,
  evidence: {
    readonly previous: ReactBindingCompilerEvidence;
    readonly next: ReactBindingCompilerEvidence;
  }
): ReactBindingManifest {
  const manifest = validateReactBindingManifest(value, {
    graph,
    graphRevision,
    workspace: previous,
    compilerEvidence: evidence.previous
  });
  const map = patch.nodeIdMapping ?? {};
  const remapped = {
    ...manifest,
    sourceRevisionId: next.revision.id,
    nodeBindings: manifest.nodeBindings.map((binding) => ({
      ...binding,
      sourceNodeId: map[binding.sourceNodeId] ?? binding.sourceNodeId
    })),
    actionBindings: manifest.actionBindings.map((binding) => ({
      ...binding,
      sourceNodeId: map[binding.sourceNodeId] ?? binding.sourceNodeId
    }))
  };
  return validateReactBindingManifest(remapped, {
    graph,
    graphRevision,
    workspace: next,
    compilerEvidence: evidence.next
  });
}
