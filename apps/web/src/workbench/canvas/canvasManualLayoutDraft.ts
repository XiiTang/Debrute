import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import { buildResizeGeometry } from '../services/canvasInteraction.js';
import type { CanvasRuntimeLayoutInteraction } from './runtime/CanvasEditorRuntime.js';
import type { CanvasPoint } from './runtime/canvasGeometry.js';

export interface CanvasLayoutOverride {
  projectRelativePath: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasManualLayoutDraft {
  canvasId: string;
  interaction: 'move' | 'resize';
  nodeLayouts: CanvasLayoutOverride[];
}

export type CanvasNodeStackOrder = readonly string[];

export function canvasManualLayoutDraftFromMoveInteraction(input: {
  canvasId: string;
  interaction: Extract<CanvasRuntimeLayoutInteraction, { kind: 'move-node' }>;
  point: CanvasPoint;
}): CanvasManualLayoutDraft {
  const delta = {
    x: input.point.x - input.interaction.start.x,
    y: input.point.y - input.interaction.start.y
  };
  return {
    canvasId: input.canvasId,
    interaction: 'move',
    nodeLayouts: input.interaction.origins.map((origin) => ({
      projectRelativePath: origin.projectRelativePath,
      x: origin.x + delta.x,
      y: origin.y + delta.y,
      width: origin.width,
      height: origin.height
    }))
  };
}

export function canvasManualLayoutDraftFromResizeInteraction(input: {
  canvasId: string;
  interaction: Extract<CanvasRuntimeLayoutInteraction, { kind: 'resize-node' }>;
  point: CanvasPoint;
}): CanvasManualLayoutDraft {
  const delta = {
    x: input.point.x - input.interaction.start.x,
    y: input.point.y - input.interaction.start.y
  };
  const next = buildResizeGeometry(
    input.interaction.handle,
    input.interaction.origin,
    delta,
    input.interaction.preserveAspect
  );
  return {
    canvasId: input.canvasId,
    interaction: 'resize',
    nodeLayouts: [{
      projectRelativePath: input.interaction.node.projectRelativePath,
      x: next.x,
      y: next.y,
      width: next.width,
      height: next.height
    }]
  };
}

export function canvasManualLayoutDraftFromInteraction(input: {
  canvasId: string;
  interaction: CanvasRuntimeLayoutInteraction;
  point: CanvasPoint;
}): CanvasManualLayoutDraft {
  return input.interaction.kind === 'move-node'
    ? canvasManualLayoutDraftFromMoveInteraction({
        canvasId: input.canvasId,
        interaction: input.interaction,
        point: input.point
      })
    : canvasManualLayoutDraftFromResizeInteraction({
        canvasId: input.canvasId,
        interaction: input.interaction,
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

export function canvasNodeStackOrder(
  nodes: readonly Pick<ProjectedCanvasNode, 'projectRelativePath' | 'z'>[]
): string[] {
  return [...nodes]
    .sort(compareCanvasNodeStackOrder)
    .map((node) => node.projectRelativePath);
}

function compareCanvasNodeStackOrder(
  left: Pick<ProjectedCanvasNode, 'projectRelativePath' | 'z'>,
  right: Pick<ProjectedCanvasNode, 'projectRelativePath' | 'z'>
): number {
  if (left.z !== right.z) {
    return left.z < right.z ? -1 : 1;
  }
  return left.projectRelativePath < right.projectRelativePath
    ? -1
    : left.projectRelativePath > right.projectRelativePath ? 1 : 0;
}

export function canvasStackOrderWithRaisedGroup(
  order: readonly string[],
  raisedPaths: readonly string[]
): string[] {
  const raised = new Set(raisedPaths);
  return order
    .filter((path) => !raised.has(path))
    .concat(order.filter((path) => raised.has(path)));
}

export function canvasNodesWithStackOrder(input: {
  nodes: readonly ProjectedCanvasNode[];
  stackOrder: CanvasNodeStackOrder | undefined;
}): ProjectedCanvasNode[] {
  if (!input.stackOrder) {
    return [...input.nodes];
  }
  const zByPath = new Map(input.stackOrder.map((path, z) => [path, z]));
  return input.nodes.map((node) => {
    const z = zByPath.get(node.projectRelativePath);
    return z === undefined || z === node.z ? node : { ...node, z };
  });
}
