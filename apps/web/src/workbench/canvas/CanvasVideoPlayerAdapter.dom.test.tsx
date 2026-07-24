import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';

vi.mock('media-chrome/react', async () => {
  const ReactModule = await import('react');
  type MockProps = React.PropsWithChildren<Record<string, unknown>>;
  const mediaComponent = (tagName: string) => ReactModule.forwardRef<HTMLElement, MockProps>(function MockMediaChromeComponent({
    children,
    ...props
  }, ref) {
    return ReactModule.createElement(tagName, { ...props, ref }, children as React.ReactNode);
  });
  return {
    MediaCaptionsButton: mediaComponent('media-captions-button'),
    MediaControlBar: mediaComponent('media-control-bar'),
    MediaController: mediaComponent('media-controller'),
    MediaErrorDialog: mediaComponent('media-error-dialog'),
    MediaFullscreenButton: mediaComponent('media-fullscreen-button'),
    MediaLoadingIndicator: mediaComponent('media-loading-indicator'),
    MediaMuteButton: mediaComponent('media-mute-button'),
    MediaPipButton: mediaComponent('media-pip-button'),
    MediaPlayButton: mediaComponent('media-play-button'),
    MediaPlaybackRateButton: mediaComponent('media-playback-rate-button'),
    MediaTimeDisplay: mediaComponent('media-time-display'),
    MediaTimeRange: mediaComponent('media-time-range'),
    MediaVolumeRange: mediaComponent('media-volume-range')
  };
});

import {
  CanvasVideoPlayerAdapter,
  type CanvasVideoPlayerHandle
} from './CanvasVideoPlayerAdapter';

type TestCanvasVideoPlayerAdapterProps = Omit<
  React.ComponentPropsWithoutRef<typeof CanvasVideoPlayerAdapter>,
  'formatPlayError' | 'formatSeekError'
>;

const TestCanvasVideoPlayerAdapter = React.forwardRef<CanvasVideoPlayerHandle, TestCanvasVideoPlayerAdapterProps>(
  function TestCanvasVideoPlayerAdapter(props, ref) {
    return (
      <CanvasVideoPlayerAdapter
        {...props}
        ref={ref}
        formatPlayError={(projectRelativePath) => `Unable to play ${projectRelativePath}.`}
        formatSeekError={(projectRelativePath, seconds) => `Unable to seek ${projectRelativePath} to ${seconds} seconds.`}
      />
    );
  }
);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CanvasVideoPlayerAdapter', { tags: ['canvas-video'] }, () => {
  it('toggles only one caption or subtitle track at a time', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const ref = React.createRef<CanvasVideoPlayerHandle>();
    const tracks = [
      textTrack('subtitles'),
      textTrack('captions'),
      textTrack('chapters')
    ];

    try {
      await act(async () => {
        root.render(
          <TestCanvasVideoPlayerAdapter
            ref={ref}
            node={videoNode()}
            initialTimeSeconds={0}
            onPointerInside={() => undefined}
            onFocusInside={() => undefined}
            onError={() => undefined}
            onPlayingChange={() => undefined}
            onPlaybackBoundary={() => undefined}
          />
        );
      });
      const video = container.querySelector('video');
      expect(video).not.toBeNull();
      Object.defineProperty(video, 'textTracks', {
        value: tracks,
        configurable: true
      });

      act(() => {
        ref.current?.toggleCaptions();
      });

      expect(tracks.map((track) => track.mode)).toEqual(['showing', 'disabled', 'disabled']);

      act(() => {
        ref.current?.toggleCaptions();
      });

      expect(tracks.map((track) => track.mode)).toEqual(['disabled', 'disabled', 'disabled']);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('keeps media-chrome hotkeys disabled and player picture gestures enabled', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <TestCanvasVideoPlayerAdapter
            node={videoNode()}
            initialTimeSeconds={0}
            onPointerInside={() => undefined}
            onFocusInside={() => undefined}
            onError={() => undefined}
            onPlayingChange={() => undefined}
            onPlaybackBoundary={() => undefined}
          />
        );
      });

      const controller = container.querySelector('media-controller');
      expect(controller).not.toBeNull();
      expect(controller?.hasAttribute('nohotkeys')).toBe(true);
      expect(controller?.hasAttribute('gesturesdisabled')).toBe(false);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('plays once for each new one-shot play request', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const play = vi.fn(async () => undefined);

    try {
      await act(async () => {
        root.render(
          <TestCanvasVideoPlayerAdapter
            node={videoNode()}
            initialTimeSeconds={0}
            onPointerInside={() => undefined}
            onFocusInside={() => undefined}
            onError={() => undefined}
            onPlayingChange={() => undefined}
            onPlaybackBoundary={() => undefined}
          />
        );
      });
      const video = container.querySelector('video');
      expect(video).not.toBeNull();
      if (!video) {
        throw new Error('Expected video element.');
      }
      Object.defineProperty(video, 'play', {
        configurable: true,
        value: play
      });

      await act(async () => {
        root.render(
          <TestCanvasVideoPlayerAdapter
            node={videoNode()}
            initialTimeSeconds={0}
            playRequest={{ requestId: 1 }}
            onPointerInside={() => undefined}
            onFocusInside={() => undefined}
            onError={() => undefined}
            onPlayingChange={() => undefined}
            onPlaybackBoundary={() => undefined}
          />
        );
      });
      expect(play).toHaveBeenCalledTimes(1);

      await act(async () => {
        root.render(
          <TestCanvasVideoPlayerAdapter
            node={videoNode()}
            initialTimeSeconds={0}
            playRequest={{ requestId: 1 }}
            onPointerInside={() => undefined}
            onFocusInside={() => undefined}
            onError={() => undefined}
            onPlayingChange={() => undefined}
            onPlaybackBoundary={() => undefined}
          />
        );
      });
      expect(play).toHaveBeenCalledTimes(1);

      await act(async () => {
        root.render(
          <TestCanvasVideoPlayerAdapter
            node={videoNode()}
            initialTimeSeconds={0}
            playRequest={{ requestId: 2 }}
            onPointerInside={() => undefined}
            onFocusInside={() => undefined}
            onError={() => undefined}
            onPlayingChange={() => undefined}
            onPlaybackBoundary={() => undefined}
          />
        );
      });
      expect(play).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('reports a playback error when the one-shot play request is rejected', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onError = vi.fn();

    try {
      await act(async () => {
        root.render(
          <TestCanvasVideoPlayerAdapter
            node={videoNode()}
            initialTimeSeconds={0}
            onPointerInside={() => undefined}
            onFocusInside={() => undefined}
            onError={onError}
            onPlayingChange={() => undefined}
            onPlaybackBoundary={() => undefined}
          />
        );
      });
      const video = container.querySelector('video');
      expect(video).not.toBeNull();
      if (!video) {
        throw new Error('Expected video element.');
      }
      Object.defineProperty(video, 'play', {
        configurable: true,
        value: vi.fn(async () => {
          throw new Error('not allowed');
        })
      });

      await act(async () => {
        root.render(
          <TestCanvasVideoPlayerAdapter
            node={videoNode()}
            initialTimeSeconds={0}
            playRequest={{ requestId: 1 }}
            onPointerInside={() => undefined}
            onFocusInside={() => undefined}
            onError={onError}
            onPlayingChange={() => undefined}
            onPlaybackBoundary={() => undefined}
          />
        );
      });

      expect(onError).toHaveBeenCalledWith('Unable to play media/clip.mp4.');
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('reports display readiness after a zero-time video has display data', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onReadyForDisplay = vi.fn();

    try {
      await act(async () => {
        root.render(
          <TestCanvasVideoPlayerAdapter
            node={videoNode()}
            initialTimeSeconds={0}
            onPointerInside={() => undefined}
            onFocusInside={() => undefined}
            onError={() => undefined}
            onPlayingChange={() => undefined}
            onPlaybackBoundary={() => undefined}
            onReadyForDisplay={onReadyForDisplay}
          />
        );
      });
      const video = requiredVideo(container);

      act(() => {
        video.dispatchEvent(new Event('loadedmetadata', { bubbles: true }));
      });
      expect(onReadyForDisplay).not.toHaveBeenCalled();

      act(() => {
        video.dispatchEvent(new Event('loadeddata', { bubbles: true }));
      });
      expect(onReadyForDisplay).toHaveBeenCalledTimes(1);

      act(() => {
        video.dispatchEvent(new Event('canplay', { bubbles: true }));
      });
      expect(onReadyForDisplay).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('reports display readiness after the initial timestamp seek completes', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onReadyForDisplay = vi.fn();

    try {
      await act(async () => {
        root.render(
          <TestCanvasVideoPlayerAdapter
            node={videoNode({ durationSeconds: 10 })}
            initialTimeSeconds={4.5}
            onPointerInside={() => undefined}
            onFocusInside={() => undefined}
            onError={() => undefined}
            onPlayingChange={() => undefined}
            onPlaybackBoundary={() => undefined}
            onReadyForDisplay={onReadyForDisplay}
          />
        );
      });
      const video = requiredVideo(container);

      act(() => {
        video.dispatchEvent(new Event('loadedmetadata', { bubbles: true }));
      });
      expect(video.currentTime).toBe(4.5);
      expect(onReadyForDisplay).not.toHaveBeenCalled();

      act(() => {
        video.dispatchEvent(new Event('seeked', { bubbles: true }));
      });
      expect(onReadyForDisplay).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('does not report display readiness when the initial timestamp is rejected', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onReadyForDisplay = vi.fn();
    const onError = vi.fn();

    try {
      await act(async () => {
        root.render(
          <TestCanvasVideoPlayerAdapter
            node={videoNode({ durationSeconds: 5 })}
            initialTimeSeconds={6.25}
            onPointerInside={() => undefined}
            onFocusInside={() => undefined}
            onError={onError}
            onPlayingChange={() => undefined}
            onPlaybackBoundary={() => undefined}
            onReadyForDisplay={onReadyForDisplay}
          />
        );
      });
      const video = requiredVideo(container);

      act(() => {
        video.dispatchEvent(new Event('loadedmetadata', { bubbles: true }));
      });

      expect(onError).toHaveBeenCalledWith('Unable to seek media/clip.mp4 to 6.25 seconds.');
      expect(onReadyForDisplay).not.toHaveBeenCalled();

      act(() => {
        video.dispatchEvent(new Event('loadeddata', { bubbles: true }));
        video.dispatchEvent(new Event('canplay', { bubbles: true }));
      });

      expect(onReadyForDisplay).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('seeks to the initial time and reports playback boundary events', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onPlayingChange = vi.fn();
    const onPlaybackBoundary = vi.fn();

    try {
      await act(async () => {
        root.render(
          <TestCanvasVideoPlayerAdapter
            node={videoNode()}
            initialTimeSeconds={4.5}
            onPointerInside={() => undefined}
            onFocusInside={() => undefined}
            onError={() => undefined}
            onPlayingChange={onPlayingChange}
            onPlaybackBoundary={onPlaybackBoundary}
          />
        );
      });
      const video = container.querySelector('video');
      expect(video).not.toBeNull();
      if (!video) {
        throw new Error('Expected video element.');
      }

      act(() => {
        video.dispatchEvent(new Event('loadedmetadata', { bubbles: true }));
      });

      expect(video.currentTime).toBe(4.5);

      act(() => {
        video.dispatchEvent(new Event('play', { bubbles: true }));
      });
      expect(onPlayingChange).toHaveBeenLastCalledWith(true);

      video.currentTime = 6.25;
      act(() => {
        video.dispatchEvent(new Event('pause', { bubbles: true }));
      });
      expect(onPlayingChange).toHaveBeenLastCalledWith(false);
      expect(onPlaybackBoundary).toHaveBeenLastCalledWith(6.25);

      video.currentTime = 8;
      act(() => {
        video.dispatchEvent(new Event('ended', { bubbles: true }));
      });
      expect(video.currentTime).toBe(0);
      expect(onPlaybackBoundary).toHaveBeenLastCalledWith(0);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('reports playback boundary events when a paused seek completes', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onPlaybackBoundary = vi.fn();

    try {
      await act(async () => {
        root.render(
          <TestCanvasVideoPlayerAdapter
            node={videoNode()}
            initialTimeSeconds={0}
            onPointerInside={() => undefined}
            onFocusInside={() => undefined}
            onError={() => undefined}
            onPlayingChange={() => undefined}
            onPlaybackBoundary={onPlaybackBoundary}
          />
        );
      });
      const video = requiredVideo(container);

      video.currentTime = 6.25;
      act(() => {
        video.dispatchEvent(new Event('seeked', { bubbles: true }));
      });

      expect(onPlaybackBoundary).toHaveBeenCalledTimes(1);
      expect(onPlaybackBoundary).toHaveBeenLastCalledWith(6.25);

      video.currentTime = 0;
      act(() => {
        video.dispatchEvent(new Event('seeked', { bubbles: true }));
      });

      expect(onPlaybackBoundary).toHaveBeenCalledTimes(2);
      expect(onPlaybackBoundary).toHaveBeenLastCalledWith(0);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('restores the persisted time after a failed commit without publishing another update', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const ref = React.createRef<CanvasVideoPlayerHandle>();
    const onPlaybackBoundary = vi.fn();
    const onPlayingChange = vi.fn();

    try {
      await act(async () => {
        root.render(
          <TestCanvasVideoPlayerAdapter
            ref={ref}
            node={videoNode()}
            initialTimeSeconds={0}
            onPointerInside={() => undefined}
            onFocusInside={() => undefined}
            onError={() => undefined}
            onPlayingChange={onPlayingChange}
            onPlaybackBoundary={onPlaybackBoundary}
          />
        );
      });
      const video = requiredVideo(container);
      Object.defineProperty(video, 'pause', { configurable: true, value: vi.fn() });

      act(() => {
        ref.current?.restorePersistedTime(3.25);
        video.dispatchEvent(new Event('seeked', { bubbles: true }));
      });

      expect(video.currentTime).toBe(3.25);
      expect(onPlayingChange).toHaveBeenLastCalledWith(false);
      expect(onPlaybackBoundary).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('reports a playback error when the initial time is outside the projected duration', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onError = vi.fn();

    try {
      await act(async () => {
        root.render(
          <TestCanvasVideoPlayerAdapter
            node={videoNode({ durationSeconds: 5 })}
            initialTimeSeconds={6.25}
            onPointerInside={() => undefined}
            onFocusInside={() => undefined}
            onError={onError}
            onPlayingChange={() => undefined}
            onPlaybackBoundary={() => undefined}
          />
        );
      });
      const video = container.querySelector('video');
      expect(video).not.toBeNull();
      if (!video) {
        throw new Error('Expected video element.');
      }

      act(() => {
        video.dispatchEvent(new Event('loadedmetadata', { bubbles: true }));
      });

      expect(onError).toHaveBeenCalledWith('Unable to seek media/clip.mp4 to 6.25 seconds.');
      expect(video.currentTime).toBe(0);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('reports a playback error when the browser rejects the initial seek assignment', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onError = vi.fn();

    try {
      await act(async () => {
        root.render(
          <TestCanvasVideoPlayerAdapter
            node={videoNode({ durationSeconds: 10 })}
            initialTimeSeconds={4.5}
            onPointerInside={() => undefined}
            onFocusInside={() => undefined}
            onError={onError}
            onPlayingChange={() => undefined}
            onPlaybackBoundary={() => undefined}
          />
        );
      });
      const video = container.querySelector('video');
      expect(video).not.toBeNull();
      if (!video) {
        throw new Error('Expected video element.');
      }
      Object.defineProperty(video, 'currentTime', {
        configurable: true,
        get: () => 0,
        set: () => {
          throw new Error('seek rejected');
        }
      });

      act(() => {
        video.dispatchEvent(new Event('loadedmetadata', { bubbles: true }));
      });

      expect(onError).toHaveBeenCalledWith('Unable to seek media/clip.mp4 to 4.5 seconds.');
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });
});

function textTrack(kind: TextTrack['kind']): { kind: TextTrack['kind']; mode: TextTrack['mode'] } {
  return {
    kind,
    mode: 'disabled'
  };
}

function requiredVideo(container: HTMLElement): HTMLVideoElement {
  const video = container.querySelector('video');
  if (!video) {
    throw new Error('Expected video element.');
  }
  return video;
}

function videoNode(options: { durationSeconds?: number } = {}): ProjectedCanvasNode {
  const videoPresentation: ProjectedCanvasNode['videoPresentation'] = {
    kind: 'video',
    width: 640,
    height: 360,
    textTracks: []
  };
  if (options.durationSeconds !== undefined) {
    videoPresentation.durationSeconds = options.durationSeconds;
  }
  return {
    projectRelativePath: 'media/clip.mp4',
    nodeKind: 'file',
    mediaKind: 'video',
    x: 0,
    y: 0,
    width: 640,
    height: 360,
    z: 0,
    availability: {
      state: 'available',
      size: 100,
      mimeType: 'video/mp4',
      fileUrl: '/api/projects/p/files/raw/media/clip.mp4?v=rev',
      revision: 'rev'
    },
    videoPresentation
  };
}
