import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, Video } from 'lucide-react';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import { Button } from '../ui';
import { useI18n } from '../i18n';
import {
  CanvasVideoPlayerAdapter,
  type CanvasVideoPlayerHandle
} from './CanvasVideoPlayerAdapter';

export interface CanvasVideoNodeContentProps {
  node: ProjectedCanvasNode;
  onSelectNode: () => void;
  onRegisterVideoTarget: (projectRelativePath: string, target: CanvasVideoPlayerHandle | undefined) => void;
}

export function CanvasVideoNodeContent({
  node,
  onSelectNode,
  onRegisterVideoTarget
}: CanvasVideoNodeContentProps): React.ReactElement {
  const i18n = useI18n();
  const [error, setError] = useState<string>();
  const [retryKey, setRetryKey] = useState(0);
  const sourceKey = node.availability.state === 'available'
    ? `${node.projectRelativePath}\u001f${node.availability.fileUrl}\u001f${node.availability.revision}`
    : `${node.projectRelativePath}\u001f${node.availability.state}`;
  const register = useCallback((target: CanvasVideoPlayerHandle | null) => {
    onRegisterVideoTarget(node.projectRelativePath, target ?? undefined);
  }, [node.projectRelativePath, onRegisterVideoTarget]);

  useEffect(() => {
    setError(undefined);
    setRetryKey(0);
  }, [sourceKey]);

  useEffect(() => () => {
    onRegisterVideoTarget(node.projectRelativePath, undefined);
  }, [node.projectRelativePath, onRegisterVideoTarget]);

  const caption = (
    <div className="db-canvas-node-caption">
      <Video size={13} />
      <span>{node.projectRelativePath.split('/').pop() ?? node.projectRelativePath}</span>
    </div>
  );

  if (node.availability.state !== 'available') {
    return (
      <section className="canvas-video-node">
        <div className="canvas-video-player-shell">
          <div className="db-canvas-node-placeholder db-canvas-node-placeholder--problem">
            <AlertTriangle size={22} />
            <strong>{node.availability.state === 'missing' ? i18n.t('canvas.node.missingFile') : i18n.t('canvas.node.unreadableFile')}</strong>
            <span>{node.availability.message}</span>
          </div>
        </div>
        {caption}
      </section>
    );
  }
  if (!node.videoPresentation) {
    throw new Error(`Projected video node is missing videoPresentation: ${node.projectRelativePath}`);
  }

  return (
    <section className="canvas-video-node">
      <div className="canvas-video-player-shell">
        {error ? (
          <div className="db-canvas-node-error-overlay">
            <AlertTriangle size={16} />
            <span>{error}</span>
            <Button
              className="db-canvas-node-retry"
              size="xs"
              iconStart={<RefreshCw size={12} />}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => {
                setError(undefined);
                setRetryKey((current) => current + 1);
              }}
            >
              {i18n.t('canvas.node.retry')}
            </Button>
          </div>
        ) : null}
        <CanvasVideoPlayerAdapter
          key={`${node.availability.fileUrl}:${retryKey}`}
          ref={register}
          node={node}
          onPointerInside={onSelectNode}
          onFocusInside={onSelectNode}
          onError={setError}
        />
      </div>
      {caption}
    </section>
  );
}
