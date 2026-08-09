import { useSyncExternalStore } from 'react';
import type { CanvasEditorRuntime } from './CanvasEditorRuntime.js';
import type { CanvasSize } from './canvasGeometry.js';
import type { CanvasSelection } from './canvasSelection.js';

export function useCanvasSelection(runtime: CanvasEditorRuntime): CanvasSelection | undefined {
  return useSyncExternalStore(
    runtime.subscribeSelection,
    () => runtime.getSnapshot().selection,
    () => runtime.getSnapshot().selection
  );
}

export function useCanvasContentInteraction(runtime: CanvasEditorRuntime): string | undefined {
  return useSyncExternalStore(
    runtime.subscribeContentInteraction,
    () => runtime.getSnapshot().contentInteractionProjectRelativePath,
    () => runtime.getSnapshot().contentInteractionProjectRelativePath
  );
}

export function useCanvasSurfaceSize(runtime: CanvasEditorRuntime): CanvasSize | undefined {
  return useSyncExternalStore(
    runtime.subscribeSurfaceSize,
    () => runtime.getSnapshot().surfaceSize,
    () => runtime.getSnapshot().surfaceSize
  );
}
