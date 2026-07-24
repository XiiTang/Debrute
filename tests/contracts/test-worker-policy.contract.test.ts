import { describe, expect, it } from 'vitest';

import {
  domTestConfig,
  nodeUnitTestConfig,
  serialTestConfig
} from '../config/shared.js';
import { resolveWorkerPlan } from '../config/workers.js';

describe('test worker policy', () => {
  it('reserves two CPUs and caps parallel worker classes', () => {
    expect(resolveWorkerPlan({ availableCpus: 6 })).toMatchObject({
      unitWorkers: 4,
      domWorkers: 2,
      releaseWorkers: 1
    });
  });

  it('keeps smaller machines within their available capacity', () => {
    expect(resolveWorkerPlan({ availableCpus: 2 })).toMatchObject({
      unitWorkers: 1,
      domWorkers: 1,
      releaseWorkers: 1
    });
  });

  it('uses a positive integer override as the parallel worker upper bound', () => {
    expect(resolveWorkerPlan({
      availableCpus: 12,
      requestedWorkers: '3'
    })).toMatchObject({
      unitWorkers: 3,
      domWorkers: 2
    });
  });

  it.each(['0', '2.5'])('rejects invalid worker override %s', (requestedWorkers) => {
    expect(() => resolveWorkerPlan({
      availableCpus: 6,
      requestedWorkers
    })).toThrow('DEBRUTE_TEST_WORKERS must be a positive integer');
  });

  it.each([
    ['unit', nodeUnitTestConfig('unit-example'), 1],
    ['DOM', domTestConfig('dom-web'), 2],
    ['serial', serialTestConfig('release'), 3]
  ])('assigns group order for the %s project', (_name, config, groupOrder) => {
    expect(config.test?.sequence).toEqual({ groupOrder });
  });
});
