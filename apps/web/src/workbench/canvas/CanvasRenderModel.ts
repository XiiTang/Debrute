import type { CanvasProjection, ProjectedCanvasNode } from '@axis/canvas-core';
import {
  createCanvasVirtualizationIndex,
  nodeRect,
  shouldRefreshVirtualizedRenderState,
  type CanvasEdgeSegment,
  type VirtualizedCanvasRenderState
} from './canvasVirtualization';
import type { CanvasCamera, CanvasCameraState } from './runtime/canvasCamera';
import type { CanvasRect, CanvasSize } from './runtime/canvasGeometry';
import { rectsIntersect } from './runtime/canvasGeometry';
import { selectedNodeProjectRelativePaths, type CanvasSelection } from './runtime/canvasSelection';

export interface CanvasRenderModelSnapshot {
  visibleRect: CanvasRect;
  virtualRect: CanvasRect;
  culledNodePaths: ReadonlySet<string>;
  nodesByPath: ReadonlyMap<string, ProjectedCanvasNode>;
  edges: CanvasEdgeSegment[];
  svgBounds: CanvasRect;
  svgViewBox: string;
}

export interface CanvasRenderModelUpdateInput {
  camera: CanvasCamera;
  cameraState: CanvasCameraState;
  surfaceSize: CanvasSize | undefined;
  selection: CanvasSelection | undefined;
  activeNodePaths: readonly string[];
}

export interface CanvasRenderModel {
  update(input: CanvasRenderModelUpdateInput): CanvasRenderModelSnapshot;
}

export function createCanvasRenderModel(projection: CanvasProjection): CanvasRenderModel {
  const index = createCanvasVirtualizationIndex({
    nodes: projection.nodes,
    edges: projection.edges
  });
  let snapshot: CanvasRenderModelSnapshot | undefined;
  let mountedInputPathKey: string | undefined;

  const buildSnapshot = (input: CanvasRenderModelUpdateInput): CanvasRenderModelSnapshot => {
    const rendered: VirtualizedCanvasRenderState = index.render({
      camera: input.camera,
      surfaceSize: input.surfaceSize,
      selection: input.selection,
      activeNodeProjectRelativePaths: input.activeNodePaths
    });
    const nodesByPath = new Map(rendered.nodes.map((node) => [node.projectRelativePath, node]));
    const culledNodePaths = new Set(
      rendered.nodes
        .filter((node) => !rectsIntersect(rendered.visibleRect, nodeRect(node)))
        .map((node) => node.projectRelativePath)
    );
    return {
      visibleRect: rendered.visibleRect,
      virtualRect: rendered.virtualRect,
      culledNodePaths,
      nodesByPath,
      edges: rendered.edges,
      svgBounds: rendered.svgBounds,
      svgViewBox: rendered.svgViewBox
    };
  };

  return {
    update(input) {
      const nextMountedInputPathKey = canvasRenderModelMountedInputPathKey(input);
      if (
        input.cameraState === 'moving'
        && snapshot
        && nextMountedInputPathKey === mountedInputPathKey
        && !shouldRefreshVirtualizedRenderState({
          currentVirtualRect: snapshot.virtualRect,
          camera: input.camera,
          surfaceSize: input.surfaceSize
        })
      ) {
        return snapshot;
      }
      snapshot = buildSnapshot(input);
      mountedInputPathKey = nextMountedInputPathKey;
      return snapshot;
    }
  };
}

function canvasRenderModelMountedInputPathKey(input: CanvasRenderModelUpdateInput): string {
  return [...new Set([
    ...selectedNodeProjectRelativePaths(input.selection),
    ...input.activeNodePaths
  ])].sort().join('\u001f');
}
