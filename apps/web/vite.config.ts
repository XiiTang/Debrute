import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@debrute/app-protocol': resolve(workspaceRoot, 'packages/app-protocol/src/index.ts'),
      '@debrute/project-core': resolve(workspaceRoot, 'packages/project-core/src/index.ts'),
      '@debrute/canvas-core': resolve(workspaceRoot, 'packages/canvas-core/src/index.ts')
    }
  },
  server: {
    port: 17322,
    proxy: {
      '/api': {
        target: process.env.DEBRUTE_DAEMON_URL ?? 'http://127.0.0.1:17321',
        changeOrigin: true
      }
    }
  }
});
