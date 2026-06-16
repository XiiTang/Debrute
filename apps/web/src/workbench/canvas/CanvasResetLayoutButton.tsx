import React from 'react';
import { RotateCcw } from 'lucide-react';
import { IconButton } from '../ui';

export interface CanvasResetLayoutButtonProps {
  enabled: boolean;
  onResetCanvasLayout(): void;
}

export function CanvasResetLayoutButton({
  enabled,
  onResetCanvasLayout
}: CanvasResetLayoutButtonProps): React.ReactElement {
  return (
    <IconButton
      className="db-floating-bar canvas-reset-layout-button"
      data-testid="canvas-reset-layout-button"
      data-canvas-local-wheel="true"
      label="Reset Canvas Layout"
      icon={<RotateCcw size={13} />}
      disabled={!enabled}
      onPointerDown={stopCanvasResetLayoutEvent}
      onPointerMove={stopCanvasResetLayoutEvent}
      onPointerUp={stopCanvasResetLayoutEvent}
      onWheel={stopCanvasResetLayoutEvent}
      onClick={(event) => {
        stopCanvasResetLayoutEvent(event);
        if (enabled) {
          onResetCanvasLayout();
        }
      }}
      onDoubleClick={stopCanvasResetLayoutEvent}
      onContextMenu={stopCanvasResetLayoutEvent}
    />
  );
}

function stopCanvasResetLayoutEvent(event: React.SyntheticEvent): void {
  event.stopPropagation();
}
