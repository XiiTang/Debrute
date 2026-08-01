import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Loader2 } from './ui/index.js';
import type {
  DebruteProductPlatform,
  DebruteWorkbenchRoute,
  ProjectPathEntry,
  WorkbenchProjectSessionSnapshot
} from '@debrute/app-protocol';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import type { HttpWorkbenchApiClient } from '../api/httpWorkbenchApiClient.js';
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
import { useCanvasSurfaceReady } from './canvas/runtime/useCanvasRuntimeSnapshot.js';
import { getCanvasById } from './services/canvasState';
import { createCanvasSelectionStackOrderSync } from './services/canvasStackOrderSelection';
import { chooseInitialActiveCanvasId } from './canvas/canvasCardBarState';
import {
  currentDebruteWorkbenchRoute,
  replaceWorkbenchProjectRoute,
  resolveInitialProjectRoute,
  shouldShowInitialProjectLoader,
  type ProjectOpenStartupError
} from './services/projectSessionState';
import {
  createProjectBindingLifecycle,
  type ProjectBindingLifecycle,
  type ProjectBindingLifecycleOutcome
} from './services/projectBindingLifecycle.js';
import { restoreProjectViewState, saveProjectViewState } from './services/projectViewState';
import { reconcileWorkbenchViewportLayout } from './services/workbenchViewportLayout';
import {
  closeTextEditorWindowState,
  dragTextEditorWindowState,
  openTextEditorWindowState,
  resizeTextEditorWindowState
} from './services/textEditorWindows';
import { useTextFileBufferActions } from './services/textFileBufferActions';
import {
  createProjectPathCommandRouter,
  type ProjectPathCommandRouter
} from './services/projectPathCommandRouter.js';
import {
  createProjectPathCommandEffects,
  type ProjectPathCommandEffects,
  type ProjectPathEffectApiName
} from './services/projectPathCommandEffects.js';
import {
  createProjectPathCommandIntake,
  type AcceptedProjectPathCommandScope
} from './services/projectPathCommandIntake.js';
import {
  PendingWorkbenchContextMenuDismissal,
  WorkbenchContextMenu
} from './shell/WorkbenchContextMenu.js';
import { WorkbenchTitleBar } from './shell/WorkbenchTitleBar';
import { executeTitleBarMenuCommand } from './shell/workbenchTitleBarCommands';
import {
  buildWorkbenchTitleBarState,
  type WorkbenchMenuItem
} from './shell/workbenchTitleBarState';
import {
  cameraCenteredOnNode,
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
import type { ProjectExplorerController } from './project-explorer/useProjectExplorerController.js';
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
import { NotificationStack } from './shell/NotificationStack';
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
import type { WorkbenchSettingsController } from './settings/useWorkbenchSettingsController.js';
import {
  useWorkbenchPresentationController,
  type WorkbenchPresentationController
} from './services/useWorkbenchPresentationController.js';
import { canvasTextRenderProfileForAppearance } from './canvas/CanvasFontCatalog.js';
import {
  CanvasTextRenderProfileGate,
  CanvasTextRenderProfileProvider
} from './canvas/CanvasTextRenderProfileContext.js';
import { CanvasTextProjectFontEnvironmentProvider } from './canvas/font-subset/CanvasTextProjectFontEnvironment.js';
import { workbenchStartupTimeline } from '../startup/workbenchStartupTimeline.js';
import { waitForWorkbenchShellFonts } from '../startup/workbenchShellFonts.js';

const productPlatform: DebruteProductPlatform = __DEBRUTE_PLATFORM__;
const TerminalPanel = React.lazy(async () => {
  workbenchStartupTimeline.markFeatureRequested('terminal');
  const module = await import('./terminal/TerminalPanel.js');
  workbenchStartupTimeline.markFeatureReady('terminal');
  return { default: module.TerminalPanel };
});
const loadSettingsFeature = async () => {
  workbenchStartupTimeline.markFeatureRequested('settings');
  const module = await import('./settings/SettingsFeature.js');
  workbenchStartupTimeline.markFeatureReady('settings');
  return module;
};
const WorkbenchSettingsFeatureHost = React.lazy(async () => {
  const module = await loadSettingsFeature();
  return { default: module.WorkbenchSettingsFeatureHost };
});
const WorkbenchSettingsPanelFeature = React.lazy(async () => {
  const module = await loadSettingsFeature();
  return { default: module.WorkbenchSettingsPanelFeature };
});
const loadExplorerFeature = async () => {
  workbenchStartupTimeline.markFeatureRequested('explorer');
  const module = await import('./project-explorer/ExplorerPanelFeature.js');
  workbenchStartupTimeline.markFeatureReady('explorer');
  return module;
};
const WorkbenchExplorerControllerHost = React.lazy(async () => {
  const module = await loadExplorerFeature();
  return { default: module.WorkbenchExplorerControllerHost };
});
const WorkbenchExplorerPanelFeature = React.lazy(async () => {
  const module = await loadExplorerFeature();
  return { default: module.WorkbenchExplorerPanelFeature };
});
const WorkbenchInspectorPanelFeature = React.lazy(async () => {
  workbenchStartupTimeline.markFeatureRequested('inspector');
  const module = await import('./shell/InspectorPanelFeature.js');
  workbenchStartupTimeline.markFeatureReady('inspector');
  return { default: module.WorkbenchInspectorPanelFeature };
});
const WorkbenchFloatingTextEditorWindowFeature = React.lazy(async () => {
  const module = await import('./canvas/FloatingTextEditorWindowFeature.js');
  return { default: module.WorkbenchFloatingTextEditorWindowFeature };
});

type WorkbenchProjectGenerationApi = Omit<HttpWorkbenchApiClient, ProjectPathEffectApiName>;

export function WorkbenchApp({
  api,
  onCommitted
}: {
  api: HttpWorkbenchApiClient;
  onCommitted?: () => void;
}): React.ReactElement {
  const initialRoute = useMemo(() => currentDebruteWorkbenchRoute(), []);
  if (initialRoute.kind === 'not-found') {
    return <WorkbenchNotFound onCommitted={onCommitted} />;
  }
  return (
    <WorkbenchRuntimeApp
      api={api}
      initialRoute={initialRoute}
      onCommitted={onCommitted}
    />
  );
}

function WorkbenchNotFound({
  onCommitted
}: {
  onCommitted: (() => void) | undefined;
}): React.ReactElement {
  useLayoutEffect(() => {
    onCommitted?.();
  }, [onCommitted]);
  return (
    <main className="boot-screen" role="alert" data-testid="workbench-not-found">
      <strong>404 — Workbench page not found</strong>
      <span>This URL is not a Debrute Workbench page.</span>
    </main>
  );
}

function WorkbenchRuntimeApp({
  api,
  initialRoute,
  onCommitted
}: {
  api: HttpWorkbenchApiClient;
  initialRoute: Exclude<DebruteWorkbenchRoute, { kind: 'not-found' }>;
  onCommitted: (() => void) | undefined;
}): React.ReactElement {
  const projectProjection = useSyncExternalStore(
    api.projectProjection.subscribe,
    api.projectProjection.getState
  );
  const projectBindingLifecycle = useMemo(() => createProjectBindingLifecycle({
    openProject: api.openProject,
    projectProjection: api.projectProjection,
    commitProjectRoute: replaceWorkbenchProjectRoute
  }), [api]);
  const projectBindingLifecycleState = useSyncExternalStore(
    projectBindingLifecycle.subscribe,
    projectBindingLifecycle.getState
  );
  const projectPathCommandEffects = useMemo(
    () => createProjectPathCommandEffects(api),
    [api]
  );
  const [connectionEnded, setConnectionEnded] = useState<Error>();
  const notificationIdRef = useRef(0);
  const [notificationEntries, setNotificationEntries] = useState<Array<{ id: number; message: string }>>([]);
  const notifications = notificationEntries.map((entry) => entry.message);
  const [isLoading, setIsLoading] = useState(() => shouldShowInitialProjectLoader(initialRoute));
  const [projectOpenAttemptedPath, setProjectOpenAttemptedPath] = useState<string>();
  const [projectOpenError, setProjectOpenError] = useState<string>();
  const initialProjectOpeningRef = useRef<ReturnType<ProjectBindingLifecycle['open']> | undefined>(undefined);
  const announcedProjectGenerationsRef = useRef(new Set<number>());
  const notify = useCallback((message: string) => {
    notificationIdRef.current += 1;
    const entry = { id: notificationIdRef.current, message };
    setNotificationEntries((current) => [entry, ...current].slice(0, 4));
  }, []);
  const startNotification = useCallback((message: string) => {
    notificationIdRef.current += 1;
    const id = notificationIdRef.current;
    setNotificationEntries((current) => [{ id, message }, ...current].slice(0, 4));
    return (nextMessage: string) => {
      setNotificationEntries((current) => current.map((entry) => (
        entry.id === id ? { ...entry, message: nextMessage } : entry
      )));
    };
  }, []);
  const presentationController = useWorkbenchPresentationController({
    globalProjection: api.globalProjection
  });
  useLayoutEffect(() => {
    workbenchStartupTimeline.mark('react-committed');
    onCommitted?.();
  }, [onCommitted]);
  useEffect(() => {
    if (!workbenchStartupTimeline.enabled) {
      return;
    }
    let cancelled = false;
    void waitForWorkbenchShellFonts(document.fonts).then(() => {
      if (!cancelled) {
        workbenchStartupTimeline.mark('shell-fonts-ready');
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const [settingsFeatureRequested, setSettingsFeatureRequested] = useState(false);
  const [settingsFeatureController, setSettingsFeatureController] = useState<WorkbenchSettingsController>();
  const requestSettingsFeature = useCallback(() => {
    setSettingsFeatureRequested(true);
  }, []);
  const canvasTextAppearance = settingsFeatureController
    ? settingsFeatureController.canvasTextAppearance
    : presentationController.settings.canvas.textAppearance;
  const canvasTextRenderProfile = useMemo(
    () => canvasTextRenderProfileForAppearance(canvasTextAppearance),
    [
      canvasTextAppearance.fontId,
      canvasTextAppearance.fontSizePx,
      canvasTextAppearance.fontWeight,
      canvasTextAppearance.letterSpacingPx,
      canvasTextAppearance.ligatures,
      canvasTextAppearance.lineHeightRatio
    ]
  );
  const i18n = useMemo(
    () => createI18n(presentationController.locale),
    [presentationController.locale]
  );
  const announceProjectGeneration = useCallback((input: {
    generation: number;
    projectName: string;
    viewStateInvalid: boolean;
  }) => {
    if (announcedProjectGenerationsRef.current.has(input.generation)) {
      return;
    }
    announcedProjectGenerationsRef.current.add(input.generation);
    const currentI18n = presentationController.getCurrentI18n();
    if (input.viewStateInvalid) {
      notify(currentI18n.t('shell.notifications.projectViewStateReset', {
        name: input.projectName
      }));
    }
    notify(currentI18n.t('shell.notifications.projectOpened', {
      name: input.projectName
    }));
  }, [notify, presentationController.getCurrentI18n]);

  useEffect(() => api.onConnectionEnded(setConnectionEnded), []);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const resolution = resolveInitialProjectRoute(initialRoute);
        setProjectOpenAttemptedPath(resolution.projectOpen?.attemptedPath);
        setProjectOpenError(localizedProjectOpenError(
          resolution.projectOpen?.error,
          presentationController.getCurrentI18n()
        ));
        if (!resolution.target) {
          return;
        }
        initialProjectOpeningRef.current ??= projectBindingLifecycle.open(resolution.target);
        const result = await initialProjectOpeningRef.current;
        if (disposed) {
          return;
        }
        if (result.outcome === 'failed') {
          const error: ProjectOpenStartupError = initialRoute.kind === 'project'
            ? { code: 'project-snapshot-load-failed', message: result.error.message }
            : { code: 'project-open-failed', message: result.error.message };
          setProjectOpenError(localizedProjectOpenError(error, presentationController.getCurrentI18n()));
        }
      } catch (error) {
        if (!disposed) {
          notify(presentationController.getCurrentI18n().t('shell.notifications.projectStartupFailed', {
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
  }, [initialRoute, notify, presentationController.getCurrentI18n, projectBindingLifecycle]);

  const projectGenerationAppProps = {
    api,
    projectPathCommandEffects,
    canvasTextRenderProfile,
    projectProjection,
    connectionEnded,
    notifications,
    notify,
    startNotification,
    announceProjectGeneration,
    presentationController,
    settingsFeatureController,
    requestSettingsFeature,
    i18n,
    isLoading,
    projectOpenAttemptedPath,
    setProjectOpenAttemptedPath,
    projectOpenError,
    setProjectOpenError,
    projectBindingLifecycle,
    isProjectOpening: projectBindingLifecycleState.opening
  };
  const generationApp = <WorkbenchProjectGenerationApp {...projectGenerationAppProps} />;
  const surface = projectProjection.status === 'unbound' ? (
    <CanvasTextProjectFontEnvironmentProvider profile={canvasTextRenderProfile}>
      {generationApp}
    </CanvasTextProjectFontEnvironmentProvider>
  ) : (
    <CanvasTextProjectFontEnvironmentProvider
      key={projectProjection.generation}
      profile={canvasTextRenderProfile}
    >
      {generationApp}
    </CanvasTextProjectFontEnvironmentProvider>
  );
  return (
    <>
      {surface}
      {settingsFeatureRequested ? (
        <React.Suspense fallback={null}>
          <WorkbenchSettingsFeatureHost
            api={api}
            notify={notify}
            getCurrentI18n={presentationController.getCurrentI18n}
            onController={setSettingsFeatureController}
          />
        </React.Suspense>
      ) : null}
      <NotificationStack notifications={notifications} />
    </>
  );
}

function WorkbenchProjectGenerationApp({
  api,
  projectPathCommandEffects,
  canvasTextRenderProfile,
  projectProjection,
  connectionEnded,
  notifications,
  notify,
  startNotification,
  announceProjectGeneration,
  presentationController,
  settingsFeatureController,
  requestSettingsFeature,
  i18n,
  isLoading,
  projectOpenAttemptedPath,
  setProjectOpenAttemptedPath,
  projectOpenError,
  setProjectOpenError,
  projectBindingLifecycle,
  isProjectOpening
}: {
  api: WorkbenchProjectGenerationApi;
  projectPathCommandEffects: ProjectPathCommandEffects;
  canvasTextRenderProfile: ReturnType<typeof canvasTextRenderProfileForAppearance>;
  projectProjection: WorkbenchProjectProjectionState;
  connectionEnded: Error | undefined;
  notifications: string[];
  notify(message: string): void;
  startNotification(message: string): (message: string) => void;
  announceProjectGeneration(input: {
    generation: number;
    projectName: string;
    viewStateInvalid: boolean;
  }): void;
  presentationController: WorkbenchPresentationController;
  settingsFeatureController: WorkbenchSettingsController | undefined;
  requestSettingsFeature(): void;
  i18n: WorkbenchI18n;
  isLoading: boolean;
  projectOpenAttemptedPath: string | undefined;
  setProjectOpenAttemptedPath: React.Dispatch<React.SetStateAction<string | undefined>>;
  projectOpenError: string | undefined;
  setProjectOpenError: React.Dispatch<React.SetStateAction<string | undefined>>;
  projectBindingLifecycle: ProjectBindingLifecycle;
  isProjectOpening: boolean;
}): React.ReactElement {
  const installProductUpdateFromTitleBar = useCallback(() => {
    void api.applyProductUpdate().catch((error: unknown) => {
      notify(errorMessage(error));
    });
  }, [api, notify]);
  const acceptedProject = projectProjection.status === 'unbound' ? undefined : projectProjection;
  const hasAcceptedProject = acceptedProject !== undefined;
  const snapshot = acceptedProject?.presentedSnapshot;
  const runtimeProjectId = acceptedProject?.projectId;
  const projectDetached = projectProjection.status === 'detached';
  const projectPresentationBlocked = Boolean(connectionEnded || projectDetached);
  const projectPathCommandSurfaceAvailableRef = useRef(!projectPresentationBlocked);
  projectPathCommandSurfaceAvailableRef.current = !projectPresentationBlocked;
  useLayoutEffect(() => {
    if (isLoading) {
      return;
    }
    workbenchStartupTimeline.mark(
      acceptedProject ? 'project-surface-committed' : 'project-open-surface-committed'
    );
  }, [acceptedProject, isLoading]);
  const projectPathCommandIntake = useMemo(() => createProjectPathCommandIntake({
    projectBindingLifecycle,
    projectProjection: api.projectProjection,
    isCommandSurfaceAvailable: () => projectPathCommandSurfaceAvailableRef.current
  }), [api.projectProjection, projectBindingLifecycle]);
  const initialProjectPresentation = useMemo(
    () => createInitialProjectPresentation(acceptedProject),
    []
  );
  const [activeCanvasId, setActiveCanvasId] = useState<string | undefined>(
    initialProjectPresentation.activeCanvasId
  );
  const [activeCanvasRuntime, setActiveCanvasRuntime] = useState<CanvasEditorRuntime>();
  const [activeCanvasCurrentNodes, setActiveCanvasCurrentNodes] = useState<{
    canvasId: string;
    nodes: ProjectedCanvasNode[];
  }>();
  const canvasRuntimeScopeKey = projectProjection.generation;
  const [floatingPanels, setFloatingPanels] = useState<FloatingPanelState>(
    initialProjectPresentation.floatingPanels
  );
  useEffect(() => {
    if (floatingPanels.panels.settings.open) {
      requestSettingsFeature();
    }
  }, [floatingPanels.panels.settings.open, requestSettingsFeature]);
  const [requestedTerminal, setRequestedTerminal] = useState<{
    cwdProjectRelativePath: string;
    scope: AcceptedProjectPathCommandScope;
  } | null>(null);
  const canSubmitRequestedTerminal = useCallback(
    () => requestedTerminal?.scope.canSubmit() ?? false,
    [requestedTerminal]
  );
  const consumeRequestedTerminal = useCallback(() => {
    setRequestedTerminal(null);
  }, []);
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
  const centerActiveCanvasProjectFile = useCallback((projectRelativePath: string) => {
    centerCanvasProjectionNode(activeProjection, projectRelativePath);
  }, [activeProjection, centerCanvasProjectionNode]);
  const locateProjectFileInCanvas = useCallback((projectRelativePath: string) => {
    if (!projectPathCommandIntake.tryAccept()) {
      return;
    }
    centerActiveCanvasProjectFile(projectRelativePath);
  }, [centerActiveCanvasProjectFile, projectPathCommandIntake]);
  const getAcceptedProjectSnapshot = useCallback(() => {
    const state = api.projectProjection.getState();
    return state.status === 'unbound' ? undefined : state.presentedSnapshot;
  }, []);
  const [explorerFeatureRequested, setExplorerFeatureRequested] = useState(false);
  const [explorerController, setExplorerController] = useState<ProjectExplorerController>();
  const requestExplorerFeature = useCallback(() => {
    setExplorerFeatureRequested(true);
  }, []);
  useEffect(() => {
    if (floatingPanels.panels.explorer.open) {
      requestExplorerFeature();
    }
  }, [floatingPanels.panels.explorer.open, requestExplorerFeature]);
  const fileClipboard = explorerController?.fileClipboard;
  const inlineProjectTreeEdit = explorerController?.inlineEdit;

  const notifyCanvasFeedbackUnavailable = useCallback((message: string) => {
    const currentI18n = presentationController.getCurrentI18n();
    notify(currentI18n.t('canvas.feedback.unavailable', { message }));
  }, [notify, presentationController.getCurrentI18n]);
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
    setProjectOpenAttemptedPath(undefined);
    setProjectOpenError(undefined);
    feedbackInteraction.restoreWorkingCopies(acceptedProject.workingCopies.feedback);
    void feedbackInteraction.load();
  }, [acceptedProject?.generation]);

  const reopenDetachedProject = useCallback(async () => {
    if (!runtimeProjectId) {
      return;
    }
    setProjectOpenError(undefined);
    const outcome = await projectBindingLifecycle.open({ projectId: runtimeProjectId });
    if (outcome.outcome === 'failed') {
      setProjectOpenError(i18n.t('projectOpen.openFailed', { message: outcome.error.message }));
    }
  }, [i18n, projectBindingLifecycle, runtimeProjectId, setProjectOpenError]);

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
      const currentI18n = presentationController.getCurrentI18n();
      notify(currentI18n.t('shell.notifications.windowStateFailed', { message: errorMessage(error) }));
    });
    return shell.onNativeWindowStateChanged((state) => {
      setNativeWindowState(state);
      reconcileCurrentWorkbenchViewportLayout();
    });
  }, [notify, presentationController.getCurrentI18n, reconcileCurrentWorkbenchViewportLayout]);

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
    refreshTextFileBuffer
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
    const scope = projectPathCommandIntake.tryAccept();
    if (!scope) {
      throw new Error('Project path commands are unavailable.');
    }
    const request = projectPathCommandEffects.resetCanvasNodeLayouts(scope, {
      canvasId,
      ...input
    });
    if (!request) {
      throw new Error('Project path commands are unavailable.');
    }
    return request;
  }, [projectPathCommandEffects, projectPathCommandIntake]);

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
    const scope = projectPathCommandIntake.tryAccept();
    if (!scope) {
      return;
    }
    try {
      const request = projectPathCommandEffects.addProjectPathToCanvasMap(scope, input);
      if (!request) {
        return;
      }
      await request;
      if (!scope.isCurrent()) {
        return;
      }
      const accepted = api.projectProjection.getState();
      const projection = accepted.status === 'unbound'
        ? undefined
        : accepted.presentedSnapshot.projections.find((item) => item.canvasId === input.canvasId);
      setActiveCanvasId(input.canvasId);
      explorerController?.setSelection(projectTreeSelectionFromPaths([input.projectRelativePath]));
      centerCanvasProjectionNode(projection, input.projectRelativePath);
    } catch (error) {
      if (!scope.isCurrent()) {
        return;
      }
      notify(i18n.t('shell.notifications.addToCanvasMapFailed', { message: errorMessage(error) }));
    }
  }, [
    centerCanvasProjectionNode,
    explorerController,
    i18n,
    notify,
    projectPathCommandEffects,
    projectPathCommandIntake
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

  const presentProjectOpenFailure = useCallback((error: Error) => {
    const message = i18n.t('projectOpen.openFailed', { message: error.message });
    if (hasAcceptedProject) {
      notify(message);
      return;
    }
    setProjectOpenError(message);
  }, [hasAcceptedProject, i18n, notify, setProjectOpenError]);

  const presentProjectOpenOutcome = useCallback((outcome: ProjectBindingLifecycleOutcome) => {
    if (outcome.outcome === 'failed') {
      presentProjectOpenFailure(outcome.error);
    }
  }, [presentProjectOpenFailure]);

  const openProject = useCallback<WorkbenchActions['openProject']>(async () => {
    const shell = getDebruteShellApi();
    if (shell) {
      setProjectOpenError(undefined);
      setProjectOpenAttemptedPath(undefined);
      try {
        await shell.executeNativeMenuCommand({ commandId: 'project.open-picker' });
      } catch (error) {
        presentProjectOpenFailure(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    setProjectOpenError(undefined);
    setProjectOpenAttemptedPath(undefined);
    try {
      const projectRoot = await api.chooseProjectRoot();
      if (!projectRoot) {
        return;
      }
      setProjectOpenAttemptedPath(projectRoot);
      presentProjectOpenOutcome(await projectBindingLifecycle.open({ projectRoot }));
    } catch (error) {
      presentProjectOpenFailure(error instanceof Error ? error : new Error(String(error)));
    }
  }, [api, presentProjectOpenFailure, presentProjectOpenOutcome, projectBindingLifecycle, setProjectOpenAttemptedPath, setProjectOpenError]);

  const openProjectRoot = useCallback(async (projectRoot: string): Promise<ProjectBindingLifecycleOutcome> => {
    setProjectOpenError(undefined);
    setProjectOpenAttemptedPath(projectRoot);
    return projectBindingLifecycle.open({ projectRoot });
  }, [projectBindingLifecycle, setProjectOpenAttemptedPath, setProjectOpenError]);

  const openWorkbenchContextMenu = useCallback((target: WorkbenchContextMenuTarget, position: WorkbenchContextMenuPosition) => {
    if (!projectPathCommandIntake.canAccept()) {
      return;
    }
    requestExplorerFeature();
    setContextMenu({ target, position });
  }, [projectPathCommandIntake, requestExplorerFeature]);

  const closeWorkbenchContextMenu = useCallback(() => {
    setContextMenu(undefined);
  }, []);

  useEffect(() => {
    if (!isProjectOpening && !projectPresentationBlocked) {
      return;
    }
    closeWorkbenchContextMenu();
    explorerController?.cancelEdit();
  }, [closeWorkbenchContextMenu, explorerController, isProjectOpening, projectPresentationBlocked]);

  const openInspectorPanel = useCallback(() => {
    setFloatingPanels((current) => openFloatingPanel(current, 'inspector', workbenchViewportRectRef.current));
    setWindowOrder((current) => focusWorkbenchWindow(current, panelWindowIdentity('inspector')));
  }, []);

  const copyProjectRelativePath = useCallback(async (projectRelativePath: string) => {
    if (!navigator.clipboard?.writeText) {
      throw new Error('Clipboard unavailable');
    }
    await navigator.clipboard.writeText(projectRelativePath);
  }, []);

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
    locale: presentationController.locale,
    projectTitle: snapshot?.metadata.project.name,
    recentProjects: presentationController.settings.chrome.recentProjects
  }), [presentationController.locale, presentationController.settings.chrome.recentProjects, snapshot?.metadata.project.name]);
  const disabledFloatingPanelIds = useMemo<readonly FloatingPanelId[]>(() => (
    runtimeProjectId ? [] : ['terminal']
  ), [runtimeProjectId]);

  const globalProjection = api.globalProjection.getState();
  if (globalProjection.status === 'uninitialized') {
    throw new Error('Workbench project generation requires the initial Global snapshot.');
  }
  const productUpdate = globalProjection.product.status === 'ready'
    ? globalProjection.product.value?.update
    : undefined;
  const titleBarUpdateVersion = productUpdate?.type === 'available' || productUpdate?.type === 'install_failed'
    ? productUpdate.updateVersion
    : undefined;
  const state: WorkbenchState = {
    snapshot,
    projectId: runtimeProjectId,
    titleBarState: effectiveTitleBarState,
    resolvedTheme: presentationController.resolvedTheme,
    projectOpen: {
      ...(projectOpenAttemptedPath ? { attemptedPath: projectOpenAttemptedPath } : {}),
      ...(projectOpenError ? { error: projectOpenError } : {}),
      opening: isProjectOpening
    },
    explorerSelection: explorerController?.selection ?? projectTreeSelectionFromPaths([]),
    photoshop: globalProjection.photoshop,
    canvasFeedback: feedbackInteraction.feedback,
    textFileBuffers,
    textEditorWindows,
    notifications
  };

  const openProjectPathTerminalPanel = useCallback((
    scope: AcceptedProjectPathCommandScope,
    cwdProjectRelativePath: string
  ) => {
    if (!scope.canSubmit()) {
      return;
    }
    setRequestedTerminal({ cwdProjectRelativePath, scope });
    setFloatingPanels((current) => openFloatingPanel(current, 'terminal', workbenchViewportRectRef.current));
    setWindowOrder((current) => focusWorkbenchWindow(current, panelWindowIdentity('terminal')));
  }, []);

  const actions: WorkbenchActions = useMemo(() => ({
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
    openProject
  }), [
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
    openProject
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
      openProjectRoot: async (projectRoot) => {
        presentProjectOpenOutcome(await openProjectRoot(projectRoot));
      }
    }).catch((error) => {
      notify(i18n.t('shell.notifications.menuCommandFailed', { message: errorMessage(error) }));
    });
  }, [actions.openProject, i18n, notify, openProjectRoot, presentProjectOpenOutcome]);
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
  const readyPhotoshop = globalProjection.photoshop.status === 'ready'
    ? globalProjection.photoshop.value
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
  const projectPathCommandRouter = useMemo(() => explorerController
    ? createProjectPathCommandRouter({
    commandIntake: projectPathCommandIntake,
    commandEffects: projectPathCommandEffects,
    openTerminalPanel: openProjectPathTerminalPanel,
    menuContext: {
      projection: activeProjection,
      canSelectCanvasNode: Boolean(activeCanvasRuntime),
      fileClipboard,
      photoshop: readyPhotoshop
    },
    commandContext: {
      activeProjection,
      activeCanvasRuntime,
      fileClipboard,
      explorerCommands: explorerController,
      copyText: copyProjectRelativePath,
      notify,
      startNotification,
      photoshopLabels: {
        sending: (path, documentTitle) => i18n.t('shell.notifications.sendingToPhotoshop', {
          path,
          document: documentTitle
        }),
        sent: (path, documentTitle) => i18n.t('shell.notifications.sentToPhotoshopDocument', {
          path,
          document: documentTitle
        }),
        failed: (message) => i18n.t('shell.notifications.sendToPhotoshopFailed', { message })
      },
      closeContextMenu: closeWorkbenchContextMenu,
      openInspectorPanel,
      confirmPermanentDelete,
      getProjectSnapshot: getAcceptedProjectSnapshot,
      confirmMoveOverwrite,
      errorLabels: contextMenuCommandErrorLabels
    }
    })
    : undefined, [
    activeCanvasRuntime,
    activeProjection,
    closeWorkbenchContextMenu,
    confirmMoveOverwrite,
    contextMenuCommandErrorLabels,
    copyProjectRelativePath,
    confirmPermanentDelete,
    fileClipboard,
    getAcceptedProjectSnapshot,
    explorerController,
    notify,
    openProjectPathTerminalPanel,
    openInspectorPanel,
    readyPhotoshop,
    startNotification,
    i18n,
    projectPathCommandEffects,
    projectPathCommandIntake
  ]);
  const handleProjectTreeKeyboardFileCommand = useCallback((command: ProjectTreeFileKeyboardCommand, target: WorkbenchContextMenuTarget) => {
    projectPathCommandRouter?.run(command, {
      target,
      position: { x: 0, y: 0 }
    });
  }, [projectPathCommandRouter]);
  if (connectionEnded && !acceptedProject) {
    return (
      <I18nProvider locale={presentationController.locale}>
        <WorkbenchIconProvider>
          <div className="workbench-shell" data-theme={presentationController.resolvedTheme} data-testid="workbench-shell">
            <WorkbenchTitleBar
              state={effectiveTitleBarState}
              nativeWindowState={nativeWindowState}
              {...(titleBarUpdateVersion ? {
                updateVersion: titleBarUpdateVersion,
                onInstallProductUpdate: installProductUpdateFromTitleBar
              } : {})}
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
      <I18nProvider locale={presentationController.locale}>
        <WorkbenchIconProvider>
          <div className="workbench-shell" data-theme={presentationController.resolvedTheme} data-testid="workbench-shell">
            <WorkbenchTitleBar
              state={effectiveTitleBarState}
              nativeWindowState={nativeWindowState}
              {...(titleBarUpdateVersion ? {
                updateVersion: titleBarUpdateVersion,
                onInstallProductUpdate: installProductUpdateFromTitleBar
              } : {})}
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

  if (productUpdate?.type === 'preparing' || productUpdate?.type === 'committing') {
    const message = productUpdate.type === 'preparing'
      ? i18n.t('shell.productUpdate.preparing')
      : i18n.t('shell.productUpdate.committing');
    return (
      <I18nProvider locale={presentationController.locale}>
        <WorkbenchIconProvider>
          <div className="workbench-shell" data-theme={presentationController.resolvedTheme} data-testid="workbench-shell">
            <WorkbenchTitleBar
              state={effectiveTitleBarState}
              nativeWindowState={nativeWindowState}
              onCommand={handleTitleBarCommand}
              onWindowCommand={handleTitleBarWindowCommand}
            />
            <div className="boot-screen boot-screen--with-titlebar" role="status" aria-live="polite" data-testid="workbench-product-update-blocking">
              <Loader2 className="spin" size={22} />
              <strong>{message}</strong>
              <span>{i18n.t('shell.productUpdate.doNotClose')}</span>
            </div>
          </div>
        </WorkbenchIconProvider>
      </I18nProvider>
    );
  }

  const canvasEditor = (
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
  );
  const profiledCanvasEditor = activeCanvas ? (
    <CanvasTextRenderProfileProvider profile={canvasTextRenderProfile}>
      {canvasEditor}
    </CanvasTextRenderProfileProvider>
  ) : canvasEditor;

  return (
    <>
      {explorerFeatureRequested ? (
        <React.Suspense fallback={null}>
          <WorkbenchExplorerControllerHost
            commandEffects={projectPathCommandEffects}
            getSnapshot={getAcceptedProjectSnapshot}
            activeCanvasRuntime={activeCanvasRuntime}
            centerProjectFileInCanvas={centerActiveCanvasProjectFile}
            notify={notify}
            i18n={i18n}
            onController={setExplorerController}
          />
        </React.Suspense>
      ) : null}
      <I18nProvider locale={presentationController.locale}>
      <WorkbenchIconProvider>
        <div className="workbench-shell" data-theme={presentationController.resolvedTheme} data-testid="workbench-shell">
          <WorkbenchTitleBar
            state={effectiveTitleBarState}
            nativeWindowState={nativeWindowState}
            {...(titleBarUpdateVersion ? {
              updateVersion: titleBarUpdateVersion,
              onInstallProductUpdate: installProductUpdateFromTitleBar
            } : {})}
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
              profiledCanvasEditor
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
                if (panelId === 'settings' && !isOpen) {
                  requestSettingsFeature();
                }
                if (panelId === 'explorer' && !isOpen) {
                  requestExplorerFeature();
                }
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
            {Object.values(textEditorWindows).some((windowState) => windowState.open) ? (
              <CanvasTextRenderProfileGate profile={canvasTextRenderProfile} pending={null}>
                {Object.values(textEditorWindows).filter((windowState) => windowState.open).map((windowState) => (
                  <React.Suspense
                    key={windowState.projectRelativePath}
                    fallback={null}
                  >
                    <WorkbenchFloatingTextEditorWindowFeature
                      locale={presentationController.locale}
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
                  </React.Suspense>
                ))}
              </CanvasTextRenderProfileGate>
            ) : null}
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
                    explorerPanel={explorerController ? (
                      <React.Suspense fallback={<div className="project-tree" aria-busy="true" />}>
                        <WorkbenchExplorerPanelFeature
                          locale={presentationController.locale}
                          state={state}
                          fileClipboard={fileClipboard}
                          inlineProjectTreeEdit={inlineProjectTreeEdit}
                          onEditValueChange={explorerController.updateEditValue}
                          onEditSubmit={() => {
                            const scope = projectPathCommandIntake.tryAccept();
                            if (scope) {
                              void explorerController.submitEdit(scope);
                            }
                          }}
                          onEditCancel={explorerController.cancelEdit}
                          onClearCut={explorerController.clearCut}
                          onExpandProjectDirectory={(projectRelativeDirectory) => {
                            const scope = projectPathCommandIntake.tryAccept();
                            if (scope) {
                              explorerController.loadDirectory(scope, projectRelativeDirectory);
                            }
                          }}
                          onExplorerSelectionChange={explorerController.setSelection}
                          onLocateFileInCanvas={locateProjectFileInCanvas}
                          onProjectTreeInternalDrop={(input) => {
                            const scope = projectPathCommandIntake.tryAccept();
                            if (scope) {
                              explorerController.handleInternalDrop(scope, input);
                            }
                          }}
                          onProjectTreeExternalDrop={(input) => {
                            const scope = projectPathCommandIntake.tryAccept();
                            if (scope) {
                              explorerController.handleExternalDrop(scope, input);
                            }
                          }}
                          onOpenContextMenu={openWorkbenchContextMenu}
                          onCreateRootFile={() => {
                            const scope = projectPathCommandIntake.tryAccept();
                            if (scope) {
                              explorerController.beginCreateFile(scope, '');
                            }
                          }}
                          productPlatform={productPlatform}
                          onKeyboardFileCommand={handleProjectTreeKeyboardFileCommand}
                        />
                      </React.Suspense>
                    ) : <div className="project-tree" aria-busy="true" />}
                    inspectorPanel={(
                      <React.Suspense fallback={<div className="inspector" aria-busy="true" />}>
                        <WorkbenchInspectorPanelFeature
                          locale={presentationController.locale}
                          state={state}
                          activeCanvasId={activeCanvasId}
                          activeCanvasRuntime={activeCanvasRuntime}
                          actions={actions}
                        />
                      </React.Suspense>
                    )}
                    settingsPanel={settingsFeatureController ? (
                      <React.Suspense fallback={<div className="settings-panel" aria-busy="true" />}>
                        <WorkbenchSettingsPanelFeature
                          controller={settingsFeatureController}
                          locale={presentationController.locale}
                          resolvedTheme={presentationController.resolvedTheme}
                        />
                      </React.Suspense>
                    ) : <div className="settings-panel" aria-busy="true" />}
                    terminalPanel={(
                      <React.Suspense fallback={<div className="terminal-panel" aria-busy="true" />}>
                        <TerminalPanel
                          key={runtimeProjectId}
                          api={api}
                          resolvedTheme={presentationController.resolvedTheme}
                          requestedCwdProjectRelativePath={requestedTerminal?.cwdProjectRelativePath ?? null}
                          canSubmitRequestedCwd={canSubmitRequestedTerminal}
                          onRequestedCwdConsumed={consumeRequestedTerminal}
                        />
                      </React.Suspense>
                    )}
                  />
                </WorkbenchFloatingPanelShell>
              ) : null
            ))}
          </div>
          {!projectPresentationBlocked && contextMenu ? (
            <ProjectPathContextMenuHost
              contextMenu={contextMenu}
              router={projectPathCommandRouter}
              runtime={activeCanvasRuntime}
              productPlatform={productPlatform}
              onClose={closeWorkbenchContextMenu}
            />
          ) : null}
        </div>
      </WorkbenchIconProvider>
      </I18nProvider>
    </>
  );
}

export function ProjectPathContextMenuHost({
  contextMenu,
  router,
  runtime,
  productPlatform,
  onClose
}: {
  contextMenu: {
    target: WorkbenchContextMenuTarget;
    position: WorkbenchContextMenuPosition;
  };
  router: ProjectPathCommandRouter | undefined;
  runtime: CanvasEditorRuntime | undefined;
  productPlatform: DebruteProductPlatform;
  onClose(): void;
}): React.ReactElement {
  const canRevealInCanvas = useCanvasSurfaceReady(runtime);
  const items = useMemo(
    () => router?.contextMenuItems(contextMenu.target, canRevealInCanvas) ?? [],
    [canRevealInCanvas, contextMenu.target, router]
  );
  if (!router) {
    return <PendingWorkbenchContextMenuDismissal onClose={onClose} />;
  }
  return (
    <WorkbenchContextMenu
      items={items}
      position={contextMenu.position}
      productPlatform={productPlatform}
      onCommand={(command, photoshopTarget) => router.run(command, contextMenu, photoshopTarget)}
      onClose={onClose}
    />
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
