import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@selene/ui': fileURLToPath(new URL('../../packages/ui/src/index.ts', import.meta.url))
    }
  }
});
