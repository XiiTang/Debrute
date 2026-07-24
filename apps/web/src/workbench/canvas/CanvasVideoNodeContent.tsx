import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, Video } from '../ui/index.js';
import type { CanvasFeedbackEntry, CanvasFeedbackGeometry, CanvasFeedbackSpatialItem, ProjectedCanvasNode } from '@debrute/canvas-core';
import { useI18n } from '../i18n';
import {
  CanvasVideoPlayerAdapter,
  type CanvasVideoPlayRequest,
  type CanvasVideoPlayerHandle
} from './CanvasVideoPlayerAdapter';
import type { CanvasVideoPreviewSource } from './canvasVideoPreviews';
import { preloadCanvasImageForHandoff } from './CanvasMediaHandoff';
import { CanvasMediaFeedbackLayer, type CanvasMediaFeedbackDraftRegion, type CanvasMediaFeedbackMode } from './CanvasMediaFeedbackLayer';
import { CanvasNodeTitleBar } from './CanvasNodeTitleBar';
import { CanvasNodeErrorPresentation } from './CanvasNodeErrorPresentation';

type CanvasVideoVisibleLayer = 'preview' | 'player';

interface CanvasVideoVisiblePreview {
  sourceKey: string;
  preview: CanvasVideoPreviewSource;
}

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
  feedbackEntry?: CanvasFeedbackEntry | undefined;
  activeFeedbackItemId?: string | undefined;
  localFeedbackMode?: CanvasMediaFeedbackMode | undefined;
  localFeedbackRegions?: readonly CanvasMediaFeedbackDraftRegion[] | undefined;
  activeFeedbackMomentTimeSeconds?: number | undefined;
  onTitlePointerDown?: ((event: React.PointerEvent<Element>) => void) | undefined;
  onTitlePointerMove?: ((event: React.PointerEvent<Element>) => void) | undefined;
  onTitlePointerUp?: ((event: React.PointerEvent<Element>) => void) | undefined;
  onLocalFeedbackDraft?: ((input: {
    projectRelativePath: string;
    geometry: CanvasFeedbackGeometry;
  }) => void) | undefined;
  onFeedbackItemActivate?: ((itemId: string) => void) | undefined;
}

function canvasVideoPreviewLoadKey(preview: CanvasVideoPreviewSource): string {
  return `${preview.src}\u001f${preview.previewWidth}`;
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
  onVideoPreviewError,
  feedbackEntry,
  activeFeedbackItemId,
  localFeedbackMode,
  localFeedbackRegions,
  activeFeedbackMomentTimeSeconds,
  onTitlePointerDown,
  onTitlePointerMove,
  onTitlePointerUp,
  onLocalFeedbackDraft,
  onFeedbackItemActivate
}: CanvasVideoNodeContentProps): React.ReactElement {
  const i18n = useI18n();
  const [error, setError] = useState<string>();
  const [retryKey, setRetryKey] = useState(0);
  const [playing, setPlaying] = useState(false);
  const sourceKey = node.availability.state === 'available'
    ? `${node.projectRelativePath}\u001f${node.availability.fileUrl}\u001f${node.availability.revision}`
    : `${node.projectRelativePath}\u001f${node.availability.state}`;
  const initialVisibleLayer: CanvasVideoVisibleLayer = selected || forcePlayerMounted ? 'player' : 'preview';
  const [visibleLayer, setVisibleLayer] = useState<CanvasVideoVisibleLayer>(initialVisibleLayer);
  const [visiblePreview, setVisiblePreview] = useState<CanvasVideoVisiblePreview | undefined>(() => (
    initialVisibleLayer === 'preview' && videoPreview && !videoPreviewError
      ? { sourceKey, preview: videoPreview }
      : undefined
  ));
  const [playerMounted, setPlayerMounted] = useState(() => initialVisibleLayer === 'player');
  const playerShellRef = useRef<HTMLDivElement | null>(null);
  const [playerShellSize, setPlayerShellSize] = useState<CanvasVideoFrameSize>();
  const targetLayer: CanvasVideoVisibleLayer = selected || forcePlayerMounted || playing ? 'player' : 'preview';
  const targetLayerRef = useRef(targetLayer);
  const sourceResetLayerRef = useRef<CanvasVideoVisibleLayer>(initialVisibleLayer);
  const nextPlayRequestIdRef = useRef(0);
  const [playRequest, setPlayRequest] = useState<CanvasVideoPlayRequest>();
  const playingRef = useRef(false);
  const previousSourceKeyRef = useRef(sourceKey);
  const currentVisiblePreview = visiblePreview?.sourceKey === sourceKey
    ? visiblePreview.preview
    : undefined;

  targetLayerRef.current = targetLayer;
  sourceResetLayerRef.current = selected || forcePlayerMounted ? 'player' : 'preview';

  const register = useCallback((target: CanvasVideoPlayerHandle | null) => {
    onRegisterVideoTarget(node.projectRelativePath, target ?? undefined);
    if (target) {
      onPlayerMounted?.(node.projectRelativePath);
    }
  }, [node.projectRelativePath, onPlayerMounted, onRegisterVideoTarget]);

  useEffect(() => {
    const sourceChanged = previousSourceKeyRef.current !== sourceKey;
    previousSourceKeyRef.current = sourceKey;
    if (!sourceChanged) {
      return;
    }
    const wasPlaying = playingRef.current;
    playingRef.current = false;
    setError(undefined);
    setRetryKey(0);
    setPlaying(false);
    setPlayRequest(undefined);
    const resetLayer = sourceResetLayerRef.current;
    setVisibleLayer(resetLayer);
    setVisiblePreview(undefined);
    setPlayerMounted(resetLayer === 'player');
    if (wasPlaying) {
      onPlayingChange?.(node.projectRelativePath, false);
    }
  }, [sourceKey, node.projectRelativePath, onPlayingChange]);

  useEffect(() => {
    if (visibleLayer !== 'preview' || !videoPreview || videoPreviewError) {
      return;
    }
    setVisiblePreview((current) => (
      current?.sourceKey === sourceKey
        && current.preview.src === videoPreview.src
        && current.preview.previewWidth === videoPreview.previewWidth
        ? current
        : { sourceKey, preview: videoPreview }
    ));
  }, [sourceKey, videoPreview, videoPreviewError, visibleLayer]);

  useEffect(() => {
    if (targetLayer !== 'player') {
      return;
    }
    setPlayerMounted(true);
    if ((!videoPreview && !currentVisiblePreview) || videoPreviewError) {
      setVisibleLayer('player');
    }
  }, [currentVisiblePreview, targetLayer, videoPreview, videoPreviewError]);

  useEffect(() => {
    if (targetLayer === 'preview' && visibleLayer === 'preview') {
      setPlayerMounted(false);
    }
  }, [targetLayer, visibleLayer]);

  useEffect(() => () => {
    onRegisterVideoTarget(node.projectRelativePath, undefined);
  }, [node.projectRelativePath, onRegisterVideoTarget]);

  useLayoutEffect(() => {
    const element = playerShellRef.current;
    if (!element) {
      return;
    }
    const syncSize = () => {
      const nextSize = element.clientWidth > 0 && element.clientHeight > 0
        ? { width: element.clientWidth, height: element.clientHeight }
        : undefined;
      setPlayerShellSize((current) => sameFrameSize(current, nextSize) ? current : nextSize);
    };
    syncSize();
    const resizeObserver = new ResizeObserver(syncSize);
    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, []);

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
    }
  }, [node.projectRelativePath, onPlayingChange]);
  const handlePlaybackBoundary = useCallback((currentTimeSeconds: number) => {
    const normalizedTimeSeconds = Number.isFinite(currentTimeSeconds) && currentTimeSeconds > 0
      ? currentTimeSeconds
      : 0;
    void onUpdatePlaybackTime(node.projectRelativePath, normalizedTimeSeconds);
    if (normalizedTimeSeconds === 0) {
      playingRef.current = false;
      setPlaying(false);
      onPlayingChange?.(node.projectRelativePath, false);
      return;
    }
  }, [node.projectRelativePath, onPlayingChange, onUpdatePlaybackTime]);
  const reportVideoPreviewLoadError = useCallback((preview: CanvasVideoPreviewSource) => {
    onVideoPreviewError?.(
      node.projectRelativePath,
      preview,
      i18n.t('canvas.node.videoPreviewVariantLoadError', { path: node.projectRelativePath })
    );
  }, [i18n, node.projectRelativePath, onVideoPreviewError]);
  const formatVideoPlayError = useCallback((projectRelativePath: string) => (
    i18n.t('canvas.node.videoPlayError', { path: projectRelativePath })
  ), [i18n]);
  const formatVideoSeekError = useCallback((projectRelativePath: string, seconds: number) => (
    i18n.t('canvas.node.videoSeekError', { path: projectRelativePath, seconds })
  ), [i18n]);
  useEffect(() => {
    if (targetLayer !== 'preview' || visibleLayer !== 'player' || !videoPreview || videoPreviewError) {
      return undefined;
    }
    const loadKey = canvasVideoPreviewLoadKey(videoPreview);
    return preloadCanvasImageForHandoff({
      image: {
        ...videoPreview,
        loadKey
      },
      resolveLoaded: (resolvedLoadKey) => {
        if (targetLayerRef.current !== 'preview' || resolvedLoadKey !== loadKey) {
          return;
        }
        setVisibleLayer('preview');
        setPlayerMounted(false);
      },
      rejectLoaded: (rejectedLoadKey) => {
        if (targetLayerRef.current !== 'preview' || rejectedLoadKey !== loadKey) {
          return;
        }
        reportVideoPreviewLoadError(videoPreview);
      }
    });
  }, [
    reportVideoPreviewLoadError,
    targetLayer,
    videoPreview,
    videoPreviewError,
    visibleLayer
  ]);
  const handlePlayerReadyForDisplay = useCallback(() => {
    if (targetLayerRef.current === 'player') {
      setVisibleLayer('player');
    }
  }, []);

  const titleBar = (
    <CanvasNodeTitleBar
      icon={<Video size={13} />}
      title={node.projectRelativePath.split('/').pop() ?? node.projectRelativePath}
      onPointerDown={onTitlePointerDown}
      onPointerMove={onTitlePointerMove}
      onPointerUp={onTitlePointerUp}
    />
  );

  if (node.availability.state !== 'available') {
    return (
      <section className="canvas-video-node">
        {titleBar}
        <div className="canvas-video-player-shell">
          <div className="db-canvas-node-placeholder db-canvas-node-placeholder--problem">
            <AlertTriangle size={22} />
            <strong>{node.availability.state === 'missing' ? i18n.t('canvas.node.missingFile') : i18n.t('canvas.node.unreadableFile')}</strong>
            <span>{node.availability.message}</span>
          </div>
        </div>
      </section>
    );
  }
  if (!node.videoPresentation) {
    throw new Error(`Projected video node is missing videoPresentation: ${node.projectRelativePath}`);
  }
  const presentation = node.videoPresentation;
  const initialTimeSeconds = node.videoPlayback?.currentTimeSeconds ?? 0;
  const feedbackMomentTimeSeconds = playing && activeFeedbackMomentTimeSeconds === undefined
    ? undefined
    : activeFeedbackMomentTimeSeconds ?? initialTimeSeconds;
  const previewLayerSource = visibleLayer === 'preview' && !videoPreviewError
    ? videoPreview ?? currentVisiblePreview
    : undefined;
  const feedbackContentBox = canvasVideoFrameContentBox({
    shell: playerShellSize,
    frame: {
      width: presentation.width,
      height: presentation.height
    }
  });

  return (
    <section className="canvas-video-node">
      {titleBar}
      <div ref={playerShellRef} className="canvas-video-player-shell">
        {error ? (
          <CanvasNodeErrorPresentation
            message={error}
            onRetry={() => {
              setError(undefined);
              setRetryKey((current) => current + 1);
            }}
          />
        ) : null}
        {videoPreviewError && targetLayer === 'preview' ? (
          <CanvasNodeErrorPresentation message={videoPreviewError} />
        ) : null}
        {previewLayerSource ? (
          <img
            className="canvas-video-layer canvas-video-preview-image"
            src={previewLayerSource.src}
            alt=""
            draggable={false}
            data-preview-width={previewLayerSource.previewWidth}
            data-canvas-video-layer="preview"
            onError={() => reportVideoPreviewLoadError(previewLayerSource)}
            onPointerDown={requestPlaybackFromPreview}
          />
        ) : null}
        {playerMounted ? (
          <div
            className={visibleLayer === 'player'
              ? 'canvas-video-layer'
              : 'canvas-video-layer canvas-video-layer--hidden'}
            data-canvas-video-layer="player"
          >
            <CanvasVideoPlayerAdapter
              key={`${node.availability.fileUrl}:${retryKey}`}
              ref={register}
              node={node}
              initialTimeSeconds={initialTimeSeconds}
              playRequest={playRequest}
              onPointerInside={mountPlayer}
              onFocusInside={mountPlayer}
              formatPlayError={formatVideoPlayError}
              formatSeekError={formatVideoSeekError}
              onError={setError}
              onPlayingChange={handlePlayingChange}
              onPlaybackBoundary={handlePlaybackBoundary}
              onReadyForDisplay={handlePlayerReadyForDisplay}
              onPlayRequestConsumed={(requestId) => {
                setPlayRequest((current) => current?.requestId === requestId ? undefined : current);
              }}
            />
          </div>
        ) : null}
        {visibleLayer === 'preview' && !previewLayerSource && !videoPreviewError && !playerMounted ? (
          <div className="db-canvas-node-placeholder">
            <Video size={22} />
            <strong>{i18n.t('canvas.node.video')}</strong>
            <span>{node.projectRelativePath.split('/').pop() ?? node.projectRelativePath}</span>
          </div>
        ) : null}
        <div className="canvas-video-feedback-content" style={canvasVideoFrameContentBoxStyle(feedbackContentBox)}>
          <CanvasMediaFeedbackLayer
            items={videoMomentSpatialItems({
              entry: feedbackEntry,
              currentTimeSeconds: feedbackMomentTimeSeconds
            })}
            mode={localFeedbackMode}
            draftRegions={localFeedbackRegions?.filter((region) => (
              region.momentTimeSeconds === feedbackMomentTimeSeconds
            ))}
            activeItemId={activeFeedbackItemId}
            onItemActivate={onFeedbackItemActivate}
            onRegionDraft={(geometry) => onLocalFeedbackDraft?.({
              projectRelativePath: node.projectRelativePath,
              geometry
            })}
          />
        </div>
      </div>
    </section>
  );
}

interface CanvasVideoFrameSize {
  width: number;
  height: number;
}

interface CanvasVideoFrameContentBox extends CanvasVideoFrameSize {
  left: number;
  top: number;
}

export function canvasVideoFrameContentBox(input: {
  shell: CanvasVideoFrameSize | undefined;
  frame: CanvasVideoFrameSize;
}): CanvasVideoFrameContentBox | undefined {
  if (!input.shell || input.shell.width <= 0 || input.shell.height <= 0 || input.frame.width <= 0 || input.frame.height <= 0) {
    return undefined;
  }
  const shellAspect = input.shell.width / input.shell.height;
  const frameAspect = input.frame.width / input.frame.height;
  if (shellAspect > frameAspect) {
    const height = input.shell.height;
    const width = height * frameAspect;
    return {
      left: (input.shell.width - width) / 2,
      top: 0,
      width,
      height
    };
  }
  const width = input.shell.width;
  const height = width / frameAspect;
  return {
    left: 0,
    top: (input.shell.height - height) / 2,
    width,
    height
  };
}

function canvasVideoFrameContentBoxStyle(box: CanvasVideoFrameContentBox | undefined): React.CSSProperties {
  return box
    ? {
        left: `${box.left}px`,
        top: `${box.top}px`,
        width: `${box.width}px`,
        height: `${box.height}px`
      }
    : { inset: 0 };
}

function sameFrameSize(
  left: CanvasVideoFrameSize | undefined,
  right: CanvasVideoFrameSize | undefined
): boolean {
  return left?.width === right?.width && left?.height === right?.height;
}

function videoMomentSpatialItems(input: {
  entry: CanvasFeedbackEntry | undefined;
  currentTimeSeconds: number | undefined;
}): CanvasFeedbackSpatialItem[] {
  if (input.currentTimeSeconds === undefined) {
    return [];
  }
  return input.entry?.items.filter((item): item is CanvasFeedbackSpatialItem => (
    (item.kind === 'pin' || item.kind === 'region')
    && item.scope === 'moment'
    && item.moment.currentTimeSeconds === input.currentTimeSeconds
  )) ?? [];
}
