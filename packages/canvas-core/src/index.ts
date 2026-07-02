import { layoutCanvasDesiredNodes } from './canvasAutoLayout.js';

export * from './canvasRasterPreviews.js';
export * from './canvasTextPreviews.js';

export type CanvasNodeKind = 'directory' | 'file';
export type CanvasMediaKind = 'image' | 'video' | 'audio' | 'text' | 'unknown';
export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  id: string;
  source: 'project' | 'canvas' | 'capability' | 'settings' | 'generated_asset' | 'canvas-map';
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  filePath?: string;
  line?: number;
  column?: number;
  entityId?: string;
}

export interface CanvasAnnotation {
  id: string;
  text: string;
  x: number;
  y: number;
}

export interface CanvasNodeElement {
  projectRelativePath: string;
  nodeKind: CanvasNodeKind;
  mediaKind?: CanvasMediaKind;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  layoutMode?: 'manual';
  videoPlayback?: CanvasVideoPlaybackState;
  textViewport?: CanvasTextViewportState;
}

export type CanvasNodeAvailability =
  | {
      state: 'available';
      size: number;
      mimeType: string;
      fileUrl: string;
      canvasImagePreviewable?: boolean;
      canvasImagePreviewSourceWidth?: number;
      mtimeMs?: number;
      revision: string;
    }
  | {
      state: 'missing';
      message: string;
    }
  | {
      state: 'unreadable';
      message: string;
    };

export interface CanvasDocument {
  id: string;
  name: string;
  nodeElements: CanvasNodeElement[];
  annotations: CanvasAnnotation[];
  preferences: {
    showDiagnostics: boolean;
  };
}

export function isCanvasDocumentId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id);
}

export function assertCanvasDocumentId(id: string): string {
  if (!isCanvasDocumentId(id)) {
    throw new Error(`Invalid canvas document id: ${id}`);
  }
  return id;
}

export function isCanvasDocumentName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

export function normalizeCanvasDocumentName(name: string): string {
  const normalized = name.trim();
  if (!normalized) {
    throw new Error('Canvas document name must be a non-empty string.');
  }
  return normalized;
}

export interface CanvasStructureEdgeProjection {
  id: string;
  sourceProjectRelativePath: string;
  targetProjectRelativePath: string;
}

export interface CanvasVideoPlaybackState {
  currentTimeSeconds: number;
}

export interface CanvasTextViewportState {
  scrollTop: number;
  scrollLeft: number;
}

export interface CanvasVideoTextTrack {
  projectRelativePath: string;
  fileUrl?: string;
  revision: string;
  kind: 'subtitles' | 'captions' | 'chapters' | 'metadata';
  label: string;
  srclang?: string;
  default: boolean;
}

export interface CanvasVideoPresentation {
  kind: 'video';
  durationSeconds?: number;
  textTracks: CanvasVideoTextTrack[];
}

export interface ProjectedCanvasNode extends CanvasNodeElement {
  availability: CanvasNodeAvailability;
  videoPresentation?: CanvasVideoPresentation;
}

export interface CanvasProjection {
  canvasId: string;
  nodes: ProjectedCanvasNode[];
  edges: CanvasStructureEdgeProjection[];
  diagnostics: Diagnostic[];
}

export interface ProjectCanvasInput {
  canvas: CanvasDocument;
  diagnostics?: Diagnostic[];
  nodeAvailability: (node: CanvasNodeElement) => CanvasNodeAvailability;
}

export interface CanvasLayoutSize {
  width: number;
  height: number;
}

export interface CanvasDesiredNode {
  projectRelativePath: string;
  nodeKind: CanvasNodeKind;
  mediaKind?: CanvasMediaKind;
}

export interface CanvasDesiredLayoutRow {
  parentProjectRelativePath: string;
  memberProjectRelativePaths: string[];
}

export interface ReconcileCanvasNodeElementsInput {
  existing: CanvasNodeElement[];
  desired: CanvasDesiredNode[];
  layoutRows?: CanvasDesiredLayoutRow[];
  layoutSizeForNode: (node: CanvasDesiredNode) => CanvasLayoutSize;
}

export const CANVAS_FEEDBACK_MARKS = [
  'like',
  'dislike',
  'check',
  'cross',
  'pending',
  'important',
  'needs_revision'
] as const;

export type CanvasFeedbackMark = typeof CANVAS_FEEDBACK_MARKS[number];

export type CanvasFeedbackGeometry =
  | { type: 'point'; x: number; y: number }
  | { type: 'rect'; x: number; y: number; width: number; height: number };

export interface CanvasFeedbackComment {
  id: string;
  comment: string;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasImageFeedbackRegion {
  id: string;
  label: number;
  kind: 'pin' | 'region';
  geometry: CanvasFeedbackGeometry;
  comment: string;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasFeedbackEntry {
  projectRelativePath: string;
  marks: CanvasFeedbackMark[];
  comments: CanvasFeedbackComment[];
  nextRegionLabel: number;
  regions: CanvasImageFeedbackRegion[];
  updatedAt: string;
}

export interface CanvasFeedbackDocument {
  updatedAt: string;
  entries: Record<string, CanvasFeedbackEntry>;
}

export type UpdateCanvasFeedbackEntryInput =
  | {
      operation: 'set-marks';
      projectRelativePath: string;
      marks: CanvasFeedbackMark[];
    }
  | {
      operation: 'add-comment';
      projectRelativePath: string;
      comment: string;
    }
  | {
      operation: 'update-comment';
      projectRelativePath: string;
      commentId: string;
      comment: string;
    }
  | {
      operation: 'delete-comment';
      projectRelativePath: string;
      commentId: string;
    }
  | {
      operation: 'add-region';
      projectRelativePath: string;
      region: {
        kind: 'pin' | 'region';
        geometry: CanvasFeedbackGeometry;
        comment: string;
      };
    }
  | {
      operation: 'update-region';
      projectRelativePath: string;
      regionId: string;
      geometry?: CanvasFeedbackGeometry;
      comment?: string;
    }
  | {
      operation: 'delete-region';
      projectRelativePath: string;
      regionId: string;
    };

const CANVAS_FEEDBACK_MARK_ORDER = new Map<string, number>(
  CANVAS_FEEDBACK_MARKS.map((mark, index) => [mark, index])
);
const PROJECT_ROOT_PATH = '';

export function createEmptyCanvasFeedbackDocument(updatedAt: string): CanvasFeedbackDocument {
  assertIsoDateTime(updatedAt, 'Canvas feedback updatedAt must be an ISO date-time string.');
  return {
    updatedAt,
    entries: {}
  };
}

export function normalizeCanvasFeedbackDocument(value: unknown): CanvasFeedbackDocument {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['updatedAt', 'entries'])
    || typeof value.updatedAt !== 'string'
    || !isRecord(value.entries)) {
    throw new Error('Invalid Canvas feedback document.');
  }
  assertIsoDateTime(value.updatedAt, 'Canvas feedback updatedAt must be an ISO date-time string.');
  const entries: Record<string, CanvasFeedbackEntry> = {};
  for (const [key, entry] of Object.entries(value.entries)) {
    const normalizedKey = normalizeCanvasFeedbackProjectRelativePath(key);
    const normalizedEntry = normalizeCanvasFeedbackEntry(entry);
    if (normalizedKey !== normalizedEntry.projectRelativePath) {
      throw new Error(`Canvas feedback entry key must match projectRelativePath: ${key}`);
    }
    if (normalizedEntry.marks.length > 0 || normalizedEntry.comments.length > 0 || normalizedEntry.regions.length > 0) {
      entries[normalizedKey] = normalizedEntry;
    }
  }
  return {
    updatedAt: value.updatedAt,
    entries
  };
}

export function updateCanvasFeedbackEntry(
  document: CanvasFeedbackDocument,
  input: UpdateCanvasFeedbackEntryInput,
  updatedAt: string
): CanvasFeedbackDocument {
  const normalizedDocument = normalizeCanvasFeedbackDocument(document);
  const projectRelativePath = normalizeCanvasFeedbackProjectRelativePath(input.projectRelativePath);
  assertIsoDateTime(updatedAt, 'Canvas feedback updatedAt must be an ISO date-time string.');
  const currentEntry = normalizedDocument.entries[projectRelativePath]
    ?? createEmptyCanvasFeedbackEntry(projectRelativePath, updatedAt);
  const nextEntry = normalizedCanvasFeedbackEntryForOperation(currentEntry, input, updatedAt);
  const entries = { ...normalizedDocument.entries };
  if (nextEntry.marks.length === 0 && nextEntry.comments.length === 0 && nextEntry.regions.length === 0) {
    delete entries[projectRelativePath];
  } else {
    entries[projectRelativePath] = nextEntry;
  }
  return {
    updatedAt,
    entries
  };
}

export function canvasFeedbackRenderedProjectPath(projectRelativePath: string): string {
  const normalized = normalizeCanvasFeedbackProjectRelativePath(projectRelativePath);
  return `.debrute/reviews/rendered-feedback/${normalized}.annotated.png`;
}

export function canvasFeedbackEntryHasLocalRegions(entry: CanvasFeedbackEntry | undefined): boolean {
  return Boolean(entry && entry.regions.length > 0);
}

export function normalizeCanvasFeedbackMarks(marks: unknown): CanvasFeedbackMark[] {
  if (!Array.isArray(marks)) {
    throw new Error('Canvas feedback marks must be an array.');
  }
  const selected = new Set<CanvasFeedbackMark>();
  for (const mark of marks) {
    if (!isCanvasFeedbackMark(mark)) {
      throw new Error(`Invalid Canvas feedback mark: ${String(mark)}`);
    }
    selected.add(mark);
  }
  return [...selected].sort((left, right) => CANVAS_FEEDBACK_MARK_ORDER.get(left)! - CANVAS_FEEDBACK_MARK_ORDER.get(right)!);
}

export function normalizeCanvasFeedbackProjectRelativePath(projectRelativePath: string): string {
  if (typeof projectRelativePath !== 'string') {
    throw new Error(`Invalid Canvas feedback project-relative path: ${String(projectRelativePath)}`);
  }
  const normalized = projectRelativePath.replaceAll('\\', '/').replace(/^\.\//, '');
  const segments = normalized.split('/');
  if (!normalized
    || normalized.startsWith('/')
    || /^[A-Za-z]:/.test(normalized)
    || segments.some((segment) => segment === '' || segment === '..')) {
    throw new Error(`Invalid Canvas feedback project-relative path: ${projectRelativePath}`);
  }
  if (normalized === '.debrute/reviews/rendered-feedback' || normalized.startsWith('.debrute/reviews/rendered-feedback/')) {
    throw new Error('Canvas feedback cannot target rendered feedback artifacts.');
  }
  return normalized;
}

function createEmptyCanvasFeedbackEntry(projectRelativePath: string, updatedAt: string): CanvasFeedbackEntry {
  return {
    projectRelativePath,
    marks: [],
    comments: [],
    nextRegionLabel: 1,
    regions: [],
    updatedAt
  };
}

function nextCanvasFeedbackCommentId(comments: CanvasFeedbackComment[], updatedAt: string): string {
  const timestamp = updatedAt.replace(/[^0-9]/g, '');
  const prefix = `comment-${timestamp}-`;
  const maxExistingSuffix = comments.reduce((max, comment) => {
    if (!comment.id.startsWith(prefix)) {
      return max;
    }
    const suffix = Number(comment.id.slice(prefix.length));
    return Number.isInteger(suffix) && suffix > max ? suffix : max;
  }, 0);
  return `${prefix}${maxExistingSuffix + 1}`;
}

function normalizedCanvasFeedbackEntryForOperation(
  entry: CanvasFeedbackEntry,
  input: UpdateCanvasFeedbackEntryInput,
  updatedAt: string
): CanvasFeedbackEntry {
  if (input.operation === 'set-marks') {
    return {
      ...entry,
      marks: normalizeCanvasFeedbackMarks(input.marks),
      updatedAt
    };
  }
  if (input.operation === 'add-comment') {
    const comment = normalizeCanvasFeedbackComment(input.comment);
    return {
      ...entry,
      comments: [
        ...entry.comments,
        {
          id: nextCanvasFeedbackCommentId(entry.comments, updatedAt),
          comment,
          createdAt: updatedAt,
          updatedAt
        }
      ],
      updatedAt
    };
  }
  if (input.operation === 'update-comment') {
    let changed = false;
    const comments = entry.comments.map((item) => {
      if (item.id !== input.commentId) {
        return item;
      }
      changed = true;
      return {
        ...item,
        comment: normalizeCanvasFeedbackComment(input.comment),
        updatedAt
      };
    });
    if (!changed) {
      throw new Error(`Canvas feedback comment not found: ${input.commentId}`);
    }
    return { ...entry, comments, updatedAt };
  }
  if (input.operation === 'delete-comment') {
    let removed = false;
    const comments = entry.comments.filter((item) => {
      if (item.id === input.commentId) {
        removed = true;
        return false;
      }
      return true;
    });
    if (!removed) {
      throw new Error(`Canvas feedback comment not found: ${input.commentId}`);
    }
    return { ...entry, comments, updatedAt };
  }
  if (input.operation === 'add-region') {
    const label = entry.nextRegionLabel;
    const geometry = normalizeCanvasFeedbackGeometry(input.region.geometry);
    validateCanvasFeedbackRegionKindGeometry(input.region.kind, geometry);
    return {
      ...entry,
      nextRegionLabel: label + 1,
      regions: [
        ...entry.regions,
        {
          id: `region-${updatedAt.replace(/[^0-9]/g, '')}-${label}`,
          label,
          kind: input.region.kind,
          geometry,
          comment: normalizeCanvasFeedbackRegionComment(input.region.comment),
          createdAt: updatedAt,
          updatedAt
        }
      ],
      updatedAt
    };
  }
  if (input.operation === 'update-region') {
    let changed = false;
    const regions = entry.regions.map((region) => {
      if (region.id !== input.regionId) {
        return region;
      }
      changed = true;
      const geometry = input.geometry ? normalizeCanvasFeedbackGeometry(input.geometry) : region.geometry;
      validateCanvasFeedbackRegionKindGeometry(region.kind, geometry);
      return {
        ...region,
        geometry,
        ...(input.comment !== undefined ? { comment: normalizeCanvasFeedbackRegionComment(input.comment) } : {}),
        updatedAt
      };
    });
    if (!changed) {
      throw new Error(`Canvas feedback region not found: ${input.regionId}`);
    }
    return { ...entry, regions, updatedAt };
  }
  let removed = false;
  const regions = entry.regions.filter((region) => {
    if (region.id === input.regionId) {
      removed = true;
      return false;
    }
    return true;
  });
  if (!removed) {
    throw new Error(`Canvas feedback region not found: ${input.regionId}`);
  }
  return { ...entry, regions, updatedAt };
}

export function createCanvasDocument(input: { id: string }): CanvasDocument {
  const id = assertCanvasDocumentId(input.id);
  return {
    id,
    name: id,
    nodeElements: [],
    annotations: [],
    preferences: {
      showDiagnostics: true
    }
  };
}

export function projectCanvas(input: ProjectCanvasInput): CanvasProjection {
  const nodeElements = sortedCanvasNodeElements(input.canvas.nodeElements);
  return {
    canvasId: input.canvas.id,
    nodes: nodeElements.map((node) => ({
      ...node,
      availability: input.nodeAvailability(node)
    })),
    edges: structureEdgesForCanvasNodes(nodeElements),
    diagnostics: input.diagnostics ?? []
  };
}

export function updateCanvasNodeLayouts(
  canvas: CanvasDocument,
  input: {
    nodeLayouts?: Array<{
      projectRelativePath: string;
      x: number;
      y: number;
      width?: number;
      height?: number;
    }>;
  }
): CanvasDocument {
  const updatesByPath = new Map((input.nodeLayouts ?? []).map((layout) => [layout.projectRelativePath, layout]));
  return {
    ...canvas,
    nodeElements: canvas.nodeElements.map((nodeElement) => {
      const layout = updatesByPath.get(nodeElement.projectRelativePath);
      return layout
        ? {
            ...nodeElement,
            x: layout.x,
            y: layout.y,
            width: layout.width ?? nodeElement.width,
            height: layout.height ?? nodeElement.height,
            layoutMode: 'manual'
          }
        : nodeElement;
    })
  };
}

export function clearCanvasNodeManualLayouts(
  canvas: CanvasDocument,
  input: { all: true } | { projectRelativePaths: string[] }
): { canvas: CanvasDocument; resetCount: number } {
  const resetPaths = 'all' in input
    ? undefined
    : new Set(input.projectRelativePaths);
  let resetCount = 0;
  const nodeElements = canvas.nodeElements.map((nodeElement) => {
    if (nodeElement.layoutMode !== 'manual') {
      return nodeElement;
    }
    if (resetPaths && !resetPaths.has(nodeElement.projectRelativePath)) {
      return nodeElement;
    }
    const { layoutMode: _layoutMode, ...automaticNode } = nodeElement;
    resetCount += 1;
    return automaticNode;
  });
  return {
    canvas: {
      ...canvas,
      nodeElements
    },
    resetCount
  };
}

export function updateCanvasNodeLayers(
  canvas: CanvasDocument,
  input: {
    nodeProjectRelativePathsTopFirst?: string[];
  }
): CanvasDocument {
  return {
    ...canvas,
    nodeElements: input.nodeProjectRelativePathsTopFirst
      ? reorderCanvasNodeElementsTopFirst(canvas.nodeElements, input.nodeProjectRelativePathsTopFirst)
      : canvas.nodeElements
  };
}

export function updateCanvasVideoPlaybackState(
  canvas: CanvasDocument,
  input: {
    updates: Array<{
      projectRelativePath: string;
      currentTimeSeconds: number;
    }>;
  }
): CanvasDocument {
  const updatesByPath = new Map(input.updates.map((update) => {
    assertCanvasVideoPlaybackTime(update.currentTimeSeconds);
    return [update.projectRelativePath, normalizeCanvasVideoPlaybackTime(update.currentTimeSeconds)] as const;
  }));
  if (updatesByPath.size === 0) {
    return canvas;
  }
  return {
    ...canvas,
    nodeElements: canvas.nodeElements.map((nodeElement) => {
      const currentTimeSeconds = updatesByPath.get(nodeElement.projectRelativePath);
      if (currentTimeSeconds === undefined || nodeElement.nodeKind !== 'file' || nodeElement.mediaKind !== 'video') {
        return nodeElement;
      }
      if (currentTimeSeconds === 0) {
        const { videoPlayback: _videoPlayback, ...nodeWithoutPlayback } = nodeElement;
        return nodeWithoutPlayback;
      }
      return {
        ...nodeElement,
        videoPlayback: { currentTimeSeconds }
      };
    })
  };
}

export function updateCanvasTextViewportState(
  canvas: CanvasDocument,
  input: {
    updates: Array<{
      projectRelativePath: string;
      scrollTop: number;
      scrollLeft: number;
    }>;
  }
): CanvasDocument {
  const updatesByPath = new Map(input.updates.map((update) => {
    assertCanvasTextViewportScroll(update.scrollTop, update.scrollLeft);
    return [update.projectRelativePath, {
      scrollTop: update.scrollTop,
      scrollLeft: update.scrollLeft
    }] as const;
  }));
  if (updatesByPath.size === 0) {
    return canvas;
  }
  let changed = false;
  const nodeElements = canvas.nodeElements.map((nodeElement) => {
    const viewport = updatesByPath.get(nodeElement.projectRelativePath);
    if (viewport === undefined || nodeElement.nodeKind !== 'file' || nodeElement.mediaKind !== 'text') {
      return nodeElement;
    }
    if (viewport.scrollTop === 0 && viewport.scrollLeft === 0) {
      if (nodeElement.textViewport === undefined) {
        return nodeElement;
      }
      changed = true;
      const { textViewport: _textViewport, ...nodeWithoutViewport } = nodeElement;
      return nodeWithoutViewport;
    }
    if (nodeElement.textViewport?.scrollTop === viewport.scrollTop
      && nodeElement.textViewport.scrollLeft === viewport.scrollLeft) {
      return nodeElement;
    }
    changed = true;
    return {
      ...nodeElement,
      textViewport: viewport
    };
  });
  return changed
    ? {
        ...canvas,
        nodeElements
      }
    : canvas;
}

export function canvasNodeLayerOrderTopFirst(canvas: Pick<CanvasDocument, 'nodeElements'>): string[] {
  return [...canvas.nodeElements]
    .sort((left, right) => compareNodeZ(right, left))
    .map((nodeElement) => nodeElement.projectRelativePath);
}

export function reconcileCanvasNodeElements(input: ReconcileCanvasNodeElementsInput): CanvasNodeElement[] {
  const desired = sortDesiredNodes(input.desired);
  const existingByPath = new Map(input.existing.map((node) => [node.projectRelativePath, node]));
  const manualPaths = new Set(input.existing
    .filter((node) => node.layoutMode === 'manual')
    .map((node) => node.projectRelativePath));
  const layoutByPath = layoutCanvasDesiredNodes({
    desired,
    layoutRows: input.layoutRows ?? [],
    manualPaths,
    layoutSizeForNode: input.layoutSizeForNode
  });
  const desiredPaths = new Set(desired.map((node) => node.projectRelativePath));
  const usedZ = new Set<number>();
  const preservedZByPath = new Map<string, number>();
  for (const existing of input.existing) {
    if (desiredPaths.has(existing.projectRelativePath) && !usedZ.has(existing.z)) {
      preservedZByPath.set(existing.projectRelativePath, existing.z);
      usedZ.add(existing.z);
    }
  }
  let nextZ = 0;
  const allocateNewZ = (): number => {
    while (usedZ.has(nextZ)) {
      nextZ += 1;
    }
    const z = nextZ;
    usedZ.add(z);
    nextZ += 1;
    return z;
  };
  return desired.map((desiredNode) => {
    const existing = existingByPath.get(desiredNode.projectRelativePath);
    const base = {
      projectRelativePath: desiredNode.projectRelativePath,
      nodeKind: desiredNode.nodeKind,
      ...(desiredNode.mediaKind ? { mediaKind: desiredNode.mediaKind } : {}),
      ...(existing?.videoPlayback && desiredNode.nodeKind === 'file' && desiredNode.mediaKind === 'video'
        ? { videoPlayback: existing.videoPlayback }
        : {}),
      ...(existing?.textViewport && desiredNode.nodeKind === 'file' && desiredNode.mediaKind === 'text'
        ? { textViewport: existing.textViewport }
        : {}),
      z: preservedZByPath.get(desiredNode.projectRelativePath) ?? allocateNewZ()
    };
    if (existing?.layoutMode === 'manual') {
      return {
        ...base,
        x: existing.x,
        y: existing.y,
        width: existing.width,
        height: existing.height,
        layoutMode: 'manual'
      };
    }
    const layout = layoutByPath.get(desiredNode.projectRelativePath);
    if (!layout) {
      throw new Error(`Canvas node layout is missing: ${desiredNode.projectRelativePath}`);
    }
    return {
      ...base,
      x: layout.x,
      y: layout.y,
      width: layout.width,
      height: layout.height
    };
  });
}

function sortedCanvasNodeElements(nodeElements: CanvasNodeElement[]): CanvasNodeElement[] {
  return [...nodeElements].sort(compareNodeZ);
}

function compareNodeZ(left: CanvasNodeElement, right: CanvasNodeElement): number {
  if (left.z !== right.z) {
    return left.z - right.z;
  }
  return left.projectRelativePath.localeCompare(right.projectRelativePath);
}

function assertCanvasVideoPlaybackTime(currentTimeSeconds: number): void {
  if (!Number.isFinite(currentTimeSeconds) || currentTimeSeconds < 0) {
    throw new Error('Canvas video playback time must be a non-negative finite number.');
  }
}

function assertCanvasTextViewportScroll(scrollTop: number, scrollLeft: number): void {
  if (!Number.isFinite(scrollTop) || scrollTop < 0 || !Number.isFinite(scrollLeft) || scrollLeft < 0) {
    throw new Error('Canvas text viewport scroll values must be non-negative finite numbers.');
  }
}

function normalizeCanvasVideoPlaybackTime(currentTimeSeconds: number): number {
  return Math.round(currentTimeSeconds * 1000) / 1000;
}

function reorderCanvasNodeElementsTopFirst(
  nodeElements: CanvasNodeElement[],
  projectRelativePathsTopFirst: string[]
): CanvasNodeElement[] {
  const existingPaths = new Set(nodeElements.map((node) => node.projectRelativePath));
  const requested = [...new Set(projectRelativePathsTopFirst.filter((path) => existingPaths.has(path)))];
  if (requested.length === 0) {
    return nodeElements;
  }
  const requestedSet = new Set(requested);
  const remaining = [...nodeElements]
    .filter((node) => !requestedSet.has(node.projectRelativePath))
    .sort((left, right) => compareNodeZ(right, left))
    .map((node) => node.projectRelativePath);
  const orderedPathsTopFirst = [...requested, ...remaining];
  const zByPath = new Map<string, number>();
  for (const [index, path] of [...orderedPathsTopFirst].reverse().entries()) {
    zByPath.set(path, index);
  }
  return nodeElements.map((node) => {
    const z = zByPath.get(node.projectRelativePath);
    return z === undefined ? node : { ...node, z };
  });
}

function structureEdgesForCanvasNodes(nodes: CanvasNodeElement[]): CanvasStructureEdgeProjection[] {
  const existing = new Set(nodes.map((node) => node.projectRelativePath));
  return nodes.flatMap((node) => {
    const parent = parentPath(node.projectRelativePath);
    if (parent === undefined || !existing.has(parent)) {
      return [];
    }
    return [{
      id: `${parent}--${node.projectRelativePath}`,
      sourceProjectRelativePath: parent,
      targetProjectRelativePath: node.projectRelativePath
    }];
  });
}

function sortDesiredNodes(nodes: CanvasDesiredNode[]): CanvasDesiredNode[] {
  return [...nodes].sort(compareDesiredPath);
}

function compareDesiredPath(left: CanvasDesiredNode, right: CanvasDesiredNode): number {
  const leftParts = left.projectRelativePath.split('/');
  const rightParts = right.projectRelativePath.split('/');
  const length = Math.min(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = leftParts[index]!.localeCompare(rightParts[index]!, undefined, { numeric: true, sensitivity: 'base' });
    if (comparison !== 0) {
      return comparison;
    }
  }
  return leftParts.length - rightParts.length;
}

function parentPath(path: string): string | undefined {
  if (path === PROJECT_ROOT_PATH) {
    return undefined;
  }
  const index = path.lastIndexOf('/');
  if (index < 0) {
    return PROJECT_ROOT_PATH;
  }
  return index > 0 ? path.slice(0, index) : undefined;
}

function normalizeCanvasFeedbackEntry(value: unknown): CanvasFeedbackEntry {
  const nextRegionLabel = isRecord(value) ? value.nextRegionLabel : undefined;
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['projectRelativePath', 'marks', 'comments', 'nextRegionLabel', 'regions', 'updatedAt'])
    || typeof value.projectRelativePath !== 'string'
    || typeof nextRegionLabel !== 'number'
    || !Number.isInteger(nextRegionLabel)
    || nextRegionLabel <= 0
    || !Array.isArray(value.comments)
    || !Array.isArray(value.regions)
    || typeof value.updatedAt !== 'string') {
    throw new Error('Invalid Canvas feedback entry.');
  }
  assertIsoDateTime(value.updatedAt, 'Canvas feedback entry updatedAt must be an ISO date-time string.');
  const comments = value.comments.map(normalizeCanvasFeedbackCommentEntry);
  assertUniqueCanvasFeedbackCommentIds(comments);
  const regions = value.regions.map(normalizeCanvasFeedbackRegion);
  assertUniqueCanvasFeedbackRegionIds(regions);
  assertUniqueCanvasFeedbackRegionLabels(regions);
  const maxLabel = Math.max(0, ...regions.map((region) => region.label));
  if (nextRegionLabel <= maxLabel) {
    throw new Error('Canvas feedback nextRegionLabel must exceed existing region labels.');
  }
  return {
    projectRelativePath: normalizeCanvasFeedbackProjectRelativePath(value.projectRelativePath),
    marks: normalizeCanvasFeedbackMarks(value.marks),
    comments,
    nextRegionLabel,
    regions,
    updatedAt: value.updatedAt
  };
}

function assertUniqueCanvasFeedbackCommentIds(comments: CanvasFeedbackComment[]): void {
  const ids = new Set<string>();
  for (const comment of comments) {
    if (ids.has(comment.id)) {
      throw new Error('Canvas feedback comment ids must be unique.');
    }
    ids.add(comment.id);
  }
}

function assertUniqueCanvasFeedbackRegionIds(regions: CanvasImageFeedbackRegion[]): void {
  const ids = new Set<string>();
  for (const region of regions) {
    if (ids.has(region.id)) {
      throw new Error('Canvas feedback region ids must be unique.');
    }
    ids.add(region.id);
  }
}

function assertUniqueCanvasFeedbackRegionLabels(regions: CanvasImageFeedbackRegion[]): void {
  const labels = new Set<number>();
  for (const region of regions) {
    if (labels.has(region.label)) {
      throw new Error('Canvas feedback region labels must be unique.');
    }
    labels.add(region.label);
  }
}

function normalizeCanvasFeedbackCommentEntry(value: unknown): CanvasFeedbackComment {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['id', 'comment', 'createdAt', 'updatedAt'])
    || typeof value.id !== 'string'
    || !value.id.trim()
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string') {
    throw new Error('Invalid Canvas feedback comment.');
  }
  assertIsoDateTime(value.createdAt, 'Canvas feedback comment createdAt must be an ISO date-time string.');
  assertIsoDateTime(value.updatedAt, 'Canvas feedback comment updatedAt must be an ISO date-time string.');
  return {
    id: value.id.trim(),
    comment: normalizeCanvasFeedbackComment(value.comment),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function normalizeCanvasFeedbackRegion(value: unknown): CanvasImageFeedbackRegion {
  const label = isRecord(value) ? value.label : undefined;
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['id', 'label', 'kind', 'geometry', 'comment', 'createdAt', 'updatedAt'])
    || typeof value.id !== 'string'
    || !value.id.trim()
    || typeof label !== 'number'
    || !Number.isInteger(label)
    || label <= 0
    || (value.kind !== 'pin' && value.kind !== 'region')
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string') {
    throw new Error('Invalid Canvas feedback region.');
  }
  assertIsoDateTime(value.createdAt, 'Canvas feedback region createdAt must be an ISO date-time string.');
  assertIsoDateTime(value.updatedAt, 'Canvas feedback region updatedAt must be an ISO date-time string.');
  const geometry = normalizeCanvasFeedbackGeometry(value.geometry);
  validateCanvasFeedbackRegionKindGeometry(value.kind, geometry);
  return {
    id: value.id.trim(),
    label,
    kind: value.kind,
    geometry,
    comment: normalizeCanvasFeedbackRegionComment(value.comment),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function normalizeCanvasFeedbackGeometry(value: unknown): CanvasFeedbackGeometry {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('Invalid Canvas feedback geometry.');
  }
  if (value.type === 'point') {
    return {
      type: 'point',
      x: normalizeUnitInterval(value.x, 'Canvas feedback point x'),
      y: normalizeUnitInterval(value.y, 'Canvas feedback point y')
    };
  }
  if (value.type === 'rect') {
    const x = normalizeUnitInterval(value.x, 'Canvas feedback region x');
    const y = normalizeUnitInterval(value.y, 'Canvas feedback region y');
    const width = normalizePositiveUnitSize(value.width, 'Canvas feedback region width');
    const height = normalizePositiveUnitSize(value.height, 'Canvas feedback region height');
    if (x + width > 1) {
      throw new Error('Canvas feedback region x plus width must be at most 1.');
    }
    if (y + height > 1) {
      throw new Error('Canvas feedback region y plus height must be at most 1.');
    }
    return { type: value.type, x, y, width, height };
  }
  throw new Error(`Invalid Canvas feedback geometry type: ${String(value.type)}`);
}

function validateCanvasFeedbackRegionKindGeometry(kind: CanvasImageFeedbackRegion['kind'], geometry: CanvasFeedbackGeometry): void {
  if (kind === 'pin' && geometry.type !== 'point') {
    throw new Error('Canvas feedback pin geometry must be a point.');
  }
  if (kind === 'region' && geometry.type === 'point') {
    throw new Error('Canvas feedback region geometry must be a rect.');
  }
}

function normalizeUnitInterval(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1.`);
  }
  return value;
}

function normalizePositiveUnitSize(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${label} must be greater than 0.`);
  }
  return value;
}

function normalizeCanvasFeedbackComment(comment: unknown): string {
  if (typeof comment !== 'string') {
    throw new Error('Canvas feedback comment must be a string.');
  }
  const trimmed = comment.trim();
  if (!trimmed) {
    throw new Error('Canvas feedback comment must be non-empty.');
  }
  return trimmed;
}

function normalizeCanvasFeedbackRegionComment(comment: unknown): string {
  if (typeof comment !== 'string') {
    throw new Error('Canvas feedback region comment must be a string.');
  }
  const trimmed = comment.trim();
  if (!trimmed) {
    throw new Error('Canvas feedback region comment must be non-empty.');
  }
  return trimmed;
}

function isCanvasFeedbackMark(value: unknown): value is CanvasFeedbackMark {
  return typeof value === 'string' && CANVAS_FEEDBACK_MARK_ORDER.has(value);
}

function assertIsoDateTime(value: string, message: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(message);
  }
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
