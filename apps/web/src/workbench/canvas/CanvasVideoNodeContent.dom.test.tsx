import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  canvasPreviewContinuityKey,
  canvasPreviewTargetIdentityFromDigest,
  type CanvasFeedbackEntry,
  type ProjectedCanvasNode
} from '@debrute/canvas-core';
import { CanvasVideoNodeContent, canvasVideoFrameContentBox } from './CanvasVideoNodeContent';
import type { CanvasRasterPreviewRequest } from './CanvasRasterPreviewPresentation';
import { I18nProvider } from '../i18n';

const runtimeMocks = vi.hoisted(() => ({ retryPreview: vi.fn() }));

vi.mock('./CanvasVideoPreviewRuntime.js', () => ({
  useCanvasVideoPreviewRuntime: () => runtimeMocks
}));

vi.mock('./CanvasRasterPreviewPresentation.js', () => ({
  useCanvasRasterPreviewPresentation: ({
    request,
    hidden,
    sourceFailure,
    onPointerDown
  }: {
    request: CanvasRasterPreviewRequest;
    hidden?: boolean;
    sourceFailure?: { error: unknown; retry?: () => void };
    onPointerDown?: React.PointerEventHandler<HTMLImageElement>;
  }) => {
    const target = request.variantTarget;
    const src = target?.srcForWidth(640);
    return {
      layers: (
        <div
          className="canvas-raster-preview-layers"
          data-canvas-raster-preview-hidden={hidden ? 'true' : 'false'}
        >
          {src ? (
            <img
              className="canvas-raster-preview-image"
              src={src}
              alt=""
              data-canvas-raster-preview-layer="visible"
              onPointerDown={onPointerDown}
            />
          ) : null}
        </div>
      ),
      status: src ? 'visible' : sourceFailure ? 'failed' : 'empty',
      hasVisible: src !== undefined,
      failure: sourceFailure,
      retry: () => sourceFailure?.retry?.()
    };
  }
}));

vi.mock('./CanvasVideoPlayerAdapter', () => ({
  CanvasVideoPlayerAdapter: React.forwardRef(function MockCanvasVideoPlayerAdapter(
    {
      node,
      initialTimeMs,
      onPointerInside,
      onFocusInside,
      onError,
      onPlayingChange,
      onPlaybackBoundary,
      onReadyForDisplay,
      playRequest,
      formatPlayError
    }: {
      node: ProjectedCanvasNode;
      initialTimeMs: number;
      onPointerInside: () => void;
      onFocusInside: () => void;
      onError: (message: string) => void;
      onPlayingChange: (playing: boolean) => void;
      onPlaybackBoundary: (currentTimeMs: number) => void;
      onReadyForDisplay: () => void;
      playRequest?: { requestId: number } | undefined;
      formatPlayError: (projectRelativePath: string) => string;
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
        data-initial-time={initialTimeMs}
        data-play-request-id={playRequest?.requestId}
        onPointerDown={onPointerInside}
        onFocus={onFocusInside}
      >
        <video src={node.availability.state === 'available' ? node.availability.fileUrl : undefined} />
        <button type="button" data-testid="mock-video-error" onClick={() => onError(formatPlayError(node.projectRelativePath))}>
          trigger error
        </button>
        <button type="button" data-testid="mock-video-ready" onClick={onReadyForDisplay}>
          ready
        </button>
        <button type="button" data-testid="mock-video-playing" onClick={() => onPlayingChange(true)}>
          playing
        </button>
        <button
          type="button"
          data-testid="mock-video-paused"
          onClick={() => {
            onPlayingChange(false);
            onPlaybackBoundary(4_250);
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
  runtimeMocks.retryPreview.mockReset();
});

describe('CanvasVideoNodeContent', { tags: ['canvas-video'] }, () => {
  it('computes the video frame content box inside horizontal or vertical letterboxing', () => {
    expect(canvasVideoFrameContentBox({
      shell: { width: 640, height: 300 },
      frame: { width: 640, height: 360 }
    })).toEqual({
      left: 53.33333333333337,
      top: 0,
      width: 533.3333333333333,
      height: 300
    });
    expect(canvasVideoFrameContentBox({
      shell: { width: 640, height: 500 },
      frame: { width: 640, height: 360 }
    })).toEqual({
      left: 0,
      top: 70,
      width: 640,
      height: 360
    });
  });

  it('sizes the feedback content box from unscaled layout dimensions', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const restoreLayoutMeasurement = installVideoShellLayoutMeasurement({
      layoutWidth: 640,
      layoutHeight: 360,
      screenWidth: 64,
      screenHeight: 36
    });

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

      const feedbackContent = container.querySelector<HTMLElement>('.canvas-video-feedback-content');
      expect(feedbackContent?.style.width).toBe('640px');
      expect(feedbackContent?.style.height).toBe('360px');
    } finally {
      restoreLayoutMeasurement();
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('renders the video title bar before the player shell', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <CanvasVideoNodeContent
          node={videoNode()}
          selected={false}
          videoPreviewRequest={previewSource()}
          onSelectNode={() => undefined}
          onRegisterVideoTarget={() => undefined}
          onUpdatePlaybackTime={() => undefined}
        />
      </I18nProvider>
    );

    expect(html.indexOf('db-canvas-node-titlebar')).toBeLessThan(html.indexOf('canvas-video-player-shell'));
  });

  it('mounts the real player with the persisted timestamp when selected', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <CanvasVideoNodeContent
          node={videoNode({ currentTimeMs: 4_500 })}
          selected
          videoPreviewRequest={previewSource()}
          onSelectNode={() => undefined}
          onRegisterVideoTarget={() => undefined}
          onUpdatePlaybackTime={() => undefined}
        />
      </I18nProvider>
    );

    expect(html).toContain('data-testid="video-player-adapter"');
    expect(html).toContain('data-initial-time="4500"');
    expect(html).toContain('data-canvas-raster-preview-hidden="true"');
  });

  it('surfaces video preview errors without mounting the player', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <CanvasVideoNodeContent
          node={videoNode()}
          selected={false}
          videoPreviewError="preview frame is unavailable"
          onSelectNode={() => undefined}
          onRegisterVideoTarget={() => undefined}
          onUpdatePlaybackTime={() => undefined}
        />
      </I18nProvider>
    );

    expect(html).toContain('preview frame is unavailable');
    expect(html).toContain('db-canvas-node-error-overlay');
    expect(html).toContain('canvas-node-error-presentation');
    expect(html).toContain('Retry');
    expect(html).not.toContain('data-testid="video-player-adapter"');
  });

  it('passes a one-shot play request when the inactive preview click mounts the player', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onSelectNode = vi.fn();

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode()}
              selected={false}
              videoPreviewRequest={previewSource()}
              onSelectNode={onSelectNode}
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={() => undefined}
            />
          </I18nProvider>
        );
      });

      await act(async () => {
        container.querySelector<HTMLImageElement>('img.canvas-raster-preview-image')?.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true
        }));
      });

      expect(onSelectNode).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[data-testid="video-player-adapter"]')?.getAttribute('data-play-request-id')).toBe('1');
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('keeps the preview visible until the player is ready for display', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode()}
              selected={false}
              videoPreviewRequest={previewSource()}
              onSelectNode={() => undefined}
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={() => undefined}
            />
          </I18nProvider>
        );
      });

      await act(async () => {
        container.querySelector<HTMLImageElement>('img.canvas-raster-preview-image')?.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true
        }));
      });
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode()}
              selected
              videoPreviewRequest={previewSource()}
              onSelectNode={() => undefined}
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={() => undefined}
            />
          </I18nProvider>
        );
      });

      expect(videoPreviewIsVisible(container)).toBe(true);
      expect(container.querySelector('[data-testid="video-player-adapter"]')).not.toBeNull();

      await act(async () => {
        button(container, 'mock-video-ready').click();
      });

      expect(videoPreviewIsVisible(container)).toBe(false);
      expect(container.querySelector('[data-testid="video-player-adapter"]')).not.toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('unloads the pending player when preview-to-player handoff is cancelled before display readiness', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode()}
              selected={false}
              videoPreviewRequest={previewSource()}
              onSelectNode={() => undefined}
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={() => undefined}
            />
          </I18nProvider>
        );
      });

      await act(async () => {
        container.querySelector<HTMLImageElement>('img.canvas-raster-preview-image')?.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true
        }));
      });
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode()}
              selected
              videoPreviewRequest={previewSource()}
              onSelectNode={() => undefined}
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={() => undefined}
            />
          </I18nProvider>
        );
      });

      expect(videoPreviewIsVisible(container)).toBe(true);
      expect(container.querySelector('[data-testid="video-player-adapter"]')).not.toBeNull();

      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode()}
              selected={false}
              videoPreviewRequest={previewSource()}
              onSelectNode={() => undefined}
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={() => undefined}
            />
          </I18nProvider>
        );
      });

      expect(videoPreviewIsVisible(container)).toBe(true);
      expect(container.querySelector('[data-testid="video-player-adapter"]')).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('keeps the preview visible when the pending player reports an error', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode()}
              selected={false}
              videoPreviewRequest={previewSource()}
              onSelectNode={() => undefined}
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={() => undefined}
            />
          </I18nProvider>
        );
      });

      await act(async () => {
        container.querySelector<HTMLImageElement>('img.canvas-raster-preview-image')?.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true
        }));
      });
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode()}
              selected
              videoPreviewRequest={previewSource()}
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

      expect(videoPreviewIsVisible(container)).toBe(true);
      expect(container.textContent).toContain('Unable to play media/clip.mp4.');
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('resets pending handoff state when the projected video source changes', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode({ revision: 'rev-a' })}
              selected={false}
              videoPreviewRequest={previewSource()}
              onSelectNode={() => undefined}
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={() => undefined}
            />
          </I18nProvider>
        );
      });

      await act(async () => {
        container.querySelector<HTMLImageElement>('img.canvas-raster-preview-image')?.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true
        }));
      });
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode({ revision: 'rev-a' })}
              selected
              videoPreviewRequest={previewSource()}
              onSelectNode={() => undefined}
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={() => undefined}
            />
          </I18nProvider>
        );
      });

      expect(videoPreviewIsVisible(container)).toBe(true);

      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode({ revision: 'rev-b' })}
              selected
              videoPreviewRequest={previewSource()}
              onSelectNode={() => undefined}
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={() => undefined}
            />
          </I18nProvider>
        );
      });

      expect(videoPreviewIsVisible(container)).toBe(false);
      expect(container.querySelector('video')?.getAttribute('src')).toContain('v=rev-b');
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('keeps the Canvas title bar when a video file is unavailable', () => {
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
    expect(html).toContain('db-canvas-node-titlebar');
    expect(html).toContain('clip.mp4');
  });

  it('throws when an available video node is missing projected video presentation', () => {
    const { videoPresentation: _videoPresentation, ...node } = videoNode();

    expect(() => renderToStaticMarkup(
      <I18nProvider locale="en">
        <CanvasVideoNodeContent
          node={node}
          selected={false}
          videoPreviewRequest={previewSource()}
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

  it('persists the pause boundary and unloads the player after the inactive preview is ready', async () => {
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
        button(container, 'mock-video-ready').click();
      });

      await act(async () => {
        button(container, 'mock-video-paused').click();
      });
      expect(onUpdatePlaybackTime).toHaveBeenLastCalledWith('media/clip.mp4', 4_250);
      expect(container.querySelector('[data-testid="video-player-adapter"]')).not.toBeNull();

      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode({ currentTimeMs: 4_250 })}
              selected={false}
              videoPreviewRequest={previewSource()}
              onSelectNode={() => undefined}
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={onUpdatePlaybackTime}
            />
          </I18nProvider>
        );
      });

      expect(container.querySelector('[data-testid="video-player-adapter"]')).toBeNull();
      expect(videoPreviewIsVisible(container)).toBe(true);
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
              node={videoNode({ currentTimeMs: 4_250 })}
              selected
              videoPreviewRequest={previewSource()}
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
      expect(videoPreviewIsVisible(container)).toBe(false);
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
              videoPreviewRequest={previewSource()}
              onSelectNode={() => undefined}
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={() => undefined}
            />
          </I18nProvider>
        );
      });

      expect(container.querySelector('[data-testid="video-player-adapter"]')).not.toBeNull();
      expect(videoPreviewIsVisible(container)).toBe(false);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('hides saved moment spatial overlays while the video is playing', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode({ currentTimeMs: 4_250 })}
              selected
              feedbackEntry={videoFeedbackEntry()}
              onSelectNode={() => undefined}
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={() => undefined}
            />
          </I18nProvider>
        );
      });

      expect(container.querySelector('[data-canvas-feedback-label="1"]')).not.toBeNull();

      await act(async () => {
        button(container, 'mock-video-playing').click();
      });

      expect(container.querySelector('[data-canvas-feedback-label="1"]')).toBeNull();
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
  currentTimeMs?: number;
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
      fileUrl: `/api/projects/p/files/raw/media/clip.mp4?v=${revision}`,
      revision
    },
    videoPresentation: {
      kind: 'video',
      width: 640,
      height: 360,
      durationSeconds: 5,
      textTracks: [{
        projectRelativePath: 'media/clip.en.vtt',
        fileUrl: '/api/projects/p/files/raw/media/clip.en.vtt?v=track-rev',
        revision: 'track-rev',
        kind: 'subtitles',
        label: 'English',
        srclang: 'en',
        default: true
      }]
    }
  };
  return options.currentTimeMs === undefined
    ? node
    : { ...node, videoPlayback: { currentTimeMs: options.currentTimeMs } };
}

function previewSource(): CanvasRasterPreviewRequest {
  const targetIdentity = canvasPreviewTargetIdentityFromDigest('sha256:test-preview');
  return {
    continuityKey: canvasPreviewContinuityKey({
      mediaKind: 'video',
      projectId: 'p',
      canvasId: 'canvas-1',
      projectRelativePath: 'media/clip.mp4',
      continuityIdentity: targetIdentity
    }),
    variantTarget: {
      mediaKind: 'video',
      projectId: 'p',
      canvasId: 'canvas-1',
      projectRelativePath: 'media/clip.mp4',
      targetIdentity,
      sourceWidth: 640,
      srcForWidth: (width) => `http://127.0.0.1:17321/api/projects/p/canvas-video-preview/preview.jpg?path=media%2Fclip.mp4&w=${width}&sourceKey=test-preview`
    }
  };
}

function videoFeedbackEntry(): CanvasFeedbackEntry {
  return {
    projectRelativePath: 'media/clip.mp4',
    marks: [],
    nextMomentLabel: 2,
    nextSpatialLabel: 2,
    items: [{
      id: 'item-pin',
      kind: 'pin',
      scope: 'moment',
      label: 1,
      geometry: { type: 'point', x: 0.25, y: 0.5 },
      moment: { label: 'M1', currentTimeSeconds: 4.25 },
      comment: 'look here',
      createdAt: '2026-06-21T12:00:00.000Z',
      updatedAt: '2026-06-21T12:00:00.000Z'
    }],
    updatedAt: '2026-06-21T12:00:00.000Z'
  };
}

function button(container: HTMLElement, testId: string): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!element) {
    throw new Error(`Missing button: ${testId}`);
  }
  return element;
}

function videoPreviewIsVisible(container: ParentNode): boolean {
  const layers = container.querySelector('.canvas-raster-preview-layers');
  return layers?.getAttribute('data-canvas-raster-preview-hidden') === 'false'
    && layers.querySelector('.canvas-raster-preview-image') !== null;
}

function installVideoShellLayoutMeasurement(input: {
  layoutWidth: number;
  layoutHeight: number;
  screenWidth: number;
  screenHeight: number;
}): () => void {
  const clientWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  const clientHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  const getBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;

  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return (this as HTMLElement).classList.contains('canvas-video-player-shell') ? input.layoutWidth : 0;
    }
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return (this as HTMLElement).classList.contains('canvas-video-player-shell') ? input.layoutHeight : 0;
    }
  });
  HTMLElement.prototype.getBoundingClientRect = function getMockBoundingClientRect() {
    if (this.classList.contains('canvas-video-player-shell')) {
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: input.screenWidth,
        bottom: input.screenHeight,
        width: input.screenWidth,
        height: input.screenHeight,
        toJSON: () => undefined
      };
    }
    return getBoundingClientRect.call(this);
  };

  return () => {
    restorePropertyDescriptor(HTMLElement.prototype, 'clientWidth', clientWidthDescriptor);
    restorePropertyDescriptor(HTMLElement.prototype, 'clientHeight', clientHeightDescriptor);
    HTMLElement.prototype.getBoundingClientRect = getBoundingClientRect;
  };
}

function restorePropertyDescriptor(
  target: object,
  property: string,
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor) {
    Object.defineProperty(target, property, descriptor);
  } else {
    delete (target as Record<string, unknown>)[property];
  }
}
