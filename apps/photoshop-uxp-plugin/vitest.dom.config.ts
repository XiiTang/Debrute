import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import { domTestConfig } from '../../tests/config/shared.js';

const domConfig = domTestConfig('dom-photoshop-uxp-plugin');

export default defineConfig({
  ...domConfig,
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    ...domConfig.test,
    include: ['src/**/*Interaction.test.ts', 'src/**/*Interaction.test.tsx']
  }
});
