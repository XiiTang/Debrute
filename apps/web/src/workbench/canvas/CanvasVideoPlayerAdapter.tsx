import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import {
  MediaCaptionsButton,
  MediaControlBar,
  MediaController,
  MediaFullscreenButton,
  MediaLoadingIndicator,
  MediaMuteButton,
  MediaPipButton,
  MediaPlayButton,
  MediaPlaybackRateButton,
  MediaTimeDisplay,
  MediaTimeRange,
  MediaVolumeRange
} from 'media-chrome/react';
import { normalizeCanvasVideoPlaybackTimeMs } from '@debrute/canvas-core';
import type { ProjectedCanvasNode } from './CanvasScene';

export interface CanvasVideoPlayerHandle {
  readCurrentTimeSeconds(): number | undefined;
  pauseAt(seconds: number): void;
}

export interface CanvasVideoPlaybackToggleRequest {
  requestId: number;
}

export interface CanvasVideoPlayerAdapterProps {
  node: ProjectedCanvasNode;
  initialTimeMs: number;
  playbackToggleRequest?: CanvasVideoPlaybackToggleRequest | undefined;
  contentInteractionActive: boolean;
  formatPlayError: (projectRelativePath: string) => string;
  formatSeekError: (projectRelativePath: string, seconds: number) => string;
  onError: (message: string) => void;
  onPlayingChange: (playing: boolean) => void;
  onReadyForDisplay?: (() => void) | undefined;
  onPlaybackToggleRequestConsumed?: ((requestId: number) => void) | undefined;
}

export const CanvasVideoPlayerAdapter = forwardRef<CanvasVideoPlayerHandle, CanvasVideoPlayerAdapterProps>(function CanvasVideoPlayerAdapter({
  node,
  initialTimeMs,
  playbackToggleRequest,
  contentInteractionActive,
  formatPlayError,
  formatSeekError,
  onError,
  onPlayingChange,
  onReadyForDisplay,
  onPlaybackToggleRequestConsumed
}, ref) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const consumedPlaybackToggleRequestIdRef = useRef<number | undefined>(undefined);
  const readyForDisplayRef = useRef(false);
  const displayReadinessFailedRef = useRef(false);
  const pendingInitialSeekRef = useRef(initialTimeMs > 0);
  const initialSeekStartedRef = useRef(false);
  const source = node.availability.state === 'available' ? node.availability.fileUrl : '';
  const textTracks = (node.videoTextTracks ?? []).map((track) => ({
    ...track,
    fileUrl: requiredVideoCompanionFileUrl(node, track.projectRelativePath, track.fileUrl)
  }));

  const reportInitialSeekError = useCallback((message: string) => {
    displayReadinessFailedRef.current = true;
    pendingInitialSeekRef.current = false;
    onError(message);
  }, [onError]);

  const startInitialSeek = useCallback((video: HTMLVideoElement) => {
    if (
      initialTimeMs <= 0
      || initialSeekStartedRef.current
      || displayReadinessFailedRef.current
    ) {
      return;
    }
    const initialTimeSeconds = initialTimeMs / 1000;
    const message = formatSeekError(node.projectRelativePath, initialTimeSeconds);
    const duration = Number.isFinite(video.duration)
      ? video.duration
      : node.videoMetadata?.durationSeconds;
    if (duration !== undefined && initialTimeSeconds > duration) {
      reportInitialSeekError(message);
      return;
    }
    initialSeekStartedRef.current = true;
    try {
      video.currentTime = initialTimeSeconds;
    } catch {
      reportInitialSeekError(message);
    }
  }, [formatSeekError, initialTimeMs, node.projectRelativePath, node.videoMetadata?.durationSeconds, reportInitialSeekError]);

  const syncReadyForDisplay = useCallback((video: HTMLVideoElement | null) => {
    if (
      !video
      || readyForDisplayRef.current
      || displayReadinessFailedRef.current
    ) {
      return;
    }
    if (pendingInitialSeekRef.current) {
      if (!initialSeekStartedRef.current) {
        if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
          startInitialSeek(video);
        }
        return;
      }
      const initialTimeSeconds = initialTimeMs / 1000;
      if (video.seeking || Math.abs(video.currentTime - initialTimeSeconds) > 0.001) {
        return;
      }
      pendingInitialSeekRef.current = false;
    }
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return;
    }
    readyForDisplayRef.current = true;
    onReadyForDisplay?.();
  }, [initialTimeMs, onReadyForDisplay, startInitialSeek]);

  const handleLoadedMetadata = useCallback((event: React.SyntheticEvent<HTMLVideoElement>) => {
    startInitialSeek(event.currentTarget);
  }, [startInitialSeek]);

  const handleSeeked = useCallback((event: React.SyntheticEvent<HTMLVideoElement>) => {
    syncReadyForDisplay(event.currentTarget);
  }, [syncReadyForDisplay]);

  useEffect(() => {
    const video = videoRef.current;
    syncReadyForDisplay(video);
    if (!video || initialTimeMs <= 0 || readyForDisplayRef.current || displayReadinessFailedRef.current) {
      return;
    }
    const frameId = requestAnimationFrame(() => {
      syncReadyForDisplay(video);
    });
    return () => cancelAnimationFrame(frameId);
  }, [initialTimeMs, syncReadyForDisplay]);

  useEffect(() => {
    const video = videoRef.current;
    const request = playbackToggleRequest;
    if (!video || !request || consumedPlaybackToggleRequestIdRef.current === request.requestId) {
      return;
    }
    consumedPlaybackToggleRequestIdRef.current = request.requestId;
    onPlaybackToggleRequestConsumed?.(request.requestId);
    if (video.paused) {
      void video.play().catch(() => {
        onError(formatPlayError(node.projectRelativePath));
      });
    } else {
      video.pause();
    }
  }, [
    formatPlayError,
    node.projectRelativePath,
    onError,
    onPlaybackToggleRequestConsumed,
    playbackToggleRequest
  ]);

  useImperativeHandle(ref, () => ({
    readCurrentTimeSeconds: () => {
      const video = videoRef.current;
      return video && Number.isFinite(video.currentTime)
        ? normalizeCanvasVideoPlaybackTimeMs(Math.round(Math.max(0, video.currentTime) * 1000)) / 1000
        : undefined;
    },
    pauseAt: (seconds) => {
      const video = videoRef.current;
      if (!video) return;
      const currentTimeSeconds = normalizeCanvasVideoPlaybackTimeMs(Math.round(Math.max(0, seconds) * 1000)) / 1000;
      video.pause();
      video.currentTime = currentTimeSeconds;
      onPlayingChange(false);
    }
  }), [onPlayingChange]);

  return (
    <div className="canvas-video-player">
      <MediaController noHotkeys={!contentInteractionActive}>
        <video
          ref={videoRef}
          slot="media"
          src={source}
          preload="metadata"
          playsInline
          onLoadedMetadata={handleLoadedMetadata}
          onLoadedData={(event) => syncReadyForDisplay(event.currentTarget)}
          onCanPlay={(event) => syncReadyForDisplay(event.currentTarget)}
          onSeeked={handleSeeked}
          onPlay={() => onPlayingChange(true)}
          onPlaying={(event) => syncReadyForDisplay(event.currentTarget)}
          onPause={() => onPlayingChange(false)}
          onEnded={(event) => {
            onPlayingChange(false);
            event.currentTarget.currentTime = 0;
          }}
          onError={() => onError(formatPlayError(node.projectRelativePath))}
        >
          {textTracks.map((track) => (
            <track
              key={`${track.projectRelativePath}:${track.revision}`}
              src={track.fileUrl}
              kind={track.kind}
              label={track.label}
              srcLang={track.srclang}
              default={track.default}
            />
          ))}
        </video>
        <MediaLoadingIndicator />
        <MediaControlBar>
          <MediaPlayButton />
          <MediaTimeRange data-canvas-direct-manipulation="true" />
          <MediaTimeDisplay showDuration />
          <MediaMuteButton />
          <MediaVolumeRange data-canvas-direct-manipulation="true" />
          <MediaPlaybackRateButton rates={[0.5, 1, 1.5, 2]} />
          <MediaCaptionsButton />
          <MediaPipButton />
          <MediaFullscreenButton />
        </MediaControlBar>
      </MediaController>
    </div>
  );
});

function requiredVideoCompanionFileUrl(
  node: ProjectedCanvasNode,
  projectRelativePath: string,
  fileUrl: string | undefined
): string {
  if (!fileUrl) {
    throw new Error(`Projected video companion is missing fileUrl: ${node.projectRelativePath} -> ${projectRelativePath}`);
  }
  return fileUrl;
}
