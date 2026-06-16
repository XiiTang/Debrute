import type { CanvasProjection, ProjectedCanvasNode } from '@debrute/canvas-core';
import type { CanvasCamera } from './runtime/canvasCamera';
import { assertCanvasCamera } from './runtime/canvasCamera';
import type { CanvasRect } from './runtime/canvasGeometry';
import { canvasRectContainsRect, expandCanvasRect, rectsIntersect } from './runtime/canvasGeometry';
import { visibleCanvasRectForCamera } from './runtime/canvasCoordinateSystem';
import type { CanvasSelection } from './runtime/canvasSelection';
import { selectedNodeProjectRelativePaths } from './runtime/canvasSelection';

export const CANVAS_VIRTUAL_OVERSCAN_SCREEN_PX = 768;
export const CANVAS_VIRTUAL_REFRESH_MARGIN_SCREEN_PX = CANVAS_VIRTUAL_OVERSCAN_SCREEN_PX / 2;
export const CANVAS_VIRTUAL_MAX_STALE_AREA_RATIO = 4;
export { canvasRectContainsRect, expandCanvasRect } from './runtime/canvasGeometry';

const SPATIAL_INDEX_CELL_SIZE = 1024;
const SVG_EDGE_PADDING = 64;
const TREE_EDGE_TRUNK_MAX_GAP = 96;
const TREE_EDGE_TRUNK_FALLBACK_OFFSET = 48;

interface CanvasSize {
  width: number;
  height: number;
}

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasEdgeSegment {
  id: string;
  sourceProjectRelativePath: string;
  targetProjectRelativePath: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  points: CanvasPoint[];
  path: string;
  svgBounds: CanvasRect;
  svgViewBox: string;
}

export interface VirtualizedCanvasRenderState {
  visibleRect: CanvasRect;
  virtualRect: CanvasRect;
  nodes: ProjectedCanvasNode[];
  edges: CanvasEdgeSegment[];
}

export interface CanvasVirtualizationIndex {
  render: (input: CanvasVirtualizationQueryInput) => VirtualizedCanvasRenderState;
}

export interface CanvasVirtualizationQueryInput {
  camera: CanvasCamera;
  surfaceSize: Partial<CanvasSize> | undefined;
  selection: CanvasSelection | undefined;
  activeNodeProjectRelativePaths: Iterable<string>;
}

export function canvasVisibleRect(input: {
  camera: CanvasCamera;
  surfaceSize: Partial<CanvasSize> | undefined;
}): CanvasRect {
  return visibleCanvasRectForCamera(input);
}

export function canvasVirtualRenderRect(input: {
  camera: CanvasCamera;
  surfaceSize: Partial<CanvasSize> | undefined;
}): CanvasRect {
  assertCanvasCamera(input.camera);
  return expandCanvasRect(
    canvasVisibleRect(input),
    CANVAS_VIRTUAL_OVERSCAN_SCREEN_PX / input.camera.z
  );
}

export function createCanvasVirtualizationIndex(input: {
  nodes: ProjectedCanvasNode[];
  edges: CanvasProjection['edges'];
}): CanvasVirtualizationIndex {
  const imageNodes = input.nodes.filter((node) => node.nodeKind === 'file' && node.mediaKind === 'image');
  const nodeByPath = new Map(input.nodes.map((node) => [node.projectRelativePath, node]));
  const nodeIndex = new CanvasNodeSpatialIndex(input.nodes);
  const edgeSegments = indexedCanvasEdgeSegmentsForProjectionEdges({
    nodes: input.nodes,
    edges: input.edges
  });
  const edgeIndex = new CanvasEdgeSpatialIndex(edgeSegments);

  return {
    render: (query) => buildVirtualizedCanvasRenderStateFromIndex({
      ...query,
      nodeByPath,
      imageNodes,
      nodeIndex,
      edgeIndex
    })
  };
}

export function canvasEdgeSegmentsForProjectionEdges(input: {
  nodes: ProjectedCanvasNode[];
  edges: CanvasProjection['edges'];
}): CanvasEdgeSegment[] {
  return indexedCanvasEdgeSegmentsForProjectionEdges(input)
    .map(({ order: _order, ...edge }) => edge);
}

export function buildVirtualizedCanvasRenderState(input: {
  nodes: ProjectedCanvasNode[];
  edges: CanvasProjection['edges'];
  camera: CanvasCamera;
  surfaceSize: Partial<CanvasSize> | undefined;
  selection: CanvasSelection | undefined;
  activeNodeProjectRelativePaths: Iterable<string>;
}): VirtualizedCanvasRenderState {
  return createCanvasVirtualizationIndex({
    nodes: input.nodes,
    edges: input.edges
  }).render({
    camera: input.camera,
    surfaceSize: input.surfaceSize,
    selection: input.selection,
    activeNodeProjectRelativePaths: input.activeNodeProjectRelativePaths
  });
}

function buildVirtualizedCanvasRenderStateFromIndex(input: CanvasVirtualizationQueryInput & {
  nodeByPath: Map<string, ProjectedCanvasNode>;
  imageNodes: readonly ProjectedCanvasNode[];
  nodeIndex: CanvasNodeSpatialIndex;
  edgeIndex: CanvasEdgeSpatialIndex;
}): VirtualizedCanvasRenderState {
  const visibleRect = canvasVisibleRect(input);
  const virtualRect = canvasVirtualRenderRect(input);
  const selectedPaths = selectedNodeProjectRelativePaths(input.selection);
  const activePaths = [...input.activeNodeProjectRelativePaths];
  const nodes = uniqueNodes([
    ...input.nodeIndex.query(virtualRect),
    ...input.imageNodes,
    ...selectedPaths.flatMap((path) => input.nodeByPath.get(path) ?? []),
    ...activePaths.flatMap((path) => input.nodeByPath.get(path) ?? [])
  ]);
  const edges = input.edgeIndex.query(virtualRect);

  return {
    visibleRect,
    virtualRect,
    nodes,
    edges
  };
}

function indexedCanvasEdgeSegmentsForProjectionEdges(input: {
  nodes: ProjectedCanvasNode[];
  edges: CanvasProjection['edges'];
}): IndexedCanvasEdgeSegment[] {
  const nodeByPath = new Map(input.nodes.map((node) => [node.projectRelativePath, node]));
  const resolvedEdges = input.edges.flatMap((edge, order) => {
    const resolved = resolveEdgeNodes(edge, nodeByPath, order);
    return resolved ? [resolved] : [];
  });
  return routedEdges(resolvedEdges);
}

export function shouldRefreshVirtualizedRenderState(input: {
  currentVirtualRect: CanvasRect | undefined;
  camera: CanvasCamera;
  surfaceSize: Partial<CanvasSize> | undefined;
  force?: boolean;
}): boolean {
  if (input.force || !input.currentVirtualRect) {
    return true;
  }
  assertCanvasCamera(input.camera);
  const visibleRect = canvasVisibleRect(input);
  const refreshRect = expandCanvasRect(
    visibleRect,
    CANVAS_VIRTUAL_REFRESH_MARGIN_SCREEN_PX / input.camera.z
  );
  if (!canvasRectContainsRect(input.currentVirtualRect, refreshRect)) {
    return true;
  }
  const nextVirtualRect = canvasVirtualRenderRect(input);
  return rectArea(input.currentVirtualRect) > rectArea(nextVirtualRect) * CANVAS_VIRTUAL_MAX_STALE_AREA_RATIO;
}

export function nodeRect(node: Pick<ProjectedCanvasNode, 'x' | 'y' | 'width' | 'height'>): CanvasRect {
  return {
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height
  };
}

export function segmentIntersectsRect(
  segment: Pick<CanvasEdgeSegment, 'x1' | 'y1' | 'x2' | 'y2'>,
  rect: CanvasRect
): boolean {
  const start = { x: segment.x1, y: segment.y1 };
  const end = { x: segment.x2, y: segment.y2 };
  if (pointInRect(start, rect) || pointInRect(end, rect)) {
    return true;
  }
  const topLeft = { x: rect.x, y: rect.y };
  const topRight = { x: rect.x + rect.width, y: rect.y };
  const bottomRight = { x: rect.x + rect.width, y: rect.y + rect.height };
  const bottomLeft = { x: rect.x, y: rect.y + rect.height };
  return lineSegmentsIntersect(start, end, topLeft, topRight)
    || lineSegmentsIntersect(start, end, topRight, bottomRight)
    || lineSegmentsIntersect(start, end, bottomRight, bottomLeft)
    || lineSegmentsIntersect(start, end, bottomLeft, topLeft);
}

function uniqueNodes(nodes: ProjectedCanvasNode[]): ProjectedCanvasNode[] {
  const seen = new Set<string>();
  const result: ProjectedCanvasNode[] = [];
  for (const node of nodes) {
    if (seen.has(node.projectRelativePath)) {
      continue;
    }
    seen.add(node.projectRelativePath);
    result.push(node);
  }
  return result;
}

function rectArea(rect: CanvasRect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

class CanvasNodeSpatialIndex {
  private readonly cells = new Map<string, ProjectedCanvasNode[]>();

  constructor(nodes: ProjectedCanvasNode[]) {
    for (const node of nodes) {
      const range = cellRangeForRect(nodeRect(node));
      for (let cellX = range.minX; cellX <= range.maxX; cellX += 1) {
        for (let cellY = range.minY; cellY <= range.maxY; cellY += 1) {
          const key = cellKey(cellX, cellY);
          const cell = this.cells.get(key);
          if (cell) {
            cell.push(node);
          } else {
            this.cells.set(key, [node]);
          }
        }
      }
    }
  }

  query(rect: CanvasRect): ProjectedCanvasNode[] {
    const range = cellRangeForRect(rect);
    const seen = new Set<string>();
    const result: ProjectedCanvasNode[] = [];
    for (let cellX = range.minX; cellX <= range.maxX; cellX += 1) {
      for (let cellY = range.minY; cellY <= range.maxY; cellY += 1) {
        for (const node of this.cells.get(cellKey(cellX, cellY)) ?? []) {
          if (!seen.has(node.projectRelativePath) && rectsIntersect(rect, nodeRect(node))) {
            seen.add(node.projectRelativePath);
            result.push(node);
          }
        }
      }
    }
    return result;
  }
}

interface IndexedCanvasEdgeSegment extends CanvasEdgeSegment {
  order: number;
}

interface ResolvedCanvasEdge {
  id: string;
  sourceProjectRelativePath: string;
  targetProjectRelativePath: string;
  source: ProjectedCanvasNode;
  target: ProjectedCanvasNode;
  order: number;
}

class CanvasEdgeSpatialIndex {
  private readonly cells = new Map<string, IndexedCanvasEdgeSegment[]>();

  constructor(edges: IndexedCanvasEdgeSegment[]) {
    for (const edge of edges) {
      const range = cellRangeForRect(edgeBoundingRect(edge));
      for (let cellX = range.minX; cellX <= range.maxX; cellX += 1) {
        for (let cellY = range.minY; cellY <= range.maxY; cellY += 1) {
          const key = cellKey(cellX, cellY);
          const cell = this.cells.get(key);
          if (cell) {
            cell.push(edge);
          } else {
            this.cells.set(key, [edge]);
          }
        }
      }
    }
  }

  query(rect: CanvasRect): CanvasEdgeSegment[] {
    const range = cellRangeForRect(rect);
    const seen = new Set<string>();
    const result: IndexedCanvasEdgeSegment[] = [];
    for (let cellX = range.minX; cellX <= range.maxX; cellX += 1) {
      for (let cellY = range.minY; cellY <= range.maxY; cellY += 1) {
        for (const edge of this.cells.get(cellKey(cellX, cellY)) ?? []) {
          if (!seen.has(edge.id) && edgeIntersectsRect(edge, rect)) {
            seen.add(edge.id);
            result.push(edge);
          }
        }
      }
    }
    return result
      .sort((left, right) => left.order - right.order)
      .map(({ order: _order, ...edge }) => edge);
  }
}

function resolveEdgeNodes(
  edge: CanvasProjection['edges'][number],
  nodeByPath: Map<string, ProjectedCanvasNode>,
  order: number
): ResolvedCanvasEdge | undefined {
  const source = nodeByPath.get(edge.sourceProjectRelativePath);
  const target = nodeByPath.get(edge.targetProjectRelativePath);
  if (!source || !target) {
    return undefined;
  }
  return {
    id: edge.id,
    sourceProjectRelativePath: edge.sourceProjectRelativePath,
    targetProjectRelativePath: edge.targetProjectRelativePath,
    source,
    target,
    order
  };
}

function routedEdges(edges: ResolvedCanvasEdge[]): IndexedCanvasEdgeSegment[] {
  const edgesBySource = new Map<string, ResolvedCanvasEdge[]>();
  for (const edge of edges) {
    const sourceEdges = edgesBySource.get(edge.sourceProjectRelativePath);
    if (sourceEdges) {
      sourceEdges.push(edge);
    } else {
      edgesBySource.set(edge.sourceProjectRelativePath, [edge]);
    }
  }

  const trunkXBySource = new Map<string, number>();
  for (const [sourcePath, sourceEdges] of edgesBySource) {
    trunkXBySource.set(sourcePath, trunkXForSourceEdges(sourceEdges));
  }

  return edges.map((edge) => edgeRouteFromNodes(edge, trunkXBySource.get(edge.sourceProjectRelativePath)!));
}

function trunkXForSourceEdges(edges: ResolvedCanvasEdge[]): number {
  const first = edges[0]!;
  const sourceRight = first.source.x + first.source.width;
  const nearestTargetLeft = Math.min(...edges.map((edge) => edge.target.x));
  if (nearestTargetLeft > sourceRight) {
    return sourceRight + Math.min((nearestTargetLeft - sourceRight) / 2, TREE_EDGE_TRUNK_MAX_GAP);
  }
  return sourceRight + TREE_EDGE_TRUNK_FALLBACK_OFFSET;
}

function edgeRouteFromNodes(edge: ResolvedCanvasEdge, trunkX: number): IndexedCanvasEdgeSegment {
  const sourceAnchor = rightEdgeMidpoint(nodeRect(edge.source));
  const targetAnchor = leftEdgeMidpoint(nodeRect(edge.target));
  const points = [
    sourceAnchor,
    { x: trunkX, y: sourceAnchor.y },
    { x: trunkX, y: targetAnchor.y },
    targetAnchor
  ];
  const svgBounds = svgBoundsForPoints(points);
  return {
    id: edge.id,
    sourceProjectRelativePath: edge.sourceProjectRelativePath,
    targetProjectRelativePath: edge.targetProjectRelativePath,
    x1: sourceAnchor.x,
    y1: sourceAnchor.y,
    x2: targetAnchor.x,
    y2: targetAnchor.y,
    points,
    path: svgPathFromPoints(points),
    svgBounds,
    svgViewBox: rectViewBox(svgBounds),
    order: edge.order
  };
}

function edgeBoundingRect(edge: Pick<CanvasEdgeSegment, 'points'>): CanvasRect {
  const first = edge.points[0] ?? { x: 0, y: 0 };
  let minX = first.x;
  let minY = first.y;
  let maxX = first.x;
  let maxY = first.y;
  for (const point of edge.points.slice(1)) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  };
}

function edgeIntersectsRect(edge: Pick<CanvasEdgeSegment, 'points'>, rect: CanvasRect): boolean {
  for (let index = 1; index < edge.points.length; index += 1) {
    const start = edge.points[index - 1]!;
    const end = edge.points[index]!;
    if (segmentIntersectsRect({ x1: start.x, y1: start.y, x2: end.x, y2: end.y }, rect)) {
      return true;
    }
  }
  return false;
}

function svgBoundsForPoints(points: CanvasPoint[]): CanvasRect {
  const firstPoint = points[0];
  if (!firstPoint) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  let minX = firstPoint.x;
  let minY = firstPoint.y;
  let maxX = firstPoint.x;
  let maxY = firstPoint.y;
  for (const point of points.slice(1)) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return {
    x: minX - SVG_EDGE_PADDING,
    y: minY - SVG_EDGE_PADDING,
    width: Math.max(1, maxX - minX + SVG_EDGE_PADDING * 2),
    height: Math.max(1, maxY - minY + SVG_EDGE_PADDING * 2)
  };
}

function rightEdgeMidpoint(rect: CanvasRect): CanvasPoint {
  return {
    x: rect.x + rect.width,
    y: rect.y + rect.height / 2
  };
}

function leftEdgeMidpoint(rect: CanvasRect): CanvasPoint {
  return {
    x: rect.x,
    y: rect.y + rect.height / 2
  };
}

function svgPathFromPoints(points: CanvasPoint[]): string {
  const [first, ...rest] = points;
  if (!first) {
    return '';
  }
  return [`M ${first.x} ${first.y}`, ...rest.map((point) => `L ${point.x} ${point.y}`)].join(' ');
}

function pointInRect(point: CanvasPoint, rect: CanvasRect): boolean {
  return point.x >= rect.x
    && point.x <= rect.x + rect.width
    && point.y >= rect.y
    && point.y <= rect.y + rect.height;
}

function lineSegmentsIntersect(a1: CanvasPoint, a2: CanvasPoint, b1: CanvasPoint, b2: CanvasPoint): boolean {
  const d1 = direction(b1, b2, a1);
  const d2 = direction(b1, b2, a2);
  const d3 = direction(a1, a2, b1);
  const d4 = direction(a1, a2, b2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return d1 === 0 && pointOnSegment(a1, b1, a2)
    || d2 === 0 && pointOnSegment(a1, b2, a2)
    || d3 === 0 && pointOnSegment(b1, a1, b2)
    || d4 === 0 && pointOnSegment(b1, a2, b2);
}

function direction(a: CanvasPoint, b: CanvasPoint, c: CanvasPoint): number {
  return (c.x - a.x) * (b.y - a.y) - (b.x - a.x) * (c.y - a.y);
}

function pointOnSegment(a: CanvasPoint, b: CanvasPoint, c: CanvasPoint): boolean {
  return Math.min(a.x, c.x) <= b.x && b.x <= Math.max(a.x, c.x)
    && Math.min(a.y, c.y) <= b.y && b.y <= Math.max(a.y, c.y);
}

function cellRangeForRect(rect: CanvasRect): { minX: number; maxX: number; minY: number; maxY: number } {
  return {
    minX: Math.floor(rect.x / SPATIAL_INDEX_CELL_SIZE),
    maxX: Math.floor((rect.x + rect.width) / SPATIAL_INDEX_CELL_SIZE),
    minY: Math.floor(rect.y / SPATIAL_INDEX_CELL_SIZE),
    maxY: Math.floor((rect.y + rect.height) / SPATIAL_INDEX_CELL_SIZE)
  };
}

function cellKey(x: number, y: number): string {
  return `${x}:${y}`;
}

function rectViewBox(rect: CanvasRect): string {
  return `${rect.x} ${rect.y} ${rect.width} ${rect.height}`;
}
