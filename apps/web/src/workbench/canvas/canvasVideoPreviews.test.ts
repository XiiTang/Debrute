import { describe, expect, it } from 'vitest';
import { canvasVideoRasterPreviewRequest } from './CanvasVideoPreviewRuntime';
import type { CanvasVideoPreviewTarget } from './CanvasVideoPreviewTaskRegistry.js';

describe('canvas video preview URLs', { tags: ['canvas-video'] }, () => {
  it('builds video preview URLs from one owner-scoped target', () => {
    const request = canvasVideoRasterPreviewRequest({
      target: videoTarget(),
      source: { sourceWidth: 1200 }
    });

    expect(request.variantTarget?.sourceWidth).toBe(1200);
    expect(request.variantTarget?.srcForWidth(300)).toBe(
      '/api/workbench/bindings/123e4567-e89b-42d3-a456-426614174000/canvas-video-preview?path=media%2Fclip.mp4&sourceRevision=rev-video&frameTimeMs=0&w=300'
    );
  });
});

function videoTarget(): CanvasVideoPreviewTarget {
  return {
    bindingId: '123e4567-e89b-42d3-a456-426614174000',
    projectRelativePath: 'media/clip.mp4',
    sourceRevision: 'rev-video',
    sourceUrl: '/api/video',
    frameTimeMs: 0
  };
}
