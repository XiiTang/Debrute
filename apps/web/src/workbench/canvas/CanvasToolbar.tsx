import React from 'react';
import { RefreshCw } from 'lucide-react';
import type { CanvasDocument, CanvasProjection } from '@debrute/canvas-core';
import type { CanvasEditorRuntime, CanvasRuntimeSnapshot } from './runtime/CanvasEditorRuntime';
import { cameraForCanvasContent, canvasContentBounds } from './CanvasCameraBounds';
import { Button, Toolbar } from '../ui';

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
  const nodeCountLabel = `${projection.nodes.length} ${projection.nodes.length === 1 ? 'node' : 'nodes'}`;

  return (
    <Toolbar ariaLabel="Canvas tools" className="db-floating-bar canvas-toolbar" data-testid="canvas-toolbar">
      <Button
        data-testid="fit-active-canvas"
        title="Fit canvas"
        disabled={!canFitCanvas}
        iconStart={<RefreshCw size={15} />}
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
        Fit
      </Button>
      <span className="canvas-toolbar__stat">{nodeCountLabel}</span>
      {projection.diagnostics.length > 0 ? (
        <span className="canvas-toolbar__stat">{projection.diagnostics.length} diagnostics</span>
      ) : null}
    </Toolbar>
  );
}
