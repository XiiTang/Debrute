import type { CanvasProjection, ProjectedCanvasNode } from '@debrute/canvas-core';
import { CANVAS_PERF_INTERACTION_SESSION_TYPES, type CanvasPerfCounterName, type CanvasPerfMonitor } from './CanvasPerfMonitor';
import {
  canvasEdgeSegmentsForProjectionEdges,
  createCanvasVirtualizationIndex,
  nodeRect,
  shouldRefreshVirtualizedRenderState,
  type CanvasEdgeSegment,
  type VirtualizedCanvasRenderState
} from './canvasVirtualization';
import type { CanvasLayoutOverride } from './canvasLocalLayoutDraft';
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
  layoutOverrides?: readonly CanvasLayoutOverride[];
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
  let mountedInputKey: string | undefined;

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
    const layoutOverrides = input.layoutOverrides ?? [];
    const draftAwareNodesByPath = draftAwareNodesByPathFor(latestNodesByPath, layoutOverrides);
    const overrideNodes = layoutOverrides
      .map((layout) => draftAwareNodesByPath.get(layout.projectRelativePath))
      .filter((node): node is ProjectedCanvasNode => Boolean(node));
    const nodes = rendered.nodes
      .map((node) => draftAwareNodesByPath.get(node.projectRelativePath) ?? node)
      .concat(overrideNodes)
      .filter(uniqueNodePathPredicate())
      .sort((left, right) => left.projectRelativePath.localeCompare(right.projectRelativePath));
    const nodesByPath = new Map(nodes.map((node) => [node.projectRelativePath, node]));
    const culledNodePaths = new Set(
      nodes
        .filter((node) => !rectsIntersect(rendered.virtualRect, nodeRect(node)))
        .map((node) => node.projectRelativePath)
    );
    const edges = renderSnapshotEdges({
      projectionEdges: projection.edges,
      renderedEdges: rendered.edges,
      draftAwareNodes: [...draftAwareNodesByPath.values()],
      layoutOverrides
    });
    return {
      visibleRect: rendered.visibleRect,
      virtualRect: rendered.virtualRect,
      culledNodePaths,
      nodesByPath,
      nodeLayers: nodeLayersFor(nodes),
      edges
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
        mountedInputKey = undefined;
        recordCounter('render-virtual-refresh', { reason: 'projection-membership-change' });
        return;
      }
      if (snapshot) {
        snapshot = undefined;
        mountedInputKey = undefined;
      }
    },
    update(input) {
      const nextMountedInputKey = canvasRenderCoordinatorMountedInputKey(input);
      if (
        input.cameraState === 'moving'
        && snapshot
        && nextMountedInputKey === mountedInputKey
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
      mountedInputKey = nextMountedInputKey;
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
        node.height
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

function canvasRenderCoordinatorMountedInputKey(input: CanvasRenderCoordinatorUpdateInput): string {
  const mountedPaths = [...new Set([
    ...selectedNodeProjectRelativePaths(input.selection),
    ...input.activeNodePaths,
    ...(input.layoutOverrides ?? []).map((layout) => layout.projectRelativePath)
  ])].sort().join('\u001f');
  const layoutKey = [...(input.layoutOverrides ?? [])]
    .map((layout) => [
      layout.projectRelativePath,
      layout.x,
      layout.y,
      layout.width,
      layout.height
    ].join('\u001f'))
    .sort()
    .join('\u001e');
  return [mountedPaths, layoutKey].join('\u001d');
}

function draftAwareNodesByPathFor(
  nodesByPath: ReadonlyMap<string, ProjectedCanvasNode>,
  layoutOverrides: readonly CanvasLayoutOverride[]
): Map<string, ProjectedCanvasNode> {
  const next = new Map(nodesByPath);
  for (const layout of layoutOverrides) {
    const node = nodesByPath.get(layout.projectRelativePath);
    if (!node) {
      continue;
    }
    next.set(layout.projectRelativePath, {
      ...node,
      x: layout.x,
      y: layout.y,
      width: layout.width,
      height: layout.height
    });
  }
  return next;
}

function renderSnapshotEdges(input: {
  projectionEdges: CanvasProjection['edges'];
  renderedEdges: CanvasEdgeSegment[];
  draftAwareNodes: ProjectedCanvasNode[];
  layoutOverrides: readonly CanvasLayoutOverride[];
}): CanvasEdgeSegment[] {
  if (input.layoutOverrides.length === 0) {
    return input.renderedEdges;
  }
  const overridePaths = new Set(input.layoutOverrides.map((layout) => layout.projectRelativePath));
  const connectedEdges = input.projectionEdges.filter((edge) => (
    overridePaths.has(edge.sourceProjectRelativePath) || overridePaths.has(edge.targetProjectRelativePath)
  ));
  if (connectedEdges.length === 0) {
    return input.renderedEdges;
  }
  const connectedEdgeIds = new Set(connectedEdges.map((edge) => edge.id));
  const edgeById = new Map(
    input.renderedEdges
      .filter((edge) => !connectedEdgeIds.has(edge.id))
      .map((edge) => [edge.id, edge])
  );
  for (const edge of canvasEdgeSegmentsForProjectionEdges({
    nodes: input.draftAwareNodes,
    edges: connectedEdges
  })) {
    edgeById.set(edge.id, edge);
  }
  return input.projectionEdges.flatMap((edge) => edgeById.get(edge.id) ?? []);
}

function uniqueNodePathPredicate(): (node: ProjectedCanvasNode) => boolean {
  const seen = new Set<string>();
  return (node) => {
    if (seen.has(node.projectRelativePath)) {
      return false;
    }
    seen.add(node.projectRelativePath);
    return true;
  };
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
