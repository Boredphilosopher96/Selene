import { describe, expect, it } from 'vitest';

import {
  createPrototypeRuntime,
  projectComponentCatalogManifest,
  prototypeGraphFixture,
  type PrototypeRuntimeSnapshot,
  type PrototypeGraph
} from '@selene/core';
import { transformWithOxc } from 'vite';

import { createImmutablePublishBundle, type ImmutablePublishBundle } from './designer-host-ports';
import { createInitialWorkspace } from './designer-service';
import {
  BunViteReactGeneratedProjectTemplate,
  generatedComponentCatalogManifest,
  validateGeneratedProjectFilePlan
} from './generated-project-template';
import { createEmbeddedGeneratedProjectToolchainPort } from './generated-project-toolchain';
import { generatedPrototypeRuntimeSource } from './generated-prototype-runtime';

describe('generatedComponentCatalogManifest', () => {
  it('emits the portable canonical catalog for generated CSF stories', () => {
    const source = createInitialWorkspace('orders');
    const bundle = {
      projectId: 'orders',
      source,
      sourceRevisionId: source.revision.id,
      bundleDigest: 'a'.repeat(64),
      designInputProvenance: {
        format: 'selene-desktop-current-workspace-design-inputs/v1',
        projectId: 'orders'
      },
      componentCatalog: {
        entries: [
          {
            component: 'App',
            href: 'catalog:orders/App',
            origin: 'project',
            catalogComponentId: 'App',
            owner: 'Orders design',
            declaredProps: []
          }
        ]
      }
    } as unknown as ImmutablePublishBundle;

    const manifest = generatedComponentCatalogManifest(bundle);
    const projection = projectComponentCatalogManifest(manifest, {
      projectId: 'orders',
      prototypeRevision: source.revision.id
    });

    expect(projection).toMatchObject({
      state: 'ready',
      catalogRevision: 'catalog-aaaaaaaaaaaaaaaaaaaaaaaa',
      buildId: 'storybook-aaaaaaaaaaaaaaaaaaaaaaaa',
      components: [
        {
          id: 'App',
          owner: 'Orders design',
          stories: [
            {
              id: 'App--default',
              exportName: 'Default',
              coverage: ['accessibility', 'responsive']
            }
          ]
        }
      ]
    });
    expect(JSON.stringify(manifest)).toContain('src/.selene-stories/');
    expect(JSON.stringify(manifest)).not.toContain('selene-generated-project-component-catalog');
  });
});

describe('generated runnable prototype', () => {
  it('matches core runtime snapshots for navigation, state, overlay, back, and scenario reset', async () => {
    const compiled = await transformWithOxc(generatedPrototypeRuntimeSource, 'runtime.ts');
    const code = compiled.code
      .replace(/export\s*\{[^}]*\};?/g, '')
      .replace(/\bexport\s+(?=function)/g, '');
    const generated = new Function(
      `${code}\nreturn { startPrototype, triggerPrototype, prototypeBack };`
    )() as {
      startPrototype(graph: PrototypeGraph, scenarioId?: string): PrototypeRuntimeSnapshot;
      triggerPrototype(
        graph: PrototypeGraph,
        snapshot: PrototypeRuntimeSnapshot,
        nodeId: string,
        portId: string
      ): PrototypeRuntimeSnapshot;
      prototypeBack(snapshot: PrototypeRuntimeSnapshot): PrototypeRuntimeSnapshot;
    };
    const core = createPrototypeRuntime(prototypeGraphFixture, 'orders-empty');
    expect(generated.startPrototype(prototypeGraphFixture)).toEqual(
      createPrototypeRuntime(prototypeGraphFixture).snapshot()
    );
    let snapshot = generated.startPrototype(prototypeGraphFixture, 'orders-empty');
    expect(snapshot).toEqual(core.snapshot());
    for (const [nodeId, portId] of [
      ['orders', 'create'],
      ['new-order', 'save'],
      ['saved', 'dismiss'],
      ['new-order', 'expire'],
      ['orders', 'filter-empty'],
      ['orders', 'create'],
      ['new-order', 'cancel']
    ]) {
      snapshot = generated.triggerPrototype(prototypeGraphFixture, snapshot, nodeId!, portId!);
      expect(snapshot).toEqual(core.dispatch({ type: 'trigger', nodeId, portId }));
    }
    expect(generated.prototypeBack(snapshot)).toEqual(core.dispatch({ type: 'back' }));
    expect(() =>
      generated.triggerPrototype(prototypeGraphFixture, snapshot, 'saved', 'dismiss')
    ).toThrow('not active');
    expect(() =>
      generated.triggerPrototype(prototypeGraphFixture, snapshot, 'orders', 'missing')
    ).toThrow('No transition');
  });

  it('preserves canonical source and emits a sealed standalone runner with frozen-lock Pages deployment', () => {
    const source = createInitialWorkspace('generated-review');
    const bundle = createImmutablePublishBundle({
      projectId: source.projectId,
      source,
      prototype: {
        graph: {
          ...prototypeGraphFixture,
          project: { ...prototypeGraphFixture.project, projectId: source.projectId }
        },
        revision: 3
      },
      scenarios: [],
      collaborationSnapshot: JSON.stringify({
        format: 'selene-collaboration/v2',
        project: { id: source.projectId, organizationId: 'local', name: 'Generated review' },
        revisions: [],
        threads: [],
        comments: [],
        reactions: [],
        approvals: [],
        reviewThreads: [],
        aiChangeRequests: [],
        developerAnnotations: []
      }),
      designInputProvenance: {
        format: 'selene-desktop-current-workspace-design-inputs/v1',
        projectId: source.projectId
      },
      componentCatalog: {
        manifest: {
          format: 'selene-component-catalog-projection/v1',
          state: 'unavailable',
          reason: 'NOT_CONFIGURED'
        },
        entries: []
      },
      packageProvenance: {
        packageManager: 'bun@1.3.14',
        lockfile: { path: 'bun.lock', checksum: 'a'.repeat(64) },
        packages: [],
        dependencies: []
      }
    });
    const template = new BunViteReactGeneratedProjectTemplate(
      createEmbeddedGeneratedProjectToolchainPort()
    );
    const plan = validateGeneratedProjectFilePlan(template.create(bundle));
    expect(plan.files.find((file) => file.path.endsWith('.stories.tsx'))?.content).toContain(
      '__id: "App--default"'
    );
    for (const file of source.files)
      expect(plan.files.find((entry) => entry.path === file.path)?.content).toBe(file.content);
    const workflow = plan.files.find(
      (file) => file.path === '.github/workflows/selene-pages.yml'
    )?.content;
    expect(workflow).toContain('bun install --frozen-lockfile');
    expect(workflow).toContain('actions/deploy-pages@');
    expect(workflow).toContain('dist/storybook');
    expect(plan.files.find((file) => file.path === 'README.md')?.content).toContain(
      'publisher commits the validated'
    );
    expect(plan.files.some((file) => file.path === 'src/.selene-prototype/runtime.ts')).toBe(true);
    const mainSource = {
      ...source,
      entrypoint: 'src/main.tsx',
      files: source.files.map((file) => ({
        ...file,
        path: file.path === source.entrypoint ? 'src/main.tsx' : file.path
      })),
      nodes: source.nodes.map((node) => ({
        ...node,
        path: node.path === source.entrypoint ? 'src/main.tsx' : node.path
      }))
    };
    const mainPlan = template.create(
      createImmutablePublishBundle({ ...bundle, source: mainSource })
    );
    expect(mainPlan.files.find((file) => file.path === 'src/main.tsx')?.content).toBe(
      mainSource.files.find((file) => file.path === 'src/main.tsx')?.content
    );
    expect(mainPlan.files.find((file) => file.path === 'index.html')?.content).toContain(
      '/src/.selene-prototype/main.tsx'
    );
    expect(() =>
      template.create(bundle, {
        contributions: [
          {
            id: 'override-runtime',
            version: '1.0.0',
            kind: 'user-template',
            provenance: { provider: 'local', digest: 'b'.repeat(64) },
            files: () => [
              {
                path: 'src/.selene-prototype/injected.ts',
                content: 'export const injected = true;'
              }
            ]
          }
        ]
      })
    ).toThrow('reserved project data');
  });
});
