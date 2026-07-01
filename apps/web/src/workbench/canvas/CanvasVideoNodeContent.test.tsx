// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import { CanvasVideoNodeContent } from './CanvasVideoNodeContent';
import type { CanvasVideoPreviewSource } from './canvasVideoPreviews';
import { I18nProvider } from '../i18n';

vi.mock('./CanvasVideoPlayerAdapter', () => ({
  CanvasVideoPlayerAdapter: React.forwardRef(function MockCanvasVideoPlayerAdapter(
    {
      node,
      initialTimeSeconds,
      onPointerInside,
      onFocusInside,
      onError,
      onPlayingChange,
      onPlaybackBoundary
    }: {
      node: ProjectedCanvasNode;
      initialTimeSeconds: number;
      onPointerInside: () => void;
      onFocusInside: () => void;
      onError: (message: string) => void;
      onPlayingChange: (playing: boolean) => void;
      onPlaybackBoundary: (currentTimeSeconds: number) => void;
    },
    ref: React.ForwardedRef<unknown>
  ) {
    React.useImperativeHandle(ref, () => ({
      togglePlayback: vi.fn(),
      seekBy: vi.fn(),
      toggleMuted: vi.fn(),
      adjustPlaybackRate: vi.fn(),
      toggleCaptions: vi.fn(),
      enterFullscreen: vi.fn(),
      togglePictureInPicture: vi.fn()
    }), []);
    return (
      <div
        data-testid="video-player-adapter"
        data-path={node.projectRelativePath}
        data-initial-time={initialTimeSeconds}
        onPointerDown={onPointerInside}
        onFocus={onFocusInside}
      >
        <video src={node.availability.state === 'available' ? node.availability.fileUrl : undefined} />
        <button type="button" data-testid="mock-video-error" onClick={() => onError(`Unable to play ${node.projectRelativePath}.`)}>
          trigger error
        </button>
        <button type="button" data-testid="mock-video-playing" onClick={() => onPlayingChange(true)}>
          playing
        </button>
        <button
          type="button"
          data-testid="mock-video-paused"
          onClick={() => {
            onPlayingChange(false);
            onPlaybackBoundary(4.25);
          }}
        >
          paused
        </button>
        <button
          type="button"
          data-testid="mock-video-ended"
          onClick={() => {
            onPlayingChange(false);
            onPlaybackBoundary(0);
          }}
        >
          ended
        </button>
      </div>
    );
  })
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CanvasVideoNodeContent', () => {
  it('renders the cached video preview while the video is inactive', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <CanvasVideoNodeContent
          node={videoNode()}
          selected={false}
          videoPreview={previewSource()}
          onSelectNode={() => undefined}
          onRegisterVideoTarget={() => undefined}
          onUpdatePlaybackTime={() => undefined}
        />
      </I18nProvider>
    );

    expect(html).toContain('class="canvas-video-preview-image"');
    expect(html).toContain('preview.jpg');
    expect(html).toContain('db-canvas-node-caption');
    expect(html).not.toContain('data-testid="video-player-adapter"');
  });

  it('mounts the real player with the persisted timestamp when selected', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <CanvasVideoNodeContent
          node={videoNode({ currentTimeSeconds: 4.5 })}
          selected
          videoPreview={previewSource()}
          onSelectNode={() => undefined}
          onRegisterVideoTarget={() => undefined}
          onUpdatePlaybackTime={() => undefined}
        />
      </I18nProvider>
    );

    expect(html).toContain('data-testid="video-player-adapter"');
    expect(html).toContain('data-initial-time="4.5"');
    expect(html).not.toContain('class="canvas-video-preview-image"');
  });

  it('surfaces video preview errors without mounting the player', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <CanvasVideoNodeContent
          node={videoNode()}
          selected={false}
          videoPreviewError="poster is broken"
          onSelectNode={() => undefined}
          onRegisterVideoTarget={() => undefined}
          onUpdatePlaybackTime={() => undefined}
        />
      </I18nProvider>
    );

    expect(html).toContain('poster is broken');
    expect(html).toContain('db-canvas-node-error-overlay');
    expect(html).not.toContain('data-testid="video-player-adapter"');
  });

  it('reports inactive preview image load failures without mounting the player', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const preview = previewSource();
    const onVideoPreviewError = vi.fn();

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode()}
              selected={false}
              videoPreview={preview}
              onSelectNode={() => undefined}
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={() => undefined}
              onVideoPreviewError={onVideoPreviewError}
            />
          </I18nProvider>
        );
      });

      await act(async () => {
        container.querySelector<HTMLImageElement>('img.canvas-video-preview-image')?.dispatchEvent(new Event('error', { bubbles: false }));
      });

      expect(onVideoPreviewError).toHaveBeenCalledWith(
        'media/clip.mp4',
        preview,
        'Unable to load video preview variant for media/clip.mp4.'
      );
      expect(container.querySelector('[data-testid="video-player-adapter"]')).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('keeps the Canvas caption when a video file is unavailable', () => {
    const { videoPresentation: _videoPresentation, ...node } = videoNode();

    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <CanvasVideoNodeContent
          node={{
            ...node,
            availability: {
              state: 'missing',
              message: 'File is missing.'
            }
          }}
          selected={false}
          onSelectNode={() => undefined}
          onRegisterVideoTarget={() => undefined}
          onUpdatePlaybackTime={() => undefined}
        />
      </I18nProvider>
    );

    expect(html).toContain('db-canvas-node-placeholder');
    expect(html).toContain('db-canvas-node-caption');
    expect(html).toContain('clip.mp4');
  });

  it('throws when an available video node is missing projected video presentation', () => {
    const { videoPresentation: _videoPresentation, ...node } = videoNode();

    expect(() => renderToStaticMarkup(
      <I18nProvider locale="en">
        <CanvasVideoNodeContent
          node={node}
          selected={false}
          videoPreview={previewSource()}
          onSelectNode={() => undefined}
          onRegisterVideoTarget={() => undefined}
          onUpdatePlaybackTime={() => undefined}
        />
      </I18nProvider>
    )).toThrow('Projected video node is missing videoPresentation: media/clip.mp4');
  });

  it('clears playback errors when the projected video source changes', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode({ revision: 'rev-a' })}
              selected
              onSelectNode={() => undefined}
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={() => undefined}
            />
          </I18nProvider>
        );
      });
      await act(async () => {
        button(container, 'mock-video-error').click();
      });
      expect(container.textContent).toContain('Unable to play media/clip.mp4.');

      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode({ revision: 'rev-b' })}
              selected
              onSelectNode={() => undefined}
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={() => undefined}
            />
          </I18nProvider>
        );
      });

      expect(container.querySelector('video')?.getAttribute('src')).toContain('v=rev-b');
      expect(container.textContent).not.toContain('Unable to play media/clip.mp4.');
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('persists the pause boundary and unloads the player after losing selection', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onUpdatePlaybackTime = vi.fn();

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode()}
              selected
              onSelectNode={() => undefined}
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={onUpdatePlaybackTime}
            />
          </I18nProvider>
        );
      });

      await act(async () => {
        button(container, 'mock-video-paused').click();
      });
      expect(onUpdatePlaybackTime).toHaveBeenLastCalledWith('media/clip.mp4', 4.25);
      expect(container.querySelector('[data-testid="video-player-adapter"]')).not.toBeNull();

      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode({ currentTimeSeconds: 4.25 })}
              selected={false}
              videoPreview={previewSource()}
              onSelectNode={() => undefined}
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={onUpdatePlaybackTime}
            />
          </I18nProvider>
        );
      });

      expect(container.querySelector('[data-testid="video-player-adapter"]')).toBeNull();
      expect(container.querySelector('img.canvas-video-preview-image')).not.toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('keeps the player mounted after ended playback while selected', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onUpdatePlaybackTime = vi.fn();

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode({ currentTimeSeconds: 4.25 })}
              selected
              videoPreview={previewSource()}
              onSelectNode={() => undefined}
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={onUpdatePlaybackTime}
            />
          </I18nProvider>
        );
      });

      await act(async () => {
        button(container, 'mock-video-ended').click();
      });

      expect(onUpdatePlaybackTime).toHaveBeenLastCalledWith('media/clip.mp4', 0);
      expect(container.querySelector('[data-testid="video-player-adapter"]')).not.toBeNull();
      expect(container.querySelector('img.canvas-video-preview-image')).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('keeps a playing video mounted after losing selection', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode()}
              selected
              onSelectNode={() => undefined}
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={() => undefined}
            />
          </I18nProvider>
        );
      });
      await act(async () => {
        button(container, 'mock-video-playing').click();
      });

      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode()}
              selected={false}
              videoPreview={previewSource()}
              onSelectNode={() => undefined}
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={() => undefined}
            />
          </I18nProvider>
        );
      });

      expect(container.querySelector('[data-testid="video-player-adapter"]')).not.toBeNull();
      expect(container.querySelector('img.canvas-video-preview-image')).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('reports playback stopped when the video source changes', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onPlayingChange = vi.fn();

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode({ revision: 'rev-a' })}
              selected
              onSelectNode={() => undefined}
              onPlayingChange={onPlayingChange}
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={() => undefined}
            />
          </I18nProvider>
        );
      });
      await act(async () => {
        button(container, 'mock-video-playing').click();
      });
      expect(onPlayingChange).toHaveBeenLastCalledWith('media/clip.mp4', true);

      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode({ revision: 'rev-b' })}
              selected
              onSelectNode={() => undefined}
              onPlayingChange={onPlayingChange}
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={() => undefined}
            />
          </I18nProvider>
        );
      });

      expect(onPlayingChange).toHaveBeenLastCalledWith('media/clip.mp4', false);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });
});

function videoNode(options: {
  revision?: string;
  currentTimeSeconds?: number;
} = {}): ProjectedCanvasNode {
  const revision = options.revision ?? 'rev';
  const node: ProjectedCanvasNode = {
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
      fileUrl: `http://127.0.0.1:17321/api/projects/p/files/raw/media/clip.mp4?v=${revision}`,
      revision
    },
    videoPresentation: {
      kind: 'video',
      durationSeconds: 5,
      textTracks: [{
        projectRelativePath: 'media/clip.en.vtt',
        fileUrl: 'http://127.0.0.1:17321/api/projects/p/files/raw/media/clip.en.vtt?v=track-rev',
        revision: 'track-rev',
        kind: 'subtitles',
        label: 'English',
        srclang: 'en',
        default: true
      }]
    }
  };
  return options.currentTimeSeconds === undefined
    ? node
    : { ...node, videoPlayback: { currentTimeSeconds: options.currentTimeSeconds } };
}

function previewSource(): CanvasVideoPreviewSource {
  return {
    src: 'http://127.0.0.1:17321/api/projects/p/canvas-video-preview/preview.jpg?path=media%2Fclip.mp4&w=640&sourceKey=test-preview',
    previewWidth: 640
  };
}

function button(container: HTMLElement, testId: string): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!element) {
    throw new Error(`Missing button: ${testId}`);
  }
  return element;
}
