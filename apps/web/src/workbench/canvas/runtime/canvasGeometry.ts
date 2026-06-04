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

export interface CanvasSize {
  width: number;
  height: number;
}

export type ResizeHandle = 'n' | 'e' | 's' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

export function assertFiniteNumber(value: number, message: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(message);
  }
}

export function assertPositiveFiniteNumber(value: number, message: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(message);
  }
}

export function finiteNumber(value: number): boolean {
  return Number.isFinite(value);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function rectsIntersect(a: CanvasRect, b: CanvasRect): boolean {
  return a.x <= b.x + b.width
    && a.x + a.width >= b.x
    && a.y <= b.y + b.height
    && a.y + a.height >= b.y;
}

export function rectCenter(rect: CanvasRect): CanvasPoint {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2
  };
}

export function pointInRect(point: CanvasPoint, rect: CanvasRect): boolean {
  return point.x >= rect.x
    && point.x <= rect.x + rect.width
    && point.y >= rect.y
    && point.y <= rect.y + rect.height;
}

export function expandCanvasRect(rect: CanvasRect, amount: number): CanvasRect {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2
  };
}

export function canvasRectContainsRect(container: CanvasRect, rect: CanvasRect): boolean {
  return rect.x >= container.x
    && rect.y >= container.y
    && rect.x + rect.width <= container.x + container.width
    && rect.y + rect.height <= container.y + container.height;
}
