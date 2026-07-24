import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'html'],
      include: ['packages/**/src/**/*.ts']
    }
  }
});
