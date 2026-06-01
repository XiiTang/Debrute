import { assertCanvasViewport, type CanvasProjection, type CanvasSelection, type CanvasViewport, type ProjectedCanvasNode } from '@axis/canvas-core';
import { rectsIntersect, selectedNodeProjectRelativePaths, type CanvasRect } from '../services/canvasInteraction';
import { canvasImagePreviewBucketForNode } from './canvasImagePreviews';

export const CANVAS_VIRTUAL_OVERSCAN_SCREEN_PX = 768;
export const CANVAS_FALLBACK_SURFACE_SIZE = { width: 1280, height: 720 } as const;

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
}

export interface VirtualizedCanvasRenderState {
  visibleRect: CanvasRect;
  virtualRect: CanvasRect;
  nodes: ProjectedCanvasNode[];
  edges: CanvasEdgeSegment[];
  svgBounds: CanvasRect;
  svgViewBox: string;
  signature: string;
}

export interface CanvasVirtualizationIndex {
  render: (input: CanvasVirtualizationQueryInput) => VirtualizedCanvasRenderState;
}

export interface CanvasVirtualizationQueryInput {
  viewport: CanvasViewport;
  surfaceSize: Partial<CanvasSize> | undefined;
  selection: CanvasSelection | undefined;
  activeNodeProjectRelativePaths: Iterable<string>;
  imagePreviewsEnabled: boolean;
  devicePixelRatio: number;
  imageResourceZoom: number;
}

export function canvasVisibleRect(input: {
  viewport: CanvasViewport;
  surfaceSize: Partial<CanvasSize> | undefined;
}): CanvasRect {
  const size = normalizedSurfaceSize(input.surfaceSize);
  assertCanvasViewport(input.viewport);
  const zoom = input.viewport.zoom;
  return {
    x: -input.viewport.x / zoom,
    y: -input.viewport.y / zoom,
    width: size.width / zoom,
    height: size.height / zoom
  };
}

export function canvasVirtualRenderRect(input: {
  viewport: CanvasViewport;
  surfaceSize: Partial<CanvasSize> | undefined;
}): CanvasRect {
  assertCanvasViewport(input.viewport);
  return expandCanvasRect(
    canvasVisibleRect(input),
    CANVAS_VIRTUAL_OVERSCAN_SCREEN_PX / input.viewport.zoom
  );
}

export function createCanvasVirtualizationIndex(input: {
  nodes: ProjectedCanvasNode[];
  edges: CanvasProjection['edges'];
}): CanvasVirtualizationIndex {
  const visibleNodes = input.nodes.filter((node) => node.visible !== false);
  const nodeIndex = new CanvasNodeSpatialIndex(visibleNodes);
  const nodeByPath = new Map(visibleNodes.map((node) => [node.projectRelativePath, node]));
  const resolvedEdges = input.edges.flatMap((edge, order) => {
    const resolved = resolveEdgeNodes(edge, nodeByPath, order);
    return resolved ? [resolved] : [];
  });
  const edgeSegments = routedEdges(resolvedEdges);
  const edgeIndex = new CanvasEdgeSpatialIndex(edgeSegments);

  return {
    render: (query) => buildVirtualizedCanvasRenderStateFromIndex({
      ...query,
      visibleNodes,
      nodeIndex,
      edgeIndex
    })
  };
}

export function buildVirtualizedCanvasRenderState(input: {
  nodes: ProjectedCanvasNode[];
  edges: CanvasProjection['edges'];
  viewport: CanvasViewport;
  surfaceSize: Partial<CanvasSize> | undefined;
  selection: CanvasSelection | undefined;
  activeNodeProjectRelativePaths: Iterable<string>;
  imagePreviewsEnabled: boolean;
  devicePixelRatio: number;
  imageResourceZoom: number;
}): VirtualizedCanvasRenderState {
  return createCanvasVirtualizationIndex({
    nodes: input.nodes,
    edges: input.edges
  }).render({
    viewport: input.viewport,
    surfaceSize: input.surfaceSize,
    selection: input.selection,
    activeNodeProjectRelativePaths: input.activeNodeProjectRelativePaths,
    imagePreviewsEnabled: input.imagePreviewsEnabled,
    devicePixelRatio: input.devicePixelRatio,
    imageResourceZoom: input.imageResourceZoom
  });
}

function buildVirtualizedCanvasRenderStateFromIndex(input: CanvasVirtualizationQueryInput & {
  visibleNodes: ProjectedCanvasNode[];
  nodeIndex: CanvasNodeSpatialIndex;
  edgeIndex: CanvasEdgeSpatialIndex;
}): VirtualizedCanvasRenderState {
  assertCanvasVirtualizationImageContext(input);
  const visibleRect = canvasVisibleRect(input);
  const virtualRect = canvasVirtualRenderRect(input);
  const selectedPaths = new Set(selectedNodeProjectRelativePaths(input.selection));
  const activePaths = new Set(input.activeNodeProjectRelativePaths);
  const intersectingPaths = new Set(input.nodeIndex.query(virtualRect).map((node) => node.projectRelativePath));
  const nodes = input.visibleNodes.filter((node) => (
    intersectingPaths.has(node.projectRelativePath)
    || selectedPaths.has(node.projectRelativePath)
    || activePaths.has(node.projectRelativePath)
  ));
  const edges = input.edgeIndex.query(virtualRect);
  const svgBounds = svgBoundsForEdges(virtualRect, edges);

  return {
    visibleRect,
    virtualRect,
    nodes,
    edges,
    svgBounds,
    svgViewBox: rectViewBox(svgBounds),
    signature: renderStateSignature({
      zoom: input.imageResourceZoom,
      imagePreviewsEnabled: input.imagePreviewsEnabled,
      devicePixelRatio: input.devicePixelRatio,
      nodes,
      edges
    })
  };
}

export function renderStateSignature(input: {
  zoom: number;
  imagePreviewsEnabled: boolean;
  devicePixelRatio: number;
  nodes: Pick<ProjectedCanvasNode, 'projectRelativePath' | 'nodeKind' | 'mediaKind' | 'width' | 'availability'>[];
  edges: Pick<CanvasEdgeSegment, 'id'>[];
}): string {
  const nodeSignature = input.nodes.map((node) => [
    node.projectRelativePath,
    imageResourceSignature(node, input)
  ].join('\u001c')).join('\u001f');
  return `${nodeSignature}\u001e${input.edges.map((edge) => edge.id).join('\u001f')}`;
}

function imageResourceSignature(
  node: Pick<ProjectedCanvasNode, 'nodeKind' | 'mediaKind' | 'width' | 'availability'>,
  input: { zoom: number; imagePreviewsEnabled: boolean; devicePixelRatio: number }
): string {
  if (
    !input.imagePreviewsEnabled
    || node.nodeKind !== 'file'
    || node.mediaKind !== 'image'
    || node.availability.state !== 'available'
    || node.availability.canvasImagePreviewable !== true
  ) {
    return '';
  }
  return String(canvasImagePreviewBucketForNode(node, input.zoom, input.devicePixelRatio));
}

function assertCanvasVirtualizationImageContext(input: Pick<CanvasVirtualizationQueryInput, 'imagePreviewsEnabled' | 'devicePixelRatio' | 'imageResourceZoom'>): void {
  if (typeof input.imagePreviewsEnabled !== 'boolean') {
    throw new Error('Canvas virtualization image preview context is required.');
  }
  assertPositiveFiniteNumber(input.devicePixelRatio, 'Canvas devicePixelRatio must be a positive finite number.');
  assertPositiveFiniteNumber(input.imageResourceZoom, 'Canvas imageResourceZoom must be a positive finite number.');
}

function assertPositiveFiniteNumber(value: number, message: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(message);
  }
}

export function expandCanvasRect(rect: CanvasRect, amount: number): CanvasRect {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2
  };
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

function svgBoundsForEdges(virtualRect: CanvasRect, edges: CanvasEdgeSegment[]): CanvasRect {
  let minX = virtualRect.x;
  let minY = virtualRect.y;
  let maxX = virtualRect.x + virtualRect.width;
  let maxY = virtualRect.y + virtualRect.height;
  for (const edge of edges) {
    for (const point of edge.points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  return {
    x: minX - SVG_EDGE_PADDING,
    y: minY - SVG_EDGE_PADDING,
    width: Math.max(1, maxX - minX + SVG_EDGE_PADDING * 2),
    height: Math.max(1, maxY - minY + SVG_EDGE_PADDING * 2)
  };
}

function normalizedSurfaceSize(surfaceSize: Partial<CanvasSize> | undefined): CanvasSize {
  return {
    width: finitePositive(surfaceSize?.width) ? surfaceSize.width : CANVAS_FALLBACK_SURFACE_SIZE.width,
    height: finitePositive(surfaceSize?.height) ? surfaceSize.height : CANVAS_FALLBACK_SURFACE_SIZE.height
  };
}

function finitePositive(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
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
