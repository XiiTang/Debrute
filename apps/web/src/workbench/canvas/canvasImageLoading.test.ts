import { describe, expect, it } from 'vitest';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import { createCanvasImageLoadingPlan, selectCanvasImageLoadingCandidates } from './canvasImageLoading';
import type { CanvasLoadedImage } from './canvasImagePreviews';

describe('canvas image loading plan', () => {
  it('prioritizes visible images without loaded frames above overscan images', () => {
    const plan = createCanvasImageLoadingPlan({
      nodes: [
        imageNode('flow/visible.png', 0, 0),
        imageNode('flow/overscan.png', 900, 0),
        imageNode('flow/deferred.png', 1800, 0)
      ],
      visibleRect: { x: 0, y: 0, width: 400, height: 300 },
      imageResourceZoom: 1,
      devicePixelRatio: 1,
      imagePreviewsEnabled: true,
      existingImages: new Map(),
      retryKeys: new Map()
    });

    expect(plan.get('flow/visible.png')).toMatchObject({
      priority: 0,
      reason: 'viewport-empty',
      eligible: true
    });
    expect(plan.get('flow/overscan.png')).toMatchObject({
      priority: 2,
      reason: 'overscan-empty',
      eligible: true
    });
    expect(plan.get('flow/deferred.png')).toMatchObject({
      priority: 4,
      reason: 'deferred',
      eligible: true
    });
  });

  it('uses loaded images to distinguish upgrades from empty loads', () => {
    const loaded = loadedImage('http://127.0.0.1:17321/api/projects/p/canvas-image-preview?path=flow%2Fvisible.png&v=rev&w=256');
    const plan = createCanvasImageLoadingPlan({
      nodes: [imageNode('flow/visible.png', 0, 0, 2400, 1200)],
      visibleRect: { x: 0, y: 0, width: 400, height: 300 },
      imageResourceZoom: 1,
      devicePixelRatio: 1,
      imagePreviewsEnabled: true,
      existingImages: new Map([['flow/visible.png', loaded]]),
      retryKeys: new Map()
    });

    expect(plan.get('flow/visible.png')).toMatchObject({
      priority: 1,
      reason: 'viewport-upgrade'
    });
  });

  it('keeps original image URLs when previews are disabled but still schedules through the plan', () => {
    const plan = createCanvasImageLoadingPlan({
      nodes: [imageNode('flow/original.png', 0, 0)],
      visibleRect: { x: 0, y: 0, width: 400, height: 300 },
      imageResourceZoom: 0.1,
      devicePixelRatio: 1,
      imagePreviewsEnabled: false,
      existingImages: new Map(),
      retryKeys: new Map([['flow/original.png', 2]])
    });

    expect(plan.get('flow/original.png')).toMatchObject({
      priority: 0,
      src: rawUrl('flow/original.png'),
      loadKey: `${rawUrl('flow/original.png')}:2`
    });
  });

  it('does not prefetch overscan raw images when previews are disabled', () => {
    const plan = createCanvasImageLoadingPlan({
      nodes: [
        imageNode('flow/visible.png', 0, 0),
        imageNode('flow/overscan.png', 900, 0)
      ],
      visibleRect: { x: 0, y: 0, width: 400, height: 300 },
      imageResourceZoom: 1,
      devicePixelRatio: 1,
      imagePreviewsEnabled: false,
      existingImages: new Map(),
      retryKeys: new Map()
    });

    expect(plan.get('flow/visible.png')).toMatchObject({
      priority: 0,
      reason: 'viewport-empty'
    });
    expect(plan.get('flow/overscan.png')).toMatchObject({
      priority: 4,
      reason: 'deferred'
    });
  });

  it('marks unavailable and non-image nodes as not eligible', () => {
    const unavailable: ProjectedCanvasNode = {
      ...imageNode('flow/missing.png', 0, 0),
      availability: { state: 'missing', message: 'Project path is missing: flow/missing.png' }
    };
    const text: ProjectedCanvasNode = {
      ...imageNode('flow/readme.md', 0, 0),
      mediaKind: 'text'
    };

    const plan = createCanvasImageLoadingPlan({
      nodes: [unavailable, text],
      visibleRect: { x: 0, y: 0, width: 400, height: 300 },
      imageResourceZoom: 1,
      devicePixelRatio: 1,
      imagePreviewsEnabled: true,
      existingImages: new Map(),
      retryKeys: new Map()
    });

    expect(plan.get('flow/missing.png')).toMatchObject({ eligible: false, reason: 'unavailable' });
    expect(plan.has('flow/readme.md')).toBe(false);
  });

  it('selects only visible empty loads while moving and includes upgrades plus overscan while idle', () => {
    const visibleEmpty = imageNode('flow/visible-empty.png', 0, 0, 2400, 1200);
    const visibleUpgrade = imageNode('flow/visible-upgrade.png', 220, 0, 2400, 1200);
    const overscanEmpty = imageNode('flow/overscan-empty.png', 900, 0, 2400, 1200);
    const overscanUpgrade = imageNode('flow/overscan-upgrade.png', 1000, 0, 2400, 1200);
    const visibleUpgradeUrl = 'http://127.0.0.1:17321/api/projects/p/canvas-image-preview?path=flow%2Fvisible-upgrade.png&v=rev&w=256';
    const overscanUpgradeUrl = 'http://127.0.0.1:17321/api/projects/p/canvas-image-preview?path=flow%2Foverscan-upgrade.png&v=rev&w=256';
    const plan = createCanvasImageLoadingPlan({
      nodes: [visibleEmpty, visibleUpgrade, overscanEmpty, overscanUpgrade],
      visibleRect: { x: 0, y: 0, width: 500, height: 300 },
      imageResourceZoom: 1,
      devicePixelRatio: 1,
      imagePreviewsEnabled: true,
      existingImages: new Map([
        ['flow/visible-upgrade.png', loadedImage(visibleUpgradeUrl)],
        ['flow/overscan-upgrade.png', loadedImage(overscanUpgradeUrl)]
      ]),
      retryKeys: new Map()
    });

    expect(selectCanvasImageLoadingCandidates({
      plan,
      cameraState: 'moving',
      activeLoadKeys: new Set()
    }).map((item) => item.projectRelativePath)).toEqual(['flow/visible-empty.png']);

    expect(selectCanvasImageLoadingCandidates({
      plan,
      cameraState: 'idle',
      activeLoadKeys: new Set()
    }).map((item) => item.projectRelativePath)).toEqual([
      'flow/visible-empty.png',
      'flow/visible-upgrade.png',
      'flow/overscan-empty.png',
      'flow/overscan-upgrade.png'
    ]);
  });
});

function imageNode(path: string, x: number, y: number, width = 200, height = 120): ProjectedCanvasNode {
  return {
    projectRelativePath: path,
    nodeKind: 'file',
    mediaKind: 'image',
    x,
    y,
    width,
    height,
    z: 0,
    visible: true,
    locked: false,
    availability: {
      state: 'available',
      size: 2_000_000,
      mimeType: 'image/png',
      canvasImagePreviewable: true,
      canvasImagePreviewSourceWidth: width,
      fileUrl: rawUrl(path),
      revision: 'rev'
    }
  };
}

function rawUrl(path: string): string {
  return `http://127.0.0.1:17321/api/projects/p/files/raw/${path}?v=rev`;
}

function loadedImage(src: string): CanvasLoadedImage {
  return { src, loadKey: `${src}:0` };
}
