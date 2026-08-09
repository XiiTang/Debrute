import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type {
  CanvasEditorRuntime,
  CanvasRuntimePointerInteraction,
  CanvasRuntimeSnapshot
} from './CanvasEditorRuntime.js';
import { useCanvasActiveSelectionMarquee } from './useCanvasRuntimeSnapshot.js';

describe('useCanvasActiveSelectionMarquee', () => {
  it('rerenders only for active selection marquee snapshots and unsubscribes on unmount', async () => {
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
    const renders: Array<number | undefined> = [];
    const container = document.createElement('div');
    const root = createRoot(container);

    function Probe(): ReactElement {
      const marquee = useCanvasActiveSelectionMarquee(runtime);
      renders.push(marquee?.rect?.x);
      return <span>{marquee?.rect?.x ?? 'idle'}</span>;
    }

    await act(async () => root.render(<Probe />));
    expect(renders).toEqual([undefined]);

    pointerInteraction = moveInteraction();
    await act(async () => listeners.forEach((listener) => listener(pointerInteraction)));
    pointerInteraction = resizeInteraction();
    await act(async () => listeners.forEach((listener) => listener(pointerInteraction)));
    pointerInteraction = selectionMarquee('pending');
    await act(async () => listeners.forEach((listener) => listener(pointerInteraction)));
    expect(renders).toEqual([undefined]);

    pointerInteraction = selectionMarquee('active', 10);
    await act(async () => listeners.forEach((listener) => listener(pointerInteraction)));
    expect(renders).toEqual([undefined, 10]);

    pointerInteraction = selectionMarquee('active', 20);
    await act(async () => listeners.forEach((listener) => listener(pointerInteraction)));
    expect(renders).toEqual([undefined, 10, 20]);

    pointerInteraction = undefined;
    await act(async () => listeners.forEach((listener) => listener(pointerInteraction)));
    expect(renders).toEqual([undefined, 10, 20, undefined]);

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

function selectionMarquee(
  phase: 'pending' | 'active',
  x = 10
): CanvasRuntimePointerInteraction {
  return {
    kind: 'selection-marquee',
    pointerId: 1,
    phase,
    startScreen: { x: 10, y: 20 },
    currentScreen: { x: 10, y: 20 },
    start: { x: 10, y: 20 },
    current: { x: 10, y: 20 },
    initialSelection: undefined,
    initialContentInteractionProjectRelativePath: undefined,
    additive: false,
    topEdgeInset: 0,
    ...(phase === 'active' ? { rect: { x, y: 20, width: 30, height: 40 } } : {})
  };
}

function moveInteraction(): CanvasRuntimePointerInteraction {
  return {
    kind: 'move-node',
    pointerId: 2,
    phase: 'active',
    startScreen: { x: 0, y: 0 },
    currentScreen: { x: 10, y: 10 },
    start: { x: 0, y: 0 },
    current: { x: 10, y: 10 },
    initialSelection: undefined,
    initialContentInteractionProjectRelativePath: undefined,
    pressedProjectRelativePath: 'node.png',
    additive: false,
    origins: [{ projectRelativePath: 'node.png', x: 0, y: 0, width: 100, height: 100 }]
  };
}

function resizeInteraction(): CanvasRuntimePointerInteraction {
  return {
    kind: 'resize-node',
    pointerId: 3,
    phase: 'active',
    startScreen: { x: 0, y: 0 },
    currentScreen: { x: 10, y: 10 },
    handle: 'se',
    start: { x: 0, y: 0 },
    current: { x: 10, y: 10 },
    initialSelection: undefined,
    initialContentInteractionProjectRelativePath: undefined,
    node: { projectRelativePath: 'node.png', nodeKind: 'file', mediaKind: 'image' },
    origin: { x: 0, y: 0, width: 100, height: 100 },
    preserveAspect: false
  };
}
