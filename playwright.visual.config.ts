import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './apps/a11y',
  testMatch: 'storybook-visual.spec.ts',
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? 'github' : 'list',
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}{ext}',
  timeout: 45_000,
  use: {
    ...devices['Desktop Chrome'],
    colorScheme: 'light',
    locale: 'en-US',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    timezoneId: 'UTC',
    viewport: { width: 960, height: 700 }
  },
  webServer: {
    command:
      './node_modules/.bin/storybook dev --config-dir packages/ui/.storybook --port 6008 --ci',
    url: 'http://127.0.0.1:6008',
    reuseExistingServer: !process.env.CI
  }
});
