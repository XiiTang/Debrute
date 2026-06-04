import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { WorkbenchProjectSessionSnapshot } from '@axis/app-protocol';
import { createWorkbenchApiClient } from './api/workbenchApiClient';
import { CanvasEditor } from './canvas/CanvasEditor';
import { CanvasFeedbackBar } from './canvas/CanvasFeedbackBar';
import { CanvasMinimapBar } from './canvas/CanvasMinimapBar';
import { CanvasToolbar } from './canvas/CanvasToolbar';
import type { CanvasEditorRuntime, CanvasRuntimeSnapshot } from './canvas/runtime/CanvasEditorRuntime';
import { createCanvasFeedbackEntryUpdater } from './services/canvasFeedbackUpdates';
import { nextSnapshotFromAppServerEvent } from './services/appServerEvents';
import { getCanvasById } from './services/canvasState';
import { loadCanvasFeedback, openInitialProject, replaceWorkbenchProjectRoute } from './services/projectSessionState';
import {
  closeTextEditorWindowState,
  dragTextEditorWindowState,
  openTextEditorWindowState
} from './services/textEditorWindows';
import { useTextFileBufferActions } from './services/textFileBufferActions';
import { runWorkbenchContextMenuCommand } from './services/workbenchContextMenuCommands';
import { WorkbenchContextMenu } from './shell/WorkbenchContextMenu';
import {
  buildWorkbenchContextMenuItems,
  type WorkbenchContextMenuCommand,
  type WorkbenchFileClipboard,
  type WorkbenchContextMenuPosition,
  type WorkbenchContextMenuTarget
} from './shell/contextMenu';
import { validateInlineProjectName, type ProjectTreeInlineEditState } from './project-explorer/projectTreeEditing';
import {
  clearCanvasSelectionAfterDeletedPath,
  nearestExistingParentSelection
} from './project-explorer/workbenchFileCommands';
import {
  canvasMinimapButtonRect,
  canvasNodeToViewportRect,
  placeCanvasFeedbackBar,
  placeCanvasMinimapPanel,
  type CanvasFeedbackBarTarget,
  type FloatingBarRect
} from './shell/floatingBars';
import {
  DEFAULT_FLOATING_PANEL_STATE,
  FLOATING_PANEL_IDS,
  FLOATING_PANEL_STORAGE_KEY,
  closeFloatingPanel,
  dragFloatingPanel,
  loadFloatingPanelState,
  serializeFloatingPanelState,
  toggleFloatingPanel,
  type FloatingPanelState
} from './shell/floatingPanels';
import { FloatingDock } from './shell/FloatingDock';
import { FloatingPanel, FloatingPanelContent } from './shell/FloatingPanel';
import { FloatingTextEditorWindow } from './shell/FloatingTextEditorWindow';
import { NotificationStack } from './shell/NotificationStack';
import { FIXED_TOP_FLOATING_BAR_RECTS } from './shell/workbenchLayers';
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
import type { FloatingTextEditorWindowState, TextFileBuffer, WorkbenchActions, WorkbenchState } from '../types';

const api = createWorkbenchApiClient();

export function WorkbenchApp(): React.ReactElement {
  const [snapshot, setSnapshot] = useState<WorkbenchProjectSessionSnapshot>();
  const [activeCanvasId, setActiveCanvasId] = useState<string>();
  const [activeCanvasRuntime, setActiveCanvasRuntime] = useState<CanvasEditorRuntime>();
  const [activeCanvasRuntimeSnapshot, setActiveCanvasRuntimeSnapshot] = useState<CanvasRuntimeSnapshot>();
  const [canvasRuntimeScopeKey, setCanvasRuntimeScopeKey] = useState(0);
  const [explorerSelection, setExplorerSelection] = useState<string>();
  const [floatingPanels, setFloatingPanels] = useState<FloatingPanelState>(() => {
    const raw = globalThis.localStorage?.getItem(FLOATING_PANEL_STORAGE_KEY);
    return raw ? loadFloatingPanelState(raw) : DEFAULT_FLOATING_PANEL_STATE;
  });
  const [llmSettings, setLlmSettings] = useState<WorkbenchState['llmSettings']>();
  const [imageModelSettings, setImageModelSettings] = useState<WorkbenchState['imageModelSettings']>();
  const [videoModelSettings, setVideoModelSettings] = useState<WorkbenchState['videoModelSettings']>();
  const [integrationsSettings, setIntegrationsSettings] = useState<WorkbenchState['integrationsSettings']>();
  const [canvasSettings, setCanvasSettings] = useState<WorkbenchState['canvasSettings']>();
  const [canvasFeedback, setCanvasFeedback] = useState<WorkbenchState['canvasFeedback']>();
  const [textFileBuffers, setTextFileBuffers] = useState<Record<string, TextFileBuffer>>({});
  const [textEditorWindows, setTextEditorWindows] = useState<Record<string, FloatingTextEditorWindowState>>({});
  const [windowOrder, setWindowOrder] = useState<WorkbenchWindowOrderState>(DEFAULT_WORKBENCH_WINDOW_ORDER);
  const [feedbackBarTarget, setFeedbackBarTarget] = useState<CanvasFeedbackBarTarget>();
  const [canvasMinimapOpen, setCanvasMinimapOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    target: WorkbenchContextMenuTarget;
    position: WorkbenchContextMenuPosition;
  }>();
  const [fileClipboard, setFileClipboard] = useState<WorkbenchFileClipboard>();
  const [desktopPlatform, setDesktopPlatform] = useState<NodeJS.Platform>('linux');
  const [inlineProjectTreeEdit, setInlineProjectTreeEdit] = useState<ProjectTreeInlineEditState>();
  const [notifications, setNotifications] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const textFileBuffersRef = useRef(textFileBuffers);
  const textEditorWindowsRef = useRef(textEditorWindows);
  const feedbackBarClearTimerRef = useRef<number | undefined>(undefined);
  const feedbackBarHoveredRef = useRef(false);

  useEffect(() => {
    textFileBuffersRef.current = textFileBuffers;
  }, [textFileBuffers]);

  useEffect(() => {
    textEditorWindowsRef.current = textEditorWindows;
  }, [textEditorWindows]);

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

  useEffect(() => {
    let disposed = false;
    void api.integrationsListStatus().then((settings) => {
      if (!disposed) {
        setIntegrationsSettings(settings);
      }
    });
    void api.canvasSettingsGet().then((settings) => {
      if (!disposed) {
        setCanvasSettings(settings);
      }
    });
    void api.getDesktopPlatform().then((platform) => {
      if (!disposed) {
        setDesktopPlatform(platform);
      }
    }).catch((error) => {
      if (!disposed) {
        setNotifications((current) => [...current, `Desktop platform failed: ${errorMessage(error)}`]);
      }
    });
    openInitialProject(api)
      .then(({ snapshot: opened }) => {
        if (!opened || disposed) {
          return;
        }
        setSnapshot(opened);
        void loadCanvasFeedback(api, setCanvasFeedback, setNotifications);
        setActiveCanvasId(opened.canvases[0]?.id);
        void api.llmGetSettings().then(setLlmSettings);
        void api.imageModelGetSettings().then(setImageModelSettings);
        void api.videoModelGetSettings().then(setVideoModelSettings);
      })
      .catch((error) => {
        if (!disposed) {
          setNotifications((current) => [`Project startup failed: ${errorMessage(error)}`, ...current].slice(0, 4));
        }
      })
      .finally(() => {
        if (!disposed) {
          setIsLoading(false);
        }
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    globalThis.localStorage?.setItem(FLOATING_PANEL_STORAGE_KEY, serializeFloatingPanelState(floatingPanels));
  }, [floatingPanels]);

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
      if (event.type === 'project.opened') {
        setActiveCanvasId(event.snapshot.canvases[0]?.id);
        setExplorerSelection(undefined);
        setContextMenu(undefined);
        setFileClipboard(undefined);
        setInlineProjectTreeEdit(undefined);
        setActiveCanvasRuntime(undefined);
        setCanvasRuntimeScopeKey((current) => current + 1);
        setCanvasMinimapOpen(false);
        void loadCanvasFeedback(api, setCanvasFeedback, setNotifications);
      }
      if (event.type === 'project.fileChanged') {
        void refreshTextFileBuffer(event.event.projectRelativePath);
        if (event.event.projectRelativePath === '.axis/reviews/canvas-feedback.json') {
          void loadCanvasFeedback(api, setCanvasFeedback, setNotifications);
        }
      }
      if (event.type === 'llm.settings.changed') {
        setLlmSettings(event.settings);
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
      if (event.type === 'canvas.settings.changed') {
        setCanvasSettings(event.settings);
      }
    });
  }, [refreshTextFileBuffer]);

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
    setTextEditorWindows((windows) => openTextEditorWindowState(windows, projectRelativePath));
    setWindowOrder((current) => focusWorkbenchWindow(current, textEditorWindowIdentity(projectRelativePath)));
    void ensureTextFileBuffer(projectRelativePath);
  }, [ensureTextFileBuffer]);

  const updateCanvasFeedbackEntry = useMemo(() => createCanvasFeedbackEntryUpdater({
    requestUpdate: (input) => api.updateCanvasFeedbackEntry(input),
    applyFeedback: setCanvasFeedback,
    notifyUnavailable: (message) => {
      setNotifications((current) => [message, ...current].slice(0, 4));
    }
  }), []);

  const clearFeedbackBarHideTimer = useCallback(() => {
    if (feedbackBarClearTimerRef.current !== undefined) {
      window.clearTimeout(feedbackBarClearTimerRef.current);
      feedbackBarClearTimerRef.current = undefined;
    }
  }, []);

  const handleFeedbackBarTargetChange = useCallback((target: CanvasFeedbackBarTarget | undefined) => {
    clearFeedbackBarHideTimer();
    if (target) {
      setFeedbackBarTarget(target);
      return;
    }
    feedbackBarClearTimerRef.current = window.setTimeout(() => {
      feedbackBarClearTimerRef.current = undefined;
      if (!feedbackBarHoveredRef.current) {
        setFeedbackBarTarget(undefined);
      }
    }, 120);
  }, [clearFeedbackBarHideTimer]);

  const handleFeedbackBarPointerEnter = useCallback(() => {
    feedbackBarHoveredRef.current = true;
    clearFeedbackBarHideTimer();
  }, [clearFeedbackBarHideTimer]);

  const handleFeedbackBarPointerLeave = useCallback(() => {
    feedbackBarHoveredRef.current = false;
    setFeedbackBarTarget(undefined);
  }, []);

  const openWorkbenchContextMenu = useCallback((target: WorkbenchContextMenuTarget, position: WorkbenchContextMenuPosition) => {
    setContextMenu({ target, position });
  }, []);

  const closeWorkbenchContextMenu = useCallback(() => {
    setContextMenu(undefined);
  }, []);

  const openInspectorPanel = useCallback(() => {
    setFloatingPanels((current) => ({
      ...current,
      panels: {
        ...current.panels,
        inspector: {
          ...current.panels.inspector,
          open: true
        }
      }
    }));
    setWindowOrder((current) => focusWorkbenchWindow(current, panelWindowIdentity('inspector')));
  }, []);

  const copyProjectRelativePath = useCallback(async (projectRelativePath: string) => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard unavailable');
      }
      await navigator.clipboard.writeText(projectRelativePath);
    } catch (error) {
      setNotifications((current) => [`Copy failed: ${errorMessage(error)}`, ...current].slice(0, 4));
    }
  }, []);

  const state: WorkbenchState = {
    snapshot,
    explorerSelection,
    llmSettings,
    imageModelSettings,
    videoModelSettings,
    integrationsSettings,
    canvasSettings,
    canvasFeedback,
    textFileBuffers,
    textEditorWindows,
    notifications
  };

  const actions: WorkbenchActions = useMemo(() => ({
    selectExplorerPath: setExplorerSelection,
    openProject: async () => {
      let opened: Awaited<ReturnType<typeof api.openProject>>;
      try {
        const selectedRoot = await api.chooseProjectRoot();
        if (!selectedRoot) {
          return;
        }
        opened = await api.openProject({ projectRoot: selectedRoot });
      } catch (error) {
        setNotifications((current) => [`Open project failed: ${errorMessage(error)}`, ...current].slice(0, 4));
        return;
      }
      replaceWorkbenchProjectRoute(opened.projectId);
      setSnapshot(opened.snapshot);
      setActiveCanvasId(opened.snapshot.canvases[0]?.id);
      setActiveCanvasRuntime(undefined);
      setCanvasRuntimeScopeKey((current) => current + 1);
      setExplorerSelection(undefined);
      setFileClipboard(undefined);
      setInlineProjectTreeEdit(undefined);
      setTextFileBuffers({});
      setTextEditorWindows({});
      setWindowOrder(DEFAULT_WORKBENCH_WINDOW_ORDER);
      setFeedbackBarTarget(undefined);
      setCanvasMinimapOpen(false);
      setLlmSettings(await api.llmGetSettings());
      setImageModelSettings(await api.imageModelGetSettings());
      setVideoModelSettings(await api.videoModelGetSettings());
      setIntegrationsSettings(await api.integrationsListStatus());
      await loadCanvasFeedback(api, setCanvasFeedback, setNotifications);
      setNotifications((current) => [`Opened project: ${opened.snapshot.metadata.project.name}`, ...current].slice(0, 4));
    },
    saveLlmProviderSetting: async (input, providerId) => {
      const settings = await api.llmSaveProviderSetting(input, providerId);
      setLlmSettings(settings);
    },
    deleteLlmProviderSetting: async (providerId) => {
      const settings = await api.llmDeleteProviderSetting(providerId);
      setLlmSettings(settings);
    },
    setDefaultLlmModelKey: async (modelKey) => {
      const settings = await api.llmSetDefaultModelKey(modelKey);
      setLlmSettings(settings);
    },
    discoverLlmProviderModels: (input, providerId) => api.llmDiscoverProviderModels(input, providerId),
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
    saveCanvasSettings: async (input) => {
      setCanvasSettings(await api.canvasSettingsSave(input));
    },
    lookupGeneratedAssetMetadata,
    readGeneratedAsset,
    readProjectTextFile,
    writeProjectTextFile,
    createProjectFile: async (input) => {
      const result = await api.createProjectFile(input);
      setSnapshot(result.snapshot);
      setExplorerSelection(result.projectRelativePath);
      return result;
    },
    createProjectDirectory: async (input) => {
      const result = await api.createProjectDirectory(input);
      setSnapshot(result.snapshot);
      setExplorerSelection(result.projectRelativePath);
      return result;
    },
    renameProjectPath: async (input) => {
      const result = await api.renameProjectPath(input);
      setSnapshot(result.snapshot);
      setExplorerSelection(result.projectRelativePath);
      return result;
    },
    copyProjectPath: async (input) => {
      const result = await api.copyProjectPath(input);
      setSnapshot(result.snapshot);
      setExplorerSelection(result.projectRelativePath);
      return result;
    },
    moveProjectPath: async (input) => {
      const result = await api.moveProjectPath(input);
      setSnapshot(result.snapshot);
      setExplorerSelection(result.projectRelativePath);
      return result;
    },
    trashProjectPath: async (input) => {
      const result = await api.trashProjectPath(input);
      const existingPaths = new Set(result.snapshot.files.map((file) => file.projectRelativePath));
      setSnapshot(result.snapshot);
      activeCanvasRuntime?.setSelection(clearCanvasSelectionAfterDeletedPath(
        activeCanvasRuntime.getSnapshot().selection,
        input.projectRelativePath
      ));
      setExplorerSelection((current) => (
        current === input.projectRelativePath || current?.startsWith(`${input.projectRelativePath}/`)
          ? nearestExistingParentSelection(current, existingPaths)
          : current
      ));
      return result;
    },
    deleteProjectPathPermanently: async (input) => {
      const result = await api.deleteProjectPathPermanently(input);
      const existingPaths = new Set(result.snapshot.files.map((file) => file.projectRelativePath));
      setSnapshot(result.snapshot);
      activeCanvasRuntime?.setSelection(clearCanvasSelectionAfterDeletedPath(
        activeCanvasRuntime.getSnapshot().selection,
        input.projectRelativePath
      ));
      setExplorerSelection((current) => (
        current === input.projectRelativePath || current?.startsWith(`${input.projectRelativePath}/`)
          ? nearestExistingParentSelection(current, existingPaths)
          : current
      ));
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
      await api.updateCanvasNodeLayouts({
        canvasId,
        ...input
      });
    },
    updateCanvasNodeLayers: async (canvasId, input) => {
      await api.updateCanvasNodeLayers({
        canvasId,
        ...input
      });
    },
    updateCanvasFeedbackEntry
  }), [
    activeCanvasId,
    activeCanvasRuntime,
    ensureTextFileBuffer,
    lookupGeneratedAssetMetadata,
    openTextEditorWindow,
    readGeneratedAsset,
    readProjectTextFile,
    reloadTextFileBuffer,
    saveTextFileBuffer,
    snapshot,
    toggleTextFileWordWrap,
    updateCanvasFeedbackEntry,
    updateTextFileBuffer,
    writeProjectTextFile
  ]);

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
      setInlineProjectTreeEdit({ ...current, error: validation.message });
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
  }, [actions, inlineProjectTreeEdit]);

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

  const activeCanvas = getCanvasById(snapshot, activeCanvasId);
  const activeProjection = activeCanvas
    ? snapshot?.projections.find((item) => item.canvasId === activeCanvas.id)
    : undefined;
  const workbenchViewportRect: FloatingBarRect = {
    x: 0,
    y: 0,
    width: globalThis.window?.innerWidth ?? 1280,
    height: globalThis.window?.innerHeight ?? 720
  };
  const minimapButtonRect = canvasMinimapButtonRect(workbenchViewportRect);
  const minimapPanelPlacement = placeCanvasMinimapPanel({
    buttonRect: minimapButtonRect,
    viewportRect: workbenchViewportRect
  });
  const floatingBarReservedRects = [
    ...FIXED_TOP_FLOATING_BAR_RECTS,
    minimapButtonRect,
    ...(canvasMinimapOpen ? [minimapPanelPlacement] : [])
  ];
  const canRevealInCanvas = Boolean(activeCanvasRuntime && activeCanvasRuntimeSnapshot?.surfaceSize);
  const contextMenuItems = useMemo(() => contextMenu
      ? buildWorkbenchContextMenuItems({
          target: contextMenu.target,
          projection: activeProjection,
          canRevealInCanvas,
          fileClipboard,
          desktopPlatform
        })
    : [], [activeProjection, canRevealInCanvas, contextMenu, desktopPlatform, fileClipboard]);
  const notify = useCallback((message: string) => {
    setNotifications((current) => [message, ...current].slice(0, 4));
  }, []);
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
      openInspectorPanel
    });
  }, [
    actions,
    activeCanvasRuntime,
    activeProjection,
    closeWorkbenchContextMenu,
    contextMenu,
    copyProjectRelativePath,
    fileClipboard,
    notify,
    openInspectorPanel
  ]);
  const feedbackBarPlacement = feedbackBarTarget
    ? placeCanvasFeedbackBar({
        nodeViewportRect: canvasNodeToViewportRect({
          nodeRect: feedbackBarTarget.nodeRect,
          surfaceRect: feedbackBarTarget.surfaceRect,
          camera: feedbackBarTarget.camera
        }),
        viewportRect: workbenchViewportRect,
        reservedRects: floatingBarReservedRects
      })
    : undefined;

  if (isLoading) {
    return (
      <div className="boot-screen">
        <Loader2 className="spin" size={22} />
        <span>Opening AXIS workbench</span>
      </div>
    );
  }

  return (
    <div className="workbench-shell" data-theme="dark" data-testid="workbench-shell">
      <div className="canvas-layer" data-testid="canvas-layer">
        <CanvasEditor
          canvasId={activeCanvasId}
          state={state}
          actions={actions}
          runtimeScopeKey={canvasRuntimeScopeKey}
          onFeedbackBarTargetChange={handleFeedbackBarTargetChange}
          onRuntimeChange={setActiveCanvasRuntime}
          onOpenContextMenu={openWorkbenchContextMenu}
        />
      </div>
      <div className="floating-bar-layer" data-testid="floating-bar-layer">
        <CanvasToolbar
          canvas={activeCanvas}
          projection={activeProjection}
          runtime={activeCanvasRuntime}
          runtimeSnapshot={activeCanvasRuntimeSnapshot}
        />
        <FloatingDock
          panelState={floatingPanels}
          onToggle={(panelId) => {
            const isOpen = floatingPanels.panels[panelId].open;
            setFloatingPanels((current) => toggleFloatingPanel(current, panelId));
            setWindowOrder((current) => (
              isOpen
                ? closeWorkbenchWindow(current, panelWindowIdentity(panelId))
                : focusWorkbenchWindow(current, panelWindowIdentity(panelId))
            ));
          }}
        />
        <CanvasMinimapBar
          canvas={activeCanvas}
          projection={activeProjection}
          runtime={activeCanvasRuntime}
          open={canvasMinimapOpen}
          onOpenChange={setCanvasMinimapOpen}
          panelPlacement={minimapPanelPlacement}
        />
        {feedbackBarTarget && feedbackBarPlacement ? (
          <CanvasFeedbackBar
            projectRelativePath={feedbackBarTarget.projectRelativePath}
            entry={feedbackBarTarget.entry}
            onUpdate={actions.updateCanvasFeedbackEntry}
            onPointerEnter={handleFeedbackBarPointerEnter}
            onPointerLeave={handleFeedbackBarPointerLeave}
            style={{
              left: feedbackBarPlacement.x,
              top: feedbackBarPlacement.y,
              width: feedbackBarPlacement.width,
              height: feedbackBarPlacement.height
            }}
          />
        ) : null}
      </div>
      <div className="panel-layer" data-testid="panel-layer">
        {FLOATING_PANEL_IDS.map((panelId) => (
          floatingPanels.panels[panelId].open ? (
            <FloatingPanel
              key={panelId}
              panelId={panelId}
              state={floatingPanels}
              orderState={renderWindowOrder}
              onClose={() => {
                setFloatingPanels((current) => closeFloatingPanel(current, panelId));
                setWindowOrder((current) => closeWorkbenchWindow(current, panelWindowIdentity(panelId)));
              }}
              onBringToFront={() => setWindowOrder((current) => focusWorkbenchWindow(current, panelWindowIdentity(panelId)))}
              onDrag={(dx, dy) => setFloatingPanels((current) => dragFloatingPanel(current, panelId, { dx, dy }))}
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
              />
            </FloatingPanel>
          ) : null
        ))}
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
            onDrag={(dx, dy) => setTextEditorWindows((windows) => dragTextEditorWindowState(windows, windowState.projectRelativePath, { dx, dy }))}
          />
        ))}
      </div>
      {contextMenu ? (
        <WorkbenchContextMenu
          items={contextMenuItems}
          position={contextMenu.position}
          onCommand={handleWorkbenchContextMenuCommand}
          onClose={closeWorkbenchContextMenu}
        />
      ) : null}
      <NotificationStack notifications={notifications} />
    </div>
  );
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
