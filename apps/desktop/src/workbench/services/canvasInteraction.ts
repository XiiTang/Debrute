import type { CanvasMediaKind, CanvasSelection, CanvasSelectionItem, CanvasViewport } from '@axis/canvas-core';

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ResizeHandle = 'n' | 'e' | 's' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

const WHEEL_ZOOM_RATE = 0.006;
const MIN_RESIZE_SIZE = 48;

export function screenPointToCanvasPoint(viewport: CanvasViewport, point: CanvasPoint): CanvasPoint {
  return {
    x: (point.x - viewport.x) / viewport.zoom,
    y: (point.y - viewport.y) / viewport.zoom
  };
}

export function canvasSurfacePointToCanvasPoint(input: {
  viewport: CanvasViewport;
  surfaceRect: { left: number; top: number };
  point: CanvasPoint;
}): CanvasPoint {
  return screenPointToCanvasPoint(input.viewport, {
    x: input.point.x - input.surfaceRect.left,
    y: input.point.y - input.surfaceRect.top
  });
}

export function canvasViewportCenterPoint(input: {
  viewport: CanvasViewport;
  surfaceRect: { width: number; height: number };
}): CanvasPoint {
  return screenPointToCanvasPoint(input.viewport, {
    x: input.surfaceRect.width / 2,
    y: input.surfaceRect.height / 2
  });
}

export function canvasUpdateFromMovedSelection(
  selection: CanvasSelection | undefined,
  delta: { dx: number; dy: number },
  current: {
    nodes: Array<{ projectRelativePath: string; x: number; y: number; width: number; height: number; locked?: boolean }>;
  }
): {
  nodeLayouts: Array<{ projectRelativePath: string; x: number; y: number; width: number; height: number }>;
} {
  const items = selectionItems(selection);
  const nodeByPath = new Map(current.nodes.map((node) => [node.projectRelativePath, node]));
  return {
    nodeLayouts: items.flatMap((item) => {
      if (item.kind !== 'node') {
        return [];
      }
      const node = nodeByPath.get(item.projectRelativePath);
      return node && !node.locked
        ? [{ projectRelativePath: node.projectRelativePath, x: node.x + delta.dx, y: node.y + delta.dy, width: node.width, height: node.height }]
        : [];
    })
  };
}

export function getCanvasWheelIntent(event: {
  deltaX: number;
  deltaY: number;
  ctrlKey: boolean;
  metaKey: boolean;
}): { kind: 'pan'; deltaX: number; deltaY: number } | { kind: 'zoom'; deltaY: number } {
  if (event.ctrlKey || event.metaKey) {
    return { kind: 'zoom', deltaY: event.deltaY };
  }
  return {
    kind: 'pan',
    deltaX: -event.deltaX,
    deltaY: -event.deltaY
  };
}

const CANVAS_LOCAL_WHEEL_SELECTOR = '[data-canvas-local-wheel="true"]';
const CANVAS_FLOATING_BAR_LAYER_SELECTOR = '.floating-bar-layer';
const CANVAS_WORKBENCH_SHELL_SELECTOR = '.workbench-shell';

export function shouldCanvasHandleWheelTarget(target: EventTarget | null): boolean {
  return closestElement(target, CANVAS_LOCAL_WHEEL_SELECTOR) === null;
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

export function getWheelZoomScale(currentZoom: number, deltaY: number): number {
  return clamp(currentZoom * Math.exp(-deltaY * WHEEL_ZOOM_RATE), 0.03, 10);
}

export function getCanvasResizePreserveAspect(
  handle: ResizeHandle,
  event: Pick<MouseEvent | PointerEvent, 'shiftKey'>,
  mediaKind?: CanvasMediaKind
): boolean {
  if (handle.length !== 2) {
    return false;
  }
  return mediaKind === 'text' ? event.shiftKey : !event.shiftKey;
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

export function selectedNodeProjectRelativePaths(selection: CanvasSelection | undefined): string[] {
  return selectionItems(selection)
    .filter((item) => item.kind === 'node')
    .map((item) => item.projectRelativePath);
}

export function selectionItems(selection: CanvasSelection | undefined): CanvasSelectionItem[] {
  if (!selection) {
    return [];
  }
  return selection.kind === 'multi' ? selection.items : [selection];
}

export function isCanvasItemSelected(selection: CanvasSelection | undefined, item: CanvasSelectionItem): boolean {
  return selectionItems(selection).some((selected) => sameSelectionItem(selected, item));
}

function sameSelectionItem(a: CanvasSelectionItem, b: CanvasSelectionItem): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  return a.kind === 'node' && b.kind === 'node'
    ? a.projectRelativePath === b.projectRelativePath
    : a.kind === 'diagnostic' && b.kind === 'diagnostic' && a.id === b.id;
}

export function rectsIntersect(a: CanvasRect, b: CanvasRect): boolean {
  return a.x <= b.x + b.width
    && a.x + a.width >= b.x
    && a.y <= b.y + b.height
    && a.y + a.height >= b.y;
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

function containsTarget(container: EventTarget | null, target: EventTarget | null): boolean {
  const maybeContainer = container as { contains?: (target: EventTarget | null) => boolean } | null;
  return Boolean(maybeContainer && typeof maybeContainer.contains === 'function' && maybeContainer.contains(target));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
