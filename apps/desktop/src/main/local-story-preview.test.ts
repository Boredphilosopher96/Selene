import { describe, expect, it } from 'vitest';

import {
  parsePrototypeGraph,
  projectComponentCatalogManifest,
  projectComponentCatalogUsage,
  projectFederatedComponentCatalogs,
  prototypeGraphFixture,
  type ReactCompilerPort,
  type ReactSourceWorkspace
} from '@selene/core';

import { createInitialWorkspace } from './designer-service';
import { LocalStoryPreviewRuntime } from './local-story-preview';
import { PreviewArtifactRegistry } from './preview-adapter';
import { StoryPreviewAuthority } from './story-preview-authority';

function deterministicValues(prefix: string): () => string {
  let sequence = 0;
  return () => `${prefix}${String((sequence += 1)).padStart(32 - prefix.length, '0')}`;
}

function compiler(captured: ReactSourceWorkspace[]): ReactCompilerPort {
  return {
    compile: async (workspace) => {
      captured.push(structuredClone(workspace));
      return {
        revisionId: workspace.revision.id,
        code: 'export {};',
        receipt: {
          format: 'selene-react-build-receipt/v1',
          compilerIdentity: 'selene-vite-react-compiler/v1',
          projectId: workspace.projectId,
          sourceRevisionId: workspace.revision.id,
          sourceSha256: 'a'.repeat(64),
          outputSha256: 'b'.repeat(64),
          reachableFiles: [workspace.entrypoint]
        },
        diagnostics: []
      };
    }
  };
}

describe('LocalStoryPreviewRuntime', () => {
  it('derives canonical local stories and compiles an exact sandboxed capability', async () => {
    const captured: ReactSourceWorkspace[] = [];
    const runtime = new LocalStoryPreviewRuntime(
      compiler(captured),
      new PreviewArtifactRegistry(),
      {
        previewId: deterministicValues('preview-'),
        nonce: () => 'n'.repeat(32)
      }
    );
    const workspace = createInitialWorkspace('orders');
    const manifest = runtime.current('orders', workspace);
    const projection = projectComponentCatalogManifest(manifest, {
      projectId: 'orders',
      prototypeRevision: workspace.revision.id
    });
    expect(projection.state).toBe('ready');
    if (projection.state !== 'ready') throw new Error('fixture catalog was not projected');
    expect(projection.components).toEqual([
      expect.objectContaining({
        id: 'App',
        owner: 'Local project',
        requiredCoverage: ['accessibility', 'responsive'],
        stories: [
          expect.objectContaining({
            id: 'App--default',
            exportName: 'Default',
            coverage: ['accessibility', 'responsive']
          })
        ]
      })
    ]);

    const authority = new StoryPreviewAuthority(runtime, runtime, {
      capabilityId: () => 'c'.repeat(32)
    });
    const ticket = authority.issue({
      projectId: 'orders',
      sourceRevisionId: workspace.revision.id,
      catalogRevision: projection.catalogRevision,
      buildId: projection.buildId,
      componentId: 'App',
      storyId: 'App--default'
    });
    const result = await authority.build(7, ticket);

    expect(result.url).toMatch(/^selene-preview:\/\/local\/preview-/u);
    expect(result).toMatchObject({
      projectId: 'orders',
      sourceRevisionId: workspace.revision.id,
      componentId: 'App',
      storyId: 'App--default'
    });
    expect(JSON.stringify(result)).not.toContain('src/App.tsx');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.entrypoint).toMatch(/^src\/\.selene-preview\//u);
    expect(captured[0]?.files.at(-1)?.content).toContain('import Component from "../App";');
  });

  it('derives redacted screen usage from the exact local graph and catalog pair', () => {
    const runtime = new LocalStoryPreviewRuntime(compiler([]), new PreviewArtifactRegistry());
    const workspace = createInitialWorkspace('orders');
    const graph = parsePrototypeGraph({
      ...prototypeGraphFixture,
      project: { ...prototypeGraphFixture.project, projectId: 'orders' },
      revision: { ...workspace.revision }
    });
    const catalog = runtime.current('orders', workspace, graph);
    const usage = projectComponentCatalogUsage(runtime.currentPrototype('orders'), catalog, {
      projectId: 'orders',
      prototypeRevision: workspace.revision.id
    });

    expect(usage).toEqual({
      format: 'selene-component-catalog-usage-projection/v1',
      state: 'ready',
      projectId: 'orders',
      prototypeRevision: workspace.revision.id,
      catalogRevision: expect.stringMatching(/^catalog-/u),
      components: [
        {
          componentId: 'App',
          screens: [
            { screenId: 'orders', route: '/orders', storyIds: ['App--default'] },
            { screenId: 'new-order', route: '/orders/new', storyIds: ['App--default'] }
          ]
        }
      ]
    });
    expect(JSON.stringify(usage)).not.toContain('src/App.tsx');
    expect(JSON.stringify(usage)).not.toContain('actionPorts');
    expect(JSON.stringify(usage)).not.toContain('fixtures');
  });

  it('projects cached team catalogs without exposing their source or Storybook runtime', () => {
    const runtime = new LocalStoryPreviewRuntime(compiler([]), new PreviewArtifactRegistry());
    runtime.current('orders', createInitialWorkspace('orders'));
    runtime.current('checkout', createInitialWorkspace('checkout'));

    const projection = projectFederatedComponentCatalogs(
      runtime.currentFederation(['orders', 'checkout'])
    );
    expect(projection).toMatchObject({
      state: 'ready',
      projects: [
        {
          projectId: 'checkout',
          components: [
            {
              id: 'App',
              owner: 'Local project',
              stories: [{ projectId: 'checkout', storyId: 'App--default' }]
            }
          ]
        },
        { projectId: 'orders' }
      ]
    });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain('src/');
    expect(serialized).not.toContain('storybook-static');
    expect(serialized).not.toContain('canonical-react-workspace');
  });

  it('fails closed when the canonical workspace moves beyond an issued story', async () => {
    const runtime = new LocalStoryPreviewRuntime(compiler([]), new PreviewArtifactRegistry(), {
      previewId: deterministicValues('preview-'),
      nonce: () => 'n'.repeat(32)
    });
    const initial = createInitialWorkspace('orders');
    const manifest = runtime.current('orders', initial);
    const projection = projectComponentCatalogManifest(manifest, {
      projectId: 'orders',
      prototypeRevision: initial.revision.id
    });
    if (projection.state !== 'ready') throw new Error('fixture catalog was not projected');
    const authority = new StoryPreviewAuthority(runtime, runtime, {
      capabilityId: () => 'c'.repeat(32)
    });
    const ticket = authority.issue({
      projectId: 'orders',
      sourceRevisionId: initial.revision.id,
      catalogRevision: projection.catalogRevision,
      buildId: projection.buildId,
      componentId: 'App',
      storyId: 'App--default'
    });
    const changed: ReactSourceWorkspace = {
      ...initial,
      files: initial.files.map((file) =>
        file.path === 'src/App.tsx' ? { ...file, content: `${file.content}\n` } : file
      ),
      revision: {
        id: 'orders-r2',
        createdAt: '2026-07-31T00:00:00.000Z',
        summary: 'Changed canonical source'
      }
    };
    runtime.current('orders', changed);

    await expect(authority.build(7, ticket)).rejects.toThrow('invalid or stale');
  });

  it('invalidates capabilities when the governed design-system compiler policy changes', async () => {
    let fingerprint = 'a'.repeat(64);
    const runtime = new LocalStoryPreviewRuntime(compiler([]), new PreviewArtifactRegistry(), {
      previewId: deterministicValues('preview-'),
      nonce: () => 'n'.repeat(32),
      compilerPolicy: () => ({
        fingerprint,
        allowedBareDependencies: [],
        designSystems: [
          {
            packageName: '@selene/ui',
            version: '1.0.0',
            tokenSource: 'npm:@selene/ui@1.0.0'
          }
        ]
      })
    });
    const workspace = createInitialWorkspace('orders');
    const projection = projectComponentCatalogManifest(runtime.current('orders', workspace), {
      projectId: 'orders',
      prototypeRevision: workspace.revision.id
    });
    if (projection.state !== 'ready') throw new Error('fixture catalog was not projected');
    const authority = new StoryPreviewAuthority(runtime, runtime, {
      capabilityId: () => 'c'.repeat(32)
    });
    const ticket = authority.issue({
      projectId: 'orders',
      sourceRevisionId: workspace.revision.id,
      catalogRevision: projection.catalogRevision,
      buildId: projection.buildId,
      componentId: 'App',
      storyId: 'App--default'
    });

    fingerprint = 'b'.repeat(64);

    await expect(authority.build(7, ticket)).rejects.toThrow('invalid or stale');
  });
});
