import { layoutCanvasDesiredNodes } from './canvasAutoLayout.js';

export const CANVAS_DOCUMENT_SCHEMA_VERSION = 1;

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
  schemaVersion: typeof CANVAS_DOCUMENT_SCHEMA_VERSION;
  id: string;
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

export interface CanvasStructureEdgeProjection {
  id: string;
  sourceProjectRelativePath: string;
  targetProjectRelativePath: string;
}

export interface ProjectedCanvasNode extends CanvasNodeElement {
  availability: CanvasNodeAvailability;
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

export const CANVAS_FEEDBACK_SCHEMA_VERSION = 1;

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

export interface CanvasFeedbackEntry {
  projectRelativePath: string;
  marks: CanvasFeedbackMark[];
  note: string;
  updatedAt: string;
}

export interface CanvasFeedbackDocument {
  schemaVersion: 1;
  updatedAt: string;
  entries: Record<string, CanvasFeedbackEntry>;
}

export interface UpdateCanvasFeedbackEntryInput {
  projectRelativePath: string;
  marks: CanvasFeedbackMark[];
  note: string;
}

const CANVAS_FEEDBACK_MARK_ORDER = new Map<string, number>(
  CANVAS_FEEDBACK_MARKS.map((mark, index) => [mark, index])
);

export function createEmptyCanvasFeedbackDocument(updatedAt: string): CanvasFeedbackDocument {
  assertIsoDateTime(updatedAt, 'Canvas feedback updatedAt must be an ISO date-time string.');
  return {
    schemaVersion: CANVAS_FEEDBACK_SCHEMA_VERSION,
    updatedAt,
    entries: {}
  };
}

export function normalizeCanvasFeedbackDocument(value: unknown): CanvasFeedbackDocument {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['schemaVersion', 'updatedAt', 'entries'])
    || value.schemaVersion !== CANVAS_FEEDBACK_SCHEMA_VERSION
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
    if (normalizedEntry.marks.length > 0 || normalizedEntry.note.length > 0) {
      entries[normalizedKey] = normalizedEntry;
    }
  }
  return {
    schemaVersion: CANVAS_FEEDBACK_SCHEMA_VERSION,
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
  const marks = normalizeCanvasFeedbackMarks(input.marks);
  const note = input.note.trim();
  assertIsoDateTime(updatedAt, 'Canvas feedback updatedAt must be an ISO date-time string.');
  const entries = { ...normalizedDocument.entries };
  if (marks.length === 0 && note.length === 0) {
    delete entries[projectRelativePath];
  } else {
    entries[projectRelativePath] = {
      projectRelativePath,
      marks,
      note,
      updatedAt
    };
  }
  return {
    schemaVersion: CANVAS_FEEDBACK_SCHEMA_VERSION,
    updatedAt,
    entries
  };
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
  return normalized;
}

export function createCanvasDocument(input: { id: string }): CanvasDocument {
  const id = assertCanvasDocumentId(input.id);
  return {
    schemaVersion: CANVAS_DOCUMENT_SCHEMA_VERSION,
    id,
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
    if (!parent || !existing.has(parent)) {
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
  const index = path.lastIndexOf('/');
  return index > 0 ? path.slice(0, index) : undefined;
}

function normalizeCanvasFeedbackEntry(value: unknown): CanvasFeedbackEntry {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['projectRelativePath', 'marks', 'note', 'updatedAt'])
    || typeof value.projectRelativePath !== 'string'
    || typeof value.note !== 'string'
    || typeof value.updatedAt !== 'string') {
    throw new Error('Invalid Canvas feedback entry.');
  }
  assertIsoDateTime(value.updatedAt, 'Canvas feedback entry updatedAt must be an ISO date-time string.');
  return {
    projectRelativePath: normalizeCanvasFeedbackProjectRelativePath(value.projectRelativePath),
    marks: normalizeCanvasFeedbackMarks(value.marks),
    note: value.note.trim(),
    updatedAt: value.updatedAt
  };
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
