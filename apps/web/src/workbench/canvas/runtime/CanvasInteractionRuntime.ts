import type { CanvasDomInteractionTarget } from '../CanvasDomInteractionAdapter';
import type { CanvasCameraState } from './canvasCamera';
import type { CanvasPoint } from './canvasGeometry';

export interface CanvasInteractionRuntimeSnapshot {
  hoveredNodePath: string | undefined;
  gated: boolean;
  cameraMoving: boolean;
  pointerInteractionActive: boolean;
  reconcilePending: boolean;
}

export interface CanvasInteractionRuntime {
  getSnapshot(): CanvasInteractionRuntimeSnapshot;
  subscribe(listener: (snapshot: CanvasInteractionRuntimeSnapshot) => void): () => void;
  updatePointer(input: { screenPoint: CanvasPoint; target?: CanvasDomInteractionTarget | undefined }): void;
  setCameraState(state: CanvasCameraState): void;
  setPointerInteractionActive(active: boolean): void;
  takeReconcilePoint(): CanvasPoint | undefined;
  reconcile(target: CanvasDomInteractionTarget): void;
  leaveSurface(): void;
  dispose(): void;
}

export function createCanvasInteractionRuntime(): CanvasInteractionRuntime {
  const listeners = new Set<(snapshot: CanvasInteractionRuntimeSnapshot) => void>();
  let cameraState: CanvasCameraState = 'idle';
  let pointerInteractionActive = false;
  let pointerScreenPoint: CanvasPoint | undefined;
  let hoveredNodePath: string | undefined;
  let reconcilePending = false;
  let reconcilePublishPending = false;

  const gated = () => cameraState === 'moving' || pointerInteractionActive;
  const snapshot = (): CanvasInteractionRuntimeSnapshot => ({
    hoveredNodePath,
    gated: gated(),
    cameraMoving: cameraState === 'moving',
    pointerInteractionActive,
    reconcilePending: reconcilePending || reconcilePublishPending
  });
  const notify = () => {
    const next = snapshot();
    for (const listener of listeners) {
      listener(next);
    }
  };
  const setHoveredNodePath = (next: string | undefined) => {
    if (hoveredNodePath === next) {
      return false;
    }
    hoveredNodePath = next;
    return true;
  };
  const syncGateTransition = (previousGated: boolean) => {
    const nextGated = gated();
    if (nextGated === previousGated) {
      notify();
      return;
    }
    if (nextGated) {
      reconcilePending = true;
      reconcilePublishPending = false;
      setHoveredNodePath(undefined);
    } else if (previousGated) {
      reconcilePending = true;
    }
    notify();
  };

  return {
    getSnapshot: snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    updatePointer: (input) => {
      pointerScreenPoint = input.screenPoint;
      if (gated() || !input.target || input.target.kind === 'blocked') {
        return;
      }
      const nextHoveredNodePath = hoveredNodePathForTarget(input.target);
      if (setHoveredNodePath(nextHoveredNodePath)) {
        notify();
      }
    },
    setCameraState: (nextCameraState) => {
      if (cameraState === nextCameraState) {
        return;
      }
      const previousGated = gated();
      cameraState = nextCameraState;
      syncGateTransition(previousGated);
    },
    setPointerInteractionActive: (nextPointerInteractionActive) => {
      if (pointerInteractionActive === nextPointerInteractionActive) {
        return;
      }
      const previousGated = gated();
      pointerInteractionActive = nextPointerInteractionActive;
      syncGateTransition(previousGated);
    },
    takeReconcilePoint: () => {
      if (gated() || !reconcilePending) {
        return undefined;
      }
      if (!pointerScreenPoint) {
        reconcilePending = false;
        reconcilePublishPending = false;
        notify();
        return undefined;
      }
      reconcilePending = false;
      reconcilePublishPending = true;
      return pointerScreenPoint;
    },
    reconcile: (target) => {
      if (gated()) {
        return;
      }
      const shouldPublish = reconcilePending || reconcilePublishPending;
      reconcilePending = false;
      reconcilePublishPending = false;
      if (setHoveredNodePath(hoveredNodePathForTarget(target)) || shouldPublish) {
        notify();
      }
    },
    leaveSurface: () => {
      pointerScreenPoint = undefined;
      reconcilePending = false;
      reconcilePublishPending = false;
      if (setHoveredNodePath(undefined)) {
        notify();
      }
    },
    dispose: () => {
      listeners.clear();
      pointerScreenPoint = undefined;
      hoveredNodePath = undefined;
      reconcilePending = false;
      reconcilePublishPending = false;
    }
  };
}

function hoveredNodePathForTarget(target: CanvasDomInteractionTarget): string | undefined {
  return target.kind === 'node' ? target.projectRelativePath : undefined;
}
