import type { CanvasProjection, ProjectedCanvasNode } from './CanvasScene.js';
import {
  canvasEdgeRoutingGroupForSource,
  canvasEdgeRoutingGroupIntersectsRect,
  canvasEdgeRoutingGroupsForProjection,
  type CanvasEdgeRoutingGroup
} from './CanvasEdgeRoutingGroup.js';
import { createCanvasSpatialIndex } from './CanvasSpatialIndex.js';
import type { CanvasLayoutOverride } from './canvasManualLayoutDraft.js';
import type { CanvasRect } from './runtime/canvasGeometry.js';

export interface CanvasSceneSnapshot {
  nodesByPath: ReadonlyMap<string, ProjectedCanvasNode>;
  edgeGroups: readonly CanvasEdgeRoutingGroup[];
}

interface CanvasScenePresentationInput {
  layoutOverrides: readonly CanvasLayoutOverride[];
  selectedProjectRelativePaths: readonly string[];
}

interface CanvasPresentedNodeLayout extends CanvasLayoutOverride {
  z: number;
}

export interface CanvasScenePresentationUpdate {
  nodeLayouts: readonly CanvasPresentedNodeLayout[];
  edgeGroups: readonly CanvasEdgeRoutingGroup[];
  geometryChanged: boolean;
}

export interface CanvasRuntimeScene {
  getRenderSnapshot(): CanvasSceneSnapshot;
  subscribeRenderSnapshot(listener: () => void): () => void;
  getPresentedNodes(): ReadonlyMap<string, ProjectedCanvasNode>;
  queryNodePaths(rect: CanvasRect): string[];
  queryEdgeGroupIds(rect: CanvasRect): string[];
  subscribePresentation(listener: (update: CanvasScenePresentationUpdate) => void): () => void;
}

interface CanvasScenePresentation extends CanvasRuntimeScene {
  setProjection(projection: CanvasProjection, presentation: CanvasScenePresentationInput): CanvasSceneSnapshot;
  publishRenderSnapshot(): void;
  applyPresentation(presentation: CanvasScenePresentationInput): CanvasScenePresentationUpdate;
  dispose(): void;
}

export function createCanvasScenePresentation(input: {
  projection: CanvasProjection;
  presentation: CanvasScenePresentationInput;
}): CanvasScenePresentation {
  let projection = input.projection;
  let projectedNodesByPath = new Map<string, ProjectedCanvasNode>();
  let presentedNodesByPath = new Map<string, ProjectedCanvasNode>();
  let layoutByPath = new Map<string, CanvasLayoutOverride>();
  let selectedPaths = new Set<string>();
  let selectedOrder: string[] = [];
  let edgesBySource = new Map<string, CanvasProjection['edges']>();
  let sourceGroupsByNodePath = new Map<string, ReadonlySet<string>>();
  let edgeOrderById = new Map<string, number>();
  let edgeGroupsById = new Map<string, CanvasEdgeRoutingGroup>();
  const nodeSpatialIndex = createCanvasSpatialIndex();
  const edgeGroupSpatialIndex = createCanvasSpatialIndex();
  const renderSnapshotListeners = new Set<() => void>();
  const presentationListeners = new Set<(update: CanvasScenePresentationUpdate) => void>();
  let snapshot: CanvasSceneSnapshot = { nodesByPath: new Map(), edgeGroups: [] };

  const rebuild = (
    nextProjection: CanvasProjection,
    presentation: CanvasScenePresentationInput
  ): CanvasSceneSnapshot => {
    projection = nextProjection;
    projectedNodesByPath = new Map(
      projection.nodes.map((node) => [node.projectRelativePath, node])
    );
    layoutByPath = new Map(
      presentation.layoutOverrides.map((layout) => [layout.projectRelativePath, layout])
    );
    selectedPaths = new Set(presentation.selectedProjectRelativePaths);
    selectedOrder = selectedOrderFor({
      selectedPaths,
      preferredOrder: selectedOrder,
      nodes: projection.nodes
    });
    const selectedZByPath = selectionZByPath(projection.nodes, selectedOrder);
    presentedNodesByPath = new Map(projection.nodes.map((node) => {
      const presented = presentedNodeFor(
        node,
        layoutByPath.get(node.projectRelativePath),
        selectedZByPath.get(node.projectRelativePath)
      );
      return [node.projectRelativePath, presented];
    }));
    nodeSpatialIndex.rebuild([...presentedNodesByPath.values()].map((node) => ({
      id: node.projectRelativePath,
      bounds: node
    })));
    edgesBySource = edgesBySourceFor(projection.edges);
    sourceGroupsByNodePath = sourceGroupsByNodePathFor(projection.edges);
    edgeOrderById = new Map(projection.edges.map((edge, order) => [edge.id, order]));
    const edgeGroups = canvasEdgeRoutingGroupsForProjection({
      nodes: [...presentedNodesByPath.values()],
      edges: projection.edges
    }).sort((left, right) => left.order - right.order);
    edgeGroupsById = new Map(edgeGroups.map((group) => [group.id, group]));
    edgeGroupSpatialIndex.rebuild(edgeGroups.map((group) => ({ id: group.id, bounds: group.bounds })));
    snapshot = {
      nodesByPath: new Map(
        [...presentedNodesByPath.values()]
          .sort((left, right) => left.projectRelativePath.localeCompare(right.projectRelativePath))
          .map((node) => [node.projectRelativePath, node])
      ),
      edgeGroups
    };
    return snapshot;
  };

  rebuild(input.projection, input.presentation);

  return {
    getRenderSnapshot: () => snapshot,
    subscribeRenderSnapshot(listener) {
      renderSnapshotListeners.add(listener);
      return () => renderSnapshotListeners.delete(listener);
    },
    getPresentedNodes: () => presentedNodesByPath,
    queryNodePaths: (rect) => nodeSpatialIndex.query(rect),
    queryEdgeGroupIds(rect) {
      return edgeGroupSpatialIndex.query(rect).filter((id) => {
        const group = edgeGroupsById.get(id);
        return group ? canvasEdgeRoutingGroupIntersectsRect(group, rect) : false;
      });
    },
    subscribePresentation(listener) {
      presentationListeners.add(listener);
      return () => presentationListeners.delete(listener);
    },
    setProjection: rebuild,
    publishRenderSnapshot() {
      for (const listener of renderSnapshotListeners) {
        listener();
      }
    },
    applyPresentation(presentation) {
      const nextLayoutByPath = new Map(
        presentation.layoutOverrides.map((layout) => [layout.projectRelativePath, layout])
      );
      const nextSelectedPaths = new Set(presentation.selectedProjectRelativePaths);
      const selectionChanged = !sameStringSet(selectedPaths, nextSelectedPaths);
      const nextSelectedOrder = selectionChanged
        ? selectedOrderFor({
            selectedPaths: nextSelectedPaths,
            preferredOrder: [...presentedNodesByPath.values()]
              .filter((node) => nextSelectedPaths.has(node.projectRelativePath))
              .sort(comparePresentedNodeOrder)
              .map((node) => node.projectRelativePath),
            nodes: projection.nodes
          })
        : selectedOrder;
      const nextSelectedZByPath = selectionZByPath(projection.nodes, nextSelectedOrder);
      const geometryCandidates = new Set([
        ...layoutByPath.keys(),
        ...nextLayoutByPath.keys()
      ]);
      const geometryDirtyPaths = new Set(
        [...geometryCandidates].filter((path) => !sameLayout(
          layoutByPath.get(path),
          nextLayoutByPath.get(path)
        ))
      );
      const presentationDirtyPaths = new Set([
        ...geometryDirtyPaths,
        ...selectedPaths,
        ...nextSelectedPaths
      ]);
      const nodeLayouts: CanvasPresentedNodeLayout[] = [];
      for (const path of presentationDirtyPaths) {
        const projected = projectedNodesByPath.get(path);
        if (!projected) {
          presentedNodesByPath.delete(path);
          nodeSpatialIndex.remove(path);
          continue;
        }
        const previous = presentedNodesByPath.get(path);
        const presented = presentedNodeFor(
          projected,
          nextLayoutByPath.get(path),
          nextSelectedZByPath.get(path)
        );
        presentedNodesByPath.set(path, presented);
        if (geometryDirtyPaths.has(path)) {
          nodeSpatialIndex.upsert({ id: path, bounds: presented });
        }
        if (previous && samePresentedNodeLayout(previous, presented)) {
          continue;
        }
        nodeLayouts.push({
          projectRelativePath: path,
          x: presented.x,
          y: presented.y,
          width: presented.width,
          height: presented.height,
          z: presented.z
        });
      }

      const dirtySourceGroups = new Set<string>();
      for (const path of geometryDirtyPaths) {
        for (const sourcePath of sourceGroupsByNodePath.get(path) ?? []) {
          dirtySourceGroups.add(sourcePath);
        }
      }
      const updatedGroups: CanvasEdgeRoutingGroup[] = [];
      for (const sourcePath of dirtySourceGroups) {
        const group = canvasEdgeRoutingGroupForSource({
          sourceProjectRelativePath: sourcePath,
          nodesByPath: presentedNodesByPath,
          edges: edgesBySource.get(sourcePath) ?? [],
          orderByEdgeId: edgeOrderById
        });
        if (!group) {
          edgeGroupsById.delete(sourcePath);
          edgeGroupSpatialIndex.remove(sourcePath);
          continue;
        }
        edgeGroupsById.set(sourcePath, group);
        edgeGroupSpatialIndex.upsert({ id: group.id, bounds: group.bounds });
        updatedGroups.push(group);
      }
      layoutByPath = nextLayoutByPath;
      selectedPaths = nextSelectedPaths;
      selectedOrder = nextSelectedOrder;
      const update = {
        nodeLayouts,
        edgeGroups: updatedGroups,
        geometryChanged: geometryDirtyPaths.size > 0
      } satisfies CanvasScenePresentationUpdate;
      if (nodeLayouts.length > 0 || updatedGroups.length > 0) {
        for (const listener of presentationListeners) {
          listener(update);
        }
      }
      return update;
    },
    dispose() {
      renderSnapshotListeners.clear();
      presentationListeners.clear();
    }
  };
}

function sameLayout(
  left: CanvasLayoutOverride | undefined,
  right: CanvasLayoutOverride | undefined
): boolean {
  return left === right || Boolean(
    left
    && right
    && left.projectRelativePath === right.projectRelativePath
    && left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height
  );
}

function edgesBySourceFor(edges: CanvasProjection['edges']): Map<string, CanvasProjection['edges']> {
  const bySource = new Map<string, CanvasProjection['edges']>();
  for (const edge of edges) {
    const sourceEdges = bySource.get(edge.sourceProjectRelativePath);
    if (sourceEdges) {
      sourceEdges.push(edge);
    } else {
      bySource.set(edge.sourceProjectRelativePath, [edge]);
    }
  }
  return bySource;
}

function sourceGroupsByNodePathFor(edges: CanvasProjection['edges']): Map<string, ReadonlySet<string>> {
  const mutable = new Map<string, Set<string>>();
  for (const edge of edges) {
    for (const path of new Set([
      edge.sourceProjectRelativePath,
      edge.targetProjectRelativePath
    ])) {
      const sources = mutable.get(path) ?? new Set<string>();
      sources.add(edge.sourceProjectRelativePath);
      mutable.set(path, sources);
    }
  }
  return mutable;
}

function presentedNodeFor(
  node: ProjectedCanvasNode,
  layout: CanvasLayoutOverride | undefined,
  selectionZ: number | undefined
): ProjectedCanvasNode {
  if (!layout && selectionZ === undefined) {
    return node;
  }
  return {
    ...node,
    ...(layout ? {
      x: layout.x,
      y: layout.y,
      width: layout.width,
      height: layout.height
    } : {}),
    ...(selectionZ === undefined ? {} : { z: selectionZ })
  };
}

function selectionZByPath(
  nodes: readonly ProjectedCanvasNode[],
  selectedOrder: readonly string[]
): Map<string, number> {
  const top = nodes.reduce((maximum, node) => Math.max(maximum, node.z), 0);
  return new Map(selectedOrder.map((path, index) => [path, top + index + 1]));
}

function selectedOrderFor(input: {
  selectedPaths: ReadonlySet<string>;
  preferredOrder: readonly string[];
  nodes: readonly ProjectedCanvasNode[];
}): string[] {
  const available = new Set(input.nodes.map((node) => node.projectRelativePath));
  const retained = input.preferredOrder.filter((path) => (
    available.has(path) && input.selectedPaths.has(path)
  ));
  const retainedPaths = new Set(retained);
  return retained.concat(
    input.nodes
      .filter((node) => input.selectedPaths.has(node.projectRelativePath) && !retainedPaths.has(node.projectRelativePath))
      .sort(comparePresentedNodeOrder)
      .map((node) => node.projectRelativePath)
  );
}

function comparePresentedNodeOrder(left: ProjectedCanvasNode, right: ProjectedCanvasNode): number {
  return left.z - right.z || left.projectRelativePath.localeCompare(right.projectRelativePath);
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function samePresentedNodeLayout(left: ProjectedCanvasNode, right: ProjectedCanvasNode): boolean {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height
    && left.z === right.z;
}
