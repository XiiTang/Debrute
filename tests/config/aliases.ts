import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));

export const testAliases = [
  { find: /^react$/, replacement: resolve(workspaceRoot, 'node_modules/react/index.js') },
  { find: /^react\/jsx-runtime$/, replacement: resolve(workspaceRoot, 'node_modules/react/jsx-runtime.js') },
  { find: /^react\/jsx-dev-runtime$/, replacement: resolve(workspaceRoot, 'node_modules/react/jsx-dev-runtime.js') },
  { find: /^react-dom$/, replacement: resolve(workspaceRoot, 'node_modules/react-dom/index.js') },
  { find: /^react-dom\/server$/, replacement: resolve(workspaceRoot, 'node_modules/react-dom/server.node.js') },
  { find: '@debrute/app-protocol', replacement: resolve(workspaceRoot, 'packages/app-protocol/src/index.ts') },
  { find: '@debrute/canvas-core', replacement: resolve(workspaceRoot, 'packages/canvas-core/src/index.ts') },
  { find: '@debrute/photoshop-bridge-plugin-core', replacement: resolve(workspaceRoot, 'packages/photoshop-bridge-plugin-core/src/index.ts') },
  { find: '@debrute/photoshop-uxp-plugin', replacement: resolve(workspaceRoot, 'apps/photoshop-uxp-plugin/src/main.ts') }
];
