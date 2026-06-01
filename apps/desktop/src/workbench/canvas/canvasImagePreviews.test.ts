import { describe, expect, it } from 'vitest';
import type { ProjectedCanvasNode } from '@axis/canvas-core';
import {
  canvasImagePreviewBucket,
  canvasImageRenderSources,
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
      viewportZoom: 0.1,
      devicePixelRatio: 1
    })).toBe('axis-canvas-preview://project/flow/cover.png?v=rev&w=256');

    expect(canvasImageSourceUrl({
      node,
      imagePreviewsEnabled: true,
      viewportZoom: 1,
      devicePixelRatio: 1
    })).toBe('axis-canvas-preview://project/flow/cover.png?v=rev&w=2048');
  });

  it('keeps original URLs when previews are disabled or the image is not previewable', () => {
    expect(canvasImageSourceUrl({
      node: nodeFixture('flow/cover.png', 1000, 'image/png'),
      imagePreviewsEnabled: false,
      viewportZoom: 0.1,
      devicePixelRatio: 1
    })).toBe('axis-project-file://project/flow/cover.png?v=rev');

    expect(canvasImageSourceUrl({
      node: nodeFixture('flow/animated.gif', 1000, 'image/gif'),
      imagePreviewsEnabled: true,
      viewportZoom: 0.1,
      devicePixelRatio: 1
    })).toBe('axis-project-file://project/flow/animated.gif?v=rev');

    expect(canvasImageSourceUrl({
      node: { ...nodeFixture('flow/movie.mp4', 1000, 'video/mp4'), mediaKind: 'video' },
      imagePreviewsEnabled: true,
      viewportZoom: 0.1,
      devicePixelRatio: 1
    })).toBe('axis-project-file://project/flow/movie.mp4?v=rev');

    expect(canvasImageSourceUrl({
      node: nodeFixture('flow/animated.webp', 1000, 'image/webp', false),
      imagePreviewsEnabled: true,
      viewportZoom: 0.1,
      devicePixelRatio: 1
    })).toBe('axis-project-file://project/flow/animated.webp?v=rev');
  });

  it('caps preview bucket selection at the source image width', () => {
    const node = nodeFixture('flow/small.png', 1200, 'image/png', true, 300);

    expect(canvasImageSourceUrl({
      node,
      imagePreviewsEnabled: true,
      viewportZoom: 0.1,
      devicePixelRatio: 1
    })).toBe('axis-canvas-preview://project/flow/small.png?v=rev&w=256');

    expect(canvasImageSourceUrl({
      node,
      imagePreviewsEnabled: true,
      viewportZoom: 0.5,
      devicePixelRatio: 1
    })).toBe('axis-canvas-preview://project/flow/small.png?v=rev&w=512');

    expect(canvasImageSourceUrl({
      node,
      imagePreviewsEnabled: true,
      viewportZoom: 2,
      devicePixelRatio: 1
    })).toBe('axis-canvas-preview://project/flow/small.png?v=rev&w=512');
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
      viewportZoom: 0.2,
      devicePixelRatio: 1
    })).toBe('axis-canvas-preview://project/flow/cover%20art.png?v=rev&w=256');
  });

  it('keeps the loaded image visible while the next preview resource is loading', () => {
    expect(canvasImageRenderSources({
      selectedSrc: 'axis-canvas-preview://project/flow/cover.png?v=rev&w=512',
      loadKey: 'axis-canvas-preview://project/flow/cover.png?v=rev&w=512:0',
      loadedImage: {
        src: 'axis-canvas-preview://project/flow/cover.png?v=rev&w=256',
        loadKey: 'axis-canvas-preview://project/flow/cover.png?v=rev&w=256:0'
      }
    })).toEqual({
      loadedImage: {
        src: 'axis-canvas-preview://project/flow/cover.png?v=rev&w=256',
        loadKey: 'axis-canvas-preview://project/flow/cover.png?v=rev&w=256:0'
      },
      pendingImage: {
        src: 'axis-canvas-preview://project/flow/cover.png?v=rev&w=512',
        loadKey: 'axis-canvas-preview://project/flow/cover.png?v=rev&w=512:0'
      }
    });

    expect(canvasImageRenderSources({
      selectedSrc: 'axis-canvas-preview://project/flow/cover.png?v=rev&w=512',
      loadKey: 'axis-canvas-preview://project/flow/cover.png?v=rev&w=512:0',
      loadedImage: {
        src: 'axis-canvas-preview://project/flow/cover.png?v=rev&w=512',
        loadKey: 'axis-canvas-preview://project/flow/cover.png?v=rev&w=512:0'
      }
    })).toEqual({
      loadedImage: {
        src: 'axis-canvas-preview://project/flow/cover.png?v=rev&w=512',
        loadKey: 'axis-canvas-preview://project/flow/cover.png?v=rev&w=512:0'
      }
    });
  });

  it('keeps the loaded image visible when the next preview resource fails', () => {
    expect(canvasImageRenderSources({
      selectedSrc: 'axis-canvas-preview://project/flow/cover.png?v=rev&w=512',
      loadKey: 'axis-canvas-preview://project/flow/cover.png?v=rev&w=512:0',
      loadedImage: {
        src: 'axis-canvas-preview://project/flow/cover.png?v=rev&w=256',
        loadKey: 'axis-canvas-preview://project/flow/cover.png?v=rev&w=256:0'
      },
      loadError: 'Unable to load flow/cover.png.'
    })).toEqual({
      loadedImage: {
        src: 'axis-canvas-preview://project/flow/cover.png?v=rev&w=256',
        loadKey: 'axis-canvas-preview://project/flow/cover.png?v=rev&w=256:0'
      },
      errorOverlay: {
        message: 'Unable to load flow/cover.png.'
      }
    });
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
      fileUrl: `axis-project-file://project/${path.split('/').map(encodeURIComponent).join('/')}?v=rev`,
      revision: 'rev'
    }
  };
}

function isStillRasterMimeType(mimeType: string): boolean {
  return mimeType === 'image/png' || mimeType === 'image/jpeg' || mimeType === 'image/webp';
}
