import { defineConfig, devices } from '@playwright/test';

import { harnessPorts, harnessUrl, isHostedCi } from './scripts/playwright-harness.mjs';

const ports = harnessPorts();
const hostedCi = isHostedCi();

export default defineConfig({
  testDir: './apps/web/e2e',
  fullyParallel: true,
  forbidOnly: hostedCi,
  retries: hostedCi ? 2 : 0,
  reporter: hostedCi ? 'github' : 'list',
  use: {
    baseURL: harnessUrl(ports.browser),
    trace: 'on-first-retry'
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `bun scripts/playwright-web-server.mjs browser-e2e ${ports.browser} bun run --cwd apps/web dev -- --host 127.0.0.1 --port ${ports.browser} --strictPort`,
    url: harnessUrl(ports.browser),
    reuseExistingServer: false
  }
});
