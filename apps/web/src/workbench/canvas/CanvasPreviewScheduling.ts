import type { CanvasRect } from './runtime/canvasGeometry.js';
import { rectsIntersect } from './runtime/canvasGeometry.js';

interface CanvasPreviewSpatialTask extends CanvasRect {
  readonly projectRelativePath: string;
}

export function orderCanvasPreviewTasks<T extends CanvasPreviewSpatialTask>(
  tasks: readonly T[],
  visibleRect: CanvasRect
): T[] {
  return [...tasks].sort((left, right) => (
    canvasPreviewPriorityTier(left, visibleRect) - canvasPreviewPriorityTier(right, visibleRect)
      || left.y - right.y
      || left.x - right.x
      || left.projectRelativePath.localeCompare(right.projectRelativePath)
  ));
}

export function canvasPreviewPriorityTier(
  task: CanvasPreviewSpatialTask,
  visibleRect: CanvasRect
): 0 | 1 {
  return rectsIntersect(task, visibleRect) ? 0 : 1;
}
