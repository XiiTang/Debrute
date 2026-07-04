import type { CanvasMediaKind, CanvasNodeKind } from '@debrute/canvas-core';
import type { CanvasPoint, CanvasRect, ResizeHandle } from '../canvas/runtime/canvasGeometry';
import { rectsIntersect } from '../canvas/runtime/canvasGeometry';

export type { CanvasPoint, CanvasRect, ResizeHandle } from '../canvas/runtime/canvasGeometry';
export type { CanvasSelection, CanvasSelectionItem } from '../canvas/runtime/canvasSelection';
export {
  isCanvasItemSelected,
  selectedNodeProjectRelativePaths,
  selectionItems
} from '../canvas/runtime/canvasSelection';
export { rectsIntersect } from '../canvas/runtime/canvasGeometry';

export interface NormalizedCanvasWheelDelta {
  x: number;
  y: number;
  z: number;
}

export interface CanvasResizeTarget {
  nodeKind: CanvasNodeKind;
  mediaKind?: CanvasMediaKind;
}

const MAX_WHEEL_ZOOM_STEP = 10;
const MIN_RESIZE_SIZE = 48;

export function normalizeCanvasWheelDelta(
  event: {
    deltaX: number;
    deltaY: number;
    ctrlKey: boolean;
    metaKey: boolean;
    deltaZ?: number;
    shiftKey?: boolean;
  },
  platform = currentPlatform()
): NormalizedCanvasWheelDelta {
  let deltaX = event.deltaX;
  let deltaY = event.deltaY;
  let deltaZ = 0;

  if (event.ctrlKey || event.metaKey) {
    const zoomDelta = deltaY !== 0 ? deltaY : event.deltaZ ?? 0;
    const capped = Math.abs(zoomDelta) > MAX_WHEEL_ZOOM_STEP
      ? MAX_WHEEL_ZOOM_STEP * Math.sign(zoomDelta)
      : zoomDelta;
    deltaX = 0;
    deltaY = 0;
    deltaZ = capped === 0 ? 0 : -capped / 100;
  } else if (event.shiftKey && platform !== 'darwin') {
    deltaX = deltaY;
    deltaY = 0;
  }

  return {
    x: invertWheelDelta(deltaX),
    y: invertWheelDelta(deltaY),
    z: deltaZ
  };
}

const CANVAS_LOCAL_WHEEL_SELECTOR = '[data-canvas-local-wheel="true"]';
const CANVAS_FOCUS_LOCAL_WHEEL_SELECTOR = '[data-canvas-local-wheel="focus"]';
const CANVAS_FLOATING_BAR_LAYER_SELECTOR = '.floating-bar-layer';
const CANVAS_WORKBENCH_SHELL_SELECTOR = '.workbench-shell';

export function shouldCanvasHandleWheelTarget(target: EventTarget | null): boolean {
  if (closestElement(target, CANVAS_LOCAL_WHEEL_SELECTOR) !== null) {
    return false;
  }
  const focusLocalWheel = closestElement(target, CANVAS_FOCUS_LOCAL_WHEEL_SELECTOR);
  return focusLocalWheel === null || !elementMatches(focusLocalWheel, ':focus-within');
}

export function shouldCanvasHandleGlobalWheelTarget(
  target: EventTarget | null,
  surfaceElement: EventTarget | null
): boolean {
  if (!shouldCanvasHandleWheelTarget(target)) {
    return false;
  }
  if (containsTarget(surfaceElement, target)) {
    return true;
  }
  if (closestElement(target, CANVAS_FLOATING_BAR_LAYER_SELECTOR) === null) {
    return false;
  }
  const surfaceShell = closestElement(surfaceElement, CANVAS_WORKBENCH_SHELL_SELECTOR);
  const targetShell = closestElement(target, CANVAS_WORKBENCH_SHELL_SELECTOR);
  return surfaceShell !== null && targetShell === surfaceShell;
}

export function getCanvasResizePreserveAspect(
  handle: ResizeHandle,
  event: Pick<MouseEvent | PointerEvent, 'shiftKey'>,
  target: CanvasResizeTarget
): boolean {
  if (handle.length !== 2) {
    return false;
  }
  return target.nodeKind === 'directory' || target.mediaKind === 'text' || target.mediaKind === 'unknown'
    ? event.shiftKey
    : !event.shiftKey;
}

export function buildResizeGeometry(
  handle: ResizeHandle,
  origin: CanvasRect,
  delta: { x: number; y: number },
  preserveAspect: boolean
): CanvasRect {
  const { signX, signY } = resizeAnchor(handle);
  let width = signX === 0 ? origin.width : Math.max(MIN_RESIZE_SIZE, origin.width + delta.x * signX);
  let height = signY === 0 ? origin.height : Math.max(MIN_RESIZE_SIZE, origin.height + delta.y * signY);

  if (preserveAspect && signX !== 0 && signY !== 0) {
    const diagonalX = origin.width * signX;
    const diagonalY = origin.height * signY;
    const scaleDelta =
      (delta.x * diagonalX + delta.y * diagonalY) /
      (origin.width * origin.width + origin.height * origin.height);
    const minScale = Math.max(MIN_RESIZE_SIZE / origin.width, MIN_RESIZE_SIZE / origin.height);
    const scale = Math.max(minScale, 1 + scaleDelta);
    width = origin.width * scale;
    height = origin.height * scale;
  }

  return {
    x: signX >= 0 ? origin.x : origin.x + origin.width - width,
    y: signY >= 0 ? origin.y : origin.y + origin.height - height,
    width,
    height
  };
}

export function isAdditiveCanvasSelectionModifier(input: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): boolean {
  return input.shiftKey || input.metaKey || input.ctrlKey;
}

function resizeAnchor(handle: ResizeHandle): {
  signX: 1 | 0 | -1;
  signY: 1 | 0 | -1;
} {
  return {
    signX: handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0,
    signY: handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0
  };
}

function closestElement(target: EventTarget | null, selector: string): unknown | null {
  const maybeElement = target as { closest?: (selector: string) => unknown } | null;
  if (!maybeElement || typeof maybeElement.closest !== 'function') {
    return null;
  }
  return maybeElement.closest(selector) ?? null;
}

function elementMatches(element: unknown, selector: string): boolean {
  const maybeElement = element as { matches?: (selector: string) => boolean };
  return typeof maybeElement.matches === 'function' && maybeElement.matches(selector);
}

function containsTarget(container: EventTarget | null, target: EventTarget | null): boolean {
  const maybeContainer = container as { contains?: (target: EventTarget | null) => boolean } | null;
  return Boolean(maybeContainer && typeof maybeContainer.contains === 'function' && maybeContainer.contains(target));
}

function currentPlatform(): string {
  return globalThis.navigator?.platform?.toLowerCase().includes('mac') ? 'darwin' : 'linux';
}

function invertWheelDelta(value: number): number {
  return value === 0 ? 0 : -value;
}
