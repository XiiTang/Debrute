import type { CanvasProjection, ProjectedCanvasNode } from '@debrute/canvas-core';
import { buildResizeGeometry } from '../services/canvasInteraction';
import type { CanvasRuntimeDragState } from './runtime/CanvasEditorRuntime';
import type { CanvasPoint } from './runtime/canvasGeometry';

export interface CanvasLayoutOverride {
  projectRelativePath: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasLocalLayoutDraft {
  canvasId: string;
  nodeLayouts: CanvasLayoutOverride[];
}

export function canvasLocalLayoutDraftFromMoveState(input: {
  canvasId: string;
  dragState: Extract<CanvasRuntimeDragState, { kind: 'move-node' }>;
  point: CanvasPoint;
}): CanvasLocalLayoutDraft {
  const delta = {
    x: input.point.x - input.dragState.start.x,
    y: input.point.y - input.dragState.start.y
  };
  return {
    canvasId: input.canvasId,
    nodeLayouts: input.dragState.origins.map((origin) => ({
      projectRelativePath: origin.projectRelativePath,
      x: origin.x + delta.x,
      y: origin.y + delta.y,
      width: origin.width,
      height: origin.height
    }))
  };
}

export function canvasLocalLayoutDraftFromResizeState(input: {
  canvasId: string;
  dragState: Extract<CanvasRuntimeDragState, { kind: 'resize-node' }>;
  point: CanvasPoint;
}): CanvasLocalLayoutDraft {
  const delta = {
    x: input.point.x - input.dragState.start.x,
    y: input.point.y - input.dragState.start.y
  };
  const next = buildResizeGeometry(
    input.dragState.handle,
    input.dragState.origin,
    delta,
    input.dragState.preserveAspect
  );
  return {
    canvasId: input.canvasId,
    nodeLayouts: [{
      projectRelativePath: input.dragState.node.projectRelativePath,
      x: next.x,
      y: next.y,
      width: next.width,
      height: next.height
    }]
  };
}

export function canvasLocalLayoutDraftFromDragState(input: {
  canvasId: string;
  dragState: CanvasRuntimeDragState;
  point: CanvasPoint;
}): CanvasLocalLayoutDraft {
  return input.dragState.kind === 'move-node'
    ? canvasLocalLayoutDraftFromMoveState({
        canvasId: input.canvasId,
        dragState: input.dragState,
        point: input.point
      })
    : canvasLocalLayoutDraftFromResizeState({
        canvasId: input.canvasId,
        dragState: input.dragState,
        point: input.point
      });
}

export function canvasLayoutOverridesForCanvas(input: {
  canvasId: string;
  active?: CanvasLocalLayoutDraft | undefined;
  pending?: CanvasLocalLayoutDraft | undefined;
}): CanvasLayoutOverride[] {
  const merged = new Map<string, CanvasLayoutOverride>();
  for (const draft of [input.pending, input.active]) {
    if (!draft || draft.canvasId !== input.canvasId) {
      continue;
    }
    for (const layout of draft.nodeLayouts) {
      merged.set(layout.projectRelativePath, layout);
    }
  }
  return [...merged.values()];
}

export function canvasNodesWithLayoutOverrides(input: {
  nodes: readonly ProjectedCanvasNode[];
  layoutOverrides: readonly CanvasLayoutOverride[];
}): ProjectedCanvasNode[] {
  if (input.layoutOverrides.length === 0) {
    return [...input.nodes];
  }
  const layoutByPath = new Map(input.layoutOverrides.map((layout) => [layout.projectRelativePath, layout]));
  return input.nodes.map((node) => {
    const layout = layoutByPath.get(node.projectRelativePath);
    return layout
      ? {
          ...node,
          x: layout.x,
          y: layout.y,
          width: layout.width,
          height: layout.height
        }
      : node;
  });
}

export function canvasLocalLayoutDraftMatchesProjection(
  draft: CanvasLocalLayoutDraft,
  projection: CanvasProjection
): boolean {
  if (draft.canvasId !== projection.canvasId) {
    return false;
  }
  const nodesByPath = new Map(projection.nodes.map((node) => [node.projectRelativePath, node]));
  return draft.nodeLayouts.every((layout) => {
    const node = nodesByPath.get(layout.projectRelativePath);
    return Boolean(node)
      && node!.x === layout.x
      && node!.y === layout.y
      && node!.width === layout.width
      && node!.height === layout.height;
  });
}
