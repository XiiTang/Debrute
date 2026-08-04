import type { CanvasProjection, ProjectedCanvasNode } from '@debrute/canvas-core';
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
  raisedNodeProjectRelativePaths?: readonly string[] | undefined;
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
}): CanvasScenePresentation {
  let projection = input.projection;
  let projectedNodesByPath = new Map<string, ProjectedCanvasNode>();
  let presentedNodesByPath = new Map<string, ProjectedCanvasNode>();
  let layoutByPath = new Map<string, CanvasLayoutOverride>();
  let raisedPaths: readonly string[] = [];
  let baseMaxZ = 0;
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
    raisedPaths = presentation.raisedNodeProjectRelativePaths ?? [];
    baseMaxZ = projection.nodes.reduce((maximum, node) => Math.max(maximum, node.z), 0);
    const transientZByPath = transientZByPathFor(raisedPaths, baseMaxZ);
    presentedNodesByPath = new Map(projection.nodes.map((node) => {
      const presented = presentedNodeFor(
        node,
        layoutByPath.get(node.projectRelativePath),
        transientZByPath.get(node.projectRelativePath)
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

  rebuild(input.projection, { layoutOverrides: [] });

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
      const nextRaisedPaths = presentation.raisedNodeProjectRelativePaths ?? [];
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
      const previousTransientZByPath = transientZByPathFor(raisedPaths, baseMaxZ);
      const nextTransientZByPath = transientZByPathFor(nextRaisedPaths, baseMaxZ);
      const stackCandidates = new Set([
        ...previousTransientZByPath.keys(),
        ...nextTransientZByPath.keys()
      ]);
      const stackDirtyPaths = [...stackCandidates].filter((path) => (
        previousTransientZByPath.get(path) !== nextTransientZByPath.get(path)
      ));
      const presentationDirtyPaths = new Set([
        ...geometryDirtyPaths,
        ...stackDirtyPaths
      ]);
      const nodeLayouts: CanvasPresentedNodeLayout[] = [];
      for (const path of presentationDirtyPaths) {
        const projected = projectedNodesByPath.get(path);
        if (!projected) {
          presentedNodesByPath.delete(path);
          nodeSpatialIndex.remove(path);
          continue;
        }
        const presented = presentedNodeFor(
          projected,
          nextLayoutByPath.get(path),
          nextTransientZByPath.get(path)
        );
        presentedNodesByPath.set(path, presented);
        if (geometryDirtyPaths.has(path)) {
          nodeSpatialIndex.upsert({ id: path, bounds: presented });
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
      raisedPaths = nextRaisedPaths;
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

function transientZByPathFor(paths: readonly string[], baseMaxZ: number): ReadonlyMap<string, number> {
  const ordered: string[] = [];
  for (const path of paths) {
    const previousIndex = ordered.indexOf(path);
    if (previousIndex >= 0) {
      ordered.splice(previousIndex, 1);
    }
    ordered.push(path);
  }
  return new Map(ordered.map((path, index) => [path, baseMaxZ + index + 1]));
}

function presentedNodeFor(
  node: ProjectedCanvasNode,
  layout: CanvasLayoutOverride | undefined,
  transientZ: number | undefined
): ProjectedCanvasNode {
  if (!layout && transientZ === undefined) {
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
    ...(transientZ === undefined ? {} : { z: transientZ })
  };
}
