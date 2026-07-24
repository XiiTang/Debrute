import type {
  DebruteProductPlatform,
  ProjectPathEntry
} from '@debrute/app-protocol';
import type { ProjectFileTreeNode } from './projectFileTree';

export interface ProjectTreeSelectionState {
  selectedPaths: string[];
  focusedPath: string | null;
  anchorPath: string | null;
}

export interface ProjectTreeVisibleItem {
  path: string;
  kind: 'file' | 'directory';
  parentPath: string;
  depth: number;
}

export interface ProjectTreePointerModifiers {
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

export function createEmptyProjectTreeSelection(): ProjectTreeSelectionState {
  return { selectedPaths: [], focusedPath: null, anchorPath: null };
}

export function flattenProjectTree(tree: ProjectFileTreeNode[], expanded: Set<string>): ProjectTreeVisibleItem[] {
  const result: ProjectTreeVisibleItem[] = [];
  for (const node of tree) {
    appendVisibleProjectTreeNode(result, node, expanded, 0);
  }
  return result;
}

export function normalizeProjectTreeSelection(
  state: ProjectTreeSelectionState,
  visibleItems: ProjectTreeVisibleItem[]
): ProjectTreeSelectionState {
  const visiblePathSet = new Set(visibleItems.map((item) => item.path));
  const selectedPaths = visibleItems
    .map((item) => item.path)
    .filter((path) => state.selectedPaths.includes(path));
  const focusedPath = state.focusedPath && visiblePathSet.has(state.focusedPath) ? state.focusedPath : selectedPaths.at(-1) ?? null;
  const anchorPath = state.anchorPath && visiblePathSet.has(state.anchorPath) ? state.anchorPath : focusedPath;
  return { selectedPaths, focusedPath, anchorPath };
}

export function updateProjectTreeSelection(input: {
  state: ProjectTreeSelectionState;
  visibleItems: ProjectTreeVisibleItem[];
  path: string;
  platform: DebruteProductPlatform;
  event: ProjectTreePointerModifiers;
}): ProjectTreeSelectionState {
  const normalizedState = normalizeProjectTreeSelection(input.state, input.visibleItems);
  const clickedPath = normalizeProjectTreePath(input.path);
  const visiblePaths = input.visibleItems.map((item) => item.path);
  if (!visiblePaths.includes(clickedPath)) {
    return normalizedState;
  }

  if (input.event.shiftKey) {
    const anchorPath = normalizedState.anchorPath && visiblePaths.includes(normalizedState.anchorPath)
      ? normalizedState.anchorPath
      : clickedPath;
    return {
      selectedPaths: visibleRangePaths(visiblePaths, anchorPath, clickedPath),
      focusedPath: clickedPath,
      anchorPath
    };
  }

  if (isToggleSelectionEvent(input.event, input.platform)) {
    const selected = new Set(normalizedState.selectedPaths);
    if (selected.has(clickedPath)) {
      selected.delete(clickedPath);
    } else {
      selected.add(clickedPath);
    }
    return {
      selectedPaths: visiblePaths.filter((path) => selected.has(path)),
      focusedPath: clickedPath,
      anchorPath: clickedPath
    };
  }

  return {
    selectedPaths: [clickedPath],
    focusedPath: clickedPath,
    anchorPath: clickedPath
  };
}

export function updateProjectTreeContextSelection(input: {
  state: ProjectTreeSelectionState;
  visibleItems: ProjectTreeVisibleItem[];
  path: string;
}): ProjectTreeSelectionState {
  const normalizedState = normalizeProjectTreeSelection(input.state, input.visibleItems);
  const path = normalizeProjectTreePath(input.path);
  if (normalizedState.selectedPaths.includes(path)) {
    return normalizedState;
  }
  return {
    selectedPaths: [path],
    focusedPath: path,
    anchorPath: path
  };
}

export function projectTreePathEntriesFromSelection(input: {
  selection: ProjectTreeSelectionState;
  visibleItems: ProjectTreeVisibleItem[];
}): ProjectPathEntry[] {
  const selected = new Set(input.selection.selectedPaths);
  return input.visibleItems
    .filter((item) => selected.has(item.path))
    .map((item) => ({
      projectRelativePath: item.path,
      kind: item.kind
    }));
}

export function projectTreeDropOperation(input: {
  platform: DebruteProductPlatform;
  event: ProjectTreePointerModifiers;
}): 'copy' | 'move' {
  return input.platform === 'darwin'
    ? input.event.altKey === true ? 'copy' : 'move'
    : input.event.ctrlKey === true ? 'copy' : 'move';
}

export function projectTreeDragEntries(input: {
  selection: ProjectTreeSelectionState;
  visibleItems: ProjectTreeVisibleItem[];
  path: string;
}): ProjectPathEntry[] {
  const path = normalizeProjectTreePath(input.path);
  if (input.selection.selectedPaths.includes(path)) {
    return projectTreePathEntriesFromSelection({
      selection: input.selection,
      visibleItems: input.visibleItems
    });
  }
  const item = input.visibleItems.find((visibleItem) => visibleItem.path === path);
  return item ? [{ projectRelativePath: item.path, kind: item.kind }] : [];
}

export function projectTreeDropTargetDirectory(input: {
  visibleItems: ProjectTreeVisibleItem[];
  path: string | undefined;
}): string {
  if (!input.path) {
    return '';
  }
  const path = normalizeProjectTreePath(input.path);
  const item = input.visibleItems.find((visibleItem) => visibleItem.path === path);
  if (!item) {
    return '';
  }
  return item.kind === 'directory' ? item.path : item.parentPath;
}

export function isProjectTreeMoveNoop(input: {
  entries: ProjectPathEntry[];
  targetDirectoryProjectRelativePath: string;
}): boolean {
  const targetDirectoryPath = normalizeProjectTreePath(input.targetDirectoryProjectRelativePath);
  return input.entries.length > 0 && input.entries.every((entry) => {
    const sourcePath = normalizeProjectTreePath(entry.projectRelativePath);
    return projectTreeParentPath(sourcePath) === targetDirectoryPath;
  });
}

export function isProjectTreeDropRejected(input: {
  entries: ProjectPathEntry[];
  targetDirectoryProjectRelativePath: string;
}): boolean {
  const targetDirectoryPath = normalizeProjectTreePath(input.targetDirectoryProjectRelativePath);
  return input.entries.some((entry) => {
    if (entry.kind !== 'directory') {
      return false;
    }
    const sourcePath = normalizeProjectTreePath(entry.projectRelativePath);
    return targetDirectoryPath === sourcePath || targetDirectoryPath.startsWith(`${sourcePath}/`);
  });
}

export function projectTreeBatchMoveHasConflict(input: {
  existingProjectRelativePaths: Set<string>;
  entries: ProjectPathEntry[];
  targetDirectoryProjectRelativePath: string;
}): boolean {
  const targetDirectoryPath = normalizeProjectTreePath(input.targetDirectoryProjectRelativePath);
  return input.entries.some((entry) => {
    const sourcePath = normalizeProjectTreePath(entry.projectRelativePath);
    const targetPath = targetDirectoryPath
      ? `${targetDirectoryPath}/${projectTreeBasename(sourcePath)}`
      : projectTreeBasename(sourcePath);
    return targetPath !== sourcePath && input.existingProjectRelativePaths.has(targetPath);
  });
}

export function projectTreeParentPath(projectRelativePath: string): string {
  const parts = normalizeProjectTreePath(projectRelativePath).split('/').filter(Boolean);
  return parts.length <= 1 ? '' : parts.slice(0, -1).join('/');
}

export function projectTreeBasename(projectRelativePath: string): string {
  const parts = normalizeProjectTreePath(projectRelativePath).split('/').filter(Boolean);
  return parts.at(-1) ?? '';
}

export function normalizeProjectTreePath(projectRelativePath: string): string {
  return projectRelativePath.split('/').filter(Boolean).join('/');
}

function appendVisibleProjectTreeNode(
  result: ProjectTreeVisibleItem[],
  node: ProjectFileTreeNode,
  expanded: Set<string>,
  depth: number
): void {
  result.push({
    path: node.path,
    kind: node.kind,
    parentPath: projectTreeParentPath(node.path),
    depth
  });
  if (node.kind === 'directory' && expanded.has(node.path)) {
    for (const child of node.children) {
      appendVisibleProjectTreeNode(result, child, expanded, depth + 1);
    }
  }
}

function isToggleSelectionEvent(event: ProjectTreePointerModifiers, platform: DebruteProductPlatform): boolean {
  return platform === 'darwin' ? event.metaKey === true : event.ctrlKey === true;
}

function visibleRangePaths(visiblePaths: string[], anchorPath: string, targetPath: string): string[] {
  const anchorIndex = visiblePaths.indexOf(anchorPath);
  const targetIndex = visiblePaths.indexOf(targetPath);
  if (anchorIndex < 0 || targetIndex < 0) {
    return [targetPath];
  }
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return visiblePaths.slice(start, end + 1);
}
