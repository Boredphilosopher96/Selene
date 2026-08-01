import { defineConfig, devices } from '@playwright/test';

import { harnessPorts, harnessUrl, isHostedCi } from './scripts/playwright-harness.mjs';

const ports = harnessPorts();
const hostedCi = isHostedCi();
const baseURL = harnessUrl(ports.pages);

export default defineConfig({
  testDir: './apps/web/e2e',
  testMatch: 'pages-review*.spec.ts',
  forbidOnly: hostedCi,
  reporter: hostedCi ? 'github' : 'list',
  outputDir: 'test-results/pages-review',
  use: {
    baseURL,
    trace: 'on-first-retry'
  },
  projects: [
    {
      name: 'Desktop Chrome',
      testMatch: 'pages-review.spec.ts',
      use: { ...devices['Desktop Chrome'] }
    },
    {
      name: 'Compact Chromium',
      testMatch: 'pages-review-compact.spec.ts',
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } }
    }
  ],
  webServer: {
    command: `bun scripts/playwright-web-server.mjs pages-artifact ${ports.pages} node scripts/serve-pages.mjs ${ports.pages}`,
    url: `${baseURL}/Selene/demo/`,
    reuseExistingServer: false
  }
});
