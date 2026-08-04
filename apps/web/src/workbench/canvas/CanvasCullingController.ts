import type { CanvasSceneSnapshot } from './CanvasScenePresentation.js';
import type { CanvasCamera } from './runtime/canvasCamera.js';
import {
  normalizedSurfaceSize,
  visibleCanvasRectForCamera
} from './runtime/canvasCoordinateSystem.js';
import type { CanvasRect, CanvasSize } from './runtime/canvasGeometry.js';
import type { CanvasStageRuntime } from './runtime/CanvasStageRuntime.js';

export interface CanvasCullingCounts {
  readonly displayVisibleNodeCount: number;
  readonly culledNodeCount: number;
  readonly visibleEdgeCount: number;
}

interface CanvasCullingController {
  acceptScene(scene: CanvasSceneSnapshot): void;
  invalidateGeometry(): void;
  sync(input: {
    camera: CanvasCamera;
    surfaceSize: CanvasSize | undefined;
    displayRetainedNodePaths: ReadonlySet<string>;
  }): CanvasRect;
  getCounts(): CanvasCullingCounts;
}

interface CachedCanvasGeometry {
  readonly camera: CanvasCamera;
  readonly surfaceSize: CanvasSize;
  readonly visibleNodePaths: ReadonlySet<string>;
  readonly visibleEdgeGroupIds: ReadonlySet<string>;
  readonly visibleRect: CanvasRect;
}

export function createCanvasCullingController(input: {
  stageRuntime: Pick<CanvasStageRuntime, 'setNodeVisible' | 'setEdgeGroupVisible'>;
  queryNodePaths: (rect: CanvasRect) => readonly string[];
  queryEdgeGroupIds: (rect: CanvasRect) => readonly string[];
}): CanvasCullingController {
  let scene: CanvasSceneSnapshot = {
    nodesByPath: new Map(),
    edgeGroups: []
  };
  let sceneChanged = true;
  let cachedGeometry: CachedCanvasGeometry | undefined;
  let displayVisibleNodePaths = new Set<string>();
  let visibleEdgeGroupIds: ReadonlySet<string> = new Set();
  let counts: CanvasCullingCounts = {
    displayVisibleNodeCount: 0,
    culledNodeCount: 0,
    visibleEdgeCount: 0
  };

  return {
    acceptScene(nextScene) {
      if (nextScene === scene) {
        return;
      }
      scene = nextScene;
      sceneChanged = true;
      cachedGeometry = undefined;
    },
    invalidateGeometry() {
      cachedGeometry = undefined;
    },
    sync(syncInput) {
      const surfaceSize = normalizedSurfaceSize(syncInput.surfaceSize);
      const geometry = cachedGeometry
        && sameCamera(cachedGeometry.camera, syncInput.camera)
        && sameSurfaceSize(cachedGeometry.surfaceSize, surfaceSize)
        ? cachedGeometry
        : geometryForViewport({
          camera: syncInput.camera,
          surfaceSize,
          queryNodePaths: input.queryNodePaths,
          queryEdgeGroupIds: input.queryEdgeGroupIds
        });
      cachedGeometry = geometry;
      const nextInViewportNodePaths = geometry.visibleNodePaths;
      const nextDisplayVisibleNodePaths = new Set(nextInViewportNodePaths);
      for (const path of syncInput.displayRetainedNodePaths) {
        if (scene.nodesByPath.has(path)) {
          nextDisplayVisibleNodePaths.add(path);
        }
      }
      const nextVisibleEdgeGroupIds = geometry.visibleEdgeGroupIds;

      if (sceneChanged) {
        for (const path of scene.nodesByPath.keys()) {
          input.stageRuntime.setNodeVisible(path, nextDisplayVisibleNodePaths.has(path));
        }
        for (const group of scene.edgeGroups) {
          input.stageRuntime.setEdgeGroupVisible(group.id, nextVisibleEdgeGroupIds.has(group.id));
        }
      } else {
        writeVisibilityDelta(
          displayVisibleNodePaths,
          nextDisplayVisibleNodePaths,
          input.stageRuntime.setNodeVisible
        );
        writeVisibilityDelta(
          visibleEdgeGroupIds,
          nextVisibleEdgeGroupIds,
          input.stageRuntime.setEdgeGroupVisible
        );
      }

      sceneChanged = false;
      displayVisibleNodePaths = nextDisplayVisibleNodePaths;
      visibleEdgeGroupIds = nextVisibleEdgeGroupIds;
      counts = {
        displayVisibleNodeCount: displayVisibleNodePaths.size,
        culledNodeCount: Math.max(0, scene.nodesByPath.size - displayVisibleNodePaths.size),
        visibleEdgeCount: visibleEdgeGroupIds.size
      };
      return geometry.visibleRect;
    },
    getCounts: () => counts
  };
}

function geometryForViewport(input: {
  camera: CanvasCamera;
  surfaceSize: CanvasSize;
  queryNodePaths: (rect: CanvasRect) => readonly string[];
  queryEdgeGroupIds: (rect: CanvasRect) => readonly string[];
}): CachedCanvasGeometry {
  const visibleRect = visibleCanvasRectForCamera({
    camera: input.camera,
    surfaceSize: input.surfaceSize
  });
  return {
    camera: input.camera,
    surfaceSize: input.surfaceSize,
    visibleNodePaths: new Set(input.queryNodePaths(visibleRect)),
    visibleEdgeGroupIds: new Set(input.queryEdgeGroupIds(visibleRect)),
    visibleRect
  };
}

function sameCamera(left: CanvasCamera, right: CanvasCamera): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function sameSurfaceSize(left: CanvasSize, right: CanvasSize): boolean {
  return left.width === right.width && left.height === right.height;
}

function writeVisibilityDelta(
  previous: ReadonlySet<string>,
  next: ReadonlySet<string>,
  write: (id: string, visible: boolean) => void
): void {
  for (const id of previous) {
    if (!next.has(id)) {
      write(id, false);
    }
  }
  for (const id of next) {
    if (!previous.has(id)) {
      write(id, true);
    }
  }
}
