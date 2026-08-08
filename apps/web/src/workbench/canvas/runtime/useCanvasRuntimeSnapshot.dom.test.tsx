import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type {
  CanvasEditorRuntime,
  CanvasRuntimePointerInteraction,
  CanvasRuntimeSnapshot
} from './CanvasEditorRuntime.js';
import { useCanvasPointerInteraction } from './useCanvasRuntimeSnapshot.js';

describe('useCanvasPointerInteraction', () => {
  it('rerenders on pointer interaction changes and unsubscribes on unmount', async () => {
    let pointerInteraction: CanvasRuntimePointerInteraction | undefined;
    const listeners = new Set<(next: CanvasRuntimePointerInteraction | undefined) => void>();
    const unsubscribe = vi.fn();
    const runtime = {
      getSnapshot: () => runtimeSnapshot(pointerInteraction),
      subscribePointerInteraction: (
        listener: (next: CanvasRuntimePointerInteraction | undefined) => void
      ) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
          unsubscribe();
        };
      }
    } as CanvasEditorRuntime;
    const renders: Array<CanvasRuntimePointerInteraction['kind'] | undefined> = [];
    const container = document.createElement('div');
    const root = createRoot(container);

    function Probe(): ReactElement {
      const interaction = useCanvasPointerInteraction(runtime);
      renders.push(interaction?.kind);
      return <span>{interaction?.kind ?? 'idle'}</span>;
    }

    await act(async () => root.render(<Probe />));
    expect(renders).toEqual([undefined]);

    pointerInteraction = selectionMarquee();
    await act(async () => listeners.forEach((listener) => listener(pointerInteraction)));
    expect(renders).toEqual([undefined, 'selection-marquee']);

    pointerInteraction = undefined;
    await act(async () => listeners.forEach((listener) => listener(pointerInteraction)));
    expect(renders).toEqual([undefined, 'selection-marquee', undefined]);

    await act(async () => root.unmount());
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
  });
});

function runtimeSnapshot(
  pointerInteraction: CanvasRuntimePointerInteraction | undefined
): CanvasRuntimeSnapshot {
  return {
    camera: { x: 0, y: 0, z: 1 },
    cameraState: 'idle',
    selection: undefined,
    contentInteractionProjectRelativePath: undefined,
    pointerInteraction,
    surfaceSize: undefined
  };
}

function selectionMarquee(): CanvasRuntimePointerInteraction {
  return {
    kind: 'selection-marquee',
    pointerId: 1,
    phase: 'pending',
    startScreen: { x: 10, y: 20 },
    currentScreen: { x: 10, y: 20 },
    start: { x: 10, y: 20 },
    current: { x: 10, y: 20 },
    initialSelection: undefined,
    initialContentInteractionProjectRelativePath: undefined,
    additive: false,
    topEdgeInset: 0
  };
}
