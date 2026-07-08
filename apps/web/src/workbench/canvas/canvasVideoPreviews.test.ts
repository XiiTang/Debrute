import { describe, expect, it } from 'vitest';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import {
  canvasVideoPreviewSource,
  canvasVideoPreviewWidthForNode
} from './canvasVideoPreviews';

describe('canvas video preview URLs', () => {
  it('calculates preview width with the shared raster width ladder', () => {
    expect(canvasVideoPreviewWidthForNode({
      nodeDisplayWidth: 1200,
      sourceWidth: 1200,
      resourceZoom: 0.1,
      devicePixelRatio: 2
    })).toBe(300);
  });

  it('builds video preview URLs from raw file URLs and explicit canvas id', () => {
    const source = canvasVideoPreviewSource({
      canvasId: 'canvas-1',
      node: videoNode('media/clip.mp4', 'rev-video', rawUrl('media/clip.mp4', 'test-token')),
      sourceKey: 'v1--explicit--poster',
      sourceWidth: 1200,
      currentTimeSeconds: 0,
      resourceZoom: 0.1,
      devicePixelRatio: 2
    });

    expect(source).toEqual({
      previewWidth: 300,
      src: '/api/projects/123e4567-e89b-42d3-a456-426614174000/canvas-video-preview?canvasId=canvas-1&path=media%2Fclip.mp4&videoRevision=rev-video&t=0&sourceKey=v1--explicit--poster&w=300'
    });
    expect(source!.src).not.toContain('test-token');
  });

  it('returns undefined for unavailable video nodes', () => {
    expect(canvasVideoPreviewSource({
      canvasId: 'canvas-1',
      node: {
        ...videoNode('media/clip.mp4'),
        availability: { state: 'missing', message: 'missing' }
      },
      sourceKey: 'source',
      sourceWidth: 1200,
      currentTimeSeconds: 0,
      resourceZoom: 0.1,
      devicePixelRatio: 1
    })).toBeUndefined();
  });
});

function videoNode(
  path: string,
  revision = 'rev-video',
  fileUrl = rawUrl(path)
): ProjectedCanvasNode {
  return {
    projectRelativePath: path,
    nodeKind: 'file',
    mediaKind: 'video',
    x: 0,
    y: 0,
    width: 1200,
    height: 675,
    z: 0,
    availability: {
      state: 'available',
      size: 100,
      mimeType: 'video/mp4',
      fileUrl,
      revision
    },
    videoPresentation: {
      kind: 'video',
      width: 640,
      height: 360,
      textTracks: []
    }
  };
}

function rawUrl(path: string, daemonToken?: string): string {
  const url = new URL(`http://127.0.0.1:17321/api/projects/123e4567-e89b-42d3-a456-426614174000/files/raw/${path.split('/').map(encodeURIComponent).join('/')}`);
  url.searchParams.set('v', 'rev-video');
  if (daemonToken) {
    url.searchParams.set('ignored', daemonToken);
  }
  return url.toString();
}
