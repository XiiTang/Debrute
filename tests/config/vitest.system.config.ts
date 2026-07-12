import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { serialTestConfig } from './shared.js';

const systemConfig = serialTestConfig('system');

export default defineConfig({
  ...systemConfig,
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    ...systemConfig.test,
    include: ['../system/**/*.system.test.ts']
  }
});
