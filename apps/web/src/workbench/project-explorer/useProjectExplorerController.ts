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

type DirectoryLoadOutcome =
  | { ok: true }
  | { ok: false; error: unknown };

interface PendingCreateParentLoad {
  token: number;
  parentProjectRelativePath: string;
  outcome: Promise<DirectoryLoadOutcome>;
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
  loadDirectory(projectRelativeDirectory: string): void;
  handleInternalDrop(input: {
    entries: ProjectPathEntry[];
    targetDirectoryProjectRelativePath: string;
    operation: 'copy' | 'move';
  }): void;
  handleExternalDrop(input: {
    dataTransfer: DataTransfer;
    targetDirectoryProjectRelativePath: string;
  }): void;
}

export function useProjectExplorerController(input: {
  api: WorkbenchApiClient;
  projectId: string | undefined;
  projectGeneration: number;
  getSnapshot(): WorkbenchProjectSessionSnapshot | undefined;
  activeCanvasRuntime: CanvasEditorRuntime | undefined;
  locateProjectFileInCanvas(projectRelativePath: string): void;
  notify(message: string): void;
  i18n: WorkbenchI18n;
  canStartProjectPathCommand(): boolean;
  isCurrentProjectPathCommandScope(): boolean;
}): ProjectExplorerController {
  const { canStartProjectPathCommand, isCurrentProjectPathCommandScope } = input;
  const [selection, setSelectionState] = useState<ProjectTreeSelectionState>(() => createEmptyProjectTreeSelection());
  const [fileClipboard, setFileClipboard] = useState<WorkbenchFileClipboard>();
  const [inlineEdit, setInlineEdit] = useState<ProjectTreeInlineEditState>();
  const projectScopeRef = useRef<ProjectCommandScope>({
    projectId: input.projectId,
    generation: input.projectGeneration
  });
  const editIntentTokenRef = useRef(0);
  const pendingCreateParentLoadRef = useRef<PendingCreateParentLoad | undefined>(undefined);

  const captureProjectScope = useCallback((): ProjectCommandScope => ({ ...projectScopeRef.current }), []);
  const isCurrentProjectScope = useCallback((scope: ProjectCommandScope, resultProjectId?: string): boolean => {
    const current = projectScopeRef.current;
    return scope.generation === current.generation
      && scope.projectId === current.projectId
      && isCurrentProjectPathCommandScope()
      && (resultProjectId === undefined || resultProjectId === scope.projectId);
  }, [isCurrentProjectPathCommandScope]);

  useEffect(() => {
    return () => {
      editIntentTokenRef.current += 1;
      pendingCreateParentLoadRef.current = undefined;
      projectScopeRef.current = {
        projectId: undefined,
        generation: projectScopeRef.current.generation + 1
      };
    };
  }, []);

  const setSelection = useCallback((nextSelection: ProjectTreeSelectionState) => {
    setSelectionState(nextSelection);
  }, []);

  const requestDirectory = useCallback(async (projectRelativeDirectory: string): Promise<void> => {
    if (!canStartProjectPathCommand()) {
      throw new Error('Project path commands are unavailable.');
    }
    const scope = captureProjectScope();
    try {
      const result = await input.api.loadProjectDirectory(projectRelativeDirectory);
      if (!isCurrentProjectScope(scope, result.projectId)) {
        throw new Error('Project changed while its directory was loading.');
      }
    } catch (error) {
      if (isCurrentProjectScope(scope)) {
        input.notify(notificationMessageForFileCommandError(
          input.i18n.t('shell.notifications.loadProjectDirectoryFailed'),
          error
        ));
      }
      throw error;
    }
  }, [canStartProjectPathCommand, captureProjectScope, input.api, input.i18n, input.notify, isCurrentProjectScope]);

  const loadDirectory = useCallback((projectRelativeDirectory: string) => {
    void requestDirectory(projectRelativeDirectory).catch(() => undefined);
  }, [requestDirectory]);

  const beginCreate = useCallback((
    kind: 'creating-file' | 'creating-directory',
    parentProjectRelativePath: string
  ) => {
    if (!canStartProjectPathCommand()) {
      return;
    }
    const token = editIntentTokenRef.current + 1;
    editIntentTokenRef.current = token;
    pendingCreateParentLoadRef.current = parentProjectRelativePath
      ? {
          token,
          parentProjectRelativePath,
          outcome: directoryLoadOutcome(requestDirectory(parentProjectRelativePath))
        }
      : undefined;
    setInlineEdit(createInlineEditState(kind, parentProjectRelativePath));
  }, [canStartProjectPathCommand, requestDirectory]);

  const beginCreateFile = useCallback((parentProjectRelativePath: string) => {
    beginCreate('creating-file', parentProjectRelativePath);
  }, [beginCreate]);

  const beginCreateDirectory = useCallback((parentProjectRelativePath: string) => {
    beginCreate('creating-directory', parentProjectRelativePath);
  }, [beginCreate]);

  const beginRename = useCallback((entry: ProjectPathEntry) => {
    if (!canStartProjectPathCommand()) {
      return;
    }
    editIntentTokenRef.current += 1;
    pendingCreateParentLoadRef.current = undefined;
    setInlineEdit(createInlineEditState('renaming', entry.projectRelativePath));
  }, [canStartProjectPathCommand]);

  const copyEntries = useCallback((entries: ProjectPathEntry[]) => {
    if (!canStartProjectPathCommand()) {
      return;
    }
    setFileClipboard({ operation: 'copy', entries });
  }, [canStartProjectPathCommand]);

  const cutEntries = useCallback((entries: ProjectPathEntry[]) => {
    if (!canStartProjectPathCommand()) {
      return;
    }
    setFileClipboard({ operation: 'cut', entries });
  }, [canStartProjectPathCommand]);

  const updateEditValue = useCallback((value: string) => {
    setInlineEdit((current) => current ? { ...current, value } : current);
  }, []);

  const submitEdit = useCallback(async () => {
    if (!canStartProjectPathCommand()) {
      return;
    }
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
    const intentToken = editIntentTokenRef.current;
    setInlineEdit({ ...submittingEdit, submitting: true });
    try {
      if (current.kind === 'creating-file' || current.kind === 'creating-directory') {
        const parent = current.parentProjectRelativePath;
        if (parent) {
          let pending = pendingCreateParentLoadRef.current;
          if (
            !pending
            || pending.token !== intentToken
            || pending.parentProjectRelativePath !== parent
          ) {
            pending = {
              token: intentToken,
              parentProjectRelativePath: parent,
              outcome: directoryLoadOutcome(requestDirectory(parent))
            };
            pendingCreateParentLoadRef.current = pending;
          }
          const outcome = await pending.outcome;
          if (
            editIntentTokenRef.current !== intentToken
            || !isCurrentProjectScope(scope)
          ) {
            return;
          }
          if (!outcome.ok) {
            pendingCreateParentLoadRef.current = undefined;
            setInlineEdit({ ...current, submitting: false, error: errorMessage(outcome.error) });
            return;
          }
        }
      }
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
      setSelectionState(projectTreeSelectionFromPaths([result.projectRelativePath]));
      pendingCreateParentLoadRef.current = undefined;
      setInlineEdit(undefined);
    } catch (error) {
      if (isCurrentProjectScope(scope)) {
        setInlineEdit({ ...current, submitting: false, error: errorMessage(error) });
      }
    }
  }, [canStartProjectPathCommand, captureProjectScope, inlineEdit, input.api, input.i18n, isCurrentProjectScope, requestDirectory]);

  const cancelEdit = useCallback(() => {
    editIntentTokenRef.current += 1;
    pendingCreateParentLoadRef.current = undefined;
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
    setSelectionState(projectTreeSelectionFromPaths(batchResultSelectionPaths(result.results)));
    const locatedPath = singleFileBatchResultPath(result.results);
    if (locatedPath) {
      input.locateProjectFileInCanvas(locatedPath);
    }
    return true;
  }, [input.locateProjectFileInCanvas, isCurrentProjectScope]);

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
    if (!canStartProjectPathCommand()) {
      return;
    }
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
  }, [canStartProjectPathCommand, captureProjectScope, copyPaths, input.i18n, input.notify, isCurrentProjectScope, movePaths]);

  const copyAbsolutePaths = useCallback(async (entries: ProjectPathEntry[]): Promise<string[] | undefined> => {
    if (!canStartProjectPathCommand()) {
      return undefined;
    }
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
  }, [canStartProjectPathCommand, captureProjectScope, input.api, input.i18n, input.notify, isCurrentProjectScope]);

  const revealEntry = useCallback((entry: ProjectPathEntry) => {
    if (!canStartProjectPathCommand()) {
      return;
    }
    const scope = captureProjectScope();
    void input.api.revealProjectPathInSystemFileManager(entry).catch((error) => {
      if (isCurrentProjectScope(scope)) {
        input.notify(notificationMessageForFileCommandError(input.i18n.t('shell.notifications.revealFailed'), error));
      }
    });
  }, [canStartProjectPathCommand, captureProjectScope, input.api, input.i18n, input.notify, isCurrentProjectScope]);

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
    if (!canStartProjectPathCommand()) {
      return;
    }
    const scope = captureProjectScope();
    const request = permanent
      ? input.api.deleteProjectPathsPermanently({ entries })
      : input.api.trashProjectPaths({ entries });
    void request.then((result) => {
      if (!isCurrentProjectScope(scope, result.projectId)) {
        return;
      }
      const acceptedSnapshot = input.getSnapshot();
      if (!acceptedSnapshot) {
        return;
      }
      applyDeletedEntries(entries, acceptedSnapshot);
    }).catch((error) => {
      if (isCurrentProjectScope(scope)) {
        input.notify(notificationMessageForFileCommandError(input.i18n.t('shell.notifications.deleteFailed'), error));
      }
    });
  }, [applyDeletedEntries, canStartProjectPathCommand, captureProjectScope, input.api, input.getSnapshot, input.i18n, input.notify, isCurrentProjectScope]);

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
    if (!canStartProjectPathCommand()) {
      return;
    }
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
      existingProjectRelativePaths: new Set(input.getSnapshot()?.files.map((file) => file.projectRelativePath) ?? []),
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
  }, [canStartProjectPathCommand, captureProjectScope, copyPaths, input.getSnapshot, input.i18n, input.notify, isCurrentProjectScope, movePaths]);

  const handleExternalDrop = useCallback((dropInput: {
    dataTransfer: DataTransfer;
    targetDirectoryProjectRelativePath: string;
  }) => {
    if (!canStartProjectPathCommand()) {
      return;
    }
    const scope = captureProjectScope();
    void createProjectTreeExternalDropPlan({
      dataTransfer: dropInput.dataTransfer,
      shell: getDebruteShellApi(),
      targetDirectoryProjectRelativePath: dropInput.targetDirectoryProjectRelativePath
    }).then(async (plan) => {
      if (!canStartProjectPathCommand() || !isCurrentProjectScope(scope)) {
        return;
      }
      const overwrite = externalDropPlanHasConflict({
        snapshot: input.getSnapshot(),
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
  }, [applyBatchResult, canStartProjectPathCommand, captureProjectScope, input.api, input.getSnapshot, input.i18n, input.notify, isCurrentProjectScope]);

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
    loadDirectory,
    handleInternalDrop,
    handleExternalDrop
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
    loadDirectory,
    pasteEntries,
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

function directoryLoadOutcome(request: Promise<void>): Promise<DirectoryLoadOutcome> {
  return request.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error })
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
