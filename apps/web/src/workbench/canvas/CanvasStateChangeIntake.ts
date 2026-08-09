import type { CanvasStateChange } from '@debrute/app-protocol';

interface CanvasStateChangeTarget {
  acceptCanvasStateChange(change: CanvasStateChange): void;
}

export interface CanvasStateChangeIntake {
  accept(change: CanvasStateChange): void;
  setRuntime(runtime: CanvasStateChangeTarget | undefined): void;
}

export function createCanvasStateChangeIntake(): CanvasStateChangeIntake {
  let runtime: CanvasStateChangeTarget | undefined;
  let pending: CanvasStateChange[] = [];
  return {
    accept(change) {
      if (runtime) {
        runtime.acceptCanvasStateChange(change);
      } else {
        pending.push(change);
      }
    },
    setRuntime(nextRuntime) {
      runtime = nextRuntime;
      if (!runtime || pending.length === 0) {
        return;
      }
      const accepted = pending;
      pending = [];
      for (const change of accepted) {
        runtime.acceptCanvasStateChange(change);
      }
    }
  };
}
