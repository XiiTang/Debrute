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
            onPointerInside={() => undefined}
            onFocusInside={() => undefined}
            onError={() => undefined}
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
});

function textTrack(kind: TextTrack['kind']): { kind: TextTrack['kind']; mode: TextTrack['mode'] } {
  return {
    kind,
    mode: 'disabled'
  };
}

function videoNode(): ProjectedCanvasNode {
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
    videoPresentation: {
      kind: 'video',
      textTracks: []
    }
  };
}
