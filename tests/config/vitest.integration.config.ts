import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import { integrationTestConfig } from './shared.js';

const integrationConfig = integrationTestConfig('integration');

export default defineConfig({
  ...integrationConfig,
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    ...integrationConfig.test,
    include: ['../integration/**/*.integration.test.ts']
  }
});
