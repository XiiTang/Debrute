import { useSyncExternalStore } from 'react';
import type { CanvasEditorRuntime, CanvasRuntimePointerInteraction } from './CanvasEditorRuntime.js';
import type { CanvasSize } from './canvasGeometry.js';
import type { CanvasSelection } from './canvasSelection.js';

export function useCanvasSelection(runtime: CanvasEditorRuntime): CanvasSelection | undefined {
  return useSyncExternalStore(
    runtime.subscribeSelection,
    () => runtime.getSnapshot().selection,
    () => runtime.getSnapshot().selection
  );
}

export function useCanvasSurfaceSize(runtime: CanvasEditorRuntime): CanvasSize | undefined {
  return useSyncExternalStore(
    runtime.subscribeSurfaceSize,
    () => runtime.getSnapshot().surfaceSize,
    () => runtime.getSnapshot().surfaceSize
  );
}

export function useCanvasPointerInteraction(runtime: CanvasEditorRuntime): CanvasRuntimePointerInteraction | undefined {
  return useSyncExternalStore(
    runtime.subscribePointerInteraction,
    () => runtime.getSnapshot().pointerInteraction,
    () => runtime.getSnapshot().pointerInteraction
  );
}
