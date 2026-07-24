import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { createWorkbenchDevProxy } from './src/devWorkbenchProxy';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ command }) => {
  const runtimeOrigin = process.env.DEBRUTE_RUNTIME_ORIGIN;
  if (command === 'serve' && !runtimeOrigin) {
    throw new Error('DEBRUTE_RUNTIME_ORIGIN is required; start Web through pnpm dev or pnpm dev:electron.');
  }
  return {
    plugins: [
      react()
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
    ...(runtimeOrigin ? {
      server: {
        port: 17322,
        proxy: createWorkbenchDevProxy(runtimeOrigin)
      }
    } : {})
  };
});
