import { useSyncExternalStore } from 'react';
import type { CanvasEditorRuntime } from './CanvasEditorRuntime';
import type { CanvasSize } from './canvasGeometry';
import type { CanvasSelection } from './canvasSelection';

const subscribeToNothing = (): (() => void) => () => undefined;
const readFalse = (): boolean => false;

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

export function useCanvasSurfaceReady(runtime: CanvasEditorRuntime | undefined): boolean {
  return useSyncExternalStore(
    runtime?.subscribeSurfaceSize ?? subscribeToNothing,
    runtime ? () => runtime.getSnapshot().surfaceSize !== undefined : readFalse,
    readFalse
  );
}
