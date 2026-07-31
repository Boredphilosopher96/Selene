import { describe, expect, it } from 'vitest';

import { projectComponentCatalogManifest } from '@selene/core';

import type { ImmutablePublishBundle } from './designer-host-ports';
import { createInitialWorkspace } from './designer-service';
import { generatedComponentCatalogManifest } from './generated-project-template';

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
