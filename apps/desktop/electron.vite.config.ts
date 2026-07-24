import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: [
        {
          find: '@selene/core',
          replacement: fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url))
        },
        {
          find: '@selene/project-schema',
          replacement: fileURLToPath(
            new URL('../../packages/project-schema/src/index.ts', import.meta.url)
          )
        },
        {
          find: '@selene/ui/prototype',
          replacement: fileURLToPath(new URL('../../packages/ui/src/prototype.ts', import.meta.url))
        },
        {
          find: '@selene/ui/workspace',
          replacement: fileURLToPath(new URL('../../packages/ui/src/workspace.ts', import.meta.url))
        },
        {
          find: '@selene/ui',
          replacement: fileURLToPath(new URL('../../packages/ui/src/index.ts', import.meta.url))
        }
      ]
    }
  }
});
