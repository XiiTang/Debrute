import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts', 'apps/**/*.test.ts', 'apps/**/*.test.tsx'],
    maxWorkers: 1
  },
  resolve: {
    alias: [
      { find: /^react$/, replacement: resolve(workspaceRoot, 'node_modules/react/index.js') },
      { find: /^react\/jsx-runtime$/, replacement: resolve(workspaceRoot, 'node_modules/react/jsx-runtime.js') },
      { find: /^react\/jsx-dev-runtime$/, replacement: resolve(workspaceRoot, 'node_modules/react/jsx-dev-runtime.js') },
      { find: /^react-dom$/, replacement: resolve(workspaceRoot, 'node_modules/react-dom/index.js') },
      { find: /^react-dom\/server$/, replacement: resolve(workspaceRoot, 'node_modules/react-dom/server.node.js') },
      { find: '@debrute/app-protocol', replacement: resolve(workspaceRoot, 'packages/app-protocol/src/index.ts') },
      { find: '@debrute/capability-core', replacement: resolve(workspaceRoot, 'packages/capability-core/src/index.ts') },
      { find: '@debrute/capability-runtime', replacement: resolve(workspaceRoot, 'packages/capability-runtime/src/index.ts') },
      { find: '@debrute/project-core/projectCacheKeys', replacement: resolve(workspaceRoot, 'packages/project-core/src/projectCacheKeys.ts') },
      { find: '@debrute/project-core/projectTextFileTypes', replacement: resolve(workspaceRoot, 'packages/project-core/src/projectTextFileTypes.ts') },
      { find: '@debrute/project-core', replacement: resolve(workspaceRoot, 'packages/project-core/src/index.ts') },
      { find: '@debrute/canvas-core', replacement: resolve(workspaceRoot, 'packages/canvas-core/src/index.ts') },
      { find: '@debrute/canvas-map-core', replacement: resolve(workspaceRoot, 'packages/canvas-map-core/src/index.ts') },
      { find: '@debrute/workbench-runtime', replacement: resolve(workspaceRoot, 'packages/workbench-runtime/src/index.ts') },
      { find: '@debrute/photoshop-bridge-plugin-core', replacement: resolve(workspaceRoot, 'packages/photoshop-bridge-plugin-core/src/index.ts') },
      { find: '@debrute/app-server', replacement: resolve(workspaceRoot, 'apps/app-server/src/index.ts') },
      { find: '@debrute/daemon', replacement: resolve(workspaceRoot, 'apps/daemon/src/index.ts') },
      { find: '@debrute/photoshop-uxp-plugin', replacement: resolve(workspaceRoot, 'apps/photoshop-uxp-plugin/src/main.ts') }
    ]
  }
});
