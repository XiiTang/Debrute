import type { WorkbenchProjectFileBatchOperationResult } from '@debrute/app-protocol';
import type { CanvasSelection } from '../canvas/runtime/canvasSelection';
import type { WorkbenchFileClipboard } from '../shell/contextMenu';

export function clearClipboardAfterPaste(clipboard: WorkbenchFileClipboard): WorkbenchFileClipboard | undefined {
  return clipboard.operation === 'cut' ? undefined : clipboard;
}

export function clearClipboardAfterDeletedPath(
  clipboard: WorkbenchFileClipboard | undefined,
  deletedProjectRelativePath: string
): WorkbenchFileClipboard | undefined {
  if (!clipboard) {
    return undefined;
  }
  const entries = clipboard.entries.filter((entry) => !isProjectPathContainedByDeletedPath(entry.projectRelativePath, deletedProjectRelativePath));
  if (entries.length === clipboard.entries.length) {
    return clipboard;
  }
  return entries.length > 0 ? { ...clipboard, entries } : undefined;
}

export function batchResultSelectionPaths(results: WorkbenchProjectFileBatchOperationResult['results']): string[] {
  return results
    .filter((result) => result.status === 'ok' || result.status === 'skipped')
    .map((result) => result.projectRelativePath);
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

export interface PermanentDeleteConfirmationLabels {
  directory: (path: string) => string;
  file: (path: string) => string;
  selectedItems: (count: number) => string;
}

export function permanentDeleteConfirmationMessage(input: {
  projectRelativePath: string;
  kind: 'file' | 'directory';
}, labels: PermanentDeleteConfirmationLabels): string {
  return input.kind === 'directory'
    ? labels.directory(input.projectRelativePath)
    : labels.file(input.projectRelativePath);
}

export function permanentDeleteConfirmationMessageForEntries(input: {
  entries: Array<{ projectRelativePath: string; kind: 'file' | 'directory' }>;
}, labels: PermanentDeleteConfirmationLabels): string {
  if (input.entries.length === 1) {
    return permanentDeleteConfirmationMessage(input.entries[0]!, labels);
  }
  return labels.selectedItems(input.entries.length);
}

function isDeletedNodeSelection(
  selection: CanvasSelection,
  deletedProjectRelativePath: string
): boolean {
  return selection.kind === 'node'
    && isProjectPathContainedByDeletedPath(selection.projectRelativePath, deletedProjectRelativePath);
}

function isProjectPathContainedByDeletedPath(projectRelativePath: string, deletedProjectRelativePath: string): boolean {
  return projectRelativePath === deletedProjectRelativePath || projectRelativePath.startsWith(`${deletedProjectRelativePath}/`);
}
