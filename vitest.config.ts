import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@selene/agent-sdk': new URL('./packages/agent-sdk/src/index.ts', import.meta.url).pathname
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
