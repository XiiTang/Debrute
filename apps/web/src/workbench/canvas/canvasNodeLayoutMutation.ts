import {
  raiseCanvasSelection,
  type CanvasProjectedRect
} from './CanvasScene.js';

interface CanvasNodeLayoutMutationPatch {
  nodeStateUpdates?: Array<{
    projectRelativePath: string;
    manualLayout: { x: number; y: number; width: number; height: number };
  }>;
  occlusionOrder?: string[];
}

export function canvasNodeLayoutMutationPatch(input: {
  currentNodes: readonly CanvasProjectedRect[];
  nextNodes: readonly CanvasProjectedRect[];
  currentOcclusionOrder: readonly string[];
  selectedProjectRelativePaths: readonly string[];
  nodeLayouts: readonly CanvasProjectedRect[];
}): CanvasNodeLayoutMutationPatch | undefined {
  const currentNodesByPath = new Map(
    input.currentNodes.map((node) => [node.projectRelativePath, node])
  );
  const nextNodePaths = new Set(input.nextNodes.map((node) => node.projectRelativePath));
  const changedLayouts = input.nodeLayouts.filter((layout) => {
    const current = currentNodesByPath.get(layout.projectRelativePath);
    return current !== undefined
      && nextNodePaths.has(layout.projectRelativePath)
      && !sameGeometry(current, layout);
  });
  const nextOcclusionOrder = raiseCanvasSelection(
    input.currentOcclusionOrder,
    input.nextNodes,
    input.selectedProjectRelativePaths
  );
  const occlusionChanged = !sameOrder(input.currentOcclusionOrder, nextOcclusionOrder);
  if (changedLayouts.length === 0 && !occlusionChanged) {
    return undefined;
  }
  return {
    ...(changedLayouts.length > 0 ? {
      nodeStateUpdates: changedLayouts.map((layout) => ({
        projectRelativePath: layout.projectRelativePath,
        manualLayout: {
          x: layout.x,
          y: layout.y,
          width: layout.width,
          height: layout.height
        }
      }))
    } : {}),
    ...(occlusionChanged ? { occlusionOrder: nextOcclusionOrder } : {})
  };
}

function sameGeometry(left: CanvasProjectedRect, right: CanvasProjectedRect): boolean {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
