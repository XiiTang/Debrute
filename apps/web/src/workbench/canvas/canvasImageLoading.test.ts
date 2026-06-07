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
      existingImages: new Map(),
      retryKeys: new Map()
    });

    expect(plan.get('flow/visible.png')).toMatchObject({
      intent: 'display-critical',
      previewWidth: 256,
      eligible: true
    });
    expect(plan.get('flow/overscan.png')).toMatchObject({
      intent: 'prefetch-near',
      eligible: true
    });
    expect(plan.get('flow/deferred.png')).toMatchObject({
      intent: 'deferred',
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
      existingImages: new Map([['flow/visible.png', loaded]]),
      retryKeys: new Map()
    });

    expect(plan.get('flow/visible.png')).toMatchObject({
      intent: 'upgrade-idle'
    });
  });

  it('classifies image work by final intent and carries preview width', () => {
    const lowQualityUrl = previewUrl('flow/visible-upgrade.png', 256);
    const plan = createCanvasImageLoadingPlan({
      nodes: [
        imageNode('flow/visible-empty.png', 0, 0, 2400, 1200),
        imageNode('flow/visible-upgrade.png', 220, 0, 2400, 1200),
        imageNode('flow/prefetch-empty.png', 900, 0, 2400, 1200),
        imageNode('flow/prefetch-upgrade.png', 1000, 0, 2400, 1200),
        imageNode('flow/deferred.png', 5000, 0, 2400, 1200)
      ],
      visibleRect: { x: 0, y: 0, width: 500, height: 300 },
      imageResourceZoom: 1,
      devicePixelRatio: 1,
      existingImages: new Map([
        ['flow/visible-upgrade.png', loadedImage(lowQualityUrl, 256)],
        ['flow/prefetch-upgrade.png', loadedImage(previewUrl('flow/prefetch-upgrade.png', 256), 256)]
      ]),
      retryKeys: new Map()
    });

    expect(plan.get('flow/visible-empty.png')).toMatchObject({
      intent: 'display-critical',
      previewWidth: 2048,
      eligible: true
    });
    expect(plan.get('flow/visible-upgrade.png')).toMatchObject({ intent: 'upgrade-idle' });
    expect(plan.get('flow/prefetch-empty.png')).toMatchObject({ intent: 'prefetch-near' });
    expect(plan.get('flow/prefetch-upgrade.png')).toMatchObject({ intent: 'upgrade-idle' });
    expect(plan.get('flow/deferred.png')).toMatchObject({ intent: 'deferred' });
  });

  it('uses preview image URLs for supported visible image nodes', () => {
    const plan = createCanvasImageLoadingPlan({
      nodes: [imageNode('flow/original.png', 0, 0)],
      visibleRect: { x: 0, y: 0, width: 400, height: 300 },
      imageResourceZoom: 0.1,
      devicePixelRatio: 1,
      existingImages: new Map(),
      retryKeys: new Map([['flow/original.png', 2]])
    });

    const src = previewUrl('flow/original.png', 256);
    expect(plan.get('flow/original.png')).toMatchObject({
      intent: 'display-critical',
      src,
      previewWidth: 256,
      loadKey: `${src}:2`
    });
  });

  it('always schedules near-viewport preview images while idle', () => {
    const plan = createCanvasImageLoadingPlan({
      nodes: [
        imageNode('flow/visible.png', 0, 0),
        imageNode('flow/overscan.png', 900, 0)
      ],
      visibleRect: { x: 0, y: 0, width: 400, height: 300 },
      imageResourceZoom: 1,
      devicePixelRatio: 1,
      existingImages: new Map(),
      retryKeys: new Map()
    });

    expect(plan.get('flow/visible.png')).toMatchObject({
      intent: 'display-critical'
    });
    expect(plan.get('flow/overscan.png')).toMatchObject({
      intent: 'prefetch-near'
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
      existingImages: new Map(),
      retryKeys: new Map()
    });

    expect(plan.get('flow/missing.png')).toMatchObject({ eligible: false, intent: 'unavailable' });
    expect(plan.has('flow/readme.md')).toBe(false);
  });

  it('selects display-critical and bounded prefetch while moving and defers upgrades until idle', () => {
    const visibleEmpty = imageNode('flow/visible-empty.png', 0, 0, 2400, 1200);
    const visibleUpgrade = imageNode('flow/visible-upgrade.png', 220, 0, 2400, 1200);
    const nearPrefetchEmpty = imageNode('flow/near-prefetch-empty.png', 900, 0, 2400, 1200);
    const nearPrefetchUpgrade = imageNode('flow/near-prefetch-upgrade.png', 1000, 0, 2400, 1200);
    const visibleUpgradeUrl = 'http://127.0.0.1:17321/api/projects/p/canvas-image-preview?path=flow%2Fvisible-upgrade.png&v=rev&w=256';
    const nearPrefetchUpgradeUrl = 'http://127.0.0.1:17321/api/projects/p/canvas-image-preview?path=flow%2Fnear-prefetch-upgrade.png&v=rev&w=256';
    const plan = createCanvasImageLoadingPlan({
      nodes: [visibleEmpty, visibleUpgrade, nearPrefetchEmpty, nearPrefetchUpgrade],
      visibleRect: { x: 0, y: 0, width: 500, height: 300 },
      imageResourceZoom: 1,
      devicePixelRatio: 1,
      existingImages: new Map([
        ['flow/visible-upgrade.png', loadedImage(visibleUpgradeUrl)],
        ['flow/near-prefetch-upgrade.png', loadedImage(nearPrefetchUpgradeUrl)]
      ]),
      retryKeys: new Map()
    });

    expect(selectCanvasImageLoadingCandidates({
      plan,
      cameraState: 'moving',
      activeLoadKeys: new Set(),
      movingPrefetchLimit: 1
    }).map((item) => item.projectRelativePath)).toEqual([
      'flow/visible-empty.png',
      'flow/near-prefetch-empty.png'
    ]);

    expect(selectCanvasImageLoadingCandidates({
      plan,
      cameraState: 'idle',
      activeLoadKeys: new Set()
    }).map((item) => item.projectRelativePath)).toEqual([
      'flow/visible-empty.png',
      'flow/near-prefetch-empty.png',
      'flow/visible-upgrade.png',
      'flow/near-prefetch-upgrade.png'
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

function previewUrl(path: string, width: number): string {
  const url = new URL('http://127.0.0.1:17321/api/projects/p/canvas-image-preview');
  url.searchParams.set('path', path);
  url.searchParams.set('v', 'rev');
  url.searchParams.set('w', String(width));
  return url.toString();
}

function loadedImage(src: string, previewWidth = 256): CanvasLoadedImage {
  return { src, loadKey: `${src}:0`, previewWidth };
}
