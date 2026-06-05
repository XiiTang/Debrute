import { describe, expect, it } from 'vitest';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import {
  canvasImagePreviewBucket,
  canvasImageSourceUrl,
  shouldUpdateCanvasImageResourceZoom
} from './canvasImagePreviews';

describe('canvas image preview URLs', () => {
  it('uses bounded preview buckets without falling back to original files by screen width', () => {
    const node = nodeFixture('flow/cover.png', 2400, 'image/png');

    expect(canvasImagePreviewBucket(240)).toBe(256);
    expect(canvasImageSourceUrl({
      node,
      imagePreviewsEnabled: true,
      cameraZoom: 0.1,
      devicePixelRatio: 1
    })).toBe(previewUrl('flow/cover.png', 256));

    expect(canvasImageSourceUrl({
      node,
      imagePreviewsEnabled: true,
      cameraZoom: 1,
      devicePixelRatio: 1
    })).toBe(previewUrl('flow/cover.png', 2048));
  });

  it('keeps original URLs when previews are disabled or the image is not previewable', () => {
    expect(canvasImageSourceUrl({
      node: nodeFixture('flow/cover.png', 1000, 'image/png'),
      imagePreviewsEnabled: false,
      cameraZoom: 0.1,
      devicePixelRatio: 1
    })).toBe(rawUrl('flow/cover.png'));

    expect(canvasImageSourceUrl({
      node: nodeFixture('flow/animated.gif', 1000, 'image/gif'),
      imagePreviewsEnabled: true,
      cameraZoom: 0.1,
      devicePixelRatio: 1
    })).toBe(rawUrl('flow/animated.gif'));

    expect(canvasImageSourceUrl({
      node: { ...nodeFixture('flow/movie.mp4', 1000, 'video/mp4'), mediaKind: 'video' },
      imagePreviewsEnabled: true,
      cameraZoom: 0.1,
      devicePixelRatio: 1
    })).toBe(rawUrl('flow/movie.mp4'));

    expect(canvasImageSourceUrl({
      node: nodeFixture('flow/animated.webp', 1000, 'image/webp', false),
      imagePreviewsEnabled: true,
      cameraZoom: 0.1,
      devicePixelRatio: 1
    })).toBe(rawUrl('flow/animated.webp'));
  });

  it('caps preview bucket selection at the source image width', () => {
    const node = nodeFixture('flow/small.png', 1200, 'image/png', true, 300);

    expect(canvasImageSourceUrl({
      node,
      imagePreviewsEnabled: true,
      cameraZoom: 0.1,
      devicePixelRatio: 1
    })).toBe(previewUrl('flow/small.png', 256));

    expect(canvasImageSourceUrl({
      node,
      imagePreviewsEnabled: true,
      cameraZoom: 0.5,
      devicePixelRatio: 1
    })).toBe(previewUrl('flow/small.png', 512));

    expect(canvasImageSourceUrl({
      node,
      imagePreviewsEnabled: true,
      cameraZoom: 2,
      devicePixelRatio: 1
    })).toBe(previewUrl('flow/small.png', 512));
  });

  it('rejects invalid target widths instead of selecting a fallback bucket', () => {
    expect(() => canvasImagePreviewBucket(0)).toThrow('Canvas image preview target width must be a positive finite number.');
    expect(() => canvasImagePreviewBucket(Number.NaN)).toThrow('Canvas image preview target width must be a positive finite number.');
  });

  it('does not settle image resource zoom while previews are disabled', () => {
    expect(shouldUpdateCanvasImageResourceZoom({
      imagePreviewsEnabled: false,
      nextZoom: 0.25,
      currentResourceZoom: 1,
      hasPendingTimer: false
    })).toBe(false);

    expect(shouldUpdateCanvasImageResourceZoom({
      imagePreviewsEnabled: true,
      nextZoom: 0.25,
      currentResourceZoom: 1,
      hasPendingTimer: false
    })).toBe(true);

    expect(shouldUpdateCanvasImageResourceZoom({
      imagePreviewsEnabled: true,
      nextZoom: 1,
      currentResourceZoom: 1,
      hasPendingTimer: false
    })).toBe(false);
  });

  it('keeps preview URLs limited to path, revision, and width', () => {
    expect(canvasImageSourceUrl({
      node: nodeFixture('flow/cover art.png', 1000, 'image/png'),
      imagePreviewsEnabled: true,
      cameraZoom: 0.2,
      devicePixelRatio: 1
    })).toBe('http://127.0.0.1:17321/api/projects/123e4567-e89b-42d3-a456-426614174000/canvas-image-preview?path=flow%2Fcover+art.png&v=rev&w=256');
  });

});

function nodeFixture(
  path: string,
  width: number,
  mimeType: string,
  canvasImagePreviewable = isStillRasterMimeType(mimeType),
  canvasImagePreviewSourceWidth = width
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
    visible: true,
    locked: false,
    availability: {
      state: 'available',
      size: 100,
      mimeType,
      canvasImagePreviewable,
      canvasImagePreviewSourceWidth,
      fileUrl: rawUrl(path),
      revision: 'rev'
    }
  };
}

function rawUrl(path: string): string {
  return `http://127.0.0.1:17321/api/projects/123e4567-e89b-42d3-a456-426614174000/files/raw/${path.split('/').map(encodeURIComponent).join('/')}?v=rev`;
}

function previewUrl(path: string, width: number): string {
  const url = new URL('http://127.0.0.1:17321/api/projects/123e4567-e89b-42d3-a456-426614174000/canvas-image-preview');
  url.searchParams.set('path', path);
  url.searchParams.set('v', 'rev');
  url.searchParams.set('w', String(width));
  return url.toString();
}

function isStillRasterMimeType(mimeType: string): boolean {
  return mimeType === 'image/png' || mimeType === 'image/jpeg' || mimeType === 'image/webp';
}
