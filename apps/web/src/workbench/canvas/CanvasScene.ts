import type {
  CanvasMediaKind,
  CanvasNodeKind,
  CanvasResourceView,
  CanvasState,
  CanvasTextViewportState,
  CanvasVideoMetadata,
  CanvasVideoPlaybackState,
  CanvasSourceResolutionResponse,
  ProjectTextLanguageId
} from '@debrute/app-protocol';
import {
  canvasGenericNodeSceneSizes,
  type CanvasGenericIdentityRowMeasurer,
  type CanvasGenericNodeSceneSize
} from './CanvasGenericNodeGeometry.js';
import {
  CANVAS_VIDEO_FALLBACK_CONTENT_SIZE,
  canvasVideoNodeSizeForContent
} from './CanvasNodePresentationGeometry.js';

type CanvasResource = CanvasResourceView['resources'][number];
type CanvasFileResource = Extract<CanvasResource, { nodeKind: 'file' }>;

const TEXT_WIDTH = 4_200;
const TEXT_HEIGHT = 2_800;
const AUDIO_WIDTH = 3_200;
const AUDIO_HEIGHT = 680;
const DEPTH_GAP = 100;
const SIBLING_GAP = 80;

export interface CanvasProjectedRect {
  projectRelativePath: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CanvasProjectedNodeGeometry extends CanvasProjectedRect {
  projectRelativePath: string;
  nodeKind: CanvasNodeKind;
  mediaKind?: CanvasMediaKind;
  z: number;
  layoutMode?: 'manual';
  videoPlayback?: CanvasVideoPlaybackState;
  textViewport?: CanvasTextViewportState;
  automaticLayout?: Readonly<LayoutRect>;
}

interface ProjectedCanvasNodeBase extends CanvasProjectedNodeGeometry {
  displayName: string;
  availability: CanvasFileResource['availability'] | { state: 'directory' };
  imageDimensions?: CanvasFileResource['imageDimensions'];
  textLanguage?: ProjectTextLanguageId;
  videoMetadata?: CanvasVideoMetadata;
  videoTextTracks?: CanvasSourceResolutionResponse['sources'][number]['videoTextTracks'];
}

export type ProjectedCanvasNode = ProjectedCanvasNodeBase & (
  | {
      nodeKind: 'directory';
      folderDisclosure: 'collapsed' | 'disclosed';
    }
  | {
      nodeKind: 'file';
      folderDisclosure?: never;
    }
);

export interface CanvasStructureEdgeProjection {
  id: string;
  sourceProjectRelativePath: string;
  targetProjectRelativePath: string;
}

export interface CanvasProjection {
  nodes: ProjectedCanvasNode[];
  edges: CanvasStructureEdgeProjection[];
  occlusionOrder?: readonly string[];
}

export interface CanvasNodeSceneProjection {
  nodes: ProjectedCanvasNode[];
  occlusionOrder: string[];
}

interface LayoutTreeNode {
  resource: CanvasResource;
  depth: number;
  children: LayoutTreeNode[];
}

interface LayoutSize {
  width: number;
  height: number;
}

interface LayoutRect extends LayoutSize {
  x: number;
  y: number;
}

export interface ProjectCanvasNodeSceneInput {
  canonicalRoot: string;
  resources: CanvasResourceView;
  state: CanvasState;
  videoMetadataByPath?: Readonly<Record<string, {
    sourceRevision: string;
    metadata: CanvasVideoMetadata;
  }>>;
  measureGenericIdentityRows?: CanvasGenericIdentityRowMeasurer;
}

export function projectCanvasNodeScene(
  input: ProjectCanvasNodeSceneInput
): CanvasNodeSceneProjection {
  const nodes = projectCanvasSceneNodes(input);
  const occlusionOrder = reconcileCanvasOcclusionOrder(input.state.occlusionOrder, nodes);
  const zByPath = new Map(occlusionOrder.map((path, index) => [path, nodes.length + index]));
  for (const node of nodes) {
    node.z = zByPath.get(node.projectRelativePath) ?? node.z;
  }
  return {
    nodes,
    occlusionOrder
  };
}

export function projectCanvasSceneNodes(
  input: ProjectCanvasNodeSceneInput
): ProjectedCanvasNode[] {
  const trees = buildLayoutTrees(input.resources.resources);
  const labels = new Map(input.resources.resources.map((resource) => [
    resource.projectRelativePath,
    resourceLabel(resource, input.canonicalRoot)
  ]));
  const disclosedDirectories = new Set(input.state.expandedDirectories);
  const genericSizes = canvasGenericNodeSceneSizes(
    input.resources.resources.flatMap((resource) => (
      resourceUsesGenericGeometry(resource)
        ? [labels.get(resource.projectRelativePath)!]
        : []
    )),
    input.measureGenericIdentityRows
  );
  const sizes = new Map(input.resources.resources.map((resource) => [
    resource.projectRelativePath,
    resourceSize(
      resource,
      labels.get(resource.projectRelativePath)!,
      genericSizes,
      input.videoMetadataByPath?.[resource.projectRelativePath]
    )
  ]));
  const columnWidths: number[] = [];
  for (const tree of trees) {
    collectColumnWidths(tree, sizes, columnWidths);
  }
  const columnOffsets = [0];
  for (let depth = 1; depth < columnWidths.length; depth += 1) {
    columnOffsets.push(columnOffsets[depth - 1]! + columnWidths[depth - 1]! + DEPTH_GAP);
  }
  const automaticLayouts = new Map<string, LayoutRect>();
  let cursorY = 0;
  for (const tree of trees) {
    const rect = layoutSubtree(tree, cursorY, columnOffsets, sizes, automaticLayouts);
    cursorY = rect.y + rect.height + SIBLING_GAP;
  }

  const nodes = input.resources.resources.map((resource, index): ProjectedCanvasNode => {
    const state = input.state.nodeStates[resource.projectRelativePath];
    const automaticLayout = automaticLayouts.get(resource.projectRelativePath)!;
    const layout = state?.manualLayout ?? automaticLayout;
    const common = {
      projectRelativePath: resource.projectRelativePath,
      displayName: resourceLabel(resource, input.canonicalRoot),
      x: layout.x,
      y: layout.y,
      width: layout.width,
      height: layout.height,
      z: index,
      automaticLayout,
      ...(state?.manualLayout ? { layoutMode: 'manual' as const } : {}),
      ...(state?.videoPlayback ? { videoPlayback: state.videoPlayback } : {}),
      ...(state?.textViewport ? { textViewport: state.textViewport } : {})
    };
    if (resource.nodeKind === 'directory') {
      return {
        ...common,
        nodeKind: 'directory',
        folderDisclosure: resource.projectRelativePath === ''
          || disclosedDirectories.has(resource.projectRelativePath)
          ? 'disclosed'
          : 'collapsed',
        availability: { state: 'directory' }
      };
    }
    return {
      ...common,
      nodeKind: 'file',
      mediaKind: resource.mediaKind,
      availability: resource.availability,
      ...(resource.imageDimensions ? { imageDimensions: resource.imageDimensions } : {}),
      ...(resource.textLanguage ? { textLanguage: resource.textLanguage } : {}),
      ...videoMetadataForResource(resource, input.videoMetadataByPath?.[resource.projectRelativePath])
    };
  });
  return nodes;
}

export function projectCanvasHierarchyEdges(
  nodes: readonly ProjectedCanvasNode[]
): CanvasStructureEdgeProjection[] {
  const visiblePaths = new Set(nodes.map((node) => node.projectRelativePath));
  return nodes.flatMap((node) => {
    const parent = canvasParentPath(node.projectRelativePath);
    return parent !== undefined && visiblePaths.has(parent)
      ? [{
          id: `${parent}\u001f${node.projectRelativePath}`,
          sourceProjectRelativePath: parent,
          targetProjectRelativePath: node.projectRelativePath
        }]
      : [];
  });
}

function resourceLabel(resource: CanvasResource, canonicalRoot: string): string {
  if (resource.projectRelativePath) {
    return resource.projectRelativePath.split('/').at(-1)!;
  }
  const normalized = canonicalRoot.replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).at(-1) || canonicalRoot;
}

function resourceSize(
  resource: CanvasResource,
  label: string,
  genericSizes: ReadonlyMap<string, CanvasGenericNodeSceneSize>,
  videoMetadata: { sourceRevision: string; metadata: CanvasVideoMetadata } | undefined
): LayoutSize {
  if (resource.nodeKind === 'file') {
    if (resource.mediaKind === 'text') {
      return { width: TEXT_WIDTH, height: TEXT_HEIGHT };
    }
    if (resource.mediaKind === 'audio') {
      return { width: AUDIO_WIDTH, height: AUDIO_HEIGHT };
    }
    if (resource.mediaKind === 'image' && resource.imageDimensions) {
      return resource.imageDimensions;
    }
    if (resource.mediaKind === 'video') {
      const metadata = videoMetadataForResource(resource, videoMetadata).videoMetadata;
      return canvasVideoNodeSizeForContent(metadata ?? CANVAS_VIDEO_FALLBACK_CONTENT_SIZE);
    }
  }
  const genericSize = genericSizes.get(label);
  if (!genericSize) {
    throw new Error(`Canvas generic geometry is missing for ${JSON.stringify(label)}.`);
  }
  return genericSize;
}

function videoMetadataForResource(
  resource: CanvasResource,
  value: { sourceRevision: string; metadata: CanvasVideoMetadata } | undefined
): { videoMetadata?: CanvasVideoMetadata } {
  return resource.nodeKind === 'file'
    && resource.mediaKind === 'video'
    && resource.availability.state === 'available'
    && value?.sourceRevision === resource.availability.revision
    ? { videoMetadata: value.metadata }
    : {};
}

function resourceUsesGenericGeometry(resource: CanvasResource): boolean {
  if (resource.nodeKind !== 'file') {
    return true;
  }
  if (resource.mediaKind === 'text' || resource.mediaKind === 'audio') {
    return false;
  }
  if (resource.mediaKind === 'image' && resource.imageDimensions) {
    return false;
  }
  if (resource.mediaKind === 'video') {
    return false;
  }
  return true;
}

function buildLayoutTrees(resources: readonly CanvasResource[]): LayoutTreeNode[] {
  const nodes = new Map<string, LayoutTreeNode>();
  for (const resource of resources) {
    nodes.set(resource.projectRelativePath, {
      resource,
      depth: resource.projectRelativePath ? resource.projectRelativePath.split('/').length : 0,
      children: []
    });
  }
  const roots: LayoutTreeNode[] = [];
  for (const resource of resources) {
    const node = nodes.get(resource.projectRelativePath)!;
    const parent = canvasParentPath(resource.projectRelativePath);
    const parentNode = parent === undefined ? undefined : nodes.get(parent);
    if (parentNode) {
      parentNode.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function canvasParentPath(path: string): string | undefined {
  if (!path) {
    return undefined;
  }
  const separator = path.lastIndexOf('/');
  return separator < 0 ? '' : path.slice(0, separator);
}

function collectColumnWidths(
  node: LayoutTreeNode,
  sizes: ReadonlyMap<string, LayoutSize>,
  widths: number[]
): void {
  const size = sizes.get(node.resource.projectRelativePath)!;
  widths[node.depth] = Math.max(widths[node.depth] ?? 0, size.width);
  for (const child of node.children) {
    collectColumnWidths(child, sizes, widths);
  }
}

function layoutSubtree(
  node: LayoutTreeNode,
  top: number,
  offsets: readonly number[],
  sizes: ReadonlyMap<string, LayoutSize>,
  result: Map<string, LayoutRect>
): LayoutRect {
  let cursorY = top;
  const children: LayoutRect[] = [];
  for (const child of node.children.filter(({ resource }) => resource.nodeKind === 'directory')) {
    const placed = layoutSubtree(child, cursorY, offsets, sizes, result);
    children.push(placed);
    cursorY = placed.y + placed.height + SIBLING_GAP;
  }
  const fileChildren = node.children.filter(({ resource }) => resource.nodeKind === 'file');
  if (fileChildren.length > 0) {
    const rowHeight = Math.max(...fileChildren.map((child) => (
      sizes.get(child.resource.projectRelativePath)!.height
    )));
    const rowX = offsets[fileChildren[0]!.depth] ?? 0;
    let cursorX = rowX;
    for (const child of fileChildren) {
      const childSize = sizes.get(child.resource.projectRelativePath)!;
      result.set(child.resource.projectRelativePath, {
        x: cursorX,
        y: cursorY + (rowHeight - childSize.height) / 2,
        ...childSize
      });
      cursorX += childSize.width + SIBLING_GAP;
    }
    children.push({
      x: rowX,
      y: cursorY,
      width: cursorX - rowX - SIBLING_GAP,
      height: rowHeight
    });
  }
  const size = sizes.get(node.resource.projectRelativePath)!;
  const x = offsets[node.depth] ?? 0;
  const y = children.length === 0
    ? top
    : (children[0]!.y + children.at(-1)!.y + children.at(-1)!.height) / 2 - size.height / 2;
  const own = { x, y, ...size };
  result.set(node.resource.projectRelativePath, own);
  const left = children.reduce((value, child) => Math.min(value, child.x), own.x);
  const right = children.reduce((value, child) => Math.max(value, child.x + child.width), own.x + own.width);
  const rectTop = children.reduce((value, child) => Math.min(value, child.y), own.y);
  const bottom = children.reduce((value, child) => Math.max(value, child.y + child.height), own.y + own.height);
  return { x: left, y: rectTop, width: right - left, height: bottom - rectTop };
}

export function reconcileCanvasOcclusionOrder(
  currentOrder: readonly string[],
  nodes: readonly CanvasProjectedRect[]
): string[] {
  const participants = canvasOverlapParticipants(nodes);
  const retained = currentOrder.filter((path, index) => (
    participants.has(path) && currentOrder.indexOf(path) === index
  ));
  const retainedPaths = new Set(retained);
  return retained.concat(
    nodes
      .map((node) => node.projectRelativePath)
      .filter((path) => participants.has(path) && !retainedPaths.has(path))
  );
}

export function raiseCanvasSelection(
  currentOrder: readonly string[],
  selectedPaths: readonly string[]
): string[] {
  const selected = new Set(selectedPaths);
  return currentOrder
    .filter((path) => !selected.has(path))
    .concat(currentOrder.filter((path) => selected.has(path)));
}

export function canvasPathAncestors(path: string): string[] {
  if (path.length === 0) {
    return [];
  }
  const parts = path.split('/');
  const result: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    result.push(parts.slice(0, index).join('/'));
  }
  return result;
}

function canvasOverlapParticipants(nodes: readonly CanvasProjectedRect[]): Set<string> {
  const result = new Set<string>();
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    const left = nodes[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const right = nodes[rightIndex]!;
      if (canvasRectsOverlap(left, right)) {
        result.add(left.projectRelativePath);
        result.add(right.projectRelativePath);
      }
    }
  }
  return result;
}

function canvasRectsOverlap(left: CanvasProjectedRect, right: CanvasProjectedRect): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}
