import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './apps/a11y',
  testMatch: 'accessibility.spec.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 45_000,
  webServer: [
    {
      command: 'bun run --cwd apps/web preview -- --host 127.0.0.1 --port 4174',
      url: 'http://127.0.0.1:4174',
      reuseExistingServer: !process.env.CI
    },
    {
      command:
        './node_modules/.bin/storybook dev --config-dir packages/ui/.storybook --port 6009 --ci',
      url: 'http://127.0.0.1:6009',
      reuseExistingServer: !process.env.CI
    }
  ]
});
