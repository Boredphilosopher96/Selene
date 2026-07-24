import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './apps/a11y',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 45_000,
  webServer: [
    {
      command: 'bun run --cwd apps/web preview -- --host 127.0.0.1 --port 4174',
      url: 'http://127.0.0.1:4174',
      reuseExistingServer: !process.env.CI
    },
    {
      command:
        'XDG_CONFIG_HOME=.cache storybook dev --config-dir packages/ui/.storybook -p 6007 --ci',
      url: 'http://127.0.0.1:6007',
      reuseExistingServer: !process.env.CI
    },
    {
      command: 'bunx vite apps/desktop/out/renderer --host 127.0.0.1 --port 4175',
      url: 'http://127.0.0.1:4175',
      reuseExistingServer: !process.env.CI
    }
  ]
});
