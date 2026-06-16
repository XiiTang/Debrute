import type {
  CanvasDesiredLayoutRow,
  CanvasDesiredNode,
  CanvasLayoutSize
} from './index.js';

export interface CanvasResolvedLayout extends CanvasLayoutSize {
  x: number;
  y: number;
}

export interface CanvasAutoLayoutInput {
  desired: CanvasDesiredNode[];
  layoutRows: CanvasDesiredLayoutRow[];
  manualPaths: Set<string>;
  layoutSizeForNode: (node: CanvasDesiredNode) => CanvasLayoutSize;
}

const HORIZONTAL_TREE_GAP = 100;
const VERTICAL_GAP = 80;
const HORIZONTAL_ROW_GAP = VERTICAL_GAP;
const PROJECT_ROOT_PATH = '';

interface LayoutTreeNode {
  node: CanvasDesiredNode;
  depth: number;
  children: LayoutTreeNode[];
}

interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type LayoutBlock =
  | {
      kind: 'node';
      node: LayoutTreeNode;
    }
  | {
      kind: 'horizontal-row';
      members: LayoutTreeNode[];
    };

interface PlacedBlock {
  rect: LayoutRect;
}

export function layoutCanvasDesiredNodes(input: CanvasAutoLayoutInput): Map<string, CanvasResolvedLayout> {
  const desired = sortDesiredNodes(input.desired);
  const tree = buildLayoutTree(desired);
  const rowsByParent = buildLayoutRowsByParent(input.layoutRows, tree.byPath);
  const columnOffsets = canvasColumnOffsets(tree.roots, rowsByParent, input.manualPaths, input.layoutSizeForNode);
  const layoutByPath = new Map<string, CanvasResolvedLayout>();
  let cursorY = 0;

  for (const root of tree.roots) {
    const placed = layoutSubtree({
      treeNode: root,
      top: cursorY,
      rowsByParent,
      columnOffsets,
      manualPaths: input.manualPaths,
      layoutSizeForNode: input.layoutSizeForNode,
      layoutByPath
    });
    if (!placed) {
      continue;
    }
    cursorY = placed.rect.y + placed.rect.height + VERTICAL_GAP;
  }

  return layoutByPath;
}

function layoutSubtree(input: {
  treeNode: LayoutTreeNode;
  top: number;
  rowsByParent: Map<string, LayoutTreeNode[][]>;
  columnOffsets: number[];
  manualPaths: Set<string>;
  layoutSizeForNode: (node: CanvasDesiredNode) => CanvasLayoutSize;
  layoutByPath: Map<string, CanvasResolvedLayout>;
}): PlacedBlock | undefined {
  const childBlocks = childBlocksForNode(input.treeNode, input.rowsByParent, input.manualPaths);
  let cursorY = input.top;
  const placedChildren: PlacedBlock[] = [];

  for (const block of childBlocks) {
    const placed = block.kind === 'horizontal-row'
      ? layoutHorizontalRow({
          block,
          top: cursorY,
          columnOffsets: input.columnOffsets,
          layoutSizeForNode: input.layoutSizeForNode,
          layoutByPath: input.layoutByPath
        })
      : layoutSubtree({
          treeNode: block.node,
          top: cursorY,
          rowsByParent: input.rowsByParent,
          columnOffsets: input.columnOffsets,
          manualPaths: input.manualPaths,
          layoutSizeForNode: input.layoutSizeForNode,
          layoutByPath: input.layoutByPath
        });
    if (!placed) {
      continue;
    }
    placedChildren.push(placed);
    cursorY = placed.rect.y + placed.rect.height + VERTICAL_GAP;
  }

  if (input.manualPaths.has(input.treeNode.node.projectRelativePath)) {
    return unionPlacedBlocks(placedChildren);
  }

  const size = input.layoutSizeForNode(input.treeNode.node);
  const x = input.columnOffsets[input.treeNode.depth] ?? 0;
  const y = placedChildren.length === 0
    ? input.top
    : childSpanCenter(placedChildren) - size.height / 2;

  input.layoutByPath.set(input.treeNode.node.projectRelativePath, {
    x,
    y,
    ...size
  });

  return mergePlacedBlocks([
    {
      rect: { x, y, width: size.width, height: size.height }
    },
    ...placedChildren
  ]);
}

function layoutHorizontalRow(input: {
  block: Extract<LayoutBlock, { kind: 'horizontal-row' }>;
  top: number;
  columnOffsets: number[];
  layoutSizeForNode: (node: CanvasDesiredNode) => CanvasLayoutSize;
  layoutByPath: Map<string, CanvasResolvedLayout>;
}): PlacedBlock | undefined {
  const members = input.block.members.map((member) => ({
    member,
    size: input.layoutSizeForNode(member.node)
  }));
  if (members.length === 0) {
    return undefined;
  }
  const rowHeight = Math.max(...members.map(({ size }) => size.height));
  const rowLeft = input.columnOffsets[input.block.members[0]!.depth] ?? 0;
  let cursorX = rowLeft;
  let rightEdge = cursorX;

  for (const { member, size } of members) {
    input.layoutByPath.set(member.node.projectRelativePath, {
      x: cursorX,
      y: input.top + (rowHeight - size.height) / 2,
      ...size
    });
    rightEdge = cursorX + size.width;
    cursorX = rightEdge + HORIZONTAL_ROW_GAP;
  }

  return {
    rect: {
      x: rowLeft,
      y: input.top,
      width: rightEdge - rowLeft,
      height: rowHeight
    }
  };
}

function buildLayoutTree(desired: CanvasDesiredNode[]): { roots: LayoutTreeNode[]; byPath: Map<string, LayoutTreeNode> } {
  const byPath = new Map<string, LayoutTreeNode>();
  const hasProjectRoot = desired.some((node) => node.projectRelativePath === PROJECT_ROOT_PATH);
  for (const node of desired) {
    byPath.set(node.projectRelativePath, {
      node,
      depth: layoutDepth(node.projectRelativePath, hasProjectRoot),
      children: []
    });
  }

  const roots: LayoutTreeNode[] = [];
  for (const treeNode of byPath.values()) {
    const parent = parentPath(treeNode.node.projectRelativePath);
    const parentNode = parent === undefined ? undefined : byPath.get(parent);
    if (parentNode) {
      parentNode.children.push(treeNode);
    } else {
      roots.push(treeNode);
    }
  }

  for (const treeNode of byPath.values()) {
    treeNode.children.sort(compareTreeNode);
  }
  roots.sort(compareTreeNode);
  return { roots, byPath };
}

function buildLayoutRowsByParent(
  layoutRows: CanvasDesiredLayoutRow[],
  desiredByPath: Map<string, LayoutTreeNode>
): Map<string, LayoutTreeNode[][]> {
  const rowsByParent = new Map<string, LayoutTreeNode[][]>();
  const used = new Set<string>();

  for (const row of layoutRows) {
    const directMembers: LayoutTreeNode[] = [];
    for (const path of row.memberProjectRelativePaths) {
      const node = desiredByPath.get(path);
      if (!node) {
        throw new Error(`Canvas layout row member is missing: ${path}`);
      }
      if (node.node.nodeKind !== 'file') {
        throw new Error(`Canvas layout row member must be a file: ${path}`);
      }
      if (parentPath(node.node.projectRelativePath) !== row.parentProjectRelativePath) {
        throw new Error(`Canvas layout row member is not a direct child of its row parent: ${path}`);
      }
      if (used.has(node.node.projectRelativePath)) {
        throw new Error(`Canvas layout row member is controlled by more than one row: ${path}`);
      }
      directMembers.push(node);
    }
    if (directMembers.length === 0) {
      continue;
    }
    directMembers.sort(compareTreeNode);
    for (const member of directMembers) {
      used.add(member.node.projectRelativePath);
    }
    rowsByParent.set(row.parentProjectRelativePath, [
      ...(rowsByParent.get(row.parentProjectRelativePath) ?? []),
      directMembers
    ]);
  }

  return rowsByParent;
}

function childBlocksForNode(
  treeNode: LayoutTreeNode,
  rowsByParent: Map<string, LayoutTreeNode[][]>,
  manualPaths: Set<string>
): LayoutBlock[] {
  const rows = rowsByParent.get(treeNode.node.projectRelativePath) ?? [];
  const rowPaths = new Set(rows.flat().map((member) => member.node.projectRelativePath));
  const rowBlocks: LayoutBlock[] = rows.map((members) => ({
    kind: 'horizontal-row',
    members
  }));
  const nodeBlocks: Array<Extract<LayoutBlock, { kind: 'node' }>> = treeNode.children
    .filter((child) => !rowPaths.has(child.node.projectRelativePath))
    .map((child) => ({ kind: 'node', node: child }));

  const visibleNodeBlocks = nodeBlocks
    .filter((block) => !manualPaths.has(block.node.node.projectRelativePath)
      || block.node.children.length > 0)
    .sort(compareNodeBlock);
  return [
    ...rowBlocks,
    ...visibleNodeBlocks
  ];
}

function canvasColumnOffsets(
  roots: LayoutTreeNode[],
  rowsByParent: Map<string, LayoutTreeNode[][]>,
  manualPaths: Set<string>,
  layoutSizeForNode: (node: CanvasDesiredNode) => CanvasLayoutSize
): number[] {
  const widthsByDepth: number[] = [];
  for (const root of roots) {
    collectCanvasColumnWidths(root, rowsByParent, manualPaths, layoutSizeForNode, widthsByDepth);
  }

  const offsets: number[] = [0];
  for (let depth = 1; depth < widthsByDepth.length; depth += 1) {
    offsets[depth] = offsets[depth - 1]! + (widthsByDepth[depth - 1] ?? 0) + HORIZONTAL_TREE_GAP;
  }
  return offsets;
}

function collectCanvasColumnWidths(
  treeNode: LayoutTreeNode,
  rowsByParent: Map<string, LayoutTreeNode[][]>,
  manualPaths: Set<string>,
  layoutSizeForNode: (node: CanvasDesiredNode) => CanvasLayoutSize,
  widthsByDepth: number[]
): void {
  if (!manualPaths.has(treeNode.node.projectRelativePath)) {
    const size = layoutSizeForNode(treeNode.node);
    widthsByDepth[treeNode.depth] = Math.max(widthsByDepth[treeNode.depth] ?? 0, size.width);
  }

  for (const block of childBlocksForNode(treeNode, rowsByParent, manualPaths)) {
    if (block.kind === 'horizontal-row') {
      for (const member of block.members) {
        const size = layoutSizeForNode(member.node);
        widthsByDepth[member.depth] = Math.max(widthsByDepth[member.depth] ?? 0, size.width);
      }
      continue;
    }
    collectCanvasColumnWidths(block.node, rowsByParent, manualPaths, layoutSizeForNode, widthsByDepth);
  }
}

function unionPlacedBlocks(blocks: PlacedBlock[]): PlacedBlock | undefined {
  return blocks.length === 0 ? undefined : mergePlacedBlocks(blocks);
}

function mergePlacedBlocks(blocks: PlacedBlock[]): PlacedBlock {
  const rect = unionRects(blocks.map((block) => block.rect));
  return { rect };
}

function unionRects(rects: LayoutRect[]): LayoutRect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };
}

function childSpanCenter(blocks: PlacedBlock[]): number {
  const first = blocks[0]!;
  const last = blocks[blocks.length - 1]!;
  return (first.rect.y + last.rect.y + last.rect.height) / 2;
}

function sortDesiredNodes(nodes: CanvasDesiredNode[]): CanvasDesiredNode[] {
  return [...nodes].sort(compareDesiredPath);
}

function compareNodeBlock(
  left: Extract<LayoutBlock, { kind: 'node' }>,
  right: Extract<LayoutBlock, { kind: 'node' }>
): number {
  return compareProjectPath(left.node.node.projectRelativePath, right.node.node.projectRelativePath);
}

function compareTreeNode(left: LayoutTreeNode, right: LayoutTreeNode): number {
  return compareDesiredSibling(left.node, right.node);
}

function compareDesiredSibling(left: CanvasDesiredNode, right: CanvasDesiredNode): number {
  if (left.nodeKind !== right.nodeKind) {
    return left.nodeKind === 'directory' ? -1 : 1;
  }
  return basename(left.projectRelativePath).localeCompare(basename(right.projectRelativePath), undefined, { numeric: true, sensitivity: 'base' });
}

function compareDesiredPath(left: CanvasDesiredNode, right: CanvasDesiredNode): number {
  return compareProjectPath(left.projectRelativePath, right.projectRelativePath);
}

function layoutDepth(projectRelativePath: string, hasProjectRoot: boolean): number {
  if (projectRelativePath === PROJECT_ROOT_PATH) {
    return 0;
  }
  const pathDepth = projectRelativePath.split('/').length - 1;
  return hasProjectRoot ? pathDepth + 1 : pathDepth;
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

function basename(path: string): string {
  const index = path.lastIndexOf('/');
  return index >= 0 ? path.slice(index + 1) : path;
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
