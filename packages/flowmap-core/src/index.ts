import { createHash } from 'node:crypto';
import { parseDocument, stringify } from 'yaml';

export const FLOWMAP_SCHEMA_VERSION = 1;

export interface FlowmapDocument {
  schemaVersion: 1;
  axis?: {
    managed?: boolean;
    publishedAt?: string;
    sourceDraft?: string;
    contentHash?: string;
  };
  flowmapId: string;
  canvases: string[];
  include: string[];
  layout?: FlowmapLayout;
}

export interface FlowmapLayoutGroup {
  directory: string;
  include: string[];
}

export interface FlowmapLayout {
  groups: FlowmapLayoutGroup[];
}

export interface FlowmapParseInput {
  sourceDraftPath: string;
  content: string;
}

export interface FlowmapPublishInput extends FlowmapParseInput {
  now?: () => string;
}

export interface PublishedFlowmap {
  flowmapId: string;
  activePath: string;
  sourceDraftPath: string;
  rootProjectRelativePath: string;
  canvasIds: string[];
  yaml: string;
  map: FlowmapDocument;
}

export interface FlowmapIntegrityResult {
  ok: boolean;
  map?: FlowmapDocument;
  error?: {
    code: 'flowmap_unmanaged' | 'flowmap_hash_mismatch' | 'flowmap_invalid_yaml' | 'flowmap_source_mismatch';
    message: string;
    line?: number;
    column?: number;
  };
}

export interface FlowmapProjectEntry {
  projectRelativePath: string;
  kind: 'file' | 'directory';
}

export type FlowmapNodeKind = 'directory' | 'file';

export interface FlowmapNodeProjection {
  projectRelativePath: string;
  nodeKind: FlowmapNodeKind;
}

export interface FlowmapStructureEdgeProjection {
  id: string;
  sourceProjectRelativePath: string;
  targetProjectRelativePath: string;
}

export interface ExpandedFlowmapLayoutGroup {
  parentProjectRelativePath: string;
  memberProjectRelativePaths: string[];
}

export interface ExpandedFlowmapLayoutGroupError {
  code: 'flowmap_layout_group_duplicate_match';
  message: string;
  projectRelativePath: string;
}

export interface ExpandedFlowmap {
  flowmapId: string;
  rootProjectRelativePath: string;
  canvases: string[];
  nodes: FlowmapNodeProjection[];
  edges: FlowmapStructureEdgeProjection[];
  layoutGroups: ExpandedFlowmapLayoutGroup[];
  layoutGroupErrors: ExpandedFlowmapLayoutGroupError[];
}

export class FlowmapError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'flowmap_invalid_yaml'
      | 'flowmap_invalid_id'
      | 'flowmap_invalid_draft_path'
      | 'flowmap_draft_read_failed'
      | 'flowmap_write_failed' = 'flowmap_invalid_yaml',
    readonly line?: number,
    readonly column?: number
  ) {
    super(message);
    this.name = 'FlowmapError';
  }
}

export function inferFlowmapIdFromDraftPath(sourceDraftPath: string): string {
  const normalized = normalizeStrictProjectPath(sourceDraftPath);
  const match = /^\.axis\/flowmaps\/([^/]+)\.draft\.yaml$/.exec(normalized);
  if (!match) {
    throw new FlowmapError(
      'Flowmap draft path must be ".axis/flowmaps/<flowmap-id>.draft.yaml".',
      'flowmap_invalid_draft_path'
    );
  }
  assertValidFlowmapId(match[1]!);
  return match[1]!;
}

export function inferFlowmapIdFromActivePath(activePath: string): string {
  const normalized = normalizeStrictProjectPath(activePath);
  const match = /^\.axis\/flowmaps\/([^/]+)\.yaml$/.exec(normalized);
  if (!match || normalized.endsWith('.draft.yaml')) {
    throw new FlowmapError('Flowmap active path must be ".axis/flowmaps/<flowmap-id>.yaml".', 'flowmap_invalid_draft_path');
  }
  assertValidFlowmapId(match[1]!);
  return match[1]!;
}

export function activeFlowmapPath(flowmapId: string): string {
  assertValidFlowmapId(flowmapId);
  return `.axis/flowmaps/${flowmapId}.yaml`;
}

export function draftFlowmapPath(flowmapId: string): string {
  assertValidFlowmapId(flowmapId);
  return `.axis/flowmaps/${flowmapId}.draft.yaml`;
}

export function assertValidFlowmapId(value: string): void {
  if (!isValidSafeId(value)) {
    throw new FlowmapError('Flowmap id must be a valid id.', 'flowmap_invalid_id');
  }
}

export function assertValidCanvasId(value: string): void {
  if (!isValidSafeId(value)) {
    throw new FlowmapError('Flowmap canvas id must be a valid id.', 'flowmap_invalid_yaml');
  }
}

export function parseFlowmapDraft(input: FlowmapParseInput): FlowmapDocument {
  return validateFlowmapDocument(parseYamlObject(input.content), inferFlowmapIdFromDraftPath(input.sourceDraftPath));
}

export function parseActiveFlowmap(input: { activePath: string; content: string }): FlowmapDocument {
  return validateFlowmapDocument(parseYamlObject(input.content), inferFlowmapIdFromActivePath(input.activePath));
}

export function publishFlowmap(input: FlowmapPublishInput): PublishedFlowmap {
  const draft = parseFlowmapDraft(input);
  const withoutHash: FlowmapDocument = {
    schemaVersion: FLOWMAP_SCHEMA_VERSION,
    axis: {
      managed: true,
      publishedAt: input.now?.() ?? new Date().toISOString(),
      sourceDraft: draftFlowmapPath(draft.flowmapId)
    },
    flowmapId: draft.flowmapId,
    canvases: draft.canvases,
    include: draft.include,
    ...(draft.layout ? { layout: draft.layout } : {})
  };
  const published: FlowmapDocument = {
    ...withoutHash,
    axis: {
      ...withoutHash.axis,
      contentHash: flowmapContentHash(withoutHash)
    }
  };
  return {
    flowmapId: published.flowmapId,
    activePath: activeFlowmapPath(published.flowmapId),
    sourceDraftPath: draftFlowmapPath(published.flowmapId),
    rootProjectRelativePath: published.flowmapId,
    canvasIds: published.canvases,
    yaml: ensureTrailingNewline(stringify(flowmapYamlShape(published), { sortMapEntries: false })),
    map: published
  };
}

export function assertPublishedFlowmap(content: string, activePath: string): FlowmapIntegrityResult {
  let map: FlowmapDocument;
  try {
    map = parseActiveFlowmap({ activePath, content });
  } catch (error) {
    if (error instanceof FlowmapError) {
      return {
        ok: false,
        error: {
          code: 'flowmap_invalid_yaml',
          message: error.message,
          ...(error.line === undefined ? {} : { line: error.line }),
          ...(error.column === undefined ? {} : { column: error.column })
        }
      };
    }
    return { ok: false, error: { code: 'flowmap_invalid_yaml', message: errorMessage(error) } };
  }
  if (map.axis?.managed !== true) {
    return { ok: false, error: { code: 'flowmap_unmanaged', message: 'Flowmap is not AXIS-managed.' } };
  }
  if (map.axis.sourceDraft !== draftFlowmapPath(map.flowmapId)) {
    return {
      ok: false,
      error: {
        code: 'flowmap_source_mismatch',
        message: `Flowmap source draft does not match active Flowmap id: ${draftFlowmapPath(map.flowmapId)}`
      }
    };
  }
  const actualHash = map.axis.contentHash;
  if (!actualHash) {
    return { ok: false, error: { code: 'flowmap_hash_mismatch', message: 'Flowmap content hash is missing.' } };
  }
  const { contentHash: _contentHash, ...axisWithoutHash } = map.axis;
  const expectedHash = flowmapContentHash({
    ...map,
    axis: axisWithoutHash
  });
  if (actualHash !== expectedHash) {
    return { ok: false, error: { code: 'flowmap_hash_mismatch', message: 'Flowmap content hash does not match.' } };
  }
  return { ok: true, map };
}

export function expandFlowmap(map: FlowmapDocument, entries: FlowmapProjectEntry[]): ExpandedFlowmap {
  const root = map.flowmapId;
  const filePaths = entries
    .filter((entry) => entry.kind === 'file')
    .map((entry) => normalizeProjectPath(entry.projectRelativePath))
    .filter((path) => path.startsWith(`${root}/`))
    .sort(compareProjectPath);
  const rootRelativeFiles = filePaths.map((path) => path.slice(root.length + 1));
  const includedRootRelativeFiles = expandInclude(map.include, rootRelativeFiles);
  const nodeByPath = new Map<string, FlowmapNodeProjection>();
  for (const rootRelativeFile of includedRootRelativeFiles) {
    const projectPath = `${root}/${rootRelativeFile}`;
    addAncestors(nodeByPath, root, projectPath);
    nodeByPath.set(projectPath, { projectRelativePath: projectPath, nodeKind: 'file' });
  }
  const nodes = [...nodeByPath.values()].sort(compareNodesByTreeOrder);
  const expandedGroups = expandLayoutGroups(root, map.layout?.groups ?? [], includedRootRelativeFiles);
  return {
    flowmapId: map.flowmapId,
    rootProjectRelativePath: root,
    canvases: map.canvases,
    nodes,
    edges: structureEdgesForNodes(nodes),
    layoutGroups: expandedGroups.layoutGroups,
    layoutGroupErrors: expandedGroups.layoutGroupErrors
  };
}

function validateFlowmapDocument(value: unknown, flowmapId: string): FlowmapDocument {
  if (!isRecord(value)) {
    throw invalid('Flowmap YAML must be an object.');
  }
  assertOnlyKeys(value, ['schemaVersion', 'axis', 'canvases', 'include', 'layout']);
  if (value.schemaVersion !== FLOWMAP_SCHEMA_VERSION) {
    throw invalid(`Unsupported Flowmap schemaVersion ${String(value.schemaVersion)}.`);
  }
  if (!Array.isArray(value.include) || !value.include.every((item) => typeof item === 'string')) {
    throw invalid('Flowmap include must be a string array.');
  }
  const canvases = value.canvases === undefined ? [] : value.canvases;
  if (!Array.isArray(canvases) || !canvases.every((item) => typeof item === 'string')) {
    throw invalid('Flowmap canvases must be a string array.');
  }
  for (const canvasId of canvases) {
    assertValidCanvasId(canvasId);
  }
  const axis = value.axis === undefined ? undefined : validateAxis(value.axis);
  const layout = value.layout === undefined ? undefined : validateLayout(value.layout);
  return {
    schemaVersion: FLOWMAP_SCHEMA_VERSION,
    ...(axis ? { axis } : {}),
    flowmapId,
    canvases: canvases.map((item) => item),
    include: value.include.map((item) => item),
    ...(layout && layout.groups.length > 0 ? { layout } : {})
  };
}

function validateLayout(value: unknown): FlowmapLayout {
  if (!isRecord(value)) {
    throw invalid('Flowmap layout must be an object.');
  }
  assertOnlyKeys(value, ['groups'], 'layout');
  const groups = value.groups === undefined ? [] : value.groups;
  if (!Array.isArray(groups)) {
    throw invalid('Flowmap layout.groups must be an array.');
  }
  return {
    groups: groups.map(validateLayoutGroup)
  };
}

function validateLayoutGroup(value: unknown): FlowmapLayoutGroup {
  if (!isRecord(value)) {
    throw invalid('Flowmap layout group must be an object.');
  }
  assertOnlyKeys(value, ['directory', 'include'], 'layout group');
  if (!Array.isArray(value.include) || value.include.length === 0 || !value.include.every((item) => typeof item === 'string')) {
    throw invalid('Flowmap layout group include must be a non-empty string array.');
  }
  return {
    directory: normalizeLayoutGroupDirectory(stringField(value.directory, 'layout.groups[].directory')),
    include: value.include.map(normalizeLayoutGroupInclude)
  };
}

function normalizeLayoutGroupDirectory(value: string): string {
  const normalized = normalizeProjectPath(value);
  const parts = normalized.split('/');
  if (!normalized
    || normalized.startsWith('/')
    || /^[A-Za-z]:/.test(normalized)
    || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw invalid('Flowmap layout group directory must be a safe relative path.');
  }
  return normalized;
}

function normalizeLayoutGroupInclude(value: string): string {
  const normalized = normalizeProjectPath(value);
  if (!normalized || normalized.includes('/')) {
    throw invalid('Flowmap layout group include patterns must match direct child filenames.');
  }
  return normalized;
}

function validateAxis(value: unknown): FlowmapDocument['axis'] {
  if (!isRecord(value)) {
    throw invalid('Flowmap axis metadata must be an object.');
  }
  assertOnlyKeys(value, ['managed', 'publishedAt', 'sourceDraft', 'contentHash'], 'axis');
  if (value.managed !== undefined && typeof value.managed !== 'boolean') {
    throw invalid('Flowmap axis.managed must be a boolean.');
  }
  return {
    ...(value.managed === undefined ? {} : { managed: value.managed }),
    ...(value.publishedAt === undefined ? {} : { publishedAt: stringField(value.publishedAt, 'axis.publishedAt') }),
    ...(value.sourceDraft === undefined ? {} : { sourceDraft: stringField(value.sourceDraft, 'axis.sourceDraft') }),
    ...(value.contentHash === undefined ? {} : { contentHash: stringField(value.contentHash, 'axis.contentHash') })
  };
}

function flowmapYamlShape(map: FlowmapDocument): Record<string, unknown> {
  return {
    schemaVersion: map.schemaVersion,
    ...(map.axis ? { axis: map.axis } : {}),
    canvases: map.canvases,
    include: map.include,
    ...(map.layout ? { layout: map.layout } : {})
  };
}

function flowmapContentHash(map: FlowmapDocument): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(flowmapYamlShape(map))).digest('hex')}`;
}

function parseYamlObject(content: string): unknown {
  const document = parseDocument(content, { prettyErrors: false });
  if (document.errors[0]) {
    const error = document.errors[0];
    const position = error.linePos?.[0];
    throw new FlowmapError(
      error.message,
      'flowmap_invalid_yaml',
      position?.line,
      position?.col
    );
  }
  return document.toJSON();
}

function expandInclude(include: string[], rootRelativeFiles: string[]): string[] {
  const existingFiles = new Set(rootRelativeFiles);
  const matched = new Set<string>();
  for (const rawPattern of include) {
    const pattern = normalizeProjectPath(rawPattern);
    if (existingFiles.has(pattern)) {
      matched.add(pattern);
      continue;
    }
    const isMatch = controlledGlobMatcher(pattern);
    for (const file of rootRelativeFiles) {
      if (isMatch(file)) {
        matched.add(file);
      }
    }
  }
  return [...matched].sort(compareProjectPath);
}

function expandLayoutGroups(
  root: string,
  groups: FlowmapLayoutGroup[],
  includedRootRelativeFiles: string[]
): { layoutGroups: ExpandedFlowmapLayoutGroup[]; layoutGroupErrors: ExpandedFlowmapLayoutGroupError[] } {
  const matchedByFile = new Map<string, number>();
  const layoutGroups: ExpandedFlowmapLayoutGroup[] = [];
  const layoutGroupErrors: ExpandedFlowmapLayoutGroupError[] = [];
  for (const [groupIndex, group] of groups.entries()) {
    const matchers = group.include.map(controlledGlobMatcher);
    const memberRootRelativePaths = includedRootRelativeFiles.filter((file) => isDirectChildOfDirectory(file, group.directory)
      && matchers.some((matches) => matches(basename(file))));
    if (memberRootRelativePaths.length === 0) {
      continue;
    }
    for (const file of memberRootRelativePaths) {
      const previousGroupIndex = matchedByFile.get(file);
      if (previousGroupIndex !== undefined && previousGroupIndex !== groupIndex) {
        const projectRelativePath = `${root}/${file}`;
        layoutGroupErrors.push({
          code: 'flowmap_layout_group_duplicate_match',
          message: `Flowmap layout groups match the same file more than once: ${projectRelativePath}`,
          projectRelativePath
        });
      }
      matchedByFile.set(file, groupIndex);
    }
    layoutGroups.push({
      parentProjectRelativePath: `${root}/${group.directory}`,
      memberProjectRelativePaths: memberRootRelativePaths.map((file) => `${root}/${file}`)
    });
  }
  return layoutGroupErrors.length > 0
    ? { layoutGroups: [], layoutGroupErrors }
    : { layoutGroups, layoutGroupErrors };
}

function isDirectChildOfDirectory(file: string, directory: string): boolean {
  if (!file.startsWith(`${directory}/`)) {
    return false;
  }
  return !file.slice(directory.length + 1).includes('/');
}

function controlledGlobMatcher(pattern: string): (value: string) => boolean {
  const expression = new RegExp(`^${globPatternToRegExpSource(pattern)}$`);
  return (value) => expression.test(value);
}

function globPatternToRegExpSource(pattern: string): string {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:.*\\/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += escapeRegExp(char);
  }
  return source;
}

function addAncestors(nodeByPath: Map<string, FlowmapNodeProjection>, root: string, projectPath: string): void {
  nodeByPath.set(root, { projectRelativePath: root, nodeKind: 'directory' });
  const parts = projectPath.split('/');
  let current = root;
  for (const part of parts.slice(1, -1)) {
    current = `${current}/${part}`;
    nodeByPath.set(current, { projectRelativePath: current, nodeKind: 'directory' });
  }
}

function structureEdgesForNodes(nodes: FlowmapNodeProjection[]): FlowmapStructureEdgeProjection[] {
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

function parentPath(path: string): string | undefined {
  const index = path.lastIndexOf('/');
  return index > 0 ? path.slice(0, index) : undefined;
}

function basename(path: string): string {
  const index = path.lastIndexOf('/');
  return index >= 0 ? path.slice(index + 1) : path;
}

function compareNodesByTreeOrder(left: FlowmapNodeProjection, right: FlowmapNodeProjection): number {
  const leftParts = left.projectRelativePath.split('/');
  const rightParts = right.projectRelativePath.split('/');
  const length = Math.min(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    if (leftParts[index] === rightParts[index]) {
      continue;
    }
    const leftKind = index === leftParts.length - 1 ? left.nodeKind : 'directory';
    const rightKind = index === rightParts.length - 1 ? right.nodeKind : 'directory';
    if (leftKind !== rightKind) {
      return leftKind === 'directory' ? -1 : 1;
    }
    return leftParts[index]!.localeCompare(rightParts[index]!, undefined, { numeric: true, sensitivity: 'base' });
  }
  return leftParts.length - rightParts.length;
}

function compareProjectPath(left: string, right: string): number {
  const leftParts = left.split('/');
  const rightParts = right.split('/');
  const length = Math.min(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = leftParts[index]!.localeCompare(rightParts[index]!, undefined, { numeric: true, sensitivity: 'base' });
    if (comparison !== 0) {
      return comparison;
    }
  }
  return leftParts.length - rightParts.length;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[], prefix?: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw invalid(prefix ? `Unsupported Flowmap ${prefix} field "${key}".` : `Unsupported Flowmap field "${key}".`);
    }
  }
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw invalid(`Flowmap ${field} must be a string.`);
  }
  return value;
}

function isValidSafeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) && value !== '.' && value !== '..';
}

function normalizeProjectPath(projectRelativePath: string): string {
  return projectRelativePath.replaceAll('\\', '/');
}

function normalizeStrictProjectPath(projectRelativePath: string): string {
  const normalized = normalizeProjectPath(projectRelativePath);
  const parts = normalized.split('/');
  if (!normalized
    || normalized.startsWith('/')
    || /^[A-Za-z]:/.test(normalized)
    || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new FlowmapError('Flowmap path must be a safe relative project path.', 'flowmap_invalid_draft_path');
  }
  return normalized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

function invalid(message: string): FlowmapError {
  return new FlowmapError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
