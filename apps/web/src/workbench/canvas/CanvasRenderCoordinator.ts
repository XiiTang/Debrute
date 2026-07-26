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
import type { CanvasLayoutOverride } from './canvasManualLayoutDraft';
import type { CanvasCamera, CanvasCameraState } from './runtime/canvasCamera';
import type { CanvasRect, CanvasSize } from './runtime/canvasGeometry';
import { rectsIntersect } from './runtime/canvasGeometry';
import { selectedNodeProjectRelativePaths, type CanvasSelection } from './runtime/canvasSelection';

export interface CanvasNodeRenderOrderView {
  domOrder: string;
  zIndex: number;
}

export interface CanvasRenderCoordinatorSnapshot {
  visibleRect: CanvasRect;
  virtualRect: CanvasRect;
  culledNodePaths: ReadonlySet<string>;
  nodesByPath: ReadonlyMap<string, ProjectedCanvasNode>;
  nodeRenderOrder: ReadonlyMap<string, CanvasNodeRenderOrderView>;
  edges: CanvasEdgeSegment[];
}

export interface CanvasRenderCoordinatorUpdateInput {
  camera: CanvasCamera;
  cameraState: CanvasCameraState;
  surfaceSize: CanvasSize | undefined;
  selection: CanvasSelection | undefined;
  activeNodePaths: readonly string[];
  layoutOverrides: readonly CanvasLayoutOverride[];
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
  let edgeOverlayIndex = createCanvasEdgeOverlayIndex(projection.edges);
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
    const layoutOverrides = input.layoutOverrides;
    const layoutByPath = new Map(
      layoutOverrides.map((layout) => [layout.projectRelativePath, layout])
    );
    const currentNodeForPath = (path: string): ProjectedCanvasNode | undefined => {
      const node = latestNodesByPath.get(path);
      const layout = layoutByPath.get(path);
      return node && layout ? canvasNodeWithLayoutOverride(node, layout) : node;
    };
    const overrideNodes = layoutOverrides
      .map((layout) => currentNodeForPath(layout.projectRelativePath))
      .filter((node): node is ProjectedCanvasNode => Boolean(node));
    const nodes = rendered.nodes
      .map((node) => currentNodeForPath(node.projectRelativePath) ?? node)
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
      renderedEdges: rendered.edges,
      currentNodeForPath,
      layoutOverrides,
      edgeOverlayIndex
    });
    return {
      visibleRect: rendered.visibleRect,
      virtualRect: rendered.virtualRect,
      culledNodePaths,
      nodesByPath,
      nodeRenderOrder: nodeRenderOrderFor(nodes),
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
        edgeOverlayIndex = createCanvasEdgeOverlayIndex(projection.edges);
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
      .join('\u001e')
  ].join('\u001d');
}

function canvasRenderCoordinatorMountedInputKey(input: CanvasRenderCoordinatorUpdateInput): string {
  const mountedPaths = [...new Set([
    ...selectedNodeProjectRelativePaths(input.selection),
    ...input.activeNodePaths,
    ...input.layoutOverrides.map((layout) => layout.projectRelativePath)
  ])].sort().join('\u001f');
  const layoutKey = [...input.layoutOverrides]
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

function renderSnapshotEdges(input: {
  renderedEdges: CanvasEdgeSegment[];
  currentNodeForPath(path: string): ProjectedCanvasNode | undefined;
  layoutOverrides: readonly CanvasLayoutOverride[];
  edgeOverlayIndex: CanvasEdgeOverlayIndex;
}): CanvasEdgeSegment[] {
  if (input.layoutOverrides.length === 0) {
    return input.renderedEdges;
  }
  const overridePaths = new Set(input.layoutOverrides.map((layout) => layout.projectRelativePath));
  const connectedEdgeIds = new Set<string>();
  const connectedEdges = [...overridePaths]
    .flatMap((path) => input.edgeOverlayIndex.edgesByNodePath.get(path) ?? [])
    .filter((edge) => {
      if (connectedEdgeIds.has(edge.id)) {
        return false;
      }
      connectedEdgeIds.add(edge.id);
      return true;
    })
    .sort((left, right) => (
      input.edgeOverlayIndex.orderById.get(left.id)!
      - input.edgeOverlayIndex.orderById.get(right.id)!
    ));
  if (connectedEdges.length === 0) {
    return input.renderedEdges;
  }
  const connectedNodePaths = new Set(
    connectedEdges.flatMap((edge) => [
      edge.sourceProjectRelativePath,
      edge.targetProjectRelativePath
    ])
  );
  const routedConnectedEdges = canvasEdgeSegmentsForProjectionEdges({
    nodes: [...connectedNodePaths]
      .flatMap((path) => input.currentNodeForPath(path) ?? []),
    edges: connectedEdges
  });
  return input.renderedEdges
    .filter((edge) => !connectedEdgeIds.has(edge.id))
    .concat(routedConnectedEdges)
    .sort((left, right) => (
      input.edgeOverlayIndex.orderById.get(left.id)!
      - input.edgeOverlayIndex.orderById.get(right.id)!
    ));
}

interface CanvasEdgeOverlayIndex {
  edgesByNodePath: ReadonlyMap<string, CanvasProjection['edges']>;
  orderById: ReadonlyMap<string, number>;
}

function createCanvasEdgeOverlayIndex(edges: CanvasProjection['edges']): CanvasEdgeOverlayIndex {
  const edgesByNodePath = new Map<string, CanvasProjection['edges']>();
  const orderById = new Map<string, number>();
  edges.forEach((edge, order) => {
    orderById.set(edge.id, order);
    for (const path of new Set([
      edge.sourceProjectRelativePath,
      edge.targetProjectRelativePath
    ])) {
      const connected = edgesByNodePath.get(path);
      if (connected) {
        connected.push(edge);
      } else {
        edgesByNodePath.set(path, [edge]);
      }
    }
  });
  return { edgesByNodePath, orderById };
}

function canvasNodeWithLayoutOverride(
  node: ProjectedCanvasNode,
  layout: CanvasLayoutOverride
): ProjectedCanvasNode {
  return {
    ...node,
    x: layout.x,
    y: layout.y,
    width: layout.width,
    height: layout.height
  };
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

function nodeRenderOrderFor(nodes: ProjectedCanvasNode[]): Map<string, CanvasNodeRenderOrderView> {
  const renderOrder = new Map<string, CanvasNodeRenderOrderView>();
  for (const node of nodes) {
    renderOrder.set(node.projectRelativePath, {
      domOrder: node.projectRelativePath,
      zIndex: node.z
    });
  }
  return renderOrder;
}

function canvasRenderPerfTimestamp(): number {
  return performance.now();
}
