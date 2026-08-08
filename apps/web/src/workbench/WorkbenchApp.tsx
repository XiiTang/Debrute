import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Loader2 } from './ui/index.js';
import type {
  DebruteProductPlatform,
  DebruteWorkbenchRoute,
  ProjectPathEntry
} from '@debrute/app-protocol';
import {
  DebruteHttpRequestError,
  type HttpWorkbenchApiClient
} from '../api/httpWorkbenchApiClient.js';
import { getDebruteShellApi, type NativeWindowState } from '../api/shellApi';
import { CanvasEditor } from './canvas/CanvasEditor';
import { CanvasMinimapBar } from './canvas/CanvasMinimapBar';
import { CanvasResetLayoutButton } from './canvas/CanvasResetLayoutButton';
import {
  canvasPathAncestors,
  projectCanvasScene,
  raiseCanvasSelection as raiseProjectedCanvasSelection,
  type CanvasProjection
} from './canvas/CanvasScene.js';
import { createCanvasOverlayRuntime } from './canvas/CanvasOverlayRuntime';
import { createCanvasOcclusionMutationLane } from './canvas/CanvasOcclusionMutationLane.js';
import {
  CanvasFeedbackInteractionBar,
  useCanvasFeedbackInteraction
} from './canvas/CanvasFeedbackInteraction';
import type { CanvasEditorRuntime, CanvasRuntimeSnapshot } from './canvas/runtime/CanvasEditorRuntime';
import {
  canvasNodeSelection
} from './canvas/runtime/canvasSelection.js';
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
  createWorkbenchFocusCommandRouter,
  workbenchFocusCommandFromKeyboardEvent,
  workbenchFocusCommandFromMenuCommandId,
  type WorkbenchBehaviorOwner,
  type WorkbenchFocusCommandRouter
} from './services/workbenchFocusCommandRouter.js';
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
import { executeDocumentEditCommand, executeTitleBarMenuCommand } from './shell/workbenchTitleBarCommands.js';
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
import type { WorkbenchProjectProjectionState } from './services/WorkbenchProjectProjection.js';
import {
  projectPathDeletionConfirmationMessageForEntries,
  projectTreeSelectionFromPaths
} from './project-explorer/workbenchFileCommands';
import type { ProjectExplorerController } from './project-explorer/useProjectExplorerController.js';
import {
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
import { WorkbenchActivitySurfaces } from './shell/WorkbenchActivitySurfaces.js';
import {
  scopeWorkbenchActivityNoticeReporter,
  type WorkbenchActivityNoticeReporter
} from './services/WorkbenchActivities.js';
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
import { decideCanvasInteraction } from './canvas/CanvasInteractionPolicy.js';
import { CanvasTextProjectFontEnvironmentProvider } from './canvas/font-subset/CanvasTextProjectFontEnvironment.js';
import { workbenchStartupTimeline } from '../startup/workbenchStartupTimeline.js';

const productPlatform: DebruteProductPlatform = __DEBRUTE_PLATFORM__;

export function shouldWorkbenchClickEndCanvasContentActivation(
  button: number,
  target: EventTarget | null,
  activeProjectRelativePath?: string | undefined
): boolean {
  const contentIslandOwnerPath = target instanceof Element
    ? canvasContentIslandOwnerPath(target)
    : undefined;
  return button === 0
    && target instanceof Element
    && !target.closest('[data-canvas-surface="true"]')
    && (contentIslandOwnerPath === undefined || contentIslandOwnerPath !== activeProjectRelativePath);
}

function canvasContentIslandOwnerPath(target: Element): string | undefined {
  const island = target.closest<HTMLElement>('[data-canvas-node-zone="content-island"]');
  return island?.closest<HTMLElement>('[data-canvas-node-path]')?.dataset.canvasNodePath;
}

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

type WorkbenchBoundProjectApi = Omit<HttpWorkbenchApiClient, ProjectPathEffectApiName>;

export function WorkbenchApp({
  api,
  onCommitted
}: {
  api: HttpWorkbenchApiClient;
  onCommitted?: () => void;
}): React.ReactElement {
  const initialRoute = useMemo<DebruteWorkbenchRoute>(() => {
    const initialProjectRoot = api.initialProjectRoot();
    return initialProjectRoot
      ? { kind: 'project-open', projectRoot: initialProjectRoot }
      : currentDebruteWorkbenchRoute();
  }, [api]);
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
  const [isLoading, setIsLoading] = useState(() => shouldShowInitialProjectLoader(initialRoute));
  const [projectOpenPresentation, setProjectOpenPresentation] = useState<ProjectOpenPresentation>({});
  const initialProjectOpeningRef = useRef<ReturnType<ProjectBindingLifecycle['open']> | undefined>(undefined);
  const announcedProjectBindingsRef = useRef(new Set<number>());
  const presentationController = useWorkbenchPresentationController({
    globalProjection: api.globalProjection
  });
  useLayoutEffect(() => {
    workbenchStartupTimeline.mark('react-committed');
    onCommitted?.();
  }, [onCommitted]);
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
  const announceProjectBinding = useCallback((input: { bindingGeneration: number }) => {
    if (announcedProjectBindingsRef.current.has(input.bindingGeneration)) {
      return;
    }
    announcedProjectBindingsRef.current.add(input.bindingGeneration);
    void api.reportActivityNotice({ kind: 'project-opened' }).catch(() => undefined);
  }, [api]);

  useEffect(() => api.onConnectionEnded(setConnectionEnded), []);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const resolution = resolveInitialProjectRoute(initialRoute);
        const initialError = localizedProjectOpenError(
          resolution.projectOpen?.error,
          presentationController.getCurrentI18n()
        );
        setProjectOpenPresentation({
          ...(resolution.projectOpen?.attemptedPath
            ? { attemptedPath: resolution.projectOpen.attemptedPath }
            : {}),
          ...(initialError ? { error: initialError } : {})
        });
        if (!resolution.target) {
          return;
        }
        initialProjectOpeningRef.current ??= projectBindingLifecycle.open(resolution.target);
        const result = await initialProjectOpeningRef.current;
        if (disposed) {
          return;
        }
        if (result.outcome === 'failed') {
          const attemptedPath = projectRootFromOpenError(result.error)
            ?? resolution.projectOpen?.attemptedPath;
          const error: ProjectOpenStartupError = {
            code: 'project-open-failed',
            message: result.error.message
          };
          const localizedError = localizedProjectOpenError(
            error,
            presentationController.getCurrentI18n()
          );
          setProjectOpenPresentation({
            ...(attemptedPath ? { attemptedPath } : {}),
            ...(localizedError ? { error: localizedError } : {})
          });
        }
      } catch (error) {
        if (!disposed) {
          setProjectOpenPresentation((current) => ({
            ...(current.attemptedPath ? { attemptedPath: current.attemptedPath } : {}),
            error: presentationController.getCurrentI18n().t('shell.boot.projectStartupFailed', {
              message: errorMessage(error)
            })
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
  }, [initialRoute, presentationController.getCurrentI18n, projectBindingLifecycle]);

  const boundProjectAppProps = {
    api,
    projectPathCommandEffects,
    canvasTextRenderProfile,
    projectProjection,
    connectionEnded,
    announceProjectBinding,
    presentationController,
    settingsFeatureController,
    requestSettingsFeature,
    i18n,
    isLoading,
    projectOpenPresentation,
    setProjectOpenPresentation,
    projectBindingLifecycle,
    isProjectOpening: projectBindingLifecycleState.opening
  };
  const boundProjectApp = <WorkbenchBoundProjectApp {...boundProjectAppProps} />;
  const surface = projectProjection.status === 'unbound' ? (
    <CanvasTextProjectFontEnvironmentProvider profile={canvasTextRenderProfile}>
      {boundProjectApp}
    </CanvasTextProjectFontEnvironmentProvider>
  ) : (
    <CanvasTextProjectFontEnvironmentProvider
      key={projectProjection.generation}
      profile={canvasTextRenderProfile}
    >
      {boundProjectApp}
    </CanvasTextProjectFontEnvironmentProvider>
  );
  return (
    <>
      {surface}
      {settingsFeatureRequested ? (
        <React.Suspense fallback={null}>
          <WorkbenchSettingsFeatureHost
            api={api}
            onController={setSettingsFeatureController}
          />
        </React.Suspense>
      ) : null}
    </>
  );
}

function WorkbenchBoundProjectApp({
  api,
  projectPathCommandEffects,
  canvasTextRenderProfile,
  projectProjection,
  connectionEnded,
  announceProjectBinding,
  presentationController,
  settingsFeatureController,
  requestSettingsFeature,
  i18n,
  isLoading,
  projectOpenPresentation,
  setProjectOpenPresentation,
  projectBindingLifecycle,
  isProjectOpening
}: {
  api: WorkbenchBoundProjectApi;
  projectPathCommandEffects: ProjectPathCommandEffects;
  canvasTextRenderProfile: ReturnType<typeof canvasTextRenderProfileForAppearance>;
  projectProjection: WorkbenchProjectProjectionState;
  connectionEnded: Error | undefined;
  announceProjectBinding(input: { bindingGeneration: number }): void;
  presentationController: WorkbenchPresentationController;
  settingsFeatureController: WorkbenchSettingsController | undefined;
  requestSettingsFeature(): void;
  i18n: WorkbenchI18n;
  isLoading: boolean;
  projectOpenPresentation: ProjectOpenPresentation;
  setProjectOpenPresentation: React.Dispatch<React.SetStateAction<ProjectOpenPresentation>>;
  projectBindingLifecycle: ProjectBindingLifecycle;
  isProjectOpening: boolean;
}): React.ReactElement {
  const projectOpenAttemptedPath = projectOpenPresentation.attemptedPath;
  const projectOpenError = projectOpenPresentation.error;
  const activityBellRef = useRef<HTMLButtonElement>(null);
  const activitySnapshot = useSyncExternalStore(
    api.activities.subscribe,
    api.activities.getSnapshot,
    api.activities.getSnapshot
  );
  const toggleActivityCenter = useCallback(() => {
    if (api.activities.getSnapshot().centerPresentation === 'open') {
      api.activities.closeCenter();
    } else {
      api.activities.openCenter();
    }
  }, [api.activities]);
  const titleBarActivityProps = {
    activityCenterOpen: activitySnapshot.centerPresentation === 'open',
    activityBellRef,
    onToggleActivityCenter: toggleActivityCenter,
    onCloseActivityCenter: api.activities.closeCenter
  };
  const globalActivities = useMemo<WorkbenchActivityNoticeReporter>(() => ({
    report: (input) => {
      void api.reportActivityNotice(input).catch(() => undefined);
    }
  }), [api]);
  const projectActivities = useMemo(() => scopeWorkbenchActivityNoticeReporter(
    globalActivities,
    () => {
      const current = api.projectProjection.getState();
      return current.status !== 'unbound'
        && current.generation === projectProjection.generation;
    }
  ), [api.projectProjection, globalActivities, projectProjection.generation]);
  const installProductUpdateFromTitleBar = useCallback(() => {
    void api.applyProductUpdate().catch(() => {
      globalActivities.report({ kind: 'update-install-failed' });
    });
  }, [api, globalActivities]);
  const acceptedProject = projectProjection.status === 'unbound' ? undefined : projectProjection;
  const hasAcceptedProject = acceptedProject !== undefined;
  const snapshot = acceptedProject?.snapshot;
  const runtimeBindingId = acceptedProject?.bindingId;
  const canonicalRoot = acceptedProject?.canonicalRoot;
  const projectDetached = projectProjection.status === 'detached';
  const projectOpenFailureBlocking = Boolean(hasAcceptedProject && projectOpenError);
  const projectPresentationBlocked = Boolean(
    connectionEnded || projectDetached || projectOpenFailureBlocking
  );
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
  const [resettingCanvas, setResettingCanvas] = useState(false);
  const [canvasResetError, setCanvasResetError] = useState<string>();
  const [mountedCanvasRuntime, setMountedCanvasRuntime] = useState<CanvasEditorRuntime>();
  const focusCommandRouterRef = useRef<WorkbenchFocusCommandRouter | undefined>(undefined);
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
  const canvasOcclusionMutationLane = useMemo(() => createCanvasOcclusionMutationLane(), []);
  const enqueueCanvasOcclusionMutation = useCallback(<Result,>(
    mutation: (
      accepted: Extract<WorkbenchProjectProjectionState, { status: 'bound' }>
    ) => Promise<Result>
  ): Promise<Result> => {
    const generation = projectProjection.generation;
    return canvasOcclusionMutationLane.run(async () => {
      const accepted = api.projectProjection.getState();
      if (accepted.status !== 'bound' || accepted.generation !== generation) {
        throw new Error('Canvas mutation belongs to an inactive Project.');
      }
      return mutation(accepted);
    });
  }, [api.projectProjection, canvasOcclusionMutationLane, projectProjection.generation]);
  const workbenchViewportRectRef = useRef(workbenchViewportRect);
  const textFileBuffersRef = useRef(textFileBuffers);
  const textEditorWindowsRef = useRef(textEditorWindows);
  const availableCanvasWorkspace = snapshot?.canvasWorkspace.status === 'available'
    ? snapshot.canvasWorkspace
    : undefined;
  const canvasState = availableCanvasWorkspace?.workspace;
  const canvasRuntime = mountedCanvasRuntime;
  const handleWorkbenchCompletedClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!canvasRuntime) {
      return;
    }
    const snapshot = canvasRuntime.getSnapshot();
    if (!shouldWorkbenchClickEndCanvasContentActivation(
      event.button,
      event.target,
      snapshot.contentInteractionProjectRelativePath
    )) {
      return;
    }
    const decision = decideCanvasInteraction({
      event: 'completed-click',
      target: { kind: 'workbench' },
      selection: snapshot.selection,
      contentActivationProjectRelativePath: snapshot.contentInteractionProjectRelativePath,
      additive: false
    });
    if (decision.state.kind === 'end-content-activation') {
      canvasRuntime.endContentActivation();
    }
  }, [canvasRuntime]);
  const canvasScene = useMemo(() => (
    canvasState
    && availableCanvasWorkspace
    && canonicalRoot
      ? projectCanvasScene({
          canonicalRoot,
          resources: availableCanvasWorkspace.canvasResources,
          state: canvasState
        })
      : undefined
  ), [availableCanvasWorkspace, canonicalRoot, canvasState]);
  const canvasProjection = canvasScene?.projection;
  const canvas = useMemo(() => (
    canvasState && canvasProjection
      ? { state: canvasState, projection: canvasProjection }
      : undefined
  ), [canvasProjection, canvasState]);
  const visibleCanvasPathsRef = useRef<Set<string> | undefined>(undefined);
  useEffect(() => {
    if (!canvasState || !canvasScene) {
      visibleCanvasPathsRef.current = undefined;
      return;
    }
    const visiblePaths = new Set(
      canvasScene.projection.nodes.map((node) => node.projectRelativePath)
    );
    const previous = visibleCanvasPathsRef.current;
    visibleCanvasPathsRef.current = visiblePaths;
    const newlyVisible = previous
      ? [...visiblePaths].filter((path) => !previous.has(path))
      : [];
    const currentOcclusionOrder = newlyVisible.length === 0
      ? canvasScene.occlusionOrder
      : raiseProjectedCanvasSelection(
          canvasScene.occlusionOrder,
          canvasScene.projection.nodes,
          newlyVisible
        );
    if (equalStringArrays(canvasState.occlusionOrder, currentOcclusionOrder)) {
      return;
    }
    void enqueueCanvasOcclusionMutation(async (accepted) => {
      const context = canvasMutationContext(accepted);
      const scene = projectCanvasScene({
        canonicalRoot: accepted.canonicalRoot,
        resources: context.resources,
        state: context.state
      });
      const currentVisiblePaths = new Set(
        scene.projection.nodes.map((node) => node.projectRelativePath)
      );
      const currentlyNew = newlyVisible.filter((path) => currentVisiblePaths.has(path));
      const occlusionOrder = currentlyNew.length === 0
        ? scene.occlusionOrder
        : raiseProjectedCanvasSelection(
            scene.occlusionOrder,
            scene.projection.nodes,
            currentlyNew
          );
      if (equalStringArrays(context.state.occlusionOrder, occlusionOrder)) {
        return;
      }
      await api.patchCanvasState({ occlusionOrder });
    }).catch(() => projectActivities.report({
      kind: 'canvas-operation-failed',
      operation: 'raise-selection'
    }));
  }, [api, canvasScene, canvasState, enqueueCanvasOcclusionMutation, projectActivities]);
  const centerCanvasProjectionNode = useCallback((
    projection: CanvasProjection | undefined,
    projectRelativePath: string
  ) => {
    const node = projection?.nodes.find((item) => item.projectRelativePath === projectRelativePath);
    const runtimeSnapshot = canvasRuntime?.getSnapshot();
    if (!node || !canvasRuntime || !runtimeSnapshot?.surfaceSize) {
      return;
    }
    canvasRuntime.setSelection(canvasNodeSelection([projectRelativePath]));
    canvasRuntime.camera.setCamera(cameraCenteredOnNode({
      node,
      surfaceSize: runtimeSnapshot.surfaceSize,
      camera: runtimeSnapshot.camera
    }));
  }, [canvasRuntime]);
  const locateProjectFileInCanvas = useCallback(async (projectRelativePath: string) => {
    const scope = projectPathCommandIntake.tryAccept();
    if (!scope) {
      return;
    }
    try {
      const acceptedBefore = api.projectProjection.getState();
      const snapshotBefore = acceptedBefore.status === 'unbound'
        ? undefined
        : acceptedBefore.snapshot;
      const workspaceBefore = snapshotBefore?.canvasWorkspace.status === 'available'
        ? snapshotBefore.canvasWorkspace.workspace
        : undefined;
      if (!workspaceBefore) {
        return;
      }
      const expandedDirectories = Array.from(new Set([
        ...workspaceBefore.expandedDirectories,
        ...canvasPathAncestors(projectRelativePath)
      ]));
      await api.patchCanvasState({ expandedDirectories });
      if (!scope.isCurrent()) {
        return;
      }
      const accepted = api.projectProjection.getState();
      const latestSnapshot = accepted.status === 'unbound' ? undefined : accepted.snapshot;
      const latestWorkspace = latestSnapshot?.canvasWorkspace.status === 'available'
        ? latestSnapshot.canvasWorkspace
        : undefined;
      const projection = latestWorkspace && canonicalRoot
        ? projectCanvasScene({
            canonicalRoot,
            resources: latestWorkspace.canvasResources,
            state: latestWorkspace.workspace
          }).projection
        : undefined;
      centerCanvasProjectionNode(projection, projectRelativePath);
      document.querySelector<HTMLElement>('[data-testid="canvas-surface"]')?.focus({ preventScroll: true });
    } catch {
      if (scope.isCurrent()) {
        projectActivities.report({ kind: 'canvas-operation-failed', operation: 'reveal-path' });
      }
    }
  }, [api, canonicalRoot, centerCanvasProjectionNode, projectActivities, projectPathCommandIntake]);
  const getAcceptedProjectSnapshot = useCallback(() => {
    const state = api.projectProjection.getState();
    return state.status === 'unbound' ? undefined : state.snapshot;
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
  const canvasCutPaths = useMemo(() => (
    fileClipboard?.operation === 'cut'
      ? fileClipboard.entries.map((entry) => entry.projectRelativePath)
      : []
  ), [fileClipboard]);
  const inlineProjectTreeEdit = explorerController?.inlineEdit;

  const notifyCanvasFeedbackUnavailable = useCallback((_message: string) => {
    projectActivities.report({
      kind: 'canvas-operation-failed',
      operation: 'feedback-unavailable'
    });
  }, [projectActivities]);
  const notifyCanvasFeedbackSaveFailed = useCallback((_message: string) => {
    projectActivities.report({
      kind: 'canvas-operation-failed',
      operation: 'feedback-save'
    });
  }, [projectActivities]);
  const feedbackInteraction = useCanvasFeedbackInteraction({
    api,
    bindingId: runtimeBindingId,
    overlayRuntime: canvasOverlayRuntime,
    notifyUnavailable: notifyCanvasFeedbackUnavailable,
    notifySaveFailed: notifyCanvasFeedbackSaveFailed
  });

  useEffect(() => {
    if (!acceptedProject) {
      return;
    }
    announceProjectBinding({
      bindingGeneration: acceptedProject.generation
    });
    setProjectOpenPresentation({});
    feedbackInteraction.restoreWorkingCopies(acceptedProject.workingCopies.feedback);
    void feedbackInteraction.load();
  }, [acceptedProject?.generation]);

  const reopenDetachedProject = useCallback(async () => {
    if (!canonicalRoot) {
      return;
    }
    setProjectOpenPresentation({});
    const outcome = await projectBindingLifecycle.open({ projectRoot: canonicalRoot });
    if (outcome.outcome === 'failed') {
      setProjectOpenPresentation(projectOpenPresentationFromFailure(outcome.error, i18n));
    }
  }, [canonicalRoot, i18n, projectBindingLifecycle, setProjectOpenPresentation]);

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
    }).catch(() => {
      globalActivities.report({
        kind: 'workbench-operation-failed',
        operation: 'window-state'
      });
    });
    return shell.onNativeWindowStateChanged((state) => {
      setNativeWindowState(state);
      reconcileCurrentWorkbenchViewportLayout();
    });
  }, [globalActivities, reconcileCurrentWorkbenchViewportLayout]);

  useEffect(() => {
    if (!canonicalRoot) {
      return;
    }
    saveProjectViewState({
      storage: window.sessionStorage,
      canonicalRoot,
      state: { floatingPanels }
    });
  }, [canonicalRoot, floatingPanels]);

  const {
    ensureTextFileBuffer,
    updateTextFileBuffer,
    saveTextFileBuffer,
    discardTextFileBuffer,
    reloadTextFileBuffer,
    refreshTextFileBuffer
  } = useTextFileBufferActions({
    api,
    bindingId: runtimeBindingId,
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
        if (event.event.projectRelativePath === '.debrute/feedback/feedback.json') {
          void feedbackInteraction.load();
        }
      }
    });
  }, [
    feedbackInteraction.applyEvent,
    feedbackInteraction.load,
    refreshTextFileBuffer
  ]);

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

  const updateCanvasTextViewportState = useCallback<WorkbenchActions['updateCanvasTextViewportState']>(async (input) => {
    try {
      await api.patchCanvasState({
        nodeStateUpdates: input.updates.map((update) => ({
          projectRelativePath: update.projectRelativePath,
          textViewport: { scrollTop: update.scrollTop, scrollLeft: update.scrollLeft }
        }))
      });
    } catch (error) {
      projectActivities.report({
        kind: 'canvas-operation-failed',
        operation: 'save-text-viewport'
      });
      throw error;
    }
  }, [api, projectActivities]);

  const updateCanvasNodeLayouts = useCallback<WorkbenchActions['updateCanvasNodeLayouts']>(async (input) => {
    try {
      await enqueueCanvasOcclusionMutation(async (accepted) => {
        const context = canvasMutationContext(accepted);
        const nextState = {
          ...context.state,
          nodeStates: { ...context.state.nodeStates }
        };
        for (const layout of input.nodeLayouts) {
          nextState.nodeStates[layout.projectRelativePath] = {
            ...nextState.nodeStates[layout.projectRelativePath],
            manualLayout: {
              x: layout.x,
              y: layout.y,
              width: layout.width,
              height: layout.height
            }
          };
        }
        const projection = projectCanvasScene({
          canonicalRoot: accepted.canonicalRoot,
          resources: context.resources,
          state: nextState
        }).projection;
        await api.patchCanvasState({
          occlusionOrder: raiseProjectedCanvasSelection(
            context.state.occlusionOrder,
            projection.nodes,
            input.selectedProjectRelativePaths
          ),
          nodeStateUpdates: input.nodeLayouts.map((layout) => ({
            projectRelativePath: layout.projectRelativePath,
            manualLayout: {
              x: layout.x,
              y: layout.y,
              width: layout.width,
              height: layout.height
            }
          }))
        });
      });
    } catch (error) {
      projectActivities.report({
        kind: 'canvas-operation-failed',
        operation: 'save-layout'
      });
      throw error;
    }
  }, [api, enqueueCanvasOcclusionMutation, projectActivities]);

  const resetCanvasNodeLayouts = useCallback<WorkbenchActions['resetCanvasNodeLayouts']>(async (input) => {
    await enqueueCanvasOcclusionMutation(async (accepted) => {
      const context = canvasMutationContext(accepted);
      const nodePaths = 'all' in input
        ? Object.entries(context.state.nodeStates)
            .filter(([, nodeState]) => nodeState.manualLayout !== undefined)
            .map(([path]) => path)
        : input.nodePaths;
      const nextState = {
        ...context.state,
        nodeStates: { ...context.state.nodeStates }
      };
      for (const path of nodePaths) {
        const current = nextState.nodeStates[path];
        if (!current) {
          continue;
        }
        const { manualLayout: _manualLayout, ...remaining } = current;
        if (Object.keys(remaining).length === 0) {
          delete nextState.nodeStates[path];
        } else {
          nextState.nodeStates[path] = remaining;
        }
      }
      const scene = projectCanvasScene({
        canonicalRoot: accepted.canonicalRoot,
        resources: context.resources,
        state: nextState
      });
      await api.patchCanvasState({
        occlusionOrder: scene.occlusionOrder,
        nodeStateUpdates: nodePaths.map((projectRelativePath) => ({
          projectRelativePath,
          manualLayout: null
        }))
      });
    });
  }, [api, enqueueCanvasOcclusionMutation]);

  const updateCanvasVideoPlaybackState = useCallback<WorkbenchActions['updateCanvasVideoPlaybackState']>(async (input) => {
    try {
      await api.patchCanvasState({
        nodeStateUpdates: input.updates.map((update) => ({
          projectRelativePath: update.projectRelativePath,
          videoPlayback: { currentTimeMs: update.currentTimeMs }
        }))
      });
    } catch (error) {
      projectActivities.report({
        kind: 'canvas-operation-failed',
        operation: 'save-video-playback'
      });
      throw error;
    }
  }, [api, projectActivities]);

  const setCanvasDirectoryExpanded = useCallback<WorkbenchActions['setCanvasDirectoryExpanded']>(async (input) => {
    try {
      const accepted = api.projectProjection.getState();
      const acceptedSnapshot = accepted.status === 'unbound' ? undefined : accepted.snapshot;
      const workspace = acceptedSnapshot?.canvasWorkspace.status === 'available'
        ? acceptedSnapshot.canvasWorkspace.workspace
        : undefined;
      if (!workspace) {
        throw new Error('Canvas is unavailable.');
      }
      const current = workspace.expandedDirectories;
      const expandedDirectories = input.expanded
        ? Array.from(new Set([...current, input.projectRelativePath]))
        : current.filter((path) => path !== input.projectRelativePath);
      await api.patchCanvasState({ expandedDirectories });
    } catch {
      projectActivities.report({
        kind: 'canvas-operation-failed',
        operation: 'set-directory-disclosure'
      });
    }
  }, [api, projectActivities]);

  const raiseCanvasSelection = useCallback<WorkbenchActions['raiseCanvasSelection']>(async (input) => {
    try {
      await enqueueCanvasOcclusionMutation(async (accepted) => {
        const context = canvasMutationContext(accepted);
        const scene = projectCanvasScene({
          canonicalRoot: accepted.canonicalRoot,
          resources: context.resources,
          state: context.state
        });
        await api.patchCanvasState({
          occlusionOrder: raiseProjectedCanvasSelection(
            context.state.occlusionOrder,
            scene.projection.nodes,
            input.projectRelativePaths
          )
        });
      });
    } catch (error) {
      projectActivities.report({
        kind: 'canvas-operation-failed',
        operation: 'raise-selection'
      });
      throw error;
    }
  }, [api, enqueueCanvasOcclusionMutation, projectActivities]);

  const presentProjectOpenFailure = useCallback((failure: Error, attemptedPath?: string) => {
    if (hasAcceptedProject) {
      projectActivities.report({
        kind: 'project-operation-failed',
        operation: 'open'
      });
    }
    setProjectOpenPresentation(projectOpenPresentationFromFailure(failure, i18n, attemptedPath));
  }, [hasAcceptedProject, i18n, projectActivities, setProjectOpenPresentation]);

  const presentProjectOpenOutcome = useCallback((
    outcome: ProjectBindingLifecycleOutcome,
    attemptedPath?: string
  ) => {
    if (outcome.outcome === 'failed') {
      presentProjectOpenFailure(outcome.error, attemptedPath);
    }
  }, [presentProjectOpenFailure]);

  const openProject = useCallback<WorkbenchActions['openProject']>(async () => {
    const shell = getDebruteShellApi();
    if (shell) {
      setProjectOpenPresentation({});
      try {
        await shell.executeNativeMenuCommand({ commandId: 'project.open-picker' });
        setProjectOpenPresentation({});
      } catch (error) {
        presentProjectOpenFailure(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    setProjectOpenPresentation({});
    try {
      const projectRoot = await api.chooseProjectRoot();
      if (!projectRoot) {
        return;
      }
      setProjectOpenPresentation({ attemptedPath: projectRoot });
      presentProjectOpenOutcome(await projectBindingLifecycle.open({ projectRoot }));
    } catch (error) {
      presentProjectOpenFailure(error instanceof Error ? error : new Error(String(error)));
    }
  }, [api, presentProjectOpenFailure, presentProjectOpenOutcome, projectBindingLifecycle, setProjectOpenPresentation]);

  const openProjectRoot = useCallback(async (projectRoot: string): Promise<ProjectBindingLifecycleOutcome> => {
    setProjectOpenPresentation({ attemptedPath: projectRoot });
    return projectBindingLifecycle.open({ projectRoot });
  }, [projectBindingLifecycle, setProjectOpenPresentation]);

  useEffect(() => getDebruteShellApi()?.onNativeProjectOpenRequested((projectRoot) => {
    void openProjectRoot(projectRoot).then((outcome) => {
      presentProjectOpenOutcome(outcome, projectRoot);
    });
  }), [openProjectRoot, presentProjectOpenOutcome]);

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

  const effectiveTitleBarState = useMemo(() => buildWorkbenchTitleBarState({
    platform: productPlatform,
    host: getDebruteShellApi() ? 'desktop' : 'web',
    locale: presentationController.locale,
    projectTitle: snapshot?.health.projectName,
    recentProjects: presentationController.settings.chrome.recentProjectRoots.map((projectRoot) => ({ projectRoot }))
  }), [presentationController.locale, presentationController.settings.chrome.recentProjectRoots, snapshot?.health.projectName]);
  const disabledFloatingPanelIds = useMemo<readonly FloatingPanelId[]>(() => (
    runtimeBindingId ? [] : ['terminal']
  ), [runtimeBindingId]);

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
    canvasProjection,
    bindingId: runtimeBindingId,
    canonicalRoot,
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
    lookupModelArtifactProvenance: api.lookupModelArtifactProvenance,
    readProjectTextFile: api.readProjectTextFile,
    writeProjectTextFile: api.writeProjectTextFile,
    saveCanvasTextPreviewSource: api.saveCanvasTextPreviewSource,
    readCanvasTextPreviewSources: api.readCanvasTextPreviewSources,
    probeCanvasVideoPreviewSources: api.probeCanvasVideoPreviewSources,
    ensureCanvasVideoPreviewSource: api.ensureCanvasVideoPreviewSource,
    ensureTextFileBuffer,
    updateTextFileBuffer,
    saveTextFileBuffer,
    discardTextFileBuffer,
    reloadTextFileBuffer,
    openTextEditorWindow,
    toggleTextFileWordWrap,
    updateCanvasNodeLayouts,
    resetCanvasNodeLayouts,
    updateCanvasVideoPlaybackState,
    updateCanvasTextViewportState,
    setCanvasDirectoryExpanded,
    raiseCanvasSelection,
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
    updateCanvasVideoPlaybackState,
    updateCanvasTextViewportState,
    setCanvasDirectoryExpanded,
    raiseCanvasSelection,
    openProject
  ]);
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
  const handleTitleBarCommand = useCallback((
    item: Extract<WorkbenchMenuItem, { kind: 'command' }>,
    owner?: WorkbenchBehaviorOwner
  ) => {
    const focusCommand = workbenchFocusCommandFromMenuCommandId(item.commandId);
    if (focusCommand && focusCommandRouterRef.current?.dispatch(focusCommand, owner)) {
      return;
    }
    void executeTitleBarMenuCommand(item, {
      api,
      shell: getDebruteShellApi(),
      openProjectFromPicker: actions.openProject,
      openProjectRoot: async (projectRoot) => {
        presentProjectOpenOutcome(await openProjectRoot(projectRoot));
      }
    }).catch(() => {
      globalActivities.report({
        kind: 'workbench-operation-failed',
        operation: 'menu-command'
      });
    });
  }, [actions.openProject, globalActivities, openProjectRoot, presentProjectOpenFailure, presentProjectOpenOutcome]);
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
    }).catch(() => globalActivities.report({
      kind: 'workbench-operation-failed',
      operation: 'window-command'
    }));
  }, [globalActivities, reconcileCurrentWorkbenchViewportLayout]);

  const minimapButtonRect = canvasMinimapButtonRect(workbenchViewportRect);
  const minimapPanelPlacement = placeCanvasMinimapPanel({
    buttonRect: minimapButtonRect,
    viewportRect: workbenchViewportRect
  });
  const resetLayoutButtonRect = canvasState
    ? canvasResetLayoutButtonRect(workbenchViewportRect)
    : undefined;
  const floatingBarReservedRects = [
    TITLE_BAR_RESERVED_RECT(workbenchViewportRect.width),
    ...FIXED_TOP_FLOATING_BAR_RECTS,
    minimapButtonRect,
    ...(resetLayoutButtonRect ? [resetLayoutButtonRect] : []),
    ...(canvasMinimapOpen ? [minimapPanelPlacement] : [])
  ];
  useEffect(() => {
    const target = feedbackInteraction.currentTarget;
    if (!canvasRuntime || !target) {
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
    syncFeedbackBarPlacement(canvasRuntime.camera.getCamera());
    return canvasRuntime.subscribeCamera(syncFeedbackBarPlacement);
  }, [
    canvasRuntime,
    canvasOverlayRuntime,
    feedbackInteraction.currentTarget,
    floatingBarReservedRects,
    workbenchViewportRect
  ]);
  const canResetCanvasLayout = Boolean(canvasProjection?.nodes.some((node) => node.layoutMode === 'manual'));
  const resetCanvasLayout = useCallback(() => {
    void actions.resetCanvasNodeLayouts({ all: true }).catch(() => {
      projectActivities.report({
        kind: 'canvas-operation-failed',
        operation: 'reset-layout'
      });
    });
  }, [actions, projectActivities]);
  const readyPhotoshop = globalProjection.photoshop.status === 'ready'
    ? globalProjection.photoshop.value
    : undefined;
  const permanentDeleteConfirmationLabels = useMemo(() => ({
    directory: (path: string) => i18n.t('shell.confirm.permanentDeleteDirectory', { path }),
    file: (path: string) => i18n.t('shell.confirm.permanentDeleteFile', { path }),
    selectedItems: (count: number) => i18n.t('shell.confirm.permanentDeleteSelected', { count })
  }), [i18n]);
  const confirmPermanentDelete = useCallback((input: { entries: Array<{ projectRelativePath: string; kind: 'file' | 'directory' }> }) => (
    window.confirm(projectPathDeletionConfirmationMessageForEntries(input, permanentDeleteConfirmationLabels))
  ), [permanentDeleteConfirmationLabels]);
  const trashConfirmationLabels = useMemo(() => ({
    directory: (path: string) => i18n.t('shell.confirm.trashDirectory', { path }),
    file: (path: string) => i18n.t('shell.confirm.trashFile', { path }),
    selectedItems: (count: number) => i18n.t('shell.confirm.trashSelected', { count })
  }), [i18n]);
  const confirmTrash = useCallback((input: { entries: Array<{ projectRelativePath: string; kind: 'file' | 'directory' }> }) => (
    window.confirm(projectPathDeletionConfirmationMessageForEntries(input, trashConfirmationLabels))
  ), [trashConfirmationLabels]);
  const confirmMoveOverwrite = useCallback((input: {
    entries: ProjectPathEntry[];
    targetDirectoryProjectRelativePath: string;
  }) => (
    window.confirm(i18n.t('shell.confirm.moveOverwrite', {
      target: input.targetDirectoryProjectRelativePath || i18n.t('shell.confirm.projectRoot')
    }))
  ), [i18n]);
  const projectPathCommandRouter = useMemo(() => explorerController
    ? createProjectPathCommandRouter({
    commandIntake: projectPathCommandIntake,
    commandEffects: projectPathCommandEffects,
    openTerminalPanel: openProjectPathTerminalPanel,
    menuContext: {
      projection: canvasProjection,
      fileClipboard,
      photoshop: readyPhotoshop
    },
    commandContext: {
      canvasProjection,
      canvasRuntime,
      fileClipboard,
      revealInCanvas: (projectRelativePath) => {
        void locateProjectFileInCanvas(projectRelativePath);
      },
      explorerCommands: explorerController,
      activities: projectActivities,
      closeContextMenu: closeWorkbenchContextMenu,
      openInspectorPanel,
      confirmPermanentDelete,
      confirmTrash,
      getProjectSnapshot: getAcceptedProjectSnapshot,
      resetCanvasNodeLayouts: (nodePaths) => (
        resetCanvasNodeLayouts({ nodePaths })
      ),
      confirmMoveOverwrite,
    }
    })
    : undefined, [
    canvasRuntime,
    canvasProjection,
    closeWorkbenchContextMenu,
    confirmMoveOverwrite,
    confirmTrash,
    confirmPermanentDelete,
    fileClipboard,
    getAcceptedProjectSnapshot,
    explorerController,
    locateProjectFileInCanvas,
    projectActivities,
    openProjectPathTerminalPanel,
    openInspectorPanel,
    readyPhotoshop,
    resetCanvasNodeLayouts,
    projectPathCommandEffects,
    projectPathCommandIntake
  ]);
  const focusCommandRouter = useMemo(() => createWorkbenchFocusCommandRouter({
    getRuntime: () => canvasRuntime,
    getProjection: () => canvasProjection,
    getCanvasRoot: () => document.querySelector<HTMLElement>('[data-testid="canvas-surface"]'),
    getProjectPathRouter: () => projectPathCommandRouter,
    getExplorerController: () => explorerController
  }), [canvasRuntime, canvasProjection, explorerController, projectPathCommandRouter]);
  focusCommandRouterRef.current = focusCommandRouter;
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) {
        return;
      }
      const command = workbenchFocusCommandFromKeyboardEvent(event, productPlatform);
      if (!command || !focusCommandRouter.dispatch(command)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [focusCommandRouter, productPlatform]);
  useEffect(() => {
    const shell = getDebruteShellApi();
    return shell?.onNativeEditCommand((commandId) => {
      const command = workbenchFocusCommandFromMenuCommandId(commandId);
      if (command && focusCommandRouter.dispatch(command)) {
        return;
      }
      executeDocumentEditCommand(commandId);
    });
  }, [focusCommandRouter]);
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
              {...titleBarActivityProps}
              state={effectiveTitleBarState}
              nativeWindowState={nativeWindowState}
              {...(titleBarUpdateVersion ? {
                updateVersion: titleBarUpdateVersion,
                onInstallProductUpdate: installProductUpdateFromTitleBar
              } : {})}
              onCommand={handleTitleBarCommand}
              onCaptureBehaviorOwner={() => focusCommandRouter.captureOwner()}
              onWindowCommand={handleTitleBarWindowCommand}
            />
            <WorkbenchActivitySurfaces
              activities={api.activities}
              activityBellRef={activityBellRef}
              interactionBlocked
            />
            <div className="boot-screen boot-screen--with-titlebar boot-screen--blocking" role="alert" data-testid="workbench-connection-ended">
              <strong>Debrute Runtime connection ended.</strong>
              <span>{connectionEnded.message}</span>
              <span>No Project view was accepted before the connection ended.</span>
              <span>Reloading creates a new Workbench connection.</span>
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
              {...titleBarActivityProps}
              state={effectiveTitleBarState}
              nativeWindowState={nativeWindowState}
              {...(titleBarUpdateVersion ? {
                updateVersion: titleBarUpdateVersion,
                onInstallProductUpdate: installProductUpdateFromTitleBar
              } : {})}
              onCommand={handleTitleBarCommand}
              onCaptureBehaviorOwner={() => focusCommandRouter.captureOwner()}
              onWindowCommand={handleTitleBarWindowCommand}
            />
            <WorkbenchActivitySurfaces
              activities={api.activities}
              activityBellRef={activityBellRef}
              interactionBlocked={false}
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
              {...titleBarActivityProps}
              state={effectiveTitleBarState}
              nativeWindowState={nativeWindowState}
              onCommand={handleTitleBarCommand}
              onCaptureBehaviorOwner={() => focusCommandRouter.captureOwner()}
              onWindowCommand={handleTitleBarWindowCommand}
            />
            <WorkbenchActivitySurfaces
              activities={api.activities}
              activityBellRef={activityBellRef}
              interactionBlocked
            />
            <div className="boot-screen boot-screen--with-titlebar boot-screen--blocking" role="status" aria-live="polite" data-testid="workbench-product-update-blocking">
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
      canvas={canvas}
      hasProject={Boolean(snapshot)}
      projectOpenAttemptedPath={projectOpenAttemptedPath}
      projectOpenError={projectOpenError}
      projectOpening={isProjectOpening}
      actions={actions}
      textFileBuffers={textFileBuffers}
      canvasFeedback={feedbackInteraction.feedback}
      textPreviewStyleDependencyKey={presentationController.resolvedTheme}
      runtimeScopeKey={canvasRuntimeScopeKey}
      minimapOpen={canvasMinimapOpen}
      productPlatform={productPlatform}
      cutPaths={canvasCutPaths}
      feedbackInteraction={feedbackInteraction.canvas}
      onRuntimeChange={setMountedCanvasRuntime}
      onOpenContextMenu={openWorkbenchContextMenu}
      interactionBlocked={projectPresentationBlocked}
    />
  );
  const profiledCanvasEditor = canvasState ? (
    <CanvasTextRenderProfileProvider profile={canvasTextRenderProfile}>
      {canvasEditor}
    </CanvasTextRenderProfileProvider>
  ) : canvasEditor;
  const canvasWorkspaceUnavailable = snapshot?.canvasWorkspace.status === 'unavailable'
    ? snapshot.canvasWorkspace
    : undefined;
  const resetCanvas = () => {
    setResettingCanvas(true);
    setCanvasResetError(undefined);
    void api.resetCanvas()
      .catch((error) => {
        setCanvasResetError(errorMessage(error));
        projectActivities.report({
          kind: 'canvas-operation-failed',
          operation: 'reset-canvas'
        });
      })
      .finally(() => setResettingCanvas(false));
  };

  return (
    <>
      {explorerFeatureRequested ? (
        <React.Suspense fallback={null}>
          <WorkbenchExplorerControllerHost
            commandEffects={projectPathCommandEffects}
            getSnapshot={getAcceptedProjectSnapshot}
            canvasRuntime={canvasRuntime}
            activities={projectActivities}
            i18n={i18n}
            onController={setExplorerController}
          />
        </React.Suspense>
      ) : null}
      <I18nProvider locale={presentationController.locale}>
      <WorkbenchIconProvider>
        <div
          className="workbench-shell"
          data-theme={presentationController.resolvedTheme}
          data-testid="workbench-shell"
          onClickCapture={handleWorkbenchCompletedClick}
        >
          <WorkbenchTitleBar
            {...titleBarActivityProps}
            state={effectiveTitleBarState}
            nativeWindowState={nativeWindowState}
            {...(titleBarUpdateVersion ? {
              updateVersion: titleBarUpdateVersion,
              onInstallProductUpdate: installProductUpdateFromTitleBar
            } : {})}
            onCommand={handleTitleBarCommand}
            onCaptureBehaviorOwner={() => focusCommandRouter.captureOwner()}
            onWindowCommand={handleTitleBarWindowCommand}
          />
          <WorkbenchActivitySurfaces
            activities={api.activities}
            activityBellRef={activityBellRef}
            interactionBlocked={projectPresentationBlocked}
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
              <span>The last confirmed Project view is frozen. Project commands are unavailable.</span>
              <span>Reloading creates a new Workbench connection.</span>
            </WorkbenchCanvasDialog>
          ) : projectDetached ? (
            <WorkbenchCanvasDialog
              testId="workbench-detached-dialog-layer"
              titleId="workbench-detached-dialog-title"
              title="This Project is active in another Workbench."
            >
              <span>This window no longer owns the Project. Its last confirmed view and local drafts are frozen here.</span>
              <Button autoFocus disabled={isProjectOpening} onClick={() => { void reopenDetachedProject(); }}>Open Here</Button>
              {projectOpenError ? <span className="db-form-error" role="alert">{projectOpenError}</span> : null}
            </WorkbenchCanvasDialog>
          ) : projectOpenFailureBlocking ? (
            <WorkbenchCanvasDialog
              testId="workbench-project-open-failed-dialog-layer"
              titleId="workbench-project-open-failed-dialog-title"
              title={i18n.t('projectOpen.title')}
            >
              {projectOpenAttemptedPath ? <span>{projectOpenAttemptedPath}</span> : null}
              <span className="db-form-error" role="alert">{projectOpenError}</span>
              <div className="db-action-row">
                <Button onClick={() => setProjectOpenPresentation({})}>
                  {i18n.t('common.close')}
                </Button>
              </div>
            </WorkbenchCanvasDialog>
          ) : null}
          <div className="canvas-layer" data-testid="canvas-layer" inert={projectPresentationBlocked}>
            {canvasWorkspaceUnavailable ? (
              <div
                className="db-empty-state canvas-workspace-unavailable"
                role="alert"
                data-testid="canvas-workspace-unavailable"
              >
                <strong>{i18n.t('canvas.workspaceUnavailable.title')}</strong>
                <span>{canvasResetError ?? canvasWorkspaceUnavailable.message}</span>
                <Button
                  disabled={resettingCanvas}
                  onClick={resetCanvas}
                >
                  {resettingCanvas
                    ? i18n.t('canvas.workspaceUnavailable.resetting')
                    : i18n.t('canvas.workspaceUnavailable.reset')}
                </Button>
              </div>
            ) : profiledCanvasEditor}
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
            {availableCanvasWorkspace ? (
              <>
                <CanvasMinimapBar
                  runtime={canvasRuntime}
                  overlayRuntime={canvasOverlayRuntime}
                  open={canvasMinimapOpen}
                  onOpenChange={setCanvasMinimapOpen}
                  panelPlacement={minimapPanelPlacement}
                  interactionBlocked={projectPresentationBlocked}
                />
                {canvasState ? (
                  <CanvasResetLayoutButton
                    enabled={canResetCanvasLayout}
                    onResetCanvasLayout={resetCanvasLayout}
                  />
                ) : null}
                <CanvasFeedbackInteractionBar
                  interaction={feedbackInteraction}
                  overlayRuntime={canvasOverlayRuntime}
                />
              </>
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
                          key={runtimeBindingId}
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
                          canvasRuntime={canvasRuntime}
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
                          key={runtimeBindingId}
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
  productPlatform,
  onClose
}: {
  contextMenu: {
    target: WorkbenchContextMenuTarget;
    position: WorkbenchContextMenuPosition;
  };
  router: ProjectPathCommandRouter | undefined;
  productPlatform: DebruteProductPlatform;
  onClose(): void;
}): React.ReactElement {
  const items = useMemo(
    () => router?.contextMenuItems(contextMenu.target) ?? [],
    [contextMenu.target, router]
  );
  if (!router) {
    return <PendingWorkbenchContextMenuDismissal onClose={onClose} />;
  }
  return (
    <WorkbenchContextMenu
      items={items}
      position={contextMenu.position}
      productPlatform={productPlatform}
      selectionCount={contextMenu.target.selectedEntries.length}
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
  floatingPanels: FloatingPanelState;
  textFileBuffers: Record<string, TextFileBuffer>;
} {
  const viewportRect = readWorkbenchViewportRect();
  if (!project) {
    return {
      viewportRect,
      floatingPanels: DEFAULT_FLOATING_PANEL_STATE,
      textFileBuffers: {}
    };
  }
  const restoredViewState = restoreProjectViewState({
    storage: window.sessionStorage,
    canonicalRoot: project.canonicalRoot
  });
  const viewState = restoredViewState ?? { floatingPanels: DEFAULT_FLOATING_PANEL_STATE };
  return {
    viewportRect,
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
    )
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ProjectOpenPresentation {
  attemptedPath?: string;
  error?: string;
}

function projectOpenPresentationFromFailure(
  failure: Error,
  i18n: WorkbenchI18n,
  attemptedPath?: string
): ProjectOpenPresentation {
  const projectRoot = projectRootFromOpenError(failure) ?? attemptedPath;
  return {
    ...(projectRoot ? { attemptedPath: projectRoot } : {}),
    error: i18n.t('projectOpen.openFailed', { message: failure.message })
  };
}

function canvasMutationContext(
  project: Extract<WorkbenchProjectProjectionState, { status: 'bound' }>
) {
  if (project.snapshot.canvasWorkspace.status !== 'available') {
    throw new Error(project.snapshot.canvasWorkspace.message);
  }
  const resources = project.snapshot.canvasWorkspace.canvasResources;
  const state = project.snapshot.canvasWorkspace.workspace;
  return {
    resources,
    state
  };
}

function equalStringArrays(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function projectRootFromOpenError(error: Error): string | undefined {
  if (!(error instanceof DebruteHttpRequestError)) {
    return undefined;
  }
  const projectRoot = error.details?.canonicalRoot;
  return typeof projectRoot === 'string' && projectRoot.length > 0 ? projectRoot : undefined;
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
