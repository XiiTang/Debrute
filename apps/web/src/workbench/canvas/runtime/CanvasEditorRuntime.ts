import type { CanvasProjection, ProjectedCanvasNode } from '@debrute/canvas-core';
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
  isCanvasNodeSelected,
  normalizeCanvasSelection,
  pruneCanvasSelection,
  sameCanvasSelection,
  selectedNodeProjectRelativePaths,
  toggleCanvasNodeSelection,
  unionCanvasNodeSelection
} from './canvasSelection.js';
import {
  createCanvasManualLayoutLifecycle,
  type CanvasManualLayoutPresentation
} from './CanvasManualLayoutLifecycle.js';
import type { CanvasLayoutOverride } from '../canvasManualLayoutDraft.js';

export interface CanvasSurfaceElements {
  surface: HTMLElement;
}

export interface CanvasRuntimeSnapshot {
  camera: CanvasCamera;
  cameraState: CanvasCameraState;
  selection: CanvasSelection | undefined;
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
  updatePointer(input: {
    pointerId: number;
    screenPoint: CanvasPoint;
    modifiers?: CanvasRuntimePointerModifiers;
  }): boolean;
  finishPointer(input: {
    pointerId: number;
    screenPoint?: CanvasPoint;
    modifiers?: CanvasRuntimePointerModifiers;
  }): Promise<CanvasRuntimePointerInteraction | undefined>;
  cancelPointer(pointerId: number): void;
}

export interface CanvasManualLayoutController {
  getPresentation(): CanvasManualLayoutPresentation;
  acceptProjection(projection: CanvasProjection): void;
  subscribeRejection(listener: () => void): () => void;
}

export interface CanvasEditorRuntime {
  readonly camera: CanvasCameraController;
  readonly coordinates: CanvasCoordinateSystem;
  readonly input: CanvasInputController;
  readonly manualLayout: CanvasManualLayoutController;
  subscribe(listener: (snapshot: CanvasRuntimeSnapshot) => void): () => void;
  subscribeCamera(listener: (camera: CanvasCamera) => void): () => void;
  subscribeCameraState(listener: (state: CanvasCameraState) => void): () => void;
  subscribeSelection(listener: (selection: CanvasSelection | undefined) => void): () => void;
  subscribeSurfaceSize(listener: (size: CanvasSize | undefined) => void): () => void;
  subscribePointerInteraction(listener: (state: CanvasRuntimePointerInteraction | undefined) => void): () => void;
  getSnapshot(): CanvasRuntimeSnapshot;
  bindSurface(elements: CanvasSurfaceElements): () => void;
  setSelection(selection: CanvasSelection | undefined): void;
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
  pointerInteraction: CanvasRuntimePointerInteraction | undefined;
  surfaceSize: CanvasSize | undefined;
}

interface GestureState {
  camera: CanvasCamera;
  scale: number;
  origin: CanvasPoint;
}

export function createCanvasEditorRuntime(initial: {
  canvasId: string;
  initialProjection: CanvasProjection;
  submitManualLayout(mutation: {
    interaction: 'move' | 'resize';
    nodeLayouts: CanvasLayoutOverride[];
  }): Promise<void>;
  camera?: CanvasCamera;
  selection?: CanvasSelection | undefined;
}): CanvasEditorRuntime {
  const listeners = new Set<(snapshot: CanvasRuntimeSnapshot) => void>();
  const cameraListeners = new Set<(camera: CanvasCamera) => void>();
  const cameraStateListeners = new Set<(state: CanvasCameraState) => void>();
  const selectionListeners = new Set<(selection: CanvasSelection | undefined) => void>();
  const surfaceSizeListeners = new Set<(size: CanvasSize | undefined) => void>();
  const pointerInteractionListeners = new Set<(state: CanvasRuntimePointerInteraction | undefined) => void>();
  const manualLayoutListeners = new Set<() => void>();
  const manualLayoutLifecycle = createCanvasManualLayoutLifecycle({
    canvasId: initial.canvasId,
    initialProjection: initial.initialProjection,
    submitManualLayout: initial.submitManualLayout
  });
  const state: RuntimeState = {
    camera: initial.camera ?? canvasCameraReset(),
    cameraState: 'idle',
    selection: pruneCanvasSelection(
      normalizeCanvasSelection(initial.selection),
      new Set(initial.initialProjection.nodes.map((node) => node.projectRelativePath))
    ),
    pointerInteraction: undefined,
    surfaceSize: undefined
  };
  assertCanvasCamera(state.camera);

  let boundElements: CanvasSurfaceElements | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let idleTimer: number | undefined;
  let gestureState: GestureState | undefined;
  let cachedSnapshot: CanvasRuntimeSnapshot | undefined;
  let marqueeEdgeScrollFrame: number | undefined;
  let marqueeEdgeEnteredAt: number | undefined;
  let marqueeEdgeLastFrameAt: number | undefined;
  let disposed = false;

  const invalidateSnapshot = () => {
    cachedSnapshot = undefined;
  };

  const snapshot = (): CanvasRuntimeSnapshot => {
    cachedSnapshot ??= {
      camera: state.camera,
      cameraState: state.cameraState,
      selection: state.selection,
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
    if (previousCameraState !== 'moving') {
      flushCameraStateListeners('moving');
    }
    flushCameraListeners(camera);
    scheduleIdle();
  };

  const surfaceRect = (): DOMRect | { left: number; top: number; width: number; height: number } => (
    boundElements?.surface.getBoundingClientRect() ?? { left: 0, top: 0, width: 1, height: 1 }
  );

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

  const setPointerInteraction = (
    pointerInteraction: CanvasRuntimePointerInteraction | undefined,
    options: { notifySnapshot: boolean }
  ) => {
    state.pointerInteraction = pointerInteraction;
    manualLayoutLifecycle.setActiveInteraction(
      pointerInteraction?.kind !== 'selection-marquee' && pointerInteraction?.phase === 'active'
        ? pointerInteraction
        : undefined
    );
    invalidateSnapshot();
    flushPointerInteractionListeners(pointerInteraction);
    syncMarqueeEdgeScroll(pointerInteraction);
    if (options.notifySnapshot) {
      notify();
    }
  };

  const resizePreserveAspect = (
    state: Pick<Extract<CanvasRuntimePointerInteraction, { kind: 'resize-node' }>, 'handle' | 'node'>,
    modifiers: CanvasRuntimePointerModifiers
  ): boolean => getCanvasResizePreserveAspect(state.handle, modifiers, state.node);

  const presentedNode = (projectRelativePath: string): ProjectedCanvasNode => {
    const node = manualLayoutLifecycle.getPresentedNodes().find((candidate) => (
      candidate.projectRelativePath === projectRelativePath
    ));
    if (!node) {
      throw new Error(`Canvas node ${projectRelativePath} is not present in ${initial.canvasId}.`);
    }
    return node;
  };

  const flushManualLayoutListeners = () => {
    for (const listener of manualLayoutListeners) {
      listener();
    }
  };

  const commitSelection = (selection: CanvasSelection | undefined) => {
    const normalized = normalizeCanvasSelection(selection);
    if (sameCanvasSelection(state.selection, normalized)) {
      return;
    }
    state.selection = normalized;
    invalidateSnapshot();
    flushSelectionListeners(normalized);
    notify();
  };

  const pointerInteractionWithPointer = (
    active: CanvasRuntimePointerInteraction,
    screenPoint: CanvasPoint | undefined,
    modifiers: CanvasRuntimePointerModifiers | undefined
  ): CanvasRuntimePointerInteraction => {
    const nextScreen = screenPoint ?? active.currentScreen;
    const nextCanvas = screenToCanvas(nextScreen);
    if (active.kind === 'selection-marquee') {
      const phase = active.phase === 'active' || screenDistance(active.startScreen, nextScreen) > POINTER_ACTIVATION_DISTANCE
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
      const phase = active.phase === 'active' || screenDistance(active.startScreen, nextScreen) > POINTER_ACTIVATION_DISTANCE
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
    const hitPaths = manualLayoutLifecycle.getPresentedNodes()
      .filter((node) => rectsIntersect(interaction.rect!, node))
      .map((node) => node.projectRelativePath);
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
      setPointerInteraction(next, { notifySnapshot: false });
      commitSelection(marqueeSelection(next as Extract<CanvasRuntimePointerInteraction, { kind: 'selection-marquee' }>));
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
    if (!shouldCanvasHandleGlobalWheelTarget(event.target, boundElements?.surface ?? null)) {
      return;
    }
    event.preventDefault();
    cameraController.zoomByWheel({
      screenPoint: { x: event.clientX, y: event.clientY },
      delta: normalizeCanvasWheelDelta(event)
    });
  };

  const handleGestureStart = (event: Event) => {
    if (!shouldCanvasHandleGlobalWheelTarget(event.target, boundElements?.surface ?? null)) {
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
    if (!shouldCanvasHandleGlobalWheelTarget(event.target, boundElements?.surface ?? null)) {
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

  const runtime: CanvasEditorRuntime = {
    camera: cameraController,
    coordinates,
    manualLayout: {
      getPresentation: () => manualLayoutLifecycle.getPresentation(),
      acceptProjection: (projection) => {
        manualLayoutLifecycle.acceptProjection(projection);
        const currentPaths = new Set(projection.nodes.map((node) => node.projectRelativePath));
        const active = state.pointerInteraction;
        if (active?.kind === 'move-node' && active.origins.some((origin) => !currentPaths.has(origin.projectRelativePath))) {
          setPointerInteraction(undefined, { notifySnapshot: true });
          commitSelection(pruneCanvasSelection(active.initialSelection, currentPaths));
          return;
        }
        if (active?.kind === 'resize-node' && !currentPaths.has(active.node.projectRelativePath)) {
          setPointerInteraction(undefined, { notifySnapshot: true });
          commitSelection(pruneCanvasSelection(active.initialSelection, currentPaths));
          return;
        }
        if (active?.kind === 'selection-marquee') {
          const next = pointerInteractionWithPointer({
            ...active,
            initialSelection: pruneCanvasSelection(active.initialSelection, currentPaths)
          }, active.currentScreen, undefined);
          setPointerInteraction(next, { notifySnapshot: false });
          commitSelection(marqueeSelection(next as Extract<CanvasRuntimePointerInteraction, { kind: 'selection-marquee' }>));
          return;
        }
        commitSelection(pruneCanvasSelection(state.selection, currentPaths));
      },
      subscribeRejection: (listener) => {
        manualLayoutListeners.add(listener);
        return () => {
          manualLayoutListeners.delete(listener);
        };
      }
    },
    input: {
      screenToCanvasPoint: screenToCanvas,
      beginSelectionMarquee: (input) => {
        setPointerInteraction({
          kind: 'selection-marquee',
          pointerId: input.pointerId,
          phase: 'pending',
          startScreen: input.screenPoint,
          currentScreen: input.screenPoint,
          start: screenToCanvas(input.screenPoint),
          current: screenToCanvas(input.screenPoint),
          initialSelection: state.selection,
          additive: additiveSelectionModifier(input.modifiers),
          topEdgeInset: input.topEdgeInset ?? 0
        }, { notifySnapshot: false });
      },
      beginNodeMove: (input) => {
        const initialSelection = state.selection;
        const additive = additiveSelectionModifier(input.modifiers);
        const alreadySelected = isCanvasNodeSelected(initialSelection, input.projectRelativePath);
        const moveSelection = additive
          ? alreadySelected
            ? initialSelection
            : unionCanvasNodeSelection(initialSelection, [input.projectRelativePath])
          : alreadySelected
            ? initialSelection
            : canvasNodeSelection([input.projectRelativePath]);
        presentedNode(input.projectRelativePath);
        commitSelection(moveSelection);
        const selectedPaths = new Set(selectedNodeProjectRelativePaths(moveSelection));
        const start = screenToCanvas(input.screenPoint);
        setPointerInteraction({
          kind: 'move-node',
          pointerId: input.pointerId,
          phase: 'pending',
          startScreen: input.screenPoint,
          currentScreen: input.screenPoint,
          start,
          initialSelection,
          pressedProjectRelativePath: input.projectRelativePath,
          additive,
          origins: manualLayoutLifecycle.getPresentedNodes().filter((node) => selectedPaths.has(node.projectRelativePath))
        }, { notifySnapshot: false });
      },
      beginNodeResize: (input) => {
        const node = presentedNode(input.projectRelativePath);
        const initialSelection = state.selection;
        const start = screenToCanvas(input.screenPoint);
        commitSelection(canvasNodeSelection([input.projectRelativePath]));
        setPointerInteraction({
          kind: 'resize-node',
          pointerId: input.pointerId,
          phase: 'active',
          startScreen: input.screenPoint,
          currentScreen: input.screenPoint,
          handle: input.handle,
          start,
          initialSelection,
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
        }, { notifySnapshot: false });
      },
      updatePointer: (input) => {
        const active = state.pointerInteraction;
        if (!active || active.pointerId !== input.pointerId) {
          return false;
        }
        const next = pointerInteractionWithPointer(active, input.screenPoint, input.modifiers);
        setPointerInteraction(next, { notifySnapshot: false });
        if (next.kind === 'selection-marquee') {
          commitSelection(marqueeSelection(next));
        }
        return true;
      },
      finishPointer: async (input) => {
        const active = state.pointerInteraction;
        if (!active || active.pointerId !== input.pointerId) {
          return undefined;
        }
        const finished = pointerInteractionWithPointer(active, input.screenPoint, input.modifiers);
        if (finished.kind === 'selection-marquee') {
          commitSelection(finished.phase === 'pending'
            ? finished.additive ? finished.initialSelection : undefined
            : marqueeSelection(finished));
          setPointerInteraction(undefined, { notifySnapshot: true });
          return finished;
        }
        if (finished.kind === 'move-node' && finished.phase === 'pending') {
          commitSelection(finished.additive
            ? toggleCanvasNodeSelection(finished.initialSelection, finished.pressedProjectRelativePath)
            : canvasNodeSelection([finished.pressedProjectRelativePath]));
          setPointerInteraction(undefined, { notifySnapshot: true });
          return finished;
        }
        const submission = manualLayoutLifecycle.submitFinishedInteraction(finished);
        setPointerInteraction(undefined, { notifySnapshot: true });
        try {
          await submission;
        } catch (error) {
          flushManualLayoutListeners();
          throw error;
        }
        return finished;
      },
      cancelPointer: (pointerId) => {
        const active = state.pointerInteraction;
        if (active?.pointerId === pointerId) {
          setPointerInteraction(undefined, { notifySnapshot: true });
          commitSelection(active.initialSelection);
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
    bindSurface: (elements) => {
      boundElements = elements;
      const nextSize = {
        width: elements.surface.getBoundingClientRect().width,
        height: elements.surface.getBoundingClientRect().height
      };
      state.surfaceSize = nextSize;
      invalidateSnapshot();
      flushSurfaceSizeListeners(nextSize);
      notify();
      detachWindowInput();
      detachWindowInput = attachWindowInput();
      resizeObserver?.disconnect();
      resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) {
          return;
        }
        const size = {
          width: entry.contentRect.width,
          height: entry.contentRect.height
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
        }
        resizeObserver?.disconnect();
        resizeObserver = undefined;
        detachWindowInput();
        detachWindowInput = () => undefined;
      };
    },
    setSelection: commitSelection,
    dispose: () => {
      disposed = true;
      manualLayoutLifecycle.dispose();
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
      surfaceSizeListeners.clear();
      pointerInteractionListeners.clear();
      manualLayoutListeners.clear();
      boundElements = undefined;
    }
  };

  return runtime;
}

function positiveFiniteScale(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

const POINTER_ACTIVATION_DISTANCE = 4;
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
