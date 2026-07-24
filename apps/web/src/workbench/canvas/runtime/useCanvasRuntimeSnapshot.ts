import { useSyncExternalStore } from 'react';
import type { CanvasEditorRuntime } from './CanvasEditorRuntime';
import type { CanvasSize } from './canvasGeometry';
import type { CanvasSelection } from './canvasSelection';

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
