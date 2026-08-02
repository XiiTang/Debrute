import type { CanvasRect } from './runtime/canvasGeometry.js';

interface CanvasPreviewSpatialTask extends CanvasRect {
  readonly projectRelativePath: string;
}

export function orderCanvasPreviewTasks<T extends CanvasPreviewSpatialTask>(
  tasks: readonly T[],
  visibleRect: CanvasRect
): T[] {
  return tasks
    .map((task) => ({ task, distanceSquared: canvasPreviewDistanceSquared(task, visibleRect) }))
    .sort((left, right) => (
      left.distanceSquared - right.distanceSquared
        || compareCanvasPreviewPaths(left.task.projectRelativePath, right.task.projectRelativePath)
    ))
    .map(({ task }) => task);
}

export function compareCanvasPreviewPaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canvasPreviewDistanceSquared(
  task: CanvasPreviewSpatialTask,
  visibleRect: CanvasRect
): number {
  const centerX = visibleRect.x + visibleRect.width / 2;
  const centerY = visibleRect.y + visibleRect.height / 2;
  const dx = Math.max(task.x - centerX, 0, centerX - (task.x + task.width));
  const dy = Math.max(task.y - centerY, 0, centerY - (task.y + task.height));
  return dx * dx + dy * dy;
}
