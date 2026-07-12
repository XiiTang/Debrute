import { describe, expect, it } from 'vitest';

import {
  domTestConfig,
  integrationTestConfig,
  nodeUnitTestConfig,
  serialTestConfig
} from '../config/shared.js';
import { resolveWorkerPlan } from '../config/workers.js';

const GIB = 1024 ** 3;

describe('test worker policy', () => {
  it('uses the reference-hardware worker plan', () => {
    expect(resolveWorkerPlan({ availableCpus: 6, totalMemoryBytes: 8 * GIB })).toMatchObject({
      unitWorkers: 4,
      domWorkers: 2,
      integrationWorkers: 2,
      systemWorkers: 1,
      referenceHardware: true
    });
  });

  it('keeps smaller machines within their available capacity', () => {
    expect(resolveWorkerPlan({ availableCpus: 2, totalMemoryBytes: 4 * GIB })).toMatchObject({
      unitWorkers: 1,
      domWorkers: 1,
      integrationWorkers: 1,
      systemWorkers: 1,
      referenceHardware: false
    });
  });

  it('uses a positive integer override as the parallel worker upper bound', () => {
    expect(resolveWorkerPlan({
      availableCpus: 12,
      totalMemoryBytes: 16 * GIB,
      requestedWorkers: '3'
    })).toMatchObject({
      unitWorkers: 3,
      domWorkers: 2,
      integrationWorkers: 2
    });
  });

  it.each(['0', '2.5'])('rejects invalid worker override %s', (requestedWorkers) => {
    expect(() => resolveWorkerPlan({
      availableCpus: 6,
      totalMemoryBytes: 8 * GIB,
      requestedWorkers
    })).toThrow('DEBRUTE_TEST_WORKERS must be a positive integer');
  });

  it.each([
    ['unit', nodeUnitTestConfig('unit-example'), 1],
    ['DOM', domTestConfig('dom-web'), 2],
    ['integration', integrationTestConfig('integration'), 3],
    ['serial', serialTestConfig('system'), 4]
  ])('assigns group order for the %s project', (_name, config, groupOrder) => {
    expect(config.test?.sequence).toEqual({ groupOrder });
  });
});
