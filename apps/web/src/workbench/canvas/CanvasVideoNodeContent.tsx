import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, RefreshCw, Video } from 'lucide-react';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import { Button } from '../ui';
import { useI18n } from '../i18n';
import {
  CanvasVideoPlayerAdapter,
  type CanvasVideoPlayRequest,
  type CanvasVideoPlayerHandle
} from './CanvasVideoPlayerAdapter';
import type { CanvasVideoPreviewSource } from './canvasVideoPreviews';

export interface CanvasVideoNodeContentProps {
  node: ProjectedCanvasNode;
  selected: boolean;
  videoPreview?: CanvasVideoPreviewSource | undefined;
  videoPreviewError?: string | undefined;
  forcePlayerMounted?: boolean | undefined;
  onSelectNode: () => void;
  onPlayerMounted?: ((projectRelativePath: string) => void) | undefined;
  onPlayingChange?: ((projectRelativePath: string, playing: boolean) => void) | undefined;
  onRegisterVideoTarget: (projectRelativePath: string, target: CanvasVideoPlayerHandle | undefined) => void;
  onUpdatePlaybackTime: (projectRelativePath: string, currentTimeSeconds: number) => void | Promise<void>;
  onVideoPreviewError?: ((projectRelativePath: string, preview: CanvasVideoPreviewSource, message: string) => void) | undefined;
}

export function CanvasVideoNodeContent({
  node,
  selected,
  videoPreview,
  videoPreviewError,
  forcePlayerMounted = false,
  onSelectNode,
  onPlayerMounted,
  onPlayingChange,
  onRegisterVideoTarget,
  onUpdatePlaybackTime,
  onVideoPreviewError
}: CanvasVideoNodeContentProps): React.ReactElement {
  const i18n = useI18n();
  const [error, setError] = useState<string>();
  const [retryKey, setRetryKey] = useState(0);
  const [playerMounted, setPlayerMounted] = useState(() => selected || forcePlayerMounted);
  const [playing, setPlaying] = useState(false);
  const nextPlayRequestIdRef = useRef(0);
  const [playRequest, setPlayRequest] = useState<CanvasVideoPlayRequest>();
  const playingRef = useRef(false);
  const sourceKey = node.availability.state === 'available'
    ? `${node.projectRelativePath}\u001f${node.availability.fileUrl}\u001f${node.availability.revision}`
    : `${node.projectRelativePath}\u001f${node.availability.state}`;
  const previousSourceKeyRef = useRef(sourceKey);
  const register = useCallback((target: CanvasVideoPlayerHandle | null) => {
    onRegisterVideoTarget(node.projectRelativePath, target ?? undefined);
    if (target) {
      onPlayerMounted?.(node.projectRelativePath);
    }
  }, [node.projectRelativePath, onPlayerMounted, onRegisterVideoTarget]);

  useEffect(() => {
    const sourceChanged = previousSourceKeyRef.current !== sourceKey;
    previousSourceKeyRef.current = sourceKey;
    const wasPlaying = playingRef.current;
    playingRef.current = false;
    setError(undefined);
    setRetryKey(0);
    setPlaying(false);
    setPlayRequest(undefined);
    if (sourceChanged && wasPlaying) {
      onPlayingChange?.(node.projectRelativePath, false);
    }
  }, [sourceKey]);

  useEffect(() => {
    if (selected || forcePlayerMounted) {
      setPlayerMounted(true);
    }
  }, [forcePlayerMounted, selected]);

  useEffect(() => {
    if (!selected && !forcePlayerMounted && !playing) {
      setPlayerMounted(false);
    }
  }, [forcePlayerMounted, playing, selected]);

  useEffect(() => () => {
    onRegisterVideoTarget(node.projectRelativePath, undefined);
  }, [node.projectRelativePath, onRegisterVideoTarget]);

  const mountPlayer = useCallback(() => {
    setPlayerMounted(true);
    onSelectNode();
  }, [onSelectNode]);
  const requestPlaybackFromPreview = useCallback((event: React.PointerEvent<HTMLImageElement>) => {
    event.stopPropagation();
    nextPlayRequestIdRef.current += 1;
    setPlayRequest({ requestId: nextPlayRequestIdRef.current });
    setPlayerMounted(true);
    onSelectNode();
  }, [onSelectNode]);
  const handlePlayingChange = useCallback((nextPlaying: boolean) => {
    playingRef.current = nextPlaying;
    setPlaying(nextPlaying);
    onPlayingChange?.(node.projectRelativePath, nextPlaying);
    if (nextPlaying) {
      setPlayerMounted(true);
    } else if (!selected && !forcePlayerMounted) {
      setPlayerMounted(false);
    }
  }, [forcePlayerMounted, node.projectRelativePath, onPlayingChange, selected]);
  const handlePlaybackBoundary = useCallback((currentTimeSeconds: number) => {
    const normalizedTimeSeconds = Number.isFinite(currentTimeSeconds) && currentTimeSeconds > 0
      ? currentTimeSeconds
      : 0;
    void onUpdatePlaybackTime(node.projectRelativePath, normalizedTimeSeconds);
    if (normalizedTimeSeconds === 0) {
      playingRef.current = false;
      setPlaying(false);
      onPlayingChange?.(node.projectRelativePath, false);
      if (!selected && !forcePlayerMounted) {
        setPlayerMounted(false);
      }
      return;
    }
    if (!selected && !forcePlayerMounted) {
      setPlayerMounted(false);
    }
  }, [forcePlayerMounted, node.projectRelativePath, onPlayingChange, onUpdatePlaybackTime, selected]);
  const handlePreviewImageError = useCallback(() => {
    if (!videoPreview) {
      return;
    }
    onVideoPreviewError?.(
      node.projectRelativePath,
      videoPreview,
      i18n.t('canvas.node.videoPreviewVariantLoadError', { path: node.projectRelativePath })
    );
  }, [i18n, node.projectRelativePath, onVideoPreviewError, videoPreview]);

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
  const initialTimeSeconds = node.videoPlayback?.currentTimeSeconds ?? 0;

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
        {playerMounted ? (
          <CanvasVideoPlayerAdapter
            key={`${node.availability.fileUrl}:${retryKey}`}
            ref={register}
            node={node}
            initialTimeSeconds={initialTimeSeconds}
            playRequest={playRequest}
            onPointerInside={mountPlayer}
            onFocusInside={mountPlayer}
            onError={setError}
            onPlayingChange={handlePlayingChange}
            onPlaybackBoundary={handlePlaybackBoundary}
            onPlayRequestConsumed={(requestId) => {
              setPlayRequest((current) => current?.requestId === requestId ? undefined : current);
            }}
          />
        ) : videoPreviewError ? (
          <div className="db-canvas-node-error-overlay">
            <AlertTriangle size={16} />
            <span>{videoPreviewError}</span>
          </div>
        ) : videoPreview ? (
          <img
            className="canvas-video-preview-image"
            src={videoPreview.src}
            alt=""
            draggable={false}
            data-preview-width={videoPreview.previewWidth}
            onError={handlePreviewImageError}
            onPointerDown={requestPlaybackFromPreview}
          />
        ) : (
          <div className="db-canvas-node-placeholder">
            <Video size={22} />
            <strong>{i18n.t('canvas.node.video')}</strong>
            <span>{node.projectRelativePath.split('/').pop() ?? node.projectRelativePath}</span>
          </div>
        )}
      </div>
      {caption}
    </section>
  );
}
