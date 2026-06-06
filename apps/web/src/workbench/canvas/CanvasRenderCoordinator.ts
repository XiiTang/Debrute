import type { CanvasProjection, ProjectedCanvasNode } from '@debrute/canvas-core';
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

export interface CanvasNodeLayerView {
  domOrder: string;
  zIndex: number;
}

export interface CanvasRenderCoordinatorSnapshot {
  visibleRect: CanvasRect;
  virtualRect: CanvasRect;
  culledNodePaths: ReadonlySet<string>;
  nodesByPath: ReadonlyMap<string, ProjectedCanvasNode>;
  nodeLayers: ReadonlyMap<string, CanvasNodeLayerView>;
  edges: CanvasEdgeSegment[];
  svgBounds: CanvasRect;
  svgViewBox: string;
}

export interface CanvasRenderCoordinatorUpdateInput {
  camera: CanvasCamera;
  cameraState: CanvasCameraState;
  surfaceSize: CanvasSize | undefined;
  selection: CanvasSelection | undefined;
  activeNodePaths: readonly string[];
}

export interface CanvasRenderCoordinator {
  update(input: CanvasRenderCoordinatorUpdateInput): CanvasRenderCoordinatorSnapshot;
}

export function createCanvasRenderCoordinator(projection: CanvasProjection): CanvasRenderCoordinator {
  const index = createCanvasVirtualizationIndex({
    nodes: projection.nodes,
    edges: projection.edges
  });
  let snapshot: CanvasRenderCoordinatorSnapshot | undefined;
  let mountedInputPathKey: string | undefined;

  const buildSnapshot = (input: CanvasRenderCoordinatorUpdateInput): CanvasRenderCoordinatorSnapshot => {
    const rendered: VirtualizedCanvasRenderState = index.render({
      camera: input.camera,
      surfaceSize: input.surfaceSize,
      selection: input.selection,
      activeNodeProjectRelativePaths: input.activeNodePaths
    });
    const nodes = [...rendered.nodes].sort((left, right) => left.projectRelativePath.localeCompare(right.projectRelativePath));
    const nodesByPath = new Map(nodes.map((node) => [node.projectRelativePath, node]));
    const culledNodePaths = new Set(
      nodes
        .filter((node) => !rectsIntersect(rendered.visibleRect, nodeRect(node)))
        .map((node) => node.projectRelativePath)
    );
    return {
      visibleRect: rendered.visibleRect,
      virtualRect: rendered.virtualRect,
      culledNodePaths,
      nodesByPath,
      nodeLayers: nodeLayersFor(nodes),
      edges: rendered.edges,
      svgBounds: rendered.svgBounds,
      svgViewBox: rendered.svgViewBox
    };
  };

  return {
    update(input) {
      const nextMountedInputPathKey = canvasRenderCoordinatorMountedInputPathKey(input);
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

function canvasRenderCoordinatorMountedInputPathKey(input: CanvasRenderCoordinatorUpdateInput): string {
  return [...new Set([
    ...selectedNodeProjectRelativePaths(input.selection),
    ...input.activeNodePaths
  ])].sort().join('\u001f');
}

function nodeLayersFor(nodes: ProjectedCanvasNode[]): Map<string, CanvasNodeLayerView> {
  const layers = new Map<string, CanvasNodeLayerView>();
  for (const node of nodes) {
    layers.set(node.projectRelativePath, {
      domOrder: node.projectRelativePath,
      zIndex: node.z
    });
  }
  return layers;
}
