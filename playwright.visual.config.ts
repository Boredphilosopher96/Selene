import { defineConfig, devices } from '@playwright/test';

import { harnessPorts, harnessUrl, isHostedCi } from './scripts/playwright-harness.mjs';

const ports = harnessPorts();
const hostedCi = isHostedCi();

export default defineConfig({
  testDir: './apps/a11y',
  testMatch: 'storybook-visual.spec.ts',
  forbidOnly: hostedCi,
  reporter: hostedCi ? 'github' : 'list',
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{platform}/{arg}{ext}',
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
    command: `bun scripts/playwright-web-server.mjs visual-storybook ${ports.visualStorybook} bun x --no-install --bun storybook dev --config-dir packages/ui/.storybook --port ${ports.visualStorybook} --exact-port --ci`,
    url: harnessUrl(ports.visualStorybook),
    reuseExistingServer: false
  }
});
