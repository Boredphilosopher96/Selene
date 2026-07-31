import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { posix as path } from 'node:path';

import {
  serializeCanonicalData,
  validateReactSourceWorkspace,
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
  readonly catalogRevision: string;
  readonly buildId: string;
  readonly manifest: unknown;
  readonly components: ReadonlyMap<string, LocalCatalogComponent>;
}

export interface LocalStoryPreviewRuntimeOptions {
  readonly maximumProjects?: number;
  readonly previewId?: () => string;
  readonly nonce?: () => string;
  readonly allowedBareDependencies?: () => readonly string[];
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
  private readonly allowedBareDependencies: () => readonly string[];
  private readonly records = new Map<string, LocalCatalogRecord>();

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
    this.allowedBareDependencies = options.allowedBareDependencies ?? (() => []);
  }

  public current(projectId: string, workspace?: ReactSourceWorkspace): unknown | undefined {
    if (workspace !== undefined) this.synchronize(projectId, workspace);
    const record = this.records.get(projectId);
    if (record === undefined) return undefined;
    this.records.delete(projectId);
    this.records.set(projectId, record);
    return record.manifest;
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
      this.allowedBareDependencies()
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
  }

  private synchronize(projectId: string, value: ReactSourceWorkspace): void {
    validateReactSourceWorkspace(value, {
      allowedBareDependencies: this.allowedBareDependencies()
    });
    if (value.projectId !== projectId)
      throw new Error('Local story workspace does not match the requested project.');
    const workspace = structuredClone(value);
    const workspaceDigest = createHash('sha256')
      .update(serializeCanonicalData(workspace))
      .digest('hex');
    const existing = this.records.get(projectId);
    if (existing?.workspaceDigest === workspaceDigest) return;
    const components = deriveLocalCatalogComponents(workspace);
    if (components.length === 0) {
      this.records.delete(projectId);
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
      designSystem: Object.freeze([
        Object.freeze({
          packageName: '@selene/local-project',
          version: '0.0.0',
          tokenSource: 'canonical-react-workspace'
        })
      ]),
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
      catalogRevision,
      buildId,
      manifest,
      components: new Map(components.map((component) => [component.id, component]))
    });
    this.records.delete(projectId);
    this.records.set(projectId, record);
    while (this.records.size > this.maximumProjects)
      this.records.delete(this.records.keys().next().value as string);
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
      record.workspace.revision.id !== identity.sourceRevisionId ||
      record.catalogRevision !== identity.catalogRevision ||
      record.buildId !== identity.buildId
    )
      return undefined;
    const component = record.components.get(identity.componentId);
    if (component === undefined || component.storyId !== identity.storyId) return undefined;
    return { record, component };
  }
}
