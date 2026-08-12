import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { ProjectedCanvasNode } from './CanvasScene';

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
  'formatPlayError' | 'formatSeekError' | 'contentInteractionActive'
> & {
  contentInteractionActive?: boolean | undefined;
};

const TestCanvasVideoPlayerAdapter = React.forwardRef<CanvasVideoPlayerHandle, TestCanvasVideoPlayerAdapterProps>(
  function TestCanvasVideoPlayerAdapter(props, ref) {
    return (
      <CanvasVideoPlayerAdapter
        {...props}
        ref={ref}
        contentInteractionActive={props.contentInteractionActive ?? false}
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
  it('keeps only live playback operations on the Canvas handle', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const ref = React.createRef<CanvasVideoPlayerHandle>();
    try {
      await act(async () => {
        root.render(
          <TestCanvasVideoPlayerAdapter
            ref={ref}
            node={videoNode()}
            initialTimeMs={0}
            onError={() => undefined}
            onPlayingChange={() => undefined}
          />
        );
      });
      expect(Object.keys(ref.current ?? {}).sort()).toEqual([
        'pauseAt',
        'readCurrentTimeSeconds'
      ]);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('enables Media Chrome hotkeys only while Content Activation is active', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <TestCanvasVideoPlayerAdapter
            node={videoNode()}
            initialTimeMs={0}
            onError={() => undefined}
            onPlayingChange={() => undefined}
          />
        );
      });

      const controller = container.querySelector('media-controller');
      expect(controller).not.toBeNull();
      expect(controller?.hasAttribute('nohotkeys')).toBe(true);
      expect(controller?.hasAttribute('gesturesdisabled')).toBe(false);

      await act(async () => {
        root.render(
          <TestCanvasVideoPlayerAdapter
            node={videoNode()}
            initialTimeMs={0}
            contentInteractionActive
            onError={() => undefined}
            onPlayingChange={() => undefined}
          />
        );
      });
      expect(container.querySelector('media-controller')?.hasAttribute('nohotkeys')).toBe(false);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('applies each new one-shot playback toggle request once', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const play = vi.fn(async () => undefined);

    try {
      await act(async () => {
        root.render(
          <TestCanvasVideoPlayerAdapter
            node={videoNode()}
            initialTimeMs={0}
            onError={() => undefined}
            onPlayingChange={() => undefined}
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
            initialTimeMs={0}
            playbackToggleRequest={{ requestId: 1 }}
            onError={() => undefined}
            onPlayingChange={() => undefined}
          />
        );
      });
      expect(play).toHaveBeenCalledTimes(1);

      await act(async () => {
        root.render(
          <TestCanvasVideoPlayerAdapter
            node={videoNode()}
            initialTimeMs={0}
            playbackToggleRequest={{ requestId: 1 }}
            onError={() => undefined}
            onPlayingChange={() => undefined}
          />
        );
      });
      expect(play).toHaveBeenCalledTimes(1);

      await act(async () => {
        root.render(
          <TestCanvasVideoPlayerAdapter
            node={videoNode()}
            initialTimeMs={0}
            playbackToggleRequest={{ requestId: 2 }}
            onError={() => undefined}
            onPlayingChange={() => undefined}
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

  it('reports a playback error when the one-shot toggle play is rejected', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onError = vi.fn();

    try {
      await act(async () => {
        root.render(
          <TestCanvasVideoPlayerAdapter
            node={videoNode()}
            initialTimeMs={0}
            onError={onError}
            onPlayingChange={() => undefined}
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
            initialTimeMs={0}
            playbackToggleRequest={{ requestId: 1 }}
            onError={onError}
            onPlayingChange={() => undefined}
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
            initialTimeMs={0}
            onError={() => undefined}
            onPlayingChange={() => undefined}
            onReadyForDisplay={onReadyForDisplay}
          />
        );
      });
      const video = requiredVideo(container);
      Object.defineProperty(video, 'readyState', {
        configurable: true,
        value: HTMLMediaElement.HAVE_CURRENT_DATA
      });

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

  it('reports display readiness when the mounted media already has display data', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onReadyForDisplay = vi.fn();
    vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get')
      .mockReturnValue(HTMLMediaElement.HAVE_CURRENT_DATA);

    try {
      await act(async () => {
        root.render(
          <TestCanvasVideoPlayerAdapter
            node={videoNode()}
            initialTimeMs={0}
            onError={() => undefined}
            onPlayingChange={() => undefined}
            onReadyForDisplay={onReadyForDisplay}
          />
        );
      });

      expect(onReadyForDisplay).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('restores a nonzero timestamp when cached media readiness events were missed', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onReadyForDisplay = vi.fn();
    const animationFrames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get')
      .mockReturnValue(HTMLMediaElement.HAVE_CURRENT_DATA);

    try {
      await act(async () => {
        root.render(
          <TestCanvasVideoPlayerAdapter
            node={videoNode({ durationSeconds: 10 })}
            initialTimeMs={4_500}
            onError={() => undefined}
            onPlayingChange={() => undefined}
            onReadyForDisplay={onReadyForDisplay}
          />
        );
      });

      expect(requiredVideo(container).currentTime).toBe(4.5);
      expect(onReadyForDisplay).not.toHaveBeenCalled();
      expect(requestFrame).toHaveBeenCalledTimes(1);

      act(() => {
        animationFrames[0]?.(0);
      });

      expect(onReadyForDisplay).toHaveBeenCalledTimes(1);
      expect(requestFrame).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('reports display readiness from playing after an earlier readiness event was missed', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onReadyForDisplay = vi.fn();

    try {
      await act(async () => {
        root.render(
          <TestCanvasVideoPlayerAdapter
            node={videoNode()}
            initialTimeMs={0}
            onError={() => undefined}
            onPlayingChange={() => undefined}
            onReadyForDisplay={onReadyForDisplay}
          />
        );
      });
      const video = requiredVideo(container);
      Object.defineProperty(video, 'readyState', {
        configurable: true,
        value: HTMLMediaElement.HAVE_CURRENT_DATA
      });

      act(() => {
        video.dispatchEvent(new Event('playing', { bubbles: true }));
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
            initialTimeMs={4_500}
            onError={() => undefined}
            onPlayingChange={() => undefined}
            onReadyForDisplay={onReadyForDisplay}
          />
        );
      });
      const video = requiredVideo(container);
      Object.defineProperty(video, 'readyState', {
        configurable: true,
        value: HTMLMediaElement.HAVE_CURRENT_DATA
      });

      act(() => {
        video.dispatchEvent(new Event('loadedmetadata', { bubbles: true }));
      });
      expect(video.currentTime).toBe(4.5);
      expect(onReadyForDisplay).not.toHaveBeenCalled();

      video.currentTime = 2;
      act(() => {
        video.dispatchEvent(new Event('seeked', { bubbles: true }));
      });
      expect(onReadyForDisplay).not.toHaveBeenCalled();

      video.currentTime = 4.5;
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
            initialTimeMs={6_250}
            onError={onError}
            onPlayingChange={() => undefined}
            onReadyForDisplay={onReadyForDisplay}
          />
        );
      });
      const video = requiredVideo(container);
      Object.defineProperty(video, 'readyState', {
        configurable: true,
        value: HTMLMediaElement.HAVE_CURRENT_DATA
      });

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

  it('keeps pause, seek, and ended events local to the live player', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onPlayingChange = vi.fn();

    try {
      await act(async () => {
        root.render(
          <TestCanvasVideoPlayerAdapter
            node={videoNode()}
            initialTimeMs={4_500}
            onError={() => undefined}
            onPlayingChange={onPlayingChange}
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

      act(() => {
        video.dispatchEvent(new Event('seeked', { bubbles: true }));
      });
      expect(video.currentTime).toBe(6.25);

      video.currentTime = 8;
      act(() => {
        video.dispatchEvent(new Event('ended', { bubbles: true }));
      });
      expect(video.currentTime).toBe(0);
      expect(onPlayingChange).toHaveBeenLastCalledWith(false);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('keeps pauseAt on the live player without publishing persistence', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const ref = React.createRef<CanvasVideoPlayerHandle>();
    const onPlayingChange = vi.fn();

    try {
      await act(async () => {
        root.render(
          <TestCanvasVideoPlayerAdapter
            ref={ref}
            node={videoNode()}
            initialTimeMs={0}
            onError={() => undefined}
            onPlayingChange={onPlayingChange}
          />
        );
      });
      const video = requiredVideo(container);
      const pause = vi.fn();
      Object.defineProperty(video, 'pause', { configurable: true, value: pause });

      act(() => {
        ref.current?.pauseAt(6.25);
      });

      expect(pause).toHaveBeenCalledTimes(1);
      expect(video.currentTime).toBe(6.25);
      expect(onPlayingChange).toHaveBeenLastCalledWith(false);
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
            initialTimeMs={6_250}
            onError={onError}
            onPlayingChange={() => undefined}
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
            initialTimeMs={4_500}
            onError={onError}
            onPlayingChange={() => undefined}
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

function requiredVideo(container: HTMLElement): HTMLVideoElement {
  const video = container.querySelector('video');
  if (!video) {
    throw new Error('Expected video element.');
  }
  return video;
}

function videoNode(options: { durationSeconds?: number } = {}): ProjectedCanvasNode {
  const videoMetadata = {
    width: 640,
    height: 360
  };
  if (options.durationSeconds !== undefined) {
    Object.assign(videoMetadata, { durationSeconds: options.durationSeconds });
  }
  return {
    projectRelativePath: 'media/clip.mp4',
    displayName: 'clip.mp4',
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
      fileUrl: '/api/workbench/bindings/p/files/raw/media/clip.mp4?v=rev',
      revision: 'rev'
    },
    videoMetadata,
    videoTextTracks: []
  };
}
