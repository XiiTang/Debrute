import type { CanvasProjection } from '@debrute/canvas-core';
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
