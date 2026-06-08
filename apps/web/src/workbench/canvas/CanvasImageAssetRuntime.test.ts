import { describe, expect, it, vi } from 'vitest';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import { canvasImageAssetViewportSignature, createCanvasImageAssetRuntime } from './CanvasImageAssetRuntime';
import type { CanvasImageLoadingPlanItem } from './canvasImageLoading';
import { createCanvasPerfMonitor, type CanvasPerfTraceEvent } from './CanvasPerfMonitor';

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
        return { src: item.src, loadKey: item.loadKey, previewWidth: item.previewWidth };
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
    expect(visible.kind === 'image' ? visible.visible?.loadKey : undefined).toContain('w=300');

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

  it('upgrades visible images from dynamic low width to source width after idle zoom settles', async () => {
    const loadKeys: string[] = [];
    const runtime = createCanvasImageAssetRuntime({
      concurrency: 1,
      loadImage: async (item) => {
        loadKeys.push(item.loadKey);
        return { src: item.src, loadKey: item.loadKey, previewWidth: item.previewWidth };
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
    expect(visible.kind === 'image' ? visible.visible?.previewWidth : undefined).toBe(300);
    expect(visible.kind === 'image' ? visible.visible?.loadKey : undefined).toContain('w=300');

    runtime.setViewport({
      ...viewport({ cameraState: 'idle', mountedNodePaths: new Set(['flow/a.png']) }),
      imageResourceZoom: 1
    });

    const upgrading = runtime.getNodeState('flow/a.png');
    expect(upgrading.kind).toBe('image');
    expect(upgrading.kind === 'image' ? upgrading.visible?.previewWidth : undefined).toBe(300);
    expect(upgrading.kind === 'image' ? upgrading.next?.previewWidth : undefined).toBe(2400);
    expect(upgrading.kind === 'image' ? upgrading.next?.loadKey : undefined).toContain('w=2400');
    expect(loadKeys).toHaveLength(2);
  });

  it('does not start quality upgrades while the camera is moving', async () => {
    const loads: string[] = [];
    const runtime = createCanvasImageAssetRuntime({
      concurrency: 1,
      loadImage: async (item) => {
        loads.push(item.loadKey);
        return { src: item.src, loadKey: item.loadKey, previewWidth: item.previewWidth };
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

  it('blocks culled high-resolution prefetch while keeping display-critical loads moving', () => {
    const runtime = createCanvasImageAssetRuntime({ concurrency: 3 });
    runtime.setNodes(new Map([
      ['flow/visible.png', largeImageNode('flow/visible.png', 0, 0)],
      ['flow/prefetch-a.png', largeImageNode('flow/prefetch-a.png', 900, 0)],
      ['flow/prefetch-b.png', largeImageNode('flow/prefetch-b.png', 1000, 0)]
    ]));

    runtime.setViewport({
      ...viewport({
        cameraState: 'moving',
        mountedNodePaths: new Set(['flow/visible.png', 'flow/prefetch-a.png', 'flow/prefetch-b.png']),
        culledNodePaths: new Set(['flow/prefetch-a.png', 'flow/prefetch-b.png'])
      }),
      visibleRect: { x: 0, y: 0, width: 400, height: 300 },
      imageResourceZoom: 1
    });

    expect(runtime.getNodeState('flow/visible.png')).toMatchObject({ kind: 'image', next: expect.any(Object) });
    expect(runtime.getNodeState('flow/prefetch-a.png')).toMatchObject({ kind: 'placeholder' });
    expect(runtime.getNodeState('flow/prefetch-b.png')).toMatchObject({ kind: 'placeholder' });
    expect(runtime.stats()).toMatchObject({
      activeLoadCount: 1,
      pendingImageCount: 1,
      imageWorkIntentCounts: {
        'display-critical': 1,
        'prefetch-near': 1,
        deferred: 1
      },
      nextPreviewWidths: { 2400: 1 }
    });
  });

  it('publishes loaded images to only the affected node subscriber', async () => {
    let resolveLoad: ((value: { src: string; loadKey: string; previewWidth: number }) => void) | undefined;
    const runtime = createCanvasImageAssetRuntime({
      concurrency: 1,
      loadImage: (item) => new Promise((resolve) => {
        resolveLoad = () => resolve({ src: item.src, loadKey: item.loadKey, previewWidth: item.previewWidth });
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

    resolveLoad?.({ src: rawPreviewUrl('flow/cover.png', 200, 'rev'), loadKey: `${rawPreviewUrl('flow/cover.png', 200, 'rev')}:0`, previewWidth: 200 });
    await flushPromises();

    expect(cover).toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
    expect(runtime.getNodeState('flow/cover.png')).toMatchObject({
      kind: 'image',
      visible: { loadKey: expect.any(String) }
    });
  });

  it('rejects stale load results after a node revision changes', async () => {
    const resolveLoads: Array<(value: { src: string; loadKey: string; previewWidth: number }) => void> = [];
    const runtime = createCanvasImageAssetRuntime({
      concurrency: 1,
      loadImage: (item: CanvasImageLoadingPlanItem) => new Promise((resolve) => {
        resolveLoads.push(resolve);
      })
    });

    runtime.setNodes(new Map([['flow/cover.png', imageNode('flow/cover.png', 0, 0, 'rev-a')]]));
    runtime.setViewport(viewport({ cameraState: 'idle' }));
    runtime.setNodes(new Map([['flow/cover.png', imageNode('flow/cover.png', 0, 0, 'rev-b')]]));

    resolveLoads[0]?.({ src: rawPreviewUrl('flow/cover.png', 200, 'rev-a'), loadKey: `${rawPreviewUrl('flow/cover.png', 200, 'rev-a')}:0`, previewWidth: 200 });
    await flushPromises();

    expect(runtime.getNodeState('flow/cover.png')).toMatchObject({ kind: 'image', next: expect.any(Object) });
    expect(runtime.getNodeState('flow/cover.png')).not.toMatchObject({
      visible: { src: rawPreviewUrl('flow/cover.png', 200, 'rev-a') }
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

  it('changes moving viewport signatures when near blank images become visible-critical', () => {
    const nodes = new Map([
      ['flow/near-a.png', imageNode('flow/near-a.png', 700, 0)],
      ['flow/near-b.png', imageNode('flow/near-b.png', 820, 0)]
    ]);
    const mountedNodePaths = new Set(['flow/near-a.png', 'flow/near-b.png']);
    const first = canvasImageAssetViewportSignature({
      ...viewport({
        cameraState: 'moving',
        mountedNodePaths,
        culledNodePaths: new Set()
      }),
      visibleRect: { x: 0, y: 0, width: 400, height: 300 }
    }, nodes);
    const shifted = canvasImageAssetViewportSignature({
      ...viewport({
        cameraState: 'moving',
        mountedNodePaths,
        culledNodePaths: new Set()
      }),
      visibleRect: { x: 700, y: 0, width: 400, height: 300 }
    }, nodes);

    expect(shifted).not.toBe(first);
  });

  it('keeps moving viewport signatures stable while only already loaded visible images change', () => {
    const nodes = new Map([
      ['flow/loaded-a.png', imageNode('flow/loaded-a.png', 0, 0)],
      ['flow/loaded-b.png', imageNode('flow/loaded-b.png', 1800, 0)],
      ['flow/blank.png', imageNode('flow/blank.png', 3600, 0)]
    ]);
    const loadedImages = new Map([
      ['flow/loaded-a.png', {
        src: rawPreviewUrl('flow/loaded-a.png', 200, 'rev'),
        loadKey: `${rawPreviewUrl('flow/loaded-a.png', 200, 'rev')}:0`,
        previewWidth: 200
      }],
      ['flow/loaded-b.png', {
        src: rawPreviewUrl('flow/loaded-b.png', 200, 'rev'),
        loadKey: `${rawPreviewUrl('flow/loaded-b.png', 200, 'rev')}:0`,
        previewWidth: 200
      }]
    ]);
    const mountedNodePaths = new Set(['flow/loaded-a.png', 'flow/loaded-b.png', 'flow/blank.png']);

    const first = canvasImageAssetViewportSignature({
      ...viewport({ cameraState: 'moving', mountedNodePaths }),
      visibleRect: { x: 0, y: 0, width: 400, height: 300 }
    }, nodes, { loadedImages });
    const loadedOnlyShift = canvasImageAssetViewportSignature({
      ...viewport({ cameraState: 'moving', mountedNodePaths }),
      visibleRect: { x: 1700, y: 0, width: 400, height: 300 }
    }, nodes, { loadedImages });
    const blankShift = canvasImageAssetViewportSignature({
      ...viewport({ cameraState: 'moving', mountedNodePaths }),
      visibleRect: { x: 3500, y: 0, width: 400, height: 300 }
    }, nodes, { loadedImages });

    expect(loadedOnlyShift).toBe(first);
    expect(blankShift).not.toBe(first);
  });

  it('changes the moving viewport signature only when retention preview width changes for loaded images', () => {
    const node = largeImageNode('flow/a.png', 0, 0);
    const loadedHigh = {
      src: rawPreviewUrl('flow/a.png', 2400, 'rev'),
      loadKey: `${rawPreviewUrl('flow/a.png', 2400, 'rev')}:0`,
      previewWidth: 2400
    };
    const baseViewport = {
      ...viewport({
        cameraState: 'moving',
        mountedNodePaths: new Set(['flow/a.png'])
      }),
      imageResourceZoom: 1,
      retentionResourceZoom: 0.11
    };
    const sameBucketViewport = {
      ...baseViewport,
      retentionResourceZoom: 0.12
    };
    const lowerBucketViewport = {
      ...baseViewport,
      retentionResourceZoom: 0.04
    };

    expect(canvasImageAssetViewportSignature(
      baseViewport,
      new Map([['flow/a.png', node]]),
      { loadedImages: new Map([['flow/a.png', loadedHigh]]) }
    )).toBe(canvasImageAssetViewportSignature(
      sameBucketViewport,
      new Map([['flow/a.png', node]]),
      { loadedImages: new Map([['flow/a.png', loadedHigh]]) }
    ));

    expect(canvasImageAssetViewportSignature(
      baseViewport,
      new Map([['flow/a.png', node]]),
      { loadedImages: new Map([['flow/a.png', loadedHigh]]) }
    )).not.toBe(canvasImageAssetViewportSignature(
      lowerBucketViewport,
      new Map([['flow/a.png', node]]),
      { loadedImages: new Map([['flow/a.png', loadedHigh]]) }
    ));
  });

  it('records image-load sessions for start and DOM resolve', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const runtime = createCanvasImageAssetRuntime({ concurrency: 1, perfMonitor: monitor });
    runtime.subscribeNode('flow/a.png', () => undefined);

    runtime.setNodes(new Map([['flow/a.png', largeImageNode('flow/a.png', 0, 0)]]));
    runtime.setViewport({
      ...viewport({ cameraState: 'idle', mountedNodePaths: new Set(['flow/a.png']) }),
      imageResourceZoom: 0.1
    });

    const pending = runtime.getNodeState('flow/a.png');
    if (pending.kind !== 'image' || !pending.next) {
      throw new Error('Expected pending image state.');
    }
    runtime.resolvePending('flow/a.png', pending.next.loadKey);

    const imageLoadSummary = monitor.getTrace().sessions.find((session) => session.type === 'image-load');
    expect(imageLoadSummary).toMatchObject({
      type: 'image-load',
      mountedNodeCount: 1,
      visibleNodeCount: 1,
      culledNodeCount: 0,
      activeImageLoadCount: 0,
      pendingImageCount: 0,
      decodedImageCount: 1,
      zoomLevel: 0.1,
      cameraState: 'idle',
      counters: {
        'image-load-start': 1,
        'image-load-resolve': 1
      }
    });
    expect(counterNames(monitor.getTrace().events)).toEqual(expect.arrayContaining([
      'image-plan-rebuild',
      'image-pump',
      'image-load-start',
      'image-node-publish',
      'image-load-resolve'
    ]));
  });

  it('records rejected image-load sessions and starts a new session on retry', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const runtime = createCanvasImageAssetRuntime({ concurrency: 1, perfMonitor: monitor });

    runtime.setNodes(new Map([['flow/a.png', largeImageNode('flow/a.png', 0, 0)]]));
    runtime.setViewport({
      ...viewport({ cameraState: 'idle', mountedNodePaths: new Set(['flow/a.png']) }),
      imageResourceZoom: 0.1
    });

    const pending = runtime.getNodeState('flow/a.png');
    if (pending.kind !== 'image' || !pending.next) {
      throw new Error('Expected pending image state.');
    }
    const rejectedLoadKey = pending.next.loadKey;
    runtime.rejectPending('flow/a.png', rejectedLoadKey);

    const rejected = runtime.getNodeState('flow/a.png');
    if (rejected.kind !== 'image' || !rejected.error) {
      throw new Error('Expected rejected image state.');
    }
    rejected.retry();

    const retrying = runtime.getNodeState('flow/a.png');
    if (retrying.kind !== 'image' || !retrying.next) {
      throw new Error('Expected retry image state.');
    }
    runtime.resolvePending('flow/a.png', retrying.next.loadKey);

    const sessions = monitor.getTrace().sessions.filter((session) => session.type === 'image-load');
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      counters: {
        'image-load-start': 1,
        'image-load-reject': 1
      },
      detail: {
        loadKey: rejectedLoadKey,
        result: 'image-load-reject'
      }
    });
    expect(sessions[1]).toMatchObject({
      counters: {
        'image-load-start': 1,
        'image-load-resolve': 1
      },
      detail: {
        loadKey: retrying.next.loadKey,
        result: 'image-load-resolve'
      }
    });
    expect(retrying.next.loadKey).not.toBe(rejectedLoadKey);
  });

  it('keeps concurrent image-load session counters scoped to their load key', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const runtime = createCanvasImageAssetRuntime({ concurrency: 2, perfMonitor: monitor });
    runtime.setNodes(new Map([
      ['flow/a.png', largeImageNode('flow/a.png', 0, 0)],
      ['flow/b.png', largeImageNode('flow/b.png', 2600, 0)]
    ]));
    runtime.setViewport({
      ...viewport({
        cameraState: 'idle',
        mountedNodePaths: new Set(['flow/a.png', 'flow/b.png'])
      }),
      visibleRect: { x: 0, y: 0, width: 6000, height: 2000 },
      imageResourceZoom: 0.1
    });

    const pendingA = runtime.getNodeState('flow/a.png');
    const pendingB = runtime.getNodeState('flow/b.png');
    if (pendingA.kind !== 'image' || !pendingA.next || pendingB.kind !== 'image' || !pendingB.next) {
      throw new Error('Expected both images to have pending load state.');
    }
    runtime.resolvePending('flow/a.png', pendingA.next.loadKey);
    runtime.resolvePending('flow/b.png', pendingB.next.loadKey);

    const sessionsByPath = new Map(
      monitor.getTrace().sessions
        .filter((session) => session.type === 'image-load')
        .map((session) => [session.detail?.projectRelativePath, session])
    );

    expect(sessionsByPath.get('flow/a.png')?.counters).toEqual({
      'image-load-start': 1,
      'image-load-resolve': 1
    });
    expect(sessionsByPath.get('flow/b.png')?.counters).toEqual({
      'image-load-start': 1,
      'image-load-resolve': 1
    });
  });

  it('records stale async image results without publishing visible state', async () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const resolveLoads: Array<(value: { src: string; loadKey: string; previewWidth: number }) => void> = [];
    const runtime = createCanvasImageAssetRuntime({
      concurrency: 1,
      perfMonitor: monitor,
      loadImage: () => new Promise((resolve) => {
        resolveLoads.push(resolve);
      })
    });

    runtime.setNodes(new Map([['flow/cover.png', imageNode('flow/cover.png', 0, 0, 'rev-a')]]));
    runtime.setViewport(viewport({ cameraState: 'idle' }));
    runtime.setNodes(new Map([['flow/cover.png', imageNode('flow/cover.png', 0, 0, 'rev-b')]]));

    resolveLoads[0]?.({
      src: rawPreviewUrl('flow/cover.png', 200, 'rev-a'),
      loadKey: `${rawPreviewUrl('flow/cover.png', 200, 'rev-a')}:0`,
      previewWidth: 200
    });
    await flushPromises();

    expect(counterNames(monitor.getTrace().events)).toContain('image-load-stale-result');
    expect(runtime.getNodeState('flow/cover.png')).not.toMatchObject({
      visible: { src: rawPreviewUrl('flow/cover.png', 200, 'rev-a') }
    });
  });

  it('records moving viewport reuse without rebuilding the image plan', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const runtime = createCanvasImageAssetRuntime({ concurrency: 1, perfMonitor: monitor });
    const nodes = new Map([
      ['flow/cover.png', { ...largeImageNode('flow/cover.png', 0, 0), width: 1200 }],
      ['flow/other.png', imageNode('flow/other.png', 1800, 0)]
    ]);
    runtime.setNodes(nodes);
    runtime.setViewport({
      ...viewport({ cameraState: 'moving', mountedNodePaths: new Set(['flow/cover.png', 'flow/other.png']) }),
      visibleRect: { x: 0, y: 0, width: 400, height: 300 }
    });
    const firstPlanRebuildCount = counterNames(monitor.getTrace().events).filter((name) => name === 'image-plan-rebuild').length;

    runtime.setViewport({
      ...viewport({ cameraState: 'moving', mountedNodePaths: new Set(['flow/cover.png', 'flow/other.png']) }),
      visibleRect: { x: 80, y: 0, width: 400, height: 300 }
    });

    expect(counterNames(monitor.getTrace().events)).toContain('image-viewport-noop');
    expect(counterNames(monitor.getTrace().events).filter((name) => name === 'image-plan-rebuild')).toHaveLength(firstPlanRebuildCount);
  });

  it('does not rebuild the moving image plan when the newly visible image is already loaded', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const runtime = createCanvasImageAssetRuntime({ concurrency: 2, perfMonitor: monitor });
    const nodes = new Map([
      ['flow/a.png', largeImageNode('flow/a.png', 0, 0)],
      ['flow/b.png', largeImageNode('flow/b.png', 1800, 0)]
    ]);
    runtime.setNodes(nodes);
    runtime.setViewport({
      ...viewport({
        cameraState: 'idle',
        mountedNodePaths: new Set(['flow/a.png', 'flow/b.png'])
      }),
      visibleRect: { x: 0, y: 0, width: 3000, height: 1200 },
      imageResourceZoom: 0.1
    });

    const pendingA = runtime.getNodeState('flow/a.png');
    const pendingB = runtime.getNodeState('flow/b.png');
    if (pendingA.kind !== 'image' || !pendingA.next || pendingB.kind !== 'image' || !pendingB.next) {
      throw new Error('Expected both images to start loading.');
    }
    runtime.resolvePending('flow/a.png', pendingA.next.loadKey);
    runtime.resolvePending('flow/b.png', pendingB.next.loadKey);

    runtime.setViewport({
      ...viewport({
        cameraState: 'moving',
        mountedNodePaths: new Set(['flow/a.png', 'flow/b.png'])
      }),
      visibleRect: { x: 0, y: 0, width: 400, height: 300 },
      imageResourceZoom: 0.1
    });
    const rebuildCount = counterNames(monitor.getTrace().events)
      .filter((name) => name === 'image-plan-rebuild')
      .length;

    runtime.setViewport({
      ...viewport({
        cameraState: 'moving',
        mountedNodePaths: new Set(['flow/a.png', 'flow/b.png'])
      }),
      visibleRect: { x: 1700, y: 0, width: 400, height: 300 },
      imageResourceZoom: 0.1
    });

    expect(counterNames(monitor.getTrace().events)).toContain('image-viewport-noop');
    expect(counterNames(monitor.getTrace().events).filter((name) => name === 'image-plan-rebuild')).toHaveLength(rebuildCount);
  });

  it('does not rebuild the moving image plan when only zoom and DPR change over already loaded visible images', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const runtime = createCanvasImageAssetRuntime({ concurrency: 2, perfMonitor: monitor });
    const nodes = new Map([
      ['flow/a.png', largeImageNode('flow/a.png', 0, 0)],
      ['flow/b.png', largeImageNode('flow/b.png', 1800, 0)]
    ]);
    runtime.setNodes(nodes);
    runtime.setViewport({
      ...viewport({
        cameraState: 'idle',
        mountedNodePaths: new Set(['flow/a.png', 'flow/b.png'])
      }),
      visibleRect: { x: 0, y: 0, width: 3000, height: 1200 },
      imageResourceZoom: 0.1,
      devicePixelRatio: 1
    });

    const pendingA = runtime.getNodeState('flow/a.png');
    const pendingB = runtime.getNodeState('flow/b.png');
    if (pendingA.kind !== 'image' || !pendingA.next || pendingB.kind !== 'image' || !pendingB.next) {
      throw new Error('Expected both images to start loading.');
    }
    runtime.resolvePending('flow/a.png', pendingA.next.loadKey);
    runtime.resolvePending('flow/b.png', pendingB.next.loadKey);

    runtime.setViewport({
      ...viewport({
        cameraState: 'moving',
        mountedNodePaths: new Set(['flow/a.png', 'flow/b.png'])
      }),
      visibleRect: { x: 0, y: 0, width: 400, height: 300 },
      imageResourceZoom: 0.1,
      devicePixelRatio: 1
    });
    const rebuildCount = counterNames(monitor.getTrace().events)
      .filter((name) => name === 'image-plan-rebuild')
      .length;
    const publishCount = counterNames(monitor.getTrace().events)
      .filter((name) => name === 'image-node-publish')
      .length;

    runtime.setViewport({
      ...viewport({
        cameraState: 'moving',
        mountedNodePaths: new Set(['flow/a.png', 'flow/b.png'])
      }),
      visibleRect: { x: 0, y: 0, width: 400, height: 300 },
      imageResourceZoom: 1,
      devicePixelRatio: 2
    });

    expect(counterNames(monitor.getTrace().events)).toContain('image-viewport-noop');
    expect(counterNames(monitor.getTrace().events).filter((name) => name === 'image-plan-rebuild')).toHaveLength(rebuildCount);
    expect(counterNames(monitor.getTrace().events).filter((name) => name === 'image-node-publish')).toHaveLength(publishCount);
  });

  it('does not rebuild the image plan when entering moving over already loaded visible images', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const runtime = createCanvasImageAssetRuntime({ concurrency: 2, perfMonitor: monitor });
    runtime.setNodes(new Map([
      ['flow/a.png', largeImageNode('flow/a.png', 0, 0)],
      ['flow/b.png', largeImageNode('flow/b.png', 1800, 0)]
    ]));
    runtime.setViewport({
      ...viewport({
        cameraState: 'idle',
        mountedNodePaths: new Set(['flow/a.png', 'flow/b.png'])
      }),
      visibleRect: { x: 0, y: 0, width: 3000, height: 1200 },
      imageResourceZoom: 0.1
    });

    const pendingA = runtime.getNodeState('flow/a.png');
    const pendingB = runtime.getNodeState('flow/b.png');
    if (pendingA.kind !== 'image' || !pendingA.next || pendingB.kind !== 'image' || !pendingB.next) {
      throw new Error('Expected both images to start loading.');
    }
    runtime.resolvePending('flow/a.png', pendingA.next.loadKey);
    runtime.resolvePending('flow/b.png', pendingB.next.loadKey);
    const rebuildCount = counterNames(monitor.getTrace().events)
      .filter((name) => name === 'image-plan-rebuild')
      .length;

    runtime.setViewport({
      ...viewport({
        cameraState: 'moving',
        mountedNodePaths: new Set(['flow/a.png', 'flow/b.png'])
      }),
      visibleRect: { x: 0, y: 0, width: 400, height: 300 },
      imageResourceZoom: 0.1
    });

    expect(counterNames(monitor.getTrace().events)).toContain('image-viewport-noop');
    expect(counterNames(monitor.getTrace().events).filter((name) => name === 'image-plan-rebuild')).toHaveLength(rebuildCount);
  });

  it('does not rebuild the moving image plan when setNodes changes loaded image revisions without changing blank visible candidates', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const runtime = createCanvasImageAssetRuntime({ concurrency: 1, perfMonitor: monitor });
    runtime.setNodes(new Map([['flow/a.png', largeImageNode('flow/a.png', 0, 0, 'rev-a')]]));
    runtime.setViewport({
      ...viewport({
        cameraState: 'idle',
        mountedNodePaths: new Set(['flow/a.png'])
      }),
      imageResourceZoom: 0.1
    });

    const pending = runtime.getNodeState('flow/a.png');
    if (pending.kind !== 'image' || !pending.next) {
      throw new Error('Expected initial image to be pending.');
    }
    runtime.resolvePending('flow/a.png', pending.next.loadKey);

    runtime.setViewport({
      ...viewport({
        cameraState: 'moving',
        mountedNodePaths: new Set(['flow/a.png'])
      }),
      imageResourceZoom: 0.1
    });
    const rebuildCount = counterNames(monitor.getTrace().events)
      .filter((name) => name === 'image-plan-rebuild')
      .length;

    runtime.setNodes(new Map([['flow/a.png', largeImageNode('flow/a.png', 0, 0, 'rev-b')]]));

    expect(counterNames(monitor.getTrace().events).filter((name) => name === 'image-plan-rebuild')).toHaveLength(rebuildCount);
    const moving = runtime.getNodeState('flow/a.png');
    expect(moving.kind === 'image' ? moving.visible?.loadKey : undefined).toContain('rev-a');
    expect(moving.kind === 'image' ? moving.next : undefined).toBeUndefined();

    runtime.setViewport({
      ...viewport({
        cameraState: 'idle',
        mountedNodePaths: new Set(['flow/a.png'])
      }),
      imageResourceZoom: 0.1
    });
    const idle = runtime.getNodeState('flow/a.png');
    expect(idle.kind === 'image' ? idle.next?.loadKey : undefined).toContain('rev-b');
  });

  it('rebuilds the moving image plan when setNodes changes a blank visible candidate revision', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const runtime = createCanvasImageAssetRuntime({ concurrency: 1, perfMonitor: monitor });
    runtime.setNodes(new Map([['flow/a.png', largeImageNode('flow/a.png', 0, 0, 'rev-a')]]));
    runtime.setViewport({
      ...viewport({
        cameraState: 'moving',
        mountedNodePaths: new Set(['flow/a.png'])
      }),
      imageResourceZoom: 0.1
    });

    const pending = runtime.getNodeState('flow/a.png');
    if (pending.kind !== 'image' || !pending.next) {
      throw new Error('Expected initial image to be pending.');
    }
    const rebuildCount = counterNames(monitor.getTrace().events)
      .filter((name) => name === 'image-plan-rebuild')
      .length;

    runtime.setNodes(new Map([['flow/a.png', largeImageNode('flow/a.png', 0, 0, 'rev-b')]]));

    expect(counterNames(monitor.getTrace().events).filter((name) => name === 'image-plan-rebuild')).toHaveLength(rebuildCount + 1);
    const nextState = runtime.getNodeState('flow/a.png');
    expect(nextState.kind === 'image' ? nextState.next?.loadKey : undefined).toContain('rev-b');

    runtime.resolvePending('flow/a.png', pending.next.loadKey);

    expect(counterNames(monitor.getTrace().events)).toContain('image-load-stale-result');
    expect(runtime.getNodeState('flow/a.png')).not.toMatchObject({
      visible: { loadKey: pending.next.loadKey }
    });
  });

  it('cancels an in-flight image upgrade when the camera enters moving and retries the upgrade after idle', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const runtime = createCanvasImageAssetRuntime({ concurrency: 1, perfMonitor: monitor });
    runtime.setNodes(new Map([['flow/a.png', largeImageNode('flow/a.png', 0, 0, 'rev-a')]]));
    runtime.setViewport({
      ...viewport({
        cameraState: 'idle',
        mountedNodePaths: new Set(['flow/a.png'])
      }),
      imageResourceZoom: 0.1
    });

    const initial = runtime.getNodeState('flow/a.png');
    if (initial.kind !== 'image' || !initial.next) {
      throw new Error('Expected initial image to be pending.');
    }
    runtime.resolvePending('flow/a.png', initial.next.loadKey);

    runtime.setViewport({
      ...viewport({
        cameraState: 'idle',
        mountedNodePaths: new Set(['flow/a.png'])
      }),
      imageResourceZoom: 1
    });
    const upgrade = runtime.getNodeState('flow/a.png');
    if (upgrade.kind !== 'image' || !upgrade.visible || !upgrade.next) {
      throw new Error('Expected idle upgrade to be pending over a visible image.');
    }

    runtime.setViewport({
      ...viewport({
        cameraState: 'moving',
        mountedNodePaths: new Set(['flow/a.png'])
      }),
      imageResourceZoom: 1
    });

    const moving = runtime.getNodeState('flow/a.png');
    expect(moving.kind === 'image' ? moving.visible?.loadKey : undefined).toBe(upgrade.visible.loadKey);
    expect(moving.kind === 'image' ? moving.next : undefined).toBeUndefined();
    expect(runtime.stats()).toMatchObject({
      activeLoadCount: 0,
      pendingImageCount: 0,
      imageCancellationReasons: { 'moving-upgrade': 1 }
    });

    runtime.resolvePending('flow/a.png', upgrade.next.loadKey);

    expect(counterNames(monitor.getTrace().events)).toContain('image-load-stale-result');
    expect(runtime.getNodeState('flow/a.png')).toMatchObject({
      kind: 'image',
      visible: { loadKey: upgrade.visible.loadKey }
    });

    runtime.setViewport({
      ...viewport({
        cameraState: 'idle',
        mountedNodePaths: new Set(['flow/a.png'])
      }),
      imageResourceZoom: 1
    });

    const idle = runtime.getNodeState('flow/a.png');
    expect(idle.kind === 'image' ? idle.next?.loadKey : undefined).toBe(upgrade.next.loadKey);
  });

  it('reuses the idle image plan when setNodes receives the same image source identities', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const runtime = createCanvasImageAssetRuntime({ concurrency: 1, perfMonitor: monitor });
    const node = largeImageNode('flow/a.png', 0, 0, 'rev-a');
    runtime.setNodes(new Map([['flow/a.png', node]]));
    runtime.setViewport({
      ...viewport({
        cameraState: 'idle',
        mountedNodePaths: new Set(['flow/a.png'])
      }),
      imageResourceZoom: 0.1
    });

    const pending = runtime.getNodeState('flow/a.png');
    if (pending.kind !== 'image' || !pending.next) {
      throw new Error('Expected initial image to be pending.');
    }
    runtime.resolvePending('flow/a.png', pending.next.loadKey);
    const rebuildCount = counterNames(monitor.getTrace().events)
      .filter((name) => name === 'image-plan-rebuild')
      .length;

    runtime.setNodes(new Map([['flow/a.png', { ...node }]]));

    expect(counterNames(monitor.getTrace().events)).toContain('image-plan-reuse');
    expect(counterNames(monitor.getTrace().events).filter((name) => name === 'image-plan-rebuild')).toHaveLength(rebuildCount);
  });

  it('rebuilds the moving image plan when setNodes introduces a newly visible blank image candidate', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const runtime = createCanvasImageAssetRuntime({ concurrency: 1, perfMonitor: monitor });
    runtime.setNodes(new Map([['flow/a.png', largeImageNode('flow/a.png', 0, 0)]]));
    runtime.setViewport({
      ...viewport({
        cameraState: 'idle',
        mountedNodePaths: new Set(['flow/a.png'])
      }),
      imageResourceZoom: 0.1
    });
    const pending = runtime.getNodeState('flow/a.png');
    if (pending.kind !== 'image' || !pending.next) {
      throw new Error('Expected initial image to be pending.');
    }
    runtime.resolvePending('flow/a.png', pending.next.loadKey);

    runtime.setViewport({
      ...viewport({
        cameraState: 'moving',
        mountedNodePaths: new Set(['flow/a.png', 'flow/new.png'])
      }),
      visibleRect: { x: 0, y: 0, width: 400, height: 300 },
      imageResourceZoom: 0.1
    });
    const rebuildCount = counterNames(monitor.getTrace().events)
      .filter((name) => name === 'image-plan-rebuild')
      .length;

    runtime.setNodes(new Map([
      ['flow/a.png', largeImageNode('flow/a.png', 0, 0)],
      ['flow/new.png', largeImageNode('flow/new.png', 100, 0)]
    ]));

    expect(counterNames(monitor.getTrace().events).filter((name) => name === 'image-plan-rebuild')).toHaveLength(rebuildCount + 1);
    const state = runtime.getNodeState('flow/new.png');
    expect(state.kind === 'image' ? state.next : undefined).toBeDefined();
  });

  it('starts visible and near-overscan image loads from an idle viewport without requiring camera movement', () => {
    const runtime = createCanvasImageAssetRuntime({ concurrency: 3 });
    runtime.setNodes(new Map([
      ['flow/visible.png', largeImageNode('flow/visible.png', 0, 0)],
      ['flow/overscan.png', largeImageNode('flow/overscan.png', 900, 0)],
      ['flow/far.png', largeImageNode('flow/far.png', 5000, 0)]
    ]));

    runtime.setViewport({
      ...viewport({
        cameraState: 'idle',
        mountedNodePaths: new Set(['flow/visible.png', 'flow/overscan.png', 'flow/far.png'])
      }),
      visibleRect: { x: 0, y: 0, width: 400, height: 300 },
      imageResourceZoom: 1
    });

    const visible = runtime.getNodeState('flow/visible.png');
    const overscan = runtime.getNodeState('flow/overscan.png');
    const far = runtime.getNodeState('flow/far.png');
    expect(visible.kind === 'image' ? visible.next : undefined).toBeDefined();
    expect(overscan.kind === 'image' ? overscan.next : undefined).toBeDefined();
    expect(far.kind === 'image' ? far.next : undefined).toBeUndefined();
    expect(runtime.stats()).toMatchObject({
      activeLoadCount: 2,
      pendingImageCount: 2
    });
  });

  it('blocks high-resolution pending images beyond the runtime budget', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const runtime = createCanvasImageAssetRuntime({
      concurrency: 3,
      budget: { maxHighResolutionPendingImages: 1 },
      perfMonitor: monitor
    });
    runtime.setNodes(new Map([
      ['flow/a.png', largeImageNode('flow/a.png', 0, 0)],
      ['flow/b.png', largeImageNode('flow/b.png', 2600, 0)]
    ]));

    runtime.setViewport({
      ...viewport({
        cameraState: 'idle',
        mountedNodePaths: new Set(['flow/a.png', 'flow/b.png'])
      }),
      visibleRect: { x: 0, y: 0, width: 6000, height: 2000 },
      imageResourceZoom: 1
    });

    expect(runtime.stats()).toMatchObject({
      activeLoadCount: 1,
      pendingImageCount: 1,
      nextPreviewWidths: { 2400: 1 }
    });
    expect(counterNames(monitor.getTrace().events)).toContain('image-budget-block');
  });

  it('limits source-width idle upgrades to one replacement in image-heavy efficient mode', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const runtime = createCanvasImageAssetRuntime({
      concurrency: 3,
      budget: { maxHighResolutionPendingImages: 3 },
      perfMonitor: monitor
    });
    runtime.setNodes(new Map([
      ['flow/a.png', largeImageNode('flow/a.png', 0, 0)],
      ['flow/b.png', largeImageNode('flow/b.png', 2600, 0)],
      ['flow/c.png', largeImageNode('flow/c.png', 5200, 0)]
    ]));
    const allVisibleLowResolution = {
      ...viewport({
        cameraState: 'idle',
        mountedNodePaths: new Set(['flow/a.png', 'flow/b.png', 'flow/c.png'])
      }),
      visibleRect: { x: 0, y: 0, width: 8000, height: 2000 },
      imageResourceZoom: 0.1
    };
    runtime.setViewport(allVisibleLowResolution);

    const pendingA = runtime.getNodeState('flow/a.png');
    const pendingB = runtime.getNodeState('flow/b.png');
    const pendingC = runtime.getNodeState('flow/c.png');
    if (pendingA.kind !== 'image' || !pendingA.next || pendingB.kind !== 'image' || !pendingB.next || pendingC.kind !== 'image' || !pendingC.next) {
      throw new Error('Expected all low-resolution images to be pending.');
    }
    runtime.resolvePending('flow/a.png', pendingA.next.loadKey);
    runtime.resolvePending('flow/b.png', pendingB.next.loadKey);
    runtime.resolvePending('flow/c.png', pendingC.next.loadKey);

    runtime.setViewport({
      ...allVisibleLowResolution,
      imageResourceZoom: 1,
      imageHeavyEfficientMode: true
    });

    expect(runtime.stats()).toMatchObject({
      activeLoadCount: 1,
      pendingImageCount: 1,
      visiblePreviewWidths: { 300: 3 },
      nextPreviewWidths: { 2400: 1 }
    });
    expect(counterNames(monitor.getTrace().events)).toContain('image-budget-block');
  });

  it('does not block screen-visible high-resolution upgrades on retained preview budget', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const runtime = createCanvasImageAssetRuntime({
      concurrency: 3,
      budget: {
        hardRetainedDecodedImagePixels: 4_000_000,
        maxHighResolutionPendingImages: 3,
        maxSourceWidthUpgradePendingImages: 3
      },
      perfMonitor: monitor
    });
    runtime.setNodes(new Map([
      ['flow/a.png', largeImageNode('flow/a.png', 0, 0)],
      ['flow/b.png', largeImageNode('flow/b.png', 2600, 0)]
    ]));
    const lowResolutionViewport = {
      ...viewport({
        cameraState: 'idle',
        mountedNodePaths: new Set(['flow/a.png', 'flow/b.png'])
      }),
      visibleRect: { x: 0, y: 0, width: 6000, height: 2000 },
      imageResourceZoom: 0.1,
      retentionResourceZoom: 0.1,
      imageHeavyEfficientMode: true
    };
    runtime.setViewport(lowResolutionViewport);
    for (const path of ['flow/a.png', 'flow/b.png']) {
      const state = runtime.getNodeState(path);
      if (state.kind !== 'image' || !state.next) {
        throw new Error(`Expected ${path} low-resolution load.`);
      }
      runtime.resolvePending(path, state.next.loadKey);
    }

    runtime.setViewport({
      ...lowResolutionViewport,
      imageResourceZoom: 1,
      retentionResourceZoom: 1
    });

    expect(runtime.stats()).toMatchObject({
      activeLoadCount: 2,
      pendingImageCount: 2,
      visiblePreviewWidths: { 300: 2 },
      nextPreviewWidths: { 2400: 2 }
    });
    expect(counterNames(monitor.getTrace().events)).not.toContain('image-budget-block');
  });

  it('keeps retained preview budget blocking near high-resolution upgrades after visible upgrades are scheduled', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const runtime = createCanvasImageAssetRuntime({
      concurrency: 3,
      budget: {
        hardRetainedDecodedImagePixels: 4_000_000,
        maxHighResolutionPendingImages: 3,
        maxSourceWidthUpgradePendingImages: 3
      },
      perfMonitor: monitor
    });
    runtime.setNodes(new Map([
      ['flow/visible.png', largeImageNode('flow/visible.png', 0, 0)],
      ['flow/near.png', largeImageNode('flow/near.png', 700, 0)]
    ]));
    const lowResolutionViewport = {
      ...viewport({
        cameraState: 'idle',
        mountedNodePaths: new Set(['flow/visible.png', 'flow/near.png'])
      }),
      visibleRect: { x: 0, y: 0, width: 3600, height: 2000 },
      imageResourceZoom: 0.1,
      retentionResourceZoom: 0.1,
      imageHeavyEfficientMode: true
    };
    runtime.setViewport(lowResolutionViewport);
    for (const path of ['flow/visible.png', 'flow/near.png']) {
      const state = runtime.getNodeState(path);
      if (state.kind !== 'image' || !state.next) {
        throw new Error(`Expected ${path} low-resolution load.`);
      }
      runtime.resolvePending(path, state.next.loadKey);
    }

    runtime.setViewport({
      ...lowResolutionViewport,
      visibleRect: { x: 0, y: 0, width: 400, height: 300 },
      imageResourceZoom: 1,
      retentionResourceZoom: 1
    });

    expect(runtime.stats()).toMatchObject({
      activeLoadCount: 1,
      pendingImageCount: 1,
      visiblePreviewWidths: { 300: 2 },
      nextPreviewWidths: { 2400: 1 }
    });
    expect(counterNames(monitor.getTrace().events)).toContain('image-budget-block');
  });

  it('evicts far high-resolution visible images from mounted records', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const runtime = createCanvasImageAssetRuntime({ concurrency: 2, perfMonitor: monitor });
    runtime.setNodes(new Map([
      ['flow/a.png', largeImageNode('flow/a.png', 0, 0)],
      ['flow/b.png', largeImageNode('flow/b.png', 5000, 0)]
    ]));
    runtime.setViewport({
      ...viewport({
        cameraState: 'idle',
        mountedNodePaths: new Set(['flow/a.png', 'flow/b.png'])
      }),
      visibleRect: { x: 0, y: 0, width: 8000, height: 2000 },
      imageResourceZoom: 1
    });
    const pendingA = runtime.getNodeState('flow/a.png');
    const pendingB = runtime.getNodeState('flow/b.png');
    if (pendingA.kind !== 'image' || !pendingA.next || pendingB.kind !== 'image' || !pendingB.next) {
      throw new Error('Expected both high-resolution images to be pending.');
    }
    runtime.resolvePending('flow/a.png', pendingA.next.loadKey);
    runtime.resolvePending('flow/b.png', pendingB.next.loadKey);

    expect(runtime.stats().visiblePreviewWidths).toEqual({ 2400: 2 });

    runtime.setViewport({
      ...viewport({
        cameraState: 'idle',
        mountedNodePaths: new Set(['flow/a.png', 'flow/b.png']),
        culledNodePaths: new Set(['flow/b.png'])
      }),
      visibleRect: { x: 0, y: 0, width: 400, height: 300 },
      imageResourceZoom: 1
    });

    expect(runtime.stats().visiblePreviewWidths).toEqual({ 2400: 1 });
    expect(runtime.getNodeState('flow/b.png')).toMatchObject({ kind: 'placeholder' });
    expect(runtime.stats().imageEvictionReasons).toEqual({ 'far-high-resolution': 1 });
    expect(counterNames(monitor.getTrace().events)).toContain('image-visible-evict');
  });

  it('includes blank visible image URL-affecting source fields in the moving viewport signature', () => {
    const previewable = largeImageNode('flow/a.png', 0, 0, 'rev-a');
    const rawOnly = {
      ...previewable,
      availability: {
        ...previewable.availability,
        canvasImagePreviewable: false
      }
    };
    const movingViewport = {
      ...viewport({
        cameraState: 'moving',
        mountedNodePaths: new Set(['flow/a.png'])
      }),
      imageResourceZoom: 1
    };

    expect(canvasImageAssetViewportSignature(
      movingViewport,
      new Map([['flow/a.png', previewable]])
    )).not.toBe(canvasImageAssetViewportSignature(
      movingViewport,
      new Map([['flow/a.png', rawOnly]])
    ));
  });

  it('does not start image upgrades while moving when an image is already visible', () => {
    const runtime = createCanvasImageAssetRuntime({ concurrency: 1 });
    runtime.setNodes(new Map([['flow/a.png', largeImageNode('flow/a.png', 0, 0)]]));
    runtime.setViewport({
      ...viewport({ cameraState: 'idle', mountedNodePaths: new Set(['flow/a.png']) }),
      imageResourceZoom: 0.1
    });
    const pending = runtime.getNodeState('flow/a.png');
    if (pending.kind !== 'image' || !pending.next) {
      throw new Error('Expected initial image to be pending.');
    }
    runtime.resolvePending('flow/a.png', pending.next.loadKey);

    runtime.setViewport({
      ...viewport({ cameraState: 'moving', mountedNodePaths: new Set(['flow/a.png']) }),
      imageResourceZoom: 1
    });

    const moving = runtime.getNodeState('flow/a.png');
    expect(moving.kind === 'image' ? moving.next : undefined).toBeUndefined();

    runtime.setViewport({
      ...viewport({ cameraState: 'idle', mountedNodePaths: new Set(['flow/a.png']) }),
      imageResourceZoom: 1
    });

    const idle = runtime.getNodeState('flow/a.png');
    expect(idle.kind === 'image' ? idle.next : undefined).toBeDefined();
  });

  it('downshifts visible oversized images through next while keeping visible mounted', () => {
    const runtime = createCanvasImageAssetRuntime({ concurrency: 2 });
    runtime.setNodes(new Map([['flow/a.png', largeImageNode('flow/a.png', 0, 0)]]));
    runtime.setViewport({
      ...viewport({
        cameraState: 'idle',
        mountedNodePaths: new Set(['flow/a.png'])
      }),
      imageResourceZoom: 1,
      retentionResourceZoom: 1
    });

    const initial = runtime.getNodeState('flow/a.png');
    if (initial.kind !== 'image' || !initial.next) {
      throw new Error('Expected high-resolution initial pending image.');
    }
    runtime.resolvePending('flow/a.png', initial.next.loadKey);

    runtime.setViewport({
      ...viewport({
        cameraState: 'moving',
        mountedNodePaths: new Set(['flow/a.png'])
      }),
      imageResourceZoom: 1,
      retentionResourceZoom: 0.1
    });

    const downshift = runtime.getNodeState('flow/a.png');
    expect(downshift.kind === 'image' ? downshift.visible?.previewWidth : undefined).toBe(2400);
    expect(downshift.kind === 'image' ? downshift.next?.previewWidth : undefined).toBe(300);
    expect(runtime.stats()).toMatchObject({
      visiblePreviewWidths: { 2400: 1 },
      nextPreviewWidths: { 300: 1 },
      imageWorkIntentCounts: { 'downshift-visible': 1 },
      downshiftStartCount: 1
    });
  });

  it('evicts culled oversized visible images without starting replacement loads', () => {
    const runtime = createCanvasImageAssetRuntime({ concurrency: 2 });
    runtime.setNodes(new Map([['flow/far.png', largeImageNode('flow/far.png', 5000, 0)]]));
    runtime.setViewport({
      ...viewport({
        cameraState: 'idle',
        mountedNodePaths: new Set(['flow/far.png'])
      }),
      visibleRect: { x: 0, y: 0, width: 8000, height: 2000 },
      imageResourceZoom: 1,
      retentionResourceZoom: 1
    });

    const initial = runtime.getNodeState('flow/far.png');
    if (initial.kind !== 'image' || !initial.next) {
      throw new Error('Expected high-resolution initial pending image.');
    }
    runtime.resolvePending('flow/far.png', initial.next.loadKey);

    runtime.setViewport({
      ...viewport({
        cameraState: 'moving',
        mountedNodePaths: new Set(['flow/far.png']),
        culledNodePaths: new Set(['flow/far.png'])
      }),
      visibleRect: { x: 0, y: 0, width: 400, height: 300 },
      imageResourceZoom: 1,
      retentionResourceZoom: 0.1
    });

    expect(runtime.getNodeState('flow/far.png')).toMatchObject({ kind: 'placeholder' });
    expect(runtime.stats()).toMatchObject({
      activeLoadCount: 0,
      pendingImageCount: 0,
      visiblePreviewWidths: {},
      imageEvictionReasons: { 'oversized-culled': 1 },
      highResolutionEvictionCount: 1
    });
  });

  it('lets downshift work bypass source-width upgrade limits', () => {
    const runtime = createCanvasImageAssetRuntime({
      concurrency: 3,
      budget: {
        maxSourceWidthUpgradePendingImages: 0,
        maxDownshiftPendingImages: 3
      }
    });
    runtime.setNodes(new Map([
      ['flow/a.png', largeImageNode('flow/a.png', 0, 0)],
      ['flow/b.png', largeImageNode('flow/b.png', 2600, 0)]
    ]));
    runtime.setViewport({
      ...viewport({
        cameraState: 'idle',
        mountedNodePaths: new Set(['flow/a.png', 'flow/b.png'])
      }),
      visibleRect: { x: 0, y: 0, width: 6000, height: 2000 },
      imageResourceZoom: 1,
      retentionResourceZoom: 1
    });
    for (const path of ['flow/a.png', 'flow/b.png']) {
      const state = runtime.getNodeState(path);
      if (state.kind === 'image' && state.next) {
        runtime.resolvePending(path, state.next.loadKey);
      }
    }

    runtime.setViewport({
      ...viewport({
        cameraState: 'moving',
        mountedNodePaths: new Set(['flow/a.png', 'flow/b.png'])
      }),
      visibleRect: { x: 0, y: 0, width: 6000, height: 2000 },
      imageResourceZoom: 1,
      retentionResourceZoom: 0.1
    });

    expect(runtime.stats()).toMatchObject({
      pendingImageCount: 2,
      nextPreviewWidths: { 300: 2 },
      downshiftStartCount: 2
    });
  });

  it('evicts off-visible high-resolution records before visible lower-resolution records when retained pixels exceed the hard budget', () => {
    const runtime = createCanvasImageAssetRuntime({
      concurrency: 3,
      budget: {
        maxRetainedDecodedImagePixels: 2_000_000,
        hardRetainedDecodedImagePixels: 2_500_000
      }
    });
    runtime.setNodes(new Map([
      ['flow/visible.png', largeImageNode('flow/visible.png', 0, 0)],
      ['flow/far.png', largeImageNode('flow/far.png', 5000, 0)]
    ]));
    runtime.setViewport({
      ...viewport({
        cameraState: 'idle',
        mountedNodePaths: new Set(['flow/visible.png', 'flow/far.png'])
      }),
      visibleRect: { x: 0, y: 0, width: 8000, height: 2000 },
      imageResourceZoom: 1,
      retentionResourceZoom: 1
    });

    for (const path of ['flow/visible.png', 'flow/far.png']) {
      const state = runtime.getNodeState(path);
      if (state.kind !== 'image' || !state.next) {
        throw new Error(`Expected ${path} to start loading.`);
      }
      runtime.resolvePending(path, state.next.loadKey);
    }

    runtime.setViewport({
      ...viewport({
        cameraState: 'idle',
        mountedNodePaths: new Set(['flow/visible.png', 'flow/far.png'])
      }),
      visibleRect: { x: 0, y: 0, width: 400, height: 300 },
      imageResourceZoom: 1,
      retentionResourceZoom: 1,
      imageHeavyEfficientMode: true
    });

    expect(runtime.getNodeState('flow/visible.png')).toMatchObject({ kind: 'image' });
    expect(runtime.getNodeState('flow/far.png')).toMatchObject({ kind: 'placeholder' });
    expect(runtime.stats()).toMatchObject({
      visiblePreviewWidths: { 2400: 1 },
      imageEvictionReasons: { 'retained-preview-budget': 1 },
      highResolutionEvictionCount: 1
    });
  });

  it('cancels in-flight high-resolution replacements when retained budget evicts the visible record', () => {
    const runtime = createCanvasImageAssetRuntime({
      concurrency: 1,
      budget: {
        maxRetainedDecodedImagePixels: 1,
        hardRetainedDecodedImagePixels: 40_000,
        maxHighResolutionPendingImages: 1
      }
    });
    runtime.setNodes(new Map([
      ['flow/near.png', largeImageNode('flow/near.png', 500, 0)]
    ]));
    runtime.setViewport({
      ...viewport({
        cameraState: 'idle',
        mountedNodePaths: new Set(['flow/near.png'])
      }),
      visibleRect: { x: 0, y: 0, width: 4000, height: 2000 },
      imageResourceZoom: 0.1,
      retentionResourceZoom: 0.1
    });
    const low = runtime.getNodeState('flow/near.png');
    if (low.kind !== 'image' || !low.next) {
      throw new Error('Expected low-resolution visible load.');
    }
    runtime.resolvePending('flow/near.png', low.next.loadKey);

    runtime.setViewport({
      ...viewport({
        cameraState: 'idle',
        mountedNodePaths: new Set(['flow/near.png'])
      }),
      visibleRect: { x: 0, y: 0, width: 400, height: 300 },
      imageResourceZoom: 1,
      retentionResourceZoom: 1,
      imageHeavyEfficientMode: false
    });
    const high = runtime.getNodeState('flow/near.png');
    if (high.kind !== 'image' || !high.next) {
      throw new Error('Expected high-resolution replacement load.');
    }
    const highLoadKey = high.next.loadKey;

    runtime.setViewport({
      ...viewport({
        cameraState: 'idle',
        mountedNodePaths: new Set(['flow/near.png'])
      }),
      visibleRect: { x: 0, y: 0, width: 400, height: 300 },
      imageResourceZoom: 1,
      retentionResourceZoom: 1,
      imageHeavyEfficientMode: true
    });

    expect(runtime.getNodeState('flow/near.png')).toMatchObject({ kind: 'placeholder' });
    expect(runtime.stats()).toMatchObject({
      activeLoadCount: 0,
      pendingImageCount: 0,
      visiblePreviewWidths: {},
      nextPreviewWidths: {},
      imageEvictionReasons: { 'retained-preview-budget': 1 }
    });

    runtime.resolvePending('flow/near.png', highLoadKey);

    expect(runtime.getNodeState('flow/near.png')).toMatchObject({ kind: 'placeholder' });
    expect(runtime.stats().visiblePreviewWidths).toEqual({});
  });

  it('ends pending image-load sessions when disposed', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const runtime = createCanvasImageAssetRuntime({ concurrency: 1, perfMonitor: monitor });

    runtime.setNodes(new Map([['flow/a.png', largeImageNode('flow/a.png', 0, 0)]]));
    runtime.setViewport({
      ...viewport({ cameraState: 'idle', mountedNodePaths: new Set(['flow/a.png']) }),
      imageResourceZoom: 0.1
    });

    runtime.dispose();

    const imageLoadSession = monitor.getTrace().sessions.find((session) => session.type === 'image-load');
    expect(imageLoadSession).toMatchObject({
      type: 'image-load',
      counters: {
        'image-load-start': 1,
        'image-load-stale-result': 1
      },
      detail: {
        projectRelativePath: 'flow/a.png',
        result: 'image-load-stale-result'
      }
    });
  });
});

function counterNames(events: readonly CanvasPerfTraceEvent[]): string[] {
  return events
    .filter((event) => event.kind === 'counter')
    .map((event) => event.name);
}

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
  imageHeavyEfficientMode?: boolean;
}) {
  return {
    visibleRect: { x: 0, y: 0, width: 400, height: 300 },
    mountedNodePaths: input.mountedNodePaths ?? new Set(['flow/visible.png', 'flow/overscan.png', 'flow/cover.png', 'flow/other.png', 'flow/stale-visible.png']),
    culledNodePaths: input.culledNodePaths ?? new Set(),
    imageResourceZoom: 1,
    retentionResourceZoom: 1,
    devicePixelRatio: 1,
    cameraState: input.cameraState,
    imageHeavyEfficientMode: input.imageHeavyEfficientMode ?? false
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
