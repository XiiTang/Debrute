import { describe, expect, it, vi } from 'vitest';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import { canvasImageAssetViewportSignature, createCanvasImageAssetRuntime } from './CanvasImageAssetRuntime';
import type { CanvasImageLoadingPlanItem } from './canvasImageLoading';

describe('CanvasImageAssetRuntime', () => {
  it('promotes the pending image when the DOM next layer loads', () => {
    const runtime = createCanvasImageAssetRuntime({ concurrency: 1 });

    runtime.setNodes(new Map([['flow/a.png', largeImageNode('flow/a.png', 0, 0)]]));
    runtime.setViewport({
      ...viewport({ cameraState: 'idle', mountedNodePaths: new Set(['flow/a.png']) }),
      imageResourceZoom: 0.1
    });

    const pending = runtime.getNodeState('flow/a.png');
    expect(pending).toMatchObject({ kind: 'image', next: { loadKey: expect.any(String) } });
    expect(runtime.stats()).toMatchObject({ activeLoadCount: 1, pendingImageCount: 1, decodedImageCount: 0 });

    if (pending.kind !== 'image' || !pending.next) {
      throw new Error('Expected pending image state.');
    }
    runtime.resolvePending('flow/a.png', pending.next.loadKey);

    expect(runtime.getNodeState('flow/a.png')).toMatchObject({
      kind: 'image',
      visible: { loadKey: pending.next.loadKey }
    });
    expect(runtime.stats()).toMatchObject({ activeLoadCount: 0, pendingImageCount: 0, decodedImageCount: 1 });
  });

  it('publishes an image load error when the DOM next layer fails', () => {
    const runtime = createCanvasImageAssetRuntime({ concurrency: 1 });

    runtime.setNodes(new Map([['flow/a.png', largeImageNode('flow/a.png', 0, 0)]]));
    runtime.setViewport({
      ...viewport({ cameraState: 'idle', mountedNodePaths: new Set(['flow/a.png']) }),
      imageResourceZoom: 0.1
    });

    const pending = runtime.getNodeState('flow/a.png');
    if (pending.kind !== 'image' || !pending.next) {
      throw new Error('Expected pending image state.');
    }
    runtime.rejectPending('flow/a.png', pending.next.loadKey);

    expect(runtime.getNodeState('flow/a.png')).toMatchObject({
      kind: 'image',
      error: {
        loadKey: pending.next.loadKey,
        message: 'Unable to load flow/a.png.'
      }
    });
    expect(runtime.stats()).toMatchObject({ activeLoadCount: 0, pendingImageCount: 0, decodedImageCount: 0 });
  });

  it('keeps visible image state while a next image is pending', async () => {
    const loadKeys: string[] = [];
    const runtime = createCanvasImageAssetRuntime({
      concurrency: 1,
      loadImage: async (item) => {
        loadKeys.push(item.loadKey);
        return { src: item.src, loadKey: item.loadKey };
      }
    });

    runtime.setNodes(new Map([['flow/a.png', largeImageNode('flow/a.png', 0, 0)]]));
    runtime.setViewport({
      ...viewport({ cameraState: 'idle', mountedNodePaths: new Set(['flow/a.png']) }),
      imageResourceZoom: 0.1
    });
    await flushPromises();

    const visible = runtime.getNodeState('flow/a.png');
    expect(visible.kind).toBe('image');
    expect(visible.kind === 'image' ? visible.visible?.loadKey : undefined).toContain('w=256');

    runtime.setViewport({
      ...viewport({ cameraState: 'idle', mountedNodePaths: new Set(['flow/a.png']) }),
      imageResourceZoom: 1
    });

    const upgrading = runtime.getNodeState('flow/a.png');
    expect(upgrading.kind).toBe('image');
    expect(upgrading.kind === 'image' ? upgrading.visible : undefined).toBeDefined();
    expect(upgrading.kind === 'image' ? upgrading.next : undefined).toBeDefined();
    expect(loadKeys).toHaveLength(2);
  });

  it('does not start quality upgrades while the camera is moving', async () => {
    const loads: string[] = [];
    const runtime = createCanvasImageAssetRuntime({
      concurrency: 1,
      loadImage: async (item) => {
        loads.push(item.loadKey);
        return { src: item.src, loadKey: item.loadKey };
      }
    });

    runtime.setNodes(new Map([['flow/a.png', largeImageNode('flow/a.png', 0, 0)]]));
    runtime.setViewport({
      ...viewport({ cameraState: 'idle', mountedNodePaths: new Set(['flow/a.png']) }),
      imageResourceZoom: 0.1
    });
    await flushPromises();

    runtime.setViewport({
      ...viewport({ cameraState: 'moving', mountedNodePaths: new Set(['flow/a.png']) }),
      imageResourceZoom: 1
    });

    expect(loads).toHaveLength(1);
  });

  it('publishes loaded images to only the affected node subscriber', async () => {
    let resolveLoad: ((value: { src: string; loadKey: string }) => void) | undefined;
    const runtime = createCanvasImageAssetRuntime({
      concurrency: 1,
      loadImage: (item) => new Promise((resolve) => {
        resolveLoad = () => resolve({ src: item.src, loadKey: item.loadKey });
      })
    });
    const cover = vi.fn();
    const other = vi.fn();
    runtime.subscribeNode('flow/cover.png', cover);
    runtime.subscribeNode('flow/other.png', other);

    runtime.setNodes(new Map([
      ['flow/cover.png', imageNode('flow/cover.png', 0, 0)],
      ['flow/other.png', imageNode('flow/other.png', 5000, 0)]
    ]));
    runtime.setViewport(viewport({ cameraState: 'idle' }));
    cover.mockClear();
    other.mockClear();

    resolveLoad?.({ src: rawPreviewUrl('flow/cover.png', 256, 'rev'), loadKey: `${rawPreviewUrl('flow/cover.png', 256, 'rev')}:0` });
    await flushPromises();

    expect(cover).toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
    expect(runtime.getNodeState('flow/cover.png')).toMatchObject({
      kind: 'image',
      visible: { loadKey: expect.any(String) }
    });
  });

  it('rejects stale load results after a node revision changes', async () => {
    const resolveLoads: Array<(value: { src: string; loadKey: string }) => void> = [];
    const runtime = createCanvasImageAssetRuntime({
      concurrency: 1,
      loadImage: (item: CanvasImageLoadingPlanItem) => new Promise((resolve) => {
        resolveLoads.push(resolve);
      })
    });

    runtime.setNodes(new Map([['flow/cover.png', imageNode('flow/cover.png', 0, 0, 'rev-a')]]));
    runtime.setViewport(viewport({ cameraState: 'idle' }));
    runtime.setNodes(new Map([['flow/cover.png', imageNode('flow/cover.png', 0, 0, 'rev-b')]]));

    resolveLoads[0]?.({ src: rawPreviewUrl('flow/cover.png', 256, 'rev-a'), loadKey: `${rawPreviewUrl('flow/cover.png', 256, 'rev-a')}:0` });
    await flushPromises();

    expect(runtime.getNodeState('flow/cover.png')).toMatchObject({ kind: 'image', next: expect.any(Object) });
    expect(runtime.getNodeState('flow/cover.png')).not.toMatchObject({
      visible: { src: rawPreviewUrl('flow/cover.png', 256, 'rev-a') }
    });
  });

  it('releases a pending DOM image load when the node unmounts', () => {
    const runtime = createCanvasImageAssetRuntime({ concurrency: 1 });

    runtime.setNodes(new Map([
      ['flow/a.png', largeImageNode('flow/a.png', 0, 0)],
      ['flow/b.png', largeImageNode('flow/b.png', 0, 0)]
    ]));
    runtime.setViewport({
      ...viewport({
        cameraState: 'idle',
        mountedNodePaths: new Set(['flow/a.png', 'flow/b.png'])
      }),
      imageResourceZoom: 0.1
    });

    expect(runtime.getNodeState('flow/a.png')).toMatchObject({ kind: 'image', next: expect.any(Object) });
    expect(runtime.stats()).toMatchObject({ activeLoadCount: 1 });

    runtime.setNodes(new Map([
      ['flow/b.png', largeImageNode('flow/b.png', 0, 0)]
    ]));

    expect(runtime.getNodeState('flow/b.png')).toMatchObject({ kind: 'image', next: expect.any(Object) });
    expect(runtime.stats()).toMatchObject({ activeLoadCount: 1 });
  });

  it('cancels stale pending DOM image work when the node revision changes', () => {
    const runtime = createCanvasImageAssetRuntime({ concurrency: 1 });

    runtime.setNodes(new Map([['flow/cover.png', largeImageNode('flow/cover.png', 0, 0)]]));
    runtime.setViewport({
      ...viewport({
        cameraState: 'idle',
        mountedNodePaths: new Set(['flow/cover.png'])
      }),
      imageResourceZoom: 0.1
    });

    const oldState = runtime.getNodeState('flow/cover.png');
    if (oldState.kind !== 'image' || !oldState.next) {
      throw new Error('Expected pending image state.');
    }
    expect(oldState.next.loadKey).toContain('v=rev');

    runtime.setNodes(new Map([['flow/cover.png', largeImageNode('flow/cover.png', 0, 0, 'rev-b')]]));

    const nextState = runtime.getNodeState('flow/cover.png');
    expect(nextState).toMatchObject({ kind: 'image', next: expect.any(Object) });
    expect(nextState.kind === 'image' ? nextState.next?.loadKey : undefined).toContain('v=rev-b');
    expect(nextState.kind === 'image' ? nextState.next?.loadKey : undefined).not.toBe(oldState.next.loadKey);
    expect(runtime.stats()).toMatchObject({ activeLoadCount: 1 });
  });

  it('keeps moving viewport signatures stable while the effective blank visible image set is unchanged', () => {
    const nodes = new Map([
      ['flow/cover.png', { ...largeImageNode('flow/cover.png', 0, 0), width: 1200 }],
      ['flow/other.png', imageNode('flow/other.png', 1800, 0)]
    ]);
    const first = canvasImageAssetViewportSignature({
      ...viewport({
        cameraState: 'moving',
        mountedNodePaths: new Set(['flow/cover.png', 'flow/other.png'])
      }),
      visibleRect: { x: 0, y: 0, width: 400, height: 300 }
    }, nodes);
    const shifted = canvasImageAssetViewportSignature({
      ...viewport({
        cameraState: 'moving',
        mountedNodePaths: new Set(['flow/cover.png', 'flow/other.png'])
      }),
      visibleRect: { x: 80, y: 0, width: 400, height: 300 }
    }, nodes);
    const changed = canvasImageAssetViewportSignature({
      ...viewport({
        cameraState: 'moving',
        mountedNodePaths: new Set(['flow/cover.png', 'flow/other.png'])
      }),
      visibleRect: { x: 1700, y: 0, width: 400, height: 300 }
    }, nodes);

    expect(shifted).toBe(first);
    expect(changed).not.toBe(first);
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

function largeImageNode(path: string, x: number, y: number, revision = 'rev'): ProjectedCanvasNode {
  const node = imageNode(path, x, y, revision);
  const availability = node.availability as Extract<ProjectedCanvasNode['availability'], { state: 'available' }>;
  return {
    ...node,
    width: 2400,
    height: 1200,
    availability: {
      ...availability,
      canvasImagePreviewSourceWidth: 2400
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
