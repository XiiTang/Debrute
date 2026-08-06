import { describe, expect, it, vi } from 'vitest';
import { createCanvasOcclusionMutationLane } from './CanvasOcclusionMutationLane.js';

describe('Canvas Occlusion Mutation Lane', () => {
  it('runs one mutation at a time and lets each read the preceding result', async () => {
    const lane = createCanvasOcclusionMutationLane();
    const first = deferred<void>();
    let acceptedOrder = 'base';
    const observations: string[] = [];

    const firstMutation = lane.run(async () => {
      observations.push(acceptedOrder);
      await first.promise;
      acceptedOrder = 'after-first';
    });
    const secondMutation = lane.run(async () => {
      observations.push(acceptedOrder);
      acceptedOrder = 'after-second';
    });

    await Promise.resolve();
    expect(observations).toEqual(['base']);
    first.resolve();
    await Promise.all([firstMutation, secondMutation]);
    expect(observations).toEqual(['base', 'after-first']);
    expect(acceptedOrder).toBe('after-second');
  });

  it('reports a failed mutation without blocking the next one', async () => {
    const lane = createCanvasOcclusionMutationLane();
    const next = vi.fn(async () => undefined);
    const failed = lane.run(async () => {
      throw new Error('write failed');
    });
    const succeeded = lane.run(next);

    await expect(failed).rejects.toThrow('write failed');
    await expect(succeeded).resolves.toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });
});

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value?: T) => resolvePromise(value as T) };
}
