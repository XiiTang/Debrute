import React from 'react';
import { RefreshCw } from 'lucide-react';
import type { CanvasDocument, CanvasProjection } from '@axis/canvas-core';
import type { WorkbenchActions } from '../../types';

export function CanvasToolbar({
  canvas,
  projection,
  actions
}: {
  canvas: CanvasDocument | undefined;
  projection: CanvasProjection | undefined;
  actions: WorkbenchActions;
}): React.ReactElement | null {
  if (!canvas || !projection) {
    return null;
  }

  return (
    <div className="canvas-toolbar" data-testid="canvas-toolbar">
      <button
        type="button"
        data-testid="fit-active-canvas"
        title="Fit canvas"
        onClick={() => actions.updateCanvasViewport(canvas.id, { x: 0, y: 0, zoom: 1 })}
      >
        <RefreshCw size={15} />
        Fit
      </button>
      <span>{projection.nodes.length} nodes</span>
      <span>{projection.diagnostics.length} diagnostics</span>
    </div>
  );
}
