import { describe, expect, it } from 'vitest';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import { canvasImageSource } from './canvasImagePreviews';

describe('canvas image preview URLs', () => {
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

  it('rejects raw-file URLs outside the exact Runtime response shape', () => {
    const path = '阿咕/阿咕-形象总览.png';
    expect(() => canvasImageSource({
      node: nodeFixture(path, 5120, 'image/png', true, 5120, `https://elsewhere.invalid${rawUrl(path)}`),
      resourceZoom: 0.1,
      devicePixelRatio: 1
    })).toThrow('Canvas file URL must be a relative Runtime raw-file URL.');
    expect(() => canvasImageSource({
      node: nodeFixture(path, 5120, 'image/png', true, 5120, `${rawUrl(path)}&ignored=test-token`),
      resourceZoom: 0.1,
      devicePixelRatio: 1
    })).toThrow('Canvas file URL must be a relative Runtime raw-file URL.');
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

function rawUrl(path: string): string {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `/api/projects/123e4567-e89b-42d3-a456-426614174000/files/raw/${encodedPath}?v=rev`;
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
