export const CANVAS_DOCUMENT_SCHEMA_VERSION = 1;
export const CANVAS_IMAGE_PREVIEW_WIDTH_BUCKETS = [256, 512, 1024, 2048] as const;
export const CANVAS_IMAGE_PREVIEW_MIN_SOURCE_BYTES = 1.5 * 1024 * 1024;

export type CanvasImagePreviewWidth = typeof CANVAS_IMAGE_PREVIEW_WIDTH_BUCKETS[number];
export type CanvasNodeKind = 'directory' | 'file';
export type CanvasMediaKind = 'image' | 'video' | 'audio' | 'text' | 'unknown';
export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  id: string;
  source: 'project' | 'canvas' | 'capability' | 'settings' | 'generated_asset' | 'flowmap';
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
  visible: boolean;
  locked: boolean;
  layoutMode?: 'manual';
}

export interface CanvasNodeLayerPatch {
  projectRelativePath: string;
  z?: number;
  visible?: boolean;
  locked?: boolean;
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
  title: string;
  nodeElements: CanvasNodeElement[];
  annotations: CanvasAnnotation[];
  preferences: {
    showDiagnostics: boolean;
  };
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
  structureEdges?: CanvasStructureEdgeProjection[];
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

export interface CanvasDesiredLayoutGroup {
  parentProjectRelativePath: string;
  memberProjectRelativePaths: string[];
}

export interface ReconcileCanvasNodeElementsInput {
  existing: CanvasNodeElement[];
  desired: CanvasDesiredNode[];
  layoutGroups?: CanvasDesiredLayoutGroup[];
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

const HORIZONTAL_TREE_GAP = 100;
const VERTICAL_GAP = 80;
const HORIZONTAL_GROUP_GAP = VERTICAL_GAP;
const ROOT_HORIZONTAL_GAP = 180;

type CanvasLayoutBlock =
  | { kind: 'node'; node: CanvasDesiredNode }
  | { kind: 'horizontal-group'; members: CanvasDesiredNode[] };

interface CanvasLayoutBounds {
  maxDepth: number;
  rightEdge: number;
}

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

export function createCanvasDocument(input: { id: string; title: string }): CanvasDocument {
  return {
    schemaVersion: CANVAS_DOCUMENT_SCHEMA_VERSION,
    id: input.id,
    title: input.title,
    nodeElements: [],
    annotations: [],
    preferences: {
      showDiagnostics: true
    }
  };
}

export function projectCanvas(input: ProjectCanvasInput): CanvasProjection {
  return {
    canvasId: input.canvas.id,
    nodes: sortedCanvasNodeElements(input.canvas.nodeElements).map((node) => ({
      ...node,
      availability: input.nodeAvailability(node)
    })),
    edges: input.structureEdges ?? [],
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
      return layout && !nodeElement.locked
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

export function updateCanvasNodeLayers(
  canvas: CanvasDocument,
  input: {
    nodeLayers?: CanvasNodeLayerPatch[];
    nodeProjectRelativePathsTopFirst?: string[];
  }
): CanvasDocument {
  const patchesByPath = new Map((input.nodeLayers ?? []).map((patch) => [patch.projectRelativePath, patch]));
  const patched = canvas.nodeElements.map((nodeElement) => {
    const patch = patchesByPath.get(nodeElement.projectRelativePath);
    if (!patch) {
      return nodeElement;
    }
    return {
      ...nodeElement,
      ...(patch.visible === undefined ? {} : { visible: patch.visible }),
      ...(patch.locked === undefined ? {} : { locked: patch.locked }),
      ...(patch.z === undefined || nodeElement.locked ? {} : { z: patch.z })
    };
  });
  return {
    ...canvas,
    nodeElements: input.nodeProjectRelativePathsTopFirst
      ? reorderCanvasNodeElementsTopFirst(patched, input.nodeProjectRelativePathsTopFirst)
      : patched
  };
}

export function canvasNodeLayerOrderTopFirst(canvas: Pick<CanvasDocument, 'nodeElements'>): string[] {
  return [...canvas.nodeElements]
    .sort((left, right) => compareNodeZ(right, left))
    .map((nodeElement) => nodeElement.projectRelativePath);
}

export function reconcileCanvasNodeElements(input: ReconcileCanvasNodeElementsInput): CanvasNodeElement[] {
  const desired = sortDesiredNodes(input.desired);
  const layoutByPath = compactTreeLayout(desired, input.layoutSizeForNode, input.layoutGroups ?? []);
  const existingByPath = new Map(input.existing.map((node) => [node.projectRelativePath, node]));
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
    const layout = layoutByPath.get(desiredNode.projectRelativePath);
    if (!layout) {
      throw new Error(`Canvas node layout is missing: ${desiredNode.projectRelativePath}`);
    }
    const base = {
      projectRelativePath: desiredNode.projectRelativePath,
      nodeKind: desiredNode.nodeKind,
      ...(desiredNode.mediaKind ? { mediaKind: desiredNode.mediaKind } : {}),
      z: preservedZByPath.get(desiredNode.projectRelativePath) ?? allocateNewZ(),
      visible: existing?.visible ?? true,
      locked: existing?.locked ?? false
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
  const movablePaths = projectRelativePathsTopFirst.filter((path) => nodeElements.some((node) => node.projectRelativePath === path && !node.locked));
  if (movablePaths.length === 0) {
    return nodeElements;
  }
  const lockedZ = new Set(nodeElements.filter((node) => node.locked).map((node) => node.z));
  const requested = [...new Set(movablePaths)];
  const requestedSet = new Set(requested);
  const remaining = [...nodeElements]
    .filter((node) => !node.locked && !requestedSet.has(node.projectRelativePath))
    .sort((left, right) => compareNodeZ(right, left))
    .map((node) => node.projectRelativePath);
  const orderedPathsTopFirst = [...requested, ...remaining];
  const availableZ: number[] = [];
  for (let nextZ = 0; availableZ.length < orderedPathsTopFirst.length; nextZ += 1) {
    if (!lockedZ.has(nextZ)) {
      availableZ.push(nextZ);
    }
  }
  const zByPath = new Map<string, number>();
  for (const [index, path] of [...orderedPathsTopFirst].reverse().entries()) {
    zByPath.set(path, availableZ[index]!);
  }
  return nodeElements.map((node) => {
    if (node.locked) {
      return node;
    }
    const z = zByPath.get(node.projectRelativePath);
    return z === undefined ? node : { ...node, z };
  });
}

function compactTreeLayout(
  desired: CanvasDesiredNode[],
  layoutSizeForNode: (node: CanvasDesiredNode) => CanvasLayoutSize,
  layoutGroups: CanvasDesiredLayoutGroup[]
): Map<string, CanvasLayoutSize & { x: number; y: number }> {
  const layoutByPath = new Map<string, CanvasLayoutSize & { x: number; y: number }>();
  const desiredByPath = new Map(desired.map((node) => [node.projectRelativePath, node]));
  const childrenByPath = new Map<string, CanvasDesiredNode[]>();
  const roots: CanvasDesiredNode[] = [];
  for (const node of desired) {
    const parent = parentPath(node.projectRelativePath);
    if (parent && desiredByPath.has(parent)) {
      const children = childrenByPath.get(parent) ?? [];
      children.push(node);
      childrenByPath.set(parent, children);
    } else {
      roots.push(node);
    }
  }
  for (const children of childrenByPath.values()) {
    children.sort(compareDesiredSibling);
  }
  roots.sort(compareDesiredSibling);

  const groupsByParent = buildLayoutGroupsByParent(layoutGroups, desiredByPath);
  let rootOffset = 0;
  for (const root of roots) {
    let cursorY = 0;
    const columnOffsets = canvasColumnOffsets(root, rootOffset, childrenByPath, groupsByParent, layoutSizeForNode);
    const bounds = layoutSubtree(root, columnOffsets, 0, () => cursorY, (value) => {
      cursorY = value;
    }, childrenByPath, groupsByParent, layoutSizeForNode, layoutByPath);
    rootOffset = Math.max(
      bounds.rightEdge + ROOT_HORIZONTAL_GAP,
      rootOffset + (bounds.maxDepth + 1) * HORIZONTAL_TREE_GAP + ROOT_HORIZONTAL_GAP
    );
  }
  return layoutByPath;
}

function buildLayoutGroupsByParent(
  layoutGroups: CanvasDesiredLayoutGroup[],
  desiredByPath: Map<string, CanvasDesiredNode>
): Map<string, CanvasDesiredNode[][]> {
  const groupsByParent = new Map<string, CanvasDesiredNode[][]>();
  const used = new Set<string>();
  for (const group of layoutGroups) {
    const directMembers = group.memberProjectRelativePaths
      .map((path) => desiredByPath.get(path))
      .filter((node): node is CanvasDesiredNode => Boolean(node))
      .filter((node) => parentPath(node.projectRelativePath) === group.parentProjectRelativePath && !used.has(node.projectRelativePath))
      .sort(compareDesiredPath);
    if (directMembers.length === 0) {
      continue;
    }
    for (const member of directMembers) {
      used.add(member.projectRelativePath);
    }
    groupsByParent.set(group.parentProjectRelativePath, [
      ...(groupsByParent.get(group.parentProjectRelativePath) ?? []),
      directMembers
    ]);
  }
  return groupsByParent;
}

function layoutSubtree(
  node: CanvasDesiredNode,
  columnOffsets: number[],
  depth: number,
  getCursorY: () => number,
  setCursorY: (value: number) => void,
  childrenByPath: Map<string, CanvasDesiredNode[]>,
  groupsByParent: Map<string, CanvasDesiredNode[][]>,
  layoutSizeForNode: (node: CanvasDesiredNode) => CanvasLayoutSize,
  layoutByPath: Map<string, CanvasLayoutSize & { x: number; y: number }>
): CanvasLayoutBounds {
  const size = layoutSizeForNode(node);
  const blocks = childBlocksForNode(node, childrenByPath, groupsByParent);
  const x = columnOffsets[depth]!;
  if (blocks.length === 0) {
    const y = getCursorY();
    layoutByPath.set(node.projectRelativePath, {
      x,
      y,
      ...size
    });
    setCursorY(y + size.height + VERTICAL_GAP);
    return {
      maxDepth: depth,
      rightEdge: x + size.width
    };
  }

  let maxDepth = depth;
  let rightEdge = x + size.width;
  const childCenters: number[] = [];
  for (const block of blocks) {
    if (block.kind === 'node') {
      const childBounds = layoutSubtree(block.node, columnOffsets, depth + 1, getCursorY, setCursorY, childrenByPath, groupsByParent, layoutSizeForNode, layoutByPath);
      maxDepth = Math.max(maxDepth, childBounds.maxDepth);
      rightEdge = Math.max(rightEdge, childBounds.rightEdge);
      const childLayout = layoutByPath.get(block.node.projectRelativePath)!;
      childCenters.push(childLayout.y + childLayout.height / 2);
      continue;
    }
    const groupLayout = layoutHorizontalGroup(block.members, columnOffsets, depth + 1, getCursorY, setCursorY, layoutSizeForNode, layoutByPath);
    maxDepth = Math.max(maxDepth, groupLayout.maxDepth);
    rightEdge = Math.max(rightEdge, groupLayout.rightEdge);
    childCenters.push(groupLayout.y + groupLayout.height / 2);
  }
  const first = childCenters[0]!;
  const last = childCenters[childCenters.length - 1]!;
  layoutByPath.set(node.projectRelativePath, {
    x,
    y: (first + last) / 2 - size.height / 2,
    ...size
  });
  return {
    maxDepth,
    rightEdge
  };
}

function childBlocksForNode(
  node: CanvasDesiredNode,
  childrenByPath: Map<string, CanvasDesiredNode[]>,
  groupsByParent: Map<string, CanvasDesiredNode[][]>
): CanvasLayoutBlock[] {
  const groups = groupsByParent.get(node.projectRelativePath) ?? [];
  const groupedPaths = new Set(groups.flat().map((member) => member.projectRelativePath));
  const groupBlocks: CanvasLayoutBlock[] = groups.map((members) => ({
    kind: 'horizontal-group',
    members
  }));
  const childBlocks: CanvasLayoutBlock[] = (childrenByPath.get(node.projectRelativePath) ?? [])
    .filter((child) => !groupedPaths.has(child.projectRelativePath))
    .map((child) => ({ kind: 'node', node: child }));
  return [...groupBlocks, ...childBlocks];
}

function layoutHorizontalGroup(
  members: CanvasDesiredNode[],
  columnOffsets: number[],
  depth: number,
  getCursorY: () => number,
  setCursorY: (value: number) => void,
  layoutSizeForNode: (node: CanvasDesiredNode) => CanvasLayoutSize,
  layoutByPath: Map<string, CanvasLayoutSize & { x: number; y: number }>
): { y: number; height: number; maxDepth: number; rightEdge: number } {
  const rowTop = getCursorY();
  const memberLayouts = members.map((member) => ({
    member,
    size: layoutSizeForNode(member)
  }));
  const rowHeight = Math.max(...memberLayouts.map(({ size }) => size.height));
  let cursorX = columnOffsets[depth]!;
  let rightEdge = cursorX;
  for (const { member, size } of memberLayouts) {
    layoutByPath.set(member.projectRelativePath, {
      x: cursorX,
      y: rowTop + (rowHeight - size.height) / 2,
      ...size
    });
    rightEdge = cursorX + size.width;
    cursorX = rightEdge + HORIZONTAL_GROUP_GAP;
  }
  setCursorY(rowTop + rowHeight + VERTICAL_GAP);
  return {
    y: rowTop,
    height: rowHeight,
    maxDepth: depth,
    rightEdge
  };
}

function canvasColumnOffsets(
  root: CanvasDesiredNode,
  rootOffset: number,
  childrenByPath: Map<string, CanvasDesiredNode[]>,
  groupsByParent: Map<string, CanvasDesiredNode[][]>,
  layoutSizeForNode: (node: CanvasDesiredNode) => CanvasLayoutSize
): number[] {
  const widthsByDepth: number[] = [];
  collectCanvasColumnWidths(root, 0, childrenByPath, groupsByParent, layoutSizeForNode, widthsByDepth);
  const offsets: number[] = [rootOffset];
  for (let depth = 1; depth < widthsByDepth.length; depth += 1) {
    offsets[depth] = offsets[depth - 1]! + (widthsByDepth[depth - 1] ?? 0) + HORIZONTAL_TREE_GAP;
  }
  return offsets;
}

function collectCanvasColumnWidths(
  node: CanvasDesiredNode,
  depth: number,
  childrenByPath: Map<string, CanvasDesiredNode[]>,
  groupsByParent: Map<string, CanvasDesiredNode[][]>,
  layoutSizeForNode: (node: CanvasDesiredNode) => CanvasLayoutSize,
  widthsByDepth: number[]
): void {
  const size = layoutSizeForNode(node);
  widthsByDepth[depth] = Math.max(widthsByDepth[depth] ?? 0, size.width);
  for (const block of childBlocksForNode(node, childrenByPath, groupsByParent)) {
    if (block.kind === 'node') {
      collectCanvasColumnWidths(block.node, depth + 1, childrenByPath, groupsByParent, layoutSizeForNode, widthsByDepth);
      continue;
    }
    for (const member of block.members) {
      const memberSize = layoutSizeForNode(member);
      widthsByDepth[depth + 1] = Math.max(widthsByDepth[depth + 1] ?? 0, memberSize.width);
    }
  }
}

function sortDesiredNodes(nodes: CanvasDesiredNode[]): CanvasDesiredNode[] {
  return [...nodes].sort(compareDesiredPath);
}

function compareDesiredSibling(left: CanvasDesiredNode, right: CanvasDesiredNode): number {
  if (left.nodeKind !== right.nodeKind) {
    return left.nodeKind === 'directory' ? -1 : 1;
  }
  return basename(left.projectRelativePath).localeCompare(basename(right.projectRelativePath), undefined, { numeric: true, sensitivity: 'base' });
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

function basename(path: string): string {
  const index = path.lastIndexOf('/');
  return index >= 0 ? path.slice(index + 1) : path;
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
