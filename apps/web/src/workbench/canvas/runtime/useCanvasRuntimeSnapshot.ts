import { useSyncExternalStore } from 'react';
import type { CanvasEditorRuntime, CanvasRuntimePointerInteraction } from './CanvasEditorRuntime.js';
import type { CanvasRect, CanvasSize } from './canvasGeometry.js';
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

type CanvasActiveSelectionMarquee = Extract<
  CanvasRuntimePointerInteraction,
  { kind: 'selection-marquee' }
> & {
  phase: 'active';
  rect: CanvasRect;
};

export function useCanvasActiveSelectionMarquee(
  runtime: CanvasEditorRuntime
): CanvasActiveSelectionMarquee | undefined {
  return useSyncExternalStore(
    runtime.subscribePointerInteraction,
    () => activeSelectionMarquee(runtime),
    () => activeSelectionMarquee(runtime)
  );
}

function activeSelectionMarquee(runtime: CanvasEditorRuntime): CanvasActiveSelectionMarquee | undefined {
  const interaction = runtime.getSnapshot().pointerInteraction;
  return isActiveSelectionMarquee(interaction) ? interaction : undefined;
}

function isActiveSelectionMarquee(
  interaction: CanvasRuntimePointerInteraction | undefined
): interaction is CanvasActiveSelectionMarquee {
  return interaction?.kind === 'selection-marquee'
    && interaction.phase === 'active'
    && interaction.rect !== undefined;
}
