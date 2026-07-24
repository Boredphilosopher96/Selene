import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        '@selene/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
        '@selene/project-schema': fileURLToPath(
          new URL('../../packages/project-schema/src/index.ts', import.meta.url)
        ),
        '@selene/ui': fileURLToPath(new URL('../../packages/ui/src/index.ts', import.meta.url))
      }
    }
  }
});
