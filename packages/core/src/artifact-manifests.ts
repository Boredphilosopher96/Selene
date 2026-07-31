import {
  componentCatalogManifestSchema,
  executablePrototypeManifestSchema,
  type ComponentCatalogManifest,
  type ExecutablePrototypeManifest
} from '@selene/project-schema';

export interface ArtifactManifestIssue {
  readonly code:
    | 'invalid-component-catalog'
    | 'invalid-executable-prototype'
    | 'project-mismatch'
    | 'design-system-conflict'
    | 'stale-component-catalog'
    | 'missing-component'
    | 'missing-story'
    | 'invalid-action-trace'
    | 'missing-source'
    | 'broken-story'
    | 'duplicate-catalog-project';
  readonly message: string;
  readonly projectId: string;
}

export class ArtifactManifestCompatibilityError extends Error {
  public constructor(readonly issues: readonly ArtifactManifestIssue[]) {
    super(issues.map((issue) => issue.message).join('\n'));
    this.name = 'ArtifactManifestCompatibilityError';
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidIssue(
  code: 'invalid-component-catalog' | 'invalid-executable-prototype',
  value: unknown
): ArtifactManifestIssue {
  const result =
    code === 'invalid-executable-prototype'
      ? executablePrototypeManifestSchema.safeParse(value)
      : componentCatalogManifestSchema.safeParse(value);
  const projectId =
    typeof value === 'object' &&
    value !== null &&
    'projectId' in value &&
    typeof value.projectId === 'string'
      ? value.projectId
      : 'unknown-project';
  return {
    code,
    projectId,
    message: `${projectId} has an invalid ${code === 'invalid-executable-prototype' ? 'executable prototype manifest' : 'component catalog manifest'}: ${
      result.success
        ? 'unknown error'
        : result.error.issues
            .map((issue) => `${issue.path.join('.') || 'root'} ${issue.message}`)
            .sort(compareText)
            .join('; ')
    }`
  };
}

function designSystemIssues(
  prototype: ExecutablePrototypeManifest,
  catalog: ComponentCatalogManifest
): ArtifactManifestIssue[] {
  const catalogReferences = new Map(
    catalog.designSystem.map((reference) => [reference.packageName, reference])
  );
  return prototype.designSystem.flatMap((reference) => {
    const catalogReference = catalogReferences.get(reference.packageName);
    if (
      catalogReference === undefined ||
      catalogReference.version !== reference.version ||
      catalogReference.tokenSource !== reference.tokenSource
    ) {
      return [
        {
          code: 'design-system-conflict' as const,
          projectId: prototype.projectId,
          message: `prototype and component catalog disagree about design system ${reference.packageName}`
        }
      ];
    }
    return [];
  });
}

/**
 * Validates the boundary between a product simulation and its component-only
 * Storybook catalog. The catalog has no route field by schema, so it cannot be
 * promoted into product navigation by this API.
 */
export function validateArtifactManifests(
  prototypeValue: unknown,
  catalogValue: unknown
): readonly ArtifactManifestIssue[] {
  const prototypeResult = executablePrototypeManifestSchema.safeParse(prototypeValue);
  const catalogResult = componentCatalogManifestSchema.safeParse(catalogValue);
  const issues: ArtifactManifestIssue[] = [];
  if (!prototypeResult.success)
    issues.push(invalidIssue('invalid-executable-prototype', prototypeValue));
  if (!catalogResult.success) issues.push(invalidIssue('invalid-component-catalog', catalogValue));
  if (!prototypeResult.success || !catalogResult.success)
    return issues.sort(
      (left, right) =>
        compareText(left.code, right.code) || compareText(left.message, right.message)
    );

  const prototype = prototypeResult.data;
  const catalog = catalogResult.data;
  if (prototype.projectId !== catalog.projectId) {
    issues.push({
      code: 'project-mismatch',
      projectId: prototype.projectId,
      message: `prototype project ${prototype.projectId} does not match catalog project ${catalog.projectId}`
    });
  }
  if (catalog.builtFromPrototypeRevision !== prototype.provenance.revision) {
    issues.push({
      code: 'stale-component-catalog',
      projectId: prototype.projectId,
      message: `component catalog was built from ${catalog.builtFromPrototypeRevision}, not prototype revision ${prototype.provenance.revision}`
    });
  }
  issues.push(...designSystemIssues(prototype, catalog));

  const components = new Map(catalog.components.map((component) => [component.id, component]));
  const actionPorts = new Set(
    prototype.actionGraph.actionPorts.map((port) => `${port.screenId}:${port.portId}`)
  );
  for (const link of prototype.traceability) {
    const component = components.get(link.componentId);
    if (component === undefined) {
      issues.push({
        code: 'missing-component',
        projectId: prototype.projectId,
        message: `traceability for screen ${link.screenId} references missing component ${link.componentId}`
      });
      continue;
    }
    if (!component.stories.some((story) => story.id === link.storyId)) {
      issues.push({
        code: 'missing-story',
        projectId: prototype.projectId,
        message: `traceability for component ${link.componentId} references missing story ${link.storyId}`
      });
    }
    if (
      link.actionPortId !== undefined &&
      !actionPorts.has(`${link.screenId}:${link.actionPortId}`)
    ) {
      issues.push({
        code: 'invalid-action-trace',
        projectId: prototype.projectId,
        message: `traceability action port ${link.screenId}:${link.actionPortId} is absent from the prototype graph`
      });
    }
  }
  return issues.sort(
    (left, right) => compareText(left.code, right.code) || compareText(left.message, right.message)
  );
}

export interface FederatedComponentCatalogIndex {
  readonly format: 'selene-federated-component-catalog/v1';
  /** References manifest metadata only; component source is never copied into the shell. */
  readonly projects: readonly {
    readonly projectId: string;
    readonly storybook: ComponentCatalogManifest['storybook'];
    readonly components: readonly {
      readonly id: string;
      readonly owner: string;
      readonly storyIds: readonly string[];
    }[];
  }[];
}

export type ComponentCatalogProjectionUnavailableReason =
  'NOT_CONFIGURED' | 'INVALID_MANIFEST' | 'PROJECT_MISMATCH' | 'STALE_PROTOTYPE';

export interface ComponentCatalogProjection {
  readonly format: 'selene-component-catalog-projection/v1';
  readonly state: 'ready';
  readonly projectId: string;
  readonly catalogRevision: string;
  readonly builtFromPrototypeRevision: string;
  readonly generatedAt: string;
  readonly buildId: string;
  /** Package identity is inert provenance; token sources and documentation URLs stay host-owned. */
  readonly designSystems: readonly {
    readonly packageName: string;
    readonly version: string;
  }[];
  readonly components: readonly {
    readonly id: string;
    readonly owner: string;
    readonly props: readonly {
      readonly name: string;
      readonly type: string;
      readonly required: boolean;
      readonly description?: string;
    }[];
    readonly requiredCoverage: readonly (
      'loading' | 'empty' | 'error' | 'disabled' | 'responsive' | 'accessibility'
    )[];
    readonly stories: readonly {
      readonly id: string;
      readonly exportName: string;
      readonly coverage: readonly (
        'loading' | 'empty' | 'error' | 'disabled' | 'responsive' | 'accessibility'
      )[];
    }[];
  }[];
}

export type ComponentCatalogProjectionResult =
  | ComponentCatalogProjection
  | {
      readonly format: 'selene-component-catalog-projection/v1';
      readonly state: 'unavailable';
      readonly reason: ComponentCatalogProjectionUnavailableReason;
    };

export type ComponentCatalogUsageUnavailableReason =
  'NOT_CONFIGURED' | 'INVALID_MANIFEST' | 'PROJECT_MISMATCH' | 'INCOMPATIBLE_MANIFESTS';

export type ComponentCatalogUsageProjectionResult =
  | {
      readonly format: 'selene-component-catalog-usage-projection/v1';
      readonly state: 'ready';
      readonly projectId: string;
      readonly prototypeRevision: string;
      readonly catalogRevision: string;
      readonly components: readonly {
        readonly componentId: string;
        readonly screens: readonly {
          readonly screenId: string;
          readonly route: string;
          readonly storyIds: readonly string[];
        }[];
      }[];
    }
  | {
      readonly format: 'selene-component-catalog-usage-projection/v1';
      readonly state: 'unavailable';
      readonly reason: ComponentCatalogUsageUnavailableReason;
    };

function unavailableComponentCatalog(
  reason: ComponentCatalogProjectionUnavailableReason
): ComponentCatalogProjectionResult {
  return Object.freeze({
    format: 'selene-component-catalog-projection/v1' as const,
    state: 'unavailable' as const,
    reason
  });
}

function unavailableComponentCatalogUsage(
  reason: ComponentCatalogUsageUnavailableReason
): ComponentCatalogUsageProjectionResult {
  return Object.freeze({
    format: 'selene-component-catalog-usage-projection/v1' as const,
    state: 'unavailable' as const,
    reason
  });
}

/**
 * Projects screen/story usage only from a compatible executable prototype and
 * component catalog pair. Source pointers, action ports, fixtures, and raw
 * manifest validation details remain host-owned.
 */
export function projectComponentCatalogUsage(
  prototypeValue: unknown,
  catalogValue: unknown,
  expected: { readonly projectId: string; readonly prototypeRevision: string }
): ComponentCatalogUsageProjectionResult {
  if (
    typeof expected.projectId !== 'string' ||
    expected.projectId.length === 0 ||
    expected.projectId.length > 256 ||
    typeof expected.prototypeRevision !== 'string' ||
    expected.prototypeRevision.length === 0 ||
    expected.prototypeRevision.length > 256
  )
    throw new Error('component catalog usage projection identity is invalid');
  if (prototypeValue === undefined || catalogValue === undefined)
    return unavailableComponentCatalogUsage('NOT_CONFIGURED');
  const prototypeResult = executablePrototypeManifestSchema.safeParse(prototypeValue);
  const catalogResult = componentCatalogManifestSchema.safeParse(catalogValue);
  if (!prototypeResult.success || !catalogResult.success)
    return unavailableComponentCatalogUsage('INVALID_MANIFEST');
  const prototype = prototypeResult.data;
  const catalog = catalogResult.data;
  if (prototype.projectId !== expected.projectId || catalog.projectId !== expected.projectId)
    return unavailableComponentCatalogUsage('PROJECT_MISMATCH');
  if (
    prototype.provenance.revision !== expected.prototypeRevision ||
    validateArtifactManifests(prototype, catalog).length > 0
  )
    return unavailableComponentCatalogUsage('INCOMPATIBLE_MANIFESTS');
  const screens = new Map(prototype.screens.map((screen) => [screen.id, screen]));
  const usage = new Map<string, Map<string, Set<string>>>();
  for (const link of prototype.traceability) {
    const screen = screens.get(link.screenId);
    if (screen === undefined) return unavailableComponentCatalogUsage('INCOMPATIBLE_MANIFESTS');
    let componentUsage = usage.get(link.componentId);
    if (componentUsage === undefined) {
      componentUsage = new Map();
      usage.set(link.componentId, componentUsage);
    }
    let storyIds = componentUsage.get(screen.id);
    if (storyIds === undefined) {
      storyIds = new Set();
      componentUsage.set(screen.id, storyIds);
    }
    storyIds.add(link.storyId);
  }
  return Object.freeze({
    format: 'selene-component-catalog-usage-projection/v1' as const,
    state: 'ready' as const,
    projectId: expected.projectId,
    prototypeRevision: expected.prototypeRevision,
    catalogRevision: catalog.provenance.revision,
    components: Object.freeze(
      [...usage.entries()]
        .map(([componentId, componentUsage]) =>
          Object.freeze({
            componentId,
            screens: Object.freeze(
              [...componentUsage.entries()]
                .map(([screenId, storyIds]) => {
                  const screen = screens.get(screenId)!;
                  return Object.freeze({
                    screenId,
                    route: screen.route,
                    storyIds: Object.freeze([...storyIds].sort(compareText))
                  });
                })
                .sort(
                  (left, right) =>
                    compareText(left.route, right.route) ||
                    compareText(left.screenId, right.screenId)
                )
            )
          })
        )
        .sort((left, right) => compareText(left.componentId, right.componentId))
    )
  });
}

/**
 * Redacts one validated component catalog for an unprivileged UI.
 *
 * Storybook URLs, output directories, CSF file paths, source pointers, token
 * sources, and documentation URLs deliberately do not cross this boundary.
 * A host may separately issue opaque preview capabilities for these canonical
 * project/catalog/build/component/story identities.
 */
export function projectComponentCatalogManifest(
  value: unknown,
  expected: {
    readonly projectId: string;
    readonly prototypeRevision: string;
  }
): ComponentCatalogProjectionResult {
  if (
    typeof expected.projectId !== 'string' ||
    expected.projectId.length === 0 ||
    expected.projectId.length > 256 ||
    typeof expected.prototypeRevision !== 'string' ||
    expected.prototypeRevision.length === 0 ||
    expected.prototypeRevision.length > 256
  )
    throw new Error('component catalog projection identity is invalid');
  if (value === undefined) return unavailableComponentCatalog('NOT_CONFIGURED');
  const parsed = componentCatalogManifestSchema.safeParse(value);
  if (!parsed.success) return unavailableComponentCatalog('INVALID_MANIFEST');
  const catalog = parsed.data;
  if (catalog.projectId !== expected.projectId)
    return unavailableComponentCatalog('PROJECT_MISMATCH');
  if (catalog.builtFromPrototypeRevision !== expected.prototypeRevision)
    return unavailableComponentCatalog('STALE_PROTOTYPE');
  return Object.freeze({
    format: 'selene-component-catalog-projection/v1' as const,
    state: 'ready' as const,
    projectId: catalog.projectId,
    catalogRevision: catalog.provenance.revision,
    builtFromPrototypeRevision: catalog.builtFromPrototypeRevision,
    generatedAt: catalog.provenance.generatedAt,
    buildId: catalog.storybook.buildId,
    designSystems: Object.freeze(
      catalog.designSystem
        .map((reference) =>
          Object.freeze({
            packageName: reference.packageName,
            version: reference.version
          })
        )
        .sort(
          (left, right) =>
            compareText(left.packageName, right.packageName) ||
            compareText(left.version, right.version)
        )
    ),
    components: Object.freeze(
      catalog.components
        .map((component) =>
          Object.freeze({
            id: component.id,
            owner: component.owner,
            props: Object.freeze(
              component.props
                .map((prop) =>
                  Object.freeze({
                    name: prop.name,
                    type: prop.type,
                    required: prop.required,
                    ...(prop.description === undefined ? {} : { description: prop.description })
                  })
                )
                .sort((left, right) => compareText(left.name, right.name))
            ),
            requiredCoverage: Object.freeze([...component.requiredCoverage].sort(compareText)),
            stories: Object.freeze(
              component.stories
                .map((story) =>
                  Object.freeze({
                    id: story.id,
                    exportName: story.exportName,
                    coverage: Object.freeze([...story.coverage].sort(compareText))
                  })
                )
                .sort((left, right) => compareText(left.id, right.id))
            )
          })
        )
        .sort((left, right) => compareText(left.id, right.id))
    )
  });
}

/** Aggregates catalog metadata from child manifests without loading or copying their source. */
export function aggregateComponentCatalogs(
  values: readonly unknown[]
): FederatedComponentCatalogIndex {
  const catalogs = values.map((value) => componentCatalogManifestSchema.parse(value));
  const seenProjectIds = new Set<string>();
  const duplicateIssues = catalogs.flatMap((catalog) => {
    if (!seenProjectIds.has(catalog.projectId)) {
      seenProjectIds.add(catalog.projectId);
      return [];
    }
    return [
      {
        code: 'duplicate-catalog-project' as const,
        projectId: catalog.projectId,
        message: `federated component catalog contains duplicate project ${catalog.projectId}`
      }
    ];
  });
  if (duplicateIssues.length > 0) {
    throw new ArtifactManifestCompatibilityError(duplicateIssues);
  }
  return {
    format: 'selene-federated-component-catalog/v1',
    projects: catalogs
      .map((catalog) => ({
        projectId: catalog.projectId,
        storybook: catalog.storybook,
        components: catalog.components
          .map((component) => ({
            id: component.id,
            owner: component.owner,
            storyIds: component.stories.map((story) => story.id).sort(compareText)
          }))
          .sort((left, right) => compareText(left.id, right.id))
      }))
      .sort((left, right) => compareText(left.projectId, right.projectId))
  };
}

/**
 * A host-owned reader keeps filesystem and network policy outside the artifact
 * contracts. Implementations must treat `path` as untrusted manifest input and
 * enforce an allowlisted root with realpath containment before reading.
 */
export interface ArtifactSourceReader {
  read(path: string): Promise<string | undefined>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Checks that catalog references resolve to TypeScript component and CSF source.
 * Hosts may then compile the result with their separately configured Storybook build.
 */
export async function validateComponentCatalogSources(
  catalogValue: unknown,
  reader: ArtifactSourceReader
): Promise<readonly ArtifactManifestIssue[]> {
  const parsed = componentCatalogManifestSchema.safeParse(catalogValue);
  if (!parsed.success) return [invalidIssue('invalid-component-catalog', catalogValue)];
  const catalog = parsed.data;
  const results = await Promise.all(
    catalog.components.flatMap((component) => {
      const sourceCheck = reader.read(component.source.path).then((source) => {
        const sourceExport = new RegExp(
          `export\\s+(?:async\\s+)?(?:function|const|class)\\s+${escapeRegExp(component.source.exportName ?? component.id)}\\b`
        );
        return source === undefined || !sourceExport.test(source)
          ? {
              code: 'missing-source' as const,
              projectId: catalog.projectId,
              message: `catalog component ${component.id} does not resolve to exported source ${component.source.path}`
            }
          : undefined;
      });
      const storyChecks = component.stories.map((story) =>
        reader.read(story.file).then((storySource) => {
          const storyExport = new RegExp(`export\\s+const\\s+${escapeRegExp(story.exportName)}\\b`);
          return storySource === undefined ||
            !/export\s+default\s+meta\b/.test(storySource) ||
            !storyExport.test(storySource)
            ? {
                code: 'broken-story' as const,
                projectId: catalog.projectId,
                message: `catalog story ${story.id} is missing or is not a CSF export at ${story.file}`
              }
            : undefined;
        })
      );
      return [sourceCheck, ...storyChecks];
    })
  );
  const issues: ArtifactManifestIssue[] = [];
  for (const issue of results) {
    if (issue !== undefined) issues.push(issue);
  }
  return issues.sort(
    (left, right) => compareText(left.code, right.code) || compareText(left.message, right.message)
  );
}

export interface ArtifactHandoffBundle {
  readonly format: 'selene-artifact-handoff/v1';
  readonly bundleId: string;
  readonly issuedAt: string;
  readonly download: { readonly href: string; readonly sha256: string };
  readonly provenance: {
    readonly prototypeRevision: string;
    readonly catalogRevision: string;
  };
  readonly executablePrototypeManifest: ExecutablePrototypeManifest;
  readonly componentCatalogManifest: ComponentCatalogManifest;
}

/** Creates a data-only handoff whose two artifact manifests stay visibly separate. */
export function createArtifactHandoffBundle(
  prototype: unknown,
  catalog: unknown,
  options: Omit<
    ArtifactHandoffBundle,
    'format' | 'provenance' | 'executablePrototypeManifest' | 'componentCatalogManifest'
  >
): ArtifactHandoffBundle {
  const issues = validateArtifactManifests(prototype, catalog);
  if (issues.length > 0) throw new ArtifactManifestCompatibilityError(issues);
  const executablePrototypeManifest = executablePrototypeManifestSchema.parse(prototype);
  const componentCatalogManifest = componentCatalogManifestSchema.parse(catalog);
  return {
    format: 'selene-artifact-handoff/v1',
    ...options,
    provenance: {
      prototypeRevision: executablePrototypeManifest.provenance.revision,
      catalogRevision: componentCatalogManifest.provenance.revision
    },
    executablePrototypeManifest,
    componentCatalogManifest
  };
}

export function serializeArtifactHandoffBundle(bundle: ArtifactHandoffBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}
