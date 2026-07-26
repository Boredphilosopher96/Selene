import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  // Electron's application-level single-instance lock is process-global, not profile-scoped.
  // Keep the desktop behavioral suite serial while allowing the rest of CI to remain parallel.
  workers: 1,
  use: { trace: 'retain-on-failure' }
});
