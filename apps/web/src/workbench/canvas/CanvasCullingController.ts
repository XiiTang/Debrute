import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import type { CanvasRenderCoordinatorSnapshot } from './CanvasRenderCoordinator.js';
import { queryCanvasViewport, type CanvasEdgeSegment } from './canvasViewport.js';
import type { CanvasCamera } from './runtime/canvasCamera.js';
import { normalizedSurfaceSize } from './runtime/canvasCoordinateSystem.js';
import type { CanvasRect, CanvasSize } from './runtime/canvasGeometry.js';
import type { CanvasStageRuntime } from './runtime/CanvasStageRuntime.js';

export interface CanvasCullingCounts {
  readonly displayVisibleNodeCount: number;
  readonly culledNodeCount: number;
  readonly visibleEdgeCount: number;
}

interface CanvasCullingController {
  acceptScene(scene: CanvasRenderCoordinatorSnapshot): void;
  sync(input: {
    camera: CanvasCamera;
    surfaceSize: CanvasSize | undefined;
    displayRetainedNodePaths: ReadonlySet<string>;
  }): CanvasRect;
  isNodeInViewport(path: string): boolean;
  getCounts(): CanvasCullingCounts;
}

interface CachedCanvasGeometry {
  readonly camera: CanvasCamera;
  readonly surfaceSize: CanvasSize;
  readonly visibleNodePaths: ReadonlySet<string>;
  readonly visibleEdgeIds: ReadonlySet<string>;
  readonly visibleRect: CanvasRect;
}

export function createCanvasCullingController(input: {
  stageRuntime: Pick<CanvasStageRuntime, 'setNodeVisible' | 'setEdgeVisible'>;
}): CanvasCullingController {
  let scene: CanvasRenderCoordinatorSnapshot = {
    nodesByPath: new Map(),
    nodeZIndexByPath: new Map(),
    edges: []
  };
  let sceneNodes = [...scene.nodesByPath.values()];
  let sceneChanged = true;
  let cachedGeometry: CachedCanvasGeometry | undefined;
  let inViewportNodePaths: ReadonlySet<string> = new Set();
  let displayVisibleNodePaths = new Set<string>();
  let visibleEdgeIds: ReadonlySet<string> = new Set();
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
      sceneNodes = [...scene.nodesByPath.values()];
      sceneChanged = true;
      cachedGeometry = undefined;
    },
    sync(syncInput) {
      const surfaceSize = normalizedSurfaceSize(syncInput.surfaceSize);
      const geometry = cachedGeometry
        && sameCamera(cachedGeometry.camera, syncInput.camera)
        && sameSurfaceSize(cachedGeometry.surfaceSize, surfaceSize)
        ? cachedGeometry
        : geometryForViewport({
          nodes: sceneNodes,
          edges: scene.edges,
          camera: syncInput.camera,
          surfaceSize
        });
      cachedGeometry = geometry;
      const nextInViewportNodePaths = geometry.visibleNodePaths;
      const nextDisplayVisibleNodePaths = new Set(nextInViewportNodePaths);
      for (const path of syncInput.displayRetainedNodePaths) {
        if (scene.nodesByPath.has(path)) {
          nextDisplayVisibleNodePaths.add(path);
        }
      }
      const nextVisibleEdgeIds = geometry.visibleEdgeIds;

      if (sceneChanged) {
        for (const path of scene.nodesByPath.keys()) {
          input.stageRuntime.setNodeVisible(path, nextDisplayVisibleNodePaths.has(path));
        }
        for (const edge of scene.edges) {
          input.stageRuntime.setEdgeVisible(edge.id, nextVisibleEdgeIds.has(edge.id));
        }
      } else {
        writeVisibilityDelta(
          displayVisibleNodePaths,
          nextDisplayVisibleNodePaths,
          input.stageRuntime.setNodeVisible
        );
        writeVisibilityDelta(
          visibleEdgeIds,
          nextVisibleEdgeIds,
          input.stageRuntime.setEdgeVisible
        );
      }

      sceneChanged = false;
      inViewportNodePaths = nextInViewportNodePaths;
      displayVisibleNodePaths = nextDisplayVisibleNodePaths;
      visibleEdgeIds = nextVisibleEdgeIds;
      counts = {
        displayVisibleNodeCount: displayVisibleNodePaths.size,
        culledNodeCount: Math.max(0, scene.nodesByPath.size - displayVisibleNodePaths.size),
        visibleEdgeCount: visibleEdgeIds.size
      };
      return geometry.visibleRect;
    },
    isNodeInViewport: (path) => inViewportNodePaths.has(path),
    getCounts: () => counts
  };
}

function geometryForViewport(input: {
  nodes: readonly ProjectedCanvasNode[];
  edges: readonly CanvasEdgeSegment[];
  camera: CanvasCamera;
  surfaceSize: CanvasSize;
}): CachedCanvasGeometry {
  const query = queryCanvasViewport({
    nodes: input.nodes,
    edges: input.edges,
    camera: input.camera,
    surfaceSize: input.surfaceSize
  });
  return {
    camera: input.camera,
    surfaceSize: input.surfaceSize,
    visibleNodePaths: query.visibleNodePaths,
    visibleEdgeIds: query.visibleEdgeIds,
    visibleRect: query.visibleRect
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
