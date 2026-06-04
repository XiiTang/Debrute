export type CanvasSelectionItem =
  | { kind: 'diagnostic'; id: string }
  | { kind: 'node'; projectRelativePath: string };

export type CanvasSelection =
  | CanvasSelectionItem
  | {
      kind: 'multi';
      items: CanvasSelectionItem[];
    };

export function selectionItems(selection: CanvasSelection | undefined): CanvasSelectionItem[] {
  if (!selection) {
    return [];
  }
  return selection.kind === 'multi' ? selection.items : [selection];
}

export function selectedNodeProjectRelativePaths(selection: CanvasSelection | undefined): string[] {
  return selectionItems(selection)
    .filter((item) => item.kind === 'node')
    .map((item) => item.projectRelativePath);
}

export function isCanvasItemSelected(selection: CanvasSelection | undefined, item: CanvasSelectionItem): boolean {
  return selectionItems(selection).some((selected) => sameSelectionItem(selected, item));
}

export function toggleCanvasSelectionItem(
  selection: CanvasSelection | undefined,
  item: CanvasSelectionItem
): CanvasSelection | undefined {
  if (!selection) {
    return item;
  }
  const items = selectionItems(selection);
  const exists = items.some((selected) => sameSelectionItem(selected, item));
  const next = exists
    ? items.filter((selected) => !sameSelectionItem(selected, item))
    : [...items, item];
  if (next.length === 0) {
    return undefined;
  }
  return next.length === 1 ? next[0] : { kind: 'multi', items: next };
}

export function sameSelectionItem(left: CanvasSelectionItem, right: CanvasSelectionItem): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  return left.kind === 'node' && right.kind === 'node'
    ? left.projectRelativePath === right.projectRelativePath
    : left.kind === 'diagnostic' && right.kind === 'diagnostic' && left.id === right.id;
}
