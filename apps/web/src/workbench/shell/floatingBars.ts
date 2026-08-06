import {
  CANVAS_FEEDBACK_MARKS,
  type CanvasFeedbackGeometry
} from '@debrute/app-protocol';
import type { CanvasCamera } from '../canvas/runtime/canvasCamera';
import { WORKBENCH_FLOATING_DOCK_EDGE_INSET } from './workbenchLayers';

export interface FloatingBarRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CanvasFeedbackLocalToolset = 'none' | 'image' | 'video';

interface CanvasFeedbackBarTargetBase {
  anchorRect: FloatingBarRect;
  surfaceRect: FloatingBarRect;
  camera: CanvasCamera;
}

export interface CanvasFeedbackNodeBarTarget extends CanvasFeedbackBarTargetBase {
  kind: 'node';
  projectRelativePath: string;
  localToolset: CanvasFeedbackLocalToolset;
  canStartVideoMomentFeedback: boolean;
  startVideoMomentFeedback?: ((mode: 'comment' | 'pin' | 'rect') => void) | undefined;
  seekToMoment?: ((seconds: number) => void) | undefined;
}

export interface CanvasFeedbackSelectionBarTarget extends CanvasFeedbackBarTargetBase {
  kind: 'selection';
  projectRelativePaths: string[];
}

export type CanvasFeedbackBarTarget = CanvasFeedbackNodeBarTarget | CanvasFeedbackSelectionBarTarget;

export interface CanvasLocalFeedbackDraft {
  projectRelativePath: string;
  kind: 'comment' | 'pin' | 'region';
  scope: 'node' | 'moment';
  geometry?: CanvasFeedbackGeometry | undefined;
  momentTimeSeconds?: number | undefined;
  feedbackBarTarget: CanvasFeedbackNodeBarTarget;
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
  if (left.kind !== right.kind
    || !sameFloatingBarRect(left.anchorRect, right.anchorRect)
    || !sameFloatingBarRect(left.surfaceRect, right.surfaceRect)
    || left.camera.x !== right.camera.x
    || left.camera.y !== right.camera.y
    || left.camera.z !== right.camera.z) {
    return false;
  }
  if (left.kind === 'selection' && right.kind === 'selection') {
    return left.projectRelativePaths.length === right.projectRelativePaths.length
      && left.projectRelativePaths.every((path, index) => path === right.projectRelativePaths[index]);
  }
  return left.kind === 'node'
    && right.kind === 'node'
    && left.projectRelativePath === right.projectRelativePath
    && left.localToolset === right.localToolset
    && left.canStartVideoMomentFeedback === right.canStartVideoMomentFeedback;
}

export interface FloatingBarPlacement extends FloatingBarRect {
  placement: 'below' | 'above';
}

export const CANVAS_FEEDBACK_BAR_LAYOUT = {
  containerBorderWidth: 1,
  containerPadding: 3,
  primaryRowHeight: 30,
  itemRowHeight: 84,
  rowGap: 2,
  actionButtonSize: 28,
  actionGap: 4,
  localActionGap: 2,
  localModeMarginLeft: 2,
  localModePaddingLeft: 6,
  localModeBorderWidth: 1,
  twoRowHeight: 124
} as const;

export const CANVAS_MINIMAP_BUTTON_SIZE = {
  width: 42,
  height: 28
} as const;

const CANVAS_LOWER_LEFT_CONTROL_INSET = {
  left: WORKBENCH_FLOATING_DOCK_EDGE_INSET.horizontal,
  bottom: 14
} as const;
const CANVAS_RESET_LAYOUT_GAP_PX = 4;

export const CANVAS_RESET_LAYOUT_BUTTON_SIZE = {
  left: CANVAS_LOWER_LEFT_CONTROL_INSET.left + CANVAS_MINIMAP_BUTTON_SIZE.width + CANVAS_RESET_LAYOUT_GAP_PX,
  bottom: CANVAS_LOWER_LEFT_CONTROL_INSET.bottom,
  width: 28,
  height: 28
} as const;

export const CANVAS_MINIMAP_PANEL_SIZE = {
  width: 220,
  height: 150
} as const;

const FLOATING_BAR_GAP_PX = 3;
const VIEWPORT_PADDING_PX = 8;

export function canvasAnchorToViewportRect(input: {
  anchorRect: FloatingBarRect;
  surfaceRect: FloatingBarRect;
  camera: CanvasCamera;
}): FloatingBarRect {
  return {
    x: input.surfaceRect.x + input.camera.x + input.anchorRect.x * input.camera.z,
    y: input.surfaceRect.y + input.camera.y + input.anchorRect.y * input.camera.z,
    width: input.anchorRect.width * input.camera.z,
    height: input.anchorRect.height * input.camera.z
  };
}

export function feedbackBarPlacementForCanvasTarget(input: {
  target: CanvasFeedbackBarTarget;
  camera: CanvasCamera;
  viewportRect: FloatingBarRect;
  reservedRects: readonly FloatingBarRect[];
}): FloatingBarPlacement | undefined {
  return placeCanvasFeedbackBar({
    anchorViewportRect: canvasAnchorToViewportRect({
      anchorRect: input.target.anchorRect,
      surfaceRect: input.target.surfaceRect,
      camera: input.camera
    }),
    viewportRect: input.viewportRect,
    reservedRects: [...input.reservedRects],
    barSize: canvasFeedbackBarSizeForTarget(input.target.kind === 'selection'
      ? { localToolset: 'none', marksOnly: true }
      : { localToolset: input.target.localToolset })
  });
}

export function placeCanvasFeedbackBar(input: {
  anchorViewportRect: FloatingBarRect;
  viewportRect: FloatingBarRect;
  reservedRects: FloatingBarRect[];
  barSize: Pick<FloatingBarRect, 'width' | 'height'>;
}): FloatingBarPlacement | undefined {
  const centeredX = input.anchorViewportRect.x + input.anchorViewportRect.width / 2 - input.barSize.width / 2;
  const clampedX = clamp(
    centeredX,
    input.viewportRect.x + VIEWPORT_PADDING_PX,
    input.viewportRect.x + input.viewportRect.width - input.barSize.width - VIEWPORT_PADDING_PX
  );
  const candidates: FloatingBarPlacement[] = [{
    x: Math.round(clampedX),
    y: Math.round(input.anchorViewportRect.y + input.anchorViewportRect.height + FLOATING_BAR_GAP_PX),
    width: input.barSize.width,
    height: input.barSize.height,
    placement: 'below'
  }, {
    x: Math.round(clampedX),
    y: Math.round(input.anchorViewportRect.y - input.barSize.height - FLOATING_BAR_GAP_PX),
    width: input.barSize.width,
    height: input.barSize.height,
    placement: 'above'
  }];

  return candidates.find((candidate) => (
    rectInside(candidate, input.viewportRect)
    && input.reservedRects.every((reserved) => !rectsIntersect(candidate, reserved))
  ));
}

export function canvasFeedbackBarSizeForTarget(input: {
  localToolset: CanvasFeedbackLocalToolset;
  extraActionCount?: number | undefined;
  marksOnly?: boolean | undefined;
}): Pick<FloatingBarRect, 'width' | 'height'> {
  const baseActionCount = CANVAS_FEEDBACK_MARKS.length + Math.max(0, input.extraActionCount ?? 0);
  const localActionCount = canvasFeedbackLocalActionCount(input.localToolset);
  const actionWidth = feedbackActionGroupWidth(baseActionCount, CANVAS_FEEDBACK_BAR_LAYOUT.actionGap)
    + (localActionCount > 0
      ? CANVAS_FEEDBACK_BAR_LAYOUT.actionGap
        + CANVAS_FEEDBACK_BAR_LAYOUT.localModeMarginLeft
        + CANVAS_FEEDBACK_BAR_LAYOUT.localModeBorderWidth
        + CANVAS_FEEDBACK_BAR_LAYOUT.localModePaddingLeft
        + feedbackActionGroupWidth(localActionCount, CANVAS_FEEDBACK_BAR_LAYOUT.localActionGap)
      : 0);
  return {
    width: actionWidth
      + CANVAS_FEEDBACK_BAR_LAYOUT.containerPadding * 2
      + CANVAS_FEEDBACK_BAR_LAYOUT.containerBorderWidth * 2,
    height: input.marksOnly
      ? CANVAS_FEEDBACK_BAR_LAYOUT.primaryRowHeight
        + CANVAS_FEEDBACK_BAR_LAYOUT.containerPadding * 2
        + CANVAS_FEEDBACK_BAR_LAYOUT.containerBorderWidth * 2
      : CANVAS_FEEDBACK_BAR_LAYOUT.twoRowHeight
  };
}

function canvasFeedbackLocalActionCount(localToolset: CanvasFeedbackLocalToolset): number {
  if (localToolset === 'image') {
    return 2;
  }
  if (localToolset === 'video') {
    return 3;
  }
  return 0;
}

function feedbackActionGroupWidth(count: number, gap: number): number {
  if (count <= 0) {
    return 0;
  }
  return count * CANVAS_FEEDBACK_BAR_LAYOUT.actionButtonSize
    + (count - 1) * gap;
}

export function canvasFeedbackLocalToolsetForMediaKind(mediaKind: string | undefined): CanvasFeedbackLocalToolset {
  return mediaKind === 'image'
    ? 'image'
    : mediaKind === 'video'
      ? 'video'
      : 'none';
}

export function canvasMinimapButtonRect(viewportRect: FloatingBarRect): FloatingBarRect {
  return {
    x: viewportRect.x + CANVAS_LOWER_LEFT_CONTROL_INSET.left,
    y: viewportRect.y + viewportRect.height - CANVAS_LOWER_LEFT_CONTROL_INSET.bottom - CANVAS_MINIMAP_BUTTON_SIZE.height,
    width: CANVAS_MINIMAP_BUTTON_SIZE.width,
    height: CANVAS_MINIMAP_BUTTON_SIZE.height
  };
}

export function canvasResetLayoutButtonRect(viewportRect: FloatingBarRect): FloatingBarRect {
  return {
    x: viewportRect.x + CANVAS_RESET_LAYOUT_BUTTON_SIZE.left,
    y: viewportRect.y + viewportRect.height - CANVAS_RESET_LAYOUT_BUTTON_SIZE.bottom - CANVAS_RESET_LAYOUT_BUTTON_SIZE.height,
    width: CANVAS_RESET_LAYOUT_BUTTON_SIZE.width,
    height: CANVAS_RESET_LAYOUT_BUTTON_SIZE.height
  };
}

export function placeCanvasMinimapPanel(input: {
  buttonRect: FloatingBarRect;
  viewportRect: FloatingBarRect;
}): FloatingBarRect {
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
