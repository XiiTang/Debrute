import type { ViteUserConfig as UserConfig } from 'vitest/config';

import { testAliases } from './aliases.js';
import { testWorkerPlan } from './workers.js';

export const testTags = [
  { name: 'canvas-text' },
  { name: 'canvas-video' },
  { name: 'terminal' },
  { name: 'settings' },
  { name: 'runtime' }
] as const;

function sharedTestConfig(name: string): Pick<UserConfig, 'resolve'> & {
  test: NonNullable<UserConfig['test']>;
} {
  return {
    resolve: {
      alias: testAliases
    },
    test: {
      name,
      environment: 'node',
      tags: [...testTags],
      strictTags: true
    }
  };
}

export function nodeUnitTestConfig(name: string): UserConfig {
  const config = sharedTestConfig(name);

  return {
    ...config,
    test: {
      ...config.test,
      pool: 'forks',
      sequence: { groupOrder: 1 },
      maxWorkers: testWorkerPlan.unitWorkers,
      testTimeout: 5_000,
      slowTestThreshold: 250
    }
  };
}

export function domTestConfig(name: string): UserConfig {
  const config = sharedTestConfig(name);

  return {
    ...config,
    test: {
      ...config.test,
      environment: 'jsdom',
      pool: 'threads',
      sequence: { groupOrder: 2 },
      maxWorkers: testWorkerPlan.domWorkers,
      testTimeout: 5_000,
      slowTestThreshold: 500
    }
  };
}

export function integrationTestConfig(name: string): UserConfig {
  const config = sharedTestConfig(name);

  return {
    ...config,
    test: {
      ...config.test,
      pool: 'forks',
      sequence: { groupOrder: 3 },
      maxWorkers: testWorkerPlan.integrationWorkers,
      testTimeout: 15_000,
      slowTestThreshold: 2_000
    }
  };
}

export function serialTestConfig(name: string): UserConfig {
  const config = sharedTestConfig(name);

  return {
    ...config,
    test: {
      ...config.test,
      pool: 'forks',
      sequence: { groupOrder: 4 },
      maxWorkers: testWorkerPlan.systemWorkers,
      testTimeout: 30_000,
      slowTestThreshold: 5_000
    }
  };
}
