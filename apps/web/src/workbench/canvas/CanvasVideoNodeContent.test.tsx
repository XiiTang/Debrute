// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import { CanvasVideoNodeContent } from './CanvasVideoNodeContent';
import { I18nProvider } from '../i18n';

vi.mock('./CanvasVideoPlayerAdapter', () => ({
  CanvasVideoPlayerAdapter: React.forwardRef(function MockCanvasVideoPlayerAdapter(
    {
      node,
      onError
    }: {
      node: ProjectedCanvasNode;
      onError: (message: string) => void;
    },
    _ref: React.ForwardedRef<unknown>
  ) {
    return (
      <div data-testid="video-player-adapter" data-path={node.projectRelativePath}>
        <video src={node.availability.state === 'available' ? node.availability.fileUrl : undefined} />
        <button type="button" data-testid="mock-video-error" onClick={() => onError(`Unable to play ${node.projectRelativePath}.`)}>
          trigger error
        </button>
      </div>
    );
  })
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CanvasVideoNodeContent', () => {
  it('renders a real video player adapter and not a static preview image', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <CanvasVideoNodeContent
          node={videoNode()}
          onSelectNode={() => undefined}
          onRegisterVideoTarget={() => undefined}
        />
      </I18nProvider>
    );

    expect(html).toContain('data-testid="video-player-adapter"');
    expect(html).toContain('media/clip.mp4');
    expect(html).toContain('db-canvas-node-caption');
    expect(html).not.toContain('canvas-text-preview-image');
    expect(html).not.toContain('data-canvas-image-layer');
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
          onSelectNode={() => undefined}
          onRegisterVideoTarget={() => undefined}
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
          onSelectNode={() => undefined}
          onRegisterVideoTarget={() => undefined}
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
              onSelectNode={() => undefined}
              onRegisterVideoTarget={() => undefined}
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
              onSelectNode={() => undefined}
              onRegisterVideoTarget={() => undefined}
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
});

function videoNode(options: { revision?: string } = {}): ProjectedCanvasNode {
  const revision = options.revision ?? 'rev';
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
      fileUrl: `http://127.0.0.1:17321/api/projects/p/files/raw/media/clip.mp4?v=${revision}`,
      revision
    },
    videoPresentation: {
      kind: 'video',
      durationSeconds: 5,
      poster: {
        projectRelativePath: 'media/clip.poster.webp',
        fileUrl: 'http://127.0.0.1:17321/api/projects/p/files/raw/media/clip.poster.webp?v=poster-rev',
        mimeType: 'image/webp',
        revision: 'poster-rev',
        source: 'explicit'
      },
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
}

function button(container: HTMLElement, testId: string): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!element) {
    throw new Error(`Missing button: ${testId}`);
  }
  return element;
}
