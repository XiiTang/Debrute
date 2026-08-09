import React, { useEffect, useRef, useState } from 'react';
import type { ProjectedCanvasNode } from './CanvasScene.js';
import { CanvasNodeTitleBar } from './CanvasNodeTitleBar.js';
import { CanvasContentErrorPresentation } from './CanvasNodeErrorPresentation.js';
import { Music2 } from '../ui/index.js';
import { useI18n } from '../i18n/index.js';

const CanvasAudioPlayerAdapter = React.lazy(async () => {
  const module = await import('./CanvasAudioPlayerAdapter.js');
  return { default: module.CanvasAudioPlayerAdapter };
});

export interface CanvasAudioNodeContentProps {
  readonly node: ProjectedCanvasNode;
  readonly contentInteractionActive: boolean;
  readonly onContentError: (projectRelativePath: string) => void;
}

export function CanvasAudioNodeContent({
  node,
  contentInteractionActive,
  onContentError
}: CanvasAudioNodeContentProps): React.ReactElement {
  const i18n = useI18n();
  const [error, setError] = useState<string>();
  const [retryKey, setRetryKey] = useState(0);
  const previouslyActiveRef = useRef(false);
  const source = node.availability.state === 'available'
    ? node.availability.fileUrl
    : undefined;
  const availabilityError = node.availability.state === 'available' || node.availability.state === 'directory'
    ? undefined
    : node.availability.message;

  useEffect(() => {
    const becameActive = contentInteractionActive && !previouslyActiveRef.current;
    previouslyActiveRef.current = contentInteractionActive;
    if (contentInteractionActive && availabilityError) {
      onContentError(node.projectRelativePath);
      return;
    }
    if (becameActive && error) {
      setError(undefined);
      setRetryKey((current) => current + 1);
    }
  }, [availabilityError, contentInteractionActive, error, node.projectRelativePath, onContentError]);

  useEffect(() => {
    setError(undefined);
    setRetryKey(0);
  }, [source]);

  const contentError = error ?? availabilityError;
  const displayName = node.displayName;

  return (
    <section className="canvas-audio-node">
      <CanvasNodeTitleBar icon={<Music2 size={13} />} title={displayName} />
      <div className="canvas-audio-content" data-canvas-node-zone="content">
        {contentError ? (
          <CanvasContentErrorPresentation message={contentError} />
        ) : source ? (
          <React.Suspense fallback={null}>
            <CanvasAudioPlayerAdapter
              key={`${source}:${retryKey}`}
              source={source}
              contentInteractionActive={contentInteractionActive}
              playerLabel={i18n.t('canvas.node.audioPlayer')}
              errorMessage={i18n.t('canvas.node.unableToLoad', { path: node.projectRelativePath })}
              onError={(message) => {
                setError(message);
                onContentError(node.projectRelativePath);
              }}
            />
          </React.Suspense>
        ) : (
          <CanvasContentErrorPresentation message={i18n.t('canvas.node.unableToLoad', { path: node.projectRelativePath })} />
        )}
      </div>
    </section>
  );
}
