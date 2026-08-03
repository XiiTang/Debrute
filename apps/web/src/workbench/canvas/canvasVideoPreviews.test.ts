import { describe, expect, it } from 'vitest';
import { canvasPreviewCanonicalSourceIdentity } from '@debrute/canvas-core';
import { canvasVideoRasterPreviewRequest } from './CanvasVideoPreviewRuntime';
import type { CanvasVideoPreviewTarget } from './CanvasVideoPreviewTaskRegistry.js';

describe('canvas video preview URLs', { tags: ['canvas-video'] }, () => {
  it('builds video preview URLs from one owner-scoped target', () => {
    const canonicalSourceIdentity = canvasPreviewCanonicalSourceIdentity('frame-v1--ms-0');
    const request = canvasVideoRasterPreviewRequest({
      target: videoTarget(),
      canonicalSource: { canonicalSourceIdentity, sourceWidth: 1200 }
    });

    expect(request.variantTarget?.sourceWidth).toBe(1200);
    expect(request.variantTarget?.canonicalSourceIdentity).toBe(canonicalSourceIdentity);
    expect(request.variantTarget?.srcForWidth(300)).toBe(
      '/api/projects/123e4567-e89b-42d3-a456-426614174000/canvas-video-preview?canvasId=canvas-1&path=media%2Fclip.mp4&sourceRevision=rev-video&frameTimeMs=0&canonicalSourceIdentity=frame-v1--ms-0&w=300'
    );
  });
});

function videoTarget(): CanvasVideoPreviewTarget {
  return {
    projectId: '123e4567-e89b-42d3-a456-426614174000',
    canvasId: 'canvas-1',
    projectRelativePath: 'media/clip.mp4',
    sourceRevision: 'rev-video',
    frameTimeMs: 0
  };
}
