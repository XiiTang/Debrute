import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@axis/app-protocol': resolve(workspaceRoot, 'packages/app-protocol/src/index.ts'),
      '@axis/project-core': resolve(workspaceRoot, 'packages/project-core/src/index.ts'),
      '@axis/canvas-core': resolve(workspaceRoot, 'packages/canvas-core/src/index.ts')
    }
  },
  server: {
    port: 5173
  }
});
