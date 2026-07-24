import type { ProjectedCanvasNode } from '@debrute/canvas-core';
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

export interface CanvasManualLayoutDraft {
  canvasId: string;
  nodeLayouts: CanvasLayoutOverride[];
}

export function canvasManualLayoutDraftFromMoveState(input: {
  canvasId: string;
  dragState: Extract<CanvasRuntimeDragState, { kind: 'move-node' }>;
  point: CanvasPoint;
}): CanvasManualLayoutDraft {
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

export function canvasManualLayoutDraftFromResizeState(input: {
  canvasId: string;
  dragState: Extract<CanvasRuntimeDragState, { kind: 'resize-node' }>;
  point: CanvasPoint;
}): CanvasManualLayoutDraft {
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

export function canvasManualLayoutDraftFromDragState(input: {
  canvasId: string;
  dragState: CanvasRuntimeDragState;
  point: CanvasPoint;
}): CanvasManualLayoutDraft {
  return input.dragState.kind === 'move-node'
    ? canvasManualLayoutDraftFromMoveState({
        canvasId: input.canvasId,
        dragState: input.dragState,
        point: input.point
      })
    : canvasManualLayoutDraftFromResizeState({
        canvasId: input.canvasId,
        dragState: input.dragState,
        point: input.point
      });
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
