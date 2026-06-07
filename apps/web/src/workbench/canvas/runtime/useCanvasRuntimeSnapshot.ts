import { useSyncExternalStore } from 'react';
import type { CanvasEditorRuntime, CanvasRuntimeSnapshot } from './CanvasEditorRuntime';
import type { CanvasSize } from './canvasGeometry';
import type { CanvasSelection } from './canvasSelection';

export function useCanvasRuntimeSnapshot(runtime: CanvasEditorRuntime): CanvasRuntimeSnapshot {
  return useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
}

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

export function useCanvasImageResourceZoom(runtime: CanvasEditorRuntime): number {
  return useSyncExternalStore(
    runtime.subscribeImageResourceZoom,
    () => runtime.getSnapshot().imageResourceZoom,
    () => runtime.getSnapshot().imageResourceZoom
  );
}
