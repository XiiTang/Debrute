export interface CanvasOcclusionMutationLane {
  run<Result>(canvasId: string, mutation: () => Promise<Result>): Promise<Result>;
}

export function createCanvasOcclusionMutationLane(): CanvasOcclusionMutationLane {
  const tails = new Map<string, Promise<void>>();
  return {
    run(canvasId, mutation) {
      const result = (tails.get(canvasId) ?? Promise.resolve()).then(mutation);
      const tail = result.then(() => undefined, () => undefined);
      tails.set(canvasId, tail);
      void tail.then(() => {
        if (tails.get(canvasId) === tail) {
          tails.delete(canvasId);
        }
      });
      return result;
    }
  };
}
