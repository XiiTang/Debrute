import type { CanvasProjection } from '@debrute/canvas-core';
import {
  CANVAS_PERF_INTERACTION_SESSION_TYPES,
  type CanvasPerfMonitor
} from './CanvasPerfMonitor.js';
import {
  createCanvasRenderCoordinator,
  type CanvasRenderCoordinatorSnapshot,
  type CanvasRenderCoordinatorUpdateInput
} from './CanvasRenderCoordinator.js';
import type { CanvasVisibilityController } from './CanvasVisibilityController.js';
import type {
  CanvasEditorRuntime,
  CanvasRuntimeDragState,
  CanvasRuntimeSnapshot
} from './runtime/CanvasEditorRuntime.js';
import type { CanvasStageRuntime } from './runtime/CanvasStageRuntime.js';
import { selectedNodeProjectRelativePaths } from './runtime/canvasSelection.js';

export interface CanvasRenderLifecycle {
  acceptProjection(projection: CanvasProjection): void;
  getSnapshot(): CanvasRenderCoordinatorSnapshot;
  subscribe(listener: () => void): () => void;
}

export interface CanvasRenderLifecycleInput {
  projection: CanvasProjection;
  runtime: CanvasEditorRuntime;
  stageRuntime: Pick<CanvasStageRuntime, 'setCamera'>;
  visibilityController: CanvasVisibilityController;
  perfMonitor?: Pick<CanvasPerfMonitor, 'recordCounter'> | undefined;
  requestFrame?: ((callback: FrameRequestCallback) => number) | undefined;
  cancelFrame?: ((handle: number) => void) | undefined;
}

export function createCanvasRenderLifecycle(input: CanvasRenderLifecycleInput): CanvasRenderLifecycle {
  const requestFrame = input.requestFrame ?? window.requestAnimationFrame.bind(window);
  const cancelFrame = input.cancelFrame ?? window.cancelAnimationFrame.bind(window);
  const coordinator = createCanvasRenderCoordinator({
    projection: input.projection,
    perfMonitor: input.perfMonitor
  });
  const listeners = new Set<() => void>();
  let snapshot = coordinator.update(renderInput(input.runtime));
  let pendingFrame: number | undefined;
  let frameEpoch = 0;
  let detachRuntime: (() => void) | undefined;
  let acceptedProjection = input.projection;

  const recordMovingQueued = () => {
    input.perfMonitor?.recordCounter({
      sessionTypes: CANVAS_PERF_INTERACTION_SESSION_TYPES,
      timestamp: canvasRenderLifecycleTimestamp(),
      source: 'CanvasRenderLifecycle',
      name: 'render-moving-queued',
      value: 1
    });
  };

  const recordIdleFlush = () => {
    input.perfMonitor?.recordCounter({
      sessionTypes: CANVAS_PERF_INTERACTION_SESSION_TYPES,
      timestamp: canvasRenderLifecycleTimestamp(),
      source: 'CanvasRenderLifecycle',
      name: 'render-idle-flush',
      value: 1
    });
  };

  const cancelPendingFrame = () => {
    if (pendingFrame === undefined) {
      return;
    }
    frameEpoch += 1;
    cancelFrame(pendingFrame);
    pendingFrame = undefined;
  };

  const commitCurrent = (cancelPending: boolean) => {
    if (cancelPending) {
      cancelPendingFrame();
    }
    const runtimeSnapshot = input.runtime.getSnapshot();
    const next = coordinator.update(renderInput(input.runtime, runtimeSnapshot));
    input.visibilityController.sync({
      nodesByPath: next.nodesByPath,
      culledNodePaths: next.culledNodePaths,
      selectedNodePaths: new Set(selectedNodeProjectRelativePaths(runtimeSnapshot.selection)),
      activeNodePaths: new Set(activeNodeProjectRelativePaths(runtimeSnapshot.dragState))
    });
    if (next === snapshot) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) {
      listener();
    }
  };

  const requestMoving = () => {
    if (pendingFrame !== undefined) {
      return;
    }
    recordMovingQueued();
    const epoch = frameEpoch;
    pendingFrame = requestFrame(() => {
      if (epoch !== frameEpoch || pendingFrame === undefined) {
        return;
      }
      pendingFrame = undefined;
      commitCurrent(false);
    });
  };

  const attachRuntime = () => {
    if (detachRuntime) {
      return;
    }
    input.stageRuntime.setCamera(input.runtime.getSnapshot().camera);
    const detach = [
      input.runtime.subscribeCamera((camera) => {
        input.stageRuntime.setCamera(camera);
        requestMoving();
      }),
      input.runtime.subscribeCameraState((cameraState) => {
        if (cameraState === 'idle') {
          recordIdleFlush();
          commitCurrent(true);
        }
      }),
      input.runtime.subscribeSelection(() => commitCurrent(true)),
      input.runtime.subscribeSurfaceSize(() => commitCurrent(true)),
      input.runtime.subscribeDragState(() => commitCurrent(true)),
      input.runtime.manualLayout.subscribeRejection(() => commitCurrent(true))
    ];
    detachRuntime = () => {
      cancelPendingFrame();
      for (const unsubscribe of detach) {
        unsubscribe();
      }
      detachRuntime = undefined;
    };
    commitCurrent(true);
  };

  return {
    acceptProjection: (projection) => {
      if (projection === acceptedProjection) {
        return;
      }
      acceptedProjection = projection;
      input.runtime.manualLayout.acceptProjection(projection);
      coordinator.setProjection(projection);
      commitCurrent(true);
    },
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      attachRuntime();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          detachRuntime?.();
        }
      };
    }
  };
}

function renderInput(
  runtime: CanvasEditorRuntime,
  snapshot: CanvasRuntimeSnapshot = runtime.getSnapshot()
): CanvasRenderCoordinatorUpdateInput {
  return {
    camera: snapshot.camera,
    cameraState: snapshot.cameraState,
    surfaceSize: snapshot.surfaceSize,
    selection: snapshot.selection,
    activeNodePaths: activeNodeProjectRelativePaths(snapshot.dragState),
    layoutOverrides: runtime.manualLayout.getPresentation().layoutOverrides
  };
}

function activeNodeProjectRelativePaths(state: CanvasRuntimeDragState | undefined): string[] {
  if (!state) {
    return [];
  }
  return state.kind === 'move-node'
    ? state.origins.map((origin) => origin.projectRelativePath)
    : [state.node.projectRelativePath];
}

function canvasRenderLifecycleTimestamp(): number {
  return performance.now();
}
