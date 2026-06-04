import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts', 'apps/**/*.test.ts', 'apps/**/*.test.tsx']
  },
  resolve: {
    alias: [
      { find: /^react$/, replacement: resolve(workspaceRoot, 'node_modules/react/index.js') },
      { find: /^react\/jsx-runtime$/, replacement: resolve(workspaceRoot, 'node_modules/react/jsx-runtime.js') },
      { find: /^react\/jsx-dev-runtime$/, replacement: resolve(workspaceRoot, 'node_modules/react/jsx-dev-runtime.js') },
      { find: /^react-dom$/, replacement: resolve(workspaceRoot, 'node_modules/react-dom/index.js') },
      { find: /^react-dom\/server$/, replacement: resolve(workspaceRoot, 'node_modules/react-dom/server.node.js') },
      { find: /^sharp$/, replacement: resolve(workspaceRoot, 'node_modules/sharp/lib/index.js') },
      { find: '@axis/app-protocol', replacement: resolve(workspaceRoot, 'packages/app-protocol/src/index.ts') },
      { find: '@axis/capability-core', replacement: resolve(workspaceRoot, 'packages/capability-core/src/index.ts') },
      { find: '@axis/capability-runtime', replacement: resolve(workspaceRoot, 'packages/capability-runtime/src/index.ts') },
      { find: '@axis/project-core', replacement: resolve(workspaceRoot, 'packages/project-core/src/index.ts') },
      { find: '@axis/canvas-core', replacement: resolve(workspaceRoot, 'packages/canvas-core/src/index.ts') },
      { find: '@axis/flowmap-core', replacement: resolve(workspaceRoot, 'packages/flowmap-core/src/index.ts') },
      { find: '@axis/workbench-runtime', replacement: resolve(workspaceRoot, 'packages/workbench-runtime/src/index.ts') },
      { find: '@axis/app-server', replacement: resolve(workspaceRoot, 'apps/app-server/src/index.ts') },
      { find: '@axis/daemon', replacement: resolve(workspaceRoot, 'apps/daemon/src/index.ts') }
    ]
  }
});
