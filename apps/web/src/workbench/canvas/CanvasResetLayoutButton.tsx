import React from 'react';
import { RotateCcw } from 'lucide-react';
import { IconButton } from '../ui';
import { useI18n } from '../i18n';

export interface CanvasResetLayoutButtonProps {
  enabled: boolean;
  onResetCanvasLayout(): void;
}

export function CanvasResetLayoutButton({
  enabled,
  onResetCanvasLayout
}: CanvasResetLayoutButtonProps): React.ReactElement {
  const i18n = useI18n();
  return (
    <IconButton
      className="canvas-reset-layout-button db-canvas-control"
      data-testid="canvas-reset-layout-button"
      data-canvas-local-wheel="true"
      label={i18n.t('canvas.resetLayout')}
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
