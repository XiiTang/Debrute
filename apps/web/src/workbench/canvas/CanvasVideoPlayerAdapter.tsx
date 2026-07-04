import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import {
  MediaCaptionsButton,
  MediaControlBar,
  MediaController,
  MediaErrorDialog,
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
import { normalizeCanvasVideoPlaybackTime, type ProjectedCanvasNode } from '@debrute/canvas-core';

export interface CanvasVideoPlayerHandle {
  readCurrentTimeSeconds(): number | undefined;
  pauseAt(seconds: number): void;
  togglePlayback(): void;
  seekBy(seconds: number): void;
  toggleMuted(): void;
  adjustPlaybackRate(delta: number): void;
  toggleCaptions(): void;
  enterFullscreen(): void;
  togglePictureInPicture(): void;
}

export interface CanvasVideoPlayRequest {
  requestId: number;
}

export interface CanvasVideoPlayerAdapterProps {
  node: ProjectedCanvasNode;
  initialTimeSeconds: number;
  playRequest?: CanvasVideoPlayRequest | undefined;
  onPointerInside: () => void;
  onFocusInside: () => void;
  formatPlayError: (projectRelativePath: string) => string;
  formatSeekError: (projectRelativePath: string, seconds: number) => string;
  onError: (message: string) => void;
  onPlayingChange: (playing: boolean) => void;
  onPlaybackBoundary: (currentTimeSeconds: number) => void;
  onReadyForDisplay?: (() => void) | undefined;
  onPlayRequestConsumed?: ((requestId: number) => void) | undefined;
}

export const CanvasVideoPlayerAdapter = forwardRef<CanvasVideoPlayerHandle, CanvasVideoPlayerAdapterProps>(function CanvasVideoPlayerAdapter({
  node,
  initialTimeSeconds,
  playRequest,
  onPointerInside,
  onFocusInside,
  formatPlayError,
  formatSeekError,
  onError,
  onPlayingChange,
  onPlaybackBoundary,
  onReadyForDisplay,
  onPlayRequestConsumed
}, ref) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastPlaybackBoundaryRef = useRef<number | undefined>(undefined);
  const consumedPlayRequestIdRef = useRef<number | undefined>(undefined);
  const readyForDisplayRef = useRef(false);
  const displayReadinessFailedRef = useRef(false);
  const pendingInitialSeekRef = useRef(false);
  const source = node.availability.state === 'available' ? node.availability.fileUrl : '';
  const presentation = node.videoPresentation;
  if (!presentation) {
    throw new Error(`Projected video node is missing videoPresentation: ${node.projectRelativePath}`);
  }
  const textTracks = presentation.textTracks.map((track) => ({
    ...track,
    fileUrl: requiredVideoCompanionFileUrl(node, track.projectRelativePath, track.fileUrl)
  }));

  const publishPlaybackBoundary = useCallback((currentTimeSeconds: number) => {
    const normalizedTimeSeconds = Number.isFinite(currentTimeSeconds) && currentTimeSeconds > 0
      ? currentTimeSeconds
      : 0;
    if (lastPlaybackBoundaryRef.current === normalizedTimeSeconds) {
      return;
    }
    lastPlaybackBoundaryRef.current = normalizedTimeSeconds;
    onPlaybackBoundary(normalizedTimeSeconds);
  }, [onPlaybackBoundary]);

  const reportReadyForDisplay = useCallback(() => {
    if (readyForDisplayRef.current || displayReadinessFailedRef.current) {
      return;
    }
    readyForDisplayRef.current = true;
    onReadyForDisplay?.();
  }, [onReadyForDisplay]);

  const reportInitialSeekError = useCallback((message: string) => {
    displayReadinessFailedRef.current = true;
    pendingInitialSeekRef.current = false;
    onError(message);
  }, [onError]);

  const handleLoadedMetadata = useCallback((event: React.SyntheticEvent<HTMLVideoElement>) => {
    if (initialTimeSeconds <= 0) {
      return;
    }
    const message = formatSeekError(node.projectRelativePath, initialTimeSeconds);
    if (presentation.durationSeconds !== undefined && initialTimeSeconds > presentation.durationSeconds) {
      reportInitialSeekError(message);
      return;
    }
    try {
      pendingInitialSeekRef.current = true;
      event.currentTarget.currentTime = initialTimeSeconds;
    } catch {
      reportInitialSeekError(message);
    }
  }, [formatSeekError, initialTimeSeconds, node.projectRelativePath, presentation.durationSeconds, reportInitialSeekError]);

  const handleDisplayDataReady = useCallback(() => {
    if (!pendingInitialSeekRef.current) {
      reportReadyForDisplay();
    }
  }, [reportReadyForDisplay]);

  const handleSeeked = useCallback((event: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    if (pendingInitialSeekRef.current) {
      pendingInitialSeekRef.current = false;
      publishPlaybackBoundary(video.currentTime);
      reportReadyForDisplay();
      return;
    }
    if (video.paused) {
      publishPlaybackBoundary(video.currentTime);
    }
  }, [publishPlaybackBoundary, reportReadyForDisplay]);

  useEffect(() => () => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.currentTime) || video.currentTime <= 0 || video.ended) {
      return;
    }
    publishPlaybackBoundary(video.currentTime);
  }, [publishPlaybackBoundary]);

  useEffect(() => {
    const video = videoRef.current;
    const request = playRequest;
    if (!video || !request || consumedPlayRequestIdRef.current === request.requestId) {
      return;
    }
    consumedPlayRequestIdRef.current = request.requestId;
    onPlayRequestConsumed?.(request.requestId);
    void video.play().catch(() => {
      onError(formatPlayError(node.projectRelativePath));
    });
  }, [formatPlayError, node.projectRelativePath, onError, onPlayRequestConsumed, playRequest]);

  useImperativeHandle(ref, () => ({
    readCurrentTimeSeconds: () => {
      const video = videoRef.current;
      return video && Number.isFinite(video.currentTime)
        ? normalizeCanvasVideoPlaybackTime(Math.max(0, video.currentTime))
        : undefined;
    },
    pauseAt: (seconds) => {
      const video = videoRef.current;
      if (!video) return;
      const currentTimeSeconds = normalizeCanvasVideoPlaybackTime(Math.max(0, seconds));
      video.pause();
      video.currentTime = currentTimeSeconds;
      publishPlaybackBoundary(currentTimeSeconds);
      onPlayingChange(false);
    },
    togglePlayback: () => {
      const video = videoRef.current;
      if (!video) return;
      if (video.paused) {
        void video.play();
      } else {
        video.pause();
      }
    },
    seekBy: (seconds) => {
      const video = videoRef.current;
      if (!video) return;
      video.currentTime = Math.max(0, video.currentTime + seconds);
    },
    toggleMuted: () => {
      const video = videoRef.current;
      if (video) {
        video.muted = !video.muted;
      }
    },
    adjustPlaybackRate: (delta) => {
      const video = videoRef.current;
      if (!video) return;
      video.playbackRate = Math.min(3, Math.max(0.25, Number((video.playbackRate + delta).toFixed(2))));
    },
    toggleCaptions: () => {
      const video = videoRef.current;
      if (!video) return;
      const tracks = Array.from(video.textTracks).filter((track) => track.kind === 'subtitles' || track.kind === 'captions');
      const showing = tracks.find((track) => track.mode === 'showing');
      for (const track of tracks) {
        track.mode = 'disabled';
      }
      if (!showing && tracks[0]) {
        tracks[0].mode = 'showing';
      }
    },
    enterFullscreen: () => {
      const element = videoRef.current?.closest('media-controller') as HTMLElement | null;
      void element?.requestFullscreen?.();
    },
    togglePictureInPicture: () => {
      const video = videoRef.current;
      if (!video || !document.pictureInPictureEnabled) return;
      if (document.pictureInPictureElement === video) {
        void document.exitPictureInPicture();
      } else {
        void video.requestPictureInPicture?.();
      }
    }
  }), [onPlayingChange, publishPlaybackBoundary]);

  return (
    <div
      className="canvas-video-player"
      onPointerDown={(event) => {
        event.stopPropagation();
        onPointerInside();
      }}
      onFocusCapture={onFocusInside}
    >
      <MediaController noHotkeys>
        <video
          ref={videoRef}
          slot="media"
          src={source}
          preload="metadata"
          playsInline
          onLoadedMetadata={handleLoadedMetadata}
          onLoadedData={handleDisplayDataReady}
          onCanPlay={handleDisplayDataReady}
          onSeeked={handleSeeked}
          onPlay={() => onPlayingChange(true)}
          onPause={(event) => {
            onPlayingChange(false);
            publishPlaybackBoundary(event.currentTarget.currentTime);
          }}
          onEnded={(event) => {
            onPlayingChange(false);
            event.currentTarget.currentTime = 0;
            publishPlaybackBoundary(0);
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
        <MediaErrorDialog role="dialog" slot="dialog" />
        <MediaControlBar>
          <MediaPlayButton />
          <MediaTimeRange />
          <MediaTimeDisplay showDuration />
          <MediaMuteButton />
          <MediaVolumeRange />
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
