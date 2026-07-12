import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import { nodeUnitTestConfig } from './shared.js';

const contractsConfig = nodeUnitTestConfig('contracts');

export default defineConfig({
  ...contractsConfig,
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    ...contractsConfig.test,
    include: ['../contracts/**/*.contract.test.ts']
  }
});
