import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import {
  getCanvasResizePreserveAspect,
  normalizeCanvasWheelDelta,
  shouldCanvasHandleGlobalWheelTarget,
  type NormalizedCanvasWheelDelta
} from '../../services/canvasInteraction';
import {
  CANVAS_CAMERA_IDLE_MS,
  DEFAULT_CANVAS_CAMERA,
  assertCanvasCamera,
  cameraCenteredOnCanvasPoint,
  cameraForGestureZoom,
  cameraForWheelDelta,
  cameraPanBy,
  canvasCameraReset,
  type CanvasCamera,
  type CanvasCameraState
} from './canvasCamera';
import {
  canvasRectToScreenRect,
  canvasToScreenPoint,
  normalizedSurfaceSize,
  screenToCanvasPoint,
  visibleCanvasRectForCamera
} from './canvasCoordinateSystem';
import type { CanvasPoint, CanvasRect, CanvasSize, ResizeHandle } from './canvasGeometry';
import type { CanvasSelection } from './canvasSelection';
import { selectedNodeProjectRelativePaths } from './canvasSelection';

export interface CanvasSurfaceElements {
  surface: HTMLElement;
}

export interface CanvasRuntimeSnapshot {
  camera: CanvasCamera;
  cameraState: CanvasCameraState;
  selection: CanvasSelection | undefined;
  dragState: CanvasRuntimeDragState | undefined;
  surfaceSize: CanvasSize | undefined;
  imageResourceZoom: number;
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
  beginNodeMove(input: {
    pointerId: number;
    node: CanvasRuntimeMoveOrigin;
    start: CanvasPoint;
    selection: CanvasSelection;
    nodes: CanvasRuntimeMoveOrigin[];
  }): void;
  beginNodeResize(input: {
    pointerId: number;
    handle: ResizeHandle;
    node: CanvasRuntimeResizeNode;
    start: CanvasPoint;
    origin: CanvasRect;
    modifiers: CanvasRuntimePointerModifiers;
  }): void;
  updatePointer(input: { pointerId: number; point: CanvasPoint; modifiers?: CanvasRuntimePointerModifiers }): boolean;
  finishPointer(input: { pointerId: number; point?: CanvasPoint; modifiers?: CanvasRuntimePointerModifiers }): CanvasRuntimeDragState | undefined;
  cancelPointer(pointerId: number): void;
}

export interface CanvasEditorRuntime {
  readonly camera: CanvasCameraController;
  readonly coordinates: CanvasCoordinateSystem;
  readonly input: CanvasInputController;
  subscribe(listener: (snapshot: CanvasRuntimeSnapshot) => void): () => void;
  subscribeCamera(listener: (camera: CanvasCamera) => void): () => void;
  subscribeCameraState(listener: (state: CanvasCameraState) => void): () => void;
  subscribeSelection(listener: (selection: CanvasSelection | undefined) => void): () => void;
  subscribeSurfaceSize(listener: (size: CanvasSize | undefined) => void): () => void;
  subscribeDragState(listener: (state: CanvasRuntimeDragState | undefined) => void): () => void;
  subscribeImageResourceZoom(listener: (zoom: number) => void): () => void;
  getSnapshot(): CanvasRuntimeSnapshot;
  bindSurface(elements: CanvasSurfaceElements): () => void;
  setSelection(selection: CanvasSelection | undefined): void;
  setImageResourceZoom(zoom: number): void;
  dispose(): void;
}

export type CanvasRuntimeMoveOrigin = Pick<ProjectedCanvasNode, 'projectRelativePath' | 'x' | 'y' | 'width' | 'height'>;
export type CanvasRuntimeResizeNode = Pick<ProjectedCanvasNode, 'projectRelativePath' | 'mediaKind'>;
export interface CanvasRuntimePointerModifiers {
  shiftKey: boolean;
}

export type CanvasRuntimeDragState =
  | {
      kind: 'move-node';
      pointerId: number;
      start: CanvasPoint;
      current?: CanvasPoint;
      origins: CanvasRuntimeMoveOrigin[];
    }
  | {
      kind: 'resize-node';
      pointerId: number;
      handle: ResizeHandle;
      start: CanvasPoint;
      current?: CanvasPoint;
      node: CanvasRuntimeResizeNode;
      origin: CanvasRect;
      preserveAspect: boolean;
    };

type CanvasGestureEvent = Event & {
  clientX: number;
  clientY: number;
  scale: number;
};

interface RuntimeState {
  camera: CanvasCamera;
  cameraState: CanvasCameraState;
  selection: CanvasSelection | undefined;
  dragState: CanvasRuntimeDragState | undefined;
  surfaceSize: CanvasSize | undefined;
  imageResourceZoom: number;
}

interface GestureState {
  camera: CanvasCamera;
  scale: number;
  origin: CanvasPoint;
}

export function createCanvasEditorRuntime(initial?: {
  camera?: CanvasCamera;
  selection?: CanvasSelection | undefined;
}): CanvasEditorRuntime {
  const listeners = new Set<(snapshot: CanvasRuntimeSnapshot) => void>();
  const cameraListeners = new Set<(camera: CanvasCamera) => void>();
  const cameraStateListeners = new Set<(state: CanvasCameraState) => void>();
  const selectionListeners = new Set<(selection: CanvasSelection | undefined) => void>();
  const surfaceSizeListeners = new Set<(size: CanvasSize | undefined) => void>();
  const dragStateListeners = new Set<(state: CanvasRuntimeDragState | undefined) => void>();
  const imageResourceZoomListeners = new Set<(zoom: number) => void>();
  const state: RuntimeState = {
    camera: initial?.camera ?? canvasCameraReset(),
    cameraState: 'idle',
    selection: initial?.selection,
    dragState: undefined,
    surfaceSize: undefined,
    imageResourceZoom: initial?.camera?.z ?? DEFAULT_CANVAS_CAMERA.z
  };
  assertCanvasCamera(state.camera);

  let boundElements: CanvasSurfaceElements | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let idleTimer: number | undefined;
  let gestureState: GestureState | undefined;
  let cachedSnapshot: CanvasRuntimeSnapshot | undefined;
  let disposed = false;

  const invalidateSnapshot = () => {
    cachedSnapshot = undefined;
  };

  const snapshot = (): CanvasRuntimeSnapshot => {
    cachedSnapshot ??= {
      camera: state.camera,
      cameraState: state.cameraState,
      selection: state.selection,
      dragState: state.dragState,
      surfaceSize: state.surfaceSize,
      imageResourceZoom: state.imageResourceZoom
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

  const flushImageResourceZoomListeners = (zoom: number) => {
    for (const listener of imageResourceZoomListeners) {
      listener(zoom);
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
    if (typeof window === 'undefined') {
      setCameraState('idle');
      return;
    }
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

  const flushDragStateListeners = (dragState: CanvasRuntimeDragState | undefined) => {
    for (const listener of dragStateListeners) {
      listener(dragState);
    }
  };

  const setDragState = (
    dragState: CanvasRuntimeDragState | undefined,
    options: { notifySnapshot: boolean }
  ) => {
    state.dragState = dragState;
    invalidateSnapshot();
    flushDragStateListeners(dragState);
    if (options.notifySnapshot) {
      notify();
    }
  };

  const resizePreserveAspect = (
    state: Pick<Extract<CanvasRuntimeDragState, { kind: 'resize-node' }>, 'handle' | 'node'>,
    modifiers: CanvasRuntimePointerModifiers
  ): boolean => getCanvasResizePreserveAspect(state.handle, modifiers, state.node.mediaKind);

  const dragStateWithPointer = (
    active: CanvasRuntimeDragState,
    point: CanvasPoint | undefined,
    modifiers: CanvasRuntimePointerModifiers | undefined
  ): CanvasRuntimeDragState => {
    const next = point ? { ...active, current: point } : active;
    if (next.kind !== 'resize-node' || !modifiers) {
      return next;
    }
    return {
      ...next,
      preserveAspect: resizePreserveAspect(next, modifiers)
    };
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
    if (typeof window === 'undefined') {
      return () => undefined;
    }
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
    input: {
      screenToCanvasPoint: screenToCanvas,
      beginNodeMove: (input) => {
        const selectedPaths = new Set(selectedNodeProjectRelativePaths(input.selection));
        if (!selectedPaths.has(input.node.projectRelativePath)) {
          selectedPaths.add(input.node.projectRelativePath);
        }
        setDragState({
          kind: 'move-node',
          pointerId: input.pointerId,
          start: input.start,
          origins: input.nodes.filter((node) => selectedPaths.has(node.projectRelativePath))
        }, { notifySnapshot: true });
      },
      beginNodeResize: (input) => {
        setDragState({
          kind: 'resize-node',
          pointerId: input.pointerId,
          handle: input.handle,
          start: input.start,
          node: input.node,
          origin: input.origin,
          preserveAspect: resizePreserveAspect(input, input.modifiers)
        }, { notifySnapshot: true });
      },
      updatePointer: (input) => {
        const active = state.dragState;
        if (!active || active.pointerId !== input.pointerId) {
          return false;
        }
        setDragState(dragStateWithPointer(active, input.point, input.modifiers), { notifySnapshot: false });
        return true;
      },
      finishPointer: (input) => {
        const active = state.dragState;
        if (!active || active.pointerId !== input.pointerId) {
          return undefined;
        }
        const finished = dragStateWithPointer(active, input.point, input.modifiers);
        setDragState(undefined, { notifySnapshot: true });
        return finished;
      },
      cancelPointer: (pointerId) => {
        if (state.dragState?.pointerId === pointerId) {
          setDragState(undefined, { notifySnapshot: true });
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
    subscribeDragState: (listener) => {
      dragStateListeners.add(listener);
      return () => {
        dragStateListeners.delete(listener);
      };
    },
    subscribeImageResourceZoom: (listener) => {
      imageResourceZoomListeners.add(listener);
      return () => {
        imageResourceZoomListeners.delete(listener);
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
      if (typeof ResizeObserver !== 'undefined') {
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
      }
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
    setSelection: (selection) => {
      if (state.selection === selection) {
        return;
      }
      state.selection = selection;
      invalidateSnapshot();
      flushSelectionListeners(selection);
      notify();
    },
    setImageResourceZoom: (zoom) => {
      if (!Number.isFinite(zoom) || zoom <= 0) {
        throw new Error('Canvas image resource zoom must be a positive finite number.');
      }
      if (state.imageResourceZoom === zoom) {
        return;
      }
      state.imageResourceZoom = zoom;
      invalidateSnapshot();
      flushImageResourceZoomListeners(zoom);
      notify();
    },
    dispose: () => {
      disposed = true;
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
      dragStateListeners.clear();
      imageResourceZoomListeners.clear();
      boundElements = undefined;
    }
  };

  return runtime;
}

function positiveFiniteScale(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
