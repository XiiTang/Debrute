import React from 'react';
import { AlertTriangle, RefreshCw } from '../ui/index.js';
import { useI18n } from '../i18n';
import { Button } from '../ui/index.js';

export interface CanvasNodeErrorPresentationProps {
  message: string;
  onRetry?: (() => void) | undefined;
}

export function CanvasNodeErrorPresentation({
  message,
  onRetry
}: CanvasNodeErrorPresentationProps): React.ReactElement {
  const i18n = useI18n();
  return (
    <div className="canvas-node-presentation canvas-node-error-presentation">
      <div className="db-canvas-node-error-overlay">
        <AlertTriangle size={16} />
        <span>{message}</span>
        {onRetry ? (
          <Button
            className="db-canvas-node-retry"
            size="xs"
            iconStart={<RefreshCw size={12} />}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onRetry}
          >
            {i18n.t('canvas.node.retry')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
