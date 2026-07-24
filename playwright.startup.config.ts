import { defineConfig } from '@playwright/test';

import { harnessPorts, harnessUrl } from './scripts/playwright-harness.mjs';

const ports = harnessPorts();

export default defineConfig({
  testDir: './apps/startup',
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  webServer: {
    command: `bun scripts/playwright-web-server.mjs startup ${ports.startup} bun run --cwd apps/web preview -- --host 127.0.0.1 --port ${ports.startup}`,
    url: harnessUrl(ports.startup),
    reuseExistingServer: false
  }
});
