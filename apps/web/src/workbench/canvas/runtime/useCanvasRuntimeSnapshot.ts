import { useSyncExternalStore } from 'react';
import type { CanvasEditorRuntime, CanvasRuntimeSnapshot } from './CanvasEditorRuntime';

export function useCanvasRuntimeSnapshot(runtime: CanvasEditorRuntime): CanvasRuntimeSnapshot {
  return useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
}
