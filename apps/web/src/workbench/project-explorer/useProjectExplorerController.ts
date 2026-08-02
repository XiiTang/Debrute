import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ExplorerActivityOperation,
  ProjectPathEntry,
  WorkbenchProjectFileBatchOperationResult,
  WorkbenchProjectSessionSnapshot
} from '@debrute/app-protocol';
import { getDebruteShellApi } from '../../api/shellApi';
import type { CanvasEditorRuntime } from '../canvas/runtime/CanvasEditorRuntime';
import type { WorkbenchI18n } from '../i18n';
import type { ProjectPathCommandEffects } from '../services/projectPathCommandEffects.js';
import type { AcceptedProjectPathCommandScope } from '../services/projectPathCommandIntake.js';
import type { WorkbenchFileClipboard } from '../shell/contextMenu';
import type { WorkbenchActivityNoticeReporter } from '../services/WorkbenchActivities.js';
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
  projectTreeSelectionFromPaths,
  reconcileCutClipboardWithProjectEntries,
  singleFileBatchResultPath
} from './workbenchFileCommands.js';

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
  beginCreateFile(scope: AcceptedProjectPathCommandScope, parentProjectRelativePath: string): void;
  beginCreateDirectory(scope: AcceptedProjectPathCommandScope, parentProjectRelativePath: string): void;
  beginRename(scope: AcceptedProjectPathCommandScope, entry: ProjectPathEntry): void;
  copyEntries(scope: AcceptedProjectPathCommandScope, entries: ProjectPathEntry[]): void;
  cutEntries(scope: AcceptedProjectPathCommandScope, entries: ProjectPathEntry[]): void;
  pasteEntries(scope: AcceptedProjectPathCommandScope, input: {
    clipboard: WorkbenchFileClipboard;
    targetDirectoryProjectRelativePath: string;
    overwrite?: boolean;
  }): void;
  revealEntry(scope: AcceptedProjectPathCommandScope, entry: ProjectPathEntry): void;
  trashEntries(scope: AcceptedProjectPathCommandScope, entries: ProjectPathEntry[]): void;
  deleteEntriesPermanently(scope: AcceptedProjectPathCommandScope, entries: ProjectPathEntry[]): void;
  updateEditValue(value: string): void;
  submitEdit(scope: AcceptedProjectPathCommandScope): Promise<void>;
  cancelEdit(): void;
  clearCut(): void;
  loadDirectory(scope: AcceptedProjectPathCommandScope, projectRelativeDirectory: string): void;
  handleInternalDrop(scope: AcceptedProjectPathCommandScope, input: {
    entries: ProjectPathEntry[];
    targetDirectoryProjectRelativePath: string;
    operation: 'copy' | 'move';
  }): void;
  handleExternalDrop(scope: AcceptedProjectPathCommandScope, input: {
    dataTransfer: DataTransfer;
    targetDirectoryProjectRelativePath: string;
  }): void;
}

export interface ProjectExplorerControllerInput {
  commandEffects: ProjectPathCommandEffects;
  getSnapshot(): WorkbenchProjectSessionSnapshot | undefined;
  activeCanvasRuntime: CanvasEditorRuntime | undefined;
  centerProjectFileInCanvas(projectRelativePath: string): void;
  activities: WorkbenchActivityNoticeReporter;
  i18n: WorkbenchI18n;
}

export function useProjectExplorerController(
  input: ProjectExplorerControllerInput
): ProjectExplorerController {
  const { commandEffects } = input;
  const [selection, setSelectionState] = useState<ProjectTreeSelectionState>(() => createEmptyProjectTreeSelection());
  const [fileClipboard, setFileClipboard] = useState<WorkbenchFileClipboard>();
  const [inlineEdit, setInlineEdit] = useState<ProjectTreeInlineEditState>();
  const editIntentTokenRef = useRef(0);
  const pendingCreateParentLoadRef = useRef<PendingCreateParentLoad | undefined>(undefined);
  const acceptedSnapshot = input.getSnapshot();
  const reportExplorerFailure = useCallback((operation: ExplorerActivityOperation) => {
    input.activities.report({ kind: 'explorer-operation-failed', operation });
  }, [input.activities]);

  useEffect(() => {
    if (!acceptedSnapshot) {
      return;
    }
    setFileClipboard((current) => reconcileCutClipboardWithProjectEntries(
      current,
      acceptedSnapshot.files
    ));
  }, [acceptedSnapshot]);

  useEffect(() => {
    return () => {
      editIntentTokenRef.current += 1;
      pendingCreateParentLoadRef.current = undefined;
    };
  }, []);

  const setSelection = useCallback((nextSelection: ProjectTreeSelectionState) => {
    setSelectionState(nextSelection);
  }, []);

  const requestDirectory = useCallback(async (
    projectRelativeDirectory: string,
    scope: AcceptedProjectPathCommandScope
  ): Promise<void> => {
    const request = commandEffects.loadProjectDirectory(scope, projectRelativeDirectory);
    if (!request) {
      throw new Error('Project path commands are unavailable.');
    }
    try {
      const result = await request;
      if (!scope.isCurrent(result.projectId)) {
        throw new Error('Project changed while its directory was loading.');
      }
    } catch (error) {
      if (scope.isCurrent()) {
        reportExplorerFailure('load-directory');
      }
      throw error;
    }
  }, [commandEffects, reportExplorerFailure]);

  const loadDirectory = useCallback((
    scope: AcceptedProjectPathCommandScope,
    projectRelativeDirectory: string
  ) => {
    void requestDirectory(projectRelativeDirectory, scope).catch(() => undefined);
  }, [requestDirectory]);

  const beginCreate = useCallback((
    scope: AcceptedProjectPathCommandScope,
    kind: 'creating-file' | 'creating-directory',
    parentProjectRelativePath: string
  ) => {
    const token = editIntentTokenRef.current + 1;
    editIntentTokenRef.current = token;
    pendingCreateParentLoadRef.current = parentProjectRelativePath
      ? {
          token,
          parentProjectRelativePath,
          outcome: directoryLoadOutcome(requestDirectory(parentProjectRelativePath, scope))
        }
      : undefined;
    setInlineEdit(createInlineEditState(kind, parentProjectRelativePath));
  }, [requestDirectory]);

  const beginCreateFile = useCallback((
    scope: AcceptedProjectPathCommandScope,
    parentProjectRelativePath: string
  ) => {
    beginCreate(scope, 'creating-file', parentProjectRelativePath);
  }, [beginCreate]);

  const beginCreateDirectory = useCallback((
    scope: AcceptedProjectPathCommandScope,
    parentProjectRelativePath: string
  ) => {
    beginCreate(scope, 'creating-directory', parentProjectRelativePath);
  }, [beginCreate]);

  const beginRename = useCallback((
    _scope: AcceptedProjectPathCommandScope,
    entry: ProjectPathEntry
  ) => {
    editIntentTokenRef.current += 1;
    pendingCreateParentLoadRef.current = undefined;
    setInlineEdit(createInlineEditState('renaming', entry.projectRelativePath));
  }, []);

  const copyEntries = useCallback((
    _scope: AcceptedProjectPathCommandScope,
    entries: ProjectPathEntry[]
  ) => {
    setFileClipboard({ operation: 'copy', entries: [...entries] });
  }, []);

  const cutEntries = useCallback((
    _scope: AcceptedProjectPathCommandScope,
    entries: ProjectPathEntry[]
  ) => {
    setFileClipboard({ operation: 'cut', entries: [...entries] });
  }, []);

  const updateEditValue = useCallback((value: string) => {
    setInlineEdit((current) => current ? { ...current, value } : current);
  }, []);

  const submitEdit = useCallback(async (scope: AcceptedProjectPathCommandScope) => {
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
              outcome: directoryLoadOutcome(requestDirectory(parent, scope))
            };
            pendingCreateParentLoadRef.current = pending;
          }
          const outcome = await pending.outcome;
          if (
            editIntentTokenRef.current !== intentToken
            || !scope.isCurrent()
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
      const request = current.kind === 'renaming'
        ? commandEffects.renameProjectPath(scope, {
            projectRelativePath: current.projectRelativePath,
            name: validation.name
          })
        : current.kind === 'creating-file'
          ? commandEffects.createProjectFile(scope, {
              parentProjectRelativePath: current.parentProjectRelativePath,
              name: validation.name
            })
          : commandEffects.createProjectDirectory(scope, {
              parentProjectRelativePath: current.parentProjectRelativePath,
              name: validation.name
            });
      if (!request) {
        return;
      }
      const result = await request;
      if (!scope.isCurrent(result.projectId)) {
        return;
      }
      setSelectionState(projectTreeSelectionFromPaths([result.projectRelativePath]));
      pendingCreateParentLoadRef.current = undefined;
      setInlineEdit(undefined);
    } catch (error) {
      if (scope.isCurrent()) {
        setInlineEdit({ ...current, submitting: false, error: errorMessage(error) });
      }
    }
  }, [commandEffects, inlineEdit, input.i18n, requestDirectory]);

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
    scope: AcceptedProjectPathCommandScope
  ): boolean => {
    if (!scope.isCurrent(result.projectId)) {
      return false;
    }
    setSelectionState(projectTreeSelectionFromPaths(batchResultSelectionPaths(result.results)));
    const locatedPath = singleFileBatchResultPath(result.results);
    if (locatedPath) {
      input.centerProjectFileInCanvas(locatedPath);
    }
    return true;
  }, [input.centerProjectFileInCanvas]);

  const copyPaths = useCallback(async (copyInput: {
    entries: ProjectPathEntry[];
    targetDirectoryProjectRelativePath: string;
  }, scope: AcceptedProjectPathCommandScope): Promise<boolean> => {
    const request = commandEffects.copyProjectPaths(scope, copyInput);
    if (!request) {
      return false;
    }
    const result = await request;
    return applyBatchResult(result, scope);
  }, [applyBatchResult, commandEffects]);

  const movePaths = useCallback(async (moveInput: {
    entries: ProjectPathEntry[];
    targetDirectoryProjectRelativePath: string;
    overwrite?: boolean;
  }, scope: AcceptedProjectPathCommandScope): Promise<boolean> => {
    const request = commandEffects.moveProjectPaths(scope, moveInput);
    if (!request) {
      return false;
    }
    const result = await request;
    return applyBatchResult(result, scope);
  }, [applyBatchResult, commandEffects]);

  const pasteEntries = useCallback((scope: AcceptedProjectPathCommandScope, pasteInput: {
    clipboard: WorkbenchFileClipboard;
    targetDirectoryProjectRelativePath: string;
    overwrite?: boolean;
  }) => {
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
    }).catch(() => {
      if (scope.isCurrent()) {
        reportExplorerFailure('paste');
      }
    });
  }, [copyPaths, movePaths, reportExplorerFailure]);

  const revealEntry = useCallback((scope: AcceptedProjectPathCommandScope, entry: ProjectPathEntry) => {
    const request = commandEffects.revealProjectPathInSystemFileManager(scope, entry);
    void request?.catch(() => {
      if (scope.isCurrent()) {
        reportExplorerFailure('reveal');
      }
    });
  }, [commandEffects, reportExplorerFailure]);

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

  const deleteEntries = useCallback((
    scope: AcceptedProjectPathCommandScope,
    entries: ProjectPathEntry[],
    permanent: boolean
  ) => {
    const request = permanent
      ? commandEffects.deleteProjectPathsPermanently(scope, { entries })
      : commandEffects.trashProjectPaths(scope, { entries });
    if (!request) {
      return;
    }
    void request.then((result) => {
      if (!scope.isCurrent(result.projectId)) {
        return;
      }
      const acceptedSnapshot = input.getSnapshot();
      if (!acceptedSnapshot) {
        return;
      }
      applyDeletedEntries(entries, acceptedSnapshot);
    }).catch(() => {
      if (scope.isCurrent()) {
        reportExplorerFailure('delete');
      }
    });
  }, [applyDeletedEntries, commandEffects, input.getSnapshot, reportExplorerFailure]);

  const trashEntries = useCallback((scope: AcceptedProjectPathCommandScope, entries: ProjectPathEntry[]) => {
    deleteEntries(scope, entries, false);
  }, [deleteEntries]);

  const deleteEntriesPermanently = useCallback((scope: AcceptedProjectPathCommandScope, entries: ProjectPathEntry[]) => {
    deleteEntries(scope, entries, true);
  }, [deleteEntries]);

  const handleInternalDrop = useCallback((scope: AcceptedProjectPathCommandScope, dropInput: {
    entries: ProjectPathEntry[];
    targetDirectoryProjectRelativePath: string;
    operation: 'copy' | 'move';
  }) => {
    if (dropInput.operation === 'copy') {
      void copyPaths({
        entries: dropInput.entries,
        targetDirectoryProjectRelativePath: dropInput.targetDirectoryProjectRelativePath
      }, scope).catch(() => {
        if (scope.isCurrent()) {
          reportExplorerFailure('copy');
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
    }, scope).catch(() => {
      if (scope.isCurrent()) {
        reportExplorerFailure('move');
      }
    });
  }, [copyPaths, input.getSnapshot, input.i18n, movePaths, reportExplorerFailure]);

  const handleExternalDrop = useCallback((scope: AcceptedProjectPathCommandScope, dropInput: {
    dataTransfer: DataTransfer;
    targetDirectoryProjectRelativePath: string;
  }) => {
    void createProjectTreeExternalDropPlan({
      dataTransfer: dropInput.dataTransfer,
      shell: getDebruteShellApi(),
      targetDirectoryProjectRelativePath: dropInput.targetDirectoryProjectRelativePath
    }).then(async (plan) => {
      if (!scope.canSubmit()) {
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
      const request = plan.localPaths.length > 0
        ? commandEffects.importExternalLocalProjectPaths(scope, {
            sources: plan.localPaths,
            targetDirectoryProjectRelativePath: plan.targetDirectoryProjectRelativePath,
            ...(overwrite ? { overwrite: true } : {})
          })
        : commandEffects.importExternalProjectUploads(scope, {
            entries: plan.uploads.map((upload) => (
              upload.kind === 'file'
                ? { kind: 'file', projectRelativePath: upload.projectRelativePath, file: upload.file }
                : upload
            )),
            targetDirectoryProjectRelativePath: plan.targetDirectoryProjectRelativePath,
            ...(overwrite ? { overwrite: true } : {})
          });
      if (!request) {
        return;
      }
      const result = await request;
      applyBatchResult(result, scope);
    }).catch(() => {
      if (scope.isCurrent()) {
        reportExplorerFailure('import');
      }
    });
  }, [applyBatchResult, commandEffects, input.getSnapshot, input.i18n, reportExplorerFailure]);

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
