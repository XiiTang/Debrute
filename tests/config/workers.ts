import { availableParallelism } from 'node:os';

export interface TestWorkerPlan {
  availableCpus: number;
  unitWorkers: number;
  domWorkers: number;
  releaseWorkers: 1;
}

export function resolveWorkerPlan(input: {
  availableCpus: number;
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
    unitWorkers,
    domWorkers: Math.min(2, unitWorkers),
    releaseWorkers: 1
  };
}

export const testWorkerPlan = resolveWorkerPlan({
  availableCpus: availableParallelism(),
  ...(process.env.DEBRUTE_TEST_WORKERS === undefined
    ? {}
    : { requestedWorkers: process.env.DEBRUTE_TEST_WORKERS })
});
