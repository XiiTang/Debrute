import {
  CANVAS_PERF_INTERACTION_SESSION_TYPES,
  type CanvasPerfMonitor
} from './CanvasPerfMonitor.js';
import {
  createCanvasCullingController,
  type CanvasCullingCounts
} from './CanvasCullingController.js';
import type { CanvasScenePresentationUpdate } from './CanvasScenePresentation.js';
import type {
  CanvasEditorRuntime,
  CanvasRuntimePointerInteraction,
  CanvasRuntimeSnapshot
} from './runtime/CanvasEditorRuntime.js';
import type { CanvasRect } from './runtime/canvasGeometry.js';
import type { CanvasStageRuntime } from './runtime/CanvasStageRuntime.js';
import { selectedNodeProjectRelativePaths } from './runtime/canvasSelection.js';
import { canvasPreviewDistanceSquared } from './CanvasPreviewScheduling.js';

export interface CanvasPreviewOrderSource {
  getPreviewOrderSnapshot(): CanvasRect;
  subscribePreviewOrder(listener: () => void): () => void;
}

export interface CanvasRenderLifecycle extends CanvasPreviewOrderSource {
  attach(): () => void;
  previewDistanceSquaredForNode(path: string): number;
  getCullingCounts(): CanvasCullingCounts;
}

interface CanvasRenderLifecycleInput {
  runtime: CanvasEditorRuntime;
  stageRuntime: Pick<CanvasStageRuntime,
    'setCamera'
    | 'setNodeLayout'
    | 'setNodeVisible'
    | 'setEdgeGroupGeometry'
    | 'setEdgeGroupVisible'
    | 'setSelectedNodePaths'>;
  perfMonitor?: Pick<CanvasPerfMonitor, 'recordCounter'> | undefined;
  requestFrame?: ((callback: FrameRequestCallback) => number) | undefined;
  cancelFrame?: ((handle: number) => void) | undefined;
}

export function createCanvasRenderLifecycle(input: CanvasRenderLifecycleInput): CanvasRenderLifecycle {
  const requestFrame = input.requestFrame ?? window.requestAnimationFrame.bind(window);
  const cancelFrame = input.cancelFrame ?? window.cancelAnimationFrame.bind(window);
  const culling = createCanvasCullingController({
    stageRuntime: input.stageRuntime,
    queryNodePaths: input.runtime.scene.queryNodePaths,
    queryEdgeGroupIds: input.runtime.scene.queryEdgeGroupIds
  });
  const previewOrderListeners = new Set<() => void>();
  let previewOrderSnapshot: CanvasRect = { x: 0, y: 0, width: 0, height: 0 };
  let pendingFrame: number | undefined;
  let frameEpoch = 0;
  let activeSubscriptions: (() => void)[] | undefined;

  const recordCounter = (
    name: 'render-snapshot-build' | 'render-snapshot-reuse' | 'viewport-cull-queued' | 'viewport-idle-publish'
  ): void => {
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

  const publishPreviewOrderSnapshot = (nextSnapshot: CanvasRect): void => {
    if (sameCanvasRect(previewOrderSnapshot, nextSnapshot)) {
      return;
    }
    previewOrderSnapshot = nextSnapshot;
    for (const listener of previewOrderListeners) {
      listener();
    }
  };

  const publishPreviewOrder = (
    runtimeSnapshot: CanvasRuntimeSnapshot = input.runtime.getSnapshot()
  ): void => publishPreviewOrderSnapshot(syncCulling(runtimeSnapshot));

  const commitPresentation = (update: CanvasScenePresentationUpdate): void => {
    cancelPendingFrame();
    for (const layout of update.nodeLayouts) {
      input.stageRuntime.setNodeLayout(layout.projectRelativePath, layout);
    }
    for (const group of update.edgeGroups) {
      input.stageRuntime.setEdgeGroupGeometry(group.id, group.path);
    }
    if (update.geometryChanged) {
      culling.invalidateGeometry();
    }
    recordCounter('render-snapshot-reuse');
    const runtimeSnapshot = input.runtime.getSnapshot();
    const visibleRect = syncCulling(runtimeSnapshot);
    if (runtimeSnapshot.pointerInteraction === undefined) {
      publishPreviewOrderSnapshot(visibleRect);
    }
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

  return {
    attach() {
      if (activeSubscriptions) {
        throw new Error('Canvas Render Lifecycle is already attached.');
      }
      culling.acceptScene(input.runtime.scene.getRenderSnapshot());
      const initialSnapshot = input.runtime.getSnapshot();
      input.stageRuntime.setCamera(initialSnapshot.camera);
      input.stageRuntime.setSelectedNodePaths(
        new Set(selectedNodeProjectRelativePaths(initialSnapshot.selection))
      );
      publishPreviewOrder(initialSnapshot);
      recordCounter('render-snapshot-build');
      const subscriptions = [
        input.runtime.scene.subscribeRenderSnapshot(() => {
          cancelPendingFrame();
          culling.acceptScene(input.runtime.scene.getRenderSnapshot());
          recordCounter('render-snapshot-build');
          publishPreviewOrder(input.runtime.getSnapshot());
        }),
        input.runtime.scene.subscribePresentation(commitPresentation),
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
        input.runtime.subscribeSelection((selection) => {
          input.stageRuntime.setSelectedNodePaths(
            new Set(selectedNodeProjectRelativePaths(selection))
          );
          syncCulling();
        }),
        input.runtime.subscribeContentInteraction(() => {
          syncCulling();
        }),
        input.runtime.subscribeSurfaceSize(() => {
          cancelPendingFrame();
          publishPreviewOrder(input.runtime.getSnapshot());
        }),
        input.runtime.subscribePointerInteraction((pointerInteraction) => {
          if (pointerInteraction === undefined) {
            publishPreviewOrder(input.runtime.getSnapshot());
          } else {
            syncCulling();
          }
        })
      ];
      activeSubscriptions = subscriptions;
      return () => {
        if (activeSubscriptions !== subscriptions) {
          return;
        }
        cancelPendingFrame();
        for (const unsubscribe of subscriptions) {
          unsubscribe();
        }
        activeSubscriptions = undefined;
      };
    },
    getPreviewOrderSnapshot: () => previewOrderSnapshot,
    subscribePreviewOrder(listener) {
      previewOrderListeners.add(listener);
      return () => previewOrderListeners.delete(listener);
    },
    previewDistanceSquaredForNode: (path) => {
      const node = input.runtime.scene.getPresentedNodes().get(path);
      return node ? canvasPreviewDistanceSquared(node, previewOrderSnapshot) : Number.POSITIVE_INFINITY;
    },
    getCullingCounts: culling.getCounts
  };
}

function displayRetainedNodePaths(snapshot: CanvasRuntimeSnapshot): ReadonlySet<string> {
  return new Set([
    ...(snapshot.contentInteractionProjectRelativePath
      ? [snapshot.contentInteractionProjectRelativePath]
      : []),
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
