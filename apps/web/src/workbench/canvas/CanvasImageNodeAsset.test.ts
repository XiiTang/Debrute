import { describe, expect, it } from 'vitest';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import {
  canvasImageNodeAssetReducer,
  deriveCanvasImageNodeRenderState,
  resolveCanvasImageNodeSource,
  type CanvasImageNodeAssetState
} from './CanvasImageNodeAsset';

describe('CanvasImageNodeAsset', () => {
  it('resolves preview URLs from node size, resource zoom, DPR, revision, and retry key', () => {
    const source = resolveCanvasImageNodeSource({
      node: imageNode('flow/cover.png', 200, 120, 2400, 'rev-a'),
      imageResourceZoom: 1,
      devicePixelRatio: 1,
      retryKey: 2
    });

    expect(source).toMatchObject({
      kind: 'source',
      image: {
        src: previewUrl('flow/cover.png', 'rev-a', 300),
        loadKey: `${previewUrl('flow/cover.png', 'rev-a', 300)}:2`,
        previewWidth: 300
      },
      sourceRevisionKey: 'flow/cover.png\u001frev-a'
    });
  });

  it('keeps loaded images visible while idle upgrades load as next', () => {
    const state = loadedState('flow/cover.png', 'rev-a', 300);
    const source = resolveCanvasImageNodeSource({
      node: imageNode('flow/cover.png', 2400, 1200, 2400, 'rev-a'),
      imageResourceZoom: 1,
      devicePixelRatio: 1,
      retryKey: 0
    });

    const next = canvasImageNodeAssetReducer(state, {
      type: 'source-resolved',
      source,
      cameraState: 'idle',
      culled: false
    });

    expect(next.loaded?.previewWidth).toBe(300);
    expect(next.next).toMatchObject({
      src: previewUrl('flow/cover.png', 'rev-a', 2400),
      loadKey: `${previewUrl('flow/cover.png', 'rev-a', 2400)}:0`,
      previewWidth: 2400
    });
  });

  it('does not create new work for the same loaded URL', () => {
    const state = loadedState('flow/cover.png', 'rev-a', 300);
    const source = resolveCanvasImageNodeSource({
      node: imageNode('flow/cover.png', 200, 120, 2400, 'rev-a'),
      imageResourceZoom: 1,
      devicePixelRatio: 1,
      retryKey: 0
    });

    const next = canvasImageNodeAssetReducer(state, {
      type: 'source-resolved',
      source,
      cameraState: 'idle',
      culled: false
    });

    expect(next.loaded).toEqual(state.loaded);
    expect(next.next).toBeUndefined();
    expect(next.error).toBeUndefined();
  });

  it('keeps the loaded URL through a culled pan out and unculled pan back without scheduling another image', () => {
    const loaded = loadedState('flow/cover.png', 'rev-a', 300);
    const source = resolveCanvasImageNodeSource({
      node: imageNode('flow/cover.png', 200, 120, 2400, 'rev-a'),
      imageResourceZoom: 1,
      devicePixelRatio: 1,
      retryKey: 0
    });

    const panOut = canvasImageNodeAssetReducer(loaded, {
      type: 'source-resolved',
      source,
      cameraState: 'moving',
      culled: true
    });
    const panBack = canvasImageNodeAssetReducer(panOut, {
      type: 'source-resolved',
      source,
      cameraState: 'idle',
      culled: false
    });
    const renderState = deriveCanvasImageNodeRenderState({
      state: panBack,
      retry: () => undefined
    });

    expect(panOut.loaded).toEqual(loaded.loaded);
    expect(panOut.next).toBeUndefined();
    expect(panBack.loaded).toEqual(loaded.loaded);
    expect(panBack.next).toBeUndefined();
    expect(renderState).toMatchObject({
      kind: 'image',
      visible: loaded.loaded
    });
    if (renderState.kind === 'image') {
      expect(renderState.next).toBeUndefined();
    }
  });

  it('skips quality upgrades while moving when a loaded image exists', () => {
    const state = loadedState('flow/cover.png', 'rev-a', 300);
    const source = resolveCanvasImageNodeSource({
      node: imageNode('flow/cover.png', 2400, 1200, 2400, 'rev-a'),
      imageResourceZoom: 1,
      devicePixelRatio: 1,
      retryKey: 0
    });

    const next = canvasImageNodeAssetReducer(state, {
      type: 'source-resolved',
      source,
      cameraState: 'moving',
      culled: false
    });

    expect(next.loaded).toEqual(state.loaded);
    expect(next.next).toBeUndefined();
  });

  it('retains loaded image state while culled and skips new work', () => {
    const state = loadedState('flow/cover.png', 'rev-a', 300);
    const source = resolveCanvasImageNodeSource({
      node: imageNode('flow/cover.png', 2400, 1200, 2400, 'rev-a'),
      imageResourceZoom: 1,
      devicePixelRatio: 1,
      retryKey: 0
    });

    const next = canvasImageNodeAssetReducer(state, {
      type: 'source-resolved',
      source,
      cameraState: 'idle',
      culled: true
    });

    expect(next.loaded).toEqual(state.loaded);
    expect(next.next).toBeUndefined();
  });

  it('prefetches a culled image when the render coordinator marks it near the viewport', () => {
    const source = resolveCanvasImageNodeSource({
      node: imageNode('flow/near.png', 2400, 1200, 2400, 'rev-a'),
      imageResourceZoom: 0.1,
      devicePixelRatio: 1,
      retryKey: 0
    });

    const next = canvasImageNodeAssetReducer(emptyState(), {
      type: 'source-resolved',
      source,
      cameraState: 'moving',
      culled: true,
      prefetch: true
    });

    expect(next.next).toMatchObject({
      src: previewUrl('flow/near.png', 'rev-a', 300),
      previewWidth: 300
    });
  });

  it('warms the first preview for culled images while the camera is idle', () => {
    const source = resolveCanvasImageNodeSource({
      node: imageNode('flow/far.png', 2400, 1200, 2400, 'rev-a'),
      imageResourceZoom: 0.1,
      devicePixelRatio: 1,
      retryKey: 0
    });

    const next = canvasImageNodeAssetReducer(emptyState(), {
      type: 'source-resolved',
      source,
      cameraState: 'idle',
      culled: true,
      prefetch: false
    });

    expect(next.next).toMatchObject({
      src: previewUrl('flow/far.png', 'rev-a', 300),
      previewWidth: 300
    });
  });

  it('still skips new work for far culled images', () => {
    const source = resolveCanvasImageNodeSource({
      node: imageNode('flow/far.png', 2400, 1200, 2400, 'rev-a'),
      imageResourceZoom: 0.1,
      devicePixelRatio: 1,
      retryKey: 0
    });

    const next = canvasImageNodeAssetReducer(emptyState(), {
      type: 'source-resolved',
      source,
      cameraState: 'moving',
      culled: true,
      prefetch: false
    });

    expect(next.next).toBeUndefined();
  });

  it('promotes matching next loads and ignores stale load events', () => {
    const nextImage = {
      src: previewUrl('flow/cover.png', 'rev-a', 1200),
      loadKey: `${previewUrl('flow/cover.png', 'rev-a', 1200)}:0`,
      previewWidth: 1200
    };
    const state: CanvasImageNodeAssetState = {
      ...loadedState('flow/cover.png', 'rev-a', 300),
      next: nextImage
    };

    expect(canvasImageNodeAssetReducer(state, { type: 'next-loaded', loadKey: 'stale' })).toEqual(state);
    expect(canvasImageNodeAssetReducer(state, { type: 'next-loaded', loadKey: nextImage.loadKey })).toMatchObject({
      loaded: nextImage,
      next: undefined,
      error: undefined
    });
  });

  it('keeps loaded image when next load fails', () => {
    const failedLoadKey = `${previewUrl('flow/cover.png', 'rev-a', 1200)}:0`;
    const state: CanvasImageNodeAssetState = {
      ...loadedState('flow/cover.png', 'rev-a', 300),
      next: {
        src: previewUrl('flow/cover.png', 'rev-a', 1200),
        loadKey: failedLoadKey,
        previewWidth: 1200
      }
    };

    const next = canvasImageNodeAssetReducer(state, {
      type: 'next-failed',
      loadKey: failedLoadKey,
      message: 'Unable to load flow/cover.png.'
    });

    expect(next.loaded).toEqual(state.loaded);
    expect(next.next).toBeUndefined();
    expect(next.error).toMatchObject({ message: 'Unable to load flow/cover.png.' });
  });

  it('resets only the affected image state on source revision change', () => {
    const state: CanvasImageNodeAssetState = {
      ...loadedState('flow/cover.png', 'rev-a', 300),
      error: { loadKey: 'old', message: 'old error' }
    };
    const source = resolveCanvasImageNodeSource({
      node: imageNode('flow/cover.png', 200, 120, 2400, 'rev-b'),
      imageResourceZoom: 1,
      devicePixelRatio: 1,
      retryKey: 0
    });

    const next = canvasImageNodeAssetReducer(state, {
      type: 'source-resolved',
      source,
      cameraState: 'idle',
      culled: false
    });

    expect(next.sourceRevisionKey).toBe('flow/cover.png\u001frev-b');
    expect(next.loaded).toBeUndefined();
    expect(next.error).toBeUndefined();
    expect(next.next?.src).toBe(previewUrl('flow/cover.png', 'rev-b', 300));
  });

  it('derives placeholder, not-eligible, and image render states', () => {
    expect(deriveCanvasImageNodeRenderState({
      state: emptyState(),
      retry: () => undefined
    })).toMatchObject({ kind: 'placeholder' });

    expect(deriveCanvasImageNodeRenderState({
      state: emptyState(),
      retry: () => undefined,
      notEligible: true
    })).toEqual({ kind: 'not-eligible' });

    expect(deriveCanvasImageNodeRenderState({
      state: loadedState('flow/cover.png', 'rev-a', 300),
      retry: () => undefined
    })).toMatchObject({ kind: 'image', visible: { previewWidth: 300 } });
  });
});

function emptyState(): CanvasImageNodeAssetState {
  return {
    sourceRevisionKey: undefined,
    retryKey: 0,
    loaded: undefined,
    next: undefined,
    error: undefined
  };
}

function loadedState(path: string, revision: string, previewWidth: number): CanvasImageNodeAssetState {
  return {
    sourceRevisionKey: `${path}\u001f${revision}`,
    retryKey: 0,
    loaded: {
      src: previewUrl(path, revision, previewWidth),
      loadKey: `${previewUrl(path, revision, previewWidth)}:0`,
      previewWidth
    },
    next: undefined,
    error: undefined
  };
}

function imageNode(
  projectRelativePath: string,
  width: number,
  height: number,
  sourceWidth: number,
  revision: string
): ProjectedCanvasNode {
  return {
    projectRelativePath,
    nodeKind: 'file',
    mediaKind: 'image',
    x: 0,
    y: 0,
    width,
    height,
    z: 0,
    visible: true,
    locked: false,
    availability: {
      state: 'available',
      revision,
      size: 10_000,
      mimeType: 'image/png',
      fileUrl: `http://127.0.0.1:17321/api/projects/p/files/raw/${projectRelativePath}?v=${revision}`,
      canvasImagePreviewable: true,
      canvasImagePreviewSourceWidth: sourceWidth
    }
  };
}

function previewUrl(path: string, revision: string, width: number): string {
  return `http://127.0.0.1:17321/api/projects/p/canvas-image-preview?path=${encodeURIComponent(path)}&v=${revision}&w=${width}`;
}
