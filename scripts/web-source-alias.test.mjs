import { fileURLToPath } from 'node:url';

import { build } from 'vite';
import { describe, expect, it } from 'vitest';

const webRoot = fileURLToPath(new URL('../apps/web/', import.meta.url));
const webConfig = fileURLToPath(new URL('../apps/web/vite.config.ts', import.meta.url));

describe('cold web workspace build', () => {
  it('bundles recovery and hosted review from workspace sources without dist output', async () => {
    const result = await build({
      root: webRoot,
      configFile: webConfig,
      logLevel: 'silent',
      plugins: [
        {
          name: 'reject-built-workspace-inputs',
          enforce: 'pre',
          load(id) {
            // This remains a cold-build regression even after a prior workspace
            // build has generated ignored dist/ files in the checkout.
            if (/\/packages\/[^/]+\/dist\//.test(id.replaceAll('\\', '/')))
              throw new Error(`Web build depended on built workspace output: ${id}`);
          }
        }
      ],
      build: { write: false }
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) => item.output);
    const javascript = outputs
      .filter((item) => item.type === 'chunk')
      .map((item) => item.code)
      .join('\n');
    expect(javascript).toContain('selene-project-backup/v1');
    expect(javascript).toContain('selene-browser-review-provider/v3');
  }, 15_000);
});
