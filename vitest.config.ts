import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import PerformanceReporter from './tests/config/performance-reporter.js';

const workspaceRoot = fileURLToPath(new URL('.', import.meta.url));

export function discoverTestProjectConfigs(root = workspaceRoot): string[] {
  return [
    ...globSync('apps/*/vitest.config.ts', { cwd: root }),
    ...globSync('apps/*/vitest.*.config.ts', { cwd: root }),
    ...globSync('packages/*/vitest.config.ts', { cwd: root }),
    ...globSync('tests/config/vitest.*.config.ts', { cwd: root })
  ].map((path) => path.replaceAll('\\', '/')).sort();
}

export default defineConfig({
  test: {
    projects: discoverTestProjectConfigs(),
    sequence: {
      shuffle: { files: true },
      seed: 104729
    },
    reporters: ['default', new PerformanceReporter()],
    coverage: {
      provider: 'v8',
      allowExternal: true,
      reportsDirectory: '.test-results/coverage',
      reporter: ['text-summary', 'json'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.d.ts',
        '**/generated/**',
        '**/*.generated.{ts,tsx}',
        '**/dist/**',
        '**/dist-electron/**',
        '**/build/**',
        'apps/web/src/types.ts',
        'apps/web/src/workbench/i18n/types.ts',
        'apps/daemon/src/cli.ts',
        'apps/runtime-host/src/cli.ts',
        'apps/web/src/main.tsx'
      ],
      excludeAfterRemap: true
    }
  }
});
