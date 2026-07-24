import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

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
      '@selene/project-schema': workspaceSource('project-schema')
    }
  },
  test: {
    include: ['apps/**/src/**/*.test.ts', 'packages/**/src/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'html'],
      include: ['packages/**/src/**/*.ts']
    }
  }
});
