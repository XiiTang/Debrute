export interface CanvasSelection {
  projectRelativePaths: readonly string[];
}

export function canvasNodeSelection(
  projectRelativePaths: Iterable<string>
): CanvasSelection | undefined {
  const normalized = [...new Set(projectRelativePaths)].sort(compareProjectRelativePaths);
  return normalized.length > 0
    ? { projectRelativePaths: normalized }
    : undefined;
}

export function normalizeCanvasSelection(
  selection: CanvasSelection | undefined
): CanvasSelection | undefined {
  return selection ? canvasNodeSelection(selection.projectRelativePaths) : undefined;
}

export function selectedNodeProjectRelativePaths(
  selection: CanvasSelection | undefined
): string[] {
  return selection ? [...selection.projectRelativePaths] : [];
}

export function soleSelectedNodeProjectRelativePath(
  selection: CanvasSelection | undefined
): string | undefined {
  return selection?.projectRelativePaths.length === 1
    ? selection.projectRelativePaths[0]
    : undefined;
}

export function isCanvasNodeSelected(
  selection: CanvasSelection | undefined,
  projectRelativePath: string
): boolean {
  return selection?.projectRelativePaths.includes(projectRelativePath) ?? false;
}

export function toggleCanvasNodeSelection(
  selection: CanvasSelection | undefined,
  projectRelativePath: string
): CanvasSelection | undefined {
  const paths = new Set(selection?.projectRelativePaths);
  if (paths.has(projectRelativePath)) {
    paths.delete(projectRelativePath);
  } else {
    paths.add(projectRelativePath);
  }
  return canvasNodeSelection(paths);
}

export function unionCanvasNodeSelection(
  selection: CanvasSelection | undefined,
  projectRelativePaths: Iterable<string>
): CanvasSelection | undefined {
  return canvasNodeSelection([
    ...selectedNodeProjectRelativePaths(selection),
    ...projectRelativePaths
  ]);
}

export function pruneCanvasSelection(
  selection: CanvasSelection | undefined,
  currentNodePaths: ReadonlySet<string>
): CanvasSelection | undefined {
  if (!selection) return undefined;
  return canvasNodeSelection(
    selection.projectRelativePaths.filter((path) => currentNodePaths.has(path))
  );
}

export function sameCanvasSelection(
  left: CanvasSelection | undefined,
  right: CanvasSelection | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return left.projectRelativePaths.length === right.projectRelativePaths.length
    && left.projectRelativePaths.every((path, index) => path === right.projectRelativePaths[index]);
}

function compareProjectRelativePaths(left: string, right: string): number {
  return left.localeCompare(right);
}
