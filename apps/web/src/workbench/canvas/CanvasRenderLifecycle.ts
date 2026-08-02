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
import {
  createCanvasCullingController,
  type CanvasCullingCounts
} from './CanvasCullingController.js';
import type {
  CanvasEditorRuntime,
  CanvasRuntimePointerInteraction,
  CanvasRuntimeSnapshot
} from './runtime/CanvasEditorRuntime.js';
import type { CanvasRect } from './runtime/canvasGeometry.js';
import type { CanvasStageRuntime } from './runtime/CanvasStageRuntime.js';
import { selectedNodeProjectRelativePaths } from './runtime/canvasSelection.js';

export interface CanvasPreviewOrderSource {
  getPreviewOrderSnapshot(): CanvasRect;
  subscribePreviewOrder(listener: () => void): () => void;
}

export interface CanvasRenderLifecycle extends CanvasPreviewOrderSource {
  acceptProjection(projection: CanvasProjection): void;
  getSnapshot(): CanvasRenderCoordinatorSnapshot;
  subscribe(listener: () => void): () => void;
  previewTierForNode(path: string): 0 | 1;
  getCullingCounts(): CanvasCullingCounts;
}

interface CanvasRenderLifecycleInput {
  projection: CanvasProjection;
  runtime: CanvasEditorRuntime;
  stageRuntime: Pick<CanvasStageRuntime,
    'setCamera' | 'setNodeVisible' | 'setEdgeVisible'>;
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
  const culling = createCanvasCullingController({ stageRuntime: input.stageRuntime });
  const listeners = new Set<() => void>();
  const previewOrderListeners = new Set<() => void>();
  let scene = coordinator.update(renderInput(input.runtime));
  let previewOrderSnapshot: CanvasRect = { x: 0, y: 0, width: 0, height: 0 };
  let pendingFrame: number | undefined;
  let frameEpoch = 0;
  let detachRuntime: (() => void) | undefined;
  let acceptedProjection = input.projection;
  culling.acceptScene(scene);

  const recordCounter = (name: 'viewport-cull-queued' | 'viewport-idle-publish'): void => {
    input.perfMonitor?.recordCounter({
      sessionTypes: CANVAS_PERF_INTERACTION_SESSION_TYPES,
      timestamp: performance.now(),
      source: 'CanvasRenderLifecycle',
      name,
      value: 1
    });
  };

  const cancelPendingFrame = (): void => {
    if (pendingFrame === undefined) {
      return;
    }
    frameEpoch += 1;
    cancelFrame(pendingFrame);
    pendingFrame = undefined;
  };

  const syncCulling = (
    runtimeSnapshot: CanvasRuntimeSnapshot = input.runtime.getSnapshot()
  ): CanvasRect => culling.sync({
    camera: runtimeSnapshot.camera,
    surfaceSize: runtimeSnapshot.surfaceSize,
    displayRetainedNodePaths: displayRetainedNodePaths(runtimeSnapshot)
  });

  const publishPreviewOrder = (
    runtimeSnapshot: CanvasRuntimeSnapshot = input.runtime.getSnapshot()
  ): void => {
    const nextSnapshot = syncCulling(runtimeSnapshot);
    if (sameCanvasRect(previewOrderSnapshot, nextSnapshot)) {
      return;
    }
    previewOrderSnapshot = nextSnapshot;
    for (const listener of previewOrderListeners) {
      listener();
    }
  };

  const commitScene = (): void => {
    cancelPendingFrame();
    const next = coordinator.update(renderInput(input.runtime));
    if (next !== scene) {
      scene = next;
      culling.acceptScene(scene);
      publishPreviewOrder(input.runtime.getSnapshot());
      for (const listener of listeners) {
        listener();
      }
      return;
    }
    syncCulling();
  };

  const requestCullingSync = (): void => {
    if (pendingFrame !== undefined) {
      return;
    }
    recordCounter('viewport-cull-queued');
    const epoch = frameEpoch;
    pendingFrame = requestFrame(() => {
      if (epoch !== frameEpoch || pendingFrame === undefined) {
        return;
      }
      pendingFrame = undefined;
      syncCulling();
    });
  };

  const attachRuntime = (): void => {
    if (detachRuntime) {
      return;
    }
    const initialSnapshot = input.runtime.getSnapshot();
    input.stageRuntime.setCamera(initialSnapshot.camera);
    publishPreviewOrder(initialSnapshot);
    const detach = [
      input.runtime.subscribeCamera((camera) => {
        input.stageRuntime.setCamera(camera);
        requestCullingSync();
      }),
      input.runtime.subscribeCameraState((cameraState) => {
        if (cameraState !== 'idle') {
          return;
        }
        recordCounter('viewport-idle-publish');
        cancelPendingFrame();
        publishPreviewOrder(input.runtime.getSnapshot());
      }),
      input.runtime.subscribeSelection(() => syncCulling()),
      input.runtime.subscribeSurfaceSize(() => {
        cancelPendingFrame();
        publishPreviewOrder(input.runtime.getSnapshot());
      }),
      input.runtime.subscribePointerInteraction(commitScene),
      input.runtime.manualLayout.subscribeRejection(commitScene)
    ];
    detachRuntime = () => {
      cancelPendingFrame();
      for (const unsubscribe of detach) {
        unsubscribe();
      }
      detachRuntime = undefined;
    };
  };

  return {
    acceptProjection: (projection) => {
      if (projection === acceptedProjection) {
        return;
      }
      acceptedProjection = projection;
      input.runtime.manualLayout.acceptProjection(projection);
      coordinator.setProjection(projection);
      commitScene();
    },
    getSnapshot: () => scene,
    subscribe: (listener) => {
      listeners.add(listener);
      attachRuntime();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          detachRuntime?.();
        }
      };
    },
    getPreviewOrderSnapshot: () => previewOrderSnapshot,
    subscribePreviewOrder(listener) {
      previewOrderListeners.add(listener);
      return () => previewOrderListeners.delete(listener);
    },
    previewTierForNode: (path) => culling.isNodeInViewport(path) ? 0 : 1,
    getCullingCounts: culling.getCounts
  };
}

function renderInput(runtime: CanvasEditorRuntime): CanvasRenderCoordinatorUpdateInput {
  const manualLayout = runtime.manualLayout.getPresentation();
  return {
    layoutOverrides: manualLayout.layoutOverrides,
    stackOrder: manualLayout.stackOrder
  };
}

function displayRetainedNodePaths(snapshot: CanvasRuntimeSnapshot): ReadonlySet<string> {
  return new Set([
    ...selectedNodeProjectRelativePaths(snapshot.selection),
    ...activeNodeProjectRelativePaths(snapshot.pointerInteraction)
  ]);
}

function activeNodeProjectRelativePaths(state: CanvasRuntimePointerInteraction | undefined): string[] {
  if (!state || state.kind === 'selection-marquee' || state.phase !== 'active') {
    return [];
  }
  return state.kind === 'move-node'
    ? state.origins.map((origin) => origin.projectRelativePath)
    : [state.node.projectRelativePath];
}

function sameCanvasRect(left: CanvasRect, right: CanvasRect): boolean {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}
