import type { CanvasProjection, ProjectedCanvasNode } from '@debrute/canvas-core';
import { CANVAS_PERF_INTERACTION_SESSION_TYPES, type CanvasPerfCounterName, type CanvasPerfMonitor } from './CanvasPerfMonitor';
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
}

export interface CanvasRenderCoordinatorUpdateInput {
  camera: CanvasCamera;
  cameraState: CanvasCameraState;
  surfaceSize: CanvasSize | undefined;
  selection: CanvasSelection | undefined;
  activeNodePaths: readonly string[];
}

export interface CanvasRenderCoordinator {
  setProjection(projection: CanvasProjection): void;
  update(input: CanvasRenderCoordinatorUpdateInput): CanvasRenderCoordinatorSnapshot;
}

export interface CanvasRenderCoordinatorInput {
  projection: CanvasProjection;
  perfMonitor?: Pick<CanvasPerfMonitor, 'recordCounter'> | undefined;
}

export function createCanvasRenderCoordinator(input: CanvasRenderCoordinatorInput): CanvasRenderCoordinator {
  let projection = input.projection;
  let membershipKey = canvasRenderProjectionMembershipKey(projection);
  let latestNodesByPath = new Map(projection.nodes.map((node) => [node.projectRelativePath, node]));
  let index = createCanvasVirtualizationIndex({
    nodes: projection.nodes,
    edges: projection.edges
  });
  let snapshot: CanvasRenderCoordinatorSnapshot | undefined;
  let mountedInputPathKey: string | undefined;

  const recordCounter = (name: CanvasPerfCounterName, detail?: Record<string, unknown>) => {
    input.perfMonitor?.recordCounter({
      sessionTypes: CANVAS_PERF_INTERACTION_SESSION_TYPES,
      timestamp: canvasRenderPerfTimestamp(),
      source: 'CanvasRenderCoordinator',
      name,
      detail
    });
  };

  const buildSnapshot = (input: CanvasRenderCoordinatorUpdateInput): CanvasRenderCoordinatorSnapshot => {
    const rendered: VirtualizedCanvasRenderState = index.render({
      camera: input.camera,
      surfaceSize: input.surfaceSize,
      selection: input.selection,
      activeNodeProjectRelativePaths: input.activeNodePaths
    });
    const nodes = rendered.nodes
      .map((node) => latestNodesByPath.get(node.projectRelativePath) ?? node)
      .sort((left, right) => left.projectRelativePath.localeCompare(right.projectRelativePath));
    const nodesByPath = new Map(nodes.map((node) => [node.projectRelativePath, node]));
    const culledNodePaths = new Set(
      nodes
        .filter((node) => !rectsIntersect(rendered.virtualRect, nodeRect(node)))
        .map((node) => node.projectRelativePath)
    );
    return {
      visibleRect: rendered.visibleRect,
      virtualRect: rendered.virtualRect,
      culledNodePaths,
      nodesByPath,
      nodeLayers: nodeLayersFor(nodes),
      edges: rendered.edges
    };
  };

  return {
    setProjection(nextProjection) {
      projection = nextProjection;
      latestNodesByPath = new Map(projection.nodes.map((node) => [node.projectRelativePath, node]));
      const nextMembershipKey = canvasRenderProjectionMembershipKey(nextProjection);
      if (nextMembershipKey !== membershipKey) {
        membershipKey = nextMembershipKey;
        index = createCanvasVirtualizationIndex({
          nodes: projection.nodes,
          edges: projection.edges
        });
        snapshot = undefined;
        mountedInputPathKey = undefined;
        recordCounter('render-virtual-refresh', { reason: 'projection-membership-change' });
        return;
      }
      if (snapshot) {
        snapshot = remapSnapshotNodes(snapshot, latestNodesByPath);
      }
    },
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
        recordCounter('render-snapshot-reuse');
        return snapshot;
      }
      if (input.cameraState === 'moving' && snapshot) {
        recordCounter('render-virtual-refresh', { reason: 'moving-refresh-margin' });
      }
      snapshot = buildSnapshot(input);
      mountedInputPathKey = nextMountedInputPathKey;
      recordCounter('render-snapshot-build', {
        cameraState: input.cameraState,
        mountedNodeCount: snapshot.nodesByPath.size,
        culledNodeCount: snapshot.culledNodePaths.size
      });
      return snapshot;
    }
  };
}

export function canvasRenderProjectionMembershipKey(projection: CanvasProjection): string {
  return [
    projection.nodes
      .map((node) => [
        node.projectRelativePath,
        node.x,
        node.y,
        node.width,
        node.height,
        node.visible === false ? 'hidden' : 'visible'
      ].join('\u001f'))
      .sort()
      .join('\u001e'),
    projection.edges
      .map((edge) => [
        edge.id,
        edge.sourceProjectRelativePath,
        edge.targetProjectRelativePath
      ].join('\u001f'))
      .sort()
      .join('\u001e')
  ].join('\u001d');
}

function remapSnapshotNodes(
  snapshot: CanvasRenderCoordinatorSnapshot,
  nodesByLatestPath: ReadonlyMap<string, ProjectedCanvasNode>
): CanvasRenderCoordinatorSnapshot {
  const nodes = [...snapshot.nodesByPath.keys()]
    .flatMap((path) => nodesByLatestPath.get(path) ?? [])
    .sort((left, right) => left.projectRelativePath.localeCompare(right.projectRelativePath));
  return {
    ...snapshot,
    nodesByPath: new Map(nodes.map((node) => [node.projectRelativePath, node])),
    nodeLayers: nodeLayersFor(nodes)
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

function canvasRenderPerfTimestamp(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}
