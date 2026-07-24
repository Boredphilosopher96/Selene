import { defineConfig, devices } from '@playwright/test';

import { harnessPorts, harnessUrl } from './scripts/playwright-harness.mjs';

const ports = harnessPorts();

export default defineConfig({
  testDir: './apps/web/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
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
