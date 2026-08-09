import type { CanvasNodeState, CanvasStateChange } from '@debrute/app-protocol';
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
  getAcceptedNode(path: string): ProjectedCanvasNode | undefined;
  subscribeAcceptedNode(path: string, listener: () => void): () => void;
}

interface CanvasScenePresentation extends CanvasRuntimeScene {
  setProjection(projection: CanvasProjection, presentation: CanvasScenePresentationInput): CanvasSceneSnapshot;
  setHierarchyEdges(edges: CanvasProjection['edges']): CanvasSceneSnapshot;
  getProjection(): CanvasProjection;
  acceptCanvasStateChange(change: CanvasStateChange): CanvasScenePresentationUpdate;
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
  let selectionRankByPath = new Map<string, number>();
  let selectionZStart = 1;
  let occlusionOrder: readonly string[] = [];
  let nodeOrderByPath = new Map<string, number>();
  let edgesBySource = new Map<string, CanvasProjection['edges']>();
  let sourceGroupsByNodePath = new Map<string, ReadonlySet<string>>();
  let edgeOrderById = new Map<string, number>();
  let edgeGroupsById = new Map<string, CanvasEdgeRoutingGroup>();
  const nodeSpatialIndex = createCanvasSpatialIndex();
  const edgeGroupSpatialIndex = createCanvasSpatialIndex();
  const renderSnapshotListeners = new Set<() => void>();
  const presentationListeners = new Set<(update: CanvasScenePresentationUpdate) => void>();
  const acceptedNodeListeners = new Map<string, Set<() => void>>();
  let snapshot: CanvasSceneSnapshot = { nodesByPath: new Map(), edgeGroups: [] };

  const rebuildEdges = (edges: CanvasProjection['edges']): CanvasEdgeRoutingGroup[] => {
    edgesBySource = edgesBySourceFor(edges);
    sourceGroupsByNodePath = sourceGroupsByNodePathFor(edges);
    edgeOrderById = new Map(edges.map((edge, order) => [edge.id, order]));
    const edgeGroups = canvasEdgeRoutingGroupsForProjection({
      nodes: [...presentedNodesByPath.values()],
      edges
    }).sort((left, right) => left.order - right.order);
    edgeGroupsById = new Map(edgeGroups.map((group) => [group.id, group]));
    edgeGroupSpatialIndex.rebuild(edgeGroups.map((group) => ({ id: group.id, bounds: group.bounds })));
    return edgeGroups;
  };

  const rebuild = (
    nextProjection: CanvasProjection,
    presentation: CanvasScenePresentationInput
  ): CanvasSceneSnapshot => {
    projection = nextProjection;
    occlusionOrder = projection.occlusionOrder ?? [];
    nodeOrderByPath = new Map(
      projection.nodes.map((node, index) => [node.projectRelativePath, index])
    );
    projectedNodesByPath = new Map(
      projection.nodes.map((node) => [node.projectRelativePath, node])
    );
    layoutByPath = new Map(
      presentation.layoutOverrides.map((layout) => [layout.projectRelativePath, layout])
    );
    selectionRankByPath = selectionRankByPathForProjection({
      selectedPaths: presentation.selectedProjectRelativePaths,
      nodesByPath: projectedNodesByPath
    });
    selectionZStart = projection.nodes.reduce(
      (start, node) => Math.max(start, node.z + 1),
      projection.nodes.length + occlusionOrder.length
    );
    presentedNodesByPath = new Map(projection.nodes.map((node) => {
      const presented = presentedNodeFor(
        node,
        layoutByPath.get(node.projectRelativePath),
        selectionZForPath(node.projectRelativePath, selectionRankByPath, selectionZStart)
      );
      return [node.projectRelativePath, presented];
    }));
    nodeSpatialIndex.rebuild([...presentedNodesByPath.values()].map((node) => ({
      id: node.projectRelativePath,
      bounds: node
    })));
    const edgeGroups = rebuildEdges(projection.edges);
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

  const updateEdgeGroupsForGeometry = (
    geometryDirtyPaths: ReadonlySet<string>
  ): CanvasEdgeRoutingGroup[] => {
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
    return updatedGroups;
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
    getAcceptedNode: (path) => projectedNodesByPath.get(path),
    subscribeAcceptedNode(path, listener) {
      const listeners = acceptedNodeListeners.get(path) ?? new Set<() => void>();
      listeners.add(listener);
      acceptedNodeListeners.set(path, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          acceptedNodeListeners.delete(path);
        }
      };
    },
    setProjection: rebuild,
    getProjection: () => projection,
    setHierarchyEdges(edges) {
      projection = { ...projection, edges };
      snapshot = {
        nodesByPath: snapshot.nodesByPath,
        edgeGroups: rebuildEdges(edges)
      };
      return snapshot;
    },
    acceptCanvasStateChange(change) {
      const stateChangedPaths = new Set<string>();
      const dirtyPaths = new Set<string>();
      for (const nodeChange of change.nodeStates) {
        const current = projectedNodesByPath.get(nodeChange.projectRelativePath);
        if (!current) {
          continue;
        }
        const next = projectedNodeForState(current, nodeChange.state);
        projectedNodesByPath.set(nodeChange.projectRelativePath, next);
        stateChangedPaths.add(nodeChange.projectRelativePath);
        dirtyPaths.add(nodeChange.projectRelativePath);
      }
      if (change.occlusionOrder !== undefined) {
        occlusionOrder = change.occlusionOrder;
        const zByPath = new Map(
          occlusionOrder.map((path, index) => [path, projectedNodesByPath.size + index])
        );
        for (const [path, current] of projectedNodesByPath) {
          const nextZ = zByPath.get(path) ?? nodeOrderByPath.get(path) ?? current.z;
          if (current.z !== nextZ) {
            projectedNodesByPath.set(path, { ...current, z: nextZ });
            dirtyPaths.add(path);
          }
        }
        selectionZStart = projectedNodesByPath.size + occlusionOrder.length;
        for (const path of selectionRankByPath.keys()) {
          dirtyPaths.add(path);
        }
      }
      projection = {
        ...projection,
        nodes: projection.nodes.map((node) => (
          projectedNodesByPath.get(node.projectRelativePath) ?? node
        )),
        occlusionOrder
      };

      const geometryDirtyPaths = new Set<string>();
      const nodeLayouts: CanvasPresentedNodeLayout[] = [];
      for (const path of dirtyPaths) {
        const projected = projectedNodesByPath.get(path);
        if (!projected) {
          continue;
        }
        const previous = presentedNodesByPath.get(path);
        const presented = presentedNodeFor(
          projected,
          layoutByPath.get(path),
          selectionZForPath(path, selectionRankByPath, selectionZStart)
        );
        presentedNodesByPath.set(path, presented);
        if (!previous || !samePresentedNodeGeometry(previous, presented)) {
          geometryDirtyPaths.add(path);
          nodeSpatialIndex.upsert({ id: path, bounds: presented });
        }
        if (!previous || !samePresentedNodeLayout(previous, presented)) {
          nodeLayouts.push({
            projectRelativePath: path,
            x: presented.x,
            y: presented.y,
            width: presented.width,
            height: presented.height,
            z: presented.z
          });
        }
      }

      const updatedGroups = updateEdgeGroupsForGeometry(geometryDirtyPaths);
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
      for (const path of stateChangedPaths) {
        for (const listener of acceptedNodeListeners.get(path) ?? []) {
          listener();
        }
      }
      return update;
    },
    publishRenderSnapshot() {
      for (const listener of renderSnapshotListeners) {
        listener();
      }
    },
    applyPresentation(presentation) {
      const nextLayoutByPath = new Map(
        presentation.layoutOverrides.map((layout) => [layout.projectRelativePath, layout])
      );
      const nextSelectionRanks = nextSelectionRankByPath({
        currentRanks: selectionRankByPath,
        selectedPaths: presentation.selectedProjectRelativePaths,
        nodesByPath: projectedNodesByPath
      });
      const selectionChanged = nextSelectionRanks !== selectionRankByPath;
      const geometryCandidates = new Set([
        ...layoutByPath.keys(),
        ...nextLayoutByPath.keys()
      ]);
      const layoutDirtyPaths = new Set(
        [...geometryCandidates].filter((path) => !sameLayout(
          layoutByPath.get(path),
          nextLayoutByPath.get(path)
        ))
      );
      const presentationDirtyPaths = new Set([
        ...layoutDirtyPaths,
        ...(selectionChanged ? selectionRankByPath.keys() : []),
        ...(selectionChanged ? nextSelectionRanks.keys() : [])
      ]);
      const geometryDirtyPaths = new Set<string>();
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
          selectionZForPath(path, nextSelectionRanks, selectionZStart)
        );
        presentedNodesByPath.set(path, presented);
        if (!previous || !samePresentedNodeGeometry(previous, presented)) {
          geometryDirtyPaths.add(path);
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

      const updatedGroups = updateEdgeGroupsForGeometry(geometryDirtyPaths);
      layoutByPath = nextLayoutByPath;
      selectionRankByPath = nextSelectionRanks;
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
      acceptedNodeListeners.clear();
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

function projectedNodeForState(
  node: ProjectedCanvasNode,
  state: CanvasNodeState | null
): ProjectedCanvasNode {
  const {
    layoutMode: _layoutMode,
    videoPlayback: _videoPlayback,
    textViewport: _textViewport,
    ...base
  } = node;
  const layout = state?.manualLayout ?? node.automaticLayout ?? node;
  return {
    ...base,
    x: layout.x,
    y: layout.y,
    width: layout.width,
    height: layout.height,
    ...(state?.manualLayout ? { layoutMode: 'manual' as const } : {}),
    ...(state?.videoPlayback ? { videoPlayback: state.videoPlayback } : {}),
    ...(state?.textViewport ? { textViewport: state.textViewport } : {})
  };
}

function selectionZForPath(
  path: string,
  selectionRankByPath: ReadonlyMap<string, number>,
  start: number
): number | undefined {
  const rank = selectionRankByPath.get(path);
  return rank === undefined ? undefined : start + rank;
}

function selectionRankByPathForProjection(input: {
  selectedPaths: readonly string[];
  nodesByPath: ReadonlyMap<string, ProjectedCanvasNode>;
}): Map<string, number> {
  const selectedNodes = selectedNodesInPresentedOrder(input.selectedPaths, input.nodesByPath);
  const firstRank = input.nodesByPath.size - selectedNodes.length + 1;
  return new Map(selectedNodes.map((node, index) => [
    node.projectRelativePath,
    firstRank + index
  ]));
}

function nextSelectionRankByPath(input: {
  currentRanks: Map<string, number>;
  selectedPaths: readonly string[];
  nodesByPath: ReadonlyMap<string, ProjectedCanvasNode>;
}): Map<string, number> {
  const selectedPaths = new Set(input.selectedPaths);
  if (
    selectedPaths.size === input.currentRanks.size
    && [...input.currentRanks.keys()].every((path) => (
      selectedPaths.has(path) && input.nodesByPath.has(path)
    ))
  ) {
    return input.currentRanks;
  }

  const retained = [...input.currentRanks.entries()]
    .filter(([path]) => selectedPaths.has(path) && input.nodesByPath.has(path))
    .sort((left, right) => left[1] - right[1]);
  const retainedPathSet = new Set(retained.map(([path]) => path));
  const enteredPaths = selectedNodesInPresentedOrder(
    [...selectedPaths].filter((path) => !retainedPathSet.has(path)),
    input.nodesByPath
  )
    .map((node) => node.projectRelativePath);
  const firstEnteredRank = (retained[0]?.[1] ?? input.nodesByPath.size + 1)
    - enteredPaths.length;
  if (firstEnteredRank >= 0) {
    return new Map([
      ...enteredPaths.map((path, index) => [path, firstEnteredRank + index] as const),
      ...retained
    ]);
  }

  const reorderedPaths = [
    ...enteredPaths,
    ...retained.map(([path]) => path)
  ];
  const firstRebasedRank = input.nodesByPath.size - reorderedPaths.length + 1;
  return new Map(reorderedPaths.map((path, index) => [path, firstRebasedRank + index]));
}

function selectedNodesInPresentedOrder(
  selectedPaths: Iterable<string>,
  nodesByPath: ReadonlyMap<string, ProjectedCanvasNode>
): ProjectedCanvasNode[] {
  return [...selectedPaths]
    .map((path) => nodesByPath.get(path))
    .filter((node): node is ProjectedCanvasNode => node !== undefined)
    .sort(comparePresentedNodeOrder);
}

function comparePresentedNodeOrder(left: ProjectedCanvasNode, right: ProjectedCanvasNode): number {
  return left.z - right.z || left.projectRelativePath.localeCompare(right.projectRelativePath);
}

function samePresentedNodeLayout(left: ProjectedCanvasNode, right: ProjectedCanvasNode): boolean {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height
    && left.z === right.z;
}

function samePresentedNodeGeometry(left: ProjectedCanvasNode, right: ProjectedCanvasNode): boolean {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}
