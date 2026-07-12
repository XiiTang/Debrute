import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import { nodeUnitTestConfig } from '../../tests/config/shared.js';

const unitConfig = nodeUnitTestConfig('unit-app-server');

export default defineConfig({
  ...unitConfig,
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    ...unitConfig.test,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx']
  }
});
