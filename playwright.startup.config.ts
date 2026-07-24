import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './apps/startup',
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  webServer: {
    command: 'bun run --cwd apps/web preview -- --host 127.0.0.1 --port 4176',
    url: 'http://127.0.0.1:4176',
    reuseExistingServer: !process.env.CI
  }
});
