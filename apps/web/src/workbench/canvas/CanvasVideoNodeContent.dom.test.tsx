import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  canvasPreviewContinuityKey,
  canvasPreviewTargetIdentityFromDigest
} from '@debrute/canvas-core';
import type { CanvasFeedbackEntry } from '@debrute/app-protocol';
import type { ProjectedCanvasNode } from './CanvasScene';
import {
  CanvasVideoNodeContent as CanvasVideoNodeContentImplementation,
  canvasVideoFrameContentBox,
  type CanvasVideoNodeContentProps
} from './CanvasVideoNodeContent';
import type { CanvasRasterPreviewRequest } from './CanvasRasterPreviewPresentation';
import { I18nProvider } from '../i18n';

const runtimeMocks = vi.hoisted(() => ({ retryPreview: vi.fn() }));

vi.mock('./CanvasVideoPreviewRuntime', () => ({
  useCanvasVideoPreviewRuntime: () => runtimeMocks
}));

vi.mock('./CanvasRasterPreviewPresentation', () => ({
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
      onError,
      onPlayingChange,
      onPlaybackBoundary,
      onReadyForDisplay,
      playbackToggleRequest,
      contentInteractionActive,
      formatPlayError
    }: {
      node: ProjectedCanvasNode;
      initialTimeMs: number;
      onError: (message: string) => void;
      onPlayingChange: (playing: boolean) => void;
      onPlaybackBoundary: (currentTimeMs: number) => void;
      onReadyForDisplay: () => void;
      playbackToggleRequest?: { requestId: number } | undefined;
      contentInteractionActive?: boolean | undefined;
      formatPlayError: (projectRelativePath: string) => string;
    },
    ref: React.ForwardedRef<unknown>
  ) {
    React.useImperativeHandle(ref, () => ({
      readCurrentTimeSeconds: vi.fn(),
      pauseAt: vi.fn(),
      restorePersistedTime: vi.fn()
    }), []);
    return (
      <div
        data-testid="video-player-adapter"
        data-path={node.projectRelativePath}
        data-initial-time={initialTimeMs}
        data-playback-toggle-request-id={playbackToggleRequest?.requestId}
        data-content-active={contentInteractionActive ? 'true' : 'false'}
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

function CanvasVideoNodeContent(
  props: Omit<CanvasVideoNodeContentProps, 'onContentError'> & {
    onContentError?: CanvasVideoNodeContentProps['onContentError'] | undefined;
  }
): React.ReactElement {
  return (
    <CanvasVideoNodeContentImplementation
      {...props}
      onContentError={props.onContentError ?? (() => undefined)}
    />
  );
}

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
              contentInteractionActive
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
          contentInteractionActive={false}
          videoPreviewRequest={previewSource()}
          onRegisterVideoTarget={() => undefined}
          onUpdatePlaybackTime={() => undefined}
        />
      </I18nProvider>
    );

    expect(html.indexOf('db-canvas-node-titlebar')).toBeLessThan(html.indexOf('canvas-video-player-shell'));
  });

  it('mounts the real player with the persisted timestamp when content-active', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <CanvasVideoNodeContent
          node={videoNode({ currentTimeMs: 4_500 })}
          contentInteractionActive
          videoPreviewRequest={previewSource()}
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
          contentInteractionActive={false}
          videoPreviewError="preview frame is unavailable"
          onRegisterVideoTarget={() => undefined}
          onUpdatePlaybackTime={() => undefined}
        />
      </I18nProvider>
    );

    expect(html).toContain('preview frame is unavailable');
    expect(html).toContain('canvas-content-error');
    expect(html).toContain('Click to retry');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('data-testid="video-player-adapter"');
  });

  it('passes one playback-toggle request when pointerup activates the inactive Content Region', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onContentHandoffConsumed = vi.fn();
    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode()}
              contentInteractionActive={false}
              videoPreviewRequest={previewSource()}
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={() => undefined}
            />
          </I18nProvider>
        );
      });

      expect(container.querySelector('[data-testid="video-player-adapter"]')).toBeNull();
      expect(container.querySelector('.canvas-video-player-shell')?.getAttribute('data-canvas-node-zone')).toBe('content');

      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode()}
              contentInteractionActive
              videoPreviewRequest={previewSource()}
              contentHandoffRequest={{
                requestId: 17,
                projectRelativePath: 'media/clip.mp4',
                kind: 'video-toggle'
              }}
              onContentHandoffConsumed={onContentHandoffConsumed}
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={() => undefined}
            />
          </I18nProvider>
        );
      });

      expect(container.querySelector('[data-testid="video-player-adapter"]')?.getAttribute('data-playback-toggle-request-id')).toBe('17');
      expect(container.querySelector('[data-testid="video-player-adapter"]')?.getAttribute('data-content-active')).toBe('true');
      expect(container.querySelector('.canvas-video-player-shell')?.getAttribute('data-canvas-node-zone')).toBe('content');
      expect(onContentHandoffConsumed).toHaveBeenCalledOnce();
      expect(onContentHandoffConsumed).toHaveBeenCalledWith(17);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('retries a failed preview while mounting one playback-toggle request from the new click', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode()}
              contentInteractionActive={false}
              videoPreviewError="preview frame is unavailable"
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={() => undefined}
            />
          </I18nProvider>
        );
      });

      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode()}
              contentInteractionActive
              videoPreviewError="preview frame is unavailable"
              contentHandoffRequest={{
                kind: 'video-toggle',
                requestId: 18,
                projectRelativePath: 'media/clip.mp4'
              }}
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={() => undefined}
            />
          </I18nProvider>
        );
      });

      expect(runtimeMocks.retryPreview).toHaveBeenCalledOnce();
      expect(runtimeMocks.retryPreview).toHaveBeenCalledWith('media/clip.mp4');
      expect(container.querySelector('[data-testid="video-player-adapter"]')?.getAttribute(
        'data-playback-toggle-request-id'
      )).toBe('18');
    } finally {
      await act(async () => root.unmount());
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
              contentInteractionActive={false}
              videoPreviewRequest={previewSource()}
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
              contentInteractionActive
              videoPreviewRequest={previewSource()}
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
              contentInteractionActive={false}
              videoPreviewRequest={previewSource()}
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
              contentInteractionActive
              videoPreviewRequest={previewSource()}
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
              contentInteractionActive={false}
              videoPreviewRequest={previewSource()}
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

  it('discards the failed player and replaces the whole Content Region with the retry surface', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onContentError = vi.fn();

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode()}
              contentInteractionActive={false}
              videoPreviewRequest={previewSource()}
              onContentError={onContentError}
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
              contentInteractionActive
              videoPreviewRequest={previewSource()}
              onContentError={onContentError}
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={() => undefined}
            />
          </I18nProvider>
        );
      });
      await act(async () => {
        button(container, 'mock-video-error').click();
      });

      expect(videoPreviewIsVisible(container)).toBe(false);
      expect(container.querySelector('[data-testid="video-player-adapter"]')).toBeNull();
      expect(container.querySelector('.canvas-content-error')).not.toBeNull();
      expect(container.textContent).toContain('Unable to play media/clip.mp4.');
      expect(container.textContent).toContain('Click to retry');
      expect(onContentError).toHaveBeenCalledWith('media/clip.mp4');
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
              contentInteractionActive={false}
              videoPreviewRequest={previewSource()}
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
              contentInteractionActive
              videoPreviewRequest={previewSource()}
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
              contentInteractionActive
              videoPreviewRequest={previewSource()}
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
    const node = videoNode();

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
          contentInteractionActive={false}
          onRegisterVideoTarget={() => undefined}
          onUpdatePlaybackTime={() => undefined}
        />
      </I18nProvider>
    );

    expect(html).toContain('canvas-content-error');
    expect(html).toContain('Click to retry');
    expect(html).not.toContain('<button');
    expect(html).toContain('db-canvas-node-titlebar');
    expect(html).toContain('clip.mp4');
  });

  it('can start decoding an available video before browser metadata is known', () => {
    const { videoMetadata: _videoMetadata, ...node } = videoNode();

    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <CanvasVideoNodeContent
          node={node}
          contentInteractionActive={false}
          videoPreviewRequest={previewSource()}
          onRegisterVideoTarget={() => undefined}
          onUpdatePlaybackTime={() => undefined}
        />
      </I18nProvider>
    );
    expect(html).toContain('canvas-video-node');
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
              contentInteractionActive
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
              contentInteractionActive
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
              contentInteractionActive
              videoPreviewRequest={previewSource()}
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
              node={videoNode()}
              contentInteractionActive={false}
              videoPreviewRequest={previewSource()}
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={onUpdatePlaybackTime}
            />
          </I18nProvider>
        );
      });

      expect(container.querySelector('[data-testid="video-player-adapter"]')).not.toBeNull();

      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode({ currentTimeMs: 4_250 })}
              contentInteractionActive={false}
              videoPreviewRequest={previewSource()}
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

  it('keeps the player mounted after ended playback while content-active', async () => {
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
              contentInteractionActive
              videoPreviewRequest={previewSource()}
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

  it('keeps a playing video mounted and locally operable after Content Activation ends', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasVideoNodeContent
              node={videoNode()}
              contentInteractionActive
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
              contentInteractionActive={false}
              videoPreviewRequest={previewSource()}
              onRegisterVideoTarget={() => undefined}
              onUpdatePlaybackTime={() => undefined}
            />
          </I18nProvider>
        );
      });

      expect(container.querySelector('[data-testid="video-player-adapter"]')).not.toBeNull();
      expect(videoPreviewIsVisible(container)).toBe(false);
      const playerLayer = container.querySelector('[data-canvas-video-layer="player"]');
      expect(playerLayer?.hasAttribute('inert')).toBe(false);
      expect(container.querySelector('.canvas-video-player-shell')?.getAttribute('data-canvas-node-zone')).toBe('content');
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
              contentInteractionActive
              feedbackEntry={videoFeedbackEntry()}
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
              contentInteractionActive
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
              contentInteractionActive
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
      fileUrl: `/api/workbench/bindings/p/files/raw/media/clip.mp4?v=${revision}`,
      revision
    },
    videoMetadata: {
      width: 640,
      height: 360,
      durationSeconds: 5
    },
    videoTextTracks: [{
        projectRelativePath: 'media/clip.en.vtt',
        fileUrl: '/api/workbench/bindings/p/files/raw/media/clip.en.vtt?v=track-rev',
        revision: 'track-rev',
        kind: 'subtitles',
        label: 'English',
        srclang: 'en',
        default: true
      }]
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
      bindingId: 'p',
      projectRelativePath: 'media/clip.mp4',
      continuityIdentity: targetIdentity
    }),
    variantTarget: {
      mediaKind: 'video',
      bindingId: 'p',
      projectRelativePath: 'media/clip.mp4',
      targetIdentity,
      sourceWidth: 640,
      srcForWidth: (width) => `http://127.0.0.1:17321/api/workbench/bindings/p/canvas-video-preview/preview.jpg?path=media%2Fclip.mp4&w=${width}&sourceKey=test-preview`
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
