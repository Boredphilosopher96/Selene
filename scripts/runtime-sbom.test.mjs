import { describe, expect, it } from 'vitest';

import { collectArchiveRuntimeManifests, runtimeComponents } from './runtime-sbom.mjs';

describe('packaged runtime SBOM inventory', () => {
  it('includes shipped runtime components and Electron but excludes source-only dev packages', async () => {
    const manifests = await collectArchiveRuntimeManifests({
      entries: [
        '/node_modules/runtime-package/package.json',
        '/node_modules/runtime-package/lib/index.js',
        '/node_modules/runtime-package/fixtures/package.json'
      ],
      extractFile: () => Buffer.from('{"name":"runtime-package","version":"1.2.3","license":"MIT"}')
    });
    const components = runtimeComponents({
      manifests,
      electronVersion: '43.2.0',
      deniedLicenses: []
    });

    expect(components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'runtime-package', version: '1.2.3', scope: 'required' }),
        expect.objectContaining({ name: 'electron', version: '43.2.0', scope: 'required' })
      ])
    );
    expect(components).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'storybook' })])
    );
  });
});
