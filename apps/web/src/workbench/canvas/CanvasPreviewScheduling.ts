export interface CanvasPreviewRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CanvasPreviewSpatialTask extends CanvasPreviewRect {
  readonly projectRelativePath: string;
}

export interface CanvasPreviewViewportPriority {
  readonly visibleRect: CanvasPreviewRect;
  readonly virtualRect: CanvasPreviewRect;
}

export function orderCanvasPreviewTasks<T extends CanvasPreviewSpatialTask>(
  tasks: readonly T[],
  viewport: CanvasPreviewViewportPriority
): T[] {
  return [...tasks].sort((left, right) => (
    canvasPreviewPriorityTier(left, viewport) - canvasPreviewPriorityTier(right, viewport)
      || left.y - right.y
      || left.x - right.x
      || left.projectRelativePath.localeCompare(right.projectRelativePath)
  ));
}

export function canvasPreviewPriorityTier(
  task: CanvasPreviewSpatialTask,
  viewport: CanvasPreviewViewportPriority
): 0 | 1 | 2 {
  if (rectsIntersect(task, viewport.visibleRect)) {
    return 0;
  }
  return rectsIntersect(task, viewport.virtualRect) ? 1 : 2;
}

function rectsIntersect(left: CanvasPreviewRect, right: CanvasPreviewRect): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}
