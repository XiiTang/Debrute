export type CanvasSelection =
  | {
      kind: 'nodes';
      projectRelativePaths: readonly string[];
    }
  | {
      kind: 'diagnostic';
      id: string;
    };

export function canvasNodeSelection(
  projectRelativePaths: Iterable<string>
): CanvasSelection | undefined {
  const normalized = [...new Set(projectRelativePaths)].sort(compareProjectRelativePaths);
  return normalized.length > 0
    ? { kind: 'nodes', projectRelativePaths: normalized }
    : undefined;
}

export function normalizeCanvasSelection(
  selection: CanvasSelection | undefined
): CanvasSelection | undefined {
  return selection?.kind === 'nodes'
    ? canvasNodeSelection(selection.projectRelativePaths)
    : selection;
}

export function selectedNodeProjectRelativePaths(
  selection: CanvasSelection | undefined
): string[] {
  return selection?.kind === 'nodes' ? [...selection.projectRelativePaths] : [];
}

export function isCanvasNodeSelected(
  selection: CanvasSelection | undefined,
  projectRelativePath: string
): boolean {
  return selection?.kind === 'nodes'
    && selection.projectRelativePaths.includes(projectRelativePath);
}

export function toggleCanvasNodeSelection(
  selection: CanvasSelection | undefined,
  projectRelativePath: string
): CanvasSelection | undefined {
  const paths = selection?.kind === 'nodes'
    ? new Set(selection.projectRelativePaths)
    : new Set<string>();
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
  if (selection?.kind !== 'nodes') {
    return selection;
  }
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
  if (!left || !right || left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'diagnostic' && right.kind === 'diagnostic') {
    return left.id === right.id;
  }
  if (left.kind !== 'nodes' || right.kind !== 'nodes') {
    return false;
  }
  return left.projectRelativePaths.length === right.projectRelativePaths.length
    && left.projectRelativePaths.every((path, index) => path === right.projectRelativePaths[index]);
}

function compareProjectRelativePaths(left: string, right: string): number {
  return left.localeCompare(right);
}
