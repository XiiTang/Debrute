import type { CanvasFeedbackEntry } from '@debrute/canvas-core';
import type { CanvasCamera } from '../canvas/runtime/canvasCamera';

export interface FloatingBarRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasFeedbackBarTarget {
  projectRelativePath: string;
  nodeRect: FloatingBarRect;
  surfaceRect: FloatingBarRect;
  camera: CanvasCamera;
  entry: CanvasFeedbackEntry | undefined;
}

export function sameCanvasFeedbackBarTarget(
  left: CanvasFeedbackBarTarget | undefined,
  right: CanvasFeedbackBarTarget | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return left.projectRelativePath === right.projectRelativePath
    && sameFloatingBarRect(left.nodeRect, right.nodeRect)
    && sameFloatingBarRect(left.surfaceRect, right.surfaceRect)
    && left.camera.x === right.camera.x
    && left.camera.y === right.camera.y
    && left.camera.z === right.camera.z
    && sameCanvasFeedbackEntry(left.entry, right.entry);
}

export interface FloatingBarPlacement extends FloatingBarRect {
  placement: 'below' | 'above';
}

export const CANVAS_FEEDBACK_BAR_SIZE = {
  width: 398,
  height: 32
} as const;

export const CANVAS_MINIMAP_BUTTON_SIZE = {
  width: 28,
  height: 28
} as const;

export const CANVAS_MINIMAP_PANEL_SIZE = {
  width: 220,
  height: 150
} as const;

export type CanvasMinimapPanelPlacement = FloatingBarRect;

const FLOATING_BAR_GAP_PX = 1;
const VIEWPORT_PADDING_PX = 8;

export function canvasNodeToViewportRect(input: {
  nodeRect: FloatingBarRect;
  surfaceRect: FloatingBarRect;
  camera: CanvasCamera;
}): FloatingBarRect {
  return {
    x: input.surfaceRect.x + input.camera.x + input.nodeRect.x * input.camera.z,
    y: input.surfaceRect.y + input.camera.y + input.nodeRect.y * input.camera.z,
    width: input.nodeRect.width * input.camera.z,
    height: input.nodeRect.height * input.camera.z
  };
}

export function placeCanvasFeedbackBar(input: {
  nodeViewportRect: FloatingBarRect;
  viewportRect: FloatingBarRect;
  reservedRects: FloatingBarRect[];
}): FloatingBarPlacement | undefined {
  const centeredX = input.nodeViewportRect.x + input.nodeViewportRect.width / 2 - CANVAS_FEEDBACK_BAR_SIZE.width / 2;
  const clampedX = clamp(
    centeredX,
    input.viewportRect.x + VIEWPORT_PADDING_PX,
    input.viewportRect.x + input.viewportRect.width - CANVAS_FEEDBACK_BAR_SIZE.width - VIEWPORT_PADDING_PX
  );
  const candidates: FloatingBarPlacement[] = [{
    x: Math.round(clampedX),
    y: Math.round(input.nodeViewportRect.y + input.nodeViewportRect.height + FLOATING_BAR_GAP_PX),
    width: CANVAS_FEEDBACK_BAR_SIZE.width,
    height: CANVAS_FEEDBACK_BAR_SIZE.height,
    placement: 'below'
  }, {
    x: Math.round(clampedX),
    y: Math.round(input.nodeViewportRect.y - CANVAS_FEEDBACK_BAR_SIZE.height - FLOATING_BAR_GAP_PX),
    width: CANVAS_FEEDBACK_BAR_SIZE.width,
    height: CANVAS_FEEDBACK_BAR_SIZE.height,
    placement: 'above'
  }];

  return candidates.find((candidate) => (
    rectInside(candidate, input.viewportRect)
    && input.reservedRects.every((reserved) => !rectsIntersect(candidate, reserved))
  ));
}

export function canvasMinimapButtonRect(viewportRect: FloatingBarRect): FloatingBarRect {
  return {
    x: viewportRect.x + 18,
    y: viewportRect.y + viewportRect.height - 18 - CANVAS_MINIMAP_BUTTON_SIZE.height,
    width: CANVAS_MINIMAP_BUTTON_SIZE.width,
    height: CANVAS_MINIMAP_BUTTON_SIZE.height
  };
}

export function placeCanvasMinimapPanel(input: {
  buttonRect: FloatingBarRect;
  viewportRect: FloatingBarRect;
}): CanvasMinimapPanelPlacement {
  return {
    x: Math.round(clamp(
      input.buttonRect.x,
      input.viewportRect.x + VIEWPORT_PADDING_PX,
      input.viewportRect.x + input.viewportRect.width - CANVAS_MINIMAP_PANEL_SIZE.width - VIEWPORT_PADDING_PX
    )),
    y: Math.round(clamp(
      input.buttonRect.y - CANVAS_MINIMAP_PANEL_SIZE.height - 8,
      input.viewportRect.y + VIEWPORT_PADDING_PX,
      input.viewportRect.y + input.viewportRect.height - CANVAS_MINIMAP_PANEL_SIZE.height - VIEWPORT_PADDING_PX
    )),
    width: CANVAS_MINIMAP_PANEL_SIZE.width,
    height: CANVAS_MINIMAP_PANEL_SIZE.height
  };
}

function rectInside(rect: FloatingBarRect, bounds: FloatingBarRect): boolean {
  return rect.x >= bounds.x + VIEWPORT_PADDING_PX
    && rect.y >= bounds.y + VIEWPORT_PADDING_PX
    && rect.x + rect.width <= bounds.x + bounds.width - VIEWPORT_PADDING_PX
    && rect.y + rect.height <= bounds.y + bounds.height - VIEWPORT_PADDING_PX;
}

function rectsIntersect(a: FloatingBarRect, b: FloatingBarRect): boolean {
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sameFloatingBarRect(left: FloatingBarRect, right: FloatingBarRect): boolean {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

function sameCanvasFeedbackEntry(
  left: CanvasFeedbackEntry | undefined,
  right: CanvasFeedbackEntry | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.marks.length !== right.marks.length) {
    return false;
  }
  return left.projectRelativePath === right.projectRelativePath
    && left.note === right.note
    && left.updatedAt === right.updatedAt
    && left.marks.every((mark, index) => mark === right.marks[index]);
}
