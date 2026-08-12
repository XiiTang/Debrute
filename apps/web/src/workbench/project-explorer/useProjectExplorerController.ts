import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type {
  ExplorerActivityOperation,
  ProjectPathBatchItemResult,
  ProjectPathRef,
  WorkbenchApiClient,
  WorkbenchProjectFileBatchAttemptResult,
  WorkbenchProjectFileBatchOperationResult,
  WorkbenchProjectSessionSnapshot
} from '@debrute/app-protocol';
import type { ProjectCommandGate, ProjectCommandScope } from '../services/projectCommandGate';
import {
  projectPathBasename,
  projectPathParent,
  resolveProjectPathCommandTarget
} from '../services/projectPathCommandTarget';
import type { WorkbenchActivityNoticeReporter } from '../services/WorkbenchActivities';
import type { ProjectExternalDropSource } from './projectTreeExternalDrop';

export interface ProjectExplorerSelection {
  selectedPaths: string[];
  focusedPath: string | null;
  anchorPath: string | null;
}

export interface ProjectExplorerClipboard {
  operation: 'copy' | 'cut';
  entries: ProjectPathRef[];
}

export type InlineProjectEdit = {
  target:
    | {
        kind: 'create';
        entryKind: 'file' | 'directory';
        parentProjectRelativePath: string;
      }
    | { kind: 'rename'; entry: ProjectPathRef };
  value: string;
  revision: number;
} & (
  | { phase: 'editing'; error?: string }
  | { phase: 'submitting' }
);

export interface ProjectExplorerViewState {
  acceptedProjectRevision: number;
  selection: ProjectExplorerSelection;
  expanded: ReadonlySet<string>;
  clipboard: ProjectExplorerClipboard | undefined;
  edit: InlineProjectEdit | undefined;
}

type ProjectExplorerAction =
  | { type: 'accept-snapshot'; snapshot: WorkbenchProjectSessionSnapshot; revision: number }
  | { type: 'set-selection'; selection: ProjectExplorerSelection }
  | { type: 'toggle-directory'; projectRelativePath: string }
  | { type: 'set-clipboard'; clipboard: ProjectExplorerClipboard | undefined }
  | { type: 'begin-edit'; edit: InlineProjectEdit }
  | { type: 'update-edit'; value: string }
  | { type: 'submit-edit'; revision: number }
  | { type: 'resume-edit'; revision: number }
  | { type: 'fail-edit'; revision: number; error: string }
  | { type: 'cancel-edit'; revision?: number }
  | {
      type: 'settle-create';
      editRevision: number;
      snapshot: WorkbenchProjectSessionSnapshot;
      projectRevision: number;
      projectRelativePath: string;
    }
  | {
      type: 'settle-transfer';
      snapshot: WorkbenchProjectSessionSnapshot;
      projectRevision: number;
      results: readonly ProjectPathBatchItemResult[];
      operation: 'copy' | 'move';
      intent: Pick<ProjectExplorerViewState, 'selection' | 'expanded' | 'clipboard'>;
      editRevision?: number;
    };

export interface ProjectExplorerController {
  state: ProjectExplorerViewState;
  selection: ProjectExplorerSelection;
  fileClipboard: ProjectExplorerClipboard | undefined;
  inlineEdit: InlineProjectEdit | undefined;
  setSelection(selection: ProjectExplorerSelection): void;
  toggleDirectory(projectRelativePath: string): void;
  beginCreate(kind: 'file' | 'directory', parentProjectRelativePath: string): void;
  beginRename(entry: ProjectPathRef): void;
  setClipboard(operation: 'copy' | 'cut', entries: readonly ProjectPathRef[]): void;
  paste(targetDirectoryProjectRelativePath: string): void;
  transfer(
    operation: 'copy' | 'move',
    entries: readonly ProjectPathRef[],
    targetDirectoryProjectRelativePath: string
  ): void;
  deleteEntries(mode: 'trash' | 'permanent', entries: readonly ProjectPathRef[]): void;
  reveal(entry: ProjectPathRef): void;
  externalDrop(source: ProjectExternalDropSource, targetDirectoryProjectRelativePath: string): void;
  updateEditValue(value: string): void;
  submitEdit(): Promise<void>;
  cancelEdit(): void;
  handleEditCommand(command: ProjectExplorerEditCommand): void;
  ensureDirectoryLoaded(projectRelativePath: string): Promise<void>;
}

export type ProjectExplorerEditCommand =
  | 'escape'
  | 'select-all'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'trash'
  | 'delete-permanently';

export interface ProjectExplorerControllerInput {
  api: WorkbenchApiClient;
  commandGate: ProjectCommandGate;
  snapshot: WorkbenchProjectSessionSnapshot | undefined;
  projectRevision: number;
  activities: WorkbenchActivityNoticeReporter;
  confirmOverwrite(input: {
    entries: readonly ProjectPathRef[];
    targetDirectoryProjectRelativePath: string;
  }): boolean;
  confirmDelete(input: {
    mode: 'trash' | 'permanent';
    entries: readonly ProjectPathRef[];
  }): boolean;
  onInspectionSelectionChange(selection: ProjectExplorerSelection): void;
}

export function useProjectExplorerController(
  input: ProjectExplorerControllerInput
): ProjectExplorerController {
  const [state, dispatch] = useReducer(projectExplorerReducer, undefined, () => (
    initialProjectExplorerState(input.snapshot, input.projectRevision)
  ));
  const stateRef = useRef(state);
  stateRef.current = state;
  const snapshotRef = useRef(input.snapshot);
  snapshotRef.current = input.snapshot;
  const editRevisionRef = useRef(0);
  const directoryLoadsRef = useRef(new Map<string, Promise<void>>());

  useEffect(() => {
    if (!input.snapshot) {
      return;
    }
    dispatch({
      type: 'accept-snapshot',
      snapshot: input.snapshot,
      revision: input.projectRevision
    });
  }, [input.projectRevision, input.snapshot]);

  useEffect(() => {
    input.onInspectionSelectionChange(state.selection);
  }, [input.onInspectionSelectionChange, state.selection]);

  useEffect(() => () => {
    editRevisionRef.current += 1;
    directoryLoadsRef.current.clear();
  }, []);

  const reportFailure = useCallback((operation: ExplorerActivityOperation) => {
    input.activities.report({ kind: 'explorer-operation-failed', operation });
  }, [input.activities]);

  const reportCurrentFailure = useCallback((
    scope: ProjectCommandScope,
    operation: ExplorerActivityOperation
  ): boolean => {
    if (!scope.isCurrent()) {
      return false;
    }
    reportFailure(operation);
    return true;
  }, [reportFailure]);

  const waitForResultSnapshot = useCallback(async (
    scope: ProjectCommandScope,
    result: { bindingId: string; projectRevision: number }
  ): Promise<WorkbenchProjectSessionSnapshot | undefined> => {
    if (!scope.isCurrent(result.bindingId)) {
      return undefined;
    }
    return scope.waitForRevision(result.projectRevision);
  }, []);

  const ensureDirectoryLoaded = useCallback((projectRelativePath: string): Promise<void> => {
    const currentEntry = snapshotRef.current?.projectTree.find((entry) => (
      entry.projectRelativePath === projectRelativePath && entry.kind === 'directory'
    ));
    if (!projectRelativePath || currentEntry?.directoryState === 'loaded') {
      return Promise.resolve();
    }
    const existing = directoryLoadsRef.current.get(projectRelativePath);
    if (existing) {
      return existing;
    }
    const scope = input.commandGate.accept();
    const request = scope?.submit(() => input.api.loadProjectDirectory(projectRelativePath));
    if (!scope || !request) {
      return Promise.resolve();
    }
    const pending = request.then(async (result) => {
      const snapshot = await waitForResultSnapshot(scope, result);
      if (snapshot) {
        dispatch({ type: 'accept-snapshot', snapshot, revision: result.projectRevision });
      }
    }).catch((error: unknown) => {
      if (scope.isCurrent()) {
        throw error;
      }
    }).finally(() => {
      if (directoryLoadsRef.current.get(projectRelativePath) === pending) {
        directoryLoadsRef.current.delete(projectRelativePath);
      }
    });
    directoryLoadsRef.current.set(projectRelativePath, pending);
    return pending;
  }, [input.api, input.commandGate, waitForResultSnapshot]);

  const setSelection = useCallback((selection: ProjectExplorerSelection) => {
    dispatch({ type: 'set-selection', selection });
  }, []);

  const toggleDirectory = useCallback((projectRelativePath: string) => {
    const willExpand = !stateRef.current.expanded.has(projectRelativePath);
    dispatch({ type: 'toggle-directory', projectRelativePath });
    if (willExpand) {
      void ensureDirectoryLoaded(projectRelativePath).catch(() => {
        reportFailure('load-directory');
      });
    }
  }, [ensureDirectoryLoaded, reportFailure]);

  const beginCreate = useCallback((
    entryKind: 'file' | 'directory',
    parentProjectRelativePath: string
  ) => {
    const revision = ++editRevisionRef.current;
    dispatch({
      type: 'begin-edit',
      edit: {
        target: { kind: 'create', entryKind, parentProjectRelativePath },
        value: '',
        revision,
        phase: 'editing'
      }
    });
    if (parentProjectRelativePath) {
      void ensureDirectoryLoaded(parentProjectRelativePath).catch(() => undefined);
    }
  }, [ensureDirectoryLoaded]);

  const beginRename = useCallback((entry: ProjectPathRef) => {
    const revision = ++editRevisionRef.current;
    dispatch({
      type: 'begin-edit',
      edit: {
        target: { kind: 'rename', entry },
        value: projectPathBasename(entry.projectRelativePath),
        revision,
        phase: 'editing'
      }
    });
  }, []);

  const setClipboard = useCallback((
    operation: 'copy' | 'cut',
    entries: readonly ProjectPathRef[]
  ) => {
    const resolved = resolveProjectPathRefs(entries);
    dispatch({
      type: 'set-clipboard',
      clipboard: resolved.length > 0 ? { operation, entries: resolved } : undefined
    });
  }, []);

  const settleBatch = useCallback(async (inputBatch: {
    scope: ProjectCommandScope;
    request: Promise<WorkbenchProjectFileBatchOperationResult>;
    operation: 'copy' | 'move';
    intent: Pick<ProjectExplorerViewState, 'selection' | 'expanded' | 'clipboard'>;
  }): Promise<void> => {
    const result = await inputBatch.request;
    const snapshot = await waitForResultSnapshot(inputBatch.scope, result);
    if (!snapshot) {
      return;
    }
    dispatch({
      type: 'settle-transfer',
      snapshot,
      projectRevision: result.projectRevision,
      results: result.results,
      operation: inputBatch.operation,
      intent: inputBatch.intent
    });
  }, [waitForResultSnapshot]);

  const moveEntries = useCallback(async (
    entries: readonly ProjectPathRef[],
    targetDirectoryProjectRelativePath: string,
    intent: Pick<ProjectExplorerViewState, 'selection' | 'expanded' | 'clipboard'>
  ): Promise<void> => {
    const scope = input.commandGate.accept();
    const firstRequest = scope?.submit(() => input.api.moveProjectPaths({
      entries: [...entries],
      targetDirectoryProjectRelativePath
    }));
    if (!scope || !firstRequest) {
      return;
    }
    try {
      const first = await firstRequest;
      if (!scope.isCurrent(first.bindingId)) {
        return;
      }
      let applied: WorkbenchProjectFileBatchAttemptResult = first;
      if (first.outcome === 'conflict') {
        if (!input.confirmOverwrite({ entries, targetDirectoryProjectRelativePath })) {
          return;
        }
        const retry = scope.submit(() => input.api.moveProjectPaths({
          entries: [...entries],
          targetDirectoryProjectRelativePath,
          overwrite: true
        }));
        if (!retry) {
          return;
        }
        applied = await retry;
      }
      if (applied.outcome !== 'applied') {
        return;
      }
      const snapshot = await waitForResultSnapshot(scope, applied);
      if (!snapshot) {
        return;
      }
      dispatch({
        type: 'settle-transfer',
        snapshot,
        projectRevision: applied.projectRevision,
        results: applied.results,
        operation: 'move',
        intent
      });
    } catch {
      reportCurrentFailure(scope, 'move');
    }
  }, [
    input.api,
    input.commandGate,
    input.confirmOverwrite,
    reportCurrentFailure,
    waitForResultSnapshot
  ]);

  const transfer = useCallback((
    operation: 'copy' | 'move',
    entries: readonly ProjectPathRef[],
    targetDirectoryProjectRelativePath: string
  ) => {
    const resolved = resolveProjectPathRefs(entries);
    if (resolved.length === 0) {
      return;
    }
    const current = stateRef.current;
    const intent = {
      selection: current.selection,
      expanded: current.expanded,
      clipboard: current.clipboard
    };
    if (operation === 'move') {
      void moveEntries(resolved, targetDirectoryProjectRelativePath, intent);
      return;
    }
    const scope = input.commandGate.accept();
    const request = scope?.submit(() => input.api.copyProjectPaths({
      entries: resolved,
      targetDirectoryProjectRelativePath
    }));
    if (!scope || !request) {
      return;
    }
    void settleBatch({ scope, request, operation: 'copy', intent }).catch(() => {
      reportCurrentFailure(scope, 'copy');
    });
  }, [input.api, input.commandGate, moveEntries, reportCurrentFailure, settleBatch]);

  const paste = useCallback((targetDirectoryProjectRelativePath: string) => {
    const clipboard = stateRef.current.clipboard;
    if (!clipboard) {
      return;
    }
    transfer(
      clipboard.operation === 'cut' ? 'move' : 'copy',
      clipboard.entries,
      targetDirectoryProjectRelativePath
    );
  }, [transfer]);

  const deleteEntries = useCallback((
    mode: 'trash' | 'permanent',
    entries: readonly ProjectPathRef[]
  ) => {
    const resolved = resolveProjectPathRefs(entries);
    if (resolved.length === 0) {
      return;
    }
    const scope = input.commandGate.accept();
    const request = scope?.submit(() => mode === 'trash'
      ? input.api.trashProjectPaths({ entries: resolved })
      : input.api.deleteProjectPathsPermanently({ entries: resolved }));
    if (!scope || !request) {
      return;
    }
    void request.then(async (result) => {
      const snapshot = await waitForResultSnapshot(scope, result);
      if (!snapshot) {
        return;
      }
      dispatch({ type: 'accept-snapshot', snapshot, revision: result.projectRevision });
      if (result.results.some((item) => item.status === 'failed')) {
        reportFailure('delete');
      }
    }).catch(() => {
      reportCurrentFailure(scope, 'delete');
    });
  }, [input.api, input.commandGate, reportCurrentFailure, reportFailure, waitForResultSnapshot]);

  const reveal = useCallback((entry: ProjectPathRef) => {
    const scope = input.commandGate.accept();
    const request = scope?.submit(() => input.api.revealProjectPathInSystemFileManager(entry));
    void request?.catch(() => {
      if (scope) {
        reportCurrentFailure(scope, 'reveal');
      }
    });
  }, [input.api, input.commandGate, reportCurrentFailure]);

  const importExternal = useCallback(async (
    source: ProjectExternalDropSource,
    targetDirectoryProjectRelativePath: string
  ): Promise<void> => {
    const scope = input.commandGate.accept();
    if (!scope) {
      return;
    }
    try {
      const submit = (overwrite: boolean) => source.kind === 'local-paths'
        ? scope.submit(() => input.api.importExternalLocalProjectPaths({
            sources: source.sourcePaths,
            targetDirectoryProjectRelativePath,
            ...(overwrite ? { overwrite: true } : {})
          }))
        : scope.submit(() => input.api.importExternalProjectUploads({
            entries: source.entries.map((entry) => entry.kind === 'file'
              ? { kind: 'file' as const, relativePath: entry.relativePath, file: entry.file }
              : { kind: 'directory' as const, relativePath: entry.relativePath }),
            targetDirectoryProjectRelativePath,
            ...(overwrite ? { overwrite: true } : {})
          }));
      const firstRequest = submit(false);
      if (!firstRequest) {
        return;
      }
      let result = await firstRequest;
      if (!scope.isCurrent(result.bindingId)) {
        return;
      }
      if (result.outcome === 'conflict') {
        const entries: ProjectPathRef[] = source.kind === 'local-paths'
          ? source.sourcePaths.map((path) => ({ projectRelativePath: path, kind: 'file' }))
          : source.entries.map((entry) => ({
              projectRelativePath: entry.relativePath,
              kind: entry.kind
            }));
        if (!input.confirmOverwrite({ entries, targetDirectoryProjectRelativePath })) {
          return;
        }
        const retry = submit(true);
        if (!retry) {
          return;
        }
        result = await retry;
      }
      if (result.outcome !== 'applied') {
        return;
      }
      const snapshot = await waitForResultSnapshot(scope, result);
      if (!snapshot) {
        return;
      }
      const current = stateRef.current;
      dispatch({
        type: 'settle-transfer',
        snapshot,
        projectRevision: result.projectRevision,
        results: result.results,
        operation: 'copy',
        intent: {
          selection: current.selection,
          expanded: current.expanded,
          clipboard: current.clipboard
        }
      });
    } catch {
      reportCurrentFailure(scope, 'import');
    }
  }, [
    input.api,
    input.commandGate,
    input.confirmOverwrite,
    reportCurrentFailure,
    waitForResultSnapshot
  ]);

  const externalDrop = useCallback((
    source: ProjectExternalDropSource,
    targetDirectoryProjectRelativePath: string
  ) => {
    void importExternal(source, targetDirectoryProjectRelativePath);
  }, [importExternal]);

  const updateEditValue = useCallback((value: string) => {
    dispatch({ type: 'update-edit', value });
  }, []);

  const submitEdit = useCallback(async (): Promise<void> => {
    const edit = stateRef.current.edit;
    if (!edit || edit.phase !== 'editing') {
      return;
    }
    const scope = input.commandGate.accept();
    if (!scope) {
      return;
    }
    const intent = {
      selection: stateRef.current.selection,
      expanded: stateRef.current.expanded,
      clipboard: stateRef.current.clipboard
    };
    dispatch({ type: 'submit-edit', revision: edit.revision });
    try {
      if (edit.target.kind === 'create' && edit.target.parentProjectRelativePath) {
        await ensureDirectoryLoaded(edit.target.parentProjectRelativePath);
        if (!scope.isCurrent() || editRevisionRef.current !== edit.revision) {
          if (editRevisionRef.current === edit.revision) {
            dispatch({ type: 'resume-edit', revision: edit.revision });
          }
          return;
        }
      }
      const request = scope.submit(() => edit.target.kind === 'rename'
        ? input.api.renameProjectPath({
            projectRelativePath: edit.target.entry.projectRelativePath,
            name: edit.value
          })
        : edit.target.entryKind === 'file'
          ? input.api.createProjectFile({
              parentProjectRelativePath: edit.target.parentProjectRelativePath,
              name: edit.value
            })
          : input.api.createProjectDirectory({
              parentProjectRelativePath: edit.target.parentProjectRelativePath,
              name: edit.value
            }));
      if (!request) {
        if (editRevisionRef.current === edit.revision) {
          dispatch({ type: 'resume-edit', revision: edit.revision });
        }
        return;
      }
      const result = await request;
      const snapshot = await waitForResultSnapshot(scope, result);
      if (!snapshot || editRevisionRef.current !== edit.revision) {
        if (!snapshot && editRevisionRef.current === edit.revision) {
          dispatch({ type: 'resume-edit', revision: edit.revision });
        }
        return;
      }
      if (edit.target.kind === 'rename') {
        dispatch({
          type: 'settle-transfer',
          snapshot,
          projectRevision: result.projectRevision,
          results: [{
            status: 'ok',
            sourceProjectRelativePath: edit.target.entry.projectRelativePath,
            projectRelativePath: result.projectRelativePath,
            kind: result.kind
          }],
          operation: 'move',
          intent,
          editRevision: edit.revision
        });
      } else {
        dispatch({
          type: 'settle-create',
          editRevision: edit.revision,
          snapshot,
          projectRevision: result.projectRevision,
          projectRelativePath: result.projectRelativePath
        });
      }
    } catch (error) {
      if (scope.isCurrent() && editRevisionRef.current === edit.revision) {
        dispatch({ type: 'fail-edit', revision: edit.revision, error: errorMessage(error) });
      } else if (editRevisionRef.current === edit.revision) {
        dispatch({ type: 'resume-edit', revision: edit.revision });
      }
    }
  }, [ensureDirectoryLoaded, input.api, input.commandGate, waitForResultSnapshot]);

  const cancelEdit = useCallback(() => {
    const edit = stateRef.current.edit;
    if (!edit || edit.phase === 'submitting') {
      return;
    }
    editRevisionRef.current += 1;
    dispatch({ type: 'cancel-edit' });
  }, []);

  const handleEditCommand = useCallback((command: ProjectExplorerEditCommand) => {
    const current = stateRef.current;
    if (command === 'escape') {
      if (current.edit?.phase === 'editing') {
        cancelEdit();
      } else if (current.clipboard?.operation === 'cut') {
        dispatch({ type: 'set-clipboard', clipboard: undefined });
      } else {
        dispatch({ type: 'set-selection', selection: projectExplorerSelectionFromPaths([]) });
      }
      return;
    }
    const snapshot = snapshotRef.current;
    if (command === 'select-all') {
      dispatch({
        type: 'set-selection',
        selection: projectExplorerSelectionFromPaths((snapshot?.projectTree ?? [])
          .map((entry) => entry.projectRelativePath)
          .filter(Boolean))
      });
      return;
    }
    if (command === 'paste') {
      const focusedEntry = snapshot?.projectTree.find((entry) => (
        entry.projectRelativePath === current.selection.focusedPath
      ));
      paste(focusedEntry?.kind === 'directory'
        ? focusedEntry.projectRelativePath
        : projectPathParent(current.selection.focusedPath ?? ''));
      return;
    }
    const entries = projectPathRefsForSelection(snapshot, current.selection);
    if (command === 'copy' || command === 'cut') {
      setClipboard(command, entries);
      return;
    }
    const mode = command === 'trash' ? 'trash' : 'permanent';
    if (entries.length > 0 && input.confirmDelete({ mode, entries })) {
      deleteEntries(mode, entries);
    }
  }, [cancelEdit, deleteEntries, input.confirmDelete, paste, setClipboard]);

  return useMemo(() => ({
    state,
    selection: state.selection,
    fileClipboard: state.clipboard,
    inlineEdit: state.edit,
    setSelection,
    toggleDirectory,
    beginCreate,
    beginRename,
    setClipboard,
    paste,
    transfer,
    deleteEntries,
    reveal,
    externalDrop,
    updateEditValue,
    submitEdit,
    cancelEdit,
    handleEditCommand,
    ensureDirectoryLoaded
  }), [
    beginCreate,
    beginRename,
    cancelEdit,
    deleteEntries,
    ensureDirectoryLoaded,
    externalDrop,
    handleEditCommand,
    paste,
    reveal,
    setClipboard,
    setSelection,
    state,
    submitEdit,
    toggleDirectory,
    transfer,
    updateEditValue
  ]);
}

export function projectExplorerReducer(
  state: ProjectExplorerViewState,
  action: ProjectExplorerAction
): ProjectExplorerViewState {
  switch (action.type) {
    case 'accept-snapshot':
      return acceptSnapshot(state, action.snapshot, action.revision);
    case 'set-selection':
      return { ...state, selection: action.selection };
    case 'toggle-directory': {
      const expanded = new Set(state.expanded);
      if (expanded.has(action.projectRelativePath)) {
        expanded.delete(action.projectRelativePath);
      } else {
        expanded.add(action.projectRelativePath);
      }
      return { ...state, expanded };
    }
    case 'set-clipboard':
      return { ...state, clipboard: action.clipboard };
    case 'begin-edit': {
      const expanded = new Set(state.expanded);
      if (action.edit.target.kind === 'create' && action.edit.target.parentProjectRelativePath) {
        expanded.add(action.edit.target.parentProjectRelativePath);
      }
      return { ...state, expanded, edit: action.edit };
    }
    case 'update-edit':
      return state.edit?.phase === 'editing'
        ? { ...state, edit: editWithValue(state.edit, action.value) }
        : state;
    case 'submit-edit':
      return state.edit?.revision === action.revision && state.edit.phase === 'editing'
        ? { ...state, edit: { ...withoutError(state.edit), phase: 'submitting' } }
        : state;
    case 'resume-edit':
      return state.edit?.revision === action.revision && state.edit.phase === 'submitting'
        ? { ...state, edit: { ...state.edit, phase: 'editing' } }
        : state;
    case 'fail-edit':
      return state.edit?.revision === action.revision
        ? { ...state, edit: { ...state.edit, phase: 'editing', error: action.error } }
        : state;
    case 'cancel-edit':
      return state.edit !== undefined
        && (action.revision === undefined || state.edit.revision === action.revision)
        ? { ...state, edit: undefined }
        : state;
    case 'settle-create': {
      if (state.edit?.revision !== action.editRevision) {
        return state;
      }
      return reconcileViewState({
        ...state,
        acceptedProjectRevision: Math.max(state.acceptedProjectRevision, action.projectRevision),
        edit: undefined,
        selection: projectExplorerSelectionFromPaths([action.projectRelativePath])
      }, action.snapshot);
    }
    case 'settle-transfer': {
      if (action.operation === 'copy') {
        return reconcileViewState({
          ...state,
          acceptedProjectRevision: Math.max(state.acceptedProjectRevision, action.projectRevision),
          selection: projectExplorerSelectionFromPaths(action.results
            .filter((result) => result.status !== 'failed')
            .map((result) => result.projectRelativePath))
        }, action.snapshot);
      }
      const rewrites = action.results.filter((result) => (
        result.status === 'ok'
        && result.sourceProjectRelativePath !== result.projectRelativePath
      ));
      const intent = rewriteIntent(action.intent, rewrites);
      const reconciledIntent = reconcileViewState({
        ...state,
        acceptedProjectRevision: Math.max(state.acceptedProjectRevision, action.projectRevision),
        selection: intent.selection,
        expanded: intent.expanded,
        clipboard: intent.clipboard,
        ...(action.editRevision !== undefined && state.edit?.revision === action.editRevision
          ? { edit: undefined }
          : {})
      }, action.snapshot);
      return reconciledIntent;
    }
  }
}

function initialProjectExplorerState(
  snapshot: WorkbenchProjectSessionSnapshot | undefined,
  projectRevision: number
): ProjectExplorerViewState {
  const state: ProjectExplorerViewState = {
    acceptedProjectRevision: projectRevision,
    selection: projectExplorerSelectionFromPaths([]),
    expanded: new Set(),
    clipboard: undefined,
    edit: undefined
  };
  return snapshot ? reconcileViewState(state, snapshot) : state;
}

function acceptSnapshot(
  state: ProjectExplorerViewState,
  snapshot: WorkbenchProjectSessionSnapshot,
  revision: number
): ProjectExplorerViewState {
  if (revision <= state.acceptedProjectRevision) {
    return state;
  }
  return reconcileViewState({ ...state, acceptedProjectRevision: revision }, snapshot);
}

function reconcileViewState(
  state: ProjectExplorerViewState,
  snapshot: WorkbenchProjectSessionSnapshot
): ProjectExplorerViewState {
  const kindByPath = new Map(snapshot.projectTree.map((entry) => [
    entry.projectRelativePath,
    entry.kind
  ]));
  const nextSelectedPaths = state.selection.selectedPaths.filter((path) => kindByPath.has(path));
  let focusedPath = state.selection.focusedPath && kindByPath.has(state.selection.focusedPath)
    ? state.selection.focusedPath
    : nearestExistingParent(state.selection.focusedPath, kindByPath);
  if (focusedPath && !nextSelectedPaths.includes(focusedPath)) {
    nextSelectedPaths.push(focusedPath);
  }
  focusedPath ??= nextSelectedPaths.at(-1) ?? null;
  const anchorPath = state.selection.anchorPath && nextSelectedPaths.includes(state.selection.anchorPath)
    ? state.selection.anchorPath
    : focusedPath;
  const selection = sameStrings(state.selection.selectedPaths, nextSelectedPaths)
    && state.selection.focusedPath === focusedPath
    && state.selection.anchorPath === anchorPath
    ? state.selection
    : { selectedPaths: nextSelectedPaths, focusedPath, anchorPath };
  const nextExpandedPaths = [...state.expanded].filter((path) => kindByPath.get(path) === 'directory');
  const expanded = nextExpandedPaths.length === state.expanded.size
    ? state.expanded
    : new Set(nextExpandedPaths);
  const nextClipboardEntries = state.clipboard?.entries.filter((entry) => (
    kindByPath.get(entry.projectRelativePath) === entry.kind
  ));
  const clipboard = state.clipboard && nextClipboardEntries && nextClipboardEntries.length > 0
    ? samePathRefs(state.clipboard.entries, nextClipboardEntries)
      ? state.clipboard
      : { ...state.clipboard, entries: nextClipboardEntries }
    : undefined;
  const edit = reconcileEdit(state.edit, kindByPath);
  if (
    selection === state.selection
    && expanded === state.expanded
    && clipboard === state.clipboard
    && edit === state.edit
  ) {
    return state;
  }
  return {
    ...state,
    selection,
    expanded,
    clipboard,
    edit
  };
}

function reconcileEdit(
  edit: InlineProjectEdit | undefined,
  kindByPath: ReadonlyMap<string, 'file' | 'directory'>
): InlineProjectEdit | undefined {
  if (!edit) {
    return undefined;
  }
  if (edit.target.kind === 'rename') {
    return kindByPath.get(edit.target.entry.projectRelativePath) === edit.target.entry.kind
      ? edit
      : undefined;
  }
  return !edit.target.parentProjectRelativePath
    || kindByPath.get(edit.target.parentProjectRelativePath) === 'directory'
    ? edit
    : undefined;
}

function rewriteIntent(
  intent: Pick<ProjectExplorerViewState, 'selection' | 'expanded' | 'clipboard'>,
  rewrites: readonly ProjectPathBatchItemResult[]
): Pick<ProjectExplorerViewState, 'selection' | 'expanded' | 'clipboard'> {
  const orderedRewrites = [...rewrites]
    .sort((left, right) => right.sourceProjectRelativePath.length - left.sourceProjectRelativePath.length);
  const rewrite = (path: string): string => rewriteProjectPath(path, orderedRewrites);
  return {
    selection: {
      selectedPaths: intent.selection.selectedPaths.map(rewrite),
      focusedPath: intent.selection.focusedPath ? rewrite(intent.selection.focusedPath) : null,
      anchorPath: intent.selection.anchorPath ? rewrite(intent.selection.anchorPath) : null
    },
    expanded: new Set([...intent.expanded].map(rewrite)),
    clipboard: intent.clipboard ? {
      ...intent.clipboard,
      entries: intent.clipboard.entries.map((entry) => ({
        ...entry,
        projectRelativePath: rewrite(entry.projectRelativePath)
      }))
    } : undefined
  };
}

function rewriteProjectPath(
  path: string,
  rewrites: readonly ProjectPathBatchItemResult[]
): string {
  const rewrite = rewrites.find((candidate) => path === candidate.sourceProjectRelativePath
    || path.startsWith(`${candidate.sourceProjectRelativePath}/`));
  if (!rewrite) {
    return path;
  }
  return rewrite.projectRelativePath + path.slice(rewrite.sourceProjectRelativePath.length);
}

function nearestExistingParent(
  path: string | null,
  kindByPath: ReadonlyMap<string, 'file' | 'directory'>
): string | null {
  let current = path ?? '';
  while (current.includes('/')) {
    current = current.slice(0, current.lastIndexOf('/'));
    if (kindByPath.has(current)) {
      return current;
    }
  }
  return null;
}

export function projectExplorerSelectionFromPaths(paths: readonly string[]): ProjectExplorerSelection {
  const selectedPaths = [...paths];
  const focusedPath = selectedPaths.at(-1) ?? null;
  return { selectedPaths, focusedPath, anchorPath: focusedPath };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function samePathRefs(left: readonly ProjectPathRef[], right: readonly ProjectPathRef[]): boolean {
  return left.length === right.length && left.every((entry, index) => (
    entry.projectRelativePath === right[index]?.projectRelativePath
    && entry.kind === right[index]?.kind
  ));
}

function projectPathRefsForSelection(
  snapshot: WorkbenchProjectSessionSnapshot | undefined,
  selection: ProjectExplorerSelection
): ProjectPathRef[] {
  const kindByPath = new Map(snapshot?.projectTree.map((entry) => [
    entry.projectRelativePath,
    entry.kind
  ]) ?? []);
  const entries = selection.selectedPaths.flatMap((projectRelativePath) => {
    const kind = kindByPath.get(projectRelativePath);
    return kind ? [{ projectRelativePath, kind }] : [];
  });
  if (entries.length === 0) {
    return [];
  }
  return resolveProjectPathRefs(entries);
}

function resolveProjectPathRefs(entries: readonly ProjectPathRef[]): ProjectPathRef[] {
  if (entries.length === 0) {
    return [];
  }
  return [...resolveProjectPathCommandTarget({
    source: 'explorer',
    invocation: entries[0]!,
    selection: entries
  })];
}

function withoutError(edit: Extract<InlineProjectEdit, { phase: 'editing' }>): Omit<typeof edit, 'error' | 'phase'> {
  const { error: _error, phase: _phase, ...rest } = edit;
  return rest;
}

function editWithValue(
  edit: Extract<InlineProjectEdit, { phase: 'editing' }>,
  value: string
): InlineProjectEdit {
  const { error: _error, ...rest } = edit;
  return { ...rest, value };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
