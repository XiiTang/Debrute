import { describe, expect, it, vi } from 'vitest';
import { createCanvasPreviewResourceScheduler } from './CanvasPreviewResourceScheduler';
import type { CanvasPerfMonitor } from './CanvasPerfMonitor';

describe('CanvasPreviewResourceScheduler', () => {
  it('shares one three-operation frame budget between result publications and request starts', () => {
    const frames: FrameRequestCallback[] = [];
    const published: string[] = [];
    const scheduler = createCanvasPreviewResourceScheduler({
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn()
    });

    scheduler.setInteractionState({ cameraState: 'idle', dragActive: false });
    for (const nodeId of ['a', 'b']) {
      scheduler.enqueuePublication({
        kind: 'text',
        nodeId,
        sourceKey: `${nodeId}:source`,
        targetWidth: 640,
        isCurrent: () => true,
        isCulled: () => false,
        run: () => published.push(nodeId)
      });
    }
    for (const nodeId of ['c', 'd']) {
      scheduler.enqueue({
        kind: 'image',
        nodeId,
        sourceKey: `${nodeId}:source`,
        targetWidth: 640,
        isCurrent: () => true,
        isCulled: () => false,
        run: () => published.push(nodeId)
      });
    }

    frames[0]?.(16);

    expect(published).toEqual(['a', 'b', 'c']);
    expect(frames).toHaveLength(2);

    frames[1]?.(32);

    expect(published).toEqual(['a', 'b', 'c', 'd']);
  });

  it('defers a culled publication until a later idle visibility check makes it current', () => {
    const frames: FrameRequestCallback[] = [];
    const published: string[] = [];
    let culled = true;
    const scheduler = createCanvasPreviewResourceScheduler({
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn()
    });

    scheduler.enqueuePublication({
      kind: 'text',
      nodeId: 'notes.md',
      sourceKey: 'notes:source',
      targetWidth: 640,
      isCurrent: () => true,
      isCulled: () => culled,
      run: () => published.push('notes.md')
    });

    expect(frames).toEqual([]);

    culled = false;
    scheduler.notifyVisibilityChanged();
    frames[0]?.(16);

    expect(published).toEqual(['notes.md']);
  });

  it('retains a current culled start until a later visibility check makes it eligible', () => {
    const frames: FrameRequestCallback[] = [];
    const started: string[] = [];
    let culled = true;
    const scheduler = createCanvasPreviewResourceScheduler({
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn()
    });

    scheduler.enqueue({
      kind: 'text',
      nodeId: 'notes.md',
      sourceKey: 'notes:source',
      targetWidth: 640,
      isCurrent: () => true,
      isCulled: () => culled,
      run: () => started.push('notes.md')
    });
    expect(frames).toEqual([]);
    expect(started).toEqual([]);

    culled = false;
    scheduler.notifyVisibilityChanged();
    frames[0]?.(16);

    expect(started).toEqual(['notes.md']);
  });

  it('cancels a pending publication frame when interaction resumes', () => {
    const frames: FrameRequestCallback[] = [];
    const canceled: number[] = [];
    const published: string[] = [];
    const scheduler = createCanvasPreviewResourceScheduler({
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: (handle) => canceled.push(handle)
    });

    scheduler.enqueuePublication({
      kind: 'image',
      nodeId: 'cover.png',
      sourceKey: 'cover:source',
      targetWidth: 640,
      isCurrent: () => true,
      isCulled: () => false,
      run: () => published.push('cover.png')
    });
    scheduler.setInteractionState({ cameraState: 'moving', dragActive: false });
    frames[0]?.(16);

    expect(canceled).toEqual([1]);
    expect(published).toEqual([]);

    scheduler.setInteractionState({ cameraState: 'idle', dragActive: false });
    frames[1]?.(32);

    expect(published).toEqual(['cover.png']);
  });

  it('starts at most three current visible requests per frame while idle', () => {
    const frames: FrameRequestCallback[] = [];
    const started: string[] = [];
    const scheduler = createCanvasPreviewResourceScheduler({
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn()
    });

    scheduler.setInteractionState({ cameraState: 'idle', dragActive: false });
    for (const nodeId of ['a', 'b', 'c', 'd']) {
      scheduler.enqueue({
        kind: 'image',
        nodeId,
        sourceKey: `${nodeId}:source`,
        targetWidth: 640,
        isCurrent: () => true,
        isCulled: () => false,
        run: () => started.push(nodeId)
      });
    }

    frames[0]?.(16);

    expect(started).toEqual(['a', 'b', 'c']);
    expect(frames).toHaveLength(2);

    frames[1]?.(32);

    expect(started).toEqual(['a', 'b', 'c', 'd']);
  });

  it('starts an idle request on the next animation frame', () => {
    const frames: FrameRequestCallback[] = [];
    const started: string[] = [];
    const scheduler = createCanvasPreviewResourceScheduler({
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn()
    });

    scheduler.setInteractionState({ cameraState: 'idle', dragActive: false });
    scheduler.enqueue({
      kind: 'image',
      nodeId: 'cover.png',
      sourceKey: 'source',
      targetWidth: 640,
      isCurrent: () => true,
      isCulled: () => false,
      run: () => started.push('cover.png')
    });

    expect(frames).toHaveLength(1);
    frames[0]?.(16);

    expect(started).toEqual(['cover.png']);
  });

  it('coalesces by preview kind and node id with newest request winning', () => {
    const frames: FrameRequestCallback[] = [];
    const started: string[] = [];
    const scheduler = createCanvasPreviewResourceScheduler({
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn()
    });

    scheduler.setInteractionState({ cameraState: 'idle', dragActive: false });
    scheduler.enqueue({
      kind: 'image',
      nodeId: 'cover.png',
      sourceKey: 'old',
      targetWidth: 320,
      isCurrent: () => true,
      isCulled: () => false,
      run: () => started.push('old')
    });
    scheduler.enqueue({
      kind: 'image',
      nodeId: 'cover.png',
      sourceKey: 'new',
      targetWidth: 640,
      isCurrent: () => true,
      isCulled: () => false,
      run: () => started.push('new')
    });

    frames[0]?.(16);

    expect(started).toEqual(['new']);
  });

  it('pauses queued starts while camera movement or drag is active', () => {
    const frames: FrameRequestCallback[] = [];
    const started: string[] = [];
    const scheduler = createCanvasPreviewResourceScheduler({
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn()
    });

    scheduler.setInteractionState({ cameraState: 'moving', dragActive: false });
    scheduler.enqueue({
      kind: 'text',
      nodeId: 'notes.md',
      sourceKey: 'source',
      targetWidth: 640,
      isCurrent: () => true,
      isCulled: () => false,
      run: () => started.push('notes.md')
    });

    expect(frames).toEqual([]);

    scheduler.setInteractionState({ cameraState: 'idle', dragActive: true });
    expect(frames).toEqual([]);

    scheduler.setInteractionState({ cameraState: 'idle', dragActive: false });
    expect(frames).toHaveLength(1);
    frames[0]?.(16);

    expect(started).toEqual(['notes.md']);
  });

  it('cancels a pending start frame when interaction begins before the frame fires', () => {
    const frames: FrameRequestCallback[] = [];
    const canceled: number[] = [];
    const started: string[] = [];
    const scheduler = createCanvasPreviewResourceScheduler({
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: (handle) => canceled.push(handle)
    });

    scheduler.setInteractionState({ cameraState: 'idle', dragActive: false });
    scheduler.enqueue({
      kind: 'image',
      nodeId: 'cover.png',
      sourceKey: 'source',
      targetWidth: 640,
      isCurrent: () => true,
      isCulled: () => false,
      run: () => started.push('cover.png')
    });

    expect(frames).toHaveLength(1);

    scheduler.setInteractionState({ cameraState: 'moving', dragActive: false });
    frames[0]?.(16);

    expect(canceled).toEqual([1]);
    expect(started).toEqual([]);

    scheduler.setInteractionState({ cameraState: 'idle', dragActive: false });
    frames[1]?.(32);

    expect(started).toEqual(['cover.png']);
  });

  it('skips stale and culled requests at start time', () => {
    const frames: FrameRequestCallback[] = [];
    const started: string[] = [];
    const scheduler = createCanvasPreviewResourceScheduler({
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn()
    });

    scheduler.setInteractionState({ cameraState: 'idle', dragActive: false });
    scheduler.enqueue({
      kind: 'image',
      nodeId: 'stale.png',
      sourceKey: 'old',
      targetWidth: 320,
      isCurrent: () => false,
      isCulled: () => false,
      run: () => started.push('stale')
    });
    scheduler.enqueue({
      kind: 'image',
      nodeId: 'culled.png',
      sourceKey: 'current',
      targetWidth: 320,
      isCurrent: () => true,
      isCulled: () => true,
      run: () => started.push('culled')
    });

    frames[0]?.(16);

    expect(started).toEqual([]);
  });

  it('records scheduler counters', () => {
    const frames: FrameRequestCallback[] = [];
    const counters: string[] = [];
    const perfMonitor = {
      recordCounter: (input) => counters.push(input.name)
    } satisfies Pick<CanvasPerfMonitor, 'recordCounter'>;
    const scheduler = createCanvasPreviewResourceScheduler({
      perfMonitor,
      now: () => 10,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn()
    });

    scheduler.setInteractionState({ cameraState: 'idle', dragActive: false });
    scheduler.enqueue({
      kind: 'text',
      nodeId: 'notes.md',
      sourceKey: 'old',
      targetWidth: 320,
      isCurrent: () => true,
      isCulled: () => false,
      run: vi.fn()
    });
    scheduler.enqueue({
      kind: 'text',
      nodeId: 'notes.md',
      sourceKey: 'new',
      targetWidth: 640,
      isCurrent: () => true,
      isCulled: () => false,
      run: vi.fn()
    });
    frames[0]?.(16);

    expect(counters).toEqual([
      'preview-resource-queued',
      'preview-resource-coalesced',
      'preview-resource-started'
    ]);
  });

  it('records publication queue and commit counters separately from request starts', () => {
    const frames: FrameRequestCallback[] = [];
    const counters: string[] = [];
    const perfMonitor = {
      recordCounter: (input) => counters.push(input.name)
    } satisfies Pick<CanvasPerfMonitor, 'recordCounter'>;
    const scheduler = createCanvasPreviewResourceScheduler({
      perfMonitor,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn()
    });

    scheduler.enqueuePublication({
      kind: 'image',
      nodeId: 'cover.png',
      sourceKey: 'cover:source',
      targetWidth: 640,
      isCurrent: () => true,
      isCulled: () => false,
      run: vi.fn()
    });
    frames[0]?.(16);

    expect(counters).toEqual([
      'preview-publication-queued',
      'preview-publication-committed'
    ]);
  });

  it('does not report idle queued work as paused moving work', () => {
    const counters: string[] = [];
    const perfMonitor = {
      recordCounter: (input) => counters.push(input.name)
    } satisfies Pick<CanvasPerfMonitor, 'recordCounter'>;
    const scheduler = createCanvasPreviewResourceScheduler({
      perfMonitor,
      requestFrame: vi.fn(),
      cancelFrame: vi.fn()
    });

    scheduler.setInteractionState({ cameraState: 'moving', dragActive: false });
    scheduler.setInteractionState({ cameraState: 'idle', dragActive: false });
    scheduler.enqueue({
      kind: 'text',
      nodeId: 'notes.md',
      sourceKey: 'source',
      targetWidth: 640,
      isCurrent: () => true,
      isCulled: () => false,
      run: vi.fn()
    });

    expect(counters).toEqual(['preview-resource-queued']);
  });
});
