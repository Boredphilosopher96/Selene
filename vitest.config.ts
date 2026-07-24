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
      '@selene/host-runtime': workspaceSource('host-runtime'),
      '@selene/identity-runtime': workspaceSource('identity-runtime'),
      // The collaboration service integration tests import these entry points
      // directly. Keep Vitest on source so `bun run test` works before any
      // workspace build has produced ignored dist/ files.
      '@selene/collaboration/identity': fileURLToPath(
        new URL('./packages/collaboration/src/identity.ts', import.meta.url)
      ),
      '@selene/collaboration/service': fileURLToPath(
        new URL('./packages/collaboration/src/service.ts', import.meta.url)
      ),
      '@selene/collaboration': workspaceSource('collaboration'),
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
