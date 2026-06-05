import type { CanvasProjection } from '@debrute/canvas-core';
import type { CanvasCamera } from './runtime/canvasCamera';
import type { CanvasPoint, CanvasRect } from './runtime/canvasGeometry';
import { finiteNumber, pointInRect, rectCenter } from './runtime/canvasGeometry';
import type { CanvasSelection } from './runtime/canvasSelection';
import { selectedNodeProjectRelativePaths } from './runtime/canvasSelection';
import { canvasVisibleRect } from './canvasVirtualization';

export interface CanvasSize {
  width: number;
  height: number;
}

export interface CanvasMinimapTransform {
  contentBounds: CanvasRect;
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface CanvasMinimapNodeRect {
  projectRelativePath: string;
  rect: CanvasRect;
  selected: boolean;
}

export interface CanvasMinimapModel {
  visibleRect: CanvasRect;
  viewportRect: CanvasRect;
  transform: CanvasMinimapTransform;
  nodeRects: CanvasMinimapNodeRect[];
}

export interface CanvasMinimapDragState {
  pointerId: number;
  transform: CanvasMinimapTransform;
  pointerOffsetFromViewportCenter: CanvasPoint;
}

const DEFAULT_MINIMAP_PADDING = 10;

export function buildCanvasMinimapModel(input: {
  nodes: CanvasProjection['nodes'];
  selection: CanvasSelection | undefined;
  camera: CanvasCamera;
  surfaceSize: CanvasSize | undefined;
  minimapSize: CanvasSize;
  padding?: number;
}): CanvasMinimapModel | undefined {
  if (!validCamera(input.camera) || !validSize(input.surfaceSize)) {
    return undefined;
  }
  const nodes = input.nodes.filter(isValidMinimapNode);
  if (nodes.length === 0) {
    return undefined;
  }

  const visibleRect = canvasVisibleRect({
    camera: input.camera,
    surfaceSize: input.surfaceSize
  });
  const contentBounds = unionCanvasRects(visibleRect, nodes.map((node) => nodeRect(node)));

  const transform = fitCanvasBoundsToMinimap({
    contentBounds,
    minimapSize: input.minimapSize,
    padding: input.padding ?? DEFAULT_MINIMAP_PADDING
  });
  const selectedPaths = new Set(selectedNodeProjectRelativePaths(input.selection));

  return {
    visibleRect,
    viewportRect: canvasRectToMinimapRect(visibleRect, transform),
    transform,
    nodeRects: nodes.map((node) => ({
      projectRelativePath: node.projectRelativePath,
      rect: canvasRectToMinimapRect(nodeRect(node), transform),
      selected: selectedPaths.has(node.projectRelativePath)
    }))
  };
}

export function hasValidMinimapNodes(nodes: CanvasProjection['nodes']): boolean {
  return nodes.some(isValidMinimapNode);
}

export function canvasPointToMinimapPoint(point: CanvasPoint, transform: CanvasMinimapTransform): CanvasPoint {
  return {
    x: transform.offsetX + (point.x - transform.contentBounds.x) * transform.scale,
    y: transform.offsetY + (point.y - transform.contentBounds.y) * transform.scale
  };
}

export function minimapPointToCanvasPoint(point: CanvasPoint, transform: CanvasMinimapTransform): CanvasPoint {
  return {
    x: transform.contentBounds.x + (point.x - transform.offsetX) / transform.scale,
    y: transform.contentBounds.y + (point.y - transform.offsetY) / transform.scale
  };
}

export function canvasCameraForMinimapCenter(input: {
  center: CanvasPoint;
  camera: CanvasCamera;
  surfaceSize: CanvasSize;
}): CanvasCamera {
  return {
    x: input.surfaceSize.width / 2 - input.center.x * input.camera.z,
    y: input.surfaceSize.height / 2 - input.center.y * input.camera.z,
    z: input.camera.z
  };
}

export function clientPointToMinimapPoint(input: {
  clientPoint: CanvasPoint;
  minimapRect: CanvasRect;
  minimapSize: CanvasSize;
}): CanvasPoint {
  return {
    x: ((input.clientPoint.x - input.minimapRect.x) / input.minimapRect.width) * input.minimapSize.width,
    y: ((input.clientPoint.y - input.minimapRect.y) / input.minimapRect.height) * input.minimapSize.height
  };
}

export function beginCanvasMinimapDrag(input: {
  pointerId: number;
  minimapPoint: CanvasPoint;
  model: CanvasMinimapModel;
  camera: CanvasCamera;
  surfaceSize: CanvasSize;
}): { dragState: CanvasMinimapDragState; camera: CanvasCamera } {
  const canvasPoint = minimapPointToCanvasPoint(input.minimapPoint, input.model.transform);
  const visibleCenter = rectCenter(input.model.visibleRect);
  const pointerOffsetFromViewportCenter = pointInRect(input.minimapPoint, input.model.viewportRect)
    ? { x: canvasPoint.x - visibleCenter.x, y: canvasPoint.y - visibleCenter.y }
    : { x: 0, y: 0 };
  return {
    dragState: {
      pointerId: input.pointerId,
      transform: input.model.transform,
      pointerOffsetFromViewportCenter
    },
    camera: canvasCameraForMinimapCenter({
      center: {
        x: canvasPoint.x - pointerOffsetFromViewportCenter.x,
        y: canvasPoint.y - pointerOffsetFromViewportCenter.y
      },
      camera: input.camera,
      surfaceSize: input.surfaceSize
    })
  };
}

export function updateCanvasMinimapDrag(input: {
  dragState: CanvasMinimapDragState;
  minimapPoint: CanvasPoint;
  camera: CanvasCamera;
  surfaceSize: CanvasSize;
}): CanvasCamera {
  const canvasPoint = minimapPointToCanvasPoint(input.minimapPoint, input.dragState.transform);
  return canvasCameraForMinimapCenter({
    center: {
      x: canvasPoint.x - input.dragState.pointerOffsetFromViewportCenter.x,
      y: canvasPoint.y - input.dragState.pointerOffsetFromViewportCenter.y
    },
    camera: input.camera,
    surfaceSize: input.surfaceSize
  });
}

function fitCanvasBoundsToMinimap(input: {
  contentBounds: CanvasRect;
  minimapSize: CanvasSize;
  padding: number;
}): CanvasMinimapTransform {
  const availableWidth = Math.max(1, input.minimapSize.width - input.padding * 2);
  const availableHeight = Math.max(1, input.minimapSize.height - input.padding * 2);
  const scale = Math.min(
    availableWidth / input.contentBounds.width,
    availableHeight / input.contentBounds.height
  );
  const width = input.contentBounds.width * scale;
  const height = input.contentBounds.height * scale;
  const offsetX = (input.minimapSize.width - width) / 2;
  const offsetY = (input.minimapSize.height - height) / 2;
  return {
    contentBounds: input.contentBounds,
    scale,
    offsetX,
    offsetY
  };
}

function canvasRectToMinimapRect(rect: CanvasRect, transform: CanvasMinimapTransform): CanvasRect {
  const point = canvasPointToMinimapPoint({ x: rect.x, y: rect.y }, transform);
  return {
    x: point.x,
    y: point.y,
    width: rect.width * transform.scale,
    height: rect.height * transform.scale
  };
}

function isValidMinimapNode(node: CanvasProjection['nodes'][number]): boolean {
  return node.visible !== false
    && finiteNumber(node.x)
    && finiteNumber(node.y)
    && finiteNumber(node.width)
    && finiteNumber(node.height)
    && node.width > 0
    && node.height > 0;
}

function validCamera(camera: CanvasCamera): boolean {
  return finiteNumber(camera.x)
    && finiteNumber(camera.y)
    && finiteNumber(camera.z)
    && camera.z > 0;
}

function validSize(size: CanvasSize | undefined): size is CanvasSize {
  return Boolean(
    size
    && finiteNumber(size.width)
    && finiteNumber(size.height)
    && size.width > 0
    && size.height > 0
  );
}

function nodeRect(node: Pick<CanvasProjection['nodes'][number], 'x' | 'y' | 'width' | 'height'>): CanvasRect {
  return {
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height
  };
}

function unionCanvasRects(first: CanvasRect, rest: CanvasRect[]): CanvasRect {
  let minX = first.x;
  let minY = first.y;
  let maxX = first.x + first.width;
  let maxY = first.y + first.height;
  for (const rect of rest) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  };
}
