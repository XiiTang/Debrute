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
  width: number;
  height: number;
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

export interface CanvasFeedbackMomentRef {
  label: string;
  currentTimeSeconds: number;
}

export interface CanvasFeedbackItemBase {
  id: string;
  comment: string;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasFeedbackFileCommentItem extends CanvasFeedbackItemBase {
  kind: 'comment';
  scope: 'file';
}

export interface CanvasFeedbackMomentCommentItem extends CanvasFeedbackItemBase {
  kind: 'comment';
  scope: 'moment';
  moment: CanvasFeedbackMomentRef;
}

export interface CanvasFeedbackFileSpatialItem extends CanvasFeedbackItemBase {
  kind: 'pin' | 'region';
  scope: 'file';
  label: number;
  geometry: CanvasFeedbackGeometry;
}

export interface CanvasFeedbackMomentSpatialItem extends CanvasFeedbackItemBase {
  kind: 'pin' | 'region';
  scope: 'moment';
  label: number;
  geometry: CanvasFeedbackGeometry;
  moment: CanvasFeedbackMomentRef;
}

export type CanvasFeedbackCommentItem = CanvasFeedbackFileCommentItem | CanvasFeedbackMomentCommentItem;
export type CanvasFeedbackSpatialItem = CanvasFeedbackFileSpatialItem | CanvasFeedbackMomentSpatialItem;
export type CanvasFeedbackItem = CanvasFeedbackCommentItem | CanvasFeedbackSpatialItem;

export interface CanvasFeedbackEntry {
  projectRelativePath: string;
  marks: CanvasFeedbackMark[];
  nextMomentLabel: number;
  nextSpatialLabel: number;
  items: CanvasFeedbackItem[];
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
      operation: 'add-item';
      projectRelativePath: string;
      item:
        | { kind: 'comment'; scope: 'file'; comment: string }
        | { kind: 'comment'; scope: 'moment'; momentTimeSeconds: number; comment: string }
        | { kind: 'pin' | 'region'; scope: 'file'; geometry: CanvasFeedbackGeometry; comment: string }
        | { kind: 'pin' | 'region'; scope: 'moment'; momentTimeSeconds: number; geometry: CanvasFeedbackGeometry; comment: string };
    }
  | {
      operation: 'update-item';
      projectRelativePath: string;
      itemId: string;
      geometry?: CanvasFeedbackGeometry;
      comment?: string;
    }
  | {
      operation: 'delete-item';
      projectRelativePath: string;
      itemId: string;
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
    if (normalizedEntry.marks.length > 0 || normalizedEntry.items.length > 0) {
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
  if (nextEntry.marks.length === 0 && nextEntry.items.length === 0) {
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

export function canvasFeedbackRenderedMomentProjectPath(projectRelativePath: string, momentLabel: string): string {
  const normalized = normalizeCanvasFeedbackProjectRelativePath(projectRelativePath);
  const label = `M${momentLabelNumber(momentLabel)}`;
  return `.debrute/reviews/rendered-feedback/${normalized}.moment-${label}.annotated.png`;
}

export function canvasFeedbackEntryHasFileSpatialItems(entry: CanvasFeedbackEntry | undefined): boolean {
  return Boolean(entry?.items.some((item) => isCanvasFeedbackSpatialItem(item) && item.scope === 'file'));
}

export function canvasFeedbackEntryHasMomentItems(entry: CanvasFeedbackEntry | undefined): boolean {
  return Boolean(entry?.items.some((item) => item.scope === 'moment'));
}

export function canvasFeedbackMomentRefs(entry: CanvasFeedbackEntry | undefined): CanvasFeedbackMomentRef[] {
  if (!entry) {
    return [];
  }
  const seen = new Set<string>();
  const moments: CanvasFeedbackMomentRef[] = [];
  for (const item of entry.items) {
    if (item.scope !== 'moment') {
      continue;
    }
    const key = `${item.moment.label}:${item.moment.currentTimeSeconds}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    moments.push(item.moment);
  }
  return moments;
}

export function canvasFeedbackItemsForMoment(
  entry: CanvasFeedbackEntry | undefined,
  moment: CanvasFeedbackMomentRef
): CanvasFeedbackItem[] {
  return entry?.items.filter((item) => (
    item.scope === 'moment'
    && item.moment.label === moment.label
    && item.moment.currentTimeSeconds === moment.currentTimeSeconds
  )) ?? [];
}

export function canvasFeedbackSpatialItemsForMoment(
  entry: CanvasFeedbackEntry | undefined,
  moment: CanvasFeedbackMomentRef
): CanvasFeedbackSpatialItem[] {
  return canvasFeedbackItemsForMoment(entry, moment).filter(isCanvasFeedbackSpatialItem);
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
    nextMomentLabel: 1,
    nextSpatialLabel: 1,
    items: [],
    updatedAt
  };
}

function nextCanvasFeedbackItemId(items: CanvasFeedbackItem[], updatedAt: string): string {
  const timestamp = updatedAt.replace(/[^0-9]/g, '');
  const prefix = `item-${timestamp}-`;
  const maxExistingSuffix = items.reduce((max, item) => {
    if (!item.id.startsWith(prefix)) {
      return max;
    }
    const suffix = Number(item.id.slice(prefix.length));
    return Number.isInteger(suffix) && suffix > max ? suffix : max;
  }, 0);
  return `${prefix}${maxExistingSuffix + 1}`;
}

function momentRefForTime(entry: CanvasFeedbackEntry, currentTimeSeconds: number): { entry: CanvasFeedbackEntry; moment: CanvasFeedbackMomentRef } {
  const normalizedTime = normalizeCanvasVideoPlaybackTime(currentTimeSeconds);
  const existing = entry.items.find((item) => item.scope === 'moment' && item.moment.currentTimeSeconds === normalizedTime);
  if (existing?.scope === 'moment') {
    return { entry, moment: existing.moment };
  }
  const moment = {
    label: `M${entry.nextMomentLabel}`,
    currentTimeSeconds: normalizedTime
  };
  return {
    entry: {
      ...entry,
      nextMomentLabel: entry.nextMomentLabel + 1
    },
    moment
  };
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
  if (input.operation === 'add-item') {
    const id = nextCanvasFeedbackItemId(entry.items, updatedAt);
    const comment = normalizeCanvasFeedbackComment(input.item.comment);
    if (input.item.kind === 'comment' && input.item.scope === 'file') {
      return {
        ...entry,
        items: [
          ...entry.items,
          {
            id,
            kind: 'comment',
            scope: 'file',
            comment,
            createdAt: updatedAt,
            updatedAt
          }
        ],
        updatedAt
      };
    }
    if (input.item.kind === 'comment' && input.item.scope === 'moment') {
      assertCanvasVideoPlaybackTime(input.item.momentTimeSeconds);
      const { entry: momentEntry, moment } = momentRefForTime(entry, input.item.momentTimeSeconds);
      return {
        ...momentEntry,
        items: [
          ...momentEntry.items,
          {
            id,
            kind: 'comment',
            scope: 'moment',
            moment,
            comment,
            createdAt: updatedAt,
            updatedAt
          }
        ],
        updatedAt
      };
    }
    const geometry = normalizeCanvasFeedbackGeometry(input.item.geometry);
    validateCanvasFeedbackSpatialKindGeometry(input.item.kind, geometry);
    const label = entry.nextSpatialLabel;
    if (input.item.scope === 'file') {
      return {
        ...entry,
        nextSpatialLabel: label + 1,
        items: [
          ...entry.items,
          {
            id,
            kind: input.item.kind,
            scope: 'file',
            label,
            geometry,
            comment,
            createdAt: updatedAt,
            updatedAt
          }
        ],
        updatedAt
      };
    }
    assertCanvasVideoPlaybackTime(input.item.momentTimeSeconds);
    const { entry: momentEntry, moment } = momentRefForTime(entry, input.item.momentTimeSeconds);
    return {
      ...momentEntry,
      nextSpatialLabel: label + 1,
      items: [
        ...momentEntry.items,
        {
          id,
          kind: input.item.kind,
          scope: 'moment',
          label,
          geometry,
          moment,
          comment,
          createdAt: updatedAt,
          updatedAt
        }
      ],
      updatedAt
    };
  }
  if (input.operation === 'update-item') {
    let changed = false;
    const items = entry.items.map((item) => {
      if (item.id !== input.itemId) {
        return item;
      }
      changed = true;
      const comment = input.comment !== undefined
        ? normalizeCanvasFeedbackComment(input.comment)
        : item.comment;
      if (input.geometry !== undefined) {
        if (!isCanvasFeedbackSpatialItem(item)) {
          throw new Error(`Canvas feedback item is not spatial: ${input.itemId}`);
        }
        const geometry = normalizeCanvasFeedbackGeometry(input.geometry);
        validateCanvasFeedbackSpatialKindGeometry(item.kind, geometry);
        return {
          ...item,
          geometry,
          comment,
          updatedAt
        };
      }
      return {
        ...item,
        comment,
        updatedAt
      };
    });
    if (!changed) {
      throw new Error(`Canvas feedback item not found: ${input.itemId}`);
    }
    return { ...entry, items, updatedAt };
  }
  let removed = false;
  const items = entry.items.filter((item) => {
    if (item.id === input.itemId) {
      removed = true;
      return false;
    }
    return true;
  });
  if (!removed) {
    throw new Error(`Canvas feedback item not found: ${input.itemId}`);
  }
  return { ...entry, items, updatedAt };
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

export function normalizeCanvasVideoPlaybackTime(currentTimeSeconds: number): number {
  assertCanvasVideoPlaybackTime(currentTimeSeconds);
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
  const nextMomentLabel = isRecord(value) ? value.nextMomentLabel : undefined;
  const nextSpatialLabel = isRecord(value) ? value.nextSpatialLabel : undefined;
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['projectRelativePath', 'marks', 'nextMomentLabel', 'nextSpatialLabel', 'items', 'updatedAt'])
    || typeof value.projectRelativePath !== 'string'
    || typeof nextMomentLabel !== 'number'
    || !Number.isInteger(nextMomentLabel)
    || nextMomentLabel <= 0
    || typeof nextSpatialLabel !== 'number'
    || !Number.isInteger(nextSpatialLabel)
    || nextSpatialLabel <= 0
    || !Array.isArray(value.items)
    || typeof value.updatedAt !== 'string') {
    throw new Error('Invalid Canvas feedback entry.');
  }
  assertIsoDateTime(value.updatedAt, 'Canvas feedback entry updatedAt must be an ISO date-time string.');
  const items = value.items.map(normalizeCanvasFeedbackItem);
  assertUniqueCanvasFeedbackItemIds(items);
  assertUniqueCanvasFeedbackSpatialLabels(items);
  assertConsistentCanvasFeedbackMoments(items);
  const maxMomentLabel = Math.max(0, ...items.map((item) => item.scope === 'moment' ? momentLabelNumber(item.moment.label) : 0));
  const maxSpatialLabel = Math.max(0, ...items.map((item) => isCanvasFeedbackSpatialItem(item) ? item.label : 0));
  if (nextMomentLabel <= maxMomentLabel) {
    throw new Error('Canvas feedback nextMomentLabel must exceed existing moment labels.');
  }
  if (nextSpatialLabel <= maxSpatialLabel) {
    throw new Error('Canvas feedback nextSpatialLabel must exceed existing spatial labels.');
  }
  return {
    projectRelativePath: normalizeCanvasFeedbackProjectRelativePath(value.projectRelativePath),
    marks: normalizeCanvasFeedbackMarks(value.marks),
    nextMomentLabel,
    nextSpatialLabel,
    items,
    updatedAt: value.updatedAt
  };
}

function normalizeCanvasFeedbackItem(value: unknown): CanvasFeedbackItem {
  if (!isRecord(value)
    || typeof value.kind !== 'string'
    || typeof value.scope !== 'string'
    || typeof value.id !== 'string'
    || !value.id.trim()
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string') {
    throw new Error('Invalid Canvas feedback item.');
  }
  assertIsoDateTime(value.createdAt, 'Canvas feedback item createdAt must be an ISO date-time string.');
  assertIsoDateTime(value.updatedAt, 'Canvas feedback item updatedAt must be an ISO date-time string.');
  const base = {
    id: value.id.trim(),
    comment: normalizeCanvasFeedbackComment(value.comment),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
  if (value.kind === 'comment' && value.scope === 'file') {
    if (!hasOnlyKeys(value, ['id', 'kind', 'scope', 'comment', 'createdAt', 'updatedAt'])) {
      throw new Error('Invalid Canvas feedback item.');
    }
    return { ...base, kind: 'comment', scope: 'file' };
  }
  if (value.kind === 'comment' && value.scope === 'moment') {
    if (!hasOnlyKeys(value, ['id', 'kind', 'scope', 'moment', 'comment', 'createdAt', 'updatedAt'])) {
      throw new Error('Invalid Canvas feedback item.');
    }
    return {
      ...base,
      kind: 'comment',
      scope: 'moment',
      moment: normalizeCanvasFeedbackMomentRef(value.moment)
    };
  }
  if ((value.kind === 'pin' || value.kind === 'region') && (value.scope === 'file' || value.scope === 'moment')) {
    const label = value.label;
    if (typeof label !== 'number' || !Number.isInteger(label) || label <= 0) {
      throw new Error('Invalid Canvas feedback item.');
    }
    const geometry = normalizeCanvasFeedbackGeometry(value.geometry);
    validateCanvasFeedbackSpatialKindGeometry(value.kind, geometry);
    if (value.scope === 'file') {
      if (!hasOnlyKeys(value, ['id', 'kind', 'scope', 'label', 'geometry', 'comment', 'createdAt', 'updatedAt'])) {
        throw new Error('Invalid Canvas feedback item.');
      }
      return {
        ...base,
        kind: value.kind,
        scope: 'file',
        label,
        geometry
      };
    }
    if (!hasOnlyKeys(value, ['id', 'kind', 'scope', 'label', 'geometry', 'moment', 'comment', 'createdAt', 'updatedAt'])) {
      throw new Error('Invalid Canvas feedback item.');
    }
    return {
      ...base,
      kind: value.kind,
      scope: 'moment',
      label,
      geometry,
      moment: normalizeCanvasFeedbackMomentRef(value.moment)
    };
  }
  throw new Error('Invalid Canvas feedback item.');
}

function normalizeCanvasFeedbackMomentRef(value: unknown): CanvasFeedbackMomentRef {
  if (!isRecord(value) || typeof value.label !== 'string' || typeof value.currentTimeSeconds !== 'number') {
    throw new Error('Invalid Canvas feedback moment.');
  }
  const labelNumber = momentLabelNumber(value.label);
  assertCanvasVideoPlaybackTime(value.currentTimeSeconds);
  return {
    label: `M${labelNumber}`,
    currentTimeSeconds: normalizeCanvasVideoPlaybackTime(value.currentTimeSeconds)
  };
}

function momentLabelNumber(label: string): number {
  const match = /^M([1-9][0-9]*)$/.exec(label);
  if (!match) {
    throw new Error(`Invalid Canvas feedback moment label: ${label}`);
  }
  return Number(match[1]);
}

function isCanvasFeedbackSpatialItem(item: CanvasFeedbackItem): item is CanvasFeedbackSpatialItem {
  return item.kind === 'pin' || item.kind === 'region';
}

function assertUniqueCanvasFeedbackItemIds(items: CanvasFeedbackItem[]): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) {
      throw new Error('Canvas feedback item ids must be unique.');
    }
    ids.add(item.id);
  }
}

function assertUniqueCanvasFeedbackSpatialLabels(items: CanvasFeedbackItem[]): void {
  const labels = new Set<number>();
  for (const item of items) {
    if (!isCanvasFeedbackSpatialItem(item)) {
      continue;
    }
    if (labels.has(item.label)) {
      throw new Error('Canvas feedback spatial labels must be unique.');
    }
    labels.add(item.label);
  }
}

function assertConsistentCanvasFeedbackMoments(items: CanvasFeedbackItem[]): void {
  const labelByTime = new Map<number, string>();
  const timeByLabel = new Map<string, number>();
  for (const item of items) {
    if (item.scope !== 'moment') {
      continue;
    }
    const existingLabel = labelByTime.get(item.moment.currentTimeSeconds);
    if (existingLabel !== undefined && existingLabel !== item.moment.label) {
      throw new Error('Canvas feedback moment times must use one label per timestamp.');
    }
    const existingTime = timeByLabel.get(item.moment.label);
    if (existingTime !== undefined && existingTime !== item.moment.currentTimeSeconds) {
      throw new Error('Canvas feedback moment labels must use one timestamp per label.');
    }
    labelByTime.set(item.moment.currentTimeSeconds, item.moment.label);
    timeByLabel.set(item.moment.label, item.moment.currentTimeSeconds);
  }
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

function validateCanvasFeedbackSpatialKindGeometry(kind: CanvasFeedbackSpatialItem['kind'], geometry: CanvasFeedbackGeometry): void {
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
