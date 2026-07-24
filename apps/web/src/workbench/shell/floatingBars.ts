import {
  CANVAS_FEEDBACK_MARKS,
  type CanvasFeedbackDocument,
  type CanvasFeedbackEntry,
  type CanvasFeedbackGeometry,
  type CanvasFeedbackItem
} from '@debrute/canvas-core';
import type { CanvasCamera } from '../canvas/runtime/canvasCamera';
import { WORKBENCH_FLOATING_DOCK_EDGE_INSET } from './workbenchLayers';

export interface FloatingBarRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CanvasFeedbackLocalToolset = 'none' | 'image' | 'video';

export interface CanvasFeedbackBarTarget {
  projectRelativePath: string;
  nodeRect: FloatingBarRect;
  surfaceRect: FloatingBarRect;
  camera: CanvasCamera;
  entry: CanvasFeedbackEntry | undefined;
  localToolset: CanvasFeedbackLocalToolset;
  canStartVideoMomentFeedback: boolean;
  startVideoMomentFeedback?: ((mode: 'comment' | 'pin' | 'rect') => void) | undefined;
  seekToMoment?: ((seconds: number) => void) | undefined;
}

export interface CanvasLocalFeedbackDraft {
  projectRelativePath: string;
  kind: 'comment' | 'pin' | 'region';
  scope: 'file' | 'moment';
  geometry?: CanvasFeedbackGeometry | undefined;
  momentTimeSeconds?: number | undefined;
  feedbackBarTarget: CanvasFeedbackBarTarget;
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
    && left.localToolset === right.localToolset
    && left.canStartVideoMomentFeedback === right.canStartVideoMomentFeedback
    && sameCanvasFeedbackEntry(left.entry, right.entry);
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
const CANVAS_CARD_BAR_GAP_PX = 4;

export const CANVAS_RESET_LAYOUT_BUTTON_SIZE = {
  left: CANVAS_LOWER_LEFT_CONTROL_INSET.left + CANVAS_MINIMAP_BUTTON_SIZE.width + CANVAS_RESET_LAYOUT_GAP_PX,
  bottom: CANVAS_LOWER_LEFT_CONTROL_INSET.bottom,
  width: 28,
  height: 28
} as const;

export const CANVAS_CARD_BAR_SIZE = {
  left: CANVAS_RESET_LAYOUT_BUTTON_SIZE.left + CANVAS_RESET_LAYOUT_BUTTON_SIZE.width + CANVAS_CARD_BAR_GAP_PX,
  bottom: CANVAS_LOWER_LEFT_CONTROL_INSET.bottom,
  height: 28,
  maxWidth: 720,
  maxViewportWidthRatio: 0.58
} as const;

export const CANVAS_MINIMAP_PANEL_SIZE = {
  width: 220,
  height: 150
} as const;

const FLOATING_BAR_GAP_PX = 3;
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

export function feedbackBarPlacementForCanvasTarget(input: {
  target: Pick<CanvasFeedbackBarTarget, 'nodeRect' | 'surfaceRect' | 'localToolset'>;
  camera: CanvasCamera;
  viewportRect: FloatingBarRect;
  reservedRects: readonly FloatingBarRect[];
}): FloatingBarPlacement | undefined {
  return placeCanvasFeedbackBar({
    nodeViewportRect: canvasNodeToViewportRect({
      nodeRect: input.target.nodeRect,
      surfaceRect: input.target.surfaceRect,
      camera: input.camera
    }),
    viewportRect: input.viewportRect,
    reservedRects: [...input.reservedRects],
    barSize: canvasFeedbackBarSizeForTarget({
      localToolset: input.target.localToolset
    })
  });
}

export function placeCanvasFeedbackBar(input: {
  nodeViewportRect: FloatingBarRect;
  viewportRect: FloatingBarRect;
  reservedRects: FloatingBarRect[];
  barSize: Pick<FloatingBarRect, 'width' | 'height'>;
}): FloatingBarPlacement | undefined {
  const centeredX = input.nodeViewportRect.x + input.nodeViewportRect.width / 2 - input.barSize.width / 2;
  const clampedX = clamp(
    centeredX,
    input.viewportRect.x + VIEWPORT_PADDING_PX,
    input.viewportRect.x + input.viewportRect.width - input.barSize.width - VIEWPORT_PADDING_PX
  );
  const candidates: FloatingBarPlacement[] = [{
    x: Math.round(clampedX),
    y: Math.round(input.nodeViewportRect.y + input.nodeViewportRect.height + FLOATING_BAR_GAP_PX),
    width: input.barSize.width,
    height: input.barSize.height,
    placement: 'below'
  }, {
    x: Math.round(clampedX),
    y: Math.round(input.nodeViewportRect.y - input.barSize.height - FLOATING_BAR_GAP_PX),
    width: input.barSize.width,
    height: input.barSize.height,
    placement: 'above'
  }];

  return candidates.find((candidate) => (
    rectInside(candidate, input.viewportRect)
    && input.reservedRects.every((reserved) => !rectsIntersect(candidate, reserved))
  ));
}

export function canvasFeedbackBarTargetWithCurrentEntry(
  target: CanvasFeedbackBarTarget,
  canvasFeedback: CanvasFeedbackDocument | undefined
): CanvasFeedbackBarTarget {
  const entry = canvasFeedback?.entries[target.projectRelativePath];
  return target.entry === entry ? target : { ...target, entry };
}

export function canvasFeedbackBarSizeForTarget(input: {
  localToolset: CanvasFeedbackLocalToolset;
  extraActionCount?: number | undefined;
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
    height: CANVAS_FEEDBACK_BAR_LAYOUT.twoRowHeight
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

export function canvasCardBarRect(viewportRect: FloatingBarRect): FloatingBarRect {
  const left = viewportRect.x + CANVAS_CARD_BAR_SIZE.left;
  return {
    x: left,
    y: viewportRect.y + viewportRect.height - CANVAS_CARD_BAR_SIZE.bottom - CANVAS_CARD_BAR_SIZE.height,
    width: Math.round(Math.min(
      CANVAS_CARD_BAR_SIZE.maxWidth,
      viewportRect.width * CANVAS_CARD_BAR_SIZE.maxViewportWidthRatio,
      Math.max(0, viewportRect.x + viewportRect.width - left - VIEWPORT_PADDING_PX)
    )),
    height: CANVAS_CARD_BAR_SIZE.height
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

function sameCanvasFeedbackEntry(
  left: CanvasFeedbackEntry | undefined,
  right: CanvasFeedbackEntry | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!left
    || !right
    || left.marks.length !== right.marks.length
    || left.items.length !== right.items.length) {
    return false;
  }
  return left.projectRelativePath === right.projectRelativePath
    && left.nextMomentLabel === right.nextMomentLabel
    && left.nextSpatialLabel === right.nextSpatialLabel
    && left.updatedAt === right.updatedAt
    && left.marks.every((mark, index) => mark === right.marks[index])
    && left.items.every((item, index) => sameCanvasFeedbackItem(item, right.items[index]));
}

function sameCanvasFeedbackItem(left: CanvasFeedbackItem, right: CanvasFeedbackItem | undefined): boolean {
  if (!right
    || left.id !== right.id
    || left.kind !== right.kind
    || left.scope !== right.scope
    || left.comment !== right.comment
    || left.createdAt !== right.createdAt
    || left.updatedAt !== right.updatedAt) {
    return false;
  }
  if (left.scope === 'moment') {
    if (right.scope !== 'moment'
      || left.moment.label !== right.moment.label
      || left.moment.currentTimeSeconds !== right.moment.currentTimeSeconds) {
      return false;
    }
  }
  if ((left.kind === 'pin' || left.kind === 'region') && (right.kind === 'pin' || right.kind === 'region')) {
    return left.label === right.label && sameCanvasFeedbackGeometry(left.geometry, right.geometry);
  }
  return left.kind === 'comment' && right.kind === 'comment';
}

function sameCanvasFeedbackGeometry(left: CanvasFeedbackGeometry, right: CanvasFeedbackGeometry): boolean {
  if (left.type !== right.type) {
    return false;
  }
  if (left.type === 'point' && right.type === 'point') {
    return left.x === right.x && left.y === right.y;
  }
  if (left.type !== 'point' && right.type !== 'point') {
    return left.x === right.x
      && left.y === right.y
      && left.width === right.width
      && left.height === right.height;
  }
  return false;
}
