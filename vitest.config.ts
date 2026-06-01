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
    alias: {
      '@axis/app-protocol': resolve(workspaceRoot, 'packages/app-protocol/src/index.ts'),
      '@axis/capability-core': resolve(workspaceRoot, 'packages/capability-core/src/index.ts'),
      '@axis/capability-runtime': resolve(workspaceRoot, 'packages/capability-runtime/src/index.ts'),
      '@axis/project-core': resolve(workspaceRoot, 'packages/project-core/src/index.ts'),
      '@axis/canvas-core': resolve(workspaceRoot, 'packages/canvas-core/src/index.ts'),
      '@axis/flowmap-core': resolve(workspaceRoot, 'packages/flowmap-core/src/index.ts'),
      '@axis/app-server': resolve(workspaceRoot, 'apps/app-server/src/index.ts')
    }
  }
});
