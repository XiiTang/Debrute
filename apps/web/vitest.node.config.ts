import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import { nodeUnitTestConfig } from '../../tests/config/shared.js';

const nodeConfig = nodeUnitTestConfig('unit-web-node');

export default defineConfig({
  ...nodeConfig,
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    ...nodeConfig.test,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['src/**/*.dom.test.ts', 'src/**/*.dom.test.tsx']
  }
});
