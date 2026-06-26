export interface WorkbenchWindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type WorkbenchViewportRect = WorkbenchWindowRect;

export const FLOATING_PANEL_DRAG_HIT_AREA_HEIGHT = 18;
export const FLOATING_PANEL_DRAG_HIT_AREA_CSS_PROPERTY = '--db-floating-panel-drag-hit-area-height';
export const FLOATING_PANEL_DRAG_HIT_AREA_CSS_VALUE = `${FLOATING_PANEL_DRAG_HIT_AREA_HEIGHT}px`;
export const FLOATING_TEXT_EDITOR_TITLEBAR_HEIGHT = 38;
export const FLOATING_TEXT_EDITOR_TITLEBAR_CSS_PROPERTY = '--db-floating-text-editor-titlebar-height';
export const FLOATING_TEXT_EDITOR_TITLEBAR_CSS_VALUE = `${FLOATING_TEXT_EDITOR_TITLEBAR_HEIGHT}px`;
export const FLOATING_PANEL_FRAME_INSET = 1;

export function readWorkbenchViewportRect(): WorkbenchViewportRect {
  if (!globalThis.window) {
    throw new Error('Workbench viewport requires a browser window.');
  }
  return {
    x: 0,
    y: 0,
    width: globalThis.window.innerWidth,
    height: globalThis.window.innerHeight
  };
}

export function constrainDragHitAreaVisible(
  rect: WorkbenchWindowRect,
  viewport: WorkbenchViewportRect,
  dragHitAreaHeight = FLOATING_PANEL_DRAG_HIT_AREA_HEIGHT,
  frameInset = FLOATING_PANEL_FRAME_INSET
): WorkbenchWindowRect {
  const visibleDragHitAreaLength = dragHitAreaHeight;
  return {
    ...rect,
    x: clamp(
      rect.x,
      viewport.x + visibleDragHitAreaLength - rect.width + frameInset,
      viewport.x + viewport.width - visibleDragHitAreaLength - frameInset
    ),
    y: clamp(
      rect.y,
      viewport.y - frameInset,
      viewport.y + viewport.height - dragHitAreaHeight - frameInset
    )
  };
}

export function constrainContainedRect(
  rect: WorkbenchWindowRect,
  viewport: WorkbenchViewportRect
): WorkbenchWindowRect {
  const width = Math.min(rect.width, Math.max(0, viewport.width));
  const height = Math.min(rect.height, Math.max(0, viewport.height));
  return {
    x: clamp(rect.x, viewport.x, viewport.x + viewport.width - width),
    y: clamp(rect.y, viewport.y, viewport.y + viewport.height - height),
    width,
    height
  };
}

export function sameWindowRect(left: WorkbenchWindowRect, right: WorkbenchWindowRect): boolean {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
