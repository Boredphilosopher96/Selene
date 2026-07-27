import {
  _default,
  array,
  boolean,
  config,
  enum as zEnum,
  literal,
  maxLength,
  minLength,
  number,
  optional,
  refine,
  regex,
  startsWith,
  strictObject,
  string,
  superRefine,
  type infer as Infer
} from 'zod/mini';
import en from 'zod/v4/locales/en.js';

config(en());

const projectIdSchema = string().check(regex(/^[a-z][a-z0-9-]{0,63}$/));
const nodeIdSchema = string().check(regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/));
const nonEmptyString = string().check(minLength(1));
const routePathSchema = string().check(startsWith('/'));
const sha256Schema = string().check(regex(/^[a-f0-9]{64}$/));

/** Portable status for generated-design review/handoff, never package release history. */
export const designBaselineStatusSchema = strictObject({
  baselineId: optional(nonEmptyString),
  revisionId: optional(nonEmptyString),
  currency: zEnum(['current', 'stale', 'none']),
  approvalsStale: boolean(),
  exactChangesToRecheck: _default(
    array(
      strictObject({
        id: nonEmptyString,
        kind: zEnum(['source', 'design-system', 'token', 'template', 'dependency', 'visual']),
        beforeRevisionId: nonEmptyString,
        currentRevisionId: nonEmptyString,
        projectId: projectIdSchema,
        screenIds: _default(array(nonEmptyString), () => []),
        routePaths: _default(array(routePathSchema), () => []),
        scenarioIds: _default(array(nonEmptyString), () => []),
        componentIds: _default(array(nonEmptyString), () => []),
        stableNodeIds: _default(array(nodeIdSchema), () => []),
        reason: nonEmptyString
      })
    ),
    () => []
  )
}).check(
  superRefine((status, context) => {
    if (
      status.currency === 'current' &&
      (status.baselineId === undefined || status.revisionId === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'current baseline status requires baselineId and revisionId'
      });
    }
    if (status.currency === 'stale' && status.exactChangesToRecheck.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'stale baseline status requires exact changes to recheck'
      });
    }
  })
);

export const projectStatusSchema = strictObject({
  state: zEnum(['planned', 'active', 'blocked', 'complete']),
  updatedAt: nonEmptyString,
  summary: optional(string().check(maxLength(1024))),
  designBaseline: optional(designBaselineStatusSchema)
});

export const ownershipSchema = strictObject({
  nodeIds: array(nodeIdSchema).check(maxLength(10_000)),
  nodeIdPrefixes: _default(array(nonEmptyString).check(maxLength(10_000)), () => [])
}).check(
  refine(
    (ownership) => new Set(ownership.nodeIds).size === ownership.nodeIds.length,
    'nodeIds must be unique'
  ),
  refine(
    (ownership) => new Set(ownership.nodeIdPrefixes).size === ownership.nodeIdPrefixes.length,
    'nodeIdPrefixes must be unique'
  )
);

export const changelogEntrySchema = strictObject({
  id: nonEmptyString,
  at: nonEmptyString,
  summary: nonEmptyString
});

export const storybookReferenceSchema = strictObject({
  component: nonEmptyString,
  url: nonEmptyString
});

export const screenSchema = strictObject({
  id: nonEmptyString,
  name: nonEmptyString,
  description: optional(string())
});

export const routeSchema = strictObject({
  path: routePathSchema,
  screenId: nonEmptyString,
  title: optional(string())
});

export const designSystemReferenceSchema = strictObject({
  packageName: nonEmptyString,
  version: nonEmptyString,
  tokenSource: nonEmptyString,
  documentationUrl: optional(nonEmptyString)
});

export const reactSourcePointerSchema = strictObject({
  path: nonEmptyString,
  exportName: optional(string()),
  revision: nonEmptyString,
  checksum: optional(sha256Schema)
});

export const staticDeploymentSchema = strictObject({
  mode: literal('static'),
  baseUrl: nonEmptyString,
  outputDirectory: nonEmptyString,
  assetBaseUrl: optional(nonEmptyString)
});

export const agentDownloadSchema = strictObject({
  href: nonEmptyString,
  mediaType: literal('application/json'),
  checksum: sha256Schema,
  instructions: nonEmptyString
});

export const handoffDescriptorSchema = strictObject({
  href: nonEmptyString,
  sha256: sha256Schema,
  expiresAt: optional(nonEmptyString),
  manifestPath: nonEmptyString,
  reactSource: array(reactSourcePointerSchema).check(minLength(1)),
  comments: array(nonEmptyString),
  developerDirections: array(nonEmptyString).check(minLength(1)),
  agentDownload: agentDownloadSchema
});

/**
 * Portable, static metadata for a project participating in a federation.
 * This contract intentionally describes references only: it does not load or
 * execute a remote module at runtime.
 */
export const projectSchema = strictObject({
  schemaVersion: literal('1.0'),
  projectId: projectIdSchema,
  parentProjectId: optional(projectIdSchema),
  role: zEnum(['shell', 'child']),
  status: projectStatusSchema,
  ownership: ownershipSchema,
  changelog: array(changelogEntrySchema),
  designSystem: array(designSystemReferenceSchema).check(minLength(1)),
  screens: array(screenSchema).check(minLength(1)),
  routes: array(routeSchema).check(minLength(1)),
  storybook: array(storybookReferenceSchema).check(minLength(1)),
  reactSource: array(reactSourcePointerSchema).check(minLength(1)),
  deployment: staticDeploymentSchema,
  children: _default(array(projectIdSchema), () => []),
  handoff: optional(handoffDescriptorSchema)
}).check(
  superRefine((project, context) => {
    if (project.role === 'child' && project.parentProjectId === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'child projects require parentProjectId',
        path: ['parentProjectId']
      });
    }

    const screenIds = new Set(project.screens.map((screen) => screen.id));
    for (const [index, route] of project.routes.entries()) {
      if (!screenIds.has(route.screenId)) {
        context.addIssue({
          code: 'custom',
          message: `route references unknown screen ${route.screenId}`,
          path: ['routes', index, 'screenId']
        });
      }
    }
  })
);

export type Project = Infer<typeof projectSchema>;
export type ProjectStatus = Infer<typeof projectStatusSchema>;
export type DesignBaselineStatus = Infer<typeof designBaselineStatusSchema>;
export type HandoffDescriptor = Infer<typeof handoffDescriptorSchema>;
export type ReactSourcePointer = Infer<typeof reactSourcePointerSchema>;

/**
 * Generated product simulations and Storybook catalogs are deliberately
 * different deliverables. Neither artifact is a remote module loader.
 */
export const executablePrototypeManifestFormat = 'selene-executable-prototype/v1' as const;
export const componentCatalogManifestFormat = 'selene-component-catalog/v1' as const;
/** Local graph-to-source fencing only; product artifact ownership remains executablePrototypeManifest. */
export const reactBindingManifestFormat = 'selene-react-binding-manifest/v1' as const;

const reactBindingNodeSchema = strictObject({
  graphNodeId: nodeIdSchema,
  sourceNodeId: nodeIdSchema
});

const reactBindingActionSchema = strictObject({
  graphNodeId: nodeIdSchema,
  portId: nodeIdSchema,
  sourceNodeId: nodeIdSchema
});

export const reactBindingManifestSchema = strictObject({
  format: literal(reactBindingManifestFormat),
  schemaVersion: literal('2.0'),
  projectId: projectIdSchema,
  sourceRevisionId: string().check(minLength(1), maxLength(256)),
  graphId: nodeIdSchema,
  graphRevision: number().check(
    refine((value) => Number.isSafeInteger(value) && value >= 0, 'graph revision is invalid')
  ),
  nodeBindings: array(reactBindingNodeSchema).check(minLength(1), maxLength(500)),
  /** Each graph node/port pair has one literal JSX opening-tag binding. */
  // Graphs may intentionally have no ports; otherwise this is exact one-per-port.
  actionBindings: array(reactBindingActionSchema).check(maxLength(16_000))
}).check(
  superRefine((manifest, context) => {
    const graphIds = new Set<string>();
    const sourceIds = new Set<string>();
    const actionIds = new Set<string>();
    for (const [index, binding] of manifest.nodeBindings.entries()) {
      if (graphIds.has(binding.graphNodeId))
        context.addIssue({
          code: 'custom',
          path: ['nodeBindings', index, 'graphNodeId'],
          message: 'graph node bindings must be unique'
        });
      graphIds.add(binding.graphNodeId);
      if (sourceIds.has(binding.sourceNodeId))
        context.addIssue({
          code: 'custom',
          path: ['nodeBindings', index, 'sourceNodeId'],
          message: 'source node bindings must be unique'
        });
      sourceIds.add(binding.sourceNodeId);
    }
    for (const [index, binding] of manifest.actionBindings.entries()) {
      const actionId = `${binding.graphNodeId}\u0000${binding.portId}`;
      if (actionIds.has(actionId))
        context.addIssue({
          code: 'custom',
          path: ['actionBindings', index],
          message: 'action bindings must be unique per graph node and port'
        });
      actionIds.add(actionId);
    }
  })
);

const artifactProvenanceSchema = strictObject({
  generator: nonEmptyString,
  revision: nonEmptyString,
  generatedAt: nonEmptyString
});

const prototypeRuntimeSchema = strictObject({
  rendering: literal('react'),
  network: literal('forbidden'),
  backend: literal('simulated')
});

const prototypeScreenSchema = strictObject({
  id: nonEmptyString,
  route: routePathSchema,
  componentId: nonEmptyString,
  source: reactSourcePointerSchema
});

const prototypeActionPortSchema = strictObject({
  screenId: nonEmptyString,
  nodeId: nodeIdSchema,
  portId: nonEmptyString,
  event: zEnum(['click', 'submit', 'change', 'key', 'timeout'])
});

const prototypeActionGraphSchema = strictObject({
  format: literal('selene-prototype-graph/v1'),
  source: reactSourcePointerSchema,
  actionPorts: array(prototypeActionPortSchema).check(minLength(1))
});

const fixtureDatasetSchema = strictObject({
  id: nonEmptyString,
  source: reactSourcePointerSchema,
  deterministic: literal(true)
});

const prototypeScenarioSchema = strictObject({
  id: nonEmptyString,
  screenId: nonEmptyString,
  fixtureDatasetId: nonEmptyString,
  state: zEnum(['loading', 'empty', 'error', 'success']),
  expectedRoute: routePathSchema
});

const prototypeTraceabilitySchema = strictObject({
  screenId: nonEmptyString,
  componentId: nonEmptyString,
  storyId: nonEmptyString,
  nodeId: optional(nodeIdSchema),
  actionPortId: optional(nonEmptyString)
});

/**
 * An executable React product simulation: real screens, routes, event ports,
 * deterministic fixtures and simulated product states. It forbids network and
 * backend integration by contract.
 */
export const executablePrototypeManifestSchema = strictObject({
  format: literal(executablePrototypeManifestFormat),
  schemaVersion: literal('1.0'),
  projectId: projectIdSchema,
  provenance: artifactProvenanceSchema,
  designSystem: array(designSystemReferenceSchema).check(minLength(1)),
  runtime: prototypeRuntimeSchema,
  screens: array(prototypeScreenSchema).check(minLength(1)),
  actionGraph: prototypeActionGraphSchema,
  fixtureDatasets: array(fixtureDatasetSchema).check(minLength(1)),
  scenarios: array(prototypeScenarioSchema).check(minLength(1)),
  traceability: array(prototypeTraceabilitySchema).check(minLength(1))
}).check(
  superRefine((manifest, context) => {
    const screenIds = new Set(manifest.screens.map((screen) => screen.id));
    const routes = new Set<string>();
    const datasets = new Set(manifest.fixtureDatasets.map((dataset) => dataset.id));
    for (const [index, screen] of manifest.screens.entries()) {
      if (routes.has(screen.route))
        context.addIssue({
          code: 'custom',
          path: ['screens', index, 'route'],
          message: 'screen routes must be unique'
        });
      routes.add(screen.route);
    }
    for (const [index, port] of manifest.actionGraph.actionPorts.entries()) {
      if (!screenIds.has(port.screenId))
        context.addIssue({
          code: 'custom',
          path: ['actionGraph', 'actionPorts', index, 'screenId'],
          message: 'action port must belong to a declared screen'
        });
    }
    for (const [index, scenario] of manifest.scenarios.entries()) {
      if (!screenIds.has(scenario.screenId))
        context.addIssue({
          code: 'custom',
          path: ['scenarios', index, 'screenId'],
          message: 'scenario must target a declared screen'
        });
      if (!datasets.has(scenario.fixtureDatasetId))
        context.addIssue({
          code: 'custom',
          path: ['scenarios', index, 'fixtureDatasetId'],
          message: 'scenario must use a declared fixture dataset'
        });
      if (!routes.has(scenario.expectedRoute))
        context.addIssue({
          code: 'custom',
          path: ['scenarios', index, 'expectedRoute'],
          message: 'scenario route must be a declared product route'
        });
    }
    for (const [index, link] of manifest.traceability.entries()) {
      if (!screenIds.has(link.screenId))
        context.addIssue({
          code: 'custom',
          path: ['traceability', index, 'screenId'],
          message: 'traceability must target a declared screen'
        });
    }
  })
);

const componentPropSchema = strictObject({
  name: nonEmptyString,
  type: nonEmptyString,
  required: boolean(),
  description: optional(string().check(maxLength(1024)))
});

const componentStorySchema = strictObject({
  id: nonEmptyString,
  file: nonEmptyString,
  exportName: nonEmptyString,
  coverage: array(
    zEnum(['loading', 'empty', 'error', 'disabled', 'responsive', 'accessibility'])
  ).check(minLength(1))
}).check(
  refine(
    (story) => new Set(story.coverage).size === story.coverage.length,
    'story coverage must be unique'
  )
);

const catalogComponentSchema = strictObject({
  id: nonEmptyString,
  owner: nonEmptyString,
  source: reactSourcePointerSchema,
  props: array(componentPropSchema),
  requiredCoverage: array(
    zEnum(['loading', 'empty', 'error', 'disabled', 'responsive', 'accessibility'])
  ).check(minLength(1)),
  stories: array(componentStorySchema).check(minLength(1))
}).check(
  superRefine((component, context) => {
    const supplied = new Set(component.stories.flatMap((story) => story.coverage));
    for (const coverage of component.requiredCoverage) {
      if (!supplied.has(coverage))
        context.addIssue({
          code: 'custom',
          path: ['stories'],
          message: `stories must cover required ${coverage} state`
        });
    }
  })
);

/** A catalog of reusable components and real CSF source; it intentionally has no routes. */
export const componentCatalogManifestSchema = strictObject({
  format: literal(componentCatalogManifestFormat),
  schemaVersion: literal('1.0'),
  projectId: projectIdSchema,
  provenance: artifactProvenanceSchema,
  builtFromPrototypeRevision: nonEmptyString,
  designSystem: array(designSystemReferenceSchema).check(minLength(1)),
  storybook: strictObject({
    url: nonEmptyString,
    outputDirectory: nonEmptyString,
    buildId: nonEmptyString
  }),
  components: array(catalogComponentSchema).check(minLength(1))
}).check(
  refine(
    (manifest) =>
      new Set(manifest.components.map((component) => component.id)).size ===
      manifest.components.length,
    'component IDs must be unique'
  )
);

export type ExecutablePrototypeManifest = Infer<typeof executablePrototypeManifestSchema>;
export type ReactBindingManifest = Infer<typeof reactBindingManifestSchema>;
export type ComponentCatalogManifest = Infer<typeof componentCatalogManifestSchema>;

const workspaceIdSchema = string().check(regex(/^[a-z][a-z0-9-]{0,63}$/));

export const workspaceNodeCommentSchema = strictObject({
  id: nonEmptyString,
  nodeId: nodeIdSchema,
  body: nonEmptyString.check(maxLength(4_000)),
  author: nonEmptyString,
  createdAt: nonEmptyString,
  resolvedAt: optional(nonEmptyString)
});

export const developerDirectionSchema = strictObject({
  id: nonEmptyString,
  body: nonEmptyString.check(maxLength(4_000)),
  createdAt: nonEmptyString
});

export const workspaceScreenSchema = strictObject({
  id: workspaceIdSchema,
  name: nonEmptyString,
  route: routePathSchema,
  states: array(nonEmptyString).check(minLength(1)),
  nodeIds: array(nodeIdSchema).check(minLength(1))
}).check(
  refine((screen) => new Set(screen.states).size === screen.states.length, 'states must be unique'),
  refine(
    (screen) => new Set(screen.nodeIds).size === screen.nodeIds.length,
    'nodeIds must be unique'
  )
);

/**
 * A portable, local-first designer workspace. This is intentionally separate
 * from the federation manifest: it stores review intent, never executable code.
 */
export const designerWorkspaceSchema = strictObject({
  format: literal('selene-designer-workspace/v1'),
  projectId: workspaceIdSchema,
  name: nonEmptyString,
  status: zEnum(['draft', 'in-review', 'ready']),
  selectedScreenId: workspaceIdSchema,
  selectedState: nonEmptyString,
  selectedNodeId: optional(nodeIdSchema),
  screens: array(workspaceScreenSchema).check(minLength(1)),
  comments: array(workspaceNodeCommentSchema),
  developerDirections: array(developerDirectionSchema),
  changelog: array(changelogEntrySchema).check(minLength(1)),
  updatedAt: nonEmptyString
}).check(
  superRefine((workspace, context) => {
    const selectedScreen = workspace.screens.find(
      (screen) => screen.id === workspace.selectedScreenId
    );
    if (selectedScreen === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'selected screen must exist',
        path: ['selectedScreenId']
      });
      return;
    }
    if (!selectedScreen.states.includes(workspace.selectedState)) {
      context.addIssue({
        code: 'custom',
        message: 'selected state must exist on selected screen',
        path: ['selectedState']
      });
    }
    if (
      workspace.selectedNodeId !== undefined &&
      !workspace.screens.some((screen) => screen.nodeIds.includes(workspace.selectedNodeId ?? ''))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'selected node must exist',
        path: ['selectedNodeId']
      });
    }
    const nodeIds = new Set(workspace.screens.flatMap((screen) => screen.nodeIds));
    for (const [index, comment] of workspace.comments.entries()) {
      if (!nodeIds.has(comment.nodeId)) {
        context.addIssue({
          code: 'custom',
          message: `comment references unknown node ${comment.nodeId}`,
          path: ['comments', index, 'nodeId']
        });
      }
    }
  })
);

export type DesignerWorkspace = Infer<typeof designerWorkspaceSchema>;
export type WorkspaceNodeComment = Infer<typeof workspaceNodeCommentSchema>;
export type DeveloperDirection = Infer<typeof developerDirectionSchema>;

export const federationSchemaVersion = '1.0' as const;
