import { defineConfig, devices } from '@playwright/test';

import { harnessPorts, harnessUrl, isHostedCi } from './scripts/playwright-harness.mjs';

const ports = harnessPorts();
const hostedCi = isHostedCi();
const baseURL = harnessUrl(ports.pages);

export default defineConfig({
  testDir: './apps/web/e2e',
  testMatch: 'pages-review.spec.ts',
  forbidOnly: hostedCi,
  reporter: hostedCi ? 'github' : 'list',
  outputDir: 'test-results/pages-review',
  use: {
    baseURL,
    trace: 'on-first-retry'
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `bun scripts/playwright-web-server.mjs pages-artifact ${ports.pages} node scripts/serve-pages.mjs ${ports.pages}`,
    url: `${baseURL}/Selene/demo/`,
    reuseExistingServer: false
  }
});
