import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { CanvasMovingCameraHitTestBlocker } from './CanvasMovingCameraHitTestBlocker';
import type { CanvasEditorRuntime } from './runtime/CanvasEditorRuntime';
import type { CanvasCameraState } from './runtime/canvasCamera';

describe('CanvasMovingCameraHitTestBlocker', () => {
  it('gates semantic interaction before revealing the blocker and reconciles only after hiding it', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let cameraState: CanvasCameraState = 'idle';
    const listeners = new Set<(state: CanvasCameraState) => void>();
    const runtime = {
      getSnapshot: () => ({ cameraState }),
      subscribeCameraState: (listener: (state: CanvasCameraState) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    } as unknown as CanvasEditorRuntime;
    const transitions: Array<{ state: CanvasCameraState; blockerHidden: boolean }> = [];
    const onCameraIdle = vi.fn(() => {
      expect(container.querySelector('.canvas-hit-test-blocker')?.classList.contains('hidden')).toBe(true);
    });

    try {
      await act(async () => {
        root.render(
          <CanvasMovingCameraHitTestBlocker
            runtime={runtime}
            onCameraStateChange={(state) => {
              transitions.push({
                state,
                blockerHidden: container.querySelector('.canvas-hit-test-blocker')?.classList.contains('hidden') === true
              });
            }}
            onCameraIdle={onCameraIdle}
          />
        );
      });
      transitions.length = 0;
      onCameraIdle.mockClear();

      await act(async () => {
        cameraState = 'moving';
        for (const listener of listeners) {
          listener(cameraState);
        }
      });
      expect(transitions).toEqual([{ state: 'moving', blockerHidden: true }]);
      expect(container.querySelector('.canvas-hit-test-blocker')?.classList.contains('hidden')).toBe(false);

      await act(async () => {
        cameraState = 'idle';
        for (const listener of listeners) {
          listener(cameraState);
        }
      });
      expect(transitions.at(-1)).toEqual({ state: 'idle', blockerHidden: true });
      expect(onCameraIdle).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
