import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { CanvasEditorRuntime, CanvasRuntimeSnapshot } from './CanvasEditorRuntime.js';
import { useCanvasSurfaceReady } from './useCanvasRuntimeSnapshot.js';

describe('useCanvasSurfaceReady', () => {
  it('rerenders only when surface readiness changes and unsubscribes on unmount', async () => {
    let snapshot = runtimeSnapshot(undefined);
    const surfaceListeners = new Set<() => void>();
    const unsubscribe = vi.fn();
    const runtime = {
      getSnapshot: () => snapshot,
      subscribeSurfaceSize: (listener: () => void) => {
        surfaceListeners.add(listener);
        return () => {
          surfaceListeners.delete(listener);
          unsubscribe();
        };
      }
    } as CanvasEditorRuntime;
    const renders: boolean[] = [];
    const container = document.createElement('div');
    const root = createRoot(container);

    function Probe(): ReactElement {
      const ready = useCanvasSurfaceReady(runtime);
      renders.push(ready);
      return <span>{String(ready)}</span>;
    }

    await act(async () => root.render(<Probe />));
    expect(renders).toEqual([false]);

    snapshot = runtimeSnapshot(undefined, { x: 12, y: 8, z: 1 });
    await act(async () => surfaceListeners.forEach((listener) => listener()));
    expect(renders).toEqual([false]);

    snapshot = runtimeSnapshot({ width: 800, height: 600 });
    await act(async () => surfaceListeners.forEach((listener) => listener()));
    expect(renders).toEqual([false, true]);

    snapshot = runtimeSnapshot({ width: 1024, height: 768 });
    await act(async () => surfaceListeners.forEach((listener) => listener()));
    expect(renders).toEqual([false, true]);

    await act(async () => root.unmount());
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(surfaceListeners.size).toBe(0);
  });
});

function runtimeSnapshot(
  surfaceSize: CanvasRuntimeSnapshot['surfaceSize'],
  camera: CanvasRuntimeSnapshot['camera'] = { x: 0, y: 0, z: 1 }
): CanvasRuntimeSnapshot {
  return {
    camera,
    cameraState: 'idle',
    selection: undefined,
    dragState: undefined,
    surfaceSize
  };
}
