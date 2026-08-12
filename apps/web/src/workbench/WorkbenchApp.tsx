import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Loader2 } from './ui/index';
import {
  workbenchCommandShortcutMatches,
  type DebruteProductPlatform,
  type DebruteWorkbenchRoute,
  type ProjectPathRef
} from '@debrute/app-protocol';
import {
  DebruteHttpRequestError,
  type HttpWorkbenchApiClient
} from '../api/httpWorkbenchApiClient';
import { getDebruteShellApi, type NativeWindowState } from '../api/shellApi';
import { CanvasEditor } from './canvas/CanvasEditor';
import { CanvasMinimapBar } from './canvas/CanvasMinimapBar';
import { CanvasResetLayoutButton } from './canvas/CanvasResetLayoutButton';
import { CanvasHierarchyEdgeVisibilityButton } from './canvas/CanvasHierarchyEdgeVisibilityButton';
import {
  canvasPathAncestors,
  projectCanvasHierarchyEdges,
  projectCanvasNodeScene,
  type CanvasProjection
} from './canvas/CanvasScene';
import { createCanvasOverlayRuntime } from './canvas/CanvasOverlayRuntime';
import { createCanvasOcclusionOrderWrites } from './canvas/CanvasOcclusionOrderWrites';
import { createCanvasStateChangeIntake } from './canvas/CanvasStateChangeIntake';
import {
  CanvasFeedbackInteractionBar,
  useCanvasFeedbackInteraction
} from './canvas/CanvasFeedbackInteraction';
import { FeedbackPanel } from './feedback/FeedbackPanel';
import type { CanvasEditorRuntime } from './canvas/runtime/CanvasEditorRuntime';
import type { CanvasVideoMetadataUpdate } from './canvas/CanvasVideoPreviewRuntime';
import {
  canvasNodeSelection,
  selectedNodeProjectRelativePaths
} from './canvas/runtime/canvasSelection';
import { createInspectionTargetStore } from './inspector/inspectionTarget';
import {
  currentDebruteWorkbenchRoute,
  replaceWorkbenchProjectRoute,
  resolveInitialProjectRoute,
  shouldShowInitialProjectLoader,
  type ProjectOpenStartupError
} from './services/projectSessionState';
import {
  createProjectBindingLifecycle,
  type ProjectBindingLifecycle
} from './services/projectBindingLifecycle';
import { reconcileWorkbenchViewportLayout } from './services/workbenchViewportLayout';
import {
  closeTextEditorWindowState,
  commitTextEditorWindowRect,
  openTextEditorWindowState
} from './services/textEditorWindows';
import { useTextFileBufferActions } from './services/textFileBufferActions';
import {
  createProjectPathCommandRouter,
  type ProjectPathCommandRouter
} from './services/projectPathCommandRouter';
import { resolveProjectPathCommandTarget } from './services/projectPathCommandTarget';
import {
  createWorkbenchFocusCommandRouter,
  workbenchFocusCommandFromKeyboardEvent,
  workbenchFocusCommandFromMenuCommandId,
  type WorkbenchBehaviorOwner,
  type WorkbenchFocusCommandRouter
} from './services/workbenchFocusCommandRouter';
import { createProjectCommandGate } from './services/projectCommandGate';
import {
  PendingWorkbenchContextMenuDismissal,
  WorkbenchContextMenu
} from './shell/WorkbenchContextMenu';
import { WorkbenchTitleBar } from './shell/WorkbenchTitleBar';
import { executeDocumentEditCommand, executeTitleBarMenuCommand } from './shell/workbenchTitleBarCommands';
import {
  buildWorkbenchTitleBarState,
  workbenchMenuCommandItem,
  type WorkbenchMenuItem
} from './shell/workbenchTitleBarState';
import {
  cameraCenteredOnNode,
  type WorkbenchContextMenuPosition,
  type WorkbenchContextMenuTarget
} from './shell/contextMenu';
import type { WorkbenchProjectProjectionState } from './services/WorkbenchProjectProjection';
import {
  useProjectExplorerController,
  type ProjectExplorerSelection
} from './project-explorer/useProjectExplorerController';
import {
  canvasHierarchyEdgeVisibilityButtonRect,
  canvasMinimapButtonRect,
  canvasResetLayoutButtonRect,
  placeCanvasMinimapPanel
} from './shell/floatingBars';
import {
  type FloatingPanelId
} from './shell/floatingPanels';
import { FloatingPanelContent } from './shell/FloatingPanel';
import {
  WorkbenchWindowHost,
  type WorkbenchWindowHostHandle
} from './shell/WorkbenchWindowHost';
import { WorkbenchActivitySurfaces } from './shell/WorkbenchActivitySurfaces';
import {
  scopeWorkbenchActivityNoticeReporter,
  type WorkbenchActivityNoticeReporter
} from './services/WorkbenchActivities';
import { Button, WorkbenchIconProvider } from './ui/index';
import { TITLE_BAR_RESERVED_RECT, WORKBENCH_TOP_CHROME_RESERVED_RECTS } from './shell/workbenchLayers';
import { readWorkbenchViewportRect } from './shell/windowBounds';
import type { FloatingTextEditorWindowState, TextFileBuffer, WorkbenchActions, WorkbenchState } from '../types';
import { I18nProvider, createI18n, type WorkbenchI18n } from './i18n';
import type { WorkbenchSettingsController } from './settings/useWorkbenchSettingsController';
import {
  useWorkbenchPresentationController,
  type WorkbenchPresentationController
} from './services/useWorkbenchPresentationController';
import {
  useWorkbenchGlobalSettingsController,
  type WorkbenchGlobalSettingsController
} from './services/useWorkbenchGlobalSettingsController';
import { canvasTextRenderProfileForAppearance } from './canvas/CanvasFontCatalog';
import {
  CanvasTextRenderProfileGate,
  CanvasTextRenderProfileProvider
} from './canvas/CanvasTextRenderProfileContext';
import { decideCanvasInteraction } from './canvas/CanvasInteractionPolicy';
import { CanvasTextProjectFontEnvironmentProvider } from './canvas/font-subset/CanvasTextProjectFontEnvironment';
import { workbenchStartupTimeline } from '../startup/workbenchStartupTimeline';

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

const EMPTY_CANVAS_HIERARCHY_EDGES: CanvasProjection['edges'] = [];
const ProjectTree = React.lazy(async () => {
  workbenchStartupTimeline.markFeatureRequested('explorer');
  const module = await import('./project-explorer/ProjectTree');
  workbenchStartupTimeline.markFeatureReady('explorer');
  return { default: module.ProjectTree };
});
const TerminalPanel = React.lazy(async () => {
  workbenchStartupTimeline.markFeatureRequested('terminal');
  const module = await import('./terminal/TerminalPanel');
  workbenchStartupTimeline.markFeatureReady('terminal');
  return { default: module.TerminalPanel };
});
const loadSettingsFeature = async () => {
  workbenchStartupTimeline.markFeatureRequested('settings');
  const module = await import('./settings/SettingsFeature');
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
const WorkbenchInspectorPanelFeature = React.lazy(async () => {
  workbenchStartupTimeline.markFeatureRequested('inspector');
  const module = await import('./inspector/InspectorPanelFeature');
  workbenchStartupTimeline.markFeatureReady('inspector');
  return { default: module.WorkbenchInspectorPanelFeature };
});
const WorkbenchFloatingTextEditorWindowFeature = React.lazy(async () => {
  const module = await import('./canvas/FloatingTextEditorWindowFeature');
  return { default: module.WorkbenchFloatingTextEditorWindowFeature };
});

type WorkbenchBoundProjectApi = HttpWorkbenchApiClient;

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
  const [connectionEnded, setConnectionEnded] = useState<Error>();
  const [productRemovalAccepted, setProductRemovalAccepted] = useState(false);
  const [isLoading, setIsLoading] = useState(() => shouldShowInitialProjectLoader(initialRoute));
  const [projectOpenPresentation, setProjectOpenPresentation] = useState<ProjectOpenPresentation>({});
  const initialProjectOpeningRef = useRef<ReturnType<ProjectBindingLifecycle['open']> | undefined>(undefined);
  const announcedProjectBindingsRef = useRef(new Set<number>());
  const reportGlobalSettingsMutationError = useCallback((
    _error: unknown,
    mutation: Parameters<WorkbenchGlobalSettingsController['mutate']>[0]
  ) => {
    if (mutation.operation !== 'set-hierarchy-edges-visible') {
      return;
    }
    void api.reportActivityNotice({
      kind: 'workbench-operation-failed',
      operation: 'save-canvas-settings'
    }).catch(() => undefined);
  }, [api]);
  const globalSettingsController = useWorkbenchGlobalSettingsController({
    api,
    globalProjection: api.globalProjection,
    onMutationError: reportGlobalSettingsMutationError
  });
  const presentationController = useWorkbenchPresentationController({
    settings: globalSettingsController.settings
  });
  useLayoutEffect(() => {
    workbenchStartupTimeline.mark('react-committed');
    onCommitted?.();
  }, [onCommitted]);
  const [settingsFeatureRequested, setSettingsFeatureRequested] = useState(false);
  const [settingsFeatureController, setSettingsFeatureController] = useState<WorkbenchSettingsController>();
  const acceptProductRemoval = useCallback(() => {
    setProductRemovalAccepted(true);
  }, []);
  const requestSettingsFeature = useCallback(() => {
    setSettingsFeatureRequested(true);
  }, []);
  const canvasTextAppearance = globalSettingsController.settings.canvas.textAppearance;
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
        await initialProjectOpeningRef.current;
        if (disposed) {
          return;
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
    canvasTextRenderProfile,
    projectProjection,
    connectionEnded,
    announceProjectBinding,
    presentationController,
    globalSettingsController,
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
  const surface = productRemovalAccepted ? (
    <I18nProvider locale={presentationController.locale}>
      <main
        className="boot-screen boot-screen--terminal"
        data-theme={presentationController.resolvedTheme}
        role="status"
        data-testid="workbench-product-removed"
      >
        <strong>{i18n.t('shell.productRemoval.removed')}</strong>
        <span>{i18n.t('shell.productRemoval.closePage')}</span>
      </main>
    </I18nProvider>
  ) : projectProjection.status === 'unbound' ? (
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
      {!productRemovalAccepted && settingsFeatureRequested ? (
        <React.Suspense fallback={null}>
          <WorkbenchSettingsFeatureHost
            api={api}
            globalSettingsController={globalSettingsController}
            onProductRemovalAccepted={acceptProductRemoval}
            onController={setSettingsFeatureController}
          />
        </React.Suspense>
      ) : null}
    </>
  );
}

function WorkbenchBoundProjectApp({
  api,
  canvasTextRenderProfile,
  projectProjection,
  connectionEnded,
  announceProjectBinding,
  presentationController,
  globalSettingsController,
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
  canvasTextRenderProfile: ReturnType<typeof canvasTextRenderProfileForAppearance>;
  projectProjection: WorkbenchProjectProjectionState;
  connectionEnded: Error | undefined;
  announceProjectBinding(input: { bindingGeneration: number }): void;
  presentationController: WorkbenchPresentationController;
  globalSettingsController: WorkbenchGlobalSettingsController;
  settingsFeatureController: WorkbenchSettingsController | undefined;
  requestSettingsFeature(): void;
  i18n: WorkbenchI18n;
  isLoading: boolean;
  projectOpenPresentation: ProjectOpenPresentation;
  setProjectOpenPresentation: React.Dispatch<React.SetStateAction<ProjectOpenPresentation>>;
  projectBindingLifecycle: ProjectBindingLifecycle;
  isProjectOpening: boolean;
}): React.ReactElement {
  const connectionEnvironment = api.connectionEnvironment();
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
  const projectCommandGate = useMemo(() => createProjectCommandGate({
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
  const inspectionTargetStore = useMemo(
    () => createInspectionTargetStore(),
    [projectProjection.generation]
  );
  const confirmMoveOverwrite = useCallback((input: {
    entries: readonly ProjectPathRef[];
    targetDirectoryProjectRelativePath: string;
  }) => (
    window.confirm(i18n.t('shell.confirm.moveOverwrite', {
      target: input.targetDirectoryProjectRelativePath || i18n.t('shell.confirm.projectRoot')
    }))
  ), [i18n]);
  const permanentDeleteConfirmationLabels = useMemo(() => ({
    directory: (path: string) => i18n.t('shell.confirm.permanentDeleteDirectory', { path }),
    file: (path: string) => i18n.t('shell.confirm.permanentDeleteFile', { path }),
    selectedItems: (count: number) => i18n.t('shell.confirm.permanentDeleteSelected', { count })
  }), [i18n]);
  const confirmPermanentDelete = useCallback((input: {
    entries: Array<{ projectRelativePath: string; kind: 'file' | 'directory' }>;
  }) => (
    window.confirm(projectPathDeletionConfirmationMessageForEntries(input, permanentDeleteConfirmationLabels))
  ), [permanentDeleteConfirmationLabels]);
  const trashConfirmationLabels = useMemo(() => ({
    directory: (path: string) => i18n.t('shell.confirm.trashDirectory', { path }),
    file: (path: string) => i18n.t('shell.confirm.trashFile', { path }),
    selectedItems: (count: number) => i18n.t('shell.confirm.trashSelected', { count })
  }), [i18n]);
  const confirmTrash = useCallback((input: {
    entries: Array<{ projectRelativePath: string; kind: 'file' | 'directory' }>;
  }) => (
    window.confirm(projectPathDeletionConfirmationMessageForEntries(input, trashConfirmationLabels))
  ), [trashConfirmationLabels]);
  const confirmExplorerDelete = useCallback((input: {
    mode: 'trash' | 'permanent';
    entries: readonly ProjectPathRef[];
  }) => input.mode === 'trash'
    ? confirmTrash({ entries: [...input.entries] })
    : confirmPermanentDelete({ entries: [...input.entries] }), [confirmPermanentDelete, confirmTrash]);
  const publishExplorerInspectionSelection = useCallback((selection: ProjectExplorerSelection) => {
    inspectionTargetStore.publishPaths(selection.selectedPaths);
  }, [inspectionTargetStore]);
  const explorerController = useProjectExplorerController({
    api,
    commandGate: projectCommandGate,
    snapshot,
    projectRevision: acceptedProject?.projectRevision ?? 0,
    activities: projectActivities,
    confirmOverwrite: confirmMoveOverwrite,
    confirmDelete: confirmExplorerDelete,
    onInspectionSelectionChange: publishExplorerInspectionSelection
  });
  const canvasStateChangeIntake = useMemo(
    () => createCanvasStateChangeIntake(),
    [canvasRuntimeScopeKey]
  );
  const handleCanvasRuntimeChange = useCallback((runtime: CanvasEditorRuntime | undefined) => {
    canvasStateChangeIntake.setRuntime(runtime);
    setMountedCanvasRuntime(runtime);
  }, [canvasStateChangeIntake]);
  const windowHostRef = useRef<WorkbenchWindowHostHandle>(null);
  const [requestedTerminal, setRequestedTerminal] = useState<{
    cwdProjectRelativePath: string;
  } | null>(null);
  const canSubmitRequestedTerminal = useCallback(
    () => projectCommandGate.available(),
    [projectCommandGate]
  );
  const consumeRequestedTerminal = useCallback(() => {
    setRequestedTerminal(null);
  }, []);
  const [textFileBuffers, setTextFileBuffers] = useState<Record<string, TextFileBuffer>>(
    initialProjectPresentation.textFileBuffers
  );
  const [textEditorWindows, setTextEditorWindows] = useState<Record<string, FloatingTextEditorWindowState>>({});
  const [canvasMinimapOpen, setCanvasMinimapOpen] = useState(false);
  const [canvasVideoMetadataByPath, setCanvasVideoMetadataByPath] = useState<Record<string, {
    sourceRevision: string;
    metadata: CanvasVideoMetadataUpdate['metadata'];
  }>>({});
  useEffect(() => setCanvasVideoMetadataByPath({}), [canvasRuntimeScopeKey]);
  const handleCanvasVideoMetadata = useCallback((update: CanvasVideoMetadataUpdate) => {
    setCanvasVideoMetadataByPath((current) => {
      const previous = current[update.projectRelativePath];
      if (previous?.sourceRevision === update.sourceRevision
        && previous.metadata.width === update.metadata.width
        && previous.metadata.height === update.metadata.height
        && previous.metadata.durationSeconds === update.metadata.durationSeconds) {
        return current;
      }
      return {
        ...current,
        [update.projectRelativePath]: {
          sourceRevision: update.sourceRevision,
          metadata: update.metadata
        }
      };
    });
  }, []);
  const [contextMenu, setContextMenu] = useState<{
    target: WorkbenchContextMenuTarget;
    position: WorkbenchContextMenuPosition;
  }>();
  const [nativeWindowState, setNativeWindowState] = useState<NativeWindowState>();
  const [workbenchViewportRect, setWorkbenchViewportRect] = useState(
    initialProjectPresentation.viewportRect
  );
  const canvasOverlayRuntime = useMemo(() => createCanvasOverlayRuntime(), []);
  const canvasOcclusionOrderWrites = useMemo(() => createCanvasOcclusionOrderWrites({
    generation: projectProjection.generation,
    readProjectProjection: () => api.projectProjection.getState(),
    patchCanvasState: (patch) => api.patchCanvasState(patch)
  }), [api, projectProjection.generation]);
  const workbenchViewportRectRef = useRef(workbenchViewportRect);
  const textFileBuffersRef = useRef(textFileBuffers);
  const textEditorWindowsRef = useRef(textEditorWindows);
  const availableCanvasWorkspace = snapshot?.canvasWorkspace.status === 'available'
    ? snapshot.canvasWorkspace
    : undefined;
  const canvasState = availableCanvasWorkspace?.workspace;
  const canvasRuntime = mountedCanvasRuntime;
  useEffect(() => {
    if (!canvasRuntime) {
      return;
    }
    inspectionTargetStore.publishPaths(selectedNodeProjectRelativePaths(
      canvasRuntime.getSnapshot().selection
    ));
    return canvasRuntime.subscribeSelection((selection) => {
      inspectionTargetStore.publishPaths(selectedNodeProjectRelativePaths(selection));
    });
  }, [canvasRuntime, inspectionTargetStore]);
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
  const hierarchyEdgesVisible = globalSettingsController.settings.canvas.hierarchyEdgesVisible;
  const canvasStateRef = useRef(canvasState);
  canvasStateRef.current = canvasState;
  const canvasProjectionSource = useMemo(() => (
    canvasStateRef.current && availableCanvasWorkspace && canonicalRoot
      ? {
          canonicalRoot,
          resources: availableCanvasWorkspace.canvasResources,
          state: canvasStateRef.current,
          videoMetadataByPath: canvasVideoMetadataByPath
        }
      : undefined
  // Canvas State events preserve membership; the mounted Runtime accepts their deltas directly.
  ), [availableCanvasWorkspace?.canvasResources, canonicalRoot, canvasVideoMetadataByPath]);
  const canvasNodeScene = useMemo(() => (
    canvasProjectionSource ? projectCanvasNodeScene(canvasProjectionSource) : undefined
  ), [canvasProjectionSource]);
  const canvasProjection = useMemo<CanvasProjection | undefined>(() => (
    canvasNodeScene
      ? {
          nodes: canvasNodeScene.nodes,
          occlusionOrder: canvasNodeScene.occlusionOrder,
          edges: hierarchyEdgesVisible
            ? projectCanvasHierarchyEdges(canvasNodeScene.nodes)
            : EMPTY_CANVAS_HIERARCHY_EDGES
        }
      : undefined
  ), [canvasNodeScene, hierarchyEdgesVisible]);
  const canvas = useMemo(() => (
    canvasProjectionSource && canvasProjection
      ? {
          expandedDirectories: canvasProjectionSource.state.expandedDirectories,
          projection: canvasProjection,
          feedbackVideoResources: availableCanvasWorkspace?.feedbackVideoResources.resources ?? []
        }
      : undefined
  ), [availableCanvasWorkspace?.feedbackVideoResources, canvasProjection, canvasProjectionSource]);
  const visibleCanvasPathsRef = useRef<Set<string> | undefined>(undefined);
  useEffect(() => {
    if (!canvasProjectionSource || !canvasNodeScene) {
      visibleCanvasPathsRef.current = undefined;
      return;
    }
    const visiblePaths = new Set(
      canvasNodeScene.nodes.map((node) => node.projectRelativePath)
    );
    const previous = visibleCanvasPathsRef.current;
    visibleCanvasPathsRef.current = visiblePaths;
    const newlyVisible = previous
      ? [...visiblePaths].filter((path) => !previous.has(path))
      : [];
    void canvasOcclusionOrderWrites.reconcileVisibility(newlyVisible).catch(() => projectActivities.report({
      kind: 'canvas-operation-failed',
      operation: 'raise-selection'
    }));
  }, [canvasNodeScene, canvasOcclusionOrderWrites, canvasProjectionSource, projectActivities]);
  const centerCanvasProjectionNode = useCallback((
    nodes: CanvasProjection['nodes'] | undefined,
    projectRelativePath: string
  ) => {
    const node = canvasRuntime?.scene.getAcceptedNode(projectRelativePath)
      ?? nodes?.find((item) => item.projectRelativePath === projectRelativePath);
    const runtimeSnapshot = canvasRuntime?.getSnapshot();
    if (!node || !canvasRuntime || !runtimeSnapshot?.surfaceSize) {
      return;
    }
    canvasRuntime.setSelection(canvasNodeSelection([projectRelativePath]));
    canvasRuntime.camera.setCamera(cameraCenteredOnNode({
      node,
      surfaceSize: runtimeSnapshot.surfaceSize,
      camera: runtimeSnapshot.camera
    }), 'programmatic');
  }, [canvasRuntime]);
  const locateProjectFileInCanvas = useCallback(async (projectRelativePath: string) => {
    const scope = projectCommandGate.accept();
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
      const request = scope.submit(() => api.patchCanvasState({ expandedDirectories }));
      if (!request) {
        return;
      }
      await request;
      if (!scope.isCurrent()) {
        return;
      }
      const accepted = api.projectProjection.getState();
      const latestSnapshot = accepted.status === 'unbound' ? undefined : accepted.snapshot;
      const latestWorkspace = latestSnapshot?.canvasWorkspace.status === 'available'
        ? latestSnapshot.canvasWorkspace
        : undefined;
      const nodes = latestWorkspace && canonicalRoot
        ? projectCanvasNodeScene({
            canonicalRoot,
            resources: latestWorkspace.canvasResources,
            state: latestWorkspace.workspace
          }).nodes
        : undefined;
      centerCanvasProjectionNode(nodes, projectRelativePath);
      document.querySelector<HTMLElement>('[data-testid="canvas-surface"]')?.focus({ preventScroll: true });
    } catch {
      if (scope.isCurrent()) {
        projectActivities.report({ kind: 'canvas-operation-failed', operation: 'reveal-path' });
      }
    }
  }, [api, canonicalRoot, centerCanvasProjectionNode, projectActivities, projectCommandGate]);
  const fileClipboard = explorerController.fileClipboard;
  const canvasCutPaths = useMemo(() => (
    fileClipboard?.operation === 'cut'
      ? fileClipboard.entries.map((entry) => entry.projectRelativePath)
      : []
  ), [fileClipboard]);

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
    try {
      await projectBindingLifecycle.open({ projectRoot: canonicalRoot });
    } catch (error) {
      setProjectOpenPresentation(projectOpenPresentationFromFailure(
        error instanceof Error ? error : new Error(String(error)),
        i18n
      ));
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

      if (event.type === 'canvas.state.changed') {
        canvasStateChangeIntake.accept(event.change);
      }

      if (event.type === 'project.fileChanged') {
        inspectionTargetStore.invalidatePath(event.event.projectRelativePath);
        void refreshTextFileBuffer(event.event.projectRelativePath);
        if (event.event.projectRelativePath === '.debrute/feedback/feedback.json') {
          void feedbackInteraction.load();
        }
      }
    });
  }, [
    canvasStateChangeIntake,
    feedbackInteraction.applyEvent,
    feedbackInteraction.load,
    inspectionTargetStore,
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
      await canvasOcclusionOrderWrites.commitManualLayouts(input);
    } catch (error) {
      projectActivities.report({
        kind: 'canvas-operation-failed',
        operation: 'save-layout'
      });
      throw error;
    }
  }, [canvasOcclusionOrderWrites, projectActivities]);

  const resetCanvasNodeLayouts = useCallback<WorkbenchActions['resetCanvasNodeLayouts']>(async (input) => {
    await canvasOcclusionOrderWrites.resetManualLayouts(input);
  }, [canvasOcclusionOrderWrites]);

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
      await canvasOcclusionOrderWrites.raiseSelection(input.projectRelativePaths);
    } catch (error) {
      projectActivities.report({
        kind: 'canvas-operation-failed',
        operation: 'raise-selection'
      });
      throw error;
    }
  }, [canvasOcclusionOrderWrites, projectActivities]);

  const presentProjectOpenFailure = useCallback((failure: Error, attemptedPath?: string) => {
    if (hasAcceptedProject) {
      projectActivities.report({
        kind: 'project-operation-failed',
        operation: 'open'
      });
    }
    setProjectOpenPresentation(projectOpenPresentationFromFailure(failure, i18n, attemptedPath));
  }, [hasAcceptedProject, i18n, projectActivities, setProjectOpenPresentation]);

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
      await projectBindingLifecycle.open({ projectRoot });
      setProjectOpenPresentation({});
    } catch (error) {
      presentProjectOpenFailure(error instanceof Error ? error : new Error(String(error)));
    }
  }, [api, presentProjectOpenFailure, projectBindingLifecycle, setProjectOpenPresentation]);

  const openProjectRoot = useCallback(async (projectRoot: string): Promise<void> => {
    setProjectOpenPresentation({ attemptedPath: projectRoot });
    try {
      await projectBindingLifecycle.open({ projectRoot });
      setProjectOpenPresentation({});
    } catch (error) {
      presentProjectOpenFailure(
        error instanceof Error ? error : new Error(String(error)),
        projectRoot
      );
    }
  }, [presentProjectOpenFailure, projectBindingLifecycle, setProjectOpenPresentation]);

  const openRecentProject = useCallback(async (projectRoot: string): Promise<void> => {
    await openProjectRoot(projectRoot);
  }, [openProjectRoot]);

  useEffect(() => getDebruteShellApi()?.onNativeProjectOpenRequested((projectRoot) => {
    void openProjectRoot(projectRoot);
  }), [openProjectRoot]);

  const openWorkbenchContextMenu = useCallback((target: WorkbenchContextMenuTarget, position: WorkbenchContextMenuPosition) => {
    if (!projectCommandGate.available()) {
      return;
    }
    setContextMenu({ target, position });
  }, [projectCommandGate]);

  const closeWorkbenchContextMenu = useCallback(() => {
    setContextMenu(undefined);
  }, []);

  useEffect(() => {
    if (!isProjectOpening && !projectPresentationBlocked) {
      return;
    }
    closeWorkbenchContextMenu();
    explorerController.cancelEdit();
  }, [
    closeWorkbenchContextMenu,
    explorerController.cancelEdit,
    isProjectOpening,
    projectPresentationBlocked
  ]);

  const openInspectorPanel = useCallback(() => {
    windowHostRef.current?.openPanel('inspector');
  }, []);
  const effectiveTitleBarState = useMemo(() => buildWorkbenchTitleBarState({
    platform: productPlatform,
    host: getDebruteShellApi() ? 'desktop' : 'web',
    locale: presentationController.locale,
    projectTitle: snapshot?.health.projectName,
    recentProjects: presentationController.settings.chrome.recentProjectRoots.map((projectRoot) => ({ projectRoot }))
  }), [presentationController.locale, presentationController.settings.chrome.recentProjectRoots, snapshot?.health.projectName]);
  const disabledFloatingPanelIds = useMemo<readonly FloatingPanelId[]>(() => (
    runtimeBindingId ? [] : ['explorer', 'inspector', 'feedback', 'terminal']
  ), [runtimeBindingId]);
  const handlePanelIntent = useCallback((panelId: FloatingPanelId) => {
    if (panelId === 'settings') {
      requestSettingsFeature();
    }
  }, [requestSettingsFeature]);

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
    photoshop: globalProjection.photoshop,
    canvasFeedback: feedbackInteraction.feedback,
    textFileBuffers,
    textEditorWindows,
  };

  const openProjectPathTerminalPanel = useCallback((cwdProjectRelativePath: string) => {
    setRequestedTerminal({ cwdProjectRelativePath });
    windowHostRef.current?.openPanel('terminal');
  }, []);

  const actions: WorkbenchActions = useMemo(() => ({
    lookupModelArtifactProvenance: api.lookupModelArtifactProvenance,
    inspectProjectPath: api.inspectProjectPath,
    resolveProjectFileSource: api.resolveProjectFileSource,
    readProjectTextFile: api.readProjectTextFile,
    resolveCanvasSources: api.resolveCanvasSources,
    writeProjectTextFile: api.writeProjectTextFile,
    saveCanvasTextPreviewSource: api.saveCanvasTextPreviewSource,
    readCanvasTextPreviewSources: api.readCanvasTextPreviewSources,
    readCanvasVideoPreviewSources: api.readCanvasVideoPreviewSources,
    saveCanvasVideoPreviewSource: api.saveCanvasVideoPreviewSource,
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
      openProjectRoot: openRecentProject
    }).catch(() => {
      globalActivities.report({
        kind: 'workbench-operation-failed',
        operation: 'menu-command'
      });
    });
  }, [actions.openProject, globalActivities, openRecentProject]);
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
  const hierarchyEdgeVisibilityButtonRect = canvasHierarchyEdgeVisibilityButtonRect(
    workbenchViewportRect
  );
  const floatingBarReservedRects = [
    TITLE_BAR_RESERVED_RECT(workbenchViewportRect.width),
    ...WORKBENCH_TOP_CHROME_RESERVED_RECTS,
    minimapButtonRect,
    ...(resetLayoutButtonRect ? [resetLayoutButtonRect] : []),
    hierarchyEdgeVisibilityButtonRect,
    ...(canvasMinimapOpen ? [minimapPanelPlacement] : [])
  ];
  const canResetCanvasLayout = Boolean(
    canvasState && Object.values(canvasState.nodeStates).some((node) => node.manualLayout !== undefined)
  );
  const resetCanvasLayout = useCallback(() => {
    void actions.resetCanvasNodeLayouts({ all: true }).catch(() => {
      projectActivities.report({
        kind: 'canvas-operation-failed',
        operation: 'reset-layout'
      });
    });
  }, [actions, projectActivities]);
  const setHierarchyEdgesVisible = useCallback((visible: boolean) => {
    void globalSettingsController.mutate({
      operation: 'set-hierarchy-edges-visible',
      hierarchyEdgesVisible: visible
    }).catch(() => undefined);
  }, [globalSettingsController]);
  const readyPhotoshop = globalProjection.photoshop.status === 'ready'
    ? globalProjection.photoshop.value
    : undefined;
  const projectPathCommandRouter = useMemo(() => createProjectPathCommandRouter({
    commandGate: projectCommandGate,
    api,
    projectTree: snapshot?.projectTree ?? [],
    projection: canvasProjection,
    explorer: explorerController,
    photoshop: readyPhotoshop,
    activities: projectActivities,
    closeContextMenu: closeWorkbenchContextMenu,
    openTerminalPanel: openProjectPathTerminalPanel,
    revealInCanvas: (projectRelativePath) => {
      void locateProjectFileInCanvas(projectRelativePath);
    },
    inspectEntries: (entries) => {
      inspectionTargetStore.publishPaths(entries.map((entry) => entry.projectRelativePath));
    },
    openInspectorPanel,
    resetCanvasNodeLayouts: (nodePaths) => resetCanvasNodeLayouts({ nodePaths }),
    confirmPermanentDelete,
    confirmTrash
  }), [
    api,
    canvasProjection,
    closeWorkbenchContextMenu,
    confirmTrash,
    confirmPermanentDelete,
    explorerController,
    locateProjectFileInCanvas,
    inspectionTargetStore,
    projectActivities,
    openProjectPathTerminalPanel,
    openInspectorPanel,
    readyPhotoshop,
    resetCanvasNodeLayouts,
    projectCommandGate,
    snapshot?.projectTree
  ]);
  const focusCommandRouter = useMemo(() => createWorkbenchFocusCommandRouter({
    getRuntime: () => canvasRuntime,
    getProjection: () => canvasProjection,
    getCanvasRoot: () => document.querySelector<HTMLElement>('[data-testid="canvas-surface"]'),
    getExplorerRoot: () => document.querySelector<HTMLElement>('.project-tree'),
    getProjectPathRouter: () => projectPathCommandRouter,
    getExplorerController: () => explorerController
  }), [canvasRuntime, canvasProjection, explorerController, projectPathCommandRouter]);
  focusCommandRouterRef.current = focusCommandRouter;
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) {
        return;
      }
      if (
        !getDebruteShellApi()
        && workbenchCommandShortcutMatches('project.open-picker', event, productPlatform)
      ) {
        const item = workbenchMenuCommandItem(effectiveTitleBarState, 'project.open-picker');
        if (item) {
          handleTitleBarCommand(item);
          event.preventDefault();
          event.stopPropagation();
        }
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
  }, [effectiveTitleBarState, focusCommandRouter, handleTitleBarCommand, productPlatform]);
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
      recentProjectRoots={presentationController.settings.chrome.recentProjectRoots}
      recentProjectUserHome={connectionEnvironment.userHome}
      onOpenRecentProject={openRecentProject}
      actions={actions}
      textFileBuffers={textFileBuffers}
      canvasFeedback={feedbackInteraction.feedback}
      onVideoMetadata={handleCanvasVideoMetadata}
      textPreviewStyleDependencyKey={presentationController.resolvedTheme}
      runtimeScopeKey={canvasRuntimeScopeKey}
      productPlatform={productPlatform}
      cutPaths={canvasCutPaths}
      feedbackInteraction={feedbackInteraction.canvas}
      onRuntimeChange={handleCanvasRuntimeChange}
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
          <div className="canvas-chrome-layer" data-testid="canvas-chrome-layer" inert={projectPresentationBlocked}>
            <CanvasMinimapBar
              runtime={canvasRuntime}
              overlayRuntime={canvasOverlayRuntime}
              open={canvasMinimapOpen}
              onOpenChange={setCanvasMinimapOpen}
              panelPlacement={minimapPanelPlacement}
              interactionBlocked={projectPresentationBlocked}
            />
            <CanvasResetLayoutButton
              enabled={Boolean(availableCanvasWorkspace && canvasState && canResetCanvasLayout)}
              onResetCanvasLayout={resetCanvasLayout}
            />
            {availableCanvasWorkspace ? (
              <CanvasFeedbackInteractionBar
                interaction={feedbackInteraction}
                availableMarks={globalSettingsController.settings.feedback.actionBar.flatMap((name) => {
                  const entry = globalSettingsController.settings.feedback.catalog.find((candidate) => candidate.name === name);
                  return entry ? [entry] : [];
                })}
                overlayRuntime={canvasOverlayRuntime}
                canvasRuntime={canvasRuntime}
                viewportRect={workbenchViewportRect}
                reservedRects={floatingBarReservedRects}
              />
            ) : null}
            <CanvasHierarchyEdgeVisibilityButton
              hierarchyEdgesVisible={hierarchyEdgesVisible}
              onHierarchyEdgesVisibleChange={setHierarchyEdgesVisible}
            />
          </div>
          <WorkbenchWindowHost
            ref={windowHostRef}
            canonicalRoot={canonicalRoot}
            viewportRect={workbenchViewportRect}
            interactionBlocked={projectPresentationBlocked}
            disabledPanelIds={disabledFloatingPanelIds}
            onPanelIntent={handlePanelIntent}
            renderPanelBody={(panelId) => (
              <FloatingPanelContent
                    panelId={panelId}
                    explorerPanel={snapshot ? (
                      <React.Suspense fallback={<div className="project-tree" aria-busy="true" />}>
                        <ProjectTree
                          key={projectProjection.generation}
                          generation={projectProjection.generation}
                          snapshot={snapshot}
                          state={explorerController.state}
                          productPlatform={productPlatform}
                          onSelectionChange={explorerController.setSelection}
                          onToggleDirectory={explorerController.toggleDirectory}
                          onBeginRename={explorerController.beginRename}
                          onBeginCreate={explorerController.beginCreate}
                          onEditValueChange={explorerController.updateEditValue}
                          onEditSubmit={() => { void explorerController.submitEdit(); }}
                          onEditCancel={explorerController.cancelEdit}
                          onInternalDrop={({ operation, entries, targetDirectoryProjectRelativePath }) => {
                            explorerController.transfer(operation, entries, targetDirectoryProjectRelativePath);
                          }}
                          onExternalDrop={explorerController.externalDrop}
                          onExternalDropError={() => {
                            projectActivities.report({ kind: 'explorer-operation-failed', operation: 'import' });
                          }}
                          onLocateFileInCanvas={locateProjectFileInCanvas}
                          onOpenContextMenu={openWorkbenchContextMenu}
                        />
                      </React.Suspense>
                    ) : <div className="project-tree" aria-busy="true" />}
                    inspectorPanel={(
                      <React.Suspense fallback={<div className="inspector" aria-busy="true" />}>
                        <WorkbenchInspectorPanelFeature
                          locale={presentationController.locale}
                          state={state}
                          targetStore={inspectionTargetStore}
                          actions={actions}
                        />
                      </React.Suspense>
                    )}
                    feedbackPanel={(
                      <FeedbackPanel
                        feedback={feedbackInteraction.feedback}
                        catalog={globalSettingsController.settings.feedback.catalog}
                        projectTree={snapshot?.projectTree ?? []}
                        onLocatePath={(path) => { void locateProjectFileInCanvas(path); }}
                        onClearMark={(path, mark) => feedbackInteraction.setMark([path], mark, false)}
                        onDeleteItem={feedbackInteraction.deleteCapsule}
                      />
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
            )}
          >
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
                      viewportRect={workbenchViewportRect}
                      buffer={textFileBuffers[windowState.projectRelativePath]}
                      actions={actions}
                      onClose={() => {
                        setTextEditorWindows((windows) => closeTextEditorWindowState(windows, windowState.projectRelativePath));
                      }}
                      onCommitRect={(rect) => {
                        setTextEditorWindows((windows) => commitTextEditorWindowRect(
                          windows,
                          windowState.projectRelativePath,
                          rect
                        ));
                      }}
                    />
                  </React.Suspense>
                ))}
              </CanvasTextRenderProfileGate>
            ) : null}
          </WorkbenchWindowHost>
          {!projectPresentationBlocked && contextMenu ? (
            <ProjectPathContextMenuHost
              contextMenu={contextMenu}
              router={projectPathCommandRouter}
              focusRouter={focusCommandRouter}
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
  focusRouter,
  productPlatform,
  onClose
}: {
  contextMenu: {
    target: WorkbenchContextMenuTarget;
    position: WorkbenchContextMenuPosition;
  };
  router: ProjectPathCommandRouter | undefined;
  focusRouter: Pick<WorkbenchFocusCommandRouter, 'restoreOwnerFocus'>;
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
      selectionCount={resolveProjectPathCommandTarget(contextMenu.target).length}
      onCommand={(command, photoshopTarget) => router.run(command, contextMenu, photoshopTarget)}
      onClose={onClose}
      onReturnFocus={() => focusRouter.restoreOwnerFocus(contextMenu.target.source)}
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
  textFileBuffers: Record<string, TextFileBuffer>;
} {
  const viewportRect = readWorkbenchViewportRect();
  if (!project) {
    return {
      viewportRect,
      textFileBuffers: {}
    };
  }
  return {
    viewportRect,
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

function projectPathDeletionConfirmationMessageForEntries(
  input: { entries: Array<{ projectRelativePath: string; kind: 'file' | 'directory' }> },
  labels: {
    directory(path: string): string;
    file(path: string): string;
    selectedItems(count: number): string;
  }
): string {
  if (input.entries.length !== 1) {
    return labels.selectedItems(input.entries.length);
  }
  const entry = input.entries[0]!;
  return entry.kind === 'directory'
    ? labels.directory(entry.projectRelativePath)
    : labels.file(entry.projectRelativePath);
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

function projectRootFromOpenError(error: Error): string | undefined {
  if (!(error instanceof DebruteHttpRequestError)) {
    return undefined;
  }
  return error.projectRoot;
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
