import type { CanvasProjection, ProjectedCanvasNode } from '@debrute/canvas-core';
import type { CanvasRect } from './runtime/canvasGeometry.js';

const TREE_EDGE_TRUNK_MAX_GAP = 96;
const TREE_EDGE_TRUNK_OVERLAP_OFFSET = 48;

interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasEdgeRoutingSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface CanvasEdgeRoutingGroup {
  id: string;
  sourceProjectRelativePath: string;
  edgeIds: string[];
  targetProjectRelativePaths: string[];
  path: string;
  bounds: CanvasRect;
  segments: CanvasEdgeRoutingSegment[];
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

export function canvasEdgeRoutingGroupsForProjection(
  projection: Pick<CanvasProjection, 'nodes' | 'edges'>
): CanvasEdgeRoutingGroup[] {
  const nodesByPath = new Map(projection.nodes.map((node) => [node.projectRelativePath, node]));
  const edgesBySource = new Map<string, ResolvedCanvasEdge[]>();
  projection.edges.forEach((edge, order) => {
    const source = nodesByPath.get(edge.sourceProjectRelativePath);
    const target = nodesByPath.get(edge.targetProjectRelativePath);
    if (!source || !target) {
      return;
    }
    const resolved: ResolvedCanvasEdge = {
      id: edge.id,
      sourceProjectRelativePath: edge.sourceProjectRelativePath,
      targetProjectRelativePath: edge.targetProjectRelativePath,
      source,
      target,
      order
    };
    const sourceEdges = edgesBySource.get(edge.sourceProjectRelativePath);
    if (sourceEdges) {
      sourceEdges.push(resolved);
    } else {
      edgesBySource.set(edge.sourceProjectRelativePath, [resolved]);
    }
  });
  return [...edgesBySource.values()].map(canvasEdgeRoutingGroupForResolvedEdges);
}

export function canvasEdgeRoutingGroupForSource(input: {
  sourceProjectRelativePath: string;
  nodesByPath: ReadonlyMap<string, ProjectedCanvasNode>;
  edges: CanvasProjection['edges'];
  orderByEdgeId: ReadonlyMap<string, number>;
}): CanvasEdgeRoutingGroup | undefined {
  const source = input.nodesByPath.get(input.sourceProjectRelativePath);
  if (!source) {
    return undefined;
  }
  const edges = input.edges.flatMap((edge) => {
    if (edge.sourceProjectRelativePath !== input.sourceProjectRelativePath) {
      return [];
    }
    const target = input.nodesByPath.get(edge.targetProjectRelativePath);
    if (!target) {
      return [];
    }
    return [{
      id: edge.id,
      sourceProjectRelativePath: edge.sourceProjectRelativePath,
      targetProjectRelativePath: edge.targetProjectRelativePath,
      source,
      target,
      order: input.orderByEdgeId.get(edge.id) ?? Number.MAX_SAFE_INTEGER
    }];
  }).sort((left, right) => left.order - right.order);
  return edges.length > 0 ? canvasEdgeRoutingGroupForResolvedEdges(edges) : undefined;
}

export function canvasEdgeRoutingGroupIntersectsRect(
  group: Pick<CanvasEdgeRoutingGroup, 'segments'>,
  rect: CanvasRect
): boolean {
  return group.segments.some((segment) => segmentIntersectsRect(segment, rect));
}

function canvasEdgeRoutingGroupForResolvedEdges(edges: ResolvedCanvasEdge[]): CanvasEdgeRoutingGroup {
  const first = edges[0]!;
  const sourceAnchor = rightEdgeMidpoint(first.source);
  const targetAnchors = edges.map((edge) => leftEdgeMidpoint(edge.target));
  const trunkX = trunkXForSourceEdges(edges);
  const trunkMinY = Math.min(sourceAnchor.y, ...targetAnchors.map((point) => point.y));
  const trunkMaxY = Math.max(sourceAnchor.y, ...targetAnchors.map((point) => point.y));
  const segments: CanvasEdgeRoutingSegment[] = [
    segment(sourceAnchor, { x: trunkX, y: sourceAnchor.y }),
    segment({ x: trunkX, y: trunkMinY }, { x: trunkX, y: trunkMaxY }),
    ...targetAnchors.map((target) => segment({ x: trunkX, y: target.y }, target))
  ];
  return {
    id: first.sourceProjectRelativePath,
    sourceProjectRelativePath: first.sourceProjectRelativePath,
    edgeIds: edges.map((edge) => edge.id),
    targetProjectRelativePaths: edges.map((edge) => edge.targetProjectRelativePath),
    path: segments.map(svgPathForSegment).join(' '),
    bounds: boundsForSegments(segments),
    segments,
    order: Math.min(...edges.map((edge) => edge.order))
  };
}

function trunkXForSourceEdges(edges: ResolvedCanvasEdge[]): number {
  const first = edges[0]!;
  const sourceRight = first.source.x + first.source.width;
  const nearestTargetLeft = Math.min(...edges.map((edge) => edge.target.x));
  if (nearestTargetLeft > sourceRight) {
    return sourceRight + Math.min((nearestTargetLeft - sourceRight) / 2, TREE_EDGE_TRUNK_MAX_GAP);
  }
  return sourceRight + TREE_EDGE_TRUNK_OVERLAP_OFFSET;
}

function rightEdgeMidpoint(node: ProjectedCanvasNode): CanvasPoint {
  return { x: node.x + node.width, y: node.y + node.height / 2 };
}

function leftEdgeMidpoint(node: ProjectedCanvasNode): CanvasPoint {
  return { x: node.x, y: node.y + node.height / 2 };
}

function segment(start: CanvasPoint, end: CanvasPoint): CanvasEdgeRoutingSegment {
  return { x1: start.x, y1: start.y, x2: end.x, y2: end.y };
}

function svgPathForSegment(value: CanvasEdgeRoutingSegment): string {
  return `M ${value.x1} ${value.y1} L ${value.x2} ${value.y2}`;
}

function boundsForSegments(segments: readonly CanvasEdgeRoutingSegment[]): CanvasRect {
  const first = segments[0]!;
  let minX = Math.min(first.x1, first.x2);
  let minY = Math.min(first.y1, first.y2);
  let maxX = Math.max(first.x1, first.x2);
  let maxY = Math.max(first.y1, first.y2);
  for (const value of segments.slice(1)) {
    minX = Math.min(minX, value.x1, value.x2);
    minY = Math.min(minY, value.y1, value.y2);
    maxX = Math.max(maxX, value.x1, value.x2);
    maxY = Math.max(maxY, value.y1, value.y2);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function segmentIntersectsRect(segmentValue: CanvasEdgeRoutingSegment, rect: CanvasRect): boolean {
  const start = { x: segmentValue.x1, y: segmentValue.y1 };
  const end = { x: segmentValue.x2, y: segmentValue.y2 };
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
