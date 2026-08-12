import { useCallback, useSyncExternalStore } from 'react';
import type { CanvasEditorRuntime, CanvasRuntimeSnapshot } from './CanvasEditorRuntime';
import type { CanvasSize } from './canvasGeometry';
import {
  soleSelectedNodeProjectRelativePath,
  type CanvasSelection
} from './canvasSelection';

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

export function useCanvasSoleSelectedPresentationPath(
  runtime: CanvasEditorRuntime
): string | undefined {
  const subscribe = useCallback((listener: () => void) => {
    const unsubscribeSelection = runtime.subscribeSelection(listener);
    const unsubscribePointerInteraction = runtime.subscribePointerInteraction(listener);
    return () => {
      unsubscribeSelection();
      unsubscribePointerInteraction();
    };
  }, [runtime]);
  const getSnapshot = useCallback(
    () => canvasSoleSelectedPresentationPath(runtime.getSnapshot()),
    [runtime]
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function canvasSoleSelectedPresentationPath(
  snapshot: Pick<CanvasRuntimeSnapshot, 'selection' | 'pointerInteraction'>
): string | undefined {
  const pointerInteraction = snapshot.pointerInteraction;
  const presentationSelection = pointerInteraction?.kind === 'selection-marquee'
    && pointerInteraction.phase === 'active'
    ? pointerInteraction.initialSelection
    : snapshot.selection;
  return soleSelectedNodeProjectRelativePath(presentationSelection);
}

export function useCanvasSurfaceSize(runtime: CanvasEditorRuntime): CanvasSize | undefined {
  return useSyncExternalStore(
    runtime.subscribeSurfaceSize,
    () => runtime.getSnapshot().surfaceSize,
    () => runtime.getSnapshot().surfaceSize
  );
}
