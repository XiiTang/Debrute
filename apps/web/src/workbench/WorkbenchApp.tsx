import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type {
  DebruteProductPlatform,
  DebruteWorkbenchRoute,
  ProjectPathEntry,
  WorkbenchCanvasDocumentMutationResult,
  WorkbenchProjectOpenResult,
  WorkbenchProjectSessionSnapshot
} from '@debrute/app-protocol';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import { createHttpWorkbenchApiClient } from '../api/httpWorkbenchApiClient';
import { getDebruteShellApi, type NativeWindowState } from '../api/shellApi';
import { CanvasEditor } from './canvas/CanvasEditor';
import { CanvasCardBar } from './canvas/CanvasCardBar';
import { CanvasFeedbackBar } from './canvas/CanvasFeedbackBar';
import { CanvasMinimapBar } from './canvas/CanvasMinimapBar';
import { CanvasResetLayoutButton } from './canvas/CanvasResetLayoutButton';
import { createCanvasOverlayRuntime } from './canvas/CanvasOverlayRuntime';
import { useCanvasFeedbackController } from './canvas/useCanvasFeedbackController';
import type { CanvasEditorRuntime, CanvasRuntimeSnapshot } from './canvas/runtime/CanvasEditorRuntime';
import {
  isSnapshotAffectingWorkbenchEvent,
  nextSnapshotFromWorkbenchEvent
} from './services/workbenchEvents';
import { getCanvasById } from './services/canvasState';
import { createCanvasSelectionStackOrderSync } from './services/canvasStackOrderSelection';
import { chooseInitialActiveCanvasId } from './canvas/canvasCardBarState';
import {
  currentDebruteWorkbenchRoute,
  openInitialProject,
  projectOpenHereProjectId,
  replaceWorkbenchProjectRoute,
  shouldShowInitialProjectLoader,
  type ProjectOpenStartupError
} from './services/projectSessionState';
import { restoreProjectViewState, saveProjectViewState } from './services/projectViewState';
import { reconcileWorkbenchViewportLayout } from './services/workbenchViewportLayout';
import {
  closeTextEditorWindowState,
  dragTextEditorWindowState,
  openTextEditorWindowState,
  resizeTextEditorWindowState
} from './services/textEditorWindows';
import { useTextFileBufferActions } from './services/textFileBufferActions';
import { runWorkbenchContextMenuCommand } from './services/workbenchContextMenuCommands';
import { SendToPhotoshopDialog } from './adobe-bridge/SendToPhotoshopDialog';
import { WorkbenchContextMenu } from './shell/WorkbenchContextMenu';
import { WorkbenchTitleBar } from './shell/WorkbenchTitleBar';
import { executeTitleBarMenuCommand } from './shell/workbenchTitleBarCommands';
import {
  buildWorkbenchTitleBarState,
  type WorkbenchMenuItem
} from './shell/workbenchTitleBarState';
import {
  buildWorkbenchContextMenuItems,
  cameraCenteredOnNode,
  type WorkbenchContextMenuCommand,
  type WorkbenchContextMenuPosition,
  type WorkbenchContextMenuTarget
} from './shell/contextMenu';
import type { ProjectTreeFileKeyboardCommand } from './project-explorer/projectTreeKeyboardCommands';
import {
  createCanvasTextViewportStateController,
  type CanvasTextViewportStateController
} from './services/canvasSnapshotUpdates';
import {
  permanentDeleteConfirmationMessageForEntries,
  projectTreeSelectionFromPaths
} from './project-explorer/workbenchFileCommands';
import { useProjectExplorerController } from './project-explorer/useProjectExplorerController';
import {
  canvasCardBarRect,
  feedbackBarPlacementForCanvasTarget,
  canvasMinimapButtonRect,
  canvasResetLayoutButtonRect,
  placeCanvasMinimapPanel
} from './shell/floatingBars';
import {
  DEFAULT_FLOATING_PANEL_STATE,
  FLOATING_PANEL_IDS,
  closeFloatingPanel,
  constrainOpenFloatingPanelsToViewport,
  dragFloatingPanel,
  openFloatingPanel,
  resizeFloatingPanel,
  toggleFloatingPanel,
  type FloatingPanelId,
  type FloatingPanelState
} from './shell/floatingPanels';
import { FloatingDock } from './shell/FloatingDock';
import { FloatingPanelContent, WorkbenchFloatingPanelShell } from './shell/FloatingPanel';
import { FloatingTextEditorWindow } from './canvas/FloatingTextEditorWindow';
import { NotificationStack } from './shell/NotificationStack';
import { TerminalPanel } from './terminal/TerminalPanel';
import { Button, WorkbenchIconProvider } from './ui';
import { FIXED_TOP_FLOATING_BAR_RECTS, TITLE_BAR_RESERVED_RECT } from './shell/workbenchLayers';
import {
  DEFAULT_WORKBENCH_WINDOW_ORDER,
  closeWorkbenchWindow,
  focusWorkbenchWindow,
  panelWindowIdentity,
  syncOpenWorkbenchWindows,
  textEditorWindowIdentity,
  type WorkbenchWindowIdentity,
  type WorkbenchWindowOrderState
} from './shell/workbenchWindowOrder';
import { readWorkbenchViewportRect } from './shell/windowBounds';
import type { FloatingTextEditorWindowState, TextFileBuffer, WorkbenchActions, WorkbenchState } from '../types';
import { I18nProvider, createI18n, type WorkbenchI18n } from './i18n';
import { useWorkbenchSettingsController } from './settings/useWorkbenchSettingsController';

const api = createHttpWorkbenchApiClient();
const productPlatform: DebruteProductPlatform = __DEBRUTE_PLATFORM__;

if (import.meta.hot) {
  import.meta.hot.dispose(() => api.dispose());
}

export function WorkbenchApp(): React.ReactElement {
  const initialRoute = useMemo(() => currentDebruteWorkbenchRoute(), []);
  if (initialRoute.kind === 'not-found') {
    return (
      <main className="boot-screen" role="alert" data-testid="workbench-not-found">
        <strong>404 — Workbench page not found</strong>
        <span>This URL is not a Debrute Workbench page.</span>
      </main>
    );
  }
  return <WorkbenchRuntimeApp initialRoute={initialRoute} />;
}

function WorkbenchRuntimeApp({ initialRoute }: { initialRoute: Exclude<DebruteWorkbenchRoute, { kind: 'not-found' }> }): React.ReactElement {
  const [snapshot, setSnapshot] = useState<WorkbenchProjectSessionSnapshot>();
  const [runtimeProjectId, setRuntimeProjectId] = useState<string>();
  const [activeCanvasId, setActiveCanvasId] = useState<string>();
  const [activeCanvasRuntime, setActiveCanvasRuntime] = useState<CanvasEditorRuntime>();
  const [activeCanvasRuntimeSnapshot, setActiveCanvasRuntimeSnapshot] = useState<CanvasRuntimeSnapshot>();
  const [activeCanvasCurrentNodes, setActiveCanvasCurrentNodes] = useState<{
    canvasId: string;
    nodes: ProjectedCanvasNode[];
  }>();
  const [canvasRuntimeScopeKey, setCanvasRuntimeScopeKey] = useState(0);
  const [floatingPanels, setFloatingPanels] = useState<FloatingPanelState>(DEFAULT_FLOATING_PANEL_STATE);
  const [requestedTerminalCwd, setRequestedTerminalCwd] = useState<string | null>(null);
  const [textFileBuffers, setTextFileBuffers] = useState<Record<string, TextFileBuffer>>({});
  const [textEditorWindows, setTextEditorWindows] = useState<Record<string, FloatingTextEditorWindowState>>({});
  const [windowOrder, setWindowOrder] = useState<WorkbenchWindowOrderState>(DEFAULT_WORKBENCH_WINDOW_ORDER);
  const [canvasMinimapOpen, setCanvasMinimapOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    target: WorkbenchContextMenuTarget;
    position: WorkbenchContextMenuPosition;
  }>();
  const [sendToPhotoshopPath, setSendToPhotoshopPath] = useState<string>();
  const [sendingToPhotoshop, setSendingToPhotoshop] = useState(false);
  const [nativeWindowState, setNativeWindowState] = useState<NativeWindowState>();
  const [projectDetached, setProjectDetached] = useState(false);
  const [connectionEnded, setConnectionEnded] = useState<Error>();
  const [notifications, setNotifications] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(() => shouldShowInitialProjectLoader(initialRoute));
  const [projectOpenAttemptedPath, setProjectOpenAttemptedPath] = useState<string>();
  const [projectOpenError, setProjectOpenError] = useState<string>();
  const [projectOpenHereTargetId, setProjectOpenHereTargetId] = useState<string>();
  const [isProjectOpening, setIsProjectOpening] = useState(false);
  const [workbenchViewportRect, setWorkbenchViewportRect] = useState(readWorkbenchViewportRect);
  const canvasOverlayRuntime = useMemo(() => createCanvasOverlayRuntime(), []);
  const workbenchViewportRectRef = useRef(workbenchViewportRect);
  const snapshotRef = useRef(snapshot);
  const authoritativeSnapshotRef = useRef(snapshot);
  const authoritativeProjectRevisionRef = useRef<number | undefined>(undefined);
  const canvasTextViewportStateControllerRef = useRef<CanvasTextViewportStateController | undefined>(undefined);
  const textFileBuffersRef = useRef(textFileBuffers);
  const textEditorWindowsRef = useRef(textEditorWindows);
  const initialProjectOpeningRef = useRef<ReturnType<typeof openInitialProject> | undefined>(undefined);
  const initialProjectResultAppliedRef = useRef(false);
  const commitPresentedProjectSnapshot = useCallback((next: WorkbenchProjectSessionSnapshot | undefined) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);
  const commitProjectSnapshot = useCallback((
    next: WorkbenchProjectSessionSnapshot | undefined,
    projectRevision?: number
  ): boolean => {
    if (
      projectRevision !== undefined
      && authoritativeProjectRevisionRef.current !== undefined
      && projectRevision < authoritativeProjectRevisionRef.current
    ) {
      return false;
    }
    authoritativeProjectRevisionRef.current = next ? projectRevision : undefined;
    authoritativeSnapshotRef.current = next;
    commitPresentedProjectSnapshot(
      canvasTextViewportStateControllerRef.current?.reconcileSnapshot(next) ?? next
    );
    return true;
  }, [commitPresentedProjectSnapshot]);
  const notify = useCallback((message: string) => {
    setNotifications((current) => [message, ...current].slice(0, 4));
  }, []);
  const settingsController = useWorkbenchSettingsController({ api, projectId: runtimeProjectId, notify });
  const i18n = useMemo(() => createI18n(settingsController.locale), [settingsController.locale]);
  const activeCanvas = getCanvasById(snapshot, activeCanvasId);
  const activeProjection = activeCanvas
    ? snapshot?.projections.find((item) => item.canvasId === activeCanvas.id)
    : undefined;
  const centerCanvasProjectionNode = useCallback((
    projection: WorkbenchProjectSessionSnapshot['projections'][number] | undefined,
    projectRelativePath: string
  ) => {
    const node = projection?.nodes.find((item) => item.projectRelativePath === projectRelativePath);
    const runtimeSnapshot = activeCanvasRuntime?.getSnapshot();
    if (!node || !activeCanvasRuntime || !runtimeSnapshot?.surfaceSize) {
      return;
    }
    activeCanvasRuntime.setSelection({ kind: 'node', projectRelativePath });
    activeCanvasRuntime.camera.setCamera(cameraCenteredOnNode({
      node,
      surfaceSize: runtimeSnapshot.surfaceSize,
      camera: runtimeSnapshot.camera
    }));
  }, [activeCanvasRuntime]);
  const locateProjectFileInCanvas = useCallback((projectRelativePath: string) => {
    centerCanvasProjectionNode(activeProjection, projectRelativePath);
  }, [activeProjection, centerCanvasProjectionNode]);
  const explorerController = useProjectExplorerController({
    api,
    projectId: runtimeProjectId,
    snapshot,
    commitSnapshot: (result) => {
      commitProjectSnapshot(result.snapshot, result.projectRevision);
    },
    activeCanvasRuntime,
    locateProjectFileInCanvas,
    notify,
    i18n
  });
  const { fileClipboard, inlineEdit: inlineProjectTreeEdit } = explorerController;

  const notifyCanvasFeedbackUnavailable = useCallback((message: string) => {
    const currentI18n = settingsController.getCurrentI18n();
    setNotifications((current) => [currentI18n.t('canvas.feedback.unavailable', { message }), ...current].slice(0, 4));
  }, [settingsController.getCurrentI18n]);
  const feedbackController = useCanvasFeedbackController({
    api,
    projectId: runtimeProjectId,
    overlayRuntime: canvasOverlayRuntime,
    notifyUnavailable: notifyCanvasFeedbackUnavailable
  });

  const commitProjectSession = useCallback((opened: {
    projectId: string;
    projectRevision: number;
    snapshot: WorkbenchProjectSessionSnapshot;
  }) => {
    const restoredViewState = restoreProjectViewState({
      storage: window.sessionStorage,
      projectId: opened.projectId
    });
    if (restoredViewState.status === 'invalid') {
      notify(settingsController.getCurrentI18n().t('shell.notifications.projectViewStateReset', {
        name: opened.snapshot.metadata.project.name
      }));
    }
    const viewState = restoredViewState.status === 'ready'
      ? restoredViewState.state
      : { floatingPanels: DEFAULT_FLOATING_PANEL_STATE };
    const canvasOrder = opened.snapshot.canvasRegistry.status === 'ready'
      ? opened.snapshot.canvasRegistry.canvasOrder
      : [];
    const nextActiveCanvasId = chooseInitialActiveCanvasId({
      storedActiveCanvasId: viewState.activeCanvasId,
      canvasOrder
    });
    const nextFloatingPanels = constrainOpenFloatingPanelsToViewport(
      viewState.floatingPanels,
      workbenchViewportRectRef.current
    );

    canvasTextViewportStateControllerRef.current?.reset();
    authoritativeProjectRevisionRef.current = undefined;
    commitProjectSnapshot(opened.snapshot, opened.projectRevision);
    setRuntimeProjectId(opened.projectId);
    setFloatingPanels(nextFloatingPanels);
    setActiveCanvasId(nextActiveCanvasId);
    setActiveCanvasRuntime(undefined);
    setCanvasRuntimeScopeKey((current) => current + 1);
    setContextMenu(undefined);
    setCanvasMinimapOpen(false);
    explorerController.resetForProject(opened.projectId);
    feedbackController.reset();
    void feedbackController.load();
  }, [
    commitProjectSnapshot,
    explorerController.resetForProject,
    feedbackController.load,
    feedbackController.reset,
    notify,
    settingsController.getCurrentI18n
  ]);

  const commitOpenedProject = useCallback((opened: WorkbenchProjectOpenResult) => {
    setProjectDetached(false);
    setProjectOpenHereTargetId(undefined);
    commitProjectSession(opened);
    replaceWorkbenchProjectRoute(opened.projectId);
    setTextFileBuffers(Object.fromEntries(
      Object.values(opened.workingCopies.text).map((workingCopy) => [
        workingCopy.projectRelativePath,
        {
          ...workingCopy,
          wordWrap: false,
          dirty: true,
          saving: false,
          externalChange: false
        }
      ])
    ));
    feedbackController.restoreWorkingCopy(opened.workingCopies.feedback);
    setTextEditorWindows({});
    setWindowOrder(DEFAULT_WORKBENCH_WINDOW_ORDER);
    setProjectOpenAttemptedPath(undefined);
    setProjectOpenError(undefined);
    const currentI18n = settingsController.getCurrentI18n();
    setNotifications((current) => [currentI18n.t('shell.notifications.projectOpened', { name: opened.snapshot.metadata.project.name }), ...current].slice(0, 4));
  }, [
    commitProjectSession,
    feedbackController.restoreWorkingCopy,
    settingsController.getCurrentI18n
  ]);

  const reopenDetachedProject = useCallback(async () => {
    if (!runtimeProjectId) {
      return;
    }
    try {
      const opened = await api.openProject({ projectId: runtimeProjectId, forceOpenHere: true });
      if (!('outcome' in opened)) {
        commitOpenedProject(opened);
      }
    } catch (error) {
      notify(errorMessage(error));
    }
  }, [commitOpenedProject, notify, runtimeProjectId]);

  const openProjectHere = useCallback(async () => {
    if (!projectOpenHereTargetId) {
      return;
    }
    setIsProjectOpening(true);
    try {
      const opened = await api.openProject({
        projectId: projectOpenHereTargetId,
        forceOpenHere: true
      });
      if (!('outcome' in opened)) {
        commitOpenedProject(opened);
      }
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      setIsProjectOpening(false);
    }
  }, [commitOpenedProject, notify, projectOpenHereTargetId]);

  useEffect(() => {
    workbenchViewportRectRef.current = workbenchViewportRect;
  }, [workbenchViewportRect]);

  useEffect(() => {
    textFileBuffersRef.current = textFileBuffers;
  }, [textFileBuffers]);

  useEffect(() => {
    textEditorWindowsRef.current = textEditorWindows;
  }, [textEditorWindows]);

  useEffect(() => {
    const handleProjectDetached = () => {
      setProjectDetached(true);
    };
    const removeApiDetachedHandler = api.onProjectDetached(handleProjectDetached);
    const removeConnectionEndedHandler = api.onConnectionEnded(setConnectionEnded);
    return () => {
      removeApiDetachedHandler();
      removeConnectionEndedHandler();
    };
  }, []);

  const reconcileCurrentWorkbenchViewportLayout = useCallback(() => {
    reconcileWorkbenchViewportLayout({
      viewportRef: workbenchViewportRectRef,
      setViewportRect: setWorkbenchViewportRect,
      setFloatingPanels,
      setTextEditorWindows
    }, readWorkbenchViewportRect());
  }, []);

  useEffect(() => {
    globalThis.window.addEventListener('resize', reconcileCurrentWorkbenchViewportLayout);
    return () => {
      globalThis.window.removeEventListener('resize', reconcileCurrentWorkbenchViewportLayout);
    };
  }, [reconcileCurrentWorkbenchViewportLayout]);

  useEffect(() => {
    if (!activeCanvasRuntime) {
      setActiveCanvasRuntimeSnapshot(undefined);
      return;
    }
    setActiveCanvasRuntimeSnapshot(activeCanvasRuntime.getSnapshot());
    return activeCanvasRuntime.subscribe((snapshot) => {
      setActiveCanvasRuntimeSnapshot((current) => (
        sameWorkbenchRuntimeSnapshot(current, snapshot) ? current : snapshot
      ));
    });
  }, [activeCanvasRuntime]);

  useEffect(() => () => {
    canvasOverlayRuntime.dispose();
  }, [canvasOverlayRuntime]);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        initialProjectOpeningRef.current ??= openInitialProject(api, initialRoute);
        const result = await initialProjectOpeningRef.current;
        if (disposed || initialProjectResultAppliedRef.current) {
          return;
        }
        initialProjectResultAppliedRef.current = true;
        setProjectOpenAttemptedPath(result.projectOpen?.attemptedPath);
        setProjectOpenError(localizedProjectOpenError(result.projectOpen?.error, settingsController.getCurrentI18n()));
        setProjectOpenHereTargetId(
          result.projectOpen?.error?.code === 'project-open-here-required'
            ? result.projectOpen.error.projectId
            : undefined
        );
        if (!result.project) {
          return;
        }
        commitOpenedProject(result.project);
      } catch (error) {
        if (!disposed) {
          const currentI18n = settingsController.getCurrentI18n();
          setNotifications((current) => [currentI18n.t('shell.notifications.projectStartupFailed', { message: errorMessage(error) }), ...current].slice(0, 4));
        }
      } finally {
        if (!disposed) {
          setIsLoading(false);
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, [
    commitOpenedProject,
    initialRoute,
    settingsController.getCurrentI18n
  ]);

  useEffect(() => {
    const shell = getDebruteShellApi();
    if (!shell) {
      return;
    }
    void shell.getNativeWindowState().then((state) => {
      setNativeWindowState(state);
      reconcileCurrentWorkbenchViewportLayout();
    }).catch((error) => {
      const currentI18n = settingsController.getCurrentI18n();
      notify(currentI18n.t('shell.notifications.windowStateFailed', { message: errorMessage(error) }));
    });
    return shell.onNativeWindowStateChanged((state) => {
      setNativeWindowState(state);
      reconcileCurrentWorkbenchViewportLayout();
    });
  }, [notify, reconcileCurrentWorkbenchViewportLayout, settingsController.getCurrentI18n]);

  useEffect(() => {
    if (!runtimeProjectId) {
      return;
    }
    saveProjectViewState({
      storage: window.sessionStorage,
      projectId: runtimeProjectId,
      state: {
        ...(activeCanvasId === undefined ? {} : { activeCanvasId }),
        floatingPanels
      }
    });
  }, [activeCanvasId, runtimeProjectId, floatingPanels]);

  const sendProjectFileToPhotoshop = useCallback<WorkbenchActions['sendProjectFileToPhotoshop']>(async (input) => {
    const result = await api.sendProjectFileToPhotoshop(input);
    notify(i18n.t('shell.notifications.sentToPhotoshop', { path: input.projectRelativePath }));
    return result;
  }, [i18n, notify]);
  const openSendToPhotoshopPicker = useCallback<WorkbenchActions['openSendToPhotoshopPicker']>((projectRelativePath) => {
    setSendToPhotoshopPath(projectRelativePath);
  }, []);

  const {
    ensureTextFileBuffer,
    updateTextFileBuffer,
    saveTextFileBuffer,
    discardTextFileBuffer,
    reloadTextFileBuffer,
    refreshTextFileBuffer
  } = useTextFileBufferActions({
    api,
    projectId: runtimeProjectId,
    textFileBuffers,
    setTextFileBuffers,
    textFileBuffersRef,
    textEditorWindowsRef
  });

  useEffect(() => {
    return api.onEvent((event) => {
      settingsController.applyEvent(event);
      feedbackController.applyEvent(event);

      if (isSnapshotAffectingWorkbenchEvent(event)) {
        commitProjectSnapshot(
          nextSnapshotFromWorkbenchEvent(event, authoritativeSnapshotRef.current),
          event.projectRevision
        );
        setRuntimeProjectId(event.projectId);
      }

      if (event.type === 'project.fileChanged') {
        void refreshTextFileBuffer(event.event.projectRelativePath);
        if (event.event.projectRelativePath === '.debrute/reviews/canvas-feedback.json') {
          void feedbackController.load();
        }
      }
    });
  }, [
    commitProjectSnapshot,
    feedbackController.applyEvent,
    feedbackController.load,
    refreshTextFileBuffer,
    settingsController.applyEvent
  ]);

  useEffect(() => {
    if (!snapshot || snapshot.canvasRegistry.status !== 'ready') {
      return;
    }
    if (!activeCanvasId || !snapshot.canvasRegistry.canvasOrder.includes(activeCanvasId)) {
      setActiveCanvasId(snapshot.canvasRegistry.canvasOrder[0]);
    }
  }, [activeCanvasId, snapshot]);

  const toggleTextFileWordWrap = useCallback((projectRelativePath: string) => {
    setTextFileBuffers((buffers) => {
      const current = buffers[projectRelativePath];
      if (!current) {
        return buffers;
      }
      return {
        ...buffers,
        [projectRelativePath]: {
          ...current,
          wordWrap: !current.wordWrap
        }
      };
    });
  }, []);

  const openTextEditorWindow = useCallback((projectRelativePath: string) => {
    setTextEditorWindows((windows) => openTextEditorWindowState(windows, projectRelativePath, workbenchViewportRectRef.current));
    setWindowOrder((current) => focusWorkbenchWindow(current, textEditorWindowIdentity(projectRelativePath)));
    void ensureTextFileBuffer(projectRelativePath);
  }, [ensureTextFileBuffer]);

  const canvasTextViewportStateController = useMemo(() => createCanvasTextViewportStateController({
    getAuthoritativeSnapshot: () => authoritativeSnapshotRef.current,
    commitAuthoritativeSnapshot: commitProjectSnapshot,
    commitPresentedSnapshot: commitPresentedProjectSnapshot,
    updateCanvasTextViewportState: (canvasId, input) => api.updateCanvasTextViewportState({
      canvasId,
      ...input
    })
  }), [commitPresentedProjectSnapshot, commitProjectSnapshot]);
  canvasTextViewportStateControllerRef.current = canvasTextViewportStateController;

  const updateCanvasTextViewportState = useCallback<WorkbenchActions['updateCanvasTextViewportState']>(async (canvasId, input) => {
    try {
      await canvasTextViewportStateController.update(canvasId, input);
    } catch (error) {
      notify(i18n.t('shell.notifications.updateCanvasTextViewportFailed', {
        message: errorMessage(error)
      }));
      throw error;
    }
  }, [canvasTextViewportStateController, i18n, notify]);

  const commitCanvasDocumentMutation = useCallback((result: WorkbenchCanvasDocumentMutationResult) => {
    const current = authoritativeSnapshotRef.current;
    if (!current) {
      throw new Error(`Cannot apply Canvas document ${result.canvas.id} without a current snapshot.`);
    }
    const next = replaceCanvasMutationInSnapshot(current, result);
    commitProjectSnapshot(next, result.projectRevision);
  }, [commitProjectSnapshot]);

  const updateCanvasNodeLayouts = useCallback<WorkbenchActions['updateCanvasNodeLayouts']>(async (canvasId, input) => {
    try {
      const result = await api.updateCanvasNodeLayouts({
        canvasId,
        ...input
      });
      commitCanvasDocumentMutation(result);
    } catch (error) {
      notify(i18n.t('shell.notifications.updateCanvasLayoutFailed', { message: errorMessage(error) }));
      throw error;
    }
  }, [commitCanvasDocumentMutation, i18n, notify]);

  const resetCanvasNodeLayouts = useCallback<WorkbenchActions['resetCanvasNodeLayouts']>(async (canvasId, input) => {
    const result = await api.resetCanvasNodeLayouts({
      canvasId,
      ...input
    });
    commitCanvasDocumentMutation(result);
    return result;
  }, [commitCanvasDocumentMutation]);

  const bringCanvasNodeToFront = useCallback<WorkbenchActions['bringCanvasNodeToFront']>(async (canvasId, input) => {
    const result = await api.bringCanvasNodeToFront({
      canvasId,
      ...input
    });
    commitCanvasDocumentMutation(result);
  }, [commitCanvasDocumentMutation]);

  const updateCanvasVideoPlaybackState = useCallback<WorkbenchActions['updateCanvasVideoPlaybackState']>(async (canvasId, input) => {
    try {
      const result = await api.updateCanvasVideoPlaybackState({
        canvasId,
        ...input
      });
      commitCanvasDocumentMutation(result);
    } catch (error) {
      notify(i18n.t('shell.notifications.updateCanvasVideoPlaybackFailed', {
        message: errorMessage(error)
      }));
      throw error;
    }
  }, [commitCanvasDocumentMutation, i18n, notify]);

  const addProjectPathToCanvasMap = useCallback<WorkbenchActions['addProjectPathToCanvasMap']>(async (input) => {
    try {
      const result = await api.addProjectPathToCanvasMap(input);
      commitProjectSnapshot(result.snapshot, result.projectRevision);
      setActiveCanvasId(result.canvas.id);
      explorerController.setSelection(projectTreeSelectionFromPaths([result.centerProjectRelativePath]));
      centerCanvasProjectionNode(result.projection, result.centerProjectRelativePath);
    } catch (error) {
      notify(i18n.t('shell.notifications.addToCanvasMapFailed', { message: errorMessage(error) }));
    }
  }, [centerCanvasProjectionNode, commitProjectSnapshot, explorerController.setSelection, i18n, notify]);

  const createCanvas = useCallback<WorkbenchActions['createCanvas']>(async () => {
    const result = await api.createCanvas();
    commitProjectSnapshot(result.snapshot, result.projectRevision);
    setActiveCanvasId(result.activeCanvasId);
    return result;
  }, [commitProjectSnapshot]);

  const renameCanvas = useCallback<WorkbenchActions['renameCanvas']>(async (input) => {
    const result = await api.renameCanvas(input);
    commitProjectSnapshot(result.snapshot, result.projectRevision);
    return result;
  }, [commitProjectSnapshot]);

  const deleteCanvas = useCallback<WorkbenchActions['deleteCanvas']>(async (input) => {
    const result = await api.deleteCanvas(input);
    commitProjectSnapshot(result.snapshot, result.projectRevision);
    if (activeCanvasId === input.canvasId) {
      setActiveCanvasId(result.activeCanvasId);
    }
    return result;
  }, [activeCanvasId, commitProjectSnapshot]);

  const reorderCanvases = useCallback<WorkbenchActions['reorderCanvases']>(async (input) => {
    const result = await api.reorderCanvases(input);
    commitProjectSnapshot(result.snapshot, result.projectRevision);
    return result;
  }, [commitProjectSnapshot]);

  const repairCanvasIndex = useCallback<WorkbenchActions['repairCanvasIndex']>(async () => {
    const result = await api.repairCanvasIndex();
    commitProjectSnapshot(result.snapshot, result.projectRevision);
    const repairedOrder = result.snapshot.canvasRegistry.status === 'ready'
      ? result.snapshot.canvasRegistry.canvasOrder
      : [];
    const repairedActiveCanvasId = activeCanvasId && repairedOrder.includes(activeCanvasId)
      ? activeCanvasId
      : result.activeCanvasId ?? repairedOrder[0];
    setActiveCanvasId(repairedActiveCanvasId);
    return result;
  }, [activeCanvasId, commitProjectSnapshot]);

  const openProject = useCallback<WorkbenchActions['openProject']>(async () => {
    setIsProjectOpening(true);
    setProjectOpenError(undefined);
    setProjectOpenAttemptedPath(undefined);
    try {
      const result = await api.openProjectFromPicker();
      if (!result.opened) {
        return;
      }
      if ('outcome' in result) {
        return;
      }
      commitOpenedProject(result);
    } catch (error) {
      const openHereProjectId = projectOpenHereProjectId(error);
      if (openHereProjectId) {
        setProjectOpenHereTargetId(openHereProjectId);
        return;
      }
      setProjectOpenError(i18n.t('projectOpen.openFailed', { message: errorMessage(error) }));
    } finally {
      setIsProjectOpening(false);
    }
  }, [commitOpenedProject, i18n]);

  const openProjectRoot = useCallback(async (projectRoot: string): Promise<void> => {
    setIsProjectOpening(true);
    setProjectOpenError(undefined);
    setProjectOpenAttemptedPath(projectRoot);
    try {
      const opened = await api.openProject({ projectRoot });
      if (!('outcome' in opened)) {
        commitOpenedProject(opened);
      }
    } catch (error) {
      const openHereProjectId = projectOpenHereProjectId(error);
      if (openHereProjectId) {
        setProjectOpenHereTargetId(openHereProjectId);
        return;
      }
      throw error;
    } finally {
      setIsProjectOpening(false);
    }
  }, [commitOpenedProject]);

  useEffect(() => {
    const shell = getDebruteShellApi();
    if (!shell) {
      return;
    }
    return shell.onOpenProjectRequested((projectRoot) => {
      void openProjectRoot(projectRoot).catch((error) => {
        notify(i18n.t('projectOpen.openFailed', { message: errorMessage(error) }));
      });
    });
  }, [i18n, notify, openProjectRoot]);

  const openWorkbenchContextMenu = useCallback((target: WorkbenchContextMenuTarget, position: WorkbenchContextMenuPosition) => {
    setContextMenu({ target, position });
  }, []);

  const closeWorkbenchContextMenu = useCallback(() => {
    setContextMenu(undefined);
  }, []);

  const openInspectorPanel = useCallback(() => {
    setFloatingPanels((current) => openFloatingPanel(current, 'inspector', workbenchViewportRectRef.current));
    setWindowOrder((current) => focusWorkbenchWindow(current, panelWindowIdentity('inspector')));
  }, []);

  const copyProjectRelativePath = useCallback(async (projectRelativePath: string) => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard unavailable');
      }
      await navigator.clipboard.writeText(projectRelativePath);
    } catch (error) {
      setNotifications((current) => [i18n.t('shell.notifications.copyFailed', { message: errorMessage(error) }), ...current].slice(0, 4));
    }
  }, [i18n]);

  const currentNodesForActiveCanvas = activeCanvasCurrentNodes?.canvasId === activeCanvas?.id
    ? activeCanvasCurrentNodes
    : undefined;
  const activeCanvasMinimapNodes = currentNodesForActiveCanvas
    ? currentNodesForActiveCanvas.nodes
    : undefined;
  const handleActiveCanvasCurrentNodesChange = useCallback((
    canvasId: string,
    nodes: ProjectedCanvasNode[] | undefined
  ) => {
    setActiveCanvasCurrentNodes((current) => {
      if (!nodes) {
        return current?.canvasId === canvasId ? undefined : current;
      }
      return { canvasId, nodes };
    });
  }, []);
  const effectiveTitleBarState = useMemo(() => buildWorkbenchTitleBarState({
    platform: productPlatform,
    host: getDebruteShellApi() ? 'desktop' : 'web',
    locale: settingsController.locale,
    projectTitle: snapshot?.metadata.project.name,
    recentProjectRoots: settingsController.globalSettings.status === 'ready'
      ? settingsController.globalSettings.value.chrome.recentProjects.map((project) => project.projectRoot)
      : []
  }), [settingsController.globalSettings, settingsController.locale, snapshot?.metadata.project.name]);
  const disabledFloatingPanelIds = useMemo<readonly FloatingPanelId[]>(() => (
    runtimeProjectId ? [] : ['terminal']
  ), [runtimeProjectId]);

  const state: WorkbenchState = {
    snapshot,
    projectId: runtimeProjectId,
    titleBarState: effectiveTitleBarState,
    globalSettings: settingsController.globalSettings,
    product: settingsController.product,
    resolvedTheme: settingsController.resolvedTheme,
    projectOpen: {
      ...(projectOpenAttemptedPath ? { attemptedPath: projectOpenAttemptedPath } : {}),
      ...(projectOpenError ? { error: projectOpenError } : {}),
      opening: isProjectOpening
    },
    explorerSelection: explorerController.selection,
    adobeBridge: settingsController.adobeBridge,
    canvasFeedback: feedbackController.feedback,
    textFileBuffers,
    textEditorWindows,
    notifications
  };

  const openTerminalPanel = useCallback((cwdProjectRelativePath = '') => {
    setRequestedTerminalCwd(cwdProjectRelativePath);
    setFloatingPanels((current) => openFloatingPanel(current, 'terminal', workbenchViewportRectRef.current));
    setWindowOrder((current) => focusWorkbenchWindow(current, panelWindowIdentity('terminal')));
  }, []);

  const actions: WorkbenchActions = useMemo(() => ({
    ...settingsController.actions,
    sendProjectFileToPhotoshop,
    openSendToPhotoshopPicker,
    lookupGeneratedAssetMetadata: api.lookupGeneratedAssetMetadata,
    readProjectTextFile: api.readProjectTextFile,
    writeProjectTextFile: api.writeProjectTextFile,
    saveCanvasTextPreviewSource: api.saveCanvasTextPreviewSource,
    readCanvasTextPreviewSources: api.readCanvasTextPreviewSources,
    readCanvasVideoPreviewSources: api.readCanvasVideoPreviewSources,
    ensureTextFileBuffer,
    updateTextFileBuffer,
    saveTextFileBuffer,
    discardTextFileBuffer,
    reloadTextFileBuffer,
    openTextEditorWindow,
    toggleTextFileWordWrap,
    updateCanvasNodeLayouts,
    resetCanvasNodeLayouts,
    bringCanvasNodeToFront,
    updateCanvasVideoPlaybackState,
    updateCanvasTextViewportState,
    updateCanvasFeedbackEntry: feedbackController.updateEntry,
    addProjectPathToCanvasMap,
    createCanvas,
    renameCanvas,
    deleteCanvas,
    reorderCanvases,
    repairCanvasIndex,
    openProject,
    openTerminalPanel
  }), [
    settingsController.actions,
    feedbackController.updateEntry,
    sendProjectFileToPhotoshop,
    openSendToPhotoshopPicker,
    ensureTextFileBuffer,
    updateTextFileBuffer,
    saveTextFileBuffer,
    discardTextFileBuffer,
    reloadTextFileBuffer,
    openTextEditorWindow,
    toggleTextFileWordWrap,
    updateCanvasNodeLayouts,
    resetCanvasNodeLayouts,
    bringCanvasNodeToFront,
    updateCanvasVideoPlaybackState,
    updateCanvasTextViewportState,
    addProjectPathToCanvasMap,
    createCanvas,
    renameCanvas,
    deleteCanvas,
    reorderCanvases,
    repairCanvasIndex,
    openProject,
    openTerminalPanel
  ]);

  useEffect(() => {
    if (!activeCanvasRuntime || !activeCanvasId) {
      return;
    }
    const stackOrderSync = createCanvasSelectionStackOrderSync({
      getSnapshot: () => snapshotRef.current,
      getActiveCanvasId: () => activeCanvasId,
      getSelection: () => activeCanvasRuntime.getSnapshot().selection,
      bringCanvasNodeToFront
    });
    return activeCanvasRuntime.subscribeSelection(() => {
      void stackOrderSync.syncSelectedNode().catch((error) => {
        notify(i18n.t('shell.notifications.bringCanvasNodeToFrontFailed', {
          message: errorMessage(error)
        }));
      });
    });
  }, [activeCanvasId, activeCanvasRuntime, bringCanvasNodeToFront, i18n, notify]);

  const openWorkbenchWindows = useMemo<WorkbenchWindowIdentity[]>(() => [
    ...FLOATING_PANEL_IDS
      .filter((panelId) => floatingPanels.panels[panelId].open)
      .map(panelWindowIdentity),
    ...Object.values(textEditorWindows)
      .filter((windowState) => windowState.open)
      .map((windowState) => textEditorWindowIdentity(windowState.projectRelativePath))
  ], [floatingPanels, textEditorWindows]);

  const renderWindowOrder = useMemo(
    () => syncOpenWorkbenchWindows(windowOrder, openWorkbenchWindows),
    [openWorkbenchWindows, windowOrder]
  );
  const handleTitleBarCommand = useCallback((item: Extract<WorkbenchMenuItem, { kind: 'command' }>) => {
    void executeTitleBarMenuCommand(item, {
      api,
      shell: getDebruteShellApi(),
      openProjectFromPicker: actions.openProject,
      openProjectRoot
    }).catch((error) => {
      notify(i18n.t('shell.notifications.menuCommandFailed', { message: errorMessage(error) }));
    });
  }, [actions.openProject, i18n, notify, openProjectRoot]);
  const handleTitleBarWindowCommand = useCallback((command: 'minimize' | 'toggle-maximize' | 'close') => {
    const shell = getDebruteShellApi();
    if (!shell) {
      return;
    }
    const promise = command === 'minimize'
      ? shell.minimizeNativeWindow()
      : command === 'toggle-maximize'
        ? shell.toggleMaximizeNativeWindow()
        : shell.closeNativeWindow();
    void promise.then((state) => {
      if ('maximized' in state) {
        setNativeWindowState(state);
        reconcileCurrentWorkbenchViewportLayout();
      }
    }).catch((error) => notify(i18n.t('shell.notifications.windowCommandFailed', { message: errorMessage(error) })));
  }, [i18n, notify, reconcileCurrentWorkbenchViewportLayout]);

  const minimapButtonRect = canvasMinimapButtonRect(workbenchViewportRect);
  const minimapPanelPlacement = placeCanvasMinimapPanel({
    buttonRect: minimapButtonRect,
    viewportRect: workbenchViewportRect
  });
  const resetLayoutButtonRect = snapshot?.canvasRegistry.status === 'ready'
    ? canvasResetLayoutButtonRect(workbenchViewportRect)
    : undefined;
  const cardBarRect = snapshot?.canvasRegistry.status === 'ready'
    ? canvasCardBarRect(workbenchViewportRect)
    : undefined;
  const floatingBarReservedRects = [
    TITLE_BAR_RESERVED_RECT(workbenchViewportRect.width),
    ...FIXED_TOP_FLOATING_BAR_RECTS,
    minimapButtonRect,
    ...(resetLayoutButtonRect ? [resetLayoutButtonRect] : []),
    ...(canvasMinimapOpen ? [minimapPanelPlacement] : []),
    ...(cardBarRect ? [cardBarRect] : [])
  ];
  useEffect(() => {
    const target = feedbackController.currentTarget;
    if (!activeCanvasRuntime || !target) {
      return;
    }
    const syncFeedbackBarPlacement = (camera: CanvasRuntimeSnapshot['camera']) => {
      const placement = feedbackBarPlacementForCanvasTarget({
        target,
        camera,
        viewportRect: workbenchViewportRect,
        reservedRects: floatingBarReservedRects
      });
      if (placement) {
        canvasOverlayRuntime.setFeedbackBarPlacement(placement);
      } else {
        canvasOverlayRuntime.clearFeedbackBarPlacement();
      }
    };
    syncFeedbackBarPlacement(activeCanvasRuntime.camera.getCamera());
    return activeCanvasRuntime.subscribeCamera(syncFeedbackBarPlacement);
  }, [
    activeCanvasRuntime,
    canvasOverlayRuntime,
    feedbackController.currentTarget,
    floatingBarReservedRects,
    workbenchViewportRect
  ]);
  const canResetActiveCanvasLayout = Boolean(activeProjection?.nodes.some((node) => node.layoutMode === 'manual'));
  const resetActiveCanvasLayout = useCallback(() => {
    if (!activeCanvasId) {
      return;
    }
    void actions.resetCanvasNodeLayouts(activeCanvasId, { all: true }).catch((error) => {
      notify(i18n.t('shell.notifications.resetCanvasLayoutFailed', { message: errorMessage(error) }));
    });
  }, [actions, activeCanvasId, i18n, notify]);
  const canRevealInCanvas = Boolean(activeCanvasRuntime && activeCanvasRuntimeSnapshot?.surfaceSize);
  const persistedAdobeBridgeEnabled = settingsController.globalSettings.status === 'ready'
    && settingsController.globalSettings.value.adobeBridge.enabled;
  const readyAdobeBridge = settingsController.adobeBridge.status === 'ready'
    ? settingsController.adobeBridge.value
    : undefined;
  const contextMenuItems = useMemo(() => contextMenu
      ? buildWorkbenchContextMenuItems({
          target: contextMenu.target,
          projection: activeProjection,
          canSelectCanvasNode: Boolean(activeCanvasRuntime),
          canRevealInCanvas,
          fileClipboard,
          adobeBridgeEnabled: persistedAdobeBridgeEnabled
        })
    : [], [activeCanvasRuntime, activeProjection, canRevealInCanvas, contextMenu, fileClipboard, persistedAdobeBridgeEnabled]);
  const canvasOrder = snapshot?.canvasRegistry.status === 'ready'
    ? snapshot.canvasRegistry.canvasOrder
    : [];
  const canvasCards = useMemo(() => {
    const canvasesById = new Map((snapshot?.canvases ?? []).map((canvas) => [canvas.id, canvas]));
    return canvasOrder.flatMap((canvasId) => {
      const canvas = canvasesById.get(canvasId);
      return canvas ? [{ id: canvas.id, name: canvas.name }] : [];
    });
  }, [canvasOrder, snapshot?.canvases]);
  const registryInvalid = snapshot?.canvasRegistry.status === 'invalid'
    ? snapshot.canvasRegistry
    : undefined;
  const permanentDeleteConfirmationLabels = useMemo(() => ({
    directory: (path: string) => i18n.t('shell.confirm.permanentDeleteDirectory', { path }),
    file: (path: string) => i18n.t('shell.confirm.permanentDeleteFile', { path }),
    selectedItems: (count: number) => i18n.t('shell.confirm.permanentDeleteSelected', { count })
  }), [i18n]);
  const confirmPermanentDelete = useCallback((input: { entries: Array<{ projectRelativePath: string; kind: 'file' | 'directory' }> }) => (
    window.confirm(permanentDeleteConfirmationMessageForEntries(input, permanentDeleteConfirmationLabels))
  ), [permanentDeleteConfirmationLabels]);
  const confirmMoveOverwrite = useCallback((input: {
    entries: ProjectPathEntry[];
    targetDirectoryProjectRelativePath: string;
  }) => (
    window.confirm(i18n.t('shell.confirm.moveOverwrite', {
      target: input.targetDirectoryProjectRelativePath || i18n.t('shell.confirm.projectRoot')
    }))
  ), [i18n]);
  const contextMenuCommandErrorLabels = useMemo(() => ({
    copyPathFailed: i18n.t('shell.notifications.copyPathFailed'),
    resetAutoLayoutFailed: i18n.t('shell.notifications.resetAutoLayoutFailed')
  }), [i18n]);
  const executeWorkbenchContextMenuCommand = useCallback((
    command: WorkbenchContextMenuCommand,
    commandContextMenu: typeof contextMenu
  ) => {
    runWorkbenchContextMenuCommand({
      command,
      contextMenu: commandContextMenu,
      activeProjection,
      activeCanvasRuntime,
      fileClipboard,
      actions,
      explorerCommands: explorerController,
      copyText: copyProjectRelativePath,
      notify,
      closeContextMenu: closeWorkbenchContextMenu,
      openInspectorPanel,
      confirmPermanentDelete,
      projectSnapshot: snapshot,
      confirmMoveOverwrite,
      errorLabels: contextMenuCommandErrorLabels
    });
  }, [
    actions,
    activeCanvasRuntime,
    activeProjection,
    closeWorkbenchContextMenu,
    confirmMoveOverwrite,
    contextMenuCommandErrorLabels,
    copyProjectRelativePath,
    confirmPermanentDelete,
    fileClipboard,
    explorerController,
    notify,
    openInspectorPanel,
    snapshot
  ]);
  const handleWorkbenchContextMenuCommand = useCallback((command: WorkbenchContextMenuCommand) => {
    executeWorkbenchContextMenuCommand(command, contextMenu);
  }, [contextMenu, executeWorkbenchContextMenuCommand]);
  const handleProjectTreeKeyboardFileCommand = useCallback((command: ProjectTreeFileKeyboardCommand, target: WorkbenchContextMenuTarget) => {
    executeWorkbenchContextMenuCommand(command, {
      target,
      position: { x: 0, y: 0 }
    });
  }, [executeWorkbenchContextMenuCommand]);
  if (connectionEnded) {
    return (
      <I18nProvider locale={settingsController.locale}>
        <WorkbenchIconProvider>
          <div className="workbench-shell" data-theme={settingsController.resolvedTheme} data-testid="workbench-shell">
            <WorkbenchTitleBar
              state={effectiveTitleBarState}
              nativeWindowState={nativeWindowState}
              onCommand={handleTitleBarCommand}
              onWindowCommand={handleTitleBarWindowCommand}
            />
            <div className="boot-screen boot-screen--with-titlebar" role="alert" data-testid="workbench-connection-ended">
              <strong>Debrute Runtime connection ended.</strong>
              <span>{connectionEnded.message}</span>
              <span>Refresh this page to start a new Workbench connection.</span>
            </div>
          </div>
        </WorkbenchIconProvider>
      </I18nProvider>
    );
  }

  if (isLoading) {
    return (
      <I18nProvider locale={settingsController.locale}>
        <WorkbenchIconProvider>
          <div className="workbench-shell" data-theme={settingsController.resolvedTheme} data-testid="workbench-shell">
            <WorkbenchTitleBar
              state={effectiveTitleBarState}
              nativeWindowState={nativeWindowState}
              onCommand={handleTitleBarCommand}
              onWindowCommand={handleTitleBarWindowCommand}
            />
            <div className="boot-screen boot-screen--with-titlebar">
              <Loader2 className="spin" size={22} />
              <span>{i18n.t('shell.boot.openingProject')}</span>
            </div>
          </div>
        </WorkbenchIconProvider>
      </I18nProvider>
    );
  }

  return (
    <I18nProvider locale={settingsController.locale}>
      <WorkbenchIconProvider>
        <div className="workbench-shell" data-theme={settingsController.resolvedTheme} data-testid="workbench-shell">
          <WorkbenchTitleBar
            state={effectiveTitleBarState}
            nativeWindowState={nativeWindowState}
            onCommand={handleTitleBarCommand}
            onWindowCommand={handleTitleBarWindowCommand}
          />
          {projectOpenHereTargetId ? (
            <div className="workbench-detached-overlay" role="status" data-testid="workbench-open-here-overlay">
              <strong>This Project is active in a Web Workbench.</strong>
              <span>Choose Open Here to move it to this Desktop window.</span>
              <Button disabled={isProjectOpening} onClick={() => { void openProjectHere(); }}>Open Here</Button>
            </div>
          ) : projectDetached ? (
            <div className="workbench-detached-overlay" role="status" data-testid="workbench-detached-overlay">
              <strong>This Project is active in another Workbench.</strong>
              <span>This window is read-only. Your local drafts remain visible here.</span>
              <Button onClick={() => { void reopenDetachedProject(); }}>Open Here</Button>
            </div>
          ) : null}
          <div className="canvas-layer" data-testid="canvas-layer">
            {registryInvalid ? (
              <div className="empty-editor empty-project">
                <strong>{i18n.t('canvas.registry.needsRepair')}</strong>
                <span>{registryInvalid.message}</span>
                <Button
                  onClick={() => { void actions.repairCanvasIndex().catch((error) => notify(i18n.t('shell.notifications.canvasRegistryRepairFailed', { message: errorMessage(error) }))); }}
                >
                  {i18n.t('canvas.registry.autoRepair')}
                </Button>
              </div>
            ) : (
              <CanvasEditor
                canvasId={activeCanvasId}
                state={state}
                actions={actions}
                runtimeScopeKey={canvasRuntimeScopeKey}
                overlayRuntime={canvasOverlayRuntime}
                minimapOpen={canvasMinimapOpen}
                feedbackPlacementContext={{
                  viewportRect: workbenchViewportRect,
                  reservedRects: floatingBarReservedRects
                }}
                onCurrentNodesChange={handleActiveCanvasCurrentNodesChange}
                onFeedbackBarTargetChange={feedbackController.handleTargetChange}
                onRuntimeChange={setActiveCanvasRuntime}
                onOpenContextMenu={openWorkbenchContextMenu}
                localFeedbackMode={feedbackController.localMode}
                pendingFeedbackItem={feedbackController.pendingItem}
                onLocalFeedbackDraft={feedbackController.handleDraft}
              />
            )}
          </div>
          <div className="floating-bar-layer" data-testid="floating-bar-layer">
            <FloatingDock
              panelState={floatingPanels}
              disabledPanelIds={disabledFloatingPanelIds}
              onToggle={(panelId) => {
                if (disabledFloatingPanelIds.includes(panelId)) {
                  return;
                }
                const isOpen = floatingPanels.panels[panelId].open;
                setFloatingPanels((current) => toggleFloatingPanel(current, panelId, workbenchViewportRect));
                setWindowOrder((current) => (
                  isOpen
                    ? closeWorkbenchWindow(current, panelWindowIdentity(panelId))
                    : focusWorkbenchWindow(current, panelWindowIdentity(panelId))
                ));
              }}
            />
            <CanvasMinimapBar
              canvas={activeCanvas}
              nodes={activeCanvasMinimapNodes}
              runtime={activeCanvasRuntime}
              overlayRuntime={canvasOverlayRuntime}
              open={canvasMinimapOpen}
              onOpenChange={setCanvasMinimapOpen}
              panelPlacement={minimapPanelPlacement}
            />
            {snapshot?.canvasRegistry.status === 'ready' ? (
              <CanvasResetLayoutButton
                enabled={canResetActiveCanvasLayout}
                onResetCanvasLayout={resetActiveCanvasLayout}
              />
            ) : null}
            {feedbackController.currentTarget ? (
              <CanvasFeedbackBar
                projectRelativePath={feedbackController.currentTarget.projectRelativePath}
                entry={feedbackController.currentTarget.entry}
                onUpdate={actions.updateCanvasFeedbackEntry}
                overlayRuntime={canvasOverlayRuntime}
                localToolset={feedbackController.currentTarget.localToolset}
                localFeedbackMode={feedbackController.currentTarget.localToolset !== 'none' ? feedbackController.localMode : undefined}
                onLocalFeedbackModeChange={feedbackController.currentTarget.localToolset === 'image' ? feedbackController.handleModeChange : undefined}
                canStartVideoMomentFeedback={feedbackController.currentTarget.canStartVideoMomentFeedback}
                onStartVideoMomentFeedback={feedbackController.currentTarget.startVideoMomentFeedback}
                onSeekToMoment={feedbackController.currentTarget.seekToMoment}
                pendingItemComment={
                  feedbackController.pendingItem?.projectRelativePath === feedbackController.currentTarget.projectRelativePath
                    ? feedbackController.pendingComment
                    : undefined
                }
                pendingItemLabel={
                  feedbackController.pendingItem?.projectRelativePath === feedbackController.currentTarget.projectRelativePath
                    ? feedbackController.pendingItem.label
                    : undefined
                }
                pendingItemReadyForComment={
                  feedbackController.pendingItem?.projectRelativePath === feedbackController.currentTarget.projectRelativePath
                    ? feedbackController.pendingItem.kind === 'comment' || feedbackController.pendingItem.geometry !== undefined
                    : undefined
                }
                onPendingItemCommentChange={
                  feedbackController.pendingItem?.projectRelativePath === feedbackController.currentTarget.projectRelativePath
                    ? feedbackController.setPendingComment
                    : undefined
                }
                onSavePendingItem={
                  feedbackController.pendingItem?.projectRelativePath === feedbackController.currentTarget.projectRelativePath
                    ? feedbackController.savePending
                    : undefined
                }
                onCancelPendingItem={
                  feedbackController.pendingItem?.projectRelativePath === feedbackController.currentTarget.projectRelativePath
                    ? feedbackController.cancelPending
                    : undefined
                }
                onPointerEnter={feedbackController.handlePointerEnter}
                onPointerLeave={feedbackController.handlePointerLeave}
              />
            ) : null}
            {snapshot?.canvasRegistry.status === 'ready' ? (
              <CanvasCardBar
                canvases={canvasCards}
                activeCanvasId={activeCanvasId}
                onActiveCanvasChange={setActiveCanvasId}
                onCreateCanvas={() => actions.createCanvas().then(() => undefined).catch((error) => notify(i18n.t('shell.notifications.createCanvasFailed', { message: errorMessage(error) })))}
                onRenameCanvas={(input) => actions.renameCanvas(input).then(() => undefined).catch((error) => notify(i18n.t('shell.notifications.renameCanvasFailed', { message: errorMessage(error) })))}
                onDeleteCanvas={(input) => actions.deleteCanvas(input).then(() => undefined).catch((error) => notify(i18n.t('shell.notifications.deleteCanvasFailed', { message: errorMessage(error) })))}
                onReorderCanvases={(input) => actions.reorderCanvases(input).then(() => undefined).catch((error) => notify(i18n.t('shell.notifications.reorderCanvasesFailed', { message: errorMessage(error) })))}
              />
            ) : null}
            {Object.values(textEditorWindows).filter((windowState) => windowState.open).map((windowState) => (
              <FloatingTextEditorWindow
                key={windowState.projectRelativePath}
                windowState={windowState}
                orderState={renderWindowOrder}
                buffer={textFileBuffers[windowState.projectRelativePath]}
                actions={actions}
                onBringToFront={() => setWindowOrder((current) => (
                  focusWorkbenchWindow(current, textEditorWindowIdentity(windowState.projectRelativePath))
                ))}
                onClose={() => {
                  setTextEditorWindows((windows) => closeTextEditorWindowState(windows, windowState.projectRelativePath));
                  setWindowOrder((current) => closeWorkbenchWindow(current, textEditorWindowIdentity(windowState.projectRelativePath)));
                }}
                onDrag={(dx, dy) => setTextEditorWindows((windows) => dragTextEditorWindowState(windows, windowState.projectRelativePath, { dx, dy }, workbenchViewportRect))}
                onResize={(rect) => setTextEditorWindows((windows) => resizeTextEditorWindowState(windows, windowState.projectRelativePath, rect, workbenchViewportRect))}
              />
            ))}
          </div>
          <div className="panel-layer" data-testid="panel-layer">
            {FLOATING_PANEL_IDS.map((panelId) => (
              floatingPanels.panels[panelId].open ? (
                <WorkbenchFloatingPanelShell
                  key={panelId}
                  panelId={panelId}
                  state={floatingPanels}
                  orderState={renderWindowOrder}
                  onClose={() => {
                    setFloatingPanels((current) => closeFloatingPanel(current, panelId));
                    setWindowOrder((current) => closeWorkbenchWindow(current, panelWindowIdentity(panelId)));
                  }}
                  onBringToFront={() => setWindowOrder((current) => focusWorkbenchWindow(current, panelWindowIdentity(panelId)))}
                  onDrag={(dx, dy) => setFloatingPanels((current) => dragFloatingPanel(current, panelId, { dx, dy }, workbenchViewportRect))}
                  onResize={(rect) => setFloatingPanels((current) => resizeFloatingPanel(current, panelId, rect, workbenchViewportRect))}
                >
                  <FloatingPanelContent
                    panelId={panelId}
                    state={state}
                    activeCanvasId={activeCanvasId}
                    activeCanvasRuntime={activeCanvasRuntime}
                    actions={actions}
                    onOpenContextMenu={openWorkbenchContextMenu}
                    fileClipboard={fileClipboard}
                    inlineProjectTreeEdit={inlineProjectTreeEdit}
                    onEditValueChange={explorerController.updateEditValue}
                    onEditSubmit={() => void explorerController.submitEdit()}
                    onEditCancel={explorerController.cancelEdit}
                    onClearCut={explorerController.clearCut}
                    onExplorerSelectionChange={explorerController.setSelection}
                    onLocateFileInCanvas={locateProjectFileInCanvas}
                    onProjectTreeInternalDrop={explorerController.handleInternalDrop}
                    onProjectTreeExternalDrop={explorerController.handleExternalDrop}
                    onCreateRootFile={() => explorerController.beginCreateFile('')}
                    productPlatform={productPlatform}
                    onKeyboardFileCommand={handleProjectTreeKeyboardFileCommand}
                    terminalPanel={(
                      <TerminalPanel
                        api={api}
                        resolvedTheme={settingsController.resolvedTheme}
                        requestedCwdProjectRelativePath={requestedTerminalCwd}
                        onRequestedCwdConsumed={() => setRequestedTerminalCwd(null)}
                      />
                    )}
                  />
                </WorkbenchFloatingPanelShell>
              ) : null
            ))}
          </div>
          {contextMenu ? (
            <WorkbenchContextMenu
              items={contextMenuItems}
              position={contextMenu.position}
              productPlatform={productPlatform}
              onCommand={handleWorkbenchContextMenuCommand}
              onClose={closeWorkbenchContextMenu}
            />
          ) : null}
          {sendToPhotoshopPath && runtimeProjectId ? (
            <SendToPhotoshopDialog
              projectId={runtimeProjectId}
              projectRelativePath={sendToPhotoshopPath}
              enabled={persistedAdobeBridgeEnabled}
              bridge={readyAdobeBridge}
              sending={sendingToPhotoshop}
              onClose={() => setSendToPhotoshopPath(undefined)}
              onSend={(pluginInstanceId) => {
                setSendingToPhotoshop(true);
                void actions.sendProjectFileToPhotoshop({
                  projectRelativePath: sendToPhotoshopPath,
                  pluginInstanceId
                }).then(() => {
                  setSendToPhotoshopPath(undefined);
                }).catch((error) => {
                  notify(i18n.t('shell.notifications.sendToPhotoshopFailed', { message: errorMessage(error) }));
                }).finally(() => {
                  setSendingToPhotoshop(false);
                });
              }}
            />
          ) : null}
          <NotificationStack notifications={notifications} />
        </div>
      </WorkbenchIconProvider>
    </I18nProvider>
  );
}

function replaceCanvasMutationInSnapshot(
  snapshot: WorkbenchProjectSessionSnapshot,
  result: WorkbenchCanvasDocumentMutationResult
): WorkbenchProjectSessionSnapshot {
  return {
    ...snapshot,
    canvases: snapshot.canvases.map((canvas) => canvas.id === result.canvas.id ? result.canvas : canvas),
    projections: snapshot.projections.map((projection) => (
      projection.canvasId === result.projection.canvasId ? result.projection : projection
    ))
  };
}

function sameWorkbenchRuntimeSnapshot(
  current: CanvasRuntimeSnapshot | undefined,
  next: CanvasRuntimeSnapshot
): boolean {
  return Boolean(
    current
    && current.camera.x === next.camera.x
    && current.camera.y === next.camera.y
    && current.camera.z === next.camera.z
    && current.cameraState === next.cameraState
    && current.selection === next.selection
    && current.surfaceSize?.width === next.surfaceSize?.width
    && current.surfaceSize?.height === next.surfaceSize?.height
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function localizedProjectOpenError(error: ProjectOpenStartupError | undefined, i18n: WorkbenchI18n): string | undefined {
  if (!error) {
    return undefined;
  }
  if (error.code === 'project-path-required') {
    return i18n.t('projectOpen.pathRequired');
  }
  if (error.code === 'project-path-must-be-absolute') {
    return i18n.t('projectOpen.pathMustBeAbsolute');
  }
  if (error.code === 'project-open-here-required') {
    return undefined;
  }
  if (error.code === 'project-snapshot-load-failed') {
    return i18n.t('projectOpen.snapshotLoadFailed', { message: error.message });
  }
  if (error.code === 'project-open-failed') {
    return i18n.t('projectOpen.openFailed', { message: error.message });
  }
  return assertNever(error);
}

function assertNever(value: never): never {
  throw new Error(`[debrute:workbench] Unhandled project open error: ${String(value)}`);
}
