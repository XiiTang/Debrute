// @vitest-environment jsdom

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CanvasVideoPlayerAdapter', () => {
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
          <CanvasVideoPlayerAdapter
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
          <CanvasVideoPlayerAdapter
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
          <CanvasVideoPlayerAdapter
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
          <CanvasVideoPlayerAdapter
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
          <CanvasVideoPlayerAdapter
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
          <CanvasVideoPlayerAdapter
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
          <CanvasVideoPlayerAdapter
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
          <CanvasVideoPlayerAdapter
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

  it('seeks to the initial time and reports playback boundary events', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onPlayingChange = vi.fn();
    const onPlaybackBoundary = vi.fn();

    try {
      await act(async () => {
        root.render(
          <CanvasVideoPlayerAdapter
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

  it('reports a playback error when the initial time is outside the projected duration', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onError = vi.fn();

    try {
      await act(async () => {
        root.render(
          <CanvasVideoPlayerAdapter
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
          <CanvasVideoPlayerAdapter
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

function videoNode(options: { durationSeconds?: number } = {}): ProjectedCanvasNode {
  const videoPresentation: ProjectedCanvasNode['videoPresentation'] = {
    kind: 'video',
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
      fileUrl: 'http://127.0.0.1:17321/api/projects/p/files/raw/media/clip.mp4?v=rev',
      revision: 'rev'
    },
    videoPresentation
  };
}
