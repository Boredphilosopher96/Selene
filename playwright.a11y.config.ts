import { defineConfig } from '@playwright/test';

import { harnessPorts, harnessUrl, isHostedCi } from './scripts/playwright-harness.mjs';

const ports = harnessPorts();
const hostedCi = isHostedCi();

export default defineConfig({
  testDir: './apps/a11y',
  testMatch: 'accessibility.spec.ts',
  fullyParallel: true,
  forbidOnly: hostedCi,
  retries: hostedCi ? 2 : 0,
  reporter: hostedCi ? 'github' : 'list',
  timeout: 45_000,
  webServer: [
    {
      command: `bun scripts/playwright-web-server.mjs accessibility-web ${ports.accessibilityWeb} bun run --cwd apps/web preview -- --host 127.0.0.1 --port ${ports.accessibilityWeb} --strictPort`,
      url: harnessUrl(ports.accessibilityWeb),
      reuseExistingServer: false
    },
    {
      command: `bun scripts/playwright-web-server.mjs accessibility-storybook ${ports.accessibilityStorybook} bun run storybook:serve -- --port ${ports.accessibilityStorybook} --exact-port --ci`,
      url: harnessUrl(ports.accessibilityStorybook),
      reuseExistingServer: false
    }
  ]
});
