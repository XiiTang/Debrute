import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Loader2 } from './ui/index.js';
import type {
  DebruteProductPlatform,
  DebruteWorkbenchRoute,
  ProjectPathEntry,
  WorkbenchProjectSessionSnapshot
} from '@debrute/app-protocol';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import { createHttpWorkbenchApiClient } from '../api/httpWorkbenchApiClient';
import { getDebruteShellApi, type NativeWindowState } from '../api/shellApi';
import { CanvasEditor } from './canvas/CanvasEditor';
import { CanvasCardBar } from './canvas/CanvasCardBar';
import { CanvasMinimapBar } from './canvas/CanvasMinimapBar';
import { CanvasResetLayoutButton } from './canvas/CanvasResetLayoutButton';
import { createCanvasOverlayRuntime } from './canvas/CanvasOverlayRuntime';
import {
  CanvasFeedbackInteractionBar,
  useCanvasFeedbackInteraction
} from './canvas/CanvasFeedbackInteraction';
import type { CanvasEditorRuntime, CanvasRuntimeSnapshot } from './canvas/runtime/CanvasEditorRuntime';
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
import { createProjectPathCommandCoordinator } from './services/projectPathCommandCoordinator';
import { SendToPhotoshopDialog } from './adobe-bridge/SendToPhotoshopDialog';
import { WorkbenchContextMenu } from './shell/WorkbenchContextMenu';
import { WorkbenchTitleBar } from './shell/WorkbenchTitleBar';
import { executeTitleBarMenuCommand } from './shell/workbenchTitleBarCommands';
import {
  buildWorkbenchTitleBarState,
  type WorkbenchMenuItem
} from './shell/workbenchTitleBarState';
import {
  cameraCenteredOnNode,
  type ProjectPathCommand,
  type WorkbenchContextMenuPosition,
  type WorkbenchContextMenuTarget
} from './shell/contextMenu';
import type { ProjectTreeFileKeyboardCommand } from './project-explorer/projectTreeKeyboardCommands';
import {
  createCanvasTextViewportStateController
} from './services/canvasSnapshotUpdates';
import type { WorkbenchProjectProjectionState } from './services/WorkbenchProjectProjection.js';
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
import { Button, WorkbenchIconProvider } from './ui/index.js';
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
  const projectProjection = useSyncExternalStore(
    api.projectProjection.subscribe,
    api.projectProjection.getState
  );
  const acceptedProject = projectProjection.status === 'unbound' ? undefined : projectProjection;
  const runtimeProjectId = acceptedProject?.projectId;
  const [connectionEnded, setConnectionEnded] = useState<Error>();
  const [notifications, setNotifications] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(() => shouldShowInitialProjectLoader(initialRoute));
  const [projectOpenAttemptedPath, setProjectOpenAttemptedPath] = useState<string>();
  const [projectOpenError, setProjectOpenError] = useState<string>();
  const [projectOpenHereTargetId, setProjectOpenHereTargetId] = useState<string>();
  const [isProjectOpening, setIsProjectOpening] = useState(false);
  const initialProjectOpeningRef = useRef<ReturnType<typeof openInitialProject> | undefined>(undefined);
  const announcedProjectGenerationsRef = useRef(new Set<number>());
  const notify = useCallback((message: string) => {
    setNotifications((current) => [message, ...current].slice(0, 4));
  }, []);
  const settingsController = useWorkbenchSettingsController({ api, projectId: runtimeProjectId, notify });
  const i18n = useMemo(() => createI18n(settingsController.locale), [settingsController.locale]);
  const announceProjectGeneration = useCallback((input: {
    generation: number;
    projectName: string;
    viewStateInvalid: boolean;
  }) => {
    if (announcedProjectGenerationsRef.current.has(input.generation)) {
      return;
    }
    announcedProjectGenerationsRef.current.add(input.generation);
    const currentI18n = settingsController.getCurrentI18n();
    if (input.viewStateInvalid) {
      notify(currentI18n.t('shell.notifications.projectViewStateReset', {
        name: input.projectName
      }));
    }
    notify(currentI18n.t('shell.notifications.projectOpened', {
      name: input.projectName
    }));
  }, [notify, settingsController.getCurrentI18n]);

  useEffect(() => api.onConnectionEnded(setConnectionEnded), []);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        initialProjectOpeningRef.current ??= openInitialProject(api, initialRoute);
        const result = await initialProjectOpeningRef.current;
        if (disposed) {
          return;
        }
        setProjectOpenAttemptedPath(result.projectOpen?.attemptedPath);
        setProjectOpenError(localizedProjectOpenError(result.projectOpen?.error, settingsController.getCurrentI18n()));
        setProjectOpenHereTargetId(
          result.projectOpen?.error?.code === 'project-open-here-required'
            ? result.projectOpen.error.projectId
            : undefined
        );
      } catch (error) {
        if (!disposed) {
          notify(settingsController.getCurrentI18n().t('shell.notifications.projectStartupFailed', {
            message: errorMessage(error)
          }));
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
  }, [initialRoute, notify, settingsController.getCurrentI18n]);

  const projectGenerationAppProps = {
    projectProjection,
    connectionEnded,
    notifications,
    setNotifications,
    notify,
    announceProjectGeneration,
    settingsController,
    i18n,
    isLoading,
    projectOpenAttemptedPath,
    setProjectOpenAttemptedPath,
    projectOpenError,
    setProjectOpenError,
    projectOpenHereTargetId,
    setProjectOpenHereTargetId,
    isProjectOpening,
    setIsProjectOpening
  };
  const surface = projectProjection.status === 'unbound' ? (
    <WorkbenchProjectGenerationApp {...projectGenerationAppProps} />
  ) : (
    <WorkbenchProjectGenerationApp
      key={projectProjection.generation}
      {...projectGenerationAppProps}
    />
  );
  return (
    <>
      {surface}
      <NotificationStack notifications={notifications} />
    </>
  );
}

function WorkbenchProjectGenerationApp({
  projectProjection,
  connectionEnded,
  notifications,
  setNotifications,
  notify,
  announceProjectGeneration,
  settingsController,
  i18n,
  isLoading,
  projectOpenAttemptedPath,
  setProjectOpenAttemptedPath,
  projectOpenError,
  setProjectOpenError,
  projectOpenHereTargetId,
  setProjectOpenHereTargetId,
  isProjectOpening,
  setIsProjectOpening
}: {
  projectProjection: WorkbenchProjectProjectionState;
  connectionEnded: Error | undefined;
  notifications: string[];
  setNotifications: React.Dispatch<React.SetStateAction<string[]>>;
  notify(message: string): void;
  announceProjectGeneration(input: {
    generation: number;
    projectName: string;
    viewStateInvalid: boolean;
  }): void;
  settingsController: ReturnType<typeof useWorkbenchSettingsController>;
  i18n: WorkbenchI18n;
  isLoading: boolean;
  projectOpenAttemptedPath: string | undefined;
  setProjectOpenAttemptedPath: React.Dispatch<React.SetStateAction<string | undefined>>;
  projectOpenError: string | undefined;
  setProjectOpenError: React.Dispatch<React.SetStateAction<string | undefined>>;
  projectOpenHereTargetId: string | undefined;
  setProjectOpenHereTargetId: React.Dispatch<React.SetStateAction<string | undefined>>;
  isProjectOpening: boolean;
  setIsProjectOpening: React.Dispatch<React.SetStateAction<boolean>>;
}): React.ReactElement {
  const acceptedProject = projectProjection.status === 'unbound' ? undefined : projectProjection;
  const hasAcceptedProject = acceptedProject !== undefined;
  const snapshot = acceptedProject?.presentedSnapshot;
  const runtimeProjectId = acceptedProject?.projectId;
  const projectDetached = projectProjection.status === 'detached';
  const projectPresentationBlocked = Boolean(connectionEnded || projectDetached);
  const projectPathCommandAdmissionRef = useRef(!isProjectOpening);
  const retiredProjectPathCommandAdmissionRef = useRef(false);
  useEffect(() => {
    if (isProjectOpening) {
      projectPathCommandAdmissionRef.current = false;
      return;
    }
    if (!retiredProjectPathCommandAdmissionRef.current) {
      projectPathCommandAdmissionRef.current = true;
    }
  }, [isProjectOpening]);
  const canStartProjectPathCommand = useCallback(
    () => projectPathCommandAdmissionRef.current && !projectPresentationBlocked,
    [projectPresentationBlocked]
  );
  const beginProjectOpening = useCallback(() => {
    if (!projectPathCommandAdmissionRef.current) {
      return false;
    }
    projectPathCommandAdmissionRef.current = false;
    setIsProjectOpening(true);
    return true;
  }, [setIsProjectOpening]);
  const finishProjectOpening = useCallback((restoreCommandAdmission: boolean) => {
    retiredProjectPathCommandAdmissionRef.current = !restoreCommandAdmission;
    projectPathCommandAdmissionRef.current = restoreCommandAdmission;
    setIsProjectOpening(false);
  }, [setIsProjectOpening]);
  const didProjectBindingChange = useCallback(
    () => api.projectProjection.getState().generation !== projectProjection.generation,
    [projectProjection.generation]
  );
  const isCurrentProjectPathCommandScope = useCallback(() => {
    const current = api.projectProjection.getState();
    return current.status !== 'unbound'
      && current.projectId === runtimeProjectId
      && current.generation === projectProjection.generation;
  }, [runtimeProjectId, projectProjection.generation]);
  const initialProjectPresentation = useMemo(
    () => createInitialProjectPresentation(acceptedProject),
    []
  );
  const [activeCanvasId, setActiveCanvasId] = useState<string | undefined>(
    initialProjectPresentation.activeCanvasId
  );
  const [activeCanvasRuntime, setActiveCanvasRuntime] = useState<CanvasEditorRuntime>();
  const [activeCanvasRuntimeSnapshot, setActiveCanvasRuntimeSnapshot] = useState<CanvasRuntimeSnapshot>();
  const [activeCanvasCurrentNodes, setActiveCanvasCurrentNodes] = useState<{
    canvasId: string;
    nodes: ProjectedCanvasNode[];
  }>();
  const canvasRuntimeScopeKey = projectProjection.generation;
  const [floatingPanels, setFloatingPanels] = useState<FloatingPanelState>(
    initialProjectPresentation.floatingPanels
  );
  const [requestedTerminalCwd, setRequestedTerminalCwd] = useState<string | null>(null);
  const [textFileBuffers, setTextFileBuffers] = useState<Record<string, TextFileBuffer>>(
    initialProjectPresentation.textFileBuffers
  );
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
  const [workbenchViewportRect, setWorkbenchViewportRect] = useState(
    initialProjectPresentation.viewportRect
  );
  const canvasOverlayRuntime = useMemo(() => createCanvasOverlayRuntime(), []);
  const workbenchViewportRectRef = useRef(workbenchViewportRect);
  const textFileBuffersRef = useRef(textFileBuffers);
  const textEditorWindowsRef = useRef(textEditorWindows);
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
    if (!canStartProjectPathCommand()) {
      return;
    }
    centerCanvasProjectionNode(activeProjection, projectRelativePath);
  }, [activeProjection, canStartProjectPathCommand, centerCanvasProjectionNode]);
  const getAcceptedProjectSnapshot = useCallback(() => {
    const state = api.projectProjection.getState();
    return state.status === 'unbound' ? undefined : state.presentedSnapshot;
  }, []);
  const explorerController = useProjectExplorerController({
    api,
    projectId: runtimeProjectId,
    projectGeneration: projectProjection.generation,
    getSnapshot: getAcceptedProjectSnapshot,
    activeCanvasRuntime,
    locateProjectFileInCanvas,
    notify,
    i18n,
    canStartProjectPathCommand,
    isCurrentProjectPathCommandScope
  });
  const { fileClipboard, inlineEdit: inlineProjectTreeEdit } = explorerController;

  const notifyCanvasFeedbackUnavailable = useCallback((message: string) => {
    const currentI18n = settingsController.getCurrentI18n();
    setNotifications((current) => [currentI18n.t('canvas.feedback.unavailable', { message }), ...current].slice(0, 4));
  }, [settingsController.getCurrentI18n]);
  const feedbackInteraction = useCanvasFeedbackInteraction({
    api,
    projectId: runtimeProjectId,
    overlayRuntime: canvasOverlayRuntime,
    notifyUnavailable: notifyCanvasFeedbackUnavailable
  });

  useEffect(() => {
    if (!acceptedProject) {
      return;
    }
    announceProjectGeneration({
      generation: acceptedProject.generation,
      projectName: acceptedProject.presentedSnapshot.metadata.project.name,
      viewStateInvalid: initialProjectPresentation.viewStateInvalid
    });
    setProjectOpenHereTargetId(undefined);
    setProjectOpenAttemptedPath(undefined);
    setProjectOpenError(undefined);
    replaceWorkbenchProjectRoute(acceptedProject.projectId);
    feedbackInteraction.restoreWorkingCopies(acceptedProject.workingCopies.feedback);
    void feedbackInteraction.load();
  }, [acceptedProject?.generation]);

  const reopenDetachedProject = useCallback(async () => {
    if (!runtimeProjectId) {
      return;
    }
    if (!beginProjectOpening()) {
      return;
    }
    setProjectOpenError(undefined);
    let projectBindingChanged = false;
    try {
      const opened = await api.openProject({ projectId: runtimeProjectId, forceOpenHere: true });
      if (!('outcome' in opened)) {
        projectBindingChanged = didProjectBindingChange();
        replaceWorkbenchProjectRoute(opened.projectId);
      }
    } catch (error) {
      setProjectOpenError(i18n.t('projectOpen.openFailed', { message: errorMessage(error) }));
    } finally {
      finishProjectOpening(!projectBindingChanged);
    }
  }, [beginProjectOpening, didProjectBindingChange, finishProjectOpening, i18n, runtimeProjectId, setProjectOpenError]);

  const openProjectHere = useCallback(async () => {
    if (!projectOpenHereTargetId) {
      return;
    }
    if (!beginProjectOpening()) {
      return;
    }
    setProjectOpenError(undefined);
    let projectBindingChanged = false;
    try {
      const opened = await api.openProject({
        projectId: projectOpenHereTargetId,
        forceOpenHere: true
      });
      if (!('outcome' in opened)) {
        projectBindingChanged = didProjectBindingChange();
        replaceWorkbenchProjectRoute(opened.projectId);
      }
    } catch (error) {
      setProjectOpenError(i18n.t('projectOpen.openFailed', { message: errorMessage(error) }));
    } finally {
      finishProjectOpening(!projectBindingChanged);
    }
  }, [beginProjectOpening, didProjectBindingChange, finishProjectOpening, i18n, projectOpenHereTargetId, setProjectOpenError]);

  useEffect(() => {
    workbenchViewportRectRef.current = workbenchViewportRect;
  }, [workbenchViewportRect]);

  useEffect(() => {
    textFileBuffersRef.current = textFileBuffers;
  }, [textFileBuffers]);

  useEffect(() => {
    textEditorWindowsRef.current = textEditorWindows;
  }, [textEditorWindows]);

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
    if (isCurrentProjectPathCommandScope()) {
      notify(i18n.t('shell.notifications.sentToPhotoshop', { path: input.projectRelativePath }));
    }
    return result;
  }, [i18n, isCurrentProjectPathCommandScope, notify]);
  const openSendToPhotoshopPicker = useCallback<WorkbenchActions['openSendToPhotoshopPicker']>((projectRelativePath) => {
    if (!canStartProjectPathCommand()) {
      return;
    }
    setSendToPhotoshopPath(projectRelativePath);
  }, [canStartProjectPathCommand]);

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
      feedbackInteraction.applyEvent(event);

      if (event.type === 'project.fileChanged') {
        void refreshTextFileBuffer(event.event.projectRelativePath);
        if (event.event.projectRelativePath === '.debrute/reviews/canvas-feedback.json') {
          void feedbackInteraction.load();
        }
      }
    });
  }, [
    feedbackInteraction.applyEvent,
    feedbackInteraction.load,
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
    projectProjection: api.projectProjection,
    updateCanvasTextViewportState: (canvasId, input) => api.updateCanvasTextViewportState({
      canvasId,
      ...input
    })
  }), []);

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

  const updateCanvasNodeLayouts = useCallback<WorkbenchActions['updateCanvasNodeLayouts']>(async (canvasId, input) => {
    try {
      await api.updateCanvasNodeLayouts({
        canvasId,
        ...input
      });
    } catch (error) {
      notify(i18n.t('shell.notifications.updateCanvasLayoutFailed', { message: errorMessage(error) }));
      throw error;
    }
  }, [i18n, notify]);

  const resetCanvasNodeLayouts = useCallback<WorkbenchActions['resetCanvasNodeLayouts']>(async (canvasId, input) => {
    const result = await api.resetCanvasNodeLayouts({
      canvasId,
      ...input
    });
    return result;
  }, []);

  const bringCanvasNodeToFront = useCallback<WorkbenchActions['bringCanvasNodeToFront']>(async (canvasId, input) => {
    await api.bringCanvasNodeToFront({
      canvasId,
      ...input
    });
  }, []);

  const updateCanvasVideoPlaybackState = useCallback<WorkbenchActions['updateCanvasVideoPlaybackState']>(async (canvasId, input) => {
    try {
      await api.updateCanvasVideoPlaybackState({
        canvasId,
        ...input
      });
    } catch (error) {
      notify(i18n.t('shell.notifications.updateCanvasVideoPlaybackFailed', {
        message: errorMessage(error)
      }));
      throw error;
    }
  }, [i18n, notify]);

  const addProjectPathToCanvasMap = useCallback<WorkbenchActions['addProjectPathToCanvasMap']>(async (input) => {
    if (!canStartProjectPathCommand()) {
      return;
    }
    try {
      await api.addProjectPathToCanvasMap(input);
      if (!isCurrentProjectPathCommandScope()) {
        return;
      }
      const accepted = api.projectProjection.getState();
      const projection = accepted.status === 'unbound'
        ? undefined
        : accepted.presentedSnapshot.projections.find((item) => item.canvasId === input.canvasId);
      setActiveCanvasId(input.canvasId);
      explorerController.setSelection(projectTreeSelectionFromPaths([input.projectRelativePath]));
      centerCanvasProjectionNode(projection, input.projectRelativePath);
    } catch (error) {
      if (!isCurrentProjectPathCommandScope()) {
        return;
      }
      notify(i18n.t('shell.notifications.addToCanvasMapFailed', { message: errorMessage(error) }));
    }
  }, [
    canStartProjectPathCommand,
    centerCanvasProjectionNode,
    explorerController.setSelection,
    i18n,
    isCurrentProjectPathCommandScope,
    notify
  ]);

  const createCanvas = useCallback<WorkbenchActions['createCanvas']>(async () => {
    const result = await api.createCanvas();
    setActiveCanvasId(result.activeCanvasId);
    return result;
  }, []);

  const renameCanvas = useCallback<WorkbenchActions['renameCanvas']>(async (input) => {
    const result = await api.renameCanvas(input);
    return result;
  }, []);

  const deleteCanvas = useCallback<WorkbenchActions['deleteCanvas']>(async (input) => {
    const result = await api.deleteCanvas(input);
    if (activeCanvasId === input.canvasId) {
      setActiveCanvasId(result.activeCanvasId);
    }
    return result;
  }, [activeCanvasId]);

  const reorderCanvases = useCallback<WorkbenchActions['reorderCanvases']>(async (input) => {
    const result = await api.reorderCanvases(input);
    return result;
  }, []);

  const repairCanvasIndex = useCallback<WorkbenchActions['repairCanvasIndex']>(async () => {
    const result = await api.repairCanvasIndex();
    const accepted = api.projectProjection.getState();
    const registry = accepted.status === 'unbound'
      ? undefined
      : accepted.presentedSnapshot.canvasRegistry;
    const repairedOrder = registry?.status === 'ready'
      ? registry.canvasOrder
      : [];
    const repairedActiveCanvasId = activeCanvasId && repairedOrder.includes(activeCanvasId)
      ? activeCanvasId
      : result.activeCanvasId ?? repairedOrder[0];
    setActiveCanvasId(repairedActiveCanvasId);
    return result;
  }, [activeCanvasId]);

  const openProject = useCallback<WorkbenchActions['openProject']>(async () => {
    if (!beginProjectOpening()) {
      return;
    }
    setProjectOpenError(undefined);
    setProjectOpenAttemptedPath(undefined);
    let projectBindingChanged = false;
    try {
      const result = await api.openProjectFromPicker();
      if (!result.opened) {
        return;
      }
      if ('outcome' in result) {
        return;
      }
      projectBindingChanged = didProjectBindingChange();
      replaceWorkbenchProjectRoute(result.projectId);
    } catch (error) {
      const openHereProjectId = projectOpenHereProjectId(error);
      if (openHereProjectId) {
        setProjectOpenHereTargetId(openHereProjectId);
        return;
      }
      setProjectOpenError(i18n.t('projectOpen.openFailed', { message: errorMessage(error) }));
    } finally {
      finishProjectOpening(!projectBindingChanged);
    }
  }, [beginProjectOpening, didProjectBindingChange, finishProjectOpening, i18n, setProjectOpenAttemptedPath, setProjectOpenError, setProjectOpenHereTargetId]);

  const openProjectRoot = useCallback(async (projectRoot: string): Promise<void> => {
    if (!beginProjectOpening()) {
      return;
    }
    setProjectOpenError(undefined);
    setProjectOpenAttemptedPath(projectRoot);
    let projectBindingChanged = false;
    try {
      const opened = await api.openProject({ projectRoot });
      if (!('outcome' in opened)) {
        projectBindingChanged = didProjectBindingChange();
        replaceWorkbenchProjectRoute(opened.projectId);
      }
    } catch (error) {
      const openHereProjectId = projectOpenHereProjectId(error);
      if (openHereProjectId) {
        setProjectOpenHereTargetId(openHereProjectId);
        return;
      }
      throw error;
    } finally {
      finishProjectOpening(!projectBindingChanged);
    }
  }, [beginProjectOpening, didProjectBindingChange, finishProjectOpening, setProjectOpenAttemptedPath, setProjectOpenError, setProjectOpenHereTargetId]);

  useEffect(() => {
    const shell = getDebruteShellApi();
    if (!shell) {
      return;
    }
    return shell.onOpenProjectRequested((projectRoot) => {
      void openProjectRoot(projectRoot).catch((error) => {
        const message = i18n.t('projectOpen.openFailed', { message: errorMessage(error) });
        if (hasAcceptedProject) {
          notify(message);
          return;
        }
        setProjectOpenError(message);
      });
    });
  }, [hasAcceptedProject, i18n, notify, openProjectRoot, setProjectOpenError]);

  const openWorkbenchContextMenu = useCallback((target: WorkbenchContextMenuTarget, position: WorkbenchContextMenuPosition) => {
    if (!canStartProjectPathCommand()) {
      return;
    }
    setContextMenu({ target, position });
  }, [canStartProjectPathCommand]);

  const closeWorkbenchContextMenu = useCallback(() => {
    setContextMenu(undefined);
  }, []);

  useEffect(() => {
    if (!isProjectOpening && !projectPresentationBlocked) {
      return;
    }
    closeWorkbenchContextMenu();
    explorerController.cancelEdit();
    setSendToPhotoshopPath(undefined);
  }, [closeWorkbenchContextMenu, explorerController.cancelEdit, isProjectOpening, projectPresentationBlocked]);

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
      if (isCurrentProjectPathCommandScope()) {
        setNotifications((current) => [i18n.t('shell.notifications.copyFailed', { message: errorMessage(error) }), ...current].slice(0, 4));
      }
    }
  }, [i18n, isCurrentProjectPathCommandScope]);

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
    canvasFeedback: feedbackInteraction.feedback,
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
      getSnapshot: () => {
        const accepted = api.projectProjection.getState();
        return accepted.status === 'unbound' ? undefined : accepted.presentedSnapshot;
      },
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
    const target = feedbackInteraction.currentTarget;
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
    feedbackInteraction.currentTarget,
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
  const projectPathCommandCoordinator = useMemo(() => createProjectPathCommandCoordinator({
    canStartCommand: canStartProjectPathCommand,
    isCurrentScope: isCurrentProjectPathCommandScope,
    menuContext: {
      projection: activeProjection,
      canSelectCanvasNode: Boolean(activeCanvasRuntime),
      canRevealInCanvas,
      fileClipboard,
      adobeBridgeEnabled: persistedAdobeBridgeEnabled
    },
    commandContext: {
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
      getProjectSnapshot: getAcceptedProjectSnapshot,
      confirmMoveOverwrite,
      errorLabels: contextMenuCommandErrorLabels
    }
  }), [
    actions,
    activeCanvasRuntime,
    activeProjection,
    canRevealInCanvas,
    canStartProjectPathCommand,
    closeWorkbenchContextMenu,
    confirmMoveOverwrite,
    contextMenuCommandErrorLabels,
    copyProjectRelativePath,
    confirmPermanentDelete,
    fileClipboard,
    getAcceptedProjectSnapshot,
    explorerController,
    isCurrentProjectPathCommandScope,
    notify,
    openInspectorPanel,
    persistedAdobeBridgeEnabled
  ]);
  const contextMenuItems = useMemo(() => contextMenu
    ? projectPathCommandCoordinator.contextMenuItems(contextMenu.target)
    : [], [contextMenu, projectPathCommandCoordinator]);
  const handleProjectPathContextMenuCommand = useCallback((command: ProjectPathCommand) => {
    projectPathCommandCoordinator.run(command, contextMenu);
  }, [contextMenu, projectPathCommandCoordinator]);
  const handleProjectTreeKeyboardFileCommand = useCallback((command: ProjectTreeFileKeyboardCommand, target: WorkbenchContextMenuTarget) => {
    projectPathCommandCoordinator.run(command, {
      target,
      position: { x: 0, y: 0 }
    });
  }, [projectPathCommandCoordinator]);
  if (connectionEnded && !acceptedProject) {
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
          {isProjectOpening && acceptedProject ? (
            <div
              className="workbench-project-opening-indicator"
              role="status"
              aria-live="polite"
              data-testid="workbench-project-opening"
            >
              <Loader2 className="spin" size={14} />
              <span>{i18n.t('shell.boot.openingProject')}</span>
            </div>
          ) : null}
          {connectionEnded ? (
            <WorkbenchCanvasDialog
              testId="workbench-connection-ended-dialog-layer"
              titleId="workbench-connection-ended-dialog-title"
              title="Debrute Runtime connection ended."
            >
              <span>{connectionEnded.message}</span>
              <span>This Project is read-only. Refresh this page to start a new Workbench connection.</span>
            </WorkbenchCanvasDialog>
          ) : projectDetached ? (
            <WorkbenchCanvasDialog
              testId="workbench-detached-dialog-layer"
              titleId="workbench-detached-dialog-title"
              title="This Project is active in another Workbench."
            >
              <span>This window is read-only. Your local drafts remain visible here.</span>
              <Button autoFocus disabled={isProjectOpening} onClick={() => { void reopenDetachedProject(); }}>Open Here</Button>
              {projectOpenError ? <span className="db-form-error" role="alert">{projectOpenError}</span> : null}
            </WorkbenchCanvasDialog>
          ) : null}
          <div className="canvas-layer" data-testid="canvas-layer" inert={projectPresentationBlocked}>
            {projectOpenHereTargetId ? (
              <div className="empty-editor empty-project" role="status" data-testid="workbench-open-here-status">
                <strong>This Project is active in a Web Workbench.</strong>
                <span>Choose Open Here to move it to this Desktop window.</span>
                <Button loading={isProjectOpening} disabled={isProjectOpening} onClick={() => { void openProjectHere(); }}>Open Here</Button>
                {projectOpenError ? (
                  <span className="db-form-error" role="alert" data-testid="workbench-open-here-error">
                    {projectOpenError}
                  </span>
                ) : null}
              </div>
            ) : registryInvalid ? (
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
                minimapOpen={canvasMinimapOpen}
                onCurrentNodesChange={handleActiveCanvasCurrentNodesChange}
                feedbackInteraction={feedbackInteraction.canvas}
                onRuntimeChange={setActiveCanvasRuntime}
                onOpenContextMenu={openWorkbenchContextMenu}
                interactionBlocked={projectPresentationBlocked}
              />
            )}
          </div>
          <div className="floating-bar-layer" data-testid="floating-bar-layer" inert={projectPresentationBlocked}>
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
              interactionBlocked={projectPresentationBlocked}
            />
            {snapshot?.canvasRegistry.status === 'ready' ? (
              <CanvasResetLayoutButton
                enabled={canResetActiveCanvasLayout}
                onResetCanvasLayout={resetActiveCanvasLayout}
              />
            ) : null}
            <CanvasFeedbackInteractionBar
              interaction={feedbackInteraction}
              overlayRuntime={canvasOverlayRuntime}
            />
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
          <div className="panel-layer" data-testid="panel-layer" inert={projectPresentationBlocked}>
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
          {!projectPresentationBlocked && contextMenu ? (
            <WorkbenchContextMenu
              items={contextMenuItems}
              position={contextMenu.position}
              productPlatform={productPlatform}
              onCommand={handleProjectPathContextMenuCommand}
              onClose={closeWorkbenchContextMenu}
            />
          ) : null}
          {!projectPresentationBlocked && sendToPhotoshopPath && runtimeProjectId ? (
            <SendToPhotoshopDialog
              projectId={runtimeProjectId}
              projectRelativePath={sendToPhotoshopPath}
              enabled={persistedAdobeBridgeEnabled}
              bridge={readyAdobeBridge}
              sending={sendingToPhotoshop}
              onClose={() => setSendToPhotoshopPath(undefined)}
              onSend={(pluginInstanceId) => {
                if (!canStartProjectPathCommand()) {
                  return;
                }
                setSendingToPhotoshop(true);
                void actions.sendProjectFileToPhotoshop({
                  projectRelativePath: sendToPhotoshopPath,
                  pluginInstanceId
                }).then(() => {
                  if (isCurrentProjectPathCommandScope()) {
                    setSendToPhotoshopPath(undefined);
                  }
                }).catch((error) => {
                  if (isCurrentProjectPathCommandScope()) {
                    notify(i18n.t('shell.notifications.sendToPhotoshopFailed', { message: errorMessage(error) }));
                  }
                }).finally(() => {
                  if (isCurrentProjectPathCommandScope()) {
                    setSendingToPhotoshop(false);
                  }
                });
              }}
            />
          ) : null}
        </div>
      </WorkbenchIconProvider>
    </I18nProvider>
  );
}

function WorkbenchCanvasDialog({
  testId,
  titleId,
  title,
  children
}: {
  testId: string;
  titleId: string;
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  const dialogRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!dialogRef.current?.contains(document.activeElement)) {
      dialogRef.current?.focus();
    }
  }, []);
  return (
    <div className="workbench-canvas-dialog-layer" role="presentation" data-testid={testId}>
      <section ref={dialogRef} className="db-modal workbench-canvas-dialog" role="dialog" aria-labelledby={titleId} tabIndex={-1}>
        <strong id={titleId}>{title}</strong>
        {children}
      </section>
    </div>
  );
}

function createInitialProjectPresentation(
  project: Exclude<WorkbenchProjectProjectionState, { status: 'unbound' }> | undefined
): {
  viewportRect: ReturnType<typeof readWorkbenchViewportRect>;
  activeCanvasId: string | undefined;
  floatingPanels: FloatingPanelState;
  textFileBuffers: Record<string, TextFileBuffer>;
  viewStateInvalid: boolean;
} {
  const viewportRect = readWorkbenchViewportRect();
  if (!project) {
    return {
      viewportRect,
      activeCanvasId: undefined,
      floatingPanels: DEFAULT_FLOATING_PANEL_STATE,
      textFileBuffers: {},
      viewStateInvalid: false
    };
  }
  const restoredViewState = restoreProjectViewState({
    storage: window.sessionStorage,
    projectId: project.projectId
  });
  const viewState = restoredViewState.status === 'ready'
    ? restoredViewState.state
    : { floatingPanels: DEFAULT_FLOATING_PANEL_STATE };
  const canvasOrder = project.presentedSnapshot.canvasRegistry.status === 'ready'
    ? project.presentedSnapshot.canvasRegistry.canvasOrder
    : [];
  return {
    viewportRect,
    activeCanvasId: chooseInitialActiveCanvasId({
      storedActiveCanvasId: viewState.activeCanvasId,
      canvasOrder
    }),
    floatingPanels: constrainOpenFloatingPanelsToViewport(
      viewState.floatingPanels,
      viewportRect
    ),
    textFileBuffers: Object.fromEntries(
      Object.values(project.workingCopies.text).map((workingCopy) => [
        workingCopy.projectRelativePath,
        {
          ...workingCopy,
          wordWrap: false,
          dirty: true,
          saving: false,
          externalChange: false
        }
      ])
    ),
    viewStateInvalid: restoredViewState.status === 'invalid'
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
