import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type {
  WorkbenchMenuItem,
  WorkbenchCanvasDocumentMutationResult,
  WorkbenchProjectFileBatchOperationResult,
  WorkbenchProjectPathEntry,
  WorkbenchProjectSessionSnapshot,
  WorkbenchPreferencesView,
  WorkbenchThemePreference,
  WorkbenchTitleBarState
} from '@debrute/app-protocol';
import { unavailableWorkbenchTitleBarState } from '@debrute/app-protocol';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import { createWorkbenchApiClient } from './api/workbenchApiClient';
import { getDebruteShellApi } from '../api/shellApi';
import { CanvasEditor } from './canvas/CanvasEditor';
import { CanvasCardBar } from './canvas/CanvasCardBar';
import { CanvasFeedbackBar } from './canvas/CanvasFeedbackBar';
import type { CanvasImageFeedbackDraftRegion, CanvasImageFeedbackMode } from './canvas/CanvasImageFeedbackLayer';
import { CanvasMinimapBar } from './canvas/CanvasMinimapBar';
import { CanvasResetLayoutButton } from './canvas/CanvasResetLayoutButton';
import { createCanvasOverlayRuntime } from './canvas/CanvasOverlayRuntime';
import type { CanvasEditorRuntime, CanvasRuntimeSnapshot } from './canvas/runtime/CanvasEditorRuntime';
import { createCanvasFeedbackEntryUpdater } from './services/canvasFeedbackUpdates';
import { nextSnapshotFromAppServerEvent } from './services/appServerEvents';
import { getCanvasById } from './services/canvasState';
import { chooseInitialActiveCanvasId } from './canvas/canvasCardBarState';
import {
  currentDebruteWorkbenchRoute,
  loadCanvasFeedback,
  openInitialProject,
  replaceWorkbenchProjectRoute,
  shouldShowInitialProjectLoader,
  type ProjectOpenStartupError
} from './services/projectSessionState';
import { loadProjectViewState, saveProjectViewState } from './services/projectViewState';
import { reconcileWorkbenchViewportLayout } from './services/workbenchViewportLayout';
import {
  closeTextEditorWindowState,
  dragTextEditorWindowState,
  openTextEditorWindowState
} from './services/textEditorWindows';
import { useTextFileBufferActions } from './services/textFileBufferActions';
import { runWorkbenchContextMenuCommand } from './services/workbenchContextMenuCommands';
import { SendToPhotoshopDialog } from './adobe-bridge/SendToPhotoshopDialog';
import { WorkbenchContextMenu } from './shell/WorkbenchContextMenu';
import { WorkbenchTitleBar } from './shell/WorkbenchTitleBar';
import { executeTitleBarMenuCommand } from './shell/workbenchTitleBarCommands';
import {
  buildWorkbenchContextMenuItems,
  cameraCenteredOnNode,
  type WorkbenchContextMenuCommand,
  type WorkbenchFileClipboard,
  type WorkbenchContextMenuPosition,
  type WorkbenchContextMenuTarget
} from './shell/contextMenu';
import { createInlineEditState, validateInlineProjectName, type ProjectTreeInlineEditState } from './project-explorer/projectTreeEditing';
import type { ProjectTreeFileKeyboardCommand } from './project-explorer/projectTreeKeyboardCommands';
import {
  clearCanvasSelectionAfterDeletedPath,
  clearClipboardAfterDeletedPath,
  batchResultSelectionPaths,
  nearestExistingParentSelection,
  permanentDeleteConfirmationMessageForEntries
} from './project-explorer/workbenchFileCommands';
import {
  createEmptyProjectTreeSelection,
  isProjectTreeMoveNoop,
  projectTreeBatchMoveHasConflict,
  projectTreeBasename,
  type ProjectTreeSelectionState
} from './project-explorer/projectTreeInteraction';
import { createProjectTreeExternalDropPlan } from './project-explorer/projectTreeExternalDrop';
import {
  canvasCardBarRect,
  canvasFeedbackBarTargetWithCurrentEntry,
  feedbackBarPlacementForCanvasTarget,
  canvasMinimapButtonRect,
  canvasResetLayoutButtonRect,
  placeCanvasMinimapPanel,
  sameCanvasFeedbackBarTarget,
  type CanvasFeedbackBarTarget,
  type CanvasLocalFeedbackDraft
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
  type FloatingPanelState
} from './shell/floatingPanels';
import { FloatingDock } from './shell/FloatingDock';
import { FloatingPanelContent, WorkbenchFloatingPanelShell } from './shell/FloatingPanel';
import { FloatingTextEditorWindow } from './shell/FloatingTextEditorWindow';
import { NotificationStack } from './shell/NotificationStack';
import { TerminalPanel } from './terminal/TerminalPanel';
import { Button } from './ui';
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
import { I18nProvider, createI18n, parseWorkbenchLocale, type WorkbenchI18n, type WorkbenchLocale } from './i18n';
import {
  DEFAULT_WORKBENCH_PREFERENCES,
  parseWorkbenchThemePreference,
  resolveWorkbenchThemePreference,
  setDocumentTheme,
  subscribeSystemThemeChanges,
  type WorkbenchResolvedTheme
} from './services/workbenchTheme';

const api = createWorkbenchApiClient();

export function WorkbenchApp(): React.ReactElement {
  const initialRoute = useMemo(() => currentDebruteWorkbenchRoute(), []);
  const [snapshot, setSnapshot] = useState<WorkbenchProjectSessionSnapshot>();
  const [daemonProjectId, setDaemonProjectId] = useState<string>();
  const [activeCanvasId, setActiveCanvasId] = useState<string>();
  const [activeCanvasRuntime, setActiveCanvasRuntime] = useState<CanvasEditorRuntime>();
  const [activeCanvasRuntimeSnapshot, setActiveCanvasRuntimeSnapshot] = useState<CanvasRuntimeSnapshot>();
  const [activeCanvasCurrentNodes, setActiveCanvasCurrentNodes] = useState<{
    canvasId: string;
    nodes: ProjectedCanvasNode[];
  }>();
  const [canvasRuntimeScopeKey, setCanvasRuntimeScopeKey] = useState(0);
  const [explorerSelection, setExplorerSelection] = useState<ProjectTreeSelectionState>(() => createEmptyProjectTreeSelection());
  const [floatingPanels, setFloatingPanels] = useState<FloatingPanelState>(DEFAULT_FLOATING_PANEL_STATE);
  const [requestedTerminalCwd, setRequestedTerminalCwd] = useState<string | null>(null);
  const [imageModelSettings, setImageModelSettings] = useState<WorkbenchState['imageModelSettings']>();
  const [videoModelSettings, setVideoModelSettings] = useState<WorkbenchState['videoModelSettings']>();
  const [integrationsSettings, setIntegrationsSettings] = useState<WorkbenchState['integrationsSettings']>();
  const [adobeBridge, setAdobeBridge] = useState<WorkbenchState['adobeBridge']>();
  const [workbenchPreferences, setWorkbenchPreferences] = useState<WorkbenchPreferencesView>();
  const [locale, setLocale] = useState<WorkbenchLocale>('en');
  const [themePreference, setThemePreference] = useState<WorkbenchThemePreference>('system');
  const [resolvedTheme, setResolvedTheme] = useState<WorkbenchResolvedTheme>(() => resolveWorkbenchThemePreference('system'));
  const [canvasFeedback, setCanvasFeedback] = useState<WorkbenchState['canvasFeedback']>();
  const [textFileBuffers, setTextFileBuffers] = useState<Record<string, TextFileBuffer>>({});
  const [textEditorWindows, setTextEditorWindows] = useState<Record<string, FloatingTextEditorWindowState>>({});
  const [windowOrder, setWindowOrder] = useState<WorkbenchWindowOrderState>(DEFAULT_WORKBENCH_WINDOW_ORDER);
  const [feedbackBarTarget, setFeedbackBarTarget] = useState<CanvasFeedbackBarTarget>();
  const [localFeedbackMode, setLocalFeedbackMode] = useState<CanvasImageFeedbackMode>();
  const [pendingFeedbackRegion, setPendingFeedbackRegion] = useState<
    ({ projectRelativePath: string } & CanvasImageFeedbackDraftRegion) | undefined
  >();
  const [pendingFeedbackRegionComment, setPendingFeedbackRegionComment] = useState('');
  const [canvasMinimapOpen, setCanvasMinimapOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    target: WorkbenchContextMenuTarget;
    position: WorkbenchContextMenuPosition;
  }>();
  const [sendToPhotoshopPath, setSendToPhotoshopPath] = useState<string>();
  const [sendingToPhotoshop, setSendingToPhotoshop] = useState(false);
  const [fileClipboard, setFileClipboard] = useState<WorkbenchFileClipboard>();
  const [titleBarState, setTitleBarState] = useState<WorkbenchTitleBarState>();
  const [nativeWindowState, setNativeWindowState] = useState({ maximized: false });
  const [desktopPlatform, setDesktopPlatform] = useState<NodeJS.Platform>();
  const [inlineProjectTreeEdit, setInlineProjectTreeEdit] = useState<ProjectTreeInlineEditState>();
  const [notifications, setNotifications] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(() => shouldShowInitialProjectLoader(initialRoute));
  const [projectOpenAttemptedPath, setProjectOpenAttemptedPath] = useState<string>();
  const [projectOpenError, setProjectOpenError] = useState<string>();
  const [isProjectOpening, setIsProjectOpening] = useState(false);
  const [workbenchViewportRect, setWorkbenchViewportRect] = useState(readWorkbenchViewportRect);
  const canvasOverlayRuntime = useMemo(() => createCanvasOverlayRuntime(), []);
  const workbenchViewportRectRef = useRef(workbenchViewportRect);
  const snapshotRef = useRef(snapshot);
  const textFileBuffersRef = useRef(textFileBuffers);
  const textEditorWindowsRef = useRef(textEditorWindows);
  const feedbackBarClearTimerRef = useRef<number | undefined>(undefined);
  const feedbackBarHoveredRef = useRef(false);
  const i18n = useMemo(() => createI18n(locale), [locale]);
  const localeRef = useRef<WorkbenchLocale>(locale);

  const applyWorkbenchPreferences = useCallback((preferences: WorkbenchPreferencesView) => {
    const nextLocale = parseWorkbenchLocale(preferences.locale);
    const nextThemePreference = parseWorkbenchThemePreference(preferences.themePreference);
    const nextPreferences: WorkbenchPreferencesView = {
      locale: nextLocale,
      themePreference: nextThemePreference
    };
    localeRef.current = nextLocale;
    setWorkbenchPreferences(nextPreferences);
    setLocale(nextLocale);
    setThemePreference(nextThemePreference);
  }, []);

  useEffect(() => {
    localeRef.current = locale;
  }, [locale]);

  useEffect(() => {
    setResolvedTheme(resolveWorkbenchThemePreference(themePreference));
    if (themePreference !== 'system') {
      return;
    }
    return subscribeSystemThemeChanges(setResolvedTheme);
  }, [themePreference]);

  useEffect(() => {
    setDocumentTheme(resolvedTheme);
  }, [resolvedTheme]);

  const notifyCanvasFeedbackUnavailable = useCallback((message: string) => {
    const currentI18n = createI18n(localeRef.current);
    setNotifications((current) => [currentI18n.t('canvas.feedback.unavailable', { message }), ...current].slice(0, 4));
  }, []);

  const refreshTitleBarState = useCallback(async (projectId?: string) => {
    const shell = getDebruteShellApi();
    try {
      const state = shell?.getWorkbenchTitleBarState
        ? await shell.getWorkbenchTitleBarState({ ...(projectId ? { projectId } : {}) })
        : await api.getWorkbenchTitleBarState({
            host: 'web',
            ...(projectId ? { projectId } : {})
          });
      setTitleBarState(state);
    } catch (error) {
      setTitleBarState(unavailableWorkbenchTitleBarState());
      const currentI18n = createI18n(localeRef.current);
      setNotifications((current) => [currentI18n.t('shell.notifications.titleBarStateFailed', { message: errorMessage(error) }), ...current].slice(0, 4));
    }
  }, []);

  const chooseActiveCanvasForProject = useCallback((input: {
    projectId: string;
    snapshot: WorkbenchProjectSessionSnapshot;
  }): string | undefined => {
    const canvasOrder = input.snapshot.canvasRegistry.status === 'ready'
      ? input.snapshot.canvasRegistry.canvasOrder
      : [];
    const viewState = loadProjectViewState({
      storage: sessionProjectViewStorage(),
      projectId: input.projectId,
      clientId: api.clientId
    });
    return chooseInitialActiveCanvasId({
      storedActiveCanvasId: viewState.activeCanvasId,
      canvasOrder
    });
  }, []);

  const loadFloatingPanelsForProject = useCallback((projectId: string): FloatingPanelState => {
    return constrainOpenFloatingPanelsToViewport(loadProjectViewState({
      storage: sessionProjectViewStorage(),
      projectId,
      clientId: api.clientId
    }).floatingPanels ?? DEFAULT_FLOATING_PANEL_STATE, workbenchViewportRectRef.current);
  }, []);

  const applyOpenedProject = useCallback(async (opened: { projectId: string; snapshot: WorkbenchProjectSessionSnapshot }) => {
    replaceWorkbenchProjectRoute(opened.projectId, { search: '', hash: '' });
    setSnapshot(opened.snapshot);
    setDaemonProjectId(opened.projectId);
    setFloatingPanels(loadFloatingPanelsForProject(opened.projectId));
    setActiveCanvasId(chooseActiveCanvasForProject({ projectId: opened.projectId, snapshot: opened.snapshot }));
    setActiveCanvasRuntime(undefined);
    setCanvasRuntimeScopeKey((current) => current + 1);
    setExplorerSelection(createEmptyProjectTreeSelection());
    setFileClipboard(undefined);
    setInlineProjectTreeEdit(undefined);
    setTextFileBuffers({});
    setTextEditorWindows({});
    setWindowOrder(DEFAULT_WORKBENCH_WINDOW_ORDER);
    setFeedbackBarTarget(undefined);
    setCanvasMinimapOpen(false);
    setProjectOpenAttemptedPath(undefined);
    setProjectOpenError(undefined);
    setImageModelSettings(await api.imageModelGetSettings());
    setVideoModelSettings(await api.videoModelGetSettings());
    setIntegrationsSettings(await api.integrationsListStatus());
    setAdobeBridge(await api.adobeBridgeGetState());
    await loadCanvasFeedback(api, setCanvasFeedback, notifyCanvasFeedbackUnavailable);
    await refreshTitleBarState(opened.projectId);
    const currentI18n = createI18n(localeRef.current);
    setNotifications((current) => [currentI18n.t('shell.notifications.projectOpened', { name: opened.snapshot.metadata.project.name }), ...current].slice(0, 4));
  }, [chooseActiveCanvasForProject, loadFloatingPanelsForProject, notifyCanvasFeedbackUnavailable, refreshTitleBarState]);

  useEffect(() => {
    workbenchViewportRectRef.current = workbenchViewportRect;
  }, [workbenchViewportRect]);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

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
    if (feedbackBarClearTimerRef.current !== undefined) {
      window.clearTimeout(feedbackBarClearTimerRef.current);
    }
  }, []);

  useEffect(() => () => {
    canvasOverlayRuntime.dispose();
  }, [canvasOverlayRuntime]);

  useEffect(() => {
    let disposed = false;
    void api.integrationsListStatus().then((settings) => {
      if (!disposed) {
        setIntegrationsSettings(settings);
      }
    });
    void api.adobeBridgeGetState().then((state) => {
      if (!disposed) {
        setAdobeBridge(state);
      }
    });
    void api.getDesktopPlatform().then((platform) => {
      if (!disposed) {
        setDesktopPlatform(platform);
      }
    }).catch((error) => {
      if (!disposed) {
        const currentI18n = createI18n(localeRef.current);
        setNotifications((current) => [currentI18n.t('shell.notifications.desktopPlatformFailed', { message: errorMessage(error) }), ...current].slice(0, 4));
      }
    });
    void (async () => {
      try {
        const preferences = await api.workbenchPreferencesGet();
        if (disposed) {
          return;
        }
        applyWorkbenchPreferences(preferences);
      } catch (error) {
        if (disposed) {
          return;
        }
        const englishI18n = createI18n('en');
        applyWorkbenchPreferences(DEFAULT_WORKBENCH_PREFERENCES);
        setNotifications((current) => [
          englishI18n.t('shell.notifications.languagePreferenceLoadFailed', { message: errorMessage(error) }),
          ...current
        ].slice(0, 4));
      }

      try {
        const result = await openInitialProject(api, initialRoute);
        if (disposed) {
          return;
        }
        setProjectOpenAttemptedPath(result.projectOpen?.attemptedPath);
        setProjectOpenError(localizedProjectOpenError(result.projectOpen?.error, createI18n(localeRef.current)));
        const { projectId: routeProjectId, snapshot: opened } = result;
        if (!opened || !routeProjectId) {
          return;
        }
        await applyOpenedProject({ projectId: routeProjectId, snapshot: opened });
      } catch (error) {
        if (!disposed) {
          const currentI18n = createI18n(localeRef.current);
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
  }, [applyOpenedProject, applyWorkbenchPreferences, initialRoute]);

  useEffect(() => {
    void refreshTitleBarState(daemonProjectId);
  }, [daemonProjectId, refreshTitleBarState]);

  useEffect(() => {
    const shell = getDebruteShellApi();
    void shell?.getNativeWindowState?.().then((state) => {
      setNativeWindowState(state);
      reconcileCurrentWorkbenchViewportLayout();
    }).catch(() => undefined);
    return shell?.onNativeWindowStateChanged?.((state) => {
      setNativeWindowState(state);
      reconcileCurrentWorkbenchViewportLayout();
    });
  }, [reconcileCurrentWorkbenchViewportLayout]);

  useEffect(() => {
    if (!daemonProjectId || !activeCanvasId) {
      return;
    }
    const current = loadProjectViewState({
      storage: sessionProjectViewStorage(),
      projectId: daemonProjectId,
      clientId: api.clientId
    });
    saveProjectViewState({
      storage: sessionProjectViewStorage(),
      projectId: daemonProjectId,
      clientId: api.clientId,
      state: {
        ...current,
        activeCanvasId
      }
    });
  }, [activeCanvasId, daemonProjectId]);

  useEffect(() => {
    if (!daemonProjectId) {
      return;
    }
    const current = loadProjectViewState({
      storage: sessionProjectViewStorage(),
      projectId: daemonProjectId,
      clientId: api.clientId
    });
    saveProjectViewState({
      storage: sessionProjectViewStorage(),
      projectId: daemonProjectId,
      clientId: api.clientId,
      state: {
        ...current,
        floatingPanels
      }
    });
  }, [daemonProjectId, floatingPanels]);

  const readProjectTextFile = useCallback((projectRelativePath: string) => api.readProjectTextFile(projectRelativePath), []);
  const writeProjectTextFile = useCallback((projectRelativePath: string, content: string) => api.writeProjectTextFile(projectRelativePath, content), []);
  const lookupGeneratedAssetMetadata = useCallback<WorkbenchActions['lookupGeneratedAssetMetadata']>((input) => api.lookupGeneratedAssetMetadata(input), []);
  const readGeneratedAsset = useCallback<WorkbenchActions['readGeneratedAsset']>((assetId) => api.readGeneratedAsset(assetId), []);

  const {
    ensureTextFileBuffer,
    updateTextFileBuffer,
    saveTextFileBuffer,
    reloadTextFileBuffer,
    refreshTextFileBuffer
  } = useTextFileBufferActions({
    api,
    textFileBuffers,
    setTextFileBuffers,
    textFileBuffersRef,
    textEditorWindowsRef
  });

  useEffect(() => {
    return api.onEvent((event) => {
      setSnapshot((current) => nextSnapshotFromAppServerEvent(event, current));
      if ('projectId' in event) {
        setDaemonProjectId(event.projectId);
      }
      if (event.type === 'project.opened') {
        setFloatingPanels(loadFloatingPanelsForProject(event.projectId));
        setActiveCanvasId(chooseActiveCanvasForProject({ projectId: event.projectId, snapshot: event.snapshot }));
        setExplorerSelection(createEmptyProjectTreeSelection());
        setContextMenu(undefined);
        setFileClipboard(undefined);
        setInlineProjectTreeEdit(undefined);
        setActiveCanvasRuntime(undefined);
        setCanvasRuntimeScopeKey((current) => current + 1);
        setCanvasMinimapOpen(false);
        void loadCanvasFeedback(api, setCanvasFeedback, notifyCanvasFeedbackUnavailable);
      }
      if (event.type === 'workbench.preferences.changed') {
        applyWorkbenchPreferences(event.preferences);
      }
      if (event.type === 'project.fileChanged') {
        void refreshTextFileBuffer(event.event.projectRelativePath);
        if (event.event.projectRelativePath === '.debrute/reviews/canvas-feedback.json') {
          void loadCanvasFeedback(api, setCanvasFeedback, notifyCanvasFeedbackUnavailable);
        }
      }
      if (event.type === 'canvas.feedback.changed') {
        setCanvasFeedback(event.feedback);
      }
      if (event.type === 'imageModel.settings.changed') {
        setImageModelSettings(event.settings);
      }
      if (event.type === 'videoModel.settings.changed') {
        setVideoModelSettings(event.settings);
      }
      if (event.type === 'integrations.settings.changed') {
        setIntegrationsSettings(event.settings);
      }
      if (event.type === 'adobeBridge.settings.changed') {
        setAdobeBridge((current) => current ? { ...current, settings: event.settings } : current);
      }
      if (event.type === 'adobeBridge.state.changed') {
        setAdobeBridge(event.state);
      }
    });
  }, [applyWorkbenchPreferences, chooseActiveCanvasForProject, loadFloatingPanelsForProject, notifyCanvasFeedbackUnavailable, refreshTextFileBuffer]);

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

  const updateCanvasFeedbackEntry = useMemo(() => createCanvasFeedbackEntryUpdater({
    requestUpdate: async (input) => (await api.updateCanvasFeedbackEntry(input)).feedback,
    applyFeedback: setCanvasFeedback,
    notifyUnavailable: (message) => {
      notifyCanvasFeedbackUnavailable(message);
    }
  }), [notifyCanvasFeedbackUnavailable]);

  const clearFeedbackBarHideTimer = useCallback(() => {
    if (feedbackBarClearTimerRef.current !== undefined) {
      window.clearTimeout(feedbackBarClearTimerRef.current);
      feedbackBarClearTimerRef.current = undefined;
    }
  }, []);

  const clearFeedbackBarTarget = useCallback(() => {
    canvasOverlayRuntime.clearFeedbackBarPlacement();
    setFeedbackBarTarget(undefined);
  }, [canvasOverlayRuntime]);

  const handleFeedbackBarTargetChange = useCallback((target: CanvasFeedbackBarTarget | undefined) => {
    clearFeedbackBarHideTimer();
    if (target) {
      setFeedbackBarTarget((current) => (
        sameCanvasFeedbackBarTarget(current, target) ? current : target
      ));
      return;
    }
    feedbackBarClearTimerRef.current = window.setTimeout(() => {
      feedbackBarClearTimerRef.current = undefined;
      if (!feedbackBarHoveredRef.current) {
        clearFeedbackBarTarget();
      }
    }, 120);
  }, [clearFeedbackBarHideTimer, clearFeedbackBarTarget]);

  const handleFeedbackBarPointerEnter = useCallback(() => {
    feedbackBarHoveredRef.current = true;
    clearFeedbackBarHideTimer();
  }, [clearFeedbackBarHideTimer]);

  const handleFeedbackBarPointerLeave = useCallback(() => {
    feedbackBarHoveredRef.current = false;
    clearFeedbackBarHideTimer();
    clearFeedbackBarTarget();
  }, [clearFeedbackBarHideTimer, clearFeedbackBarTarget]);

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

  const activeCanvas = getCanvasById(snapshot, activeCanvasId);
  const activeProjection = activeCanvas
    ? snapshot?.projections.find((item) => item.canvasId === activeCanvas.id)
    : undefined;
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
  const effectiveTitleBarState = titleBarState ?? unavailableWorkbenchTitleBarState();

  const state: WorkbenchState = {
    snapshot,
    projectId: daemonProjectId,
    titleBarState: effectiveTitleBarState,
    workbenchPreferences,
    resolvedTheme,
    projectOpen: {
      ...(projectOpenAttemptedPath ? { attemptedPath: projectOpenAttemptedPath } : {}),
      ...(projectOpenError ? { error: projectOpenError } : {}),
      opening: isProjectOpening
    },
    explorerSelection,
    imageModelSettings,
    videoModelSettings,
    integrationsSettings,
    adobeBridge,
    canvasFeedback,
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
    getProductState: () => api.getProductState(),
    checkProductUpdate: () => api.checkProductUpdate(),
    applyProductUpdate: () => api.applyProductUpdate(),
    saveWorkbenchPreferences: async (input) => {
      const previousPreferences = workbenchPreferences ?? DEFAULT_WORKBENCH_PREFERENCES;
      const nextPreferences: WorkbenchPreferencesView = {
        locale: parseWorkbenchLocale(input.locale),
        themePreference: parseWorkbenchThemePreference(input.themePreference)
      };
      applyWorkbenchPreferences(nextPreferences);
      try {
        const preferences = await api.workbenchPreferencesSave(nextPreferences);
        applyWorkbenchPreferences(preferences);
      } catch (error) {
        applyWorkbenchPreferences(previousPreferences);
        throw error;
      }
    },
    openProject: async () => {
      setIsProjectOpening(true);
      setProjectOpenError(undefined);
      setProjectOpenAttemptedPath(undefined);
      try {
        const result = await api.openProjectFromPicker();
        if (!result.opened) {
          return;
        }
        await applyOpenedProject(result);
      } catch (error) {
        setProjectOpenError(i18n.t('projectOpen.openFailed', { message: errorMessage(error) }));
      } finally {
        setIsProjectOpening(false);
      }
    },
    saveImageModelSetting: async (modelId, input) => {
      const imageModels = await api.imageModelSaveSetting(modelId, input);
      setImageModelSettings(imageModels);
    },
    saveVideoModelSetting: async (modelId, input) => {
      const videoModels = await api.videoModelSaveSetting(modelId, input);
      setVideoModelSettings(videoModels);
    },
    rescanIntegrations: async () => {
      const settings = await api.integrationsRescan();
      setIntegrationsSettings(settings);
      return settings;
    },
    saveAdobeBridgeSettings: async (input) => {
      setAdobeBridge(await api.adobeBridgeSaveSettings(input));
    },
    linkAdobeBridgePhotoshop: async (input) => {
      setAdobeBridge(await api.adobeBridgeLinkPhotoshop(input));
    },
    unlinkAdobeBridgePhotoshop: async (adobeClientId) => {
      setAdobeBridge(await api.adobeBridgeUnlinkPhotoshop(adobeClientId));
    },
    sendProjectFileToPhotoshop: async (input) => {
      const result = await api.sendProjectFileToPhotoshop(input);
      setNotifications((current) => [i18n.t('shell.notifications.sentToPhotoshop', { path: input.projectRelativePath }), ...current].slice(0, 4));
      return result;
    },
    openSendToPhotoshopPicker: (projectRelativePath) => {
      setSendToPhotoshopPath(projectRelativePath);
    },
    lookupGeneratedAssetMetadata,
    readGeneratedAsset,
    readProjectTextFile,
    writeProjectTextFile,
    saveCanvasTextPreviewSource: (input) => api.saveCanvasTextPreviewSource(input),
    readCanvasTextPreviewDescriptors: (input) => api.readCanvasTextPreviewDescriptors(input),
    reconcileCanvasTextPreviews: (input) => api.reconcileCanvasTextPreviews(input),
    createProjectFile: async (input) => {
      const result = await api.createProjectFile(input);
      setSnapshot(result.snapshot);
      setExplorerSelection(projectTreeSelectionFromPaths([result.projectRelativePath]));
      return result;
    },
    createProjectDirectory: async (input) => {
      const result = await api.createProjectDirectory(input);
      setSnapshot(result.snapshot);
      setExplorerSelection(projectTreeSelectionFromPaths([result.projectRelativePath]));
      return result;
    },
    renameProjectPath: async (input) => {
      const result = await api.renameProjectPath(input);
      setSnapshot(result.snapshot);
      setExplorerSelection(projectTreeSelectionFromPaths([result.projectRelativePath]));
      return result;
    },
    copyProjectPaths: async (input) => {
      const result = await api.copyProjectPaths(input);
      setSnapshot(result.snapshot);
      const selectedPaths = batchResultSelectionPaths(result.results);
      setExplorerSelection(projectTreeSelectionFromPaths(selectedPaths));
      locateSingleFileBatchResult(result.results, locateProjectFileInCanvas);
      return result;
    },
    moveProjectPaths: async (input) => {
      const result = await api.moveProjectPaths(input);
      setSnapshot(result.snapshot);
      const selectedPaths = batchResultSelectionPaths(result.results);
      setExplorerSelection(projectTreeSelectionFromPaths(selectedPaths));
      locateSingleFileBatchResult(result.results, locateProjectFileInCanvas);
      return result;
    },
    copyProjectAbsolutePaths: (input) => api.copyProjectAbsolutePaths(input),
    trashProjectPaths: async (input) => {
      const result = await api.trashProjectPaths(input);
      setSnapshot(result.snapshot);
      applyDeletedProjectEntries({
        entries: input.entries,
        snapshot: result.snapshot,
        activeCanvasRuntime,
        setExplorerSelection,
        setFileClipboard
      });
      return result;
    },
    deleteProjectPathsPermanently: async (input) => {
      const result = await api.deleteProjectPathsPermanently(input);
      setSnapshot(result.snapshot);
      applyDeletedProjectEntries({
        entries: input.entries,
        snapshot: result.snapshot,
        activeCanvasRuntime,
        setExplorerSelection,
        setFileClipboard
      });
      return result;
    },
    revealProjectPathInSystemFileManager: (input) => api.revealProjectPathInSystemFileManager(input),
    ensureTextFileBuffer,
    updateTextFileBuffer,
    saveTextFileBuffer,
    reloadTextFileBuffer,
    openTextEditorWindow,
    toggleTextFileWordWrap,
    updateCanvasNodeLayouts: async (canvasId, input) => {
      try {
        const result = await api.updateCanvasNodeLayouts({
          canvasId,
          ...input
        });
        const current = snapshotRef.current;
        if (!current) {
          throw new Error(`Cannot apply Canvas document ${result.canvas.id} without a current snapshot.`);
        }
        const next = replaceCanvasMutationInSnapshot(current, result);
        snapshotRef.current = next;
        setSnapshot(next);
      } catch (error) {
        setNotifications((current) => [i18n.t('shell.notifications.updateCanvasLayoutFailed', { message: errorMessage(error) }), ...current].slice(0, 4));
        throw error;
      }
    },
    resetCanvasNodeLayouts: async (canvasId, input) => {
      const result = await api.resetCanvasNodeLayouts({
        canvasId,
        ...input
      });
      const current = snapshotRef.current;
      if (!current) {
        throw new Error(`Cannot apply Canvas document ${result.canvas.id} without a current snapshot.`);
      }
      const next = replaceCanvasMutationInSnapshot(current, result);
      snapshotRef.current = next;
      setSnapshot(next);
      return result;
    },
    updateCanvasNodeLayers: async (canvasId, input) => {
      const result = await api.updateCanvasNodeLayers({
        canvasId,
        ...input
      });
      const current = snapshotRef.current;
      if (!current) {
        throw new Error(`Cannot apply Canvas document ${result.canvas.id} without a current snapshot.`);
      }
      const next = replaceCanvasMutationInSnapshot(current, result);
      snapshotRef.current = next;
      setSnapshot(next);
    },
    updateCanvasFeedbackEntry,
    addProjectPathToCanvasMap: async (input) => {
      try {
        const result = await api.addProjectPathToCanvasMap(input);
        setSnapshot(result.snapshot);
        setActiveCanvasId(result.canvas.id);
        setExplorerSelection(projectTreeSelectionFromPaths([result.centerProjectRelativePath]));
        centerCanvasProjectionNode(result.projection, result.centerProjectRelativePath);
      } catch (error) {
        setNotifications((current) => [i18n.t('shell.notifications.addToCanvasMapFailed', { message: errorMessage(error) }), ...current].slice(0, 4));
      }
    },
    createCanvas: async () => {
      const result = await api.createCanvas();
      setSnapshot(result.snapshot);
      setActiveCanvasId(result.activeCanvasId);
      return result;
    },
    renameCanvas: async (input) => {
      const result = await api.renameCanvas(input);
      setSnapshot(result.snapshot);
      return result;
    },
    deleteCanvas: async (input) => {
      const result = await api.deleteCanvas(input);
      setSnapshot(result.snapshot);
      if (activeCanvasId === input.canvasId) {
        setActiveCanvasId(result.activeCanvasId);
      }
      return result;
    },
    reorderCanvases: async (input) => {
      const result = await api.reorderCanvases(input);
      setSnapshot(result.snapshot);
      return result;
    },
    repairCanvasIndex: async () => {
      const result = await api.repairCanvasIndex();
      setSnapshot(result.snapshot);
      const repairedOrder = result.snapshot.canvasRegistry.status === 'ready'
        ? result.snapshot.canvasRegistry.canvasOrder
        : [];
      const repairedActiveCanvasId = activeCanvasId && repairedOrder.includes(activeCanvasId)
        ? activeCanvasId
        : result.activeCanvasId ?? repairedOrder[0];
      setActiveCanvasId(repairedActiveCanvasId);
      return result;
    },
    openTerminalPanel
  }), [
    activeCanvasId,
    activeCanvasRuntime,
    applyWorkbenchPreferences,
    applyOpenedProject,
    centerCanvasProjectionNode,
    locateProjectFileInCanvas,
    chooseActiveCanvasForProject,
    ensureTextFileBuffer,
    i18n,
    loadFloatingPanelsForProject,
    lookupGeneratedAssetMetadata,
    openTerminalPanel,
    openTextEditorWindow,
    readGeneratedAsset,
    readProjectTextFile,
    reloadTextFileBuffer,
    saveTextFileBuffer,
    snapshot,
    toggleTextFileWordWrap,
    updateCanvasFeedbackEntry,
    updateTextFileBuffer,
    workbenchPreferences,
    writeProjectTextFile
  ]);

  const handleLocalFeedbackModeChange = useCallback((mode: CanvasImageFeedbackMode) => {
    setLocalFeedbackMode(mode);
    setPendingFeedbackRegion(undefined);
    setPendingFeedbackRegionComment('');
  }, []);

  const handleLocalFeedbackDraft = useCallback((draft: CanvasLocalFeedbackDraft) => {
    clearFeedbackBarHideTimer();
    setFeedbackBarTarget(draft.feedbackBarTarget);
    setPendingFeedbackRegion({
      projectRelativePath: draft.projectRelativePath,
      geometry: draft.geometry,
      label: canvasFeedback?.entries[draft.projectRelativePath]?.nextRegionLabel ?? 1
    });
    setPendingFeedbackRegionComment('');
  }, [canvasFeedback, clearFeedbackBarHideTimer]);

  const cancelPendingFeedbackRegion = useCallback(() => {
    setPendingFeedbackRegion(undefined);
    setPendingFeedbackRegionComment('');
  }, []);

  const savePendingFeedbackRegion = useCallback(async () => {
    if (!pendingFeedbackRegion || !localFeedbackMode) {
      return;
    }
    const comment = pendingFeedbackRegionComment.trim();
    if (!comment) {
      return;
    }
    const saved = await updateCanvasFeedbackEntry({
      operation: 'add-region',
      projectRelativePath: pendingFeedbackRegion.projectRelativePath,
      region: {
        kind: localFeedbackMode === 'pin' ? 'pin' : 'region',
        geometry: pendingFeedbackRegion.geometry,
        comment
      }
    });
    if (!saved) {
      return;
    }
    setPendingFeedbackRegion(undefined);
    setPendingFeedbackRegionComment('');
  }, [localFeedbackMode, pendingFeedbackRegion, pendingFeedbackRegionComment, updateCanvasFeedbackEntry]);

  const updateInlineProjectTreeEditValue = useCallback((value: string) => {
    setInlineProjectTreeEdit((current) => current ? { ...current, value } : current);
  }, []);

  const submitInlineProjectTreeEdit = useCallback(async () => {
    const current = inlineProjectTreeEdit;
    if (!current || current.submitting) {
      return;
    }
    const validation = validateInlineProjectName(current.value);
    if (!validation.ok) {
      setInlineProjectTreeEdit({
        ...current,
        error: i18n.t(validation.message === 'required' ? 'explorer.nameRequired' : 'explorer.namePathSeparators')
      });
      return;
    }
    const { error: _error, ...submittingEdit } = current;
    setInlineProjectTreeEdit({ ...submittingEdit, submitting: true });
    try {
      if (current.kind === 'renaming') {
        await actions.renameProjectPath({
          projectRelativePath: current.projectRelativePath,
          name: validation.name
        });
      } else if (current.kind === 'creating-file') {
        await actions.createProjectFile({
          parentProjectRelativePath: current.parentProjectRelativePath,
          name: validation.name
        });
      } else {
        await actions.createProjectDirectory({
          parentProjectRelativePath: current.parentProjectRelativePath,
          name: validation.name
        });
      }
      setInlineProjectTreeEdit(undefined);
    } catch (error) {
      setInlineProjectTreeEdit({ ...current, submitting: false, error: errorMessage(error) });
    }
  }, [actions, i18n, inlineProjectTreeEdit]);

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
  const notify = useCallback((message: string) => {
    setNotifications((current) => [message, ...current].slice(0, 4));
  }, []);
  const handleTitleBarCommand = useCallback((item: Extract<WorkbenchMenuItem, { kind: 'command' }>) => {
    void executeTitleBarMenuCommand(item, {
      api,
      shell: getDebruteShellApi(),
      notify,
      openProjectFromPicker: actions.openProject,
      openProjectRoot: async (projectRoot) => {
        setIsProjectOpening(true);
        setProjectOpenError(undefined);
        setProjectOpenAttemptedPath(projectRoot);
        try {
          await applyOpenedProject(await api.openProject({ projectRoot }));
        } finally {
          setIsProjectOpening(false);
        }
      },
      refreshTitleBarState: () => refreshTitleBarState(daemonProjectId),
      commandUnavailableMessage: (label) => i18n.t('shell.notifications.commandUnavailable', { command: label })
    }).catch((error) => notify(i18n.t('shell.notifications.menuCommandFailed', { message: errorMessage(error) })));
  }, [actions.openProject, applyOpenedProject, daemonProjectId, i18n, notify, refreshTitleBarState]);
  const handleTitleBarWindowCommand = useCallback((command: 'minimize' | 'toggle-maximize' | 'close') => {
    const shell = getDebruteShellApi();
    const promise = command === 'minimize'
      ? shell?.minimizeNativeWindow?.()
      : command === 'toggle-maximize'
        ? shell?.toggleMaximizeNativeWindow?.()
        : shell?.closeNativeWindow?.();
    void Promise.resolve(promise).then((state) => {
      if (state && 'maximized' in state) {
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
  const currentFeedbackBarTarget = useMemo(() => (
    feedbackBarTarget ? canvasFeedbackBarTargetWithCurrentEntry(feedbackBarTarget, canvasFeedback) : undefined
  ), [canvasFeedback, feedbackBarTarget]);
  useEffect(() => {
    if (!activeCanvasRuntime || !currentFeedbackBarTarget) {
      return;
    }
    const syncFeedbackBarPlacement = (camera: CanvasRuntimeSnapshot['camera']) => {
      const placement = feedbackBarPlacementForCanvasTarget({
        target: currentFeedbackBarTarget,
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
    currentFeedbackBarTarget,
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
  const contextMenuItems = useMemo(() => contextMenu
      ? buildWorkbenchContextMenuItems({
          target: contextMenu.target,
          projection: activeProjection,
          canSelectCanvasNode: Boolean(activeCanvasRuntime),
          canRevealInCanvas,
          fileClipboard,
          desktopPlatform,
          adobeBridgeEnabled: adobeBridge?.settings.enabled === true
        })
    : [], [activeCanvasRuntime, activeProjection, adobeBridge?.settings.enabled, canRevealInCanvas, contextMenu, desktopPlatform, fileClipboard]);
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
    entries: WorkbenchProjectPathEntry[];
    targetDirectoryProjectRelativePath: string;
  }) => (
    window.confirm(i18n.t('shell.confirm.moveOverwrite', {
      target: input.targetDirectoryProjectRelativePath || i18n.t('shell.confirm.projectRoot')
    }))
  ), [i18n]);
  const contextMenuCommandErrorLabels = useMemo(() => ({
    copyPathFailed: i18n.t('shell.notifications.copyPathFailed'),
    revealFailed: i18n.t('shell.notifications.revealFailed'),
    deleteFailed: i18n.t('shell.notifications.deleteFailed'),
    pasteFailed: i18n.t('shell.notifications.pasteFailed'),
    resetAutoLayoutFailed: i18n.t('shell.notifications.resetAutoLayoutFailed')
  }), [i18n]);
  const handleWorkbenchContextMenuCommand = useCallback((command: WorkbenchContextMenuCommand) => {
    runWorkbenchContextMenuCommand({
      command,
      contextMenu,
      activeProjection,
      activeCanvasRuntime,
      fileClipboard,
      actions,
      setInlineProjectTreeEdit,
      setFileClipboard,
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
    contextMenu,
    copyProjectRelativePath,
    confirmPermanentDelete,
    fileClipboard,
    notify,
    openInspectorPanel,
    snapshot
  ]);
  const handleProjectTreeKeyboardFileCommand = useCallback((command: ProjectTreeFileKeyboardCommand, target: WorkbenchContextMenuTarget) => {
    runWorkbenchContextMenuCommand({
      command,
      contextMenu: {
        target,
        position: { x: 0, y: 0 }
      },
      activeProjection,
      activeCanvasRuntime,
      fileClipboard,
      actions,
      setInlineProjectTreeEdit,
      setFileClipboard,
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
    confirmPermanentDelete,
    copyProjectRelativePath,
    fileClipboard,
    notify,
    openInspectorPanel,
    snapshot
  ]);
  const handleProjectTreeInternalDrop = useCallback((input: {
    entries: WorkbenchProjectPathEntry[];
    targetDirectoryProjectRelativePath: string;
    operation: 'copy' | 'move';
  }) => {
    if (input.operation === 'copy') {
      void actions.copyProjectPaths({
        entries: input.entries,
        targetDirectoryProjectRelativePath: input.targetDirectoryProjectRelativePath
      }).catch((error) => notify(i18n.t('shell.notifications.copyFailed', { message: errorMessage(error) })));
      return;
    }
    if (isProjectTreeMoveNoop({
      entries: input.entries,
      targetDirectoryProjectRelativePath: input.targetDirectoryProjectRelativePath
    })) {
      return;
    }
    const overwrite = projectTreeBatchMoveHasConflict({
      existingProjectRelativePaths: new Set(snapshot?.files.map((file) => file.projectRelativePath) ?? []),
      entries: input.entries,
      targetDirectoryProjectRelativePath: input.targetDirectoryProjectRelativePath
    });
    const target = input.targetDirectoryProjectRelativePath || i18n.t('shell.confirm.projectRoot');
    const confirmed = window.confirm(overwrite
      ? i18n.t('shell.confirm.moveOverwrite', { target })
      : i18n.t('shell.confirm.moveItems', { count: input.entries.length, target }));
    if (!confirmed) {
      return;
    }
    void actions.moveProjectPaths({
      entries: input.entries,
      targetDirectoryProjectRelativePath: input.targetDirectoryProjectRelativePath,
      ...(overwrite ? { overwrite: true } : {})
    }).catch((error) => notify(i18n.t('shell.notifications.moveFailed', { message: errorMessage(error) })));
  }, [actions, i18n, notify, snapshot]);
  const handleProjectTreeExternalDrop = useCallback((input: {
    dataTransfer: DataTransfer;
    targetDirectoryProjectRelativePath: string;
  }) => {
    void createProjectTreeExternalDropPlan({
      dataTransfer: input.dataTransfer,
      shell: getDebruteShellApi(),
      targetDirectoryProjectRelativePath: input.targetDirectoryProjectRelativePath
    }).then(async (plan) => {
      const overwrite = externalDropPlanHasConflict({
        snapshot,
        localPaths: plan.localPaths,
        uploads: plan.uploads,
        targetDirectoryProjectRelativePath: plan.targetDirectoryProjectRelativePath
      });
      if (overwrite && !window.confirm(i18n.t('shell.confirm.moveOverwrite', {
        target: plan.targetDirectoryProjectRelativePath || i18n.t('shell.confirm.projectRoot')
      }))) {
        return;
      }
      if (plan.localPaths.length > 0) {
        const result = await api.importExternalLocalProjectPaths({
          sources: plan.localPaths,
          targetDirectoryProjectRelativePath: plan.targetDirectoryProjectRelativePath,
          ...(overwrite ? { overwrite: true } : {})
        });
        setSnapshot(result.snapshot);
        const selectedPaths = batchResultSelectionPaths(result.results);
        setExplorerSelection(projectTreeSelectionFromPaths(selectedPaths));
        locateSingleFileBatchResult(result.results, locateProjectFileInCanvas);
        return;
      }
      const result = await api.importExternalProjectUploads({
        entries: plan.uploads.map((upload) => (
          upload.kind === 'file'
            ? { kind: 'file', projectRelativePath: upload.projectRelativePath, file: upload.file }
            : upload
        )),
        targetDirectoryProjectRelativePath: plan.targetDirectoryProjectRelativePath,
        ...(overwrite ? { overwrite: true } : {})
      });
      setSnapshot(result.snapshot);
      const selectedPaths = batchResultSelectionPaths(result.results);
      setExplorerSelection(projectTreeSelectionFromPaths(selectedPaths));
      locateSingleFileBatchResult(result.results, locateProjectFileInCanvas);
    }).catch((error) => notify(i18n.t('shell.notifications.importFailed', { message: errorMessage(error) })));
  }, [i18n, locateProjectFileInCanvas, notify, snapshot]);
  if (isLoading) {
    return (
      <I18nProvider locale={locale}>
        <div className="workbench-shell" data-theme={resolvedTheme} data-testid="workbench-shell">
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
      </I18nProvider>
    );
  }

  return (
    <I18nProvider locale={locale}>
      <div className="workbench-shell" data-theme={resolvedTheme} data-testid="workbench-shell">
      <WorkbenchTitleBar
        state={effectiveTitleBarState}
        nativeWindowState={nativeWindowState}
        onCommand={handleTitleBarCommand}
        onWindowCommand={handleTitleBarWindowCommand}
      />
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
            onFeedbackBarTargetChange={handleFeedbackBarTargetChange}
            onRuntimeChange={setActiveCanvasRuntime}
            onOpenContextMenu={openWorkbenchContextMenu}
            localFeedbackMode={localFeedbackMode}
            pendingFeedbackRegion={pendingFeedbackRegion}
            onLocalFeedbackDraft={handleLocalFeedbackDraft}
          />
        )}
      </div>
      <div className="floating-bar-layer" data-testid="floating-bar-layer">
        <FloatingDock
          panelState={floatingPanels}
          onToggle={(panelId) => {
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
        {currentFeedbackBarTarget ? (
          <CanvasFeedbackBar
            projectRelativePath={currentFeedbackBarTarget.projectRelativePath}
            entry={currentFeedbackBarTarget.entry}
            onUpdate={actions.updateCanvasFeedbackEntry}
            overlayRuntime={canvasOverlayRuntime}
            localFeedbackMode={currentFeedbackBarTarget.supportsImageLocalFeedback ? localFeedbackMode : undefined}
            onLocalFeedbackModeChange={currentFeedbackBarTarget.supportsImageLocalFeedback ? handleLocalFeedbackModeChange : undefined}
            pendingRegionComment={
              currentFeedbackBarTarget.supportsImageLocalFeedback && pendingFeedbackRegion?.projectRelativePath === currentFeedbackBarTarget.projectRelativePath
                ? pendingFeedbackRegionComment
                : undefined
            }
            pendingRegionLabel={
              currentFeedbackBarTarget.supportsImageLocalFeedback && pendingFeedbackRegion?.projectRelativePath === currentFeedbackBarTarget.projectRelativePath
                ? pendingFeedbackRegion.label
                : undefined
            }
            onPendingRegionCommentChange={
              currentFeedbackBarTarget.supportsImageLocalFeedback && pendingFeedbackRegion?.projectRelativePath === currentFeedbackBarTarget.projectRelativePath
                ? setPendingFeedbackRegionComment
                : undefined
            }
            onSavePendingRegion={
              currentFeedbackBarTarget.supportsImageLocalFeedback && pendingFeedbackRegion?.projectRelativePath === currentFeedbackBarTarget.projectRelativePath
                ? () => { void savePendingFeedbackRegion(); }
                : undefined
            }
            onCancelPendingRegion={
              currentFeedbackBarTarget.supportsImageLocalFeedback && pendingFeedbackRegion?.projectRelativePath === currentFeedbackBarTarget.projectRelativePath
                ? cancelPendingFeedbackRegion
                : undefined
            }
            onPointerEnter={handleFeedbackBarPointerEnter}
            onPointerLeave={handleFeedbackBarPointerLeave}
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
                onEditValueChange={updateInlineProjectTreeEditValue}
                onEditSubmit={() => void submitInlineProjectTreeEdit()}
                onEditCancel={() => setInlineProjectTreeEdit(undefined)}
                onClearCut={() => setFileClipboard((current) => current?.operation === 'cut' ? undefined : current)}
                onExplorerSelectionChange={setExplorerSelection}
                onLocateFileInCanvas={locateProjectFileInCanvas}
                onProjectTreeInternalDrop={handleProjectTreeInternalDrop}
                onProjectTreeExternalDrop={handleProjectTreeExternalDrop}
                onCreateRootFile={() => setInlineProjectTreeEdit(createInlineEditState('creating-file', ''))}
                desktopPlatform={desktopPlatform}
                onKeyboardFileCommand={handleProjectTreeKeyboardFileCommand}
                terminalPanel={(
                  <TerminalPanel
                    api={api}
                    resolvedTheme={resolvedTheme}
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
          desktopPlatform={desktopPlatform}
          onCommand={handleWorkbenchContextMenuCommand}
          onClose={closeWorkbenchContextMenu}
        />
      ) : null}
      {sendToPhotoshopPath && daemonProjectId ? (
        <SendToPhotoshopDialog
          projectId={daemonProjectId}
          projectRelativePath={sendToPhotoshopPath}
          bridge={adobeBridge}
          sending={sendingToPhotoshop}
          onClose={() => setSendToPhotoshopPath(undefined)}
          onSend={(adobeClientId) => {
            setSendingToPhotoshop(true);
            void actions.sendProjectFileToPhotoshop({
              projectRelativePath: sendToPhotoshopPath,
              adobeClientId
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
    </I18nProvider>
  );
}

type SetState<T> = (value: T | ((current: T) => T)) => void;

function projectTreeSelectionFromPaths(paths: string[]): ProjectTreeSelectionState {
  const selectedPaths = [...paths];
  const focusedPath = selectedPaths.at(-1) ?? null;
  return {
    selectedPaths,
    focusedPath,
    anchorPath: focusedPath
  };
}

type WorkbenchProjectFileBatchItemResult = WorkbenchProjectFileBatchOperationResult['results'][number];

function locateSingleFileBatchResult(
  results: WorkbenchProjectFileBatchItemResult[],
  locateProjectFileInCanvas: (projectRelativePath: string) => void
): void {
  const completed = results.filter((result) => result.status === 'ok');
  if (completed.length === 1 && completed[0]!.kind === 'file') {
    locateProjectFileInCanvas(completed[0]!.projectRelativePath);
  }
}

function applyDeletedProjectEntries(input: {
  entries: WorkbenchProjectPathEntry[];
  snapshot: WorkbenchProjectSessionSnapshot;
  activeCanvasRuntime: CanvasEditorRuntime | undefined;
  setExplorerSelection: SetState<ProjectTreeSelectionState>;
  setFileClipboard: SetState<WorkbenchFileClipboard | undefined>;
}): void {
  const deletedPaths = input.entries.map((entry) => entry.projectRelativePath);
  if (input.activeCanvasRuntime) {
    const currentSelection = input.activeCanvasRuntime.getSnapshot().selection;
    input.activeCanvasRuntime.setSelection(deletedPaths.reduce(
      (selection, deletedPath) => clearCanvasSelectionAfterDeletedPath(selection, deletedPath),
      currentSelection
    ));
  }
  const existingPaths = new Set(input.snapshot.files.map((file) => file.projectRelativePath));
  input.setExplorerSelection((current) => {
    if (!current.selectedPaths.some((path) => deletedPaths.some((deletedPath) => isProjectPathContainedByDeletedPath(path, deletedPath)))) {
      return current;
    }
    const fallback = current.focusedPath
      ? nearestExistingParentSelection(current.focusedPath, existingPaths)
      : undefined;
    return projectTreeSelectionFromPaths(fallback ? [fallback] : []);
  });
  input.setFileClipboard((current) => deletedPaths.reduce(
    (clipboard, deletedPath) => clearClipboardAfterDeletedPath(clipboard, deletedPath),
    current
  ));
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

function externalDropPlanHasConflict(input: {
  snapshot: WorkbenchProjectSessionSnapshot | undefined;
  localPaths: string[];
  uploads: Array<{ projectRelativePath: string }>;
  targetDirectoryProjectRelativePath: string;
}): boolean {
  const existingPaths = new Set(input.snapshot?.files.map((file) => file.projectRelativePath) ?? []);
  return [
    ...input.localPaths.map((path) => (
      input.targetDirectoryProjectRelativePath
        ? `${input.targetDirectoryProjectRelativePath}/${nativePathBasename(path)}`
        : nativePathBasename(path)
    )),
    ...externalUploadTopLevelProjectPaths(input.uploads, input.targetDirectoryProjectRelativePath)
  ].some((path) => existingPaths.has(path));
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

function sessionProjectViewStorage(): Storage | undefined {
  return typeof window === 'undefined' ? undefined : window.sessionStorage;
}

function isProjectPathContainedByDeletedPath(projectRelativePath: string, deletedProjectRelativePath: string): boolean {
  return projectRelativePath === deletedProjectRelativePath || projectRelativePath.startsWith(`${deletedProjectRelativePath}/`);
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
