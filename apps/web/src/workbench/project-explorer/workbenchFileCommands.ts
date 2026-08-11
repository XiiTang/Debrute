import type {
  WorkbenchProjectFileBatchOperationResult,
  WorkbenchProjectSessionSnapshot
} from '@debrute/app-protocol';
import {
  canvasNodeSelection,
  type CanvasSelection
} from '../canvas/runtime/canvasSelection';
import type { WorkbenchFileClipboard } from '../shell/contextMenu';
import type { ProjectTreeSelectionState } from './projectTreeInteraction';

export function projectTreeSelectionFromPaths(paths: string[]): ProjectTreeSelectionState {
  const selectedPaths = [...paths];
  const focusedPath = selectedPaths.at(-1) ?? null;
  return {
    selectedPaths,
    focusedPath,
    anchorPath: focusedPath
  };
}

export function singleFileBatchResultPath(
  results: WorkbenchProjectFileBatchOperationResult['results']
): string | undefined {
  const completed = results.filter((result) => result.status === 'ok');
  if (completed.length === 1 && completed[0]!.kind === 'file') {
    return completed[0]!.projectRelativePath;
  }
  return undefined;
}

export function externalDropPlanHasConflict(input: {
  snapshot: WorkbenchProjectSessionSnapshot | undefined;
  localPaths: string[];
  uploads: Array<{ projectRelativePath: string }>;
  targetDirectoryProjectRelativePath: string;
}): boolean {
  const existingPaths = new Set(input.snapshot?.projectTree.map((entry) => entry.projectRelativePath) ?? []);
  return [
    ...input.localPaths.map((path) => (
      input.targetDirectoryProjectRelativePath
        ? `${input.targetDirectoryProjectRelativePath}/${nativePathBasename(path)}`
        : nativePathBasename(path)
    )),
    ...externalUploadTopLevelProjectPaths(input.uploads, input.targetDirectoryProjectRelativePath)
  ].some((path) => existingPaths.has(path));
}

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

export function reconcileCutClipboardWithProjectEntries(
  clipboard: WorkbenchFileClipboard | undefined,
  currentEntries: readonly { projectRelativePath: string; kind: 'file' | 'directory' }[]
): WorkbenchFileClipboard | undefined {
  if (clipboard?.operation !== 'cut') {
    return clipboard;
  }
  const currentKindByPath = new Map(currentEntries.map((entry) => [entry.projectRelativePath, entry.kind]));
  const entries = clipboard.entries.filter((entry) => (
    currentKindByPath.get(entry.projectRelativePath) === entry.kind
  ));
  if (entries.length === clipboard.entries.length) {
    return clipboard;
  }
  return entries.length > 0 ? { ...clipboard, entries } : undefined;
}

export function batchResultSelectionPaths(results: WorkbenchProjectFileBatchOperationResult['results']): string[] {
  return results.map((result) => result.projectRelativePath);
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
  if (selection.kind !== 'nodes') {
    return selection;
  }
  return canvasNodeSelection(selection.projectRelativePaths.filter((path) => (
    !isProjectPathContainedByDeletedPath(path, deletedProjectRelativePath)
  )));
}

export function rewriteCanvasSelectionAfterPathChanges(
  selection: CanvasSelection | undefined,
  changes: readonly {
    sourceProjectRelativePath: string;
    projectRelativePath: string;
    status: 'ok' | 'skipped';
  }[]
): CanvasSelection | undefined {
  if (selection?.kind !== 'nodes') {
    return selection;
  }
  const completed = changes
    .filter((change) => change.status === 'ok'
      && change.sourceProjectRelativePath !== change.projectRelativePath)
    .sort((left, right) => right.sourceProjectRelativePath.length - left.sourceProjectRelativePath.length);
  return canvasNodeSelection(selection.projectRelativePaths.map((path) => {
    const change = completed.find(({ sourceProjectRelativePath }) => (
      isProjectPathContainedByDeletedPath(path, sourceProjectRelativePath)
    ));
    if (!change) {
      return path;
    }
    return path === change.sourceProjectRelativePath
      ? change.projectRelativePath
      : `${change.projectRelativePath}${path.slice(change.sourceProjectRelativePath.length)}`;
  }));
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

export function projectPathDeletionConfirmationMessageForEntries(input: {
  entries: Array<{ projectRelativePath: string; kind: 'file' | 'directory' }>;
}, labels: PermanentDeleteConfirmationLabels): string {
  if (input.entries.length === 1) {
    return permanentDeleteConfirmationMessage(input.entries[0]!, labels);
  }
  return labels.selectedItems(input.entries.length);
}

function externalUploadTopLevelProjectPaths(
  uploads: Array<{ projectRelativePath: string }>,
  targetDirectoryProjectRelativePath: string
): string[] {
  return [...new Set(uploads.map((upload) => {
    const relativePath = externalUploadPathRelativeToTarget(upload.projectRelativePath, targetDirectoryProjectRelativePath);
    const topLevelName = relativePath.split('/')[0]!;
    return targetDirectoryProjectRelativePath ? `${targetDirectoryProjectRelativePath}/${topLevelName}` : topLevelName;
  }))];
}

function externalUploadPathRelativeToTarget(projectRelativePath: string, targetDirectoryProjectRelativePath: string): string {
  if (!targetDirectoryProjectRelativePath) {
    if (!projectRelativePath) {
      throw new Error('Upload import path is empty.');
    }
    return projectRelativePath;
  }
  if (!projectRelativePath.startsWith(`${targetDirectoryProjectRelativePath}/`)) {
    throw new Error(`Upload import path is outside the target directory: ${projectRelativePath}`);
  }
  const relativePath = projectRelativePath.slice(targetDirectoryProjectRelativePath.length + 1);
  if (!relativePath) {
    throw new Error(`Upload import path is outside the target directory: ${projectRelativePath}`);
  }
  return relativePath;
}

function nativePathBasename(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/$/, '');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function isProjectPathContainedByDeletedPath(projectRelativePath: string, deletedProjectRelativePath: string): boolean {
  return projectRelativePath === deletedProjectRelativePath || projectRelativePath.startsWith(`${deletedProjectRelativePath}/`);
}
