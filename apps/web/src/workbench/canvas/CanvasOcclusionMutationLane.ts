export interface CanvasOcclusionMutationLane {
  run<Result>(mutation: () => Promise<Result>): Promise<Result>;
}

export function createCanvasOcclusionMutationLane(): CanvasOcclusionMutationLane {
  let tail = Promise.resolve();
  return {
    run(mutation) {
      const result = tail.then(mutation);
      tail = result.then(() => undefined, () => undefined);
      return result;
    }
  };
}
