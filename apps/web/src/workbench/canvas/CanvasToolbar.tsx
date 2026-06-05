import React from 'react';
import { RefreshCw } from 'lucide-react';
import type { CanvasDocument, CanvasProjection } from '@debrute/canvas-core';
import type { CanvasEditorRuntime, CanvasRuntimeSnapshot } from './runtime/CanvasEditorRuntime';
import { cameraForCanvasContent, canvasContentBounds } from './CanvasCameraBounds';

export function CanvasToolbar({
  canvas,
  projection,
  runtime,
  runtimeSnapshot
}: {
  canvas: CanvasDocument | undefined;
  projection: CanvasProjection | undefined;
  runtime: CanvasEditorRuntime | undefined;
  runtimeSnapshot: CanvasRuntimeSnapshot | undefined;
}): React.ReactElement | null {
  if (!canvas || !projection) {
    return null;
  }
  const contentBounds = canvasContentBounds(projection.nodes);
  const canFitCanvas = Boolean(runtime && runtimeSnapshot?.surfaceSize && contentBounds);

  return (
    <div className="canvas-toolbar" data-testid="canvas-toolbar">
      <button
        type="button"
        data-testid="fit-active-canvas"
        title="Fit canvas"
        disabled={!canFitCanvas}
        onClick={() => {
          if (!runtime || !runtimeSnapshot?.surfaceSize || !contentBounds) {
            return;
          }
          const camera = cameraForCanvasContent({
            nodes: projection.nodes,
            surfaceSize: runtimeSnapshot.surfaceSize
          });
          if (camera) {
            runtime.camera.setCamera(camera);
          }
        }}
      >
        <RefreshCw size={15} />
        Fit
      </button>
      <span>{projection.nodes.length} nodes</span>
      <span>{projection.diagnostics.length} diagnostics</span>
    </div>
  );
}
