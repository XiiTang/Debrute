import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, Video } from '../ui/index.js';
import type { CanvasFeedbackEntry, CanvasFeedbackGeometry, CanvasFeedbackSpatialItem, ProjectedCanvasNode } from '@debrute/canvas-core';
import { useI18n } from '../i18n';
import type { CanvasVideoPlayRequest, CanvasVideoPlayerHandle } from './CanvasVideoPlayerAdapter.js';
import {
  useCanvasRasterPreviewPresentation,
  type CanvasRasterPreviewRequest
} from './CanvasRasterPreviewPresentation.js';
import { useCanvasVideoPreviewRuntime } from './CanvasVideoPreviewRuntime.js';
import { CanvasMediaFeedbackLayer, type CanvasMediaFeedbackDraftRegion, type CanvasMediaFeedbackMode } from './CanvasMediaFeedbackLayer';
import { CanvasNodeTitleBar } from './CanvasNodeTitleBar';
import { CanvasNodeErrorPresentation } from './CanvasNodeErrorPresentation';
import type { CanvasPreviewActivationRequest } from './CanvasDomInteractionAdapter.js';

const CanvasVideoPlayerAdapter = React.lazy(async () => {
  const module = await import('./CanvasVideoPlayerAdapter.js');
  return { default: module.CanvasVideoPlayerAdapter };
});

type CanvasVideoVisibleLayer = 'preview' | 'player';

export interface CanvasVideoNodeContentProps {
  node: ProjectedCanvasNode;
  contentInteractionActive: boolean;
  videoPreviewRequest?: CanvasRasterPreviewRequest | undefined;
  videoPreviewError?: string | undefined;
  forcePlayerMounted?: boolean | undefined;
  previewActivationRequest?: CanvasPreviewActivationRequest | undefined;
  onPlayerMounted?: ((projectRelativePath: string) => void) | undefined;
  onPlayingChange?: ((projectRelativePath: string, playing: boolean) => void) | undefined;
  onRegisterVideoTarget: (projectRelativePath: string, target: CanvasVideoPlayerHandle | undefined) => void;
  onUpdatePlaybackTime: (projectRelativePath: string, currentTimeMs: number) => void | Promise<void>;
  feedbackEntry?: CanvasFeedbackEntry | undefined;
  activeFeedbackItemId?: string | undefined;
  localFeedbackMode?: CanvasMediaFeedbackMode | undefined;
  localFeedbackRegions?: readonly CanvasMediaFeedbackDraftRegion[] | undefined;
  activeFeedbackMomentTimeSeconds?: number | undefined;
  onLocalFeedbackDraft?: ((input: {
    projectRelativePath: string;
    geometry: CanvasFeedbackGeometry;
  }) => void) | undefined;
  onFeedbackItemActivate?: ((itemId: string) => void) | undefined;
}

export function CanvasVideoNodeContent({
  node,
  contentInteractionActive,
  videoPreviewRequest,
  videoPreviewError,
  forcePlayerMounted = false,
  previewActivationRequest,
  onPlayerMounted,
  onPlayingChange,
  onRegisterVideoTarget,
  onUpdatePlaybackTime,
  feedbackEntry,
  activeFeedbackItemId,
  localFeedbackMode,
  localFeedbackRegions,
  activeFeedbackMomentTimeSeconds,
  onLocalFeedbackDraft,
  onFeedbackItemActivate
}: CanvasVideoNodeContentProps): React.ReactElement {
  const i18n = useI18n();
  const { retryPreview } = useCanvasVideoPreviewRuntime();
  const [error, setError] = useState<string>();
  const [retryKey, setRetryKey] = useState(0);
  const [playing, setPlaying] = useState(false);
  const playerSourceIdentity = node.availability.state === 'available'
    ? `${node.projectRelativePath}\u001f${node.availability.fileUrl}\u001f${node.availability.revision}`
    : `${node.projectRelativePath}\u001f${node.availability.state}`;
  const initialVisibleLayer: CanvasVideoVisibleLayer = contentInteractionActive || forcePlayerMounted ? 'player' : 'preview';
  const [visibleLayer, setVisibleLayer] = useState<CanvasVideoVisibleLayer>(initialVisibleLayer);
  const [playerMounted, setPlayerMounted] = useState(() => initialVisibleLayer === 'player');
  const playerShellRef = useRef<HTMLDivElement | null>(null);
  const [playerShellSize, setPlayerShellSize] = useState<CanvasVideoFrameSize>();
  const targetLayer: CanvasVideoVisibleLayer = contentInteractionActive || forcePlayerMounted || playing ? 'player' : 'preview';
  const targetLayerRef = useRef(targetLayer);
  const sourceResetLayerRef = useRef<CanvasVideoVisibleLayer>(initialVisibleLayer);
  const lastActivationRequestIdRef = useRef<number | undefined>(undefined);
  const [playRequest, setPlayRequest] = useState<CanvasVideoPlayRequest>();
  const playingRef = useRef(false);
  const previousPlayerSourceIdentityRef = useRef(playerSourceIdentity);

  targetLayerRef.current = targetLayer;
  sourceResetLayerRef.current = contentInteractionActive || forcePlayerMounted ? 'player' : 'preview';

  const register = useCallback((target: CanvasVideoPlayerHandle | null) => {
    onRegisterVideoTarget(node.projectRelativePath, target ?? undefined);
    if (target) {
      onPlayerMounted?.(node.projectRelativePath);
    }
  }, [node.projectRelativePath, onPlayerMounted, onRegisterVideoTarget]);

  useEffect(() => {
    const sourceChanged = previousPlayerSourceIdentityRef.current !== playerSourceIdentity;
    previousPlayerSourceIdentityRef.current = playerSourceIdentity;
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
    setPlayerMounted(resetLayer === 'player');
    if (wasPlaying) {
      onPlayingChange?.(node.projectRelativePath, false);
    }
  }, [playerSourceIdentity, node.projectRelativePath, onPlayingChange]);

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

  useEffect(() => {
    if (
      previewActivationRequest?.mediaKind !== 'video'
      || previewActivationRequest.projectRelativePath !== node.projectRelativePath
      || !contentInteractionActive
      || lastActivationRequestIdRef.current === previewActivationRequest.requestId
    ) {
      return;
    }
    lastActivationRequestIdRef.current = previewActivationRequest.requestId;
    setPlayRequest({ requestId: previewActivationRequest.requestId });
    setPlayerMounted(true);
  }, [contentInteractionActive, node.projectRelativePath, previewActivationRequest]);
  const handlePlayingChange = useCallback((nextPlaying: boolean) => {
    playingRef.current = nextPlaying;
    setPlaying(nextPlaying);
    onPlayingChange?.(node.projectRelativePath, nextPlaying);
    if (nextPlaying) {
      setPlayerMounted(true);
    }
  }, [node.projectRelativePath, onPlayingChange]);
  const handlePlaybackBoundary = useCallback((currentTimeMs: number) => {
    void onUpdatePlaybackTime(node.projectRelativePath, currentTimeMs);
    if (currentTimeMs === 0) {
      playingRef.current = false;
      setPlaying(false);
      onPlayingChange?.(node.projectRelativePath, false);
      return;
    }
  }, [node.projectRelativePath, onPlayingChange, onUpdatePlaybackTime]);
  const retryVideoPreviewSource = useCallback(() => {
    retryPreview(node.projectRelativePath);
  }, [node.projectRelativePath, retryPreview]);
  const rasterPreview = useCanvasRasterPreviewPresentation({
    request: videoPreviewRequest ?? {},
    nodeDisplayWidth: node.width,
    fit: 'contain',
    hidden: visibleLayer === 'player',
    sourceFailure: videoPreviewError
      ? { stage: 'source', error: new Error(videoPreviewError), retry: retryVideoPreviewSource }
      : undefined
  });
  const previewProblem = videoPreviewError
    ?? (rasterPreview.failure
      ? i18n.t('canvas.node.videoPreviewVariantLoadError', { path: node.projectRelativePath })
      : undefined);
  const formatVideoPlayError = useCallback((projectRelativePath: string) => (
    i18n.t('canvas.node.videoPlayError', { path: projectRelativePath })
  ), [i18n]);
  const formatVideoSeekError = useCallback((projectRelativePath: string, seconds: number) => (
    i18n.t('canvas.node.videoSeekError', { path: projectRelativePath, seconds })
  ), [i18n]);
  useEffect(() => {
    if (targetLayer !== 'player') {
      return;
    }
    setPlayerMounted(true);
    if (!rasterPreview.hasVisible || rasterPreview.failure) {
      setVisibleLayer('player');
    }
  }, [rasterPreview.failure, rasterPreview.hasVisible, targetLayer]);

  useEffect(() => {
    if (targetLayer !== 'preview' || !rasterPreview.hasVisible || rasterPreview.failure) {
      return;
    }
    setVisibleLayer('preview');
    setPlayerMounted(false);
  }, [rasterPreview.failure, rasterPreview.hasVisible, targetLayer]);
  const handlePlayerReadyForDisplay = useCallback(() => {
    if (targetLayerRef.current === 'player') {
      setVisibleLayer('player');
    }
  }, []);

  const titleBar = (
    <CanvasNodeTitleBar
      icon={<Video size={13} />}
      title={node.projectRelativePath.split('/').pop() ?? node.projectRelativePath}
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
  const initialTimeMs = node.videoPlayback?.currentTimeMs ?? 0;
  const feedbackMomentTimeSeconds = playing && activeFeedbackMomentTimeSeconds === undefined
    ? undefined
    : activeFeedbackMomentTimeSeconds ?? initialTimeMs / 1000;
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
      <div
        ref={playerShellRef}
        className="canvas-video-player-shell"
        data-canvas-node-zone={contentInteractionActive ? 'passive' : 'activate'}
      >
        {error ? (
          <CanvasNodeErrorPresentation
            message={error}
            onRetry={() => {
              setError(undefined);
              setRetryKey((current) => current + 1);
            }}
          />
        ) : null}
        {previewProblem && targetLayer === 'preview' ? (
          <CanvasNodeErrorPresentation message={previewProblem} onRetry={rasterPreview.retry} />
        ) : null}
        {rasterPreview.layers}
        {playerMounted ? (
          <div
            className={visibleLayer === 'player'
              ? 'canvas-video-layer'
              : 'canvas-video-layer canvas-video-layer--hidden'}
            data-canvas-video-layer="player"
            inert={!contentInteractionActive}
            data-canvas-interaction-island={contentInteractionActive ? 'true' : undefined}
          >
            <React.Suspense fallback={<div className="db-canvas-node-placeholder" aria-busy="true" />}>
              <CanvasVideoPlayerAdapter
                key={`${node.availability.fileUrl}:${retryKey}`}
                ref={register}
                node={node}
                initialTimeMs={initialTimeMs}
                playRequest={playRequest}
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
            </React.Suspense>
          </div>
        ) : null}
        {visibleLayer === 'preview' && !rasterPreview.hasVisible && !previewProblem && !playerMounted ? (
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
