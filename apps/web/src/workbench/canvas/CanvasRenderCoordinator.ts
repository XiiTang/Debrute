import type { CanvasProjection, ProjectedCanvasNode } from '@debrute/canvas-core';
import { CANVAS_PERF_INTERACTION_SESSION_TYPES, type CanvasPerfMonitor } from './CanvasPerfMonitor.js';
import {
  canvasEdgeSegmentsForProjectionEdges,
  type CanvasEdgeSegment
} from './canvasViewport.js';
import type { CanvasLayoutOverride } from './canvasManualLayoutDraft.js';

export interface CanvasRenderCoordinatorSnapshot {
  nodesByPath: ReadonlyMap<string, ProjectedCanvasNode>;
  nodeZIndexByPath: ReadonlyMap<string, number>;
  edges: CanvasEdgeSegment[];
}

export interface CanvasRenderCoordinatorUpdateInput {
  layoutOverrides: readonly CanvasLayoutOverride[];
  stackOrder?: readonly string[] | undefined;
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
  let latestNodesByPath = nodesByPathFor(projection.nodes);
  let baseEdges = canvasEdgeSegmentsForProjectionEdges(projection);
  let edgeOverlayIndex = createCanvasEdgeOverlayIndex(projection.edges);
  let snapshot: CanvasRenderCoordinatorSnapshot | undefined;
  let snapshotInputKey: string | undefined;

  const recordCounter = (name: 'render-snapshot-build' | 'render-snapshot-reuse'): void => {
    input.perfMonitor?.recordCounter({
      sessionTypes: CANVAS_PERF_INTERACTION_SESSION_TYPES,
      timestamp: canvasRenderPerfTimestamp(),
      source: 'CanvasRenderCoordinator',
      name
    });
  };

  const buildSnapshot = (update: CanvasRenderCoordinatorUpdateInput): CanvasRenderCoordinatorSnapshot => {
    const layoutByPath = new Map(
      update.layoutOverrides.map((layout) => [layout.projectRelativePath, layout])
    );
    const currentNodeForPath = (path: string): ProjectedCanvasNode | undefined => {
      const node = latestNodesByPath.get(path);
      const layout = layoutByPath.get(path);
      return node && layout ? canvasNodeWithLayoutOverride(node, layout) : node;
    };
    const nodes = projection.nodes
      .map((node) => currentNodeForPath(node.projectRelativePath) ?? node)
      .sort((left, right) => left.projectRelativePath.localeCompare(right.projectRelativePath));
    const nodesByPath = nodesByPathFor(nodes);
    return {
      nodesByPath,
      nodeZIndexByPath: nodeZIndexByPathFor(nodes, update.stackOrder),
      edges: renderSnapshotEdges({
        renderedEdges: baseEdges,
        currentNodeForPath,
        layoutOverrides: update.layoutOverrides,
        edgeOverlayIndex
      })
    };
  };

  return {
    setProjection(nextProjection) {
      if (nextProjection === projection) {
        return;
      }
      projection = nextProjection;
      latestNodesByPath = nodesByPathFor(projection.nodes);
      baseEdges = canvasEdgeSegmentsForProjectionEdges(projection);
      edgeOverlayIndex = createCanvasEdgeOverlayIndex(projection.edges);
      snapshot = undefined;
      snapshotInputKey = undefined;
    },
    update(update) {
      const nextInputKey = canvasRenderCoordinatorInputKey(update);
      if (snapshot && nextInputKey === snapshotInputKey) {
        recordCounter('render-snapshot-reuse');
        return snapshot;
      }
      snapshot = buildSnapshot(update);
      snapshotInputKey = nextInputKey;
      recordCounter('render-snapshot-build');
      return snapshot;
    }
  };
}

function canvasRenderCoordinatorInputKey(input: CanvasRenderCoordinatorUpdateInput): string {
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
  return [layoutKey, input.stackOrder?.join('\u001f') ?? ''].join('\u001d');
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

function nodesByPathFor(nodes: readonly ProjectedCanvasNode[]): Map<string, ProjectedCanvasNode> {
  return new Map(nodes.map((node) => [node.projectRelativePath, node]));
}

function nodeZIndexByPathFor(
  nodes: ProjectedCanvasNode[],
  stackOrder: readonly string[] | undefined
): Map<string, number> {
  const zIndexForNode = new Map<string, number>();
  const zIndexByPath = stackOrder
    ? new Map(stackOrder.map((path, zIndex) => [path, zIndex]))
    : undefined;
  for (const node of nodes) {
    zIndexForNode.set(node.projectRelativePath, zIndexByPath?.get(node.projectRelativePath) ?? node.z);
  }
  return zIndexForNode;
}

function canvasRenderPerfTimestamp(): number {
  return performance.now();
}
