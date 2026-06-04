import { describe, expect, it, vi } from 'vitest';
import type { ProjectedCanvasNode } from '@axis/canvas-core';
import { createCanvasImageResourceController } from './CanvasImageResourceController';
import type { CanvasImageLoadingPlanItem } from './canvasImageLoading';

describe('CanvasImageResourceController', () => {
  it('loads only viewport-empty image work while the camera is moving', async () => {
    const loaded: string[] = [];
    const controller = createCanvasImageResourceController({
      concurrency: 4,
      loadImage: async (item) => {
        loaded.push(item.projectRelativePath);
        return { src: item.src, loadKey: item.loadKey };
      }
    });

    controller.setNodes(new Map([
      ['flow/visible.png', imageNode('flow/visible.png', 0, 0)],
      ['flow/overscan.png', imageNode('flow/overscan.png', 900, 0)]
    ]));
    controller.setViewport(viewport({ cameraState: 'moving' }));
    await flushPromises();

    expect(loaded).toEqual(['flow/visible.png']);
    expect(controller.getNodeState('flow/visible.png')).toMatchObject({ kind: 'image' });
    expect(controller.getNodeState('flow/overscan.png')).toMatchObject({ kind: 'placeholder' });
  });

  it('does not start moving loads for culled mounted nodes', async () => {
    const loaded: string[] = [];
    const controller = createCanvasImageResourceController({
      concurrency: 4,
      loadImage: async (item) => {
        loaded.push(item.projectRelativePath);
        return { src: item.src, loadKey: item.loadKey };
      }
    });

    controller.setNodes(new Map([
      ['flow/stale-visible.png', imageNode('flow/stale-visible.png', 0, 0)]
    ]));
    controller.setViewport(viewport({
      cameraState: 'moving',
      culledNodePaths: new Set(['flow/stale-visible.png'])
    }));
    await flushPromises();

    expect(loaded).toEqual([]);
    expect(controller.getNodeState('flow/stale-visible.png')).toMatchObject({ kind: 'placeholder' });
  });

  it('publishes loaded images to only the affected node subscriber', async () => {
    let resolveLoad: ((value: { src: string; loadKey: string }) => void) | undefined;
    const controller = createCanvasImageResourceController({
      concurrency: 1,
      loadImage: (item) => new Promise((resolve) => {
        resolveLoad = () => resolve({ src: item.src, loadKey: item.loadKey });
      })
    });
    const cover = vi.fn();
    const other = vi.fn();
    controller.subscribeNode('flow/cover.png', cover);
    controller.subscribeNode('flow/other.png', other);

    controller.setNodes(new Map([
      ['flow/cover.png', imageNode('flow/cover.png', 0, 0)],
      ['flow/other.png', imageNode('flow/other.png', 5000, 0)]
    ]));
    controller.setViewport(viewport({ cameraState: 'idle' }));
    cover.mockClear();
    other.mockClear();

    resolveLoad?.({ src: rawPreviewUrl('flow/cover.png', 256, 'rev'), loadKey: `${rawPreviewUrl('flow/cover.png', 256, 'rev')}:0` });
    await flushPromises();

    expect(cover).toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
    expect(controller.getNodeState('flow/cover.png')).toMatchObject({
      kind: 'image',
      loaded: { loadKey: expect.any(String) }
    });
  });

  it('rejects stale load results after a node revision changes', async () => {
    let resolveOld: ((value: { src: string; loadKey: string }) => void) | undefined;
    const controller = createCanvasImageResourceController({
      concurrency: 1,
      loadImage: (item: CanvasImageLoadingPlanItem) => new Promise((resolve) => {
        resolveOld = () => resolve({ src: item.src, loadKey: item.loadKey });
      })
    });

    controller.setNodes(new Map([['flow/cover.png', imageNode('flow/cover.png', 0, 0, 'rev-a')]]));
    controller.setViewport(viewport({ cameraState: 'idle' }));
    controller.setNodes(new Map([['flow/cover.png', imageNode('flow/cover.png', 0, 0, 'rev-b')]]));

    resolveOld?.({ src: rawPreviewUrl('flow/cover.png', 256, 'rev-a'), loadKey: `${rawPreviewUrl('flow/cover.png', 256, 'rev-a')}:0` });
    await flushPromises();

    expect(controller.getNodeState('flow/cover.png')).toMatchObject({ kind: 'image', pending: expect.any(Object) });
    expect(controller.getNodeState('flow/cover.png')).not.toMatchObject({
      loaded: { src: rawPreviewUrl('flow/cover.png', 256, 'rev-a') }
    });
  });

  it('keeps an in-flight load current when the viewport rebuilds with the same load key', async () => {
    let resolveLoad: ((value: { src: string; loadKey: string }) => void) | undefined;
    const controller = createCanvasImageResourceController({
      concurrency: 1,
      loadImage: (item: CanvasImageLoadingPlanItem) => new Promise((resolve) => {
        resolveLoad = () => resolve({ src: item.src, loadKey: item.loadKey });
      })
    });

    controller.setNodes(new Map([['flow/cover.png', imageNode('flow/cover.png', 0, 0)]]));
    controller.setViewport(viewport({ cameraState: 'idle' }));
    controller.setViewport(viewport({ cameraState: 'moving' }));

    resolveLoad?.({ src: rawPreviewUrl('flow/cover.png', 256, 'rev'), loadKey: `${rawPreviewUrl('flow/cover.png', 256, 'rev')}:0` });
    await flushPromises();

    expect(controller.getNodeState('flow/cover.png')).toMatchObject({
      kind: 'image',
      loaded: { src: rawPreviewUrl('flow/cover.png', 256, 'rev') }
    });
  });

  it('retry notifies only the affected node subscriber', () => {
    const controller = createCanvasImageResourceController({ loadImage: vi.fn() });
    const cover = vi.fn();
    const other = vi.fn();
    controller.subscribeNode('flow/cover.png', cover);
    controller.subscribeNode('flow/other.png', other);

    controller.retry('flow/cover.png');

    expect(cover).toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
  });

  it('does not keep failed load keys after a node unmounts from the render window', async () => {
    const loadImage = vi.fn(async (item: CanvasImageLoadingPlanItem) => {
      if (loadImage.mock.calls.length === 1) {
        throw new Error('first load failed');
      }
      return { src: item.src, loadKey: item.loadKey };
    });
    const controller = createCanvasImageResourceController({ loadImage });
    const node = imageNode('flow/cover.png', 0, 0);

    controller.setNodes(new Map([[node.projectRelativePath, node]]));
    controller.setViewport(viewport({ cameraState: 'idle' }));
    await flushPromises();
    expect(controller.getNodeState(node.projectRelativePath)).toMatchObject({
      kind: 'image',
      error: { loadKey: expect.any(String) }
    });

    controller.setNodes(new Map());
    controller.setNodes(new Map([[node.projectRelativePath, node]]));
    await flushPromises();

    expect(loadImage).toHaveBeenCalledTimes(2);
    expect(controller.getNodeState(node.projectRelativePath)).toMatchObject({
      kind: 'image',
      loaded: { loadKey: expect.any(String) }
    });
  });
});

function imageNode(path: string, x: number, y: number, revision = 'rev'): ProjectedCanvasNode {
  return {
    projectRelativePath: path,
    nodeKind: 'file',
    mediaKind: 'image',
    x,
    y,
    width: 200,
    height: 120,
    z: 0,
    visible: true,
    locked: false,
    availability: {
      state: 'available',
      size: 100,
      mimeType: 'image/png',
      canvasImagePreviewable: true,
      canvasImagePreviewSourceWidth: 200,
      fileUrl: rawUrl(path, revision),
      revision
    }
  };
}

function viewport(input: {
  cameraState: 'idle' | 'moving';
  mountedNodePaths?: ReadonlySet<string>;
  culledNodePaths?: ReadonlySet<string>;
}) {
  return {
    visibleRect: { x: 0, y: 0, width: 400, height: 300 },
    mountedNodePaths: input.mountedNodePaths ?? new Set(['flow/visible.png', 'flow/overscan.png', 'flow/cover.png', 'flow/other.png', 'flow/stale-visible.png']),
    culledNodePaths: input.culledNodePaths ?? new Set(),
    imageResourceZoom: 1,
    devicePixelRatio: 1,
    imagePreviewsEnabled: true,
    cameraState: input.cameraState
  };
}

function rawUrl(path: string, revision: string): string {
  return `http://127.0.0.1:17321/api/projects/p/files/raw/${path}?v=${revision}`;
}

function rawPreviewUrl(path: string, width: number, revision: string): string {
  return `http://127.0.0.1:17321/api/projects/p/canvas-image-preview?path=${encodeURIComponent(path)}&v=${revision}&w=${width}`;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
