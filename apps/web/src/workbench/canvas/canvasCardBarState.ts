export function reorderCanvasIds(canvasOrder: string[], draggedCanvasId: string, targetCanvasId: string): string[] {
  if (draggedCanvasId === targetCanvasId) {
    return canvasOrder;
  }
  const next = canvasOrder.filter((id) => id !== draggedCanvasId);
  const targetIndex = next.indexOf(targetCanvasId);
  if (targetIndex < 0) {
    return canvasOrder;
  }
  next.splice(targetIndex + 1, 0, draggedCanvasId);
  return next;
}
