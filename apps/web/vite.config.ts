import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { createWorkbenchDevProxyMiddleware } from './src/devWorkbenchProxy';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'debrute-workbench-dev-proxy',
      configureServer(server) {
        server.middlewares.use(createWorkbenchDevProxyMiddleware({
          daemonUrl: process.env.DEBRUTE_DAEMON_URL ?? 'http://127.0.0.1:17321',
          token: readDaemonToken()
        }));
      }
    }
  ],
  build: {
    license: true
  },
  resolve: {
    alias: {
      '@debrute/app-protocol': resolve(workspaceRoot, 'packages/app-protocol/src/index.ts'),
      '@debrute/project-core/projectCacheKeys': resolve(workspaceRoot, 'packages/project-core/src/projectCacheKeys.ts'),
      '@debrute/project-core/projectTextFileTypes': resolve(workspaceRoot, 'packages/project-core/src/projectTextFileTypes.ts'),
      '@debrute/project-core': resolve(workspaceRoot, 'packages/project-core/src/index.ts'),
      '@debrute/canvas-core': resolve(workspaceRoot, 'packages/canvas-core/src/index.ts')
    }
  },
  server: {
    port: 17322
  }
});

function readDaemonToken(): string {
  const tokenFile = process.env.DEBRUTE_DAEMON_TOKEN_FILE;
  if (!tokenFile) {
    throw new Error('DEBRUTE_DAEMON_TOKEN_FILE is required for Debrute Workbench source-dev proxy.');
  }
  return readFileSync(tokenFile, 'utf8').trim();
}
