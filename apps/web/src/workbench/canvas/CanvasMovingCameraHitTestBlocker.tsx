import React, { useLayoutEffect, useRef } from 'react';
import type { CanvasEditorRuntime } from './runtime/CanvasEditorRuntime';
import type { CanvasCameraState } from './runtime/canvasCamera';

export function CanvasMovingCameraHitTestBlocker({
  runtime,
  onCameraStateChange,
  onCameraIdle
}: {
  runtime: CanvasEditorRuntime;
  onCameraStateChange(state: CanvasCameraState): void;
  onCameraIdle(): void;
}): React.ReactElement {
  const blockerRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const syncCameraState = (cameraState: CanvasCameraState) => {
      const blocker = blockerRef.current;
      if (!blocker) {
        return;
      }
      if (cameraState === 'moving') {
        onCameraStateChange(cameraState);
        blocker.classList.remove('hidden');
        return;
      }
      blocker.classList.add('hidden');
      onCameraStateChange(cameraState);
      onCameraIdle();
    };
    syncCameraState(runtime.getSnapshot().cameraState);
    return runtime.subscribeCameraState(syncCameraState);
  }, [onCameraIdle, onCameraStateChange, runtime]);

  return (
    <div
      ref={blockerRef}
      className="canvas-hit-test-blocker hidden"
      data-canvas-hit-test-blocker="true"
      aria-hidden="true"
    />
  );
}
