import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { parseDebruteWorkbenchPath } from '../../packages/app-protocol/src/workbenchRoute';
import { createWorkbenchDevProxy } from './src/devWorkbenchProxy';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const productPlatform = requireProductPlatform(process.platform);

export default defineConfig(({ command }) => {
  const runtimeOrigin = process.env.DEBRUTE_RUNTIME_ORIGIN;
  const canvasPerfEnabled = command === 'serve' && process.env.VITE_DEBRUTE_CANVAS_PERF === '1';
  if (command === 'serve' && !runtimeOrigin) {
    throw new Error('DEBRUTE_RUNTIME_ORIGIN is required; start Web through pnpm dev or pnpm dev:electron.');
  }
  return {
    appType: 'mpa',
    plugins: [
      serveWorkbenchPages(),
      react()
    ],
    build: {
      license: true
    },
    define: {
      __DEBRUTE_PLATFORM__: JSON.stringify(productPlatform),
      __DEBRUTE_CANVAS_PERF__: JSON.stringify(canvasPerfEnabled)
    },
    resolve: {
      alias: {
        '@debrute/app-protocol': resolve(workspaceRoot, 'packages/app-protocol/src/index.ts'),
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

function serveWorkbenchPages(): Plugin {
  return {
    name: 'debrute-workbench-pages',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        const entry = workbenchPageEntry(request.method, request.url);
        if (entry) {
          request.url = entry;
        }
        next();
      });
    }
  };
}

export function workbenchPageEntry(method: string | undefined, requestUrl: string | undefined): string | undefined {
  if ((method !== 'GET' && method !== 'HEAD') || !requestUrl) {
    return undefined;
  }
  const queryStart = requestUrl.indexOf('?');
  const pathname = queryStart === -1 ? requestUrl : requestUrl.slice(0, queryStart);
  const search = queryStart === -1 ? '' : requestUrl.slice(queryStart);
  return parseDebruteWorkbenchPath(pathname, search).kind === 'not-found'
    ? undefined
    : '/index.html';
}

function requireProductPlatform(platform: NodeJS.Platform): 'darwin' | 'win32' {
  if (platform === 'darwin' || platform === 'win32') {
    return platform;
  }
  throw new Error(`Debrute Workbench does not support build platform: ${platform}`);
}
