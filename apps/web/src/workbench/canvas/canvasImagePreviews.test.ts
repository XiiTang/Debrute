import { describe, expect, it } from 'vitest';
import type { ProjectedCanvasNode } from './CanvasScene';
import { canvasImageRasterPreviewRequestForNode } from './canvasImagePreviewTarget';

describe('canvas image preview target', () => {
  it('provides canonical source width and width-specific Runtime URLs', () => {
    const request = canvasImageRasterPreviewRequestForNode(
      nodeFixture('flow/cover art.png', 2400, 'image/png', true)
    );

    expect(request.variantTarget?.sourceWidth).toBe(2400);
    expect(request.variantTarget?.srcForWidth(600)).toBe(
      '/api/workbench/bindings/123e4567-e89b-42d3-a456-426614174000/canvas-image-preview?path=flow%2Fcover+art.png&sourceRevision=rev&w=600'
    );
  });

  it('does not create raster targets for unsupported image nodes', () => {
    expect(canvasImageRasterPreviewRequestForNode(
      nodeFixture('flow/animated.gif', 1000, 'image/gif', false)
    )).toEqual({});
    expect(canvasImageRasterPreviewRequestForNode({
      ...nodeFixture('flow/movie.mp4', 1000, 'video/mp4', false),
      mediaKind: 'video'
    })).toEqual({});
    expect(canvasImageRasterPreviewRequestForNode(
      nodeFixture('flow/animated.webp', 1000, 'image/webp', false)
    )).toEqual({});
  });

  it('rejects raw-file URLs outside the exact Runtime response shape', () => {
    const path = '阿咕/阿咕-形象总览.png';
    expect(() => canvasImageRasterPreviewRequestForNode(
      nodeFixture(path, 5120, 'image/png', true, 5120, `https://elsewhere.invalid${rawUrl(path)}`)
    )).toThrow('Canvas file URL must be a relative Runtime raw-file URL.');
    expect(() => canvasImageRasterPreviewRequestForNode(
      nodeFixture(path, 5120, 'image/png', true, 5120, `${rawUrl(path)}&ignored=test-token`)
    )).toThrow('Canvas file URL must be a relative Runtime raw-file URL.');
  });
});

function nodeFixture(
  path: string,
  width: number,
  mimeType: string,
  canvasImagePreviewable: boolean,
  canvasImagePreviewSourceWidth = width,
  fileUrl = rawUrl(path)
): ProjectedCanvasNode {
  return {
    projectRelativePath: path,
    displayName: path,
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
  return `/api/workbench/bindings/123e4567-e89b-42d3-a456-426614174000/files/raw/${encodedPath}?v=rev`;
}
