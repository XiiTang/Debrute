import { availableParallelism, totalmem } from 'node:os';

const GIB = 1024 ** 3;

export interface TestWorkerPlan {
  availableCpus: number;
  totalMemoryBytes: number;
  unitWorkers: number;
  domWorkers: number;
  integrationWorkers: number;
  systemWorkers: 1;
  referenceHardware: boolean;
}

export function resolveWorkerPlan(input: {
  availableCpus: number;
  totalMemoryBytes: number;
  requestedWorkers?: string;
}): TestWorkerPlan {
  const requestedWorkers = input.requestedWorkers === undefined
    ? Number.POSITIVE_INFINITY
    : Number(input.requestedWorkers);

  if (
    input.requestedWorkers !== undefined
    && (!Number.isInteger(requestedWorkers) || requestedWorkers <= 0)
  ) {
    throw new Error('DEBRUTE_TEST_WORKERS must be a positive integer');
  }

  const unitWorkers = Math.min(
    4,
    Math.max(1, input.availableCpus - 2),
    requestedWorkers
  );

  return {
    availableCpus: input.availableCpus,
    totalMemoryBytes: input.totalMemoryBytes,
    unitWorkers,
    domWorkers: Math.min(2, unitWorkers),
    integrationWorkers: Math.min(2, unitWorkers),
    systemWorkers: 1,
    referenceHardware: input.availableCpus >= 6 && input.totalMemoryBytes >= 8 * GIB
  };
}

export const testWorkerPlan = resolveWorkerPlan({
  availableCpus: availableParallelism(),
  totalMemoryBytes: totalmem(),
  ...(process.env.DEBRUTE_TEST_WORKERS === undefined
    ? {}
    : { requestedWorkers: process.env.DEBRUTE_TEST_WORKERS })
});
