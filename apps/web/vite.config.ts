import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [react()],
  resolve: {
    alias: [
      // Pages builds the web app before workspace dist/ outputs exist. Keep
      // runtime collaboration contracts on the same sources as TypeScript.
      {
        find: /^@selene\/collaboration\/hosted-review$/,
        replacement: fileURLToPath(
          new URL('../../packages/collaboration/src/hosted-review.ts', import.meta.url)
        )
      },
      {
        find: /^@selene\/collaboration$/,
        replacement: fileURLToPath(
          new URL('../../packages/collaboration/src/index.ts', import.meta.url)
        )
      },
      {
        find: /^@selene\/core\/project$/,
        replacement: fileURLToPath(new URL('../../packages/core/src/project.ts', import.meta.url))
      },
      {
        find: /^@selene\/core\/prototype$/,
        replacement: fileURLToPath(new URL('../../packages/core/src/prototype.ts', import.meta.url))
      },
      {
        find: /^@selene\/ui\/prototype-flow$/,
        replacement: fileURLToPath(
          new URL('../../packages/ui/src/prototype-flow.ts', import.meta.url)
        )
      },
      {
        find: /^@selene\/ui\/prototype-runtime$/,
        replacement: fileURLToPath(
          new URL('../../packages/ui/src/prototype-runtime.ts', import.meta.url)
        )
      },
      {
        find: /^@selene\/ui\/designer-workspace$/,
        replacement: fileURLToPath(
          new URL('../../packages/ui/src/designer-workspace-entry.ts', import.meta.url)
        )
      },
      {
        find: /^@selene\/core$/,
        replacement: fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url))
      },
      {
        find: /^@selene\/project-schema$/,
        replacement: fileURLToPath(
          new URL('../../packages/project-schema/src/index.ts', import.meta.url)
        )
      },
      {
        find: /^@selene\/ui\/prototype$/,
        replacement: fileURLToPath(new URL('../../packages/ui/src/prototype.ts', import.meta.url))
      },
      {
        find: /^@selene\/ui\/workspace$/,
        replacement: fileURLToPath(new URL('../../packages/ui/src/workspace.ts', import.meta.url))
      },
      {
        find: /^@selene\/ui$/,
        replacement: fileURLToPath(new URL('../../packages/ui/src/index.ts', import.meta.url))
      }
    ]
  }
});
