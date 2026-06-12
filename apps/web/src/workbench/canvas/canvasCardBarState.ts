export function chooseInitialActiveCanvasId(input: {
  storedActiveCanvasId: string | undefined;
  canvasOrder: string[];
}): string | undefined {
  return input.storedActiveCanvasId && input.canvasOrder.includes(input.storedActiveCanvasId)
    ? input.storedActiveCanvasId
    : input.canvasOrder[0];
}

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
