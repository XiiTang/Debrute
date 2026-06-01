import type { CanvasProjection, CanvasSelection, CanvasViewport } from '@axis/canvas-core';
import {
  selectedNodeProjectRelativePaths,
  type CanvasPoint,
  type CanvasRect
} from '../services/canvasInteraction';
import { canvasVisibleRect } from './canvasVirtualization';

export interface CanvasSize {
  width: number;
  height: number;
}

export interface CanvasNavigationState {
  canvasId: string;
  surfaceSize: CanvasSize;
  viewport: CanvasViewport;
  requestViewportChange: (viewport: CanvasViewport) => void;
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
  viewport: CanvasViewport;
  surfaceSize: CanvasSize | undefined;
  minimapSize: CanvasSize;
  padding?: number;
}): CanvasMinimapModel | undefined {
  if (!validViewport(input.viewport) || !validSize(input.surfaceSize)) {
    return undefined;
  }
  const nodes = input.nodes.filter(isValidMinimapNode);
  if (nodes.length === 0) {
    return undefined;
  }

  const visibleRect = canvasVisibleRect({
    viewport: input.viewport,
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

export function canvasViewportForMinimapCenter(input: {
  center: CanvasPoint;
  viewport: CanvasViewport;
  surfaceSize: CanvasSize;
}): CanvasViewport {
  return {
    x: input.surfaceSize.width / 2 - input.center.x * input.viewport.zoom,
    y: input.surfaceSize.height / 2 - input.center.y * input.viewport.zoom,
    zoom: input.viewport.zoom
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
  viewport: CanvasViewport;
  surfaceSize: CanvasSize;
}): { dragState: CanvasMinimapDragState; viewport: CanvasViewport } {
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
    viewport: canvasViewportForMinimapCenter({
      center: {
        x: canvasPoint.x - pointerOffsetFromViewportCenter.x,
        y: canvasPoint.y - pointerOffsetFromViewportCenter.y
      },
      viewport: input.viewport,
      surfaceSize: input.surfaceSize
    })
  };
}

export function updateCanvasMinimapDrag(input: {
  dragState: CanvasMinimapDragState;
  minimapPoint: CanvasPoint;
  viewport: CanvasViewport;
  surfaceSize: CanvasSize;
}): CanvasViewport {
  const canvasPoint = minimapPointToCanvasPoint(input.minimapPoint, input.dragState.transform);
  return canvasViewportForMinimapCenter({
    center: {
      x: canvasPoint.x - input.dragState.pointerOffsetFromViewportCenter.x,
      y: canvasPoint.y - input.dragState.pointerOffsetFromViewportCenter.y
    },
    viewport: input.viewport,
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

function validViewport(viewport: CanvasViewport): boolean {
  return finiteNumber(viewport.x)
    && finiteNumber(viewport.y)
    && finiteNumber(viewport.zoom)
    && viewport.zoom > 0;
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

function rectCenter(rect: CanvasRect): CanvasPoint {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2
  };
}

function pointInRect(point: CanvasPoint, rect: CanvasRect): boolean {
  return point.x >= rect.x
    && point.x <= rect.x + rect.width
    && point.y >= rect.y
    && point.y <= rect.y + rect.height;
}

function finiteNumber(value: number): boolean {
  return Number.isFinite(value);
}
