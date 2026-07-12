import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import { serialTestConfig } from './shared.js';

const releaseConfig = serialTestConfig('release');

export default defineConfig({
  ...releaseConfig,
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    ...releaseConfig.test,
    include: ['../release/**/*.release.test.ts']
  }
});
