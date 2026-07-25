import { z } from 'zod';

/** The portable, executable-in-a-host prototype graph wire format. */
export const prototypeGraphFormat = 'selene-prototype-graph/v1' as const;

const idSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/);
const labelSchema = z.string().trim().min(1).max(160);
function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

const routeSchema = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      value.startsWith('/') &&
      !value.startsWith('//') &&
      !value.includes('\\') &&
      !containsAsciiControl(value) &&
      new URL(value, 'https://selene.invalid').origin === 'https://selene.invalid',
    'route must be an internal absolute path'
  );
const pointSchema = z
  .object({
    x: z.number().finite().min(-100_000).max(100_000),
    y: z.number().finite().min(-100_000).max(100_000)
  })
  .strict();

export const prototypeTriggerSchema = z.enum(['click', 'submit', 'change', 'key', 'timeout']);
export const prototypeActionPortSchema = z.discriminatedUnion('trigger', [
  z
    .object({
      id: idSchema,
      label: labelSchema,
      trigger: z.enum(['click', 'submit', 'change', 'key'])
    })
    .strict(),
  z
    .object({
      id: idSchema,
      label: labelSchema,
      trigger: z.literal('timeout'),
      timeoutMs: z.number().int().min(10).max(300_000)
    })
    .strict()
]);

const baseNodeSchema = z
  .object({
    id: idSchema,
    label: labelSchema,
    position: pointSchema,
    ports: z.array(prototypeActionPortSchema).max(32)
  })
  .strict()
  .refine((node) => new Set(node.ports.map((port) => port.id)).size === node.ports.length, {
    message: 'action port IDs must be unique'
  });

export const prototypeNodeSchema = z.discriminatedUnion('kind', [
  baseNodeSchema.extend({ kind: z.literal('screen'), route: routeSchema }),
  baseNodeSchema.extend({ kind: z.literal('page'), route: routeSchema }),
  baseNodeSchema.extend({ kind: z.literal('state'), parentId: idSchema }),
  baseNodeSchema.extend({ kind: z.literal('overlay'), dismissible: z.boolean() })
]);

export const prototypeTransitionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      id: idSchema,
      kind: z.literal('navigate'),
      from: z.object({ nodeId: idSchema, portId: idSchema }).strict(),
      to: z.object({ nodeId: idSchema }).strict()
    })
    .strict(),
  z
    .object({
      id: idSchema,
      kind: z.literal('back'),
      from: z.object({ nodeId: idSchema, portId: idSchema }).strict()
    })
    .strict(),
  z
    .object({
      id: idSchema,
      kind: z.literal('set-state'),
      from: z.object({ nodeId: idSchema, portId: idSchema }).strict(),
      to: z.object({ nodeId: idSchema }).strict()
    })
    .strict(),
  z
    .object({
      id: idSchema,
      kind: z.literal('open-overlay'),
      from: z.object({ nodeId: idSchema, portId: idSchema }).strict(),
      to: z.object({ nodeId: idSchema }).strict()
    })
    .strict(),
  z
    .object({
      id: idSchema,
      kind: z.literal('close-overlay'),
      from: z.object({ nodeId: idSchema, portId: idSchema }).strict(),
      to: z.object({ nodeId: idSchema }).strict()
    })
    .strict(),
  z
    .object({
      id: idSchema,
      kind: z.literal('reset-flow'),
      from: z.object({ nodeId: idSchema, portId: idSchema }).strict()
    })
    .strict()
]);

export const prototypeProjectSchema = z
  .object({ projectId: idSchema, owner: labelSchema })
  .strict();
export const prototypeRevisionSchema = z
  .object({
    id: idSchema,
    parentId: idSchema.optional(),
    createdAt: z.string().datetime(),
    summary: labelSchema
  })
  .strict();
export const prototypeHandoffSchema = z
  .object({ status: z.enum(['draft', 'ready']), owner: labelSchema, summary: labelSchema })
  .strict();
export const prototypeScenarioSchema = z
  .object({
    id: idSchema,
    name: labelSchema,
    startNodeId: idSchema,
    initialStateId: idSchema.optional(),
    expectedPath: z.array(idSchema).min(1).max(500)
  })
  .strict();

const fixtureKeySchema = z.string().min(1).max(128);
const fixtureSchema = z.record(fixtureKeySchema, z.unknown());
const maxFixtureDepth = 16;
const maxFixtureKeys = 5_000;
const maxFixtureBytes = 256_000;
const maxImportedBytes = 2_000_000;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function fixtureIssue(value: unknown): string | undefined {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let keyCount = 0;
  let estimatedBytes = 0;
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item.depth > maxFixtureDepth) return 'fixtures exceed maximum nesting depth';
    if (item.value === null || typeof item.value === 'boolean') {
      estimatedBytes += 5;
      continue;
    }
    if (typeof item.value === 'number') {
      if (!Number.isFinite(item.value)) return 'fixtures contain a non-finite number';
      estimatedBytes += 24;
      continue;
    }
    if (typeof item.value === 'string') {
      if (utf8ByteLength(item.value) > 10_000) return 'fixtures contain an oversized string';
      estimatedBytes += utf8ByteLength(item.value);
      continue;
    }
    if (typeof item.value !== 'object') return 'fixtures contain an unsupported value';
    if (seen.has(item.value)) return 'fixtures must not contain cycles';
    seen.add(item.value);
    if (Array.isArray(item.value)) {
      if (item.value.length > 1_000) return 'fixtures contain an oversized array';
      for (const child of item.value) stack.push({ value: child, depth: item.depth + 1 });
      continue;
    }
    if (Object.getPrototypeOf(item.value) !== Object.prototype)
      return 'fixtures must use plain objects';
    const entries = Object.entries(item.value);
    keyCount += entries.length;
    if (keyCount > maxFixtureKeys) return 'fixtures contain too many keys';
    for (const [key, child] of entries) {
      if (!fixtureKeySchema.safeParse(key).success) return 'fixtures contain an invalid key';
      estimatedBytes += utf8ByteLength(key);
      if (estimatedBytes > maxFixtureBytes) return 'fixtures exceed maximum serialized size';
      stack.push({ value: child, depth: item.depth + 1 });
    }
  }
  return estimatedBytes > maxFixtureBytes ? 'fixtures exceed maximum serialized size' : undefined;
}

export const prototypeGraphSchema = z
  .object({
    format: z.literal(prototypeGraphFormat),
    id: idSchema,
    name: labelSchema,
    project: prototypeProjectSchema,
    revision: prototypeRevisionSchema,
    handoff: prototypeHandoffSchema,
    initialNodeId: idSchema,
    nodes: z.array(prototypeNodeSchema).min(1).max(500),
    transitions: z.array(prototypeTransitionSchema).max(2_000),
    scenarios: z.array(prototypeScenarioSchema).min(1).max(200),
    fixtures: fixtureSchema
  })
  .strict()
  .superRefine((graph, context) => {
    const invalidFixtures = fixtureIssue(graph.fixtures);
    if (invalidFixtures)
      context.addIssue({ code: 'custom', message: invalidFixtures, path: ['fixtures'] });
    const nodeIds = new Set(graph.nodes.map((node) => node.id));
    if (nodeIds.size !== graph.nodes.length)
      context.addIssue({ code: 'custom', message: 'node IDs must be unique', path: ['nodes'] });
    const transitionIds = new Set(graph.transitions.map((transition) => transition.id));
    if (transitionIds.size !== graph.transitions.length)
      context.addIssue({
        code: 'custom',
        message: 'transition IDs must be unique',
        path: ['transitions']
      });
    const actionPorts = new Set(
      graph.transitions.map(
        (transition) => `${transition.from.nodeId}\u0000${transition.from.portId}`
      )
    );
    if (actionPorts.size !== graph.transitions.length)
      context.addIssue({
        code: 'custom',
        message: 'each action port may have only one transition',
        path: ['transitions']
      });
    const initial = graph.nodes.find((node) => node.id === graph.initialNodeId);
    if (initial?.kind !== 'screen' && initial?.kind !== 'page')
      context.addIssue({
        code: 'custom',
        message: 'initialNodeId must reference a screen or page',
        path: ['initialNodeId']
      });

    for (const [index, node] of graph.nodes.entries()) {
      if (node.kind === 'state') {
        const parent = graph.nodes.find((candidate) => candidate.id === node.parentId);
        if (parent?.kind !== 'screen' && parent?.kind !== 'page')
          context.addIssue({
            code: 'custom',
            message: 'state parentId must reference a screen or page',
            path: ['nodes', index, 'parentId']
          });
      }
    }
    const routes = graph.nodes
      .filter(
        (node): node is Extract<PrototypeNode, { kind: 'screen' | 'page' }> =>
          node.kind === 'screen' || node.kind === 'page'
      )
      .map((node) => node.route);
    if (new Set(routes).size !== routes.length)
      context.addIssue({
        code: 'custom',
        message: 'screen and page routes must be unique',
        path: ['nodes']
      });
    const scenarioIds = new Set(graph.scenarios.map((scenario) => scenario.id));
    if (scenarioIds.size !== graph.scenarios.length)
      context.addIssue({
        code: 'custom',
        message: 'scenario IDs must be unique',
        path: ['scenarios']
      });
    for (const [index, scenario] of graph.scenarios.entries()) {
      const start = graph.nodes.find((node) => node.id === scenario.startNodeId);
      if (start?.kind !== 'screen' && start?.kind !== 'page')
        context.addIssue({
          code: 'custom',
          message: 'scenario startNodeId must reference a screen or page',
          path: ['scenarios', index, 'startNodeId']
        });
      const initialState = graph.nodes.find((node) => node.id === scenario.initialStateId);
      if (scenario.initialStateId !== undefined && initialState?.kind !== 'state')
        context.addIssue({
          code: 'custom',
          message: 'scenario initialStateId must reference a state',
          path: ['scenarios', index, 'initialStateId']
        });
      else if (initialState?.kind === 'state' && initialState.parentId !== scenario.startNodeId)
        context.addIssue({
          code: 'custom',
          message: 'scenario initial state must belong to its start node',
          path: ['scenarios', index, 'initialStateId']
        });
      if (scenario.expectedPath[0] !== scenario.startNodeId)
        context.addIssue({
          code: 'custom',
          message: 'scenario expectedPath must begin at startNodeId',
          path: ['scenarios', index, 'expectedPath', 0]
        });
      for (const [pathIndex, nodeId] of scenario.expectedPath.entries())
        if (!nodeIds.has(nodeId))
          context.addIssue({
            code: 'custom',
            message: 'scenario expectedPath references an unknown node',
            path: ['scenarios', index, 'expectedPath', pathIndex]
          });
      for (let pathIndex = 1; pathIndex < scenario.expectedPath.length; pathIndex += 1) {
        const fromNodeId = scenario.expectedPath[pathIndex - 1]!;
        const toNodeId = scenario.expectedPath[pathIndex]!;
        if (
          !graph.transitions.some(
            (transition) =>
              transition.from.nodeId === fromNodeId &&
              'to' in transition &&
              transition.to.nodeId === toNodeId
          )
        )
          context.addIssue({
            code: 'custom',
            message: 'scenario expectedPath contains an unwired transition',
            path: ['scenarios', index, 'expectedPath', pathIndex]
          });
      }
    }
    for (const [index, transition] of graph.transitions.entries()) {
      const source = graph.nodes.find((node) => node.id === transition.from.nodeId);
      if (!source)
        context.addIssue({
          code: 'custom',
          message: 'transition source node does not exist',
          path: ['transitions', index, 'from', 'nodeId']
        });
      else if (!source.ports.some((port) => port.id === transition.from.portId))
        context.addIssue({
          code: 'custom',
          message: 'transition source port does not exist',
          path: ['transitions', index, 'from', 'portId']
        });
      if (transition.kind === 'back' || transition.kind === 'reset-flow') continue;
      const target = graph.nodes.find((node) => node.id === transition.to.nodeId);
      if (!target)
        context.addIssue({
          code: 'custom',
          message: 'transition target node does not exist',
          path: ['transitions', index, 'to', 'nodeId']
        });
      else if (transition.kind === 'navigate' && target.kind !== 'screen' && target.kind !== 'page')
        context.addIssue({
          code: 'custom',
          message: 'navigate must target a screen or page',
          path: ['transitions', index, 'to', 'nodeId']
        });
      else if (transition.kind === 'set-state' && target.kind !== 'state')
        context.addIssue({
          code: 'custom',
          message: 'set-state must target a state',
          path: ['transitions', index, 'to', 'nodeId']
        });
      else if (transition.kind === 'set-state' && target.kind === 'state') {
        const sourceParentId =
          source?.kind === 'state'
            ? source.parentId
            : source?.kind === 'screen' || source?.kind === 'page'
              ? source.id
              : undefined;
        if (target.parentId !== sourceParentId)
          context.addIssue({
            code: 'custom',
            message: 'set-state must target a state owned by its source screen, page, or state',
            path: ['transitions', index, 'to', 'nodeId']
          });
      } else if (
        (transition.kind === 'open-overlay' || transition.kind === 'close-overlay') &&
        target.kind !== 'overlay'
      )
        context.addIssue({
          code: 'custom',
          message: `${transition.kind} must target an overlay`,
          path: ['transitions', index, 'to', 'nodeId']
        });
    }
  });

export type PrototypeGraph = z.infer<typeof prototypeGraphSchema>;
export type PrototypeNode = z.infer<typeof prototypeNodeSchema>;
export type PrototypeTransition = z.infer<typeof prototypeTransitionSchema>;
export type PrototypeTrigger = z.infer<typeof prototypeTriggerSchema>;
export type PrototypeActionPort = z.infer<typeof prototypeActionPortSchema>;
export type PrototypeScenario = z.infer<typeof prototypeScenarioSchema>;
export type PrototypeProject = z.infer<typeof prototypeProjectSchema>;
export type PrototypeRevision = z.infer<typeof prototypeRevisionSchema>;
export type PrototypeHandoff = z.infer<typeof prototypeHandoffSchema>;

/** A host-provided connector command. Core validates both its shape and graph semantics. */
export type PrototypeTransitionConnection = PrototypeTransition;

export class PrototypeGraphValidationError extends Error {
  public constructor(readonly issues: readonly string[]) {
    super(issues.join('; '));
    this.name = 'PrototypeGraphValidationError';
  }
}

/** Parses every external graph boundary before it can reach a renderer or runtime. */
export function parsePrototypeGraph(value: unknown): PrototypeGraph {
  const result = prototypeGraphSchema.safeParse(value);
  if (result.success) return result.data;
  throw new PrototypeGraphValidationError(
    result.error.issues.map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
  );
}

export const prototypeRuntimeActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('trigger'), nodeId: idSchema, portId: idSchema }).strict(),
  z.object({ type: z.literal('back') }).strict()
]);
export type PrototypeRuntimeAction = z.infer<typeof prototypeRuntimeActionSchema>;

export interface PrototypeRuntimeSnapshot {
  readonly activeNodeId: string;
  readonly activeStateId?: string | undefined;
  readonly activeOverlayId?: string | undefined;
  readonly scenarioId?: string | undefined;
  readonly history: readonly string[];
  readonly historyPathLengths: readonly number[];
  readonly activePathTransitionIds: readonly string[];
  readonly fixtures: Readonly<Record<string, unknown>>;
}

export const prototypeRuntimeSnapshotSchema = z
  .object({
    activeNodeId: idSchema,
    activeStateId: idSchema.optional(),
    activeOverlayId: idSchema.optional(),
    scenarioId: idSchema.optional(),
    history: z.array(idSchema).min(1).max(501),
    historyPathLengths: z.array(z.number().int().min(0).max(2_000)).min(1).max(501),
    activePathTransitionIds: z.array(idSchema).max(2_000),
    fixtures: fixtureSchema
  })
  .strict();

export class PrototypeRuntimeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PrototypeRuntimeError';
  }
}

function scenarioFor(
  graph: PrototypeGraph,
  scenarioId: string | undefined
): PrototypeScenario | undefined {
  const scenario =
    scenarioId === undefined ? undefined : graph.scenarios.find((item) => item.id === scenarioId);
  if (scenarioId !== undefined && scenario === undefined)
    throw new PrototypeRuntimeError('Invalid prototype runtime snapshot scenario');
  return scenario;
}

function initialRuntimeSnapshot(
  graph: PrototypeGraph,
  scenarioId: string | undefined
): PrototypeRuntimeSnapshot {
  const scenario = scenarioFor(graph, scenarioId);
  const activeNodeId = scenario?.startNodeId ?? graph.initialNodeId;
  return {
    activeNodeId,
    ...(scenario?.initialStateId === undefined ? {} : { activeStateId: scenario.initialStateId }),
    ...(scenario === undefined ? {} : { scenarioId: scenario.id }),
    history: [activeNodeId],
    historyPathLengths: [0],
    activePathTransitionIds: [],
    fixtures: structuredClone(graph.fixtures)
  };
}

function isActiveActionSurface(snapshot: PrototypeRuntimeSnapshot, nodeId: string): boolean {
  return (
    nodeId === snapshot.activeNodeId ||
    nodeId === snapshot.activeStateId ||
    nodeId === snapshot.activeOverlayId
  );
}

function backSnapshot(snapshot: PrototypeRuntimeSnapshot): PrototypeRuntimeSnapshot {
  if (snapshot.history.length <= 1) return structuredClone(snapshot);
  const history = snapshot.history.slice(0, -1);
  return {
    ...snapshot,
    activeNodeId: history.at(-1)!,
    activeStateId: undefined,
    activeOverlayId: undefined,
    history,
    historyPathLengths: snapshot.historyPathLengths.slice(0, -1),
    activePathTransitionIds: snapshot.activePathTransitionIds.slice(
      0,
      snapshot.historyPathLengths.at(-2) ?? 0
    )
  };
}

/** Applies a validated transition without any browser effect. Back has no fixed destination; reset returns to the active scenario's start and initial state. */
function applySnapshotTransition(
  graph: PrototypeGraph,
  snapshot: PrototypeRuntimeSnapshot,
  transition: PrototypeTransition
): PrototypeRuntimeSnapshot {
  if (!isActiveActionSurface(snapshot, transition.from.nodeId))
    throw new PrototypeRuntimeError('Action source is not active in this prototype snapshot');
  switch (transition.kind) {
    case 'navigate': {
      const activePathTransitionIds = [...snapshot.activePathTransitionIds, transition.id];
      return {
        ...snapshot,
        activeNodeId: transition.to.nodeId,
        activeStateId: undefined,
        activeOverlayId: undefined,
        history: [...snapshot.history, transition.to.nodeId],
        historyPathLengths: [...snapshot.historyPathLengths, activePathTransitionIds.length],
        activePathTransitionIds
      };
    }
    case 'back':
      return backSnapshot(snapshot);
    case 'set-state':
      return {
        ...snapshot,
        activeStateId: transition.to.nodeId,
        activePathTransitionIds: [...snapshot.activePathTransitionIds, transition.id]
      };
    case 'open-overlay':
      return {
        ...snapshot,
        activeOverlayId: transition.to.nodeId,
        activePathTransitionIds: [...snapshot.activePathTransitionIds, transition.id]
      };
    case 'close-overlay':
      if (snapshot.activeOverlayId !== transition.to.nodeId)
        throw new PrototypeRuntimeError('Overlay is not active');
      return {
        ...snapshot,
        activeOverlayId: undefined,
        activePathTransitionIds: [...snapshot.activePathTransitionIds, transition.id]
      };
    case 'reset-flow': {
      const initial = initialRuntimeSnapshot(graph, snapshot.scenarioId);
      const activePathTransitionIds = [...snapshot.activePathTransitionIds, transition.id];
      return {
        ...initial,
        historyPathLengths: [activePathTransitionIds.length],
        activePathTransitionIds
      };
    }
  }
}

function replayRuntimeSnapshot(
  graph: PrototypeGraph,
  scenarioId: string | undefined,
  transitionIds: readonly string[]
): PrototypeRuntimeSnapshot {
  let replayed = initialRuntimeSnapshot(graph, scenarioId);
  for (const transitionId of transitionIds) {
    const transition = graph.transitions.find((item) => item.id === transitionId);
    if (!transition) throw new PrototypeRuntimeError('Invalid prototype runtime snapshot path');
    replayed = applySnapshotTransition(graph, replayed, transition);
  }
  return replayed;
}

/** Parses an untrusted persisted snapshot against a concrete, immutable graph. */
export function parsePrototypeRuntimeSnapshot(
  value: unknown,
  graphValue: unknown
): PrototypeRuntimeSnapshot {
  const graph = parsePrototypeGraph(graphValue);
  const result = prototypeRuntimeSnapshotSchema.safeParse(value);
  if (!result.success) throw new PrototypeRuntimeError('Invalid prototype runtime snapshot');
  const snapshot = result.data;
  if (fixtureIssue(snapshot.fixtures) !== undefined)
    throw new PrototypeRuntimeError('Invalid prototype runtime snapshot fixtures');
  let replayed: PrototypeRuntimeSnapshot;
  try {
    replayed = replayRuntimeSnapshot(graph, snapshot.scenarioId, snapshot.activePathTransitionIds);
  } catch (error) {
    if (error instanceof PrototypeRuntimeError) throw error;
    throw new PrototypeRuntimeError('Invalid prototype runtime snapshot path');
  }
  if (
    replayed.activeNodeId !== snapshot.activeNodeId ||
    replayed.activeStateId !== snapshot.activeStateId ||
    replayed.activeOverlayId !== snapshot.activeOverlayId ||
    replayed.scenarioId !== snapshot.scenarioId ||
    JSON.stringify(replayed.activePathTransitionIds) !==
      JSON.stringify(snapshot.activePathTransitionIds) ||
    JSON.stringify(replayed.history) !== JSON.stringify(snapshot.history) ||
    JSON.stringify(replayed.historyPathLengths) !== JSON.stringify(snapshot.historyPathLengths)
  )
    throw new PrototypeRuntimeError('Invalid prototype runtime snapshot history');
  if (JSON.stringify(snapshot.fixtures) !== JSON.stringify(graph.fixtures))
    throw new PrototypeRuntimeError('Invalid prototype runtime snapshot fixtures');
  return structuredClone(snapshot);
}

/** Deterministic, side-effect-free runtime for previews, tests, and generated sandbox fixtures. */
export class PrototypeRuntime {
  private snapshotValue: PrototypeRuntimeSnapshot;
  public readonly graph: PrototypeGraph;

  public constructor(graphValue: unknown, scenarioId?: string) {
    this.graph = structuredClone(parsePrototypeGraph(graphValue));
    if (scenarioId !== undefined && !this.graph.scenarios.some((item) => item.id === scenarioId))
      throw new PrototypeRuntimeError('Unknown prototype scenario');
    this.snapshotValue = initialRuntimeSnapshot(this.graph, scenarioId);
  }

  public snapshot(): PrototypeRuntimeSnapshot {
    return structuredClone(this.snapshotValue);
  }

  /** Restores a snapshot that a host previously serialized into browser history. */
  public restore(value: unknown): PrototypeRuntimeSnapshot {
    this.snapshotValue = parsePrototypeRuntimeSnapshot(value, this.graph);
    return this.snapshot();
  }

  /** Dispatches only a parsed, discriminated action; no URL, network, or browser effect is performed. */
  public dispatch(value: unknown): PrototypeRuntimeSnapshot {
    const parsed = prototypeRuntimeActionSchema.safeParse(value);
    if (!parsed.success) throw new PrototypeRuntimeError('Invalid prototype runtime action');
    const action: PrototypeRuntimeAction = parsed.data;
    if (action.type !== 'trigger') return this.back();
    const transition = this.graph.transitions.find(
      (candidate) =>
        candidate.from.nodeId === action.nodeId && candidate.from.portId === action.portId
    );
    if (!transition) throw new PrototypeRuntimeError('No transition is wired to that action port');
    this.snapshotValue = applySnapshotTransition(this.graph, this.snapshotValue, transition);
    return this.snapshot();
  }

  private back(): PrototypeRuntimeSnapshot {
    this.snapshotValue = backSnapshot(this.snapshotValue);
    return this.snapshot();
  }
}

/** Immutable editor mutation; parsing preserves the same graph invariants as creation. */
export function removePrototypeTransition(graphValue: PrototypeGraph, transitionId: string): PrototypeGraph {
  return parsePrototypeGraph({
    ...graphValue,
    transitions: graphValue.transitions.filter((transition) => transition.id !== transitionId)
  });
}

export interface PrototypeTimeoutHost {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PrototypeTimeoutFailure {
  readonly type: 'unexpected-timeout-error';
  readonly nodeId: string;
  readonly portId: string;
  readonly error: unknown;
}

/** Schedules only currently active, schema-bounded timeout ports and returns cleanup. */
export function schedulePrototypeTimeouts(
  runtime: PrototypeRuntime,
  host: PrototypeTimeoutHost,
  onSnapshot: (snapshot: PrototypeRuntimeSnapshot) => void,
  onError: (failure: PrototypeTimeoutFailure) => void = () => undefined
): () => void {
  const snapshot = runtime.snapshot();
  const activeIds = [
    snapshot.activeNodeId,
    snapshot.activeStateId,
    snapshot.activeOverlayId
  ].filter((id): id is string => id !== undefined);
  const handles: unknown[] = [];
  for (const nodeId of activeIds) {
    const node = runtime.graph.nodes.find((item) => item.id === nodeId);
    if (!node) continue;
    for (const port of node.ports) {
      if (port.trigger !== 'timeout') continue;
      if (
        !runtime.graph.transitions.some(
          (transition) => transition.from.nodeId === nodeId && transition.from.portId === port.id
        )
      )
        continue;
      handles.push(
        host.setTimeout(() => {
          let next: PrototypeRuntimeSnapshot;
          try {
            next = runtime.dispatch({ type: 'trigger', nodeId, portId: port.id });
          } catch (error) {
            const current = runtime.snapshot();
            const stale = !isActiveActionSurface(current, nodeId);
            if (!stale)
              onError({ type: 'unexpected-timeout-error', nodeId, portId: port.id, error });
            return;
          }
          try {
            onSnapshot(next);
          } catch (error) {
            onError({ type: 'unexpected-timeout-error', nodeId, portId: port.id, error });
          }
        }, port.timeoutMs)
      );
    }
  }
  return () => handles.forEach((handle) => host.clearTimeout(handle));
}

export function createPrototypeRuntime(value: unknown, scenarioId?: string): PrototypeRuntime {
  return new PrototypeRuntime(value, scenarioId);
}

/**
 * Replaces the connector for an action port, or appends a new one. This keeps
 * editor gestures deterministic and prevents a port from becoming ambiguous.
 */
export function upsertPrototypeTransition(
  value: unknown,
  connection: PrototypeTransitionConnection
): PrototypeGraph {
  const graph = parsePrototypeGraph(value);
  return parsePrototypeGraph({
    ...graph,
    transitions: [
      ...graph.transitions.filter(
        (transition) =>
          transition.id !== connection.id &&
          (transition.from.nodeId !== connection.from.nodeId ||
            transition.from.portId !== connection.from.portId)
      ),
      connection
    ]
  });
}

const prototypeGraphExportFormat = 'selene-prototype-graph-export/v1' as const;
const prototypeHandoffExportFormat = 'selene-prototype-handoff/v1' as const;

/** Stable JSON transport for import/export boundaries; parsed again on import. */
export function exportPrototypeGraph(value: unknown): string {
  return JSON.stringify({ format: prototypeGraphExportFormat, graph: parsePrototypeGraph(value) });
}

export function importPrototypeGraph(serialized: string): PrototypeGraph {
  if (utf8ByteLength(serialized) > maxImportedBytes)
    throw new PrototypeGraphValidationError(['root: graph export is too large']);
  try {
    const value: unknown = JSON.parse(serialized);
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      (value as { format?: unknown }).format !== prototypeGraphExportFormat
    )
      throw new PrototypeGraphValidationError(['root: unsupported graph export format']);
    return parsePrototypeGraph((value as { graph?: unknown }).graph);
  } catch (error) {
    if (error instanceof PrototypeGraphValidationError) throw error;
    throw new PrototypeGraphValidationError(['root: graph export is not valid JSON']);
  }
}

export interface PrototypeGraphDiff {
  readonly fromRevisionId: string;
  readonly toRevisionId: string;
  readonly addedNodeIds: readonly string[];
  readonly removedNodeIds: readonly string[];
  readonly addedTransitionIds: readonly string[];
  readonly removedTransitionIds: readonly string[];
  readonly changedScenarioIds: readonly string[];
}

export function diffPrototypeGraphs(beforeValue: unknown, afterValue: unknown): PrototypeGraphDiff {
  const before = parsePrototypeGraph(beforeValue);
  const after = parsePrototypeGraph(afterValue);
  const ids = <T extends { id: string }>(items: readonly T[]) =>
    new Set(items.map((item) => item.id));
  const changed = <T extends { id: string }>(
    beforeItems: readonly T[],
    afterItems: readonly T[]
  ) => {
    const beforeById = new Map(beforeItems.map((item) => [item.id, JSON.stringify(item)]));
    return afterItems
      .filter((item) => beforeById.get(item.id) !== JSON.stringify(item))
      .map((item) => item.id);
  };
  const beforeNodes = ids(before.nodes);
  const afterNodes = ids(after.nodes);
  const beforeTransitions = ids(before.transitions);
  const afterTransitions = ids(after.transitions);
  return {
    fromRevisionId: before.revision.id,
    toRevisionId: after.revision.id,
    addedNodeIds: after.nodes.filter((node) => !beforeNodes.has(node.id)).map((node) => node.id),
    removedNodeIds: before.nodes.filter((node) => !afterNodes.has(node.id)).map((node) => node.id),
    addedTransitionIds: after.transitions
      .filter((item) => !beforeTransitions.has(item.id))
      .map((item) => item.id),
    removedTransitionIds: before.transitions
      .filter((item) => !afterTransitions.has(item.id))
      .map((item) => item.id),
    changedScenarioIds: changed(before.scenarios, after.scenarios)
  };
}

export function exportPrototypeHandoff(value: unknown): string {
  const graph = parsePrototypeGraph(value);
  return JSON.stringify({
    format: prototypeHandoffExportFormat,
    project: graph.project,
    revision: graph.revision,
    handoff: graph.handoff,
    graph: JSON.parse(exportPrototypeGraph(graph))
  });
}

export function importPrototypeHandoff(serialized: string): PrototypeGraph {
  try {
    if (utf8ByteLength(serialized) > maxImportedBytes)
      throw new PrototypeGraphValidationError(['root: prototype handoff is too large']);
    const value: unknown = JSON.parse(serialized);
    if (
      typeof value !== 'object' ||
      value === null ||
      (value as { format?: unknown }).format !== prototypeHandoffExportFormat
    )
      throw new PrototypeGraphValidationError(['root: unsupported prototype handoff format']);
    return importPrototypeGraph(JSON.stringify((value as { graph?: unknown }).graph));
  } catch (error) {
    if (error instanceof PrototypeGraphValidationError) throw error;
    throw new PrototypeGraphValidationError(['root: prototype handoff is not valid JSON']);
  }
}

const prototypeFragmentFormat = 'selene-prototype-fragment/v1' as const;

export function copyPrototypeNodes(value: unknown, nodeIds: readonly string[]): string {
  const graph = parsePrototypeGraph(value);
  const selected = new Set(nodeIds);
  const nodes = graph.nodes.filter((node) => selected.has(node.id));
  if (nodes.length === 0)
    throw new PrototypeGraphValidationError(['nodeIds: select at least one node']);
  return JSON.stringify({
    format: prototypeFragmentFormat,
    nodes,
    transitions: graph.transitions.filter(
      (item) => selected.has(item.from.nodeId) && (!('to' in item) || selected.has(item.to.nodeId))
    )
  });
}

export function pastePrototypeNodes(value: unknown, serialized: string): PrototypeGraph {
  const graph = parsePrototypeGraph(value);
  try {
    if (utf8ByteLength(serialized) > maxImportedBytes)
      throw new PrototypeGraphValidationError(['root: prototype fragment is too large']);
    const fragment: unknown = JSON.parse(serialized);
    if (
      typeof fragment !== 'object' ||
      fragment === null ||
      (fragment as { format?: unknown }).format !== prototypeFragmentFormat
    )
      throw new PrototypeGraphValidationError(['root: unsupported prototype fragment']);
    const rawNodes = (fragment as { nodes?: unknown }).nodes;
    const rawTransitions = (fragment as { transitions?: unknown }).transitions;
    if (!Array.isArray(rawNodes) || !Array.isArray(rawTransitions))
      throw new PrototypeGraphValidationError(['root: prototype fragment is malformed']);
    const nodes = z.array(prototypeNodeSchema).min(1).parse(rawNodes);
    const transitions = z.array(prototypeTransitionSchema).parse(rawTransitions);
    const used = new Set(graph.nodes.map((node) => node.id));
    const remap = new Map<string, string>();
    for (const node of nodes) {
      let suffix = 1;
      let next = `${node.id}-copy`;
      while (used.has(next)) {
        suffix += 1;
        next = `${node.id}-copy${suffix}`;
      }
      used.add(next);
      remap.set(node.id, next);
    }
    const usedRoutes = new Set(
      graph.nodes
        .filter(
          (node): node is Extract<PrototypeNode, { kind: 'screen' | 'page' }> =>
            node.kind === 'screen' || node.kind === 'page'
        )
        .map((node) => node.route)
    );
    const remapRoute = (route: string) => {
      let suffix = 1;
      let next = `${route}-copy`;
      while (usedRoutes.has(next)) {
        suffix += 1;
        next = `${route}-copy${suffix}`;
      }
      usedRoutes.add(next);
      return next;
    };
    const pastedNodes = nodes.map((node) => ({
      ...node,
      id: remap.get(node.id)!,
      position: { x: node.position.x + 36, y: node.position.y + 36 },
      ...(node.kind === 'screen' || node.kind === 'page' ? { route: remapRoute(node.route) } : {}),
      ...(node.kind === 'state' ? { parentId: remap.get(node.parentId) ?? node.parentId } : {})
    }));
    const existingTransitions = new Set(graph.transitions.map((item) => item.id));
    const pastedTransitions = transitions
      .map((item, index) => {
        let id = `${item.id}-copy`;
        let suffix = 1;
        while (existingTransitions.has(id)) {
          suffix += 1;
          id = `${item.id}-copy${suffix}`;
        }
        existingTransitions.add(id);
        return {
          ...item,
          id,
          from: { ...item.from, nodeId: remap.get(item.from.nodeId)! },
          ...('to' in item ? { to: { nodeId: remap.get(item.to.nodeId)! } } : {}),
          positionIndex: index
        };
      })
      .map(({ positionIndex: _positionIndex, ...item }) => item);
    return parsePrototypeGraph({
      ...graph,
      nodes: [...graph.nodes, ...pastedNodes],
      transitions: [...graph.transitions, ...pastedTransitions]
    });
  } catch (error) {
    if (error instanceof PrototypeGraphValidationError) throw error;
    throw new PrototypeGraphValidationError(['root: prototype fragment is not valid JSON']);
  }
}

/** Small deterministic fixture used by hosts and contract tests; it carries no backend dependency. */
export const prototypeGraphFixture: PrototypeGraph = parsePrototypeGraph({
  format: prototypeGraphFormat,
  id: 'orders-flow',
  name: 'Orders prototype',
  project: { projectId: 'northstar', owner: 'Mina' },
  revision: {
    id: 'orders-r1',
    createdAt: '2026-07-24T05:00:00.000Z',
    summary: 'Initial orders prototype'
  },
  handoff: { status: 'draft', owner: 'Mina', summary: 'Ready for local prototype review' },
  initialNodeId: 'orders',
  fixtures: {
    orders: [{ id: 'order-1042', customer: 'Ada', total: '$128.00' }],
    viewer: { name: 'Mina' }
  },
  nodes: [
    {
      kind: 'screen',
      id: 'orders',
      label: 'Orders',
      route: '/orders',
      position: { x: 80, y: 170 },
      ports: [
        { id: 'create', label: 'Create order', trigger: 'click' },
        { id: 'filter-empty', label: 'Show empty', trigger: 'change' }
      ]
    },
    {
      kind: 'page',
      id: 'new-order',
      label: 'New order',
      route: '/orders/new',
      position: { x: 420, y: 80 },
      ports: [
        { id: 'save', label: 'Save order', trigger: 'submit' },
        { id: 'cancel', label: 'Cancel', trigger: 'click' },
        { id: 'expire', label: 'Expire order draft', trigger: 'timeout', timeoutMs: 10_000 }
      ]
    },
    {
      kind: 'state',
      id: 'orders-empty',
      label: 'Orders empty',
      parentId: 'orders',
      position: { x: 420, y: 280 },
      ports: [{ id: 'restore', label: 'Restore orders', trigger: 'click' }]
    },
    {
      kind: 'overlay',
      id: 'saved',
      label: 'Order saved',
      dismissible: true,
      position: { x: 760, y: 80 },
      ports: [{ id: 'dismiss', label: 'Dismiss', trigger: 'click' }]
    }
  ],
  transitions: [
    {
      id: 'create-order',
      kind: 'navigate',
      from: { nodeId: 'orders', portId: 'create' },
      to: { nodeId: 'new-order' }
    },
    {
      id: 'filter-empty',
      kind: 'set-state',
      from: { nodeId: 'orders', portId: 'filter-empty' },
      to: { nodeId: 'orders-empty' }
    },
    {
      id: 'restore-orders',
      kind: 'set-state',
      from: { nodeId: 'orders-empty', portId: 'restore' },
      to: { nodeId: 'orders-empty' }
    },
    {
      id: 'save-order',
      kind: 'open-overlay',
      from: { nodeId: 'new-order', portId: 'save' },
      to: { nodeId: 'saved' }
    },
    {
      id: 'cancel-order',
      kind: 'back',
      from: { nodeId: 'new-order', portId: 'cancel' }
    },
    {
      id: 'dismiss-saved',
      kind: 'close-overlay',
      from: { nodeId: 'saved', portId: 'dismiss' },
      to: { nodeId: 'saved' }
    },
    {
      id: 'expire-order-draft',
      kind: 'reset-flow',
      from: { nodeId: 'new-order', portId: 'expire' }
    }
  ],
  scenarios: [
    {
      id: 'orders-default',
      name: 'Orders default',
      startNodeId: 'orders',
      expectedPath: ['orders', 'new-order']
    },
    {
      id: 'orders-empty',
      name: 'Orders empty',
      startNodeId: 'orders',
      initialStateId: 'orders-empty',
      expectedPath: ['orders', 'orders-empty']
    }
  ]
});
