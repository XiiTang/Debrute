import { describe, expect, it } from 'vitest';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import {
  canvasImagePreviewSteppedScale,
  canvasImagePreviewWidth,
  canvasImageSource
} from './canvasImagePreviews';

describe('canvas image preview URLs', () => {
  it('rounds screen scale up to the local sqrt(2) preview scale ladder', () => {
    expect(canvasImagePreviewSteppedScale(0.18)).toBe(0.25);
    expect(canvasImagePreviewSteppedScale(0.25)).toBe(0.25);
    expect(canvasImagePreviewSteppedScale(0.26)).toBeCloseTo(Math.SQRT2 / 4);
    expect(canvasImagePreviewSteppedScale(0.5)).toBe(0.5);
    expect(canvasImagePreviewSteppedScale(0.51)).toBeCloseTo(Math.SQRT2 / 2);
  });

  it('calculates dynamic preview widths from source width, display width, zoom, and DPR', () => {
    expect(canvasImagePreviewWidth({
      nodeDisplayWidth: 2400,
      sourceWidth: 2400,
      resourceZoom: 0.1,
      devicePixelRatio: 1
    })).toBe(300);

    expect(canvasImagePreviewWidth({
      nodeDisplayWidth: 2400,
      sourceWidth: 2400,
      resourceZoom: 0.1,
      devicePixelRatio: 2
    })).toBe(600);

    expect(canvasImagePreviewWidth({
      nodeDisplayWidth: 2400,
      sourceWidth: 2400,
      resourceZoom: 1,
      devicePixelRatio: 2
    })).toBe(2400);

    expect(canvasImagePreviewWidth({
      nodeDisplayWidth: 2400,
      sourceWidth: 2400,
      resourceZoom: 0.51,
      devicePixelRatio: 1
    })).toBe(1698);
  });

  it('clamps preview scale to the tldraw minimum and source width maximum', () => {
    expect(canvasImagePreviewWidth({
      nodeDisplayWidth: 2400,
      sourceWidth: 2400,
      resourceZoom: 0.001,
      devicePixelRatio: 1
    })).toBe(75);

    expect(canvasImagePreviewWidth({
      nodeDisplayWidth: 1200,
      sourceWidth: 300,
      resourceZoom: 2,
      devicePixelRatio: 2
    })).toBe(300);
  });

  it('uses dynamic preview URLs without falling back to original files by screen width', () => {
    const node = nodeFixture('flow/cover.png', 2400, 'image/png');

    expect(canvasImageSource({
      node,
      resourceZoom: 0.1,
      devicePixelRatio: 1
    })).toEqual({ src: previewUrl('flow/cover.png', 300), previewWidth: 300 });

    expect(canvasImageSource({
      node,
      resourceZoom: 1,
      devicePixelRatio: 1
    })).toEqual({ src: previewUrl('flow/cover.png', 2400), previewWidth: 2400 });
  });

  it('returns source metadata with the chosen dynamic preview width', () => {
    expect(canvasImageSource({
      node: nodeFixture('flow/cover.png', 2400, 'image/png'),
      resourceZoom: 0.2,
      devicePixelRatio: 1
    })).toEqual({
      src: previewUrl('flow/cover.png', 600),
      previewWidth: 600
    });
  });

  it('does not return raw Canvas image URLs for unsupported image nodes', () => {
    expect(canvasImageSource({
      node: nodeFixture('flow/animated.gif', 1000, 'image/gif'),
      resourceZoom: 0.1,
      devicePixelRatio: 1
    })).toBeUndefined();

    expect(canvasImageSource({
      node: { ...nodeFixture('flow/movie.mp4', 1000, 'video/mp4'), mediaKind: 'video' },
      resourceZoom: 0.1,
      devicePixelRatio: 1
    })).toBeUndefined();

    expect(canvasImageSource({
      node: nodeFixture('flow/animated.webp', 1000, 'image/webp', false),
      resourceZoom: 0.1,
      devicePixelRatio: 1
    })).toBeUndefined();
  });

  it('scales dynamic previews below source width and caps them at source width', () => {
    const node = nodeFixture('flow/small.png', 1200, 'image/png', true, 300);

    expect(canvasImageSource({
      node,
      resourceZoom: 0.1,
      devicePixelRatio: 1
    })).toEqual({ src: previewUrl('flow/small.png', 150), previewWidth: 150 });

    expect(canvasImageSource({
      node,
      resourceZoom: 2,
      devicePixelRatio: 2
    })).toEqual({ src: previewUrl('flow/small.png', 300), previewWidth: 300 });
  });

  it('rejects invalid dynamic preview inputs', () => {
    expect(() => canvasImagePreviewSteppedScale(0)).toThrow('Canvas image preview screen scale must be a positive finite number.');
    expect(() => canvasImagePreviewSteppedScale(Number.NaN)).toThrow('Canvas image preview screen scale must be a positive finite number.');
    expect(() => canvasImagePreviewWidth({
      nodeDisplayWidth: 0,
      sourceWidth: 2400,
      resourceZoom: 1,
      devicePixelRatio: 1
    })).toThrow('Canvas image preview node display width must be a positive finite number.');
    expect(() => canvasImagePreviewWidth({
      nodeDisplayWidth: 2400,
      sourceWidth: 0,
      resourceZoom: 1,
      devicePixelRatio: 1
    })).toThrow('Canvas image preview source width must be a positive finite number.');
  });

  it('keeps preview URLs limited to path, revision, and dynamic width', () => {
    expect(canvasImageSource({
      node: nodeFixture('flow/cover art.png', 1000, 'image/png'),
      resourceZoom: 0.2,
      devicePixelRatio: 1
    })).toEqual({
      src: '/api/projects/123e4567-e89b-42d3-a456-426614174000/canvas-image-preview?path=flow%2Fcover+art.png&v=rev&w=250',
      previewWidth: 250
    });
  });

  it('does not copy source file query params into preview URLs', () => {
    const path = '阿咕/阿咕-形象总览.png';
    const node = nodeFixture(path, 5120, 'image/png', true, 5120, rawUrl(path, 'test-token'));

    const source = canvasImageSource({
      node,
      resourceZoom: 0.1,
      devicePixelRatio: 1
    });

    expect(source).toEqual({
      src: previewUrl(path, 640),
      previewWidth: 640
    });
    expect(source!.src).not.toContain('test-token');
  });

});

function nodeFixture(
  path: string,
  width: number,
  mimeType: string,
  canvasImagePreviewable = isStillRasterMimeType(mimeType),
  canvasImagePreviewSourceWidth = width,
  fileUrl = rawUrl(path)
): ProjectedCanvasNode {
  return {
    projectRelativePath: path,
    nodeKind: 'file',
    mediaKind: 'image',
    x: 0,
    y: 0,
    width,
    height: 400,
    z: 0,
    availability: {
      state: 'available',
      size: 100,
      mimeType,
      canvasImagePreviewable,
      canvasImagePreviewSourceWidth,
      fileUrl,
      revision: 'rev'
    }
  };
}

function rawUrl(path: string, daemonToken?: string): string {
  const url = new URL(`http://127.0.0.1:17321/api/projects/123e4567-e89b-42d3-a456-426614174000/files/raw/${path.split('/').map(encodeURIComponent).join('/')}`);
  url.searchParams.set('v', 'rev');
  if (daemonToken) {
    url.searchParams.set('ignored', daemonToken);
  }
  return url.toString();
}

function previewUrl(path: string, width: number): string {
  const params = new URLSearchParams({
    path,
    v: 'rev',
    w: String(width)
  });
  return `/api/projects/123e4567-e89b-42d3-a456-426614174000/canvas-image-preview?${params.toString()}`;
}

function isStillRasterMimeType(mimeType: string): boolean {
  return mimeType === 'image/png' || mimeType === 'image/jpeg' || mimeType === 'image/webp';
}
