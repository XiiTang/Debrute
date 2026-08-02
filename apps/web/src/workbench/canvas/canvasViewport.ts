import type { CanvasProjection, ProjectedCanvasNode } from '@debrute/canvas-core';
import type { CanvasCamera } from './runtime/canvasCamera.js';
import type { CanvasRect } from './runtime/canvasGeometry.js';
import { rectsIntersect } from './runtime/canvasGeometry.js';
import { visibleCanvasRectForCamera } from './runtime/canvasCoordinateSystem.js';

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

export interface CanvasViewportQueryResult {
  visibleRect: CanvasRect;
  visibleNodePaths: ReadonlySet<string>;
  visibleEdgeIds: ReadonlySet<string>;
}

export interface CanvasViewportQueryInput {
  nodes: readonly ProjectedCanvasNode[];
  edges: readonly CanvasEdgeSegment[];
  camera: CanvasCamera;
  surfaceSize: Partial<CanvasSize> | undefined;
}

export function canvasVisibleRect(input: {
  camera: CanvasCamera;
  surfaceSize: Partial<CanvasSize> | undefined;
}): CanvasRect {
  return visibleCanvasRectForCamera(input);
}

export function queryCanvasViewport(input: CanvasViewportQueryInput): CanvasViewportQueryResult {
  const visibleRect = canvasVisibleRect(input);
  const visibleNodePaths = new Set<string>();
  const visibleEdgeIds = new Set<string>();
  for (const node of input.nodes) {
    if (rectsIntersect(visibleRect, nodeRect(node))) {
      visibleNodePaths.add(node.projectRelativePath);
    }
  }
  for (const edge of input.edges) {
    if (edgeIntersectsRect(edge, visibleRect)) {
      visibleEdgeIds.add(edge.id);
    }
  }
  return {
    visibleRect,
    visibleNodePaths,
    visibleEdgeIds
  };
}

export function canvasEdgeSegmentsForProjectionEdges(input: {
  nodes: ProjectedCanvasNode[];
  edges: CanvasProjection['edges'];
}): CanvasEdgeSegment[] {
  return indexedCanvasEdgeSegmentsForProjectionEdges(input)
    .map(({ order: _order, ...edge }) => edge);
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

function rectViewBox(rect: CanvasRect): string {
  return `${rect.x} ${rect.y} ${rect.width} ${rect.height}`;
}
