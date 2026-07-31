import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { posix as path } from 'node:path';

import {
  parsePrototypeGraph,
  projectComponentCatalogUsage,
  serializeCanonicalData,
  validateReactSourceWorkspace,
  type PrototypeGraph,
  type ReactCompilerPort,
  type ReactSourceWorkspace
} from '@selene/core';

import type { ComponentCatalogManifestPort } from './designer-service';
import {
  deriveLocalCatalogComponents,
  localCatalogDigest,
  type LocalCatalogComponent
} from './local-component-catalog';
import {
  createPreviewSecurityPolicy,
  type PreviewArtifactRegistry,
  type PublishedPreview
} from './preview-adapter';
import type { StoryPreviewBuildPort, StoryPreviewIdentity } from './story-preview-authority';

interface LocalCatalogRecord {
  readonly workspace: ReactSourceWorkspace;
  readonly workspaceDigest: string;
  readonly compilerPolicy: LocalStoryCompilerPolicy;
  readonly catalogRevision: string;
  readonly buildId: string;
  readonly manifest: unknown;
  readonly components: ReadonlyMap<string, LocalCatalogComponent>;
}

export interface LocalStoryCompilerPolicy {
  readonly fingerprint: string;
  readonly allowedBareDependencies: readonly string[];
  readonly designSystems: readonly {
    readonly packageName: string;
    readonly version: string;
    readonly tokenSource: string;
  }[];
}

export interface LocalStoryPreviewRuntimeOptions {
  readonly maximumProjects?: number;
  readonly previewId?: () => string;
  readonly nonce?: () => string;
  readonly compilerPolicy?: () => LocalStoryCompilerPolicy;
}

function importPath(from: string, destination: string): string {
  const relative = path.relative(path.dirname(from), destination).replace(/\.(?:tsx?|jsx?)$/u, '');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

function storyWorkspace(
  record: LocalCatalogRecord,
  component: LocalCatalogComponent,
  allowedBareDependencies: readonly string[]
): ReactSourceWorkspace {
  const entrypoint = `src/.selene-preview/${localCatalogDigest(`${component.path}\u0000${component.exportName}`)}.tsx`;
  const sourceImport = importPath(entrypoint, component.path);
  const componentImport =
    component.exportName === 'default'
      ? `import Component from ${JSON.stringify(sourceImport)};`
      : `import { ${component.exportName} as Component } from ${JSON.stringify(sourceImport)};`;
  const revisionId = `${record.buildId}:${component.storyId}`;
  const workspace: ReactSourceWorkspace = {
    ...structuredClone(record.workspace),
    entrypoint,
    files: [
      ...structuredClone(record.workspace.files),
      {
        path: entrypoint,
        language: 'tsx',
        content: `import React from 'react';\n${componentImport}\n\nexport default function SeleneStoryPreview() {\n  return <div data-selene-story-root={${JSON.stringify(component.id)}}><Component /></div>;\n}\n`
      }
    ],
    nodes: [
      {
        nodeId: `story.${localCatalogDigest(component.id)}`,
        path: entrypoint,
        exportName: 'default'
      }
    ],
    revision: {
      id: revisionId,
      createdAt: record.workspace.revision.createdAt,
      summary: `Canonical local story: ${component.id} / Default`
    }
  };
  validateReactSourceWorkspace(workspace, { allowedBareDependencies });
  return workspace;
}

/**
 * Main-process-only local catalog and story compiler.
 *
 * It derives canonical default stories from compiler-validated project exports,
 * retains only a bounded set of exact workspaces, and publishes compiled output
 * through the same no-network preview sandbox as the product canvas.
 */
export class LocalStoryPreviewRuntime
  implements ComponentCatalogManifestPort, StoryPreviewBuildPort
{
  private readonly maximumProjects: number;
  private readonly previewId: () => string;
  private readonly nonce: () => string;
  private readonly compilerPolicy: () => LocalStoryCompilerPolicy;
  private readonly records = new Map<string, LocalCatalogRecord>();
  private readonly prototypes = new Map<string, unknown>();

  public constructor(
    private readonly compiler: ReactCompilerPort,
    private readonly previews: PreviewArtifactRegistry,
    options: LocalStoryPreviewRuntimeOptions = {}
  ) {
    const maximumProjects = options.maximumProjects ?? 16;
    if (!Number.isSafeInteger(maximumProjects) || maximumProjects < 1 || maximumProjects > 128)
      throw new Error('Local story preview project limit must be between 1 and 128.');
    this.maximumProjects = maximumProjects;
    this.previewId = options.previewId ?? randomUUID;
    this.nonce = options.nonce ?? (() => randomBytes(24).toString('base64url'));
    this.compilerPolicy =
      options.compilerPolicy ??
      (() => ({
        fingerprint: createHash('sha256')
          .update('selene-local-compiler-policy/v1:[]')
          .digest('hex'),
        allowedBareDependencies: [],
        designSystems: [
          {
            packageName: '@selene/local-project',
            version: '0.0.0',
            tokenSource: 'canonical-react-workspace'
          }
        ]
      }));
  }

  public current(
    projectId: string,
    workspace?: ReactSourceWorkspace,
    graph?: PrototypeGraph
  ): unknown | undefined {
    if (workspace !== undefined) this.synchronize(projectId, workspace);
    const record = this.records.get(projectId);
    if (record === undefined) return undefined;
    if (graph !== undefined) this.synchronizePrototype(record, graph);
    this.records.delete(projectId);
    this.records.set(projectId, record);
    return record.manifest;
  }

  public currentPrototype(projectId: string): unknown | undefined {
    return this.prototypes.get(projectId);
  }

  public supports(identity: StoryPreviewIdentity): boolean {
    return this.resolve(identity) !== undefined;
  }

  public async build(
    identity: StoryPreviewIdentity,
    signal: AbortSignal
  ): Promise<PublishedPreview> {
    const resolved = this.resolve(identity);
    if (resolved === undefined)
      throw new Error('Local story source is unavailable for this catalog revision.');
    if (signal.aborted) throw new DOMException('Story preview build was cancelled.', 'AbortError');
    const workspace = storyWorkspace(
      resolved.record,
      resolved.component,
      resolved.record.compilerPolicy.allowedBareDependencies
    );
    const artifact = await this.compiler.compile(workspace, signal);
    if (signal.aborted) throw new DOMException('Story preview build was cancelled.', 'AbortError');
    if (artifact.diagnostics.length > 0)
      throw new Error(artifact.diagnostics.map((diagnostic) => diagnostic.message).join('\n'));
    if (
      artifact.receipt === undefined ||
      artifact.receipt.projectId !== workspace.projectId ||
      artifact.receipt.sourceRevisionId !== workspace.revision.id
    )
      throw new Error('Local story compiler did not issue an exact build receipt.');
    const policy = createPreviewSecurityPolicy('selene-preview://local', this.nonce());
    return this.previews.publish(this.previewId(), policy, {
      ...artifact,
      projectId: identity.projectId
    });
  }

  public reset(): void {
    this.records.clear();
    this.prototypes.clear();
  }

  private synchronize(projectId: string, value: ReactSourceWorkspace): void {
    const compilerPolicy = this.currentCompilerPolicy();
    validateReactSourceWorkspace(value, {
      allowedBareDependencies: compilerPolicy.allowedBareDependencies
    });
    if (value.projectId !== projectId)
      throw new Error('Local story workspace does not match the requested project.');
    const workspace = structuredClone(value);
    const workspaceDigest = createHash('sha256')
      .update(
        serializeCanonicalData({
          workspace,
          compilerPolicyFingerprint: compilerPolicy.fingerprint
        })
      )
      .digest('hex');
    const existing = this.records.get(projectId);
    if (existing?.workspaceDigest === workspaceDigest) return;
    const components = deriveLocalCatalogComponents(workspace);
    if (components.length === 0) {
      this.records.delete(projectId);
      this.prototypes.delete(projectId);
      return;
    }
    const catalogRevision = `catalog-${workspaceDigest.slice(0, 24)}`;
    const buildId = `storybook-${workspaceDigest.slice(0, 24)}`;
    const manifest = Object.freeze({
      format: 'selene-component-catalog/v1',
      schemaVersion: '1.0',
      projectId,
      provenance: Object.freeze({
        generator: 'selene-local-story-runtime/v1',
        revision: catalogRevision,
        generatedAt: workspace.revision.createdAt
      }),
      builtFromPrototypeRevision: workspace.revision.id,
      designSystem: compilerPolicy.designSystems,
      storybook: Object.freeze({
        url: 'selene-preview://local',
        outputDirectory: 'memory://selene-storybook',
        buildId
      }),
      components: Object.freeze(
        components.map((component) =>
          Object.freeze({
            id: component.id,
            owner: 'Local project',
            source: Object.freeze({
              path: component.path,
              exportName: component.exportName,
              revision: workspace.revision.id,
              checksum: createHash('sha256')
                .update(workspace.files.find((file) => file.path === component.path)?.content ?? '')
                .digest('hex')
            }),
            props: Object.freeze([]),
            requiredCoverage: Object.freeze(['responsive', 'accessibility']),
            stories: Object.freeze([
              Object.freeze({
                id: component.storyId,
                file: `virtual://${component.storyId}.stories.tsx`,
                exportName: 'Default',
                coverage: Object.freeze(['responsive', 'accessibility'])
              })
            ])
          })
        )
      )
    });
    const record: LocalCatalogRecord = Object.freeze({
      workspace,
      workspaceDigest,
      compilerPolicy,
      catalogRevision,
      buildId,
      manifest,
      components: new Map(components.map((component) => [component.id, component]))
    });
    this.prototypes.delete(projectId);
    this.records.delete(projectId);
    this.records.set(projectId, record);
    while (this.records.size > this.maximumProjects)
      this.deleteProject(this.records.keys().next().value as string);
  }

  private resolve(identity: StoryPreviewIdentity):
    | {
        readonly record: LocalCatalogRecord;
        readonly component: LocalCatalogComponent;
      }
    | undefined {
    const record = this.records.get(identity.projectId);
    if (
      record === undefined ||
      this.currentCompilerPolicy().fingerprint !== record.compilerPolicy.fingerprint ||
      record.workspace.revision.id !== identity.sourceRevisionId ||
      record.catalogRevision !== identity.catalogRevision ||
      record.buildId !== identity.buildId
    )
      return undefined;
    const component = record.components.get(identity.componentId);
    if (component === undefined || component.storyId !== identity.storyId) return undefined;
    return { record, component };
  }

  private currentCompilerPolicy(): LocalStoryCompilerPolicy {
    const policy = this.compilerPolicy();
    if (
      typeof policy !== 'object' ||
      policy === null ||
      !/^[a-f0-9]{64}$/u.test(policy.fingerprint) ||
      !Array.isArray(policy.allowedBareDependencies) ||
      policy.allowedBareDependencies.length > 256 ||
      new Set(policy.allowedBareDependencies).size !== policy.allowedBareDependencies.length ||
      !Array.isArray(policy.designSystems) ||
      policy.designSystems.length === 0 ||
      policy.designSystems.length > 32
    )
      throw new Error('Local story compiler policy is invalid.');
    const allowedBareDependencies = [...policy.allowedBareDependencies].sort();
    const designSystems = policy.designSystems
      .map((designSystem) => {
        if (
          !designSystem ||
          typeof designSystem.packageName !== 'string' ||
          designSystem.packageName.length === 0 ||
          designSystem.packageName.length > 256 ||
          typeof designSystem.version !== 'string' ||
          designSystem.version.length === 0 ||
          designSystem.version.length > 128 ||
          typeof designSystem.tokenSource !== 'string' ||
          designSystem.tokenSource.length === 0 ||
          designSystem.tokenSource.length > 2_048
        )
          throw new Error('Local story compiler design-system policy is invalid.');
        return Object.freeze({ ...designSystem });
      })
      .sort((left, right) =>
        `${left.packageName}\u0000${left.version}`.localeCompare(
          `${right.packageName}\u0000${right.version}`,
          'en'
        )
      );
    if (
      new Set(designSystems.map((system) => `${system.packageName}\u0000${system.version}`))
        .size !== designSystems.length
    )
      throw new Error('Local story compiler design-system policy contains duplicates.');
    return Object.freeze({
      fingerprint: policy.fingerprint,
      allowedBareDependencies: Object.freeze(allowedBareDependencies),
      designSystems: Object.freeze(designSystems)
    });
  }

  private synchronizePrototype(record: LocalCatalogRecord, value: PrototypeGraph): void {
    const graph = parsePrototypeGraph(value);
    if (graph.project.projectId !== record.workspace.projectId) {
      this.prototypes.delete(record.workspace.projectId);
      return;
    }
    const component =
      [...record.components.values()].find(
        (candidate) => candidate.path === record.workspace.entrypoint
      ) ?? record.components.values().next().value;
    const screens = graph.nodes.filter(
      (node): node is Extract<(typeof graph.nodes)[number], { kind: 'screen' | 'page' }> =>
        node.kind === 'screen' || node.kind === 'page'
    );
    const actionPorts = screens.flatMap((screen) =>
      screen.ports.map((port) => ({
        screenId: screen.id,
        nodeId: screen.id,
        portId: port.id,
        event: port.trigger
      }))
    );
    if (component === undefined || screens.length === 0 || actionPorts.length === 0) {
      this.prototypes.delete(record.workspace.projectId);
      return;
    }
    const source = {
      path: component.path,
      exportName: component.exportName,
      revision: record.workspace.revision.id,
      checksum: createHash('sha256')
        .update(record.workspace.files.find((file) => file.path === component.path)?.content ?? '')
        .digest('hex')
    };
    const fixtureSource =
      record.workspace.files.find((file) => file.language === 'json')?.path ?? component.path;
    const prototype = {
      format: 'selene-executable-prototype/v1',
      schemaVersion: '1.0',
      projectId: record.workspace.projectId,
      provenance: {
        generator: 'selene-local-prototype-runtime/v1',
        revision: record.workspace.revision.id,
        generatedAt: record.workspace.revision.createdAt
      },
      designSystem: record.compilerPolicy.designSystems,
      runtime: { rendering: 'react', network: 'forbidden', backend: 'simulated' },
      screens: screens.map((screen) => ({
        id: screen.id,
        route: screen.route,
        componentId: component.id,
        source
      })),
      actionGraph: {
        format: 'selene-prototype-graph/v1',
        source,
        actionPorts
      },
      fixtureDatasets: [
        {
          id: 'local-project-fixtures',
          source: {
            path: fixtureSource,
            revision: record.workspace.revision.id
          },
          deterministic: true
        }
      ],
      scenarios: graph.scenarios.map((scenario) => {
        const screen =
          screens.find((candidate) => candidate.id === scenario.startNodeId) ?? screens[0]!;
        return {
          id: scenario.id,
          screenId: screen.id,
          fixtureDatasetId: 'local-project-fixtures',
          state: 'success',
          expectedRoute: screen.route
        };
      }),
      traceability: screens.map((screen) => ({
        screenId: screen.id,
        componentId: component.id,
        storyId: component.storyId,
        nodeId: screen.id
      }))
    };
    if (
      projectComponentCatalogUsage(prototype, record.manifest, {
        projectId: record.workspace.projectId,
        prototypeRevision: record.workspace.revision.id
      }).state !== 'ready'
    ) {
      this.prototypes.delete(record.workspace.projectId);
      return;
    }
    this.prototypes.set(record.workspace.projectId, Object.freeze(prototype));
  }

  private deleteProject(projectId: string): void {
    this.records.delete(projectId);
    this.prototypes.delete(projectId);
  }
}
