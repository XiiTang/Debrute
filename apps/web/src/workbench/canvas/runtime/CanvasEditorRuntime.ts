import type { CanvasStateChange } from '@debrute/app-protocol';
import type { CanvasProjection, ProjectedCanvasNode } from '../CanvasScene.js';
import {
  getCanvasResizePreserveAspect,
  isAdditiveCanvasSelectionModifier,
  normalizeCanvasWheelDelta,
  shouldCanvasHandleGlobalWheelTarget,
  type NormalizedCanvasWheelDelta
} from '../../services/canvasInteraction.js';
import {
  CANVAS_CAMERA_IDLE_MS,
  assertCanvasCamera,
  cameraCenteredOnCanvasPoint,
  cameraForGestureZoom,
  cameraForWheelDelta,
  cameraPanBy,
  canvasCameraReset,
  type CanvasCamera,
  type CanvasCameraState
} from './canvasCamera.js';
import {
  canvasRectToScreenRect,
  canvasToScreenPoint,
  normalizedSurfaceSize,
  screenToCanvasPoint,
  visibleCanvasRectForCamera
} from './canvasCoordinateSystem.js';
import {
  rectsIntersect,
  type CanvasPoint,
  type CanvasRect,
  type CanvasSize,
  type ResizeHandle
} from './canvasGeometry.js';
import type { CanvasSelection } from './canvasSelection.js';
import {
  canvasNodeSelection,
  normalizeCanvasSelection,
  pruneCanvasSelection,
  sameCanvasSelection,
  selectedNodeProjectRelativePaths,
  unionCanvasNodeSelection
} from './canvasSelection.js';
import {
  createCanvasManualLayoutLifecycle
} from './CanvasManualLayoutLifecycle.js';
import type { CanvasLayoutOverride } from '../canvasManualLayoutDraft.js';
import {
  createCanvasScenePresentation,
  type CanvasRuntimeScene
} from '../CanvasScenePresentation.js';
import {
  CANVAS_POINTER_ACTIVATION_DISTANCE,
  decideCanvasInteraction,
  type CanvasInteractionStateCommand
} from '../CanvasInteractionPolicy.js';

export interface CanvasSurfaceElements {
  surface: HTMLElement;
}

export interface CanvasRuntimeSnapshot {
  camera: CanvasCamera;
  cameraState: CanvasCameraState;
  selection: CanvasSelection | undefined;
  contentInteractionProjectRelativePath: string | undefined;
  pointerInteraction: CanvasRuntimePointerInteraction | undefined;
  surfaceSize: CanvasSize | undefined;
}

export interface CanvasCameraController {
  getCamera(): CanvasCamera;
  setCamera(camera: CanvasCamera): void;
  panBy(screenDelta: CanvasPoint): void;
  zoomByWheel(input: { screenPoint: CanvasPoint; delta: NormalizedCanvasWheelDelta }): void;
  zoomByGesture(input: { origin: CanvasPoint; scale: number; delta: CanvasPoint }): void;
  centerOn(canvasPoint: CanvasPoint): void;
  reset(): void;
}

export interface CanvasCoordinateSystem {
  screenToCanvas(point: CanvasPoint): CanvasPoint;
  canvasToScreen(point: CanvasPoint): CanvasPoint;
  canvasRectToScreen(rect: CanvasRect): CanvasRect;
  visibleCanvasRect(): CanvasRect;
  cameraForScreenCenteredPoint(point: CanvasPoint): CanvasCamera;
}

export interface CanvasInputController {
  screenToCanvasPoint(point: CanvasPoint): CanvasPoint;
  beginSelectionMarquee(input: {
    pointerId: number;
    screenPoint: CanvasPoint;
    modifiers: CanvasRuntimePointerModifiers;
    topEdgeInset?: number;
  }): void;
  beginNodeMove(input: {
    pointerId: number;
    projectRelativePath: string;
    screenPoint: CanvasPoint;
    modifiers?: CanvasRuntimePointerModifiers;
  }): void;
  beginNodeResize(input: {
    pointerId: number;
    handle: ResizeHandle;
    projectRelativePath: string;
    screenPoint: CanvasPoint;
    modifiers: CanvasRuntimePointerModifiers;
  }): void;
  updatePointerInteraction(input: {
    pointerId: number;
    screenPoint: CanvasPoint;
    modifiers?: CanvasRuntimePointerModifiers;
  }): boolean;
  finishPointerInteraction(input: {
    pointerId: number;
    screenPoint?: CanvasPoint;
    modifiers?: CanvasRuntimePointerModifiers;
  }): Promise<CanvasRuntimePointerInteraction | undefined>;
  cancelPointerInteraction(pointerId: number): void;
}

export interface CanvasEditorRuntime {
  readonly camera: CanvasCameraController;
  readonly coordinates: CanvasCoordinateSystem;
  readonly input: CanvasInputController;
  readonly scene: CanvasRuntimeScene;
  subscribe(listener: (snapshot: CanvasRuntimeSnapshot) => void): () => void;
  subscribeCamera(listener: (camera: CanvasCamera) => void): () => void;
  subscribeCameraState(listener: (state: CanvasCameraState) => void): () => void;
  subscribeSelection(listener: (selection: CanvasSelection | undefined) => void): () => void;
  subscribeContentInteraction(listener: (projectRelativePath: string | undefined) => void): () => void;
  subscribeSurfaceSize(listener: (size: CanvasSize | undefined) => void): () => void;
  subscribePointerInteraction(listener: (state: CanvasRuntimePointerInteraction | undefined) => void): () => void;
  getSnapshot(): CanvasRuntimeSnapshot;
  getSelectionIntentRevision(): number;
  bindSurface(elements: CanvasSurfaceElements): () => void;
  acceptProjection(projection: CanvasProjection): void;
  acceptCanvasStateChange(change: CanvasStateChange): void;
  setSelection(selection: CanvasSelection | undefined): void;
  setSelectionAndEndContentActivation(selection: CanvasSelection | undefined): void;
  activateContent(projectRelativePath: string): void;
  endContentActivation(): void;
  dispose(): void;
}

export type CanvasRuntimeMoveOrigin = Pick<ProjectedCanvasNode, 'projectRelativePath' | 'x' | 'y' | 'width' | 'height'>;
export type CanvasRuntimeResizeNode = Pick<ProjectedCanvasNode, 'projectRelativePath' | 'nodeKind' | 'mediaKind'>;
export interface CanvasRuntimePointerModifiers {
  shiftKey: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}

export type CanvasRuntimePointerInteraction =
  | {
      kind: 'selection-marquee';
      pointerId: number;
      phase: 'pending' | 'active';
      startScreen: CanvasPoint;
      currentScreen: CanvasPoint;
      start: CanvasPoint;
      current: CanvasPoint;
      rect?: CanvasRect;
      initialSelection: CanvasSelection | undefined;
      initialContentInteractionProjectRelativePath: string | undefined;
      additive: boolean;
      topEdgeInset: number;
    }
  | {
      kind: 'move-node';
      pointerId: number;
      phase: 'pending' | 'active';
      startScreen: CanvasPoint;
      currentScreen: CanvasPoint;
      start: CanvasPoint;
      current?: CanvasPoint;
      initialSelection: CanvasSelection | undefined;
      initialContentInteractionProjectRelativePath: string | undefined;
      pressedProjectRelativePath: string;
      additive: boolean;
      origins: CanvasRuntimeMoveOrigin[];
    }
  | {
      kind: 'resize-node';
      pointerId: number;
      phase: 'active';
      startScreen: CanvasPoint;
      currentScreen: CanvasPoint;
      handle: ResizeHandle;
      start: CanvasPoint;
      current?: CanvasPoint;
      initialSelection: CanvasSelection | undefined;
      initialContentInteractionProjectRelativePath: string | undefined;
      node: CanvasRuntimeResizeNode;
      origin: CanvasRect;
      preserveAspect: boolean;
    };

export type CanvasRuntimeLayoutInteraction = Exclude<
  CanvasRuntimePointerInteraction,
  { kind: 'selection-marquee' }
>;

type CanvasGestureEvent = Event & {
  clientX: number;
  clientY: number;
  scale: number;
};

interface RuntimeState {
  camera: CanvasCamera;
  cameraState: CanvasCameraState;
  selection: CanvasSelection | undefined;
  contentInteractionProjectRelativePath: string | undefined;
  pointerInteraction: CanvasRuntimePointerInteraction | undefined;
  surfaceSize: CanvasSize | undefined;
}

interface GestureState {
  camera: CanvasCamera;
  scale: number;
  origin: CanvasPoint;
}

interface CanvasSurfaceRect extends CanvasSize {
  left: number;
  top: number;
}

const UNBOUND_CANVAS_SURFACE_RECT: CanvasSurfaceRect = {
  left: 0,
  top: 0,
  width: 1,
  height: 1
};

export function createCanvasEditorRuntime(initial: {
  initialProjection: CanvasProjection;
  submitManualLayout(mutation: {
    selectedProjectRelativePaths: readonly string[];
    nodeLayouts: CanvasLayoutOverride[];
  }): Promise<void>;
  camera?: CanvasCamera;
  selection?: CanvasSelection | undefined;
}): CanvasEditorRuntime {
  const listeners = new Set<(snapshot: CanvasRuntimeSnapshot) => void>();
  const cameraListeners = new Set<(camera: CanvasCamera) => void>();
  const cameraStateListeners = new Set<(state: CanvasCameraState) => void>();
  const selectionListeners = new Set<(selection: CanvasSelection | undefined) => void>();
  const contentInteractionListeners = new Set<(projectRelativePath: string | undefined) => void>();
  const surfaceSizeListeners = new Set<(size: CanvasSize | undefined) => void>();
  const pointerInteractionListeners = new Set<(state: CanvasRuntimePointerInteraction | undefined) => void>();
  const initialSelection = pruneCanvasSelection(
    normalizeCanvasSelection(initial.selection),
    new Set(initial.initialProjection.nodes.map((node) => node.projectRelativePath))
  );
  const manualLayoutLifecycle = createCanvasManualLayoutLifecycle({
    initialProjection: initial.initialProjection,
    submitManualLayout: (mutation) => initial.submitManualLayout({
      ...mutation,
      selectedProjectRelativePaths: selectedNodeProjectRelativePaths(state.selection)
    })
  });
  const scenePresentation = createCanvasScenePresentation({
    projection: initial.initialProjection,
    presentation: {
      layoutOverrides: [],
      selectedProjectRelativePaths: selectedNodeProjectRelativePaths(initialSelection)
    }
  });
  let acceptedProjection = initial.initialProjection;
  let acceptedMembershipNodes = initial.initialProjection.nodes;
  const state: RuntimeState = {
    camera: initial.camera ?? canvasCameraReset(),
    cameraState: 'idle',
    selection: initialSelection,
    contentInteractionProjectRelativePath: undefined,
    pointerInteraction: undefined,
    surfaceSize: undefined
  };
  assertCanvasCamera(state.camera);

  let boundElements: CanvasSurfaceElements | undefined;
  let measuredSurfaceRect = UNBOUND_CANVAS_SURFACE_RECT;
  let resizeObserver: ResizeObserver | undefined;
  let idleTimer: number | undefined;
  let gestureState: GestureState | undefined;
  let cachedSnapshot: CanvasRuntimeSnapshot | undefined;
  let marqueeEdgeScrollFrame: number | undefined;
  let marqueeEdgeEnteredAt: number | undefined;
  let marqueeEdgeLastFrameAt: number | undefined;
  let selectionIntentRevision = 0;
  let disposed = false;

  const invalidateSnapshot = () => {
    cachedSnapshot = undefined;
  };

  const snapshot = (): CanvasRuntimeSnapshot => {
    cachedSnapshot ??= {
      camera: state.camera,
      cameraState: state.cameraState,
      selection: state.selection,
      contentInteractionProjectRelativePath: state.contentInteractionProjectRelativePath,
      pointerInteraction: state.pointerInteraction,
      surfaceSize: state.surfaceSize
    };
    return cachedSnapshot;
  };

  const notify = () => {
    invalidateSnapshot();
    const next = snapshot();
    for (const listener of listeners) {
      listener(next);
    }
  };

  const flushCameraStateListeners = (cameraState: CanvasCameraState) => {
    for (const listener of cameraStateListeners) {
      listener(cameraState);
    }
  };

  const flushSelectionListeners = (selection: CanvasSelection | undefined) => {
    for (const listener of selectionListeners) {
      listener(selection);
    }
  };

  const flushContentInteractionListeners = (projectRelativePath: string | undefined) => {
    for (const listener of contentInteractionListeners) {
      listener(projectRelativePath);
    }
  };

  const flushSurfaceSizeListeners = (size: CanvasSize | undefined) => {
    for (const listener of surfaceSizeListeners) {
      listener(size);
    }
  };

  const setCameraState = (cameraState: CanvasCameraState) => {
    if (state.cameraState === cameraState) {
      return;
    }
    state.cameraState = cameraState;
    invalidateSnapshot();
    flushCameraStateListeners(cameraState);
    notify();
  };

  const clearIdleTimer = () => {
    if (idleTimer !== undefined) {
      window.clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const scheduleIdle = () => {
    clearIdleTimer();
    idleTimer = window.setTimeout(() => {
      idleTimer = undefined;
      setCameraState('idle');
    }, CANVAS_CAMERA_IDLE_MS);
  };

  const flushCameraListeners = (camera: CanvasCamera) => {
    for (const listener of cameraListeners) {
      listener(camera);
    }
  };

  const commitCamera = (camera: CanvasCamera) => {
    if (disposed) {
      return;
    }
    assertCanvasCamera(camera);
    const previousCameraState = state.cameraState;
    state.camera = camera;
    state.cameraState = 'moving';
    invalidateSnapshot();
    flushCameraListeners(camera);
    if (previousCameraState !== 'moving') {
      flushCameraStateListeners('moving');
    }
    scheduleIdle();
  };

  const refreshSurfaceRect = (): CanvasSurfaceRect => {
    const rect = boundElements?.surface.getBoundingClientRect();
    measuredSurfaceRect = rect
      ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      : UNBOUND_CANVAS_SURFACE_RECT;
    return measuredSurfaceRect;
  };

  const surfaceRect = (): CanvasSurfaceRect => measuredSurfaceRect;

  const measuredSurfaceSize = (): CanvasSize => normalizedSurfaceSize(state.surfaceSize);

  const screenToCanvas = (point: CanvasPoint): CanvasPoint => screenToCanvasPoint({
    camera: state.camera,
    surfaceRect: surfaceRect(),
    screenPoint: point
  });

  const cameraController: CanvasCameraController = {
    getCamera: () => state.camera,
    setCamera: (camera) => commitCamera(camera),
    panBy: (screenDelta) => commitCamera(cameraPanBy(state.camera, screenDelta)),
    zoomByWheel: (input) => commitCamera(cameraForWheelDelta({
      camera: state.camera,
      surfaceRect: surfaceRect(),
      screenPoint: input.screenPoint,
      delta: input.delta
    })),
    zoomByGesture: (input) => commitCamera(cameraForGestureZoom({
      camera: state.camera,
      surfaceRect: surfaceRect(),
      origin: input.origin,
      scale: input.scale,
      delta: input.delta
    })),
    centerOn: (canvasPoint) => commitCamera(cameraCenteredOnCanvasPoint({
      center: canvasPoint,
      surfaceSize: measuredSurfaceSize(),
      camera: state.camera
    })),
    reset: () => commitCamera(canvasCameraReset())
  };

  const coordinates: CanvasCoordinateSystem = {
    screenToCanvas,
    canvasToScreen: (point) => canvasToScreenPoint({
      camera: state.camera,
      surfaceRect: surfaceRect(),
      canvasPoint: point
    }),
    canvasRectToScreen: (rect) => canvasRectToScreenRect({
      camera: state.camera,
      surfaceRect: surfaceRect(),
      canvasRect: rect
    }),
    visibleCanvasRect: () => visibleCanvasRectForCamera({
      camera: state.camera,
      surfaceSize: measuredSurfaceSize()
    }),
    cameraForScreenCenteredPoint: (point) => cameraCenteredOnCanvasPoint({
      center: screenToCanvas(point),
      surfaceSize: measuredSurfaceSize(),
      camera: state.camera
    })
  };

  const flushPointerInteractionListeners = (pointerInteraction: CanvasRuntimePointerInteraction | undefined) => {
    for (const listener of pointerInteractionListeners) {
      listener(pointerInteraction);
    }
  };

  const canvasPresentation = (selection = state.selection) => ({
    ...manualLayoutLifecycle.getPresentation(),
    selectedProjectRelativePaths: selectedNodeProjectRelativePaths(selection)
  });

  const applyCanvasPresentation = () => {
    scenePresentation.applyPresentation(canvasPresentation());
  };
  const setPointerInteraction = (
    pointerInteraction: CanvasRuntimePointerInteraction | undefined,
    options: {
      notifySnapshot: boolean;
      applyPresentation?: boolean;
      flushPointerListeners?: boolean;
    }
  ) => {
    state.pointerInteraction = pointerInteraction;
    manualLayoutLifecycle.setActiveInteraction(
      pointerInteraction?.kind !== 'selection-marquee' && pointerInteraction?.phase === 'active'
        ? pointerInteraction
        : undefined
    );
    invalidateSnapshot();
    if (options.applyPresentation !== false) {
      applyCanvasPresentation();
    }
    if (options.flushPointerListeners !== false) {
      flushPointerInteractionListeners(pointerInteraction);
      syncMarqueeEdgeScroll(pointerInteraction);
    }
    if (options.notifySnapshot) {
      notify();
    }
  };

  const resizePreserveAspect = (
    state: Pick<Extract<CanvasRuntimePointerInteraction, { kind: 'resize-node' }>, 'handle' | 'node'>,
    modifiers: CanvasRuntimePointerModifiers
  ): boolean => getCanvasResizePreserveAspect(state.handle, modifiers, state.node);

  const presentedNode = (projectRelativePath: string): ProjectedCanvasNode => {
    const node = scenePresentation.getPresentedNodes().get(projectRelativePath);
    if (!node) {
      throw new Error(`Canvas node is not present: ${projectRelativePath}`);
    }
    return node;
  };

  const commitSelectionAndContentActivation = (input: {
    selection: CanvasSelection | undefined;
    contentInteractionProjectRelativePath: string | undefined;
    selectionIntent?: boolean;
    strictActivation?: boolean;
    applyPresentation?: boolean;
    notifySnapshot?: boolean;
  }): { selectionChanged: boolean; contentInteractionChanged: boolean } => {
    if (input.selectionIntent) {
      selectionIntentRevision += 1;
    }
    const selection = normalizeCanvasSelection(input.selection);
    const selectedPaths = selectedNodeProjectRelativePaths(selection);
    const requestedContentPath = input.contentInteractionProjectRelativePath;
    const contentNode = requestedContentPath
      ? scenePresentation.getPresentedNodes().get(requestedContentPath)
      : undefined;
    const activationValid = requestedContentPath !== undefined
      && selectedPaths.length === 1
      && selectedPaths[0] === requestedContentPath
      && isContentCapableNode(contentNode);
    if (requestedContentPath !== undefined && !activationValid && input.strictActivation) {
      throw new Error(`Canvas Content Activation requires a sole selected text, video, or audio node: ${requestedContentPath}`);
    }
    const contentInteractionProjectRelativePath = activationValid
      ? requestedContentPath
      : undefined;
    const selectionChanged = !sameCanvasSelection(state.selection, selection);
    const contentInteractionChanged = state.contentInteractionProjectRelativePath
      !== contentInteractionProjectRelativePath;
    if (!selectionChanged && !contentInteractionChanged) {
      return { selectionChanged: false, contentInteractionChanged: false };
    }
    state.selection = selection;
    state.contentInteractionProjectRelativePath = contentInteractionProjectRelativePath;
    if (input.applyPresentation !== false) {
      applyCanvasPresentation();
    }
    invalidateSnapshot();
    if (selectionChanged) {
      flushSelectionListeners(selection);
    }
    if (contentInteractionChanged) {
      flushContentInteractionListeners(contentInteractionProjectRelativePath);
    }
    if (input.notifySnapshot !== false) {
      notify();
    }
    return { selectionChanged, contentInteractionChanged };
  };

  const commitSelectionPreservingValidActivation = (
    selection: CanvasSelection | undefined,
    selectionIntent = true,
    notifySnapshot = true
  ) => {
    const selectedPaths = selectedNodeProjectRelativePaths(selection);
    const currentContentPath = state.contentInteractionProjectRelativePath;
    commitSelectionAndContentActivation({
      selection,
      contentInteractionProjectRelativePath: currentContentPath
        && selectedPaths.length === 1
        && selectedPaths[0] === currentContentPath
        ? currentContentPath
        : undefined,
      selectionIntent,
      notifySnapshot
    });
  };

  const commitSelectionAndEndContentActivation = (
    selection: CanvasSelection | undefined,
    selectionIntent = true,
    notifySnapshot = true
  ) => commitSelectionAndContentActivation({
    selection,
    contentInteractionProjectRelativePath: undefined,
    selectionIntent,
    notifySnapshot
  });

  const activateContent = (projectRelativePath: string) => commitSelectionAndContentActivation({
    selection: canvasNodeSelection([projectRelativePath]),
    contentInteractionProjectRelativePath: projectRelativePath,
    selectionIntent: true,
    strictActivation: true
  });

  const endContentActivation = () => commitSelectionAndContentActivation({
    selection: state.selection,
    contentInteractionProjectRelativePath: undefined
  });

  const commitInteractionStateCommand = (
    command: CanvasInteractionStateCommand,
    options: {
      applyPresentation?: boolean;
      notifySnapshot?: boolean;
    } = {}
  ) => {
    switch (command.kind) {
      case 'preserve':
        return;
      case 'end-content-activation':
        commitSelectionAndContentActivation({
          selection: state.selection,
          contentInteractionProjectRelativePath: undefined,
          ...options
        });
        return;
      case 'set-selection-and-end-content-activation':
        commitSelectionAndContentActivation({
          selection: command.selection,
          contentInteractionProjectRelativePath: undefined,
          selectionIntent: true,
          ...options
        });
        return;
      case 'activate-content':
        commitSelectionAndContentActivation({
          selection: canvasNodeSelection([command.projectRelativePath]),
          contentInteractionProjectRelativePath: command.projectRelativePath,
          selectionIntent: true,
          strictActivation: true,
          ...options
        });
    }
  };

  const commitPointerInteractionAndState = (
    pointerInteraction: CanvasRuntimePointerInteraction | undefined,
    commitState: () => void,
    notifySnapshot = true
  ) => {
    setPointerInteraction(pointerInteraction, {
      notifySnapshot: false,
      applyPresentation: false,
      flushPointerListeners: false
    });
    commitState();
    applyCanvasPresentation();
    flushPointerInteractionListeners(pointerInteraction);
    syncMarqueeEdgeScroll(pointerInteraction);
    if (notifySnapshot) {
      notify();
    }
  };

  const pointerInteractionWithPointer = (
    active: CanvasRuntimePointerInteraction,
    screenPoint: CanvasPoint | undefined,
    modifiers: CanvasRuntimePointerModifiers | undefined
  ): CanvasRuntimePointerInteraction => {
    const nextScreen = screenPoint ?? active.currentScreen;
    const nextCanvas = screenToCanvas(nextScreen);
    if (active.kind === 'selection-marquee') {
      const phase = active.phase === 'active' || screenDistance(active.startScreen, nextScreen) > CANVAS_POINTER_ACTIVATION_DISTANCE
        ? 'active'
        : 'pending';
      return {
        ...active,
        phase,
        currentScreen: nextScreen,
        current: nextCanvas,
        additive: modifiers ? additiveSelectionModifier(modifiers) : active.additive,
        ...(phase === 'active' ? { rect: rectFromPoints(active.start, nextCanvas) } : {})
      };
    }
    if (active.kind === 'move-node') {
      const phase = active.phase === 'active' || screenDistance(active.startScreen, nextScreen) > CANVAS_POINTER_ACTIVATION_DISTANCE
        ? 'active'
        : 'pending';
      return {
        ...active,
        phase,
        currentScreen: nextScreen,
        additive: modifiers ? additiveSelectionModifier(modifiers) : active.additive,
        ...(phase === 'active' ? { current: nextCanvas } : {})
      };
    }
    const next = {
      ...active,
      currentScreen: nextScreen,
      current: nextCanvas
    };
    if (!modifiers) {
      return next;
    }
    return {
      ...next,
      preserveAspect: resizePreserveAspect(next, modifiers)
    };
  };

  const marqueeSelection = (
    interaction: Extract<CanvasRuntimePointerInteraction, { kind: 'selection-marquee' }>
  ): CanvasSelection | undefined => {
    if (interaction.phase !== 'active' || !interaction.rect) {
      return interaction.initialSelection;
    }
    const presentedNodes = scenePresentation.getPresentedNodes();
    const hitPaths = scenePresentation.queryNodePaths(interaction.rect)
      .filter((path) => {
        const node = presentedNodes.get(path);
        return node ? rectsIntersect(interaction.rect!, node) : false;
      });
    return interaction.additive
      ? unionCanvasNodeSelection(interaction.initialSelection, hitPaths)
      : canvasNodeSelection(hitPaths);
  };

  const stopMarqueeEdgeScroll = () => {
    if (marqueeEdgeScrollFrame !== undefined) {
      window.cancelAnimationFrame(marqueeEdgeScrollFrame);
      marqueeEdgeScrollFrame = undefined;
    }
    marqueeEdgeEnteredAt = undefined;
    marqueeEdgeLastFrameAt = undefined;
  };

  const marqueeEdgeVector = (
    interaction: Extract<CanvasRuntimePointerInteraction, { kind: 'selection-marquee' }>
  ): CanvasPoint => {
    const rect = surfaceRect();
    return {
      x: edgeProximity(interaction.currentScreen.x, rect.left, rect.left + rect.width),
      y: edgeProximity(
        interaction.currentScreen.y,
        rect.top + interaction.topEdgeInset,
        rect.top + rect.height
      )
    };
  };

  const runMarqueeEdgeScrollFrame = (timestamp: number) => {
    marqueeEdgeScrollFrame = undefined;
    const active = state.pointerInteraction;
    if (active?.kind !== 'selection-marquee' || active.phase !== 'active') {
      stopMarqueeEdgeScroll();
      return;
    }
    const edge = marqueeEdgeVector(active);
    if (edge.x === 0 && edge.y === 0) {
      stopMarqueeEdgeScroll();
      return;
    }
    marqueeEdgeEnteredAt ??= timestamp;
    marqueeEdgeLastFrameAt ??= timestamp;
    const elapsed = timestamp - marqueeEdgeEnteredAt;
    const frameSeconds = Math.max(0, Math.min(64, timestamp - marqueeEdgeLastFrameAt)) / 1000;
    marqueeEdgeLastFrameAt = timestamp;
    if (elapsed > MARQUEE_EDGE_SCROLL_DELAY_MS && frameSeconds > 0) {
      const ease = Math.min(1, (elapsed - MARQUEE_EDGE_SCROLL_DELAY_MS) / MARQUEE_EDGE_SCROLL_EASE_MS);
      cameraController.panBy({
        x: -edge.x * MARQUEE_EDGE_SCROLL_MAX_SPEED * ease * frameSeconds,
        y: -edge.y * MARQUEE_EDGE_SCROLL_MAX_SPEED * ease * frameSeconds
      });
      const next = pointerInteractionWithPointer(active, active.currentScreen, undefined);
      commitPointerInteractionAndState(next, () => {
        commitSelectionAndContentActivation({
          selection: marqueeSelection(next as Extract<CanvasRuntimePointerInteraction, { kind: 'selection-marquee' }>),
          contentInteractionProjectRelativePath: undefined,
          selectionIntent: false,
          applyPresentation: false,
          notifySnapshot: false
        });
      }, false);
      return;
    }
    syncMarqueeEdgeScroll(state.pointerInteraction);
  };

  const syncMarqueeEdgeScroll = (
    interaction: CanvasRuntimePointerInteraction | undefined
  ) => {
    if (interaction?.kind !== 'selection-marquee' || interaction.phase !== 'active') {
      stopMarqueeEdgeScroll();
      return;
    }
    const edge = marqueeEdgeVector(interaction);
    if (edge.x === 0 && edge.y === 0) {
      stopMarqueeEdgeScroll();
      return;
    }
    if (marqueeEdgeScrollFrame === undefined) {
      marqueeEdgeScrollFrame = window.requestAnimationFrame(runMarqueeEdgeScrollFrame);
    }
  };

  const handleWheel = (event: WheelEvent) => {
    if (!shouldCanvasHandleGlobalWheelTarget(
      event.target,
      boundElements?.surface ?? null,
      event.ctrlKey || event.metaKey
    )) {
      return;
    }
    event.preventDefault();
    cameraController.zoomByWheel({
      screenPoint: { x: event.clientX, y: event.clientY },
      delta: normalizeCanvasWheelDelta(event)
    });
  };

  const handleGestureStart = (event: Event) => {
    if (!shouldCanvasHandleGlobalWheelTarget(event.target, boundElements?.surface ?? null, true)) {
      return;
    }
    const gesture = event as CanvasGestureEvent;
    const scale = positiveFiniteScale(gesture.scale);
    if (scale === undefined) {
      return;
    }
    event.preventDefault();
    gestureState = {
      camera: state.camera,
      scale,
      origin: { x: gesture.clientX, y: gesture.clientY }
    };
  };

  const handleGestureChange = (event: Event) => {
    if (!shouldCanvasHandleGlobalWheelTarget(event.target, boundElements?.surface ?? null, true)) {
      return;
    }
    const gesture = event as CanvasGestureEvent;
    const scale = positiveFiniteScale(gesture.scale);
    if (scale === undefined) {
      return;
    }
    event.preventDefault();
    const start = gestureState ?? {
      camera: state.camera,
      scale: 1,
      origin: { x: gesture.clientX, y: gesture.clientY }
    };
    const nextScale = scale / start.scale;
    if (!Number.isFinite(nextScale) || nextScale <= 0) {
      return;
    }
    commitCamera(cameraForGestureZoom({
      camera: start.camera,
      surfaceRect: surfaceRect(),
      origin: start.origin,
      scale: nextScale,
      delta: {
        x: gesture.clientX - start.origin.x,
        y: gesture.clientY - start.origin.y
      }
    }));
  };

  const handleGestureEnd = () => {
    gestureState = undefined;
  };

  const attachWindowInput = () => {
    window.addEventListener('wheel', handleWheel, { capture: true, passive: false });
    window.addEventListener('gesturestart', handleGestureStart, { capture: true, passive: false });
    window.addEventListener('gesturechange', handleGestureChange, { capture: true, passive: false });
    window.addEventListener('gestureend', handleGestureEnd, { capture: true });
    return () => {
      window.removeEventListener('wheel', handleWheel, { capture: true });
      window.removeEventListener('gesturestart', handleGestureStart, { capture: true });
      window.removeEventListener('gesturechange', handleGestureChange, { capture: true });
      window.removeEventListener('gestureend', handleGestureEnd, { capture: true });
    };
  };

  let detachWindowInput: () => void = () => undefined;

  const acceptProjection = (projection: CanvasProjection): void => {
    if (projection === acceptedProjection) {
      return;
    }
    if (projection.nodes === acceptedMembershipNodes) {
      acceptedProjection = { ...acceptedProjection, edges: projection.edges };
      scenePresentation.setHierarchyEdges(projection.edges);
      scenePresentation.publishRenderSnapshot();
      return;
    }
    const currentPaths = new Set(projection.nodes.map((node) => node.projectRelativePath));
    const previousPointerInteraction = state.pointerInteraction;
    const previousSelection = state.selection;
    const previousContentInteraction = state.contentInteractionProjectRelativePath;
    let nextPointerInteraction = previousPointerInteraction;
    let nextSelection = pruneCanvasSelection(previousSelection, currentPaths);
    if (
      previousPointerInteraction?.kind === 'move-node'
      && previousPointerInteraction.origins.some((origin) => !currentPaths.has(origin.projectRelativePath))
    ) {
      nextPointerInteraction = undefined;
      nextSelection = pruneCanvasSelection(previousPointerInteraction.initialSelection, currentPaths);
    } else if (
      previousPointerInteraction?.kind === 'resize-node'
      && !currentPaths.has(previousPointerInteraction.node.projectRelativePath)
    ) {
      nextPointerInteraction = undefined;
      nextSelection = pruneCanvasSelection(previousPointerInteraction.initialSelection, currentPaths);
    } else if (previousPointerInteraction?.kind === 'selection-marquee') {
      nextPointerInteraction = pointerInteractionWithPointer({
        ...previousPointerInteraction,
        initialSelection: pruneCanvasSelection(previousPointerInteraction.initialSelection, currentPaths)
      }, previousPointerInteraction.currentScreen, undefined);
    }
    manualLayoutLifecycle.setActiveInteraction(
      nextPointerInteraction?.kind !== 'selection-marquee' && nextPointerInteraction?.phase === 'active'
        ? nextPointerInteraction
        : undefined
    );
    manualLayoutLifecycle.acceptProjection(projection);
    acceptedMembershipNodes = projection.nodes;
    acceptedProjection = projection;
    scenePresentation.setProjection(projection, canvasPresentation(nextSelection));
    if (nextPointerInteraction?.kind === 'selection-marquee') {
      nextSelection = marqueeSelection(nextPointerInteraction);
      scenePresentation.applyPresentation(canvasPresentation(nextSelection));
    }

    state.pointerInteraction = nextPointerInteraction;
    const pointerChanged = previousPointerInteraction !== nextPointerInteraction;
    const restorationContentPath = pointerChanged && nextPointerInteraction === undefined
      ? previousPointerInteraction?.initialContentInteractionProjectRelativePath
      : previousContentInteraction;
    const stateChanges = commitSelectionAndContentActivation({
      selection: nextSelection,
      contentInteractionProjectRelativePath: restorationContentPath,
      applyPresentation: false,
      notifySnapshot: false
    });
    if (pointerChanged || stateChanges.selectionChanged || stateChanges.contentInteractionChanged) {
      invalidateSnapshot();
    }
    scenePresentation.publishRenderSnapshot();
    if (pointerChanged) {
      flushPointerInteractionListeners(nextPointerInteraction);
      syncMarqueeEdgeScroll(nextPointerInteraction);
    }
    if (pointerChanged || stateChanges.selectionChanged || stateChanges.contentInteractionChanged) {
      notify();
    }
  };

  const acceptCanvasStateChange = (change: CanvasStateChange): void => {
    scenePresentation.acceptCanvasStateChange(change);
    acceptedProjection = scenePresentation.getProjection();
    manualLayoutLifecycle.acceptNodes(
      change.nodeStates.flatMap(({ projectRelativePath }) => {
        const node = scenePresentation.getAcceptedNode(projectRelativePath);
        return node ? [node] : [];
      })
    );
    scenePresentation.applyPresentation(canvasPresentation(state.selection));
  };

  const runtime: CanvasEditorRuntime = {
    camera: cameraController,
    coordinates,
    scene: scenePresentation,
    input: {
      screenToCanvasPoint: screenToCanvas,
      beginSelectionMarquee: (input) => {
        refreshSurfaceRect();
        setPointerInteraction({
          kind: 'selection-marquee',
          pointerId: input.pointerId,
          phase: 'pending',
          startScreen: input.screenPoint,
          currentScreen: input.screenPoint,
          start: screenToCanvas(input.screenPoint),
          current: screenToCanvas(input.screenPoint),
          initialSelection: state.selection,
          initialContentInteractionProjectRelativePath: state.contentInteractionProjectRelativePath,
          additive: additiveSelectionModifier(input.modifiers),
          topEdgeInset: input.topEdgeInset ?? 0
        }, { notifySnapshot: false });
      },
      beginNodeMove: (input) => {
        refreshSurfaceRect();
        const initialSelection = state.selection;
        const additive = additiveSelectionModifier(input.modifiers);
        const node = presentedNode(input.projectRelativePath);
        const thresholdDecision = decideCanvasInteraction({
          event: 'manipulation-threshold',
          target: {
            kind: 'node',
            projectRelativePath: node.projectRelativePath,
            ...(node.mediaKind === undefined ? {} : { mediaKind: node.mediaKind }),
            zone: 'manipulation'
          },
          selection: initialSelection,
          contentActivationProjectRelativePath: state.contentInteractionProjectRelativePath,
          additive
        });
        if (thresholdDecision.gesture !== 'move'
          || thresholdDecision.state.kind !== 'set-selection-and-end-content-activation') {
          throw new Error(`Canvas manipulation policy did not produce a move selection for ${input.projectRelativePath}.`);
        }
        const proposedSelection = thresholdDecision.state.selection;
        const selectedPaths = new Set(selectedNodeProjectRelativePaths(proposedSelection));
        const start = screenToCanvas(input.screenPoint);
        setPointerInteraction({
          kind: 'move-node',
          pointerId: input.pointerId,
          phase: 'pending',
          startScreen: input.screenPoint,
          currentScreen: input.screenPoint,
          start,
          initialSelection,
          initialContentInteractionProjectRelativePath: state.contentInteractionProjectRelativePath,
          pressedProjectRelativePath: input.projectRelativePath,
          additive,
          origins: [...selectedPaths].flatMap((path) => scenePresentation.getPresentedNodes().get(path) ?? [])
        }, { notifySnapshot: false });
      },
      beginNodeResize: (input) => {
        refreshSurfaceRect();
        const node = presentedNode(input.projectRelativePath);
        const initialSelection = state.selection;
        const initialContentInteractionProjectRelativePath = state.contentInteractionProjectRelativePath;
        const decision = decideCanvasInteraction({
          event: 'resize-start',
          target: {
            kind: 'node',
            projectRelativePath: node.projectRelativePath,
            ...(node.mediaKind === undefined ? {} : { mediaKind: node.mediaKind }),
            zone: 'resize'
          },
          selection: initialSelection,
          contentActivationProjectRelativePath: initialContentInteractionProjectRelativePath,
          additive: additiveSelectionModifier(input.modifiers)
        });
        if (decision.gesture !== 'resize') {
          throw new Error(`Canvas interaction policy did not produce resize for ${input.projectRelativePath}.`);
        }
        const start = screenToCanvas(input.screenPoint);
        const interaction: Extract<CanvasRuntimePointerInteraction, { kind: 'resize-node' }> = {
          kind: 'resize-node',
          pointerId: input.pointerId,
          phase: 'active',
          startScreen: input.screenPoint,
          currentScreen: input.screenPoint,
          handle: input.handle,
          start,
          initialSelection,
          initialContentInteractionProjectRelativePath,
          node: {
            projectRelativePath: node.projectRelativePath,
            nodeKind: node.nodeKind,
            ...(node.mediaKind === undefined ? {} : { mediaKind: node.mediaKind })
          },
          origin: {
            x: node.x,
            y: node.y,
            width: node.width,
            height: node.height
          },
          preserveAspect: resizePreserveAspect({
            handle: input.handle,
            node
          }, input.modifiers)
        };
        commitPointerInteractionAndState(interaction, () => {
          commitInteractionStateCommand(decision.state, {
            applyPresentation: false,
            notifySnapshot: false
          });
        });
      },
      updatePointerInteraction: (input) => {
        const active = state.pointerInteraction;
        if (!active || active.pointerId !== input.pointerId) {
          return false;
        }
        const next = pointerInteractionWithPointer(active, input.screenPoint, input.modifiers);
        const moveBecameActive = (
          active.kind === 'move-node'
          && active.phase === 'pending'
          && next.kind === 'move-node'
          && next.phase === 'active'
        );
        const marqueeBecameActive = (
          active.kind === 'selection-marquee'
          && active.phase === 'pending'
          && next.kind === 'selection-marquee'
          && next.phase === 'active'
        );
        if (moveBecameActive && next.kind === 'move-node') {
          const pressedNode = presentedNode(active.pressedProjectRelativePath);
          const decision = decideCanvasInteraction({
            event: 'manipulation-threshold',
            target: {
              kind: 'node',
              projectRelativePath: pressedNode.projectRelativePath,
              ...(pressedNode.mediaKind === undefined ? {} : { mediaKind: pressedNode.mediaKind }),
              zone: 'manipulation'
            },
            selection: active.initialSelection,
            contentActivationProjectRelativePath: active.initialContentInteractionProjectRelativePath,
            additive: next.additive
          });
          if (decision.gesture !== 'move'
            || decision.state.kind !== 'set-selection-and-end-content-activation') {
            throw new Error(`Canvas interaction policy did not produce move for ${active.pressedProjectRelativePath}.`);
          }
          const activatedSelectionPaths = selectedNodeProjectRelativePaths(decision.state.selection);
          const activatedMove = {
            ...next,
            origins: activatedSelectionPaths.flatMap((path) => (
              scenePresentation.getPresentedNodes().get(path) ?? []
            ))
          };
          commitPointerInteractionAndState(activatedMove, () => {
            commitInteractionStateCommand(decision.state, {
              applyPresentation: false,
              notifySnapshot: false
            });
          });
          return true;
        } else if (marqueeBecameActive && next.kind === 'selection-marquee') {
          const decision = decideCanvasInteraction({
            event: 'manipulation-threshold',
            target: { kind: 'blank' },
            selection: active.initialSelection,
            contentActivationProjectRelativePath: active.initialContentInteractionProjectRelativePath,
            additive: next.additive
          });
          if (decision.gesture !== 'marquee'
            || decision.state.kind !== 'end-content-activation') {
            throw new Error('Canvas interaction policy did not produce a blank-area marquee.');
          }
          commitPointerInteractionAndState(next, () => {
            commitSelectionAndContentActivation({
              selection: marqueeSelection(next),
              contentInteractionProjectRelativePath: undefined,
              selectionIntent: true,
              applyPresentation: false,
              notifySnapshot: false
            });
          });
          return true;
        }
        if (next.kind === 'selection-marquee') {
          commitPointerInteractionAndState(next, () => {
            commitSelectionAndContentActivation({
              selection: marqueeSelection(next),
              contentInteractionProjectRelativePath: undefined,
              selectionIntent: true,
              applyPresentation: false,
              notifySnapshot: false
            });
          }, false);
        } else {
          setPointerInteraction(next, { notifySnapshot: false });
        }
        return true;
      },
      finishPointerInteraction: async (input) => {
        const active = state.pointerInteraction;
        if (!active || active.pointerId !== input.pointerId) {
          return undefined;
        }
        const finished = pointerInteractionWithPointer(active, input.screenPoint, input.modifiers);
        if (finished.kind === 'selection-marquee') {
          if (finished.phase === 'pending') {
            const decision = decideCanvasInteraction({
              event: 'completed-click',
              target: { kind: 'blank' },
              selection: finished.initialSelection,
              contentActivationProjectRelativePath: finished.initialContentInteractionProjectRelativePath,
              additive: finished.additive
            });
            commitPointerInteractionAndState(undefined, () => {
              commitInteractionStateCommand(decision.state, {
                applyPresentation: false,
                notifySnapshot: false
              });
            });
          } else {
            commitPointerInteractionAndState(undefined, () => {
              commitSelectionAndContentActivation({
                selection: marqueeSelection(finished),
                contentInteractionProjectRelativePath: undefined,
                selectionIntent: true,
                applyPresentation: false,
                notifySnapshot: false
              });
            });
          }
          return finished;
        }
        if (finished.kind === 'move-node' && finished.phase === 'pending') {
          const pressedNode = presentedNode(finished.pressedProjectRelativePath);
          const decision = decideCanvasInteraction({
            event: 'completed-click',
            target: {
              kind: 'node',
              projectRelativePath: pressedNode.projectRelativePath,
              ...(pressedNode.mediaKind === undefined ? {} : { mediaKind: pressedNode.mediaKind }),
              zone: 'manipulation'
            },
            selection: finished.initialSelection,
            contentActivationProjectRelativePath: finished.initialContentInteractionProjectRelativePath,
            additive: finished.additive
          });
          commitPointerInteractionAndState(undefined, () => {
            commitInteractionStateCommand(decision.state, {
              applyPresentation: false,
              notifySnapshot: false
            });
          });
          return finished;
        }
        const submission = manualLayoutLifecycle.submitFinishedInteraction(finished);
        setPointerInteraction(undefined, { notifySnapshot: true });
        try {
          await submission;
        } catch (error) {
          applyCanvasPresentation();
          throw error;
        }
        return finished;
      },
      cancelPointerInteraction: (pointerId) => {
        const active = state.pointerInteraction;
        if (active?.pointerId === pointerId) {
          commitPointerInteractionAndState(undefined, () => {
            commitSelectionAndContentActivation({
              selection: active.initialSelection,
              contentInteractionProjectRelativePath: active.initialContentInteractionProjectRelativePath,
              applyPresentation: false,
              notifySnapshot: false
            });
          });
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeCamera: (listener) => {
      cameraListeners.add(listener);
      return () => {
        cameraListeners.delete(listener);
      };
    },
    subscribeCameraState: (listener) => {
      cameraStateListeners.add(listener);
      return () => {
        cameraStateListeners.delete(listener);
      };
    },
    subscribeSelection: (listener) => {
      selectionListeners.add(listener);
      return () => {
        selectionListeners.delete(listener);
      };
    },
    subscribeContentInteraction: (listener) => {
      contentInteractionListeners.add(listener);
      return () => {
        contentInteractionListeners.delete(listener);
      };
    },
    subscribeSurfaceSize: (listener) => {
      surfaceSizeListeners.add(listener);
      return () => {
        surfaceSizeListeners.delete(listener);
      };
    },
    subscribePointerInteraction: (listener) => {
      pointerInteractionListeners.add(listener);
      return () => {
        pointerInteractionListeners.delete(listener);
      };
    },
    getSnapshot: snapshot,
    getSelectionIntentRevision: () => selectionIntentRevision,
    bindSurface: (elements) => {
      boundElements = elements;
      const surfaceRect = refreshSurfaceRect();
      const nextSize = {
        width: surfaceRect.width,
        height: surfaceRect.height
      };
      state.surfaceSize = nextSize;
      invalidateSnapshot();
      flushSurfaceSizeListeners(nextSize);
      notify();
      detachWindowInput();
      detachWindowInput = attachWindowInput();
      resizeObserver?.disconnect();
      resizeObserver = new ResizeObserver(() => {
        const rect = refreshSurfaceRect();
        const size = {
          width: rect.width,
          height: rect.height
        };
        if (state.surfaceSize?.width === size.width && state.surfaceSize.height === size.height) {
          return;
        }
        state.surfaceSize = size;
        invalidateSnapshot();
        flushSurfaceSizeListeners(size);
        notify();
      });
      resizeObserver.observe(elements.surface);
      return () => {
        if (boundElements === elements) {
          boundElements = undefined;
          measuredSurfaceRect = UNBOUND_CANVAS_SURFACE_RECT;
        }
        resizeObserver?.disconnect();
        resizeObserver = undefined;
        detachWindowInput();
        detachWindowInput = () => undefined;
      };
    },
    acceptProjection,
    acceptCanvasStateChange,
    setSelection: commitSelectionPreservingValidActivation,
    setSelectionAndEndContentActivation: commitSelectionAndEndContentActivation,
    activateContent,
    endContentActivation,
    dispose: () => {
      disposed = true;
      manualLayoutLifecycle.dispose();
      scenePresentation.dispose();
      stopMarqueeEdgeScroll();
      clearIdleTimer();
      resizeObserver?.disconnect();
      resizeObserver = undefined;
      detachWindowInput();
      detachWindowInput = () => undefined;
      listeners.clear();
      cameraListeners.clear();
      cameraStateListeners.clear();
      selectionListeners.clear();
      contentInteractionListeners.clear();
      surfaceSizeListeners.clear();
      pointerInteractionListeners.clear();
      boundElements = undefined;
    }
  };

  return runtime;
}

function positiveFiniteScale(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function isContentCapableNode(node: ProjectedCanvasNode | undefined): boolean {
  return node?.mediaKind === 'text'
    || node?.mediaKind === 'video'
    || node?.mediaKind === 'audio';
}

const MARQUEE_EDGE_SCROLL_ZONE = 8;
const MARQUEE_EDGE_SCROLL_DELAY_MS = 200;
const MARQUEE_EDGE_SCROLL_EASE_MS = 200;
const MARQUEE_EDGE_SCROLL_MAX_SPEED = 800;

function additiveSelectionModifier(modifiers: CanvasRuntimePointerModifiers | undefined): boolean {
  return modifiers ? isAdditiveCanvasSelectionModifier(modifiers) : false;
}

function screenDistance(left: CanvasPoint, right: CanvasPoint): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function edgeProximity(value: number, min: number, max: number): number {
  if (value < min + MARQUEE_EDGE_SCROLL_ZONE) {
    return -((min + MARQUEE_EDGE_SCROLL_ZONE - value) / MARQUEE_EDGE_SCROLL_ZONE);
  }
  if (value > max - MARQUEE_EDGE_SCROLL_ZONE) {
    return (value - (max - MARQUEE_EDGE_SCROLL_ZONE)) / MARQUEE_EDGE_SCROLL_ZONE;
  }
  return 0;
}

function rectFromPoints(left: CanvasPoint, right: CanvasPoint): CanvasRect {
  return {
    x: Math.min(left.x, right.x),
    y: Math.min(left.y, right.y),
    width: Math.abs(right.x - left.x),
    height: Math.abs(right.y - left.y)
  };
}
