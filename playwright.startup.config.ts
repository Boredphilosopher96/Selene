import { defineConfig } from '@playwright/test';

import { harnessPorts, harnessUrl, isHostedCi } from './scripts/playwright-harness.mjs';

const ports = harnessPorts();
const hostedCi = isHostedCi();

export default defineConfig({
  testDir: './apps/startup',
  forbidOnly: hostedCi,
  retries: hostedCi ? 2 : 0,
  reporter: hostedCi ? 'github' : 'list',
  webServer: {
    command: `bun scripts/playwright-web-server.mjs startup ${ports.startup} bun run --cwd apps/web preview -- --host 127.0.0.1 --port ${ports.startup} --strictPort`,
    url: harnessUrl(ports.startup),
    reuseExistingServer: false
  }
});
