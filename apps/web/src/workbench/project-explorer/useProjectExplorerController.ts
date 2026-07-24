import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  WorkbenchApiClient,
  ProjectPathEntry,
  WorkbenchProjectFileBatchOperationResult,
  WorkbenchProjectSessionSnapshot
} from '@debrute/app-protocol';
import { getDebruteShellApi } from '../../api/shellApi';
import type { CanvasEditorRuntime } from '../canvas/runtime/CanvasEditorRuntime';
import type { WorkbenchI18n } from '../i18n';
import type { WorkbenchFileClipboard } from '../shell/contextMenu';
import { createInlineEditState, validateInlineProjectName, type ProjectTreeInlineEditState } from './projectTreeEditing';
import { createProjectTreeExternalDropPlan } from './projectTreeExternalDrop';
import {
  createEmptyProjectTreeSelection,
  isProjectTreeMoveNoop,
  projectTreeBatchMoveHasConflict,
  type ProjectTreeSelectionState
} from './projectTreeInteraction';
import {
  batchResultSelectionPaths,
  clearCanvasSelectionAfterDeletedPath,
  clearClipboardAfterDeletedPath,
  clearClipboardAfterPaste,
  externalDropPlanHasConflict,
  nearestExistingParentSelection,
  notificationMessageForFileCommandError,
  projectTreeSelectionFromPaths,
  singleFileBatchResultPath
} from './workbenchFileCommands';

interface ProjectCommandScope {
  projectId: string | undefined;
  generation: number;
}

export interface ProjectExplorerController {
  selection: ProjectTreeSelectionState;
  fileClipboard: WorkbenchFileClipboard | undefined;
  inlineEdit: ProjectTreeInlineEditState | undefined;
  setSelection(selection: ProjectTreeSelectionState): void;
  beginCreateFile(parentProjectRelativePath: string): void;
  beginCreateDirectory(parentProjectRelativePath: string): void;
  beginRename(entry: ProjectPathEntry): void;
  copyEntries(entries: ProjectPathEntry[]): void;
  cutEntries(entries: ProjectPathEntry[]): void;
  pasteEntries(input: {
    clipboard: WorkbenchFileClipboard;
    targetDirectoryProjectRelativePath: string;
    overwrite?: boolean;
  }): void;
  copyAbsolutePaths(entries: ProjectPathEntry[]): Promise<string[] | undefined>;
  revealEntry(entry: ProjectPathEntry): void;
  trashEntries(entries: ProjectPathEntry[]): void;
  deleteEntriesPermanently(entries: ProjectPathEntry[]): void;
  updateEditValue(value: string): void;
  submitEdit(): Promise<void>;
  cancelEdit(): void;
  clearCut(): void;
  handleInternalDrop(input: {
    entries: ProjectPathEntry[];
    targetDirectoryProjectRelativePath: string;
    operation: 'copy' | 'move';
  }): void;
  handleExternalDrop(input: {
    dataTransfer: DataTransfer;
    targetDirectoryProjectRelativePath: string;
  }): void;
  resetForProject(projectId: string | undefined): void;
}

export function useProjectExplorerController(input: {
  api: WorkbenchApiClient;
  projectId: string | undefined;
  snapshot: WorkbenchProjectSessionSnapshot | undefined;
  commitSnapshot(result: {
    projectRevision: number;
    snapshot: WorkbenchProjectSessionSnapshot;
  }): void;
  activeCanvasRuntime: CanvasEditorRuntime | undefined;
  locateProjectFileInCanvas(projectRelativePath: string): void;
  notify(message: string): void;
  i18n: WorkbenchI18n;
}): ProjectExplorerController {
  const [selection, setSelectionState] = useState<ProjectTreeSelectionState>(() => createEmptyProjectTreeSelection());
  const [fileClipboard, setFileClipboard] = useState<WorkbenchFileClipboard>();
  const [inlineEdit, setInlineEdit] = useState<ProjectTreeInlineEditState>();
  const projectScopeRef = useRef<ProjectCommandScope>({
    projectId: input.projectId,
    generation: 0
  });

  const captureProjectScope = useCallback((): ProjectCommandScope => ({ ...projectScopeRef.current }), []);
  const isCurrentProjectScope = useCallback((scope: ProjectCommandScope, resultProjectId?: string): boolean => {
    const current = projectScopeRef.current;
    return scope.generation === current.generation
      && scope.projectId === current.projectId
      && (resultProjectId === undefined || resultProjectId === scope.projectId);
  }, []);

  const resetForProject = useCallback((projectId: string | undefined) => {
    projectScopeRef.current = {
      projectId,
      generation: projectScopeRef.current.generation + 1
    };
    setSelectionState(createEmptyProjectTreeSelection());
    setFileClipboard(undefined);
    setInlineEdit(undefined);
  }, []);

  useEffect(() => {
    if (projectScopeRef.current.projectId !== input.projectId) {
      resetForProject(input.projectId);
    }
  }, [input.projectId, resetForProject]);

  const setSelection = useCallback((nextSelection: ProjectTreeSelectionState) => {
    setSelectionState(nextSelection);
  }, []);

  const beginCreateFile = useCallback((parentProjectRelativePath: string) => {
    setInlineEdit(createInlineEditState('creating-file', parentProjectRelativePath));
  }, []);

  const beginCreateDirectory = useCallback((parentProjectRelativePath: string) => {
    setInlineEdit(createInlineEditState('creating-directory', parentProjectRelativePath));
  }, []);

  const beginRename = useCallback((entry: ProjectPathEntry) => {
    setInlineEdit(createInlineEditState('renaming', entry.projectRelativePath));
  }, []);

  const copyEntries = useCallback((entries: ProjectPathEntry[]) => {
    setFileClipboard({ operation: 'copy', entries });
  }, []);

  const cutEntries = useCallback((entries: ProjectPathEntry[]) => {
    setFileClipboard({ operation: 'cut', entries });
  }, []);

  const updateEditValue = useCallback((value: string) => {
    setInlineEdit((current) => current ? { ...current, value } : current);
  }, []);

  const submitEdit = useCallback(async () => {
    const current = inlineEdit;
    if (!current || current.submitting) {
      return;
    }
    const validation = validateInlineProjectName(current.value);
    if (!validation.ok) {
      setInlineEdit({
        ...current,
        error: input.i18n.t(validation.message === 'required' ? 'explorer.nameRequired' : 'explorer.namePathSeparators')
      });
      return;
    }
    const { error: _error, ...submittingEdit } = current;
    const scope = captureProjectScope();
    setInlineEdit({ ...submittingEdit, submitting: true });
    try {
      const result = current.kind === 'renaming'
        ? await input.api.renameProjectPath({
            projectRelativePath: current.projectRelativePath,
            name: validation.name
          })
        : current.kind === 'creating-file'
          ? await input.api.createProjectFile({
              parentProjectRelativePath: current.parentProjectRelativePath,
              name: validation.name
            })
          : await input.api.createProjectDirectory({
              parentProjectRelativePath: current.parentProjectRelativePath,
              name: validation.name
            });
      if (!isCurrentProjectScope(scope, result.projectId)) {
        return;
      }
      input.commitSnapshot(result);
      setSelectionState(projectTreeSelectionFromPaths([result.projectRelativePath]));
      setInlineEdit(undefined);
    } catch (error) {
      if (isCurrentProjectScope(scope)) {
        setInlineEdit({ ...current, submitting: false, error: errorMessage(error) });
      }
    }
  }, [captureProjectScope, inlineEdit, input.api, input.commitSnapshot, input.i18n, isCurrentProjectScope]);

  const cancelEdit = useCallback(() => {
    setInlineEdit(undefined);
  }, []);

  const clearCut = useCallback(() => {
    setFileClipboard((current) => current?.operation === 'cut' ? undefined : current);
  }, []);

  const applyBatchResult = useCallback((
    result: WorkbenchProjectFileBatchOperationResult,
    scope: ProjectCommandScope
  ): boolean => {
    if (!isCurrentProjectScope(scope, result.projectId)) {
      return false;
    }
    input.commitSnapshot(result);
    setSelectionState(projectTreeSelectionFromPaths(batchResultSelectionPaths(result.results)));
    const locatedPath = singleFileBatchResultPath(result.results);
    if (locatedPath) {
      input.locateProjectFileInCanvas(locatedPath);
    }
    return true;
  }, [input.commitSnapshot, input.locateProjectFileInCanvas, isCurrentProjectScope]);

  const copyPaths = useCallback(async (copyInput: {
    entries: ProjectPathEntry[];
    targetDirectoryProjectRelativePath: string;
  }, scope: ProjectCommandScope): Promise<boolean> => {
    const result = await input.api.copyProjectPaths(copyInput);
    return applyBatchResult(result, scope);
  }, [applyBatchResult, input.api]);

  const movePaths = useCallback(async (moveInput: {
    entries: ProjectPathEntry[];
    targetDirectoryProjectRelativePath: string;
    overwrite?: boolean;
  }, scope: ProjectCommandScope): Promise<boolean> => {
    const result = await input.api.moveProjectPaths(moveInput);
    return applyBatchResult(result, scope);
  }, [applyBatchResult, input.api]);

  const pasteEntries = useCallback((pasteInput: {
    clipboard: WorkbenchFileClipboard;
    targetDirectoryProjectRelativePath: string;
    overwrite?: boolean;
  }) => {
    const scope = captureProjectScope();
    const request = pasteInput.clipboard.operation === 'cut'
      ? movePaths({
          entries: pasteInput.clipboard.entries,
          targetDirectoryProjectRelativePath: pasteInput.targetDirectoryProjectRelativePath,
          ...(pasteInput.overwrite ? { overwrite: true } : {})
        }, scope)
      : copyPaths({
          entries: pasteInput.clipboard.entries,
          targetDirectoryProjectRelativePath: pasteInput.targetDirectoryProjectRelativePath
        }, scope);
    void request.then((applied) => {
      if (applied) {
        setFileClipboard((current) => current === pasteInput.clipboard
          ? clearClipboardAfterPaste(current)
          : current);
      }
    }).catch((error) => {
      if (isCurrentProjectScope(scope)) {
        input.notify(notificationMessageForFileCommandError(input.i18n.t('shell.notifications.pasteFailed'), error));
      }
    });
  }, [captureProjectScope, copyPaths, input.i18n, input.notify, isCurrentProjectScope, movePaths]);

  const copyAbsolutePaths = useCallback(async (entries: ProjectPathEntry[]): Promise<string[] | undefined> => {
    const scope = captureProjectScope();
    try {
      const result = await input.api.copyProjectAbsolutePaths({ entries });
      return isCurrentProjectScope(scope) ? result.paths : undefined;
    } catch (error) {
      if (isCurrentProjectScope(scope)) {
        input.notify(notificationMessageForFileCommandError(input.i18n.t('shell.notifications.copyPathFailed'), error));
      }
      return undefined;
    }
  }, [captureProjectScope, input.api, input.i18n, input.notify, isCurrentProjectScope]);

  const revealEntry = useCallback((entry: ProjectPathEntry) => {
    const scope = captureProjectScope();
    void input.api.revealProjectPathInSystemFileManager(entry).catch((error) => {
      if (isCurrentProjectScope(scope)) {
        input.notify(notificationMessageForFileCommandError(input.i18n.t('shell.notifications.revealFailed'), error));
      }
    });
  }, [captureProjectScope, input.api, input.i18n, input.notify, isCurrentProjectScope]);

  const applyDeletedEntries = useCallback((
    entries: ProjectPathEntry[],
    snapshot: WorkbenchProjectSessionSnapshot
  ) => {
    const deletedPaths = entries.map((entry) => entry.projectRelativePath);
    if (input.activeCanvasRuntime) {
      const currentSelection = input.activeCanvasRuntime.getSnapshot().selection;
      input.activeCanvasRuntime.setSelection(deletedPaths.reduce(
        (current, deletedPath) => clearCanvasSelectionAfterDeletedPath(current, deletedPath),
        currentSelection
      ));
    }
    const existingPaths = new Set(snapshot.files.map((file) => file.projectRelativePath));
    setSelectionState((current) => {
      if (!current.selectedPaths.some((path) => deletedPaths.some((deletedPath) => isPathInside(path, deletedPath)))) {
        return current;
      }
      const fallback = current.focusedPath
        ? nearestExistingParentSelection(current.focusedPath, existingPaths)
        : undefined;
      return projectTreeSelectionFromPaths(fallback ? [fallback] : []);
    });
    setFileClipboard((current) => deletedPaths.reduce(
      (clipboard, deletedPath) => clearClipboardAfterDeletedPath(clipboard, deletedPath),
      current
    ));
  }, [input.activeCanvasRuntime]);

  const deleteEntries = useCallback((entries: ProjectPathEntry[], permanent: boolean) => {
    const scope = captureProjectScope();
    const request = permanent
      ? input.api.deleteProjectPathsPermanently({ entries })
      : input.api.trashProjectPaths({ entries });
    void request.then((result) => {
      if (!isCurrentProjectScope(scope, result.projectId)) {
        return;
      }
      input.commitSnapshot(result);
      applyDeletedEntries(entries, result.snapshot);
    }).catch((error) => {
      if (isCurrentProjectScope(scope)) {
        input.notify(notificationMessageForFileCommandError(input.i18n.t('shell.notifications.deleteFailed'), error));
      }
    });
  }, [applyDeletedEntries, captureProjectScope, input.api, input.commitSnapshot, input.i18n, input.notify, isCurrentProjectScope]);

  const trashEntries = useCallback((entries: ProjectPathEntry[]) => {
    deleteEntries(entries, false);
  }, [deleteEntries]);

  const deleteEntriesPermanently = useCallback((entries: ProjectPathEntry[]) => {
    deleteEntries(entries, true);
  }, [deleteEntries]);

  const handleInternalDrop = useCallback((dropInput: {
    entries: ProjectPathEntry[];
    targetDirectoryProjectRelativePath: string;
    operation: 'copy' | 'move';
  }) => {
    const scope = captureProjectScope();
    if (dropInput.operation === 'copy') {
      void copyPaths({
        entries: dropInput.entries,
        targetDirectoryProjectRelativePath: dropInput.targetDirectoryProjectRelativePath
      }, scope).catch((error) => {
        if (isCurrentProjectScope(scope)) {
          input.notify(input.i18n.t('shell.notifications.copyFailed', { message: errorMessage(error) }));
        }
      });
      return;
    }
    if (isProjectTreeMoveNoop(dropInput)) {
      return;
    }
    const overwrite = projectTreeBatchMoveHasConflict({
      existingProjectRelativePaths: new Set(input.snapshot?.files.map((file) => file.projectRelativePath) ?? []),
      entries: dropInput.entries,
      targetDirectoryProjectRelativePath: dropInput.targetDirectoryProjectRelativePath
    });
    const target = dropInput.targetDirectoryProjectRelativePath || input.i18n.t('shell.confirm.projectRoot');
    if (!window.confirm(overwrite
      ? input.i18n.t('shell.confirm.moveOverwrite', { target })
      : input.i18n.t('shell.confirm.moveItems', { count: dropInput.entries.length, target }))) {
      return;
    }
    void movePaths({
      entries: dropInput.entries,
      targetDirectoryProjectRelativePath: dropInput.targetDirectoryProjectRelativePath,
      ...(overwrite ? { overwrite: true } : {})
    }, scope).catch((error) => {
      if (isCurrentProjectScope(scope)) {
        input.notify(input.i18n.t('shell.notifications.moveFailed', { message: errorMessage(error) }));
      }
    });
  }, [captureProjectScope, copyPaths, input.i18n, input.notify, input.snapshot, isCurrentProjectScope, movePaths]);

  const handleExternalDrop = useCallback((dropInput: {
    dataTransfer: DataTransfer;
    targetDirectoryProjectRelativePath: string;
  }) => {
    const scope = captureProjectScope();
    void createProjectTreeExternalDropPlan({
      dataTransfer: dropInput.dataTransfer,
      shell: getDebruteShellApi(),
      targetDirectoryProjectRelativePath: dropInput.targetDirectoryProjectRelativePath
    }).then(async (plan) => {
      if (!isCurrentProjectScope(scope)) {
        return;
      }
      const overwrite = externalDropPlanHasConflict({
        snapshot: input.snapshot,
        localPaths: plan.localPaths,
        uploads: plan.uploads,
        targetDirectoryProjectRelativePath: plan.targetDirectoryProjectRelativePath
      });
      if (overwrite && !window.confirm(input.i18n.t('shell.confirm.moveOverwrite', {
        target: plan.targetDirectoryProjectRelativePath || input.i18n.t('shell.confirm.projectRoot')
      }))) {
        return;
      }
      const result = plan.localPaths.length > 0
        ? await input.api.importExternalLocalProjectPaths({
            sources: plan.localPaths,
            targetDirectoryProjectRelativePath: plan.targetDirectoryProjectRelativePath,
            ...(overwrite ? { overwrite: true } : {})
          })
        : await input.api.importExternalProjectUploads({
            entries: plan.uploads.map((upload) => (
              upload.kind === 'file'
                ? { kind: 'file', projectRelativePath: upload.projectRelativePath, file: upload.file }
                : upload
            )),
            targetDirectoryProjectRelativePath: plan.targetDirectoryProjectRelativePath,
            ...(overwrite ? { overwrite: true } : {})
          });
      applyBatchResult(result, scope);
    }).catch((error) => {
      if (isCurrentProjectScope(scope)) {
        input.notify(input.i18n.t('shell.notifications.importFailed', { message: errorMessage(error) }));
      }
    });
  }, [applyBatchResult, captureProjectScope, input.api, input.i18n, input.notify, input.snapshot, isCurrentProjectScope]);

  return useMemo(() => ({
    selection,
    fileClipboard,
    inlineEdit,
    setSelection,
    beginCreateFile,
    beginCreateDirectory,
    beginRename,
    copyEntries,
    cutEntries,
    pasteEntries,
    copyAbsolutePaths,
    revealEntry,
    trashEntries,
    deleteEntriesPermanently,
    updateEditValue,
    submitEdit,
    cancelEdit,
    clearCut,
    handleInternalDrop,
    handleExternalDrop,
    resetForProject
  }), [
    beginCreateDirectory,
    beginCreateFile,
    beginRename,
    cancelEdit,
    clearCut,
    copyAbsolutePaths,
    copyEntries,
    cutEntries,
    deleteEntriesPermanently,
    fileClipboard,
    handleExternalDrop,
    handleInternalDrop,
    inlineEdit,
    pasteEntries,
    resetForProject,
    revealEntry,
    selection,
    setSelection,
    submitEdit,
    trashEntries,
    updateEditValue
  ]);
}

function isPathInside(path: string, parentPath: string): boolean {
  return path === parentPath || path.startsWith(`${parentPath}/`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
