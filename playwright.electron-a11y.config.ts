import { defineConfig } from '@playwright/test';

import { isHostedCi } from './scripts/playwright-harness.mjs';

const hostedCi = isHostedCi();

export default defineConfig({
  testDir: './apps/a11y',
  testMatch: 'accessibility.spec.ts',
  grep: /the built Electron desktop window has no WCAG A or AA violations/,
  fullyParallel: false,
  forbidOnly: hostedCi,
  retries: hostedCi ? 2 : 0,
  reporter: hostedCi ? 'github' : 'list',
  timeout: 45_000,
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  }
});
