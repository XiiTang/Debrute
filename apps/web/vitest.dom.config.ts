import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import { domTestConfig } from '../../tests/config/shared.js';

const domConfig = domTestConfig('dom-web');

export default defineConfig({
  ...domConfig,
  define: {
    __DEBRUTE_PLATFORM__: JSON.stringify('darwin'),
    __DEBRUTE_CANVAS_PERF__: JSON.stringify(false)
  },
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    ...domConfig.test,
    include: ['src/**/*.dom.test.ts', 'src/**/*.dom.test.tsx'],
    setupFiles: ['./test/setupDom.ts']
  }
});
