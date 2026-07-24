import { fileURLToPath } from 'node:url';

import { configDefaults, defineConfig } from 'vitest/config';

function workspaceSource(packageName: string): string {
  return fileURLToPath(new URL(`./packages/${packageName}/src/index.ts`, import.meta.url));
}

export default defineConfig({
  resolve: {
    alias: {
      '@selene/agent-sdk': workspaceSource('agent-sdk'),
      '@selene/core': workspaceSource('core'),
      '@selene/design-inputs': workspaceSource('design-inputs'),
      '@selene/extension-kernel': workspaceSource('extension-kernel'),
      '@selene/collaboration/identity': fileURLToPath(
        new URL('./packages/collaboration/src/identity.ts', import.meta.url)
      ),
      '@selene/project-schema': workspaceSource('project-schema')
    }
  },
  test: {
    include: ['apps/**/src/**/*.test.ts', 'packages/**/src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    exclude: [
      ...configDefaults.exclude,
      'apps/collaboration-service/src/postgres.integration.test.ts'
    ],
    coverage: {
      reporter: ['text', 'html'],
      include: ['packages/**/src/**/*.ts']
    }
  }
});
