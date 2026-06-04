import type { CanvasSelection } from '../canvas/runtime/canvasSelection';
import type { WorkbenchFileClipboard } from '../shell/contextMenu';

export function clearClipboardAfterPaste(clipboard: WorkbenchFileClipboard): WorkbenchFileClipboard | undefined {
  return clipboard.operation === 'cut' ? undefined : clipboard;
}

export function nearestExistingParentSelection(
  deletedProjectRelativePath: string,
  existingProjectRelativePaths: Set<string>
): string | undefined {
  const parts = deletedProjectRelativePath.split('/').filter(Boolean);
  while (parts.length > 1) {
    parts.pop();
    const candidate = parts.join('/');
    if (existingProjectRelativePaths.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function clearCanvasSelectionAfterDeletedPath(
  selection: CanvasSelection | undefined,
  deletedProjectRelativePath: string
): CanvasSelection | undefined {
  if (!selection) {
    return undefined;
  }
  if (selection.kind !== 'multi') {
    return isDeletedNodeSelection(selection, deletedProjectRelativePath) ? undefined : selection;
  }
  const items = selection.items.filter((item) => !isDeletedNodeSelection(item, deletedProjectRelativePath));
  if (items.length === 0) {
    return undefined;
  }
  return items.length === 1 ? items[0] : { kind: 'multi', items };
}

export function notificationMessageForFileCommandError(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}

function isDeletedNodeSelection(
  selection: CanvasSelection,
  deletedProjectRelativePath: string
): boolean {
  return selection.kind === 'node'
    && (selection.projectRelativePath === deletedProjectRelativePath || selection.projectRelativePath.startsWith(`${deletedProjectRelativePath}/`));
}
