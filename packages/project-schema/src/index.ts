import { z } from 'zod';

const projectIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const nodeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const nonEmptyString = z.string().min(1);

/** Portable status for generated-design review/handoff, never package release history. */
export const designBaselineStatusSchema = z
  .object({
    baselineId: nonEmptyString.optional(),
    revisionId: nonEmptyString.optional(),
    currency: z.enum(['current', 'stale', 'none']),
    approvalsStale: z.boolean(),
    exactChangesToRecheck: z
      .array(
        z
          .object({
            id: nonEmptyString,
            kind: z.enum(['source', 'design-system', 'token', 'template', 'dependency', 'visual']),
            beforeRevisionId: nonEmptyString,
            currentRevisionId: nonEmptyString,
            projectId: projectIdSchema,
            screenIds: z.array(nonEmptyString).default([]),
            routePaths: z.array(z.string().startsWith('/')).default([]),
            scenarioIds: z.array(nonEmptyString).default([]),
            componentIds: z.array(nonEmptyString).default([]),
            stableNodeIds: z.array(nodeIdSchema).default([]),
            reason: nonEmptyString
          })
          .strict()
      )
      .default([])
  })
  .strict()
  .superRefine((status, context) => {
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
  });

export const projectStatusSchema = z
  .object({
    state: z.enum(['planned', 'active', 'blocked', 'complete']),
    updatedAt: nonEmptyString,
    summary: z.string().max(1024).optional(),
    designBaseline: designBaselineStatusSchema.optional()
  })
  .strict();

export const ownershipSchema = z
  .object({
    nodeIds: z.array(nodeIdSchema).max(10_000),
    nodeIdPrefixes: z.array(nonEmptyString).max(10_000).default([])
  })
  .strict()
  .refine(
    (ownership) => new Set(ownership.nodeIds).size === ownership.nodeIds.length,
    'nodeIds must be unique'
  )
  .refine(
    (ownership) => new Set(ownership.nodeIdPrefixes).size === ownership.nodeIdPrefixes.length,
    'nodeIdPrefixes must be unique'
  );

export const changelogEntrySchema = z
  .object({
    id: nonEmptyString,
    at: nonEmptyString,
    summary: nonEmptyString
  })
  .strict();

export const storybookReferenceSchema = z
  .object({
    component: nonEmptyString,
    url: nonEmptyString
  })
  .strict();

export const screenSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    description: z.string().optional()
  })
  .strict();

export const routeSchema = z
  .object({
    path: z.string().startsWith('/'),
    screenId: nonEmptyString,
    title: z.string().optional()
  })
  .strict();

export const designSystemReferenceSchema = z
  .object({
    packageName: nonEmptyString,
    version: nonEmptyString,
    tokenSource: nonEmptyString,
    documentationUrl: nonEmptyString.optional()
  })
  .strict();

export const reactSourcePointerSchema = z
  .object({
    path: nonEmptyString,
    exportName: z.string().optional(),
    revision: nonEmptyString,
    checksum: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
  })
  .strict();

export const staticDeploymentSchema = z
  .object({
    mode: z.literal('static'),
    baseUrl: nonEmptyString,
    outputDirectory: nonEmptyString,
    assetBaseUrl: nonEmptyString.optional()
  })
  .strict();

export const agentDownloadSchema = z
  .object({
    href: nonEmptyString,
    mediaType: z.literal('application/json'),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
    instructions: nonEmptyString
  })
  .strict();

export const handoffDescriptorSchema = z
  .object({
    href: nonEmptyString,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: nonEmptyString.optional(),
    manifestPath: nonEmptyString,
    reactSource: z.array(reactSourcePointerSchema).min(1),
    comments: z.array(nonEmptyString),
    developerDirections: z.array(nonEmptyString).min(1),
    agentDownload: agentDownloadSchema
  })
  .strict();

/**
 * Portable, static metadata for a project participating in a federation.
 * This contract intentionally describes references only: it does not load or
 * execute a remote module at runtime.
 */
export const projectSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    projectId: projectIdSchema,
    parentProjectId: projectIdSchema.optional(),
    role: z.enum(['shell', 'child']),
    status: projectStatusSchema,
    ownership: ownershipSchema,
    changelog: z.array(changelogEntrySchema),
    designSystem: z.array(designSystemReferenceSchema).min(1),
    screens: z.array(screenSchema).min(1),
    routes: z.array(routeSchema).min(1),
    storybook: z.array(storybookReferenceSchema).min(1),
    reactSource: z.array(reactSourcePointerSchema).min(1),
    deployment: staticDeploymentSchema,
    children: z.array(projectIdSchema).default([]),
    handoff: handoffDescriptorSchema.optional()
  })
  .strict()
  .superRefine((project, context) => {
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
  });

export type Project = z.infer<typeof projectSchema>;
export type ProjectStatus = z.infer<typeof projectStatusSchema>;
export type DesignBaselineStatus = z.infer<typeof designBaselineStatusSchema>;
export type HandoffDescriptor = z.infer<typeof handoffDescriptorSchema>;
export type ReactSourcePointer = z.infer<typeof reactSourcePointerSchema>;

/**
 * Generated product simulations and Storybook catalogs are deliberately
 * different deliverables. Neither artifact is a remote module loader.
 */
export const executablePrototypeManifestFormat = 'selene-executable-prototype/v1' as const;
export const componentCatalogManifestFormat = 'selene-component-catalog/v1' as const;

const artifactProvenanceSchema = z
  .object({
    generator: nonEmptyString,
    revision: nonEmptyString,
    generatedAt: nonEmptyString
  })
  .strict();

const prototypeRuntimeSchema = z
  .object({
    rendering: z.literal('react'),
    network: z.literal('forbidden'),
    backend: z.literal('simulated')
  })
  .strict();

const prototypeScreenSchema = z
  .object({
    id: nonEmptyString,
    route: z.string().startsWith('/'),
    componentId: nonEmptyString,
    source: reactSourcePointerSchema
  })
  .strict();

const prototypeActionPortSchema = z
  .object({
    screenId: nonEmptyString,
    nodeId: nodeIdSchema,
    portId: nonEmptyString,
    event: z.enum(['click', 'submit', 'change', 'key', 'timeout'])
  })
  .strict();

const prototypeActionGraphSchema = z
  .object({
    format: z.literal('selene-prototype-graph/v1'),
    source: reactSourcePointerSchema,
    actionPorts: z.array(prototypeActionPortSchema).min(1)
  })
  .strict();

const fixtureDatasetSchema = z
  .object({
    id: nonEmptyString,
    source: reactSourcePointerSchema,
    deterministic: z.literal(true)
  })
  .strict();

const prototypeScenarioSchema = z
  .object({
    id: nonEmptyString,
    screenId: nonEmptyString,
    fixtureDatasetId: nonEmptyString,
    state: z.enum(['loading', 'empty', 'error', 'success']),
    expectedRoute: z.string().startsWith('/')
  })
  .strict();

const prototypeTraceabilitySchema = z
  .object({
    screenId: nonEmptyString,
    componentId: nonEmptyString,
    storyId: nonEmptyString,
    nodeId: nodeIdSchema.optional(),
    actionPortId: nonEmptyString.optional()
  })
  .strict();

/**
 * An executable React product simulation: real screens, routes, event ports,
 * deterministic fixtures and simulated product states. It forbids network and
 * backend integration by contract.
 */
export const executablePrototypeManifestSchema = z
  .object({
    format: z.literal(executablePrototypeManifestFormat),
    schemaVersion: z.literal('1.0'),
    projectId: projectIdSchema,
    provenance: artifactProvenanceSchema,
    designSystem: z.array(designSystemReferenceSchema).min(1),
    runtime: prototypeRuntimeSchema,
    screens: z.array(prototypeScreenSchema).min(1),
    actionGraph: prototypeActionGraphSchema,
    fixtureDatasets: z.array(fixtureDatasetSchema).min(1),
    scenarios: z.array(prototypeScenarioSchema).min(1),
    traceability: z.array(prototypeTraceabilitySchema).min(1)
  })
  .strict()
  .superRefine((manifest, context) => {
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
  });

const componentPropSchema = z
  .object({
    name: nonEmptyString,
    type: nonEmptyString,
    required: z.boolean(),
    description: z.string().max(1024).optional()
  })
  .strict();

const componentStorySchema = z
  .object({
    id: nonEmptyString,
    file: nonEmptyString,
    exportName: nonEmptyString,
    coverage: z
      .array(z.enum(['loading', 'empty', 'error', 'disabled', 'responsive', 'accessibility']))
      .min(1)
  })
  .strict()
  .refine(
    (story) => new Set(story.coverage).size === story.coverage.length,
    'story coverage must be unique'
  );

const catalogComponentSchema = z
  .object({
    id: nonEmptyString,
    owner: nonEmptyString,
    source: reactSourcePointerSchema,
    props: z.array(componentPropSchema),
    requiredCoverage: z
      .array(z.enum(['loading', 'empty', 'error', 'disabled', 'responsive', 'accessibility']))
      .min(1),
    stories: z.array(componentStorySchema).min(1)
  })
  .strict()
  .superRefine((component, context) => {
    const supplied = new Set(component.stories.flatMap((story) => story.coverage));
    for (const coverage of component.requiredCoverage) {
      if (!supplied.has(coverage))
        context.addIssue({
          code: 'custom',
          path: ['stories'],
          message: `stories must cover required ${coverage} state`
        });
    }
  });

/** A catalog of reusable components and real CSF source; it intentionally has no routes. */
export const componentCatalogManifestSchema = z
  .object({
    format: z.literal(componentCatalogManifestFormat),
    schemaVersion: z.literal('1.0'),
    projectId: projectIdSchema,
    provenance: artifactProvenanceSchema,
    builtFromPrototypeRevision: nonEmptyString,
    designSystem: z.array(designSystemReferenceSchema).min(1),
    storybook: z
      .object({ url: nonEmptyString, outputDirectory: nonEmptyString, buildId: nonEmptyString })
      .strict(),
    components: z.array(catalogComponentSchema).min(1)
  })
  .strict()
  .refine(
    (manifest) =>
      new Set(manifest.components.map((component) => component.id)).size ===
      manifest.components.length,
    'component IDs must be unique'
  );

export type ExecutablePrototypeManifest = z.infer<typeof executablePrototypeManifestSchema>;
export type ComponentCatalogManifest = z.infer<typeof componentCatalogManifestSchema>;

const workspaceIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

export const workspaceNodeCommentSchema = z
  .object({
    id: nonEmptyString,
    nodeId: nodeIdSchema,
    body: nonEmptyString.max(4_000),
    author: nonEmptyString,
    createdAt: nonEmptyString,
    resolvedAt: nonEmptyString.optional()
  })
  .strict();

export const developerDirectionSchema = z
  .object({
    id: nonEmptyString,
    body: nonEmptyString.max(4_000),
    createdAt: nonEmptyString
  })
  .strict();

export const workspaceScreenSchema = z
  .object({
    id: workspaceIdSchema,
    name: nonEmptyString,
    route: z.string().startsWith('/'),
    states: z.array(nonEmptyString).min(1),
    nodeIds: z.array(nodeIdSchema).min(1)
  })
  .strict()
  .refine((screen) => new Set(screen.states).size === screen.states.length, 'states must be unique')
  .refine(
    (screen) => new Set(screen.nodeIds).size === screen.nodeIds.length,
    'nodeIds must be unique'
  );

/**
 * A portable, local-first designer workspace. This is intentionally separate
 * from the federation manifest: it stores review intent, never executable code.
 */
export const designerWorkspaceSchema = z
  .object({
    format: z.literal('selene-designer-workspace/v1'),
    projectId: workspaceIdSchema,
    name: nonEmptyString,
    status: z.enum(['draft', 'in-review', 'ready']),
    selectedScreenId: workspaceIdSchema,
    selectedState: nonEmptyString,
    selectedNodeId: nodeIdSchema.optional(),
    screens: z.array(workspaceScreenSchema).min(1),
    comments: z.array(workspaceNodeCommentSchema),
    developerDirections: z.array(developerDirectionSchema),
    changelog: z.array(changelogEntrySchema).min(1),
    updatedAt: nonEmptyString
  })
  .strict()
  .superRefine((workspace, context) => {
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
  });

export type DesignerWorkspace = z.infer<typeof designerWorkspaceSchema>;
export type WorkspaceNodeComment = z.infer<typeof workspaceNodeCommentSchema>;
export type DeveloperDirection = z.infer<typeof developerDirectionSchema>;

export const federationSchemaVersion = '1.0' as const;
