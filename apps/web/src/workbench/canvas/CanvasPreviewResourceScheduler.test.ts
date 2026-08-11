import { describe, expect, it, vi } from 'vitest';
import {
  createCanvasPreviewResourceScheduler
} from './CanvasPreviewResourceScheduler';
import type { CanvasPerfMonitor } from './CanvasPerfMonitor';

describe('CanvasPreviewResourceScheduler', () => {
  it('exposes the current interaction state to resource consumers', () => {
    const scheduler = createScheduler({
      requestFrame: () => 1,
      cancelFrame: vi.fn()
    });

    const initial = scheduler.getInteractionState();
    const listener = vi.fn();
    const unsubscribe = scheduler.subscribeInteraction(listener);
    expect(initial).toEqual({
      cameraState: 'idle',
      pointerInteractionActive: false
    });
    scheduler.setInteractionState({ cameraState: 'idle', pointerInteractionActive: false });
    expect(scheduler.getInteractionState()).toBe(initial);
    expect(listener).not.toHaveBeenCalled();

    scheduler.setInteractionState({ cameraState: 'moving', pointerInteractionActive: true });
    expect(scheduler.getInteractionState()).toEqual({
      cameraState: 'moving',
      pointerInteractionActive: true
    });
    expect(scheduler.getInteractionState()).not.toBe(initial);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      cameraState: 'moving',
      pointerInteractionActive: true
    });

    unsubscribe();
    scheduler.setInteractionState({ cameraState: 'idle', pointerInteractionActive: false });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('shares one three-operation frame budget between result publications and request starts', () => {
    const frames: FrameRequestCallback[] = [];
    const published: string[] = [];
    const scheduler = createScheduler({
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn()
    });

    scheduler.setInteractionState({ cameraState: 'idle', pointerInteractionActive: false });
    for (const nodeId of ['a', 'b']) {
      scheduler.enqueuePublication({
        kind: 'text',
        nodeId,
        sourceKey: `${nodeId}:source`,
        targetWidth: 640,
        isCurrent: () => true,
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
        run: () => published.push(nodeId)
      });
    }

    frames[0]?.(16);

    expect(published).toEqual(['a', 'b', 'c']);
    expect(frames).toHaveLength(2);

    frames[1]?.(32);

    expect(published).toEqual(['a', 'b', 'c', 'd']);
  });

  it('runs background publication work without requiring a visibility change', () => {
    const frames: FrameRequestCallback[] = [];
    const published: string[] = [];
    const scheduler = createScheduler({
      distanceSquaredForNode: () => 1,
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
      run: () => published.push('notes.md')
    });

    expect(frames).toHaveLength(1);
    frames[0]?.(16);

    expect(published).toEqual(['notes.md']);
  });

  it('does not treat a repeated identical interaction state as a new scheduling event', () => {
    const frames: FrameRequestCallback[] = [];
    const scheduler = createScheduler({
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn()
    });

    scheduler.enqueue({
      kind: 'image',
      nodeId: 'cover.png',
      sourceKey: 'source',
      targetWidth: 640,
      isCurrent: () => true,
      run: vi.fn()
    });
    expect(frames).toHaveLength(1);

    scheduler.setInteractionState({ cameraState: 'idle', pointerInteractionActive: false });
    expect(frames).toHaveLength(1);
  });

  it('orders nearer work before farther work while completing both', () => {
    const frames: FrameRequestCallback[] = [];
    const started: string[] = [];
    const priorityByNode = new Map([
      ['background.md', 1 as const],
      ['visible.md', 0 as const]
    ]);
    const scheduler = createScheduler({
      distanceSquaredForNode: (path) => priorityByNode.get(path) ?? 1,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn()
    });

    scheduler.enqueue({
      kind: 'text',
      nodeId: 'background.md',
      sourceKey: 'background:source',
      targetWidth: 640,
      isCurrent: () => true,
      run: () => started.push('background.md')
    });
    scheduler.enqueue({
      kind: 'text',
      nodeId: 'visible.md',
      sourceKey: 'visible:source',
      targetWidth: 640,
      isCurrent: () => true,
      run: () => started.push('visible.md')
    });
    frames[0]?.(16);

    expect(started).toEqual(['visible.md', 'background.md']);
  });

  it('orders publications before starts at the same distance', () => {
    const frames: FrameRequestCallback[] = [];
    const operations: string[] = [];
    const scheduler = createScheduler({
      distanceSquaredForNode: (path) => path.startsWith('visible') ? 0 : 1,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn()
    });

    scheduler.enqueue({
      kind: 'image',
      nodeId: 'background-start',
      sourceKey: 'background-start',
      targetWidth: 640,
      isCurrent: () => true,
      run: () => operations.push('background-start')
    });
    scheduler.enqueuePublication({
      kind: 'text',
      nodeId: 'background-publication',
      sourceKey: 'background-publication',
      targetWidth: 640,
      isCurrent: () => true,
      run: () => operations.push('background-publication')
    });
    scheduler.enqueue({
      kind: 'image',
      nodeId: 'visible-start',
      sourceKey: 'visible-start',
      targetWidth: 640,
      isCurrent: () => true,
      run: () => operations.push('visible-start')
    });
    scheduler.enqueuePublication({
      kind: 'text',
      nodeId: 'visible-publication',
      sourceKey: 'visible-publication',
      targetWidth: 640,
      isCurrent: () => true,
      run: () => operations.push('visible-publication')
    });

    frames[0]?.(16);
    expect(operations).toEqual([
      'visible-publication',
      'visible-start',
      'background-publication'
    ]);

    frames[1]?.(32);
    expect(operations).toEqual([
      'visible-publication',
      'visible-start',
      'background-publication',
      'background-start'
    ]);
  });

  it('cancels a pending publication frame when interaction resumes', () => {
    const frames: FrameRequestCallback[] = [];
    const canceled: number[] = [];
    const published: string[] = [];
    const scheduler = createScheduler({
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
      run: () => published.push('cover.png')
    });
    scheduler.setInteractionState({ cameraState: 'moving', pointerInteractionActive: false });
    frames[0]?.(16);

    expect(canceled).toEqual([1]);
    expect(published).toEqual([]);

    scheduler.setInteractionState({ cameraState: 'idle', pointerInteractionActive: false });
    frames[1]?.(32);

    expect(published).toEqual(['cover.png']);
  });

  it('starts at most three current requests per frame while idle', () => {
    const frames: FrameRequestCallback[] = [];
    const started: string[] = [];
    const scheduler = createScheduler({
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn()
    });

    scheduler.setInteractionState({ cameraState: 'idle', pointerInteractionActive: false });
    for (const nodeId of ['a', 'b', 'c', 'd']) {
      scheduler.enqueue({
        kind: 'image',
        nodeId,
        sourceKey: `${nodeId}:source`,
        targetWidth: 640,
        isCurrent: () => true,
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
    const scheduler = createScheduler({
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn()
    });

    scheduler.setInteractionState({ cameraState: 'idle', pointerInteractionActive: false });
    scheduler.enqueue({
      kind: 'image',
      nodeId: 'cover.png',
      sourceKey: 'source',
      targetWidth: 640,
      isCurrent: () => true,
      run: () => started.push('cover.png')
    });

    expect(frames).toHaveLength(1);
    frames[0]?.(16);

    expect(started).toEqual(['cover.png']);
  });

  it('coalesces by preview kind and node id with newest request winning', () => {
    const frames: FrameRequestCallback[] = [];
    const started: string[] = [];
    const scheduler = createScheduler({
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn()
    });

    scheduler.setInteractionState({ cameraState: 'idle', pointerInteractionActive: false });
    scheduler.enqueue({
      kind: 'image',
      nodeId: 'cover.png',
      sourceKey: 'old',
      targetWidth: 320,
      isCurrent: () => true,
      run: () => started.push('old')
    });
    scheduler.enqueue({
      kind: 'image',
      nodeId: 'cover.png',
      sourceKey: 'new',
      targetWidth: 640,
      isCurrent: () => true,
      run: () => started.push('new')
    });

    frames[0]?.(16);

    expect(started).toEqual(['new']);
  });

  it('pauses queued starts while camera movement or drag is active', () => {
    const frames: FrameRequestCallback[] = [];
    const started: string[] = [];
    const scheduler = createScheduler({
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn()
    });

    scheduler.setInteractionState({ cameraState: 'moving', pointerInteractionActive: false });
    scheduler.enqueue({
      kind: 'text',
      nodeId: 'notes.md',
      sourceKey: 'source',
      targetWidth: 640,
      isCurrent: () => true,
      run: () => started.push('notes.md')
    });

    expect(frames).toEqual([]);

    scheduler.setInteractionState({ cameraState: 'idle', pointerInteractionActive: true });
    expect(frames).toEqual([]);

    scheduler.setInteractionState({ cameraState: 'idle', pointerInteractionActive: false });
    expect(frames).toHaveLength(1);
    frames[0]?.(16);

    expect(started).toEqual(['notes.md']);
  });

  it('does not schedule queued background work until the active interaction ends', () => {
    const frames: FrameRequestCallback[] = [];
    const counters: string[] = [];
    const started: string[] = [];
    const perfMonitor = {
      recordCounter: (input) => counters.push(input.name)
    } satisfies Pick<CanvasPerfMonitor, 'recordCounter'>;
    const scheduler = createScheduler({
      perfMonitor,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn()
    });

    scheduler.setInteractionState({ cameraState: 'moving', pointerInteractionActive: false });
    scheduler.enqueue({
      kind: 'image',
      nodeId: 'cover.png',
      sourceKey: 'source',
      targetWidth: 640,
      isCurrent: () => true,
      run: () => started.push('cover.png')
    });
    expect(frames).toEqual([]);
    expect(counters).toEqual([
      'preview-resource-queued',
      'preview-resource-paused-moving'
    ]);

    scheduler.setInteractionState({ cameraState: 'idle', pointerInteractionActive: false });
    expect(frames).toHaveLength(1);
    frames[0]?.(16);

    expect(started).toEqual(['cover.png']);
  });

  it('cancels a pending start frame when interaction begins before the frame fires', () => {
    const frames: FrameRequestCallback[] = [];
    const canceled: number[] = [];
    const started: string[] = [];
    const scheduler = createScheduler({
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: (handle) => canceled.push(handle)
    });

    scheduler.setInteractionState({ cameraState: 'idle', pointerInteractionActive: false });
    scheduler.enqueue({
      kind: 'image',
      nodeId: 'cover.png',
      sourceKey: 'source',
      targetWidth: 640,
      isCurrent: () => true,
      run: () => started.push('cover.png')
    });

    expect(frames).toHaveLength(1);

    scheduler.setInteractionState({ cameraState: 'moving', pointerInteractionActive: false });
    frames[0]?.(16);

    expect(canceled).toEqual([1]);
    expect(started).toEqual([]);

    scheduler.setInteractionState({ cameraState: 'idle', pointerInteractionActive: false });
    frames[1]?.(32);

    expect(started).toEqual(['cover.png']);
  });

  it('skips stale requests but still runs current background requests', () => {
    const frames: FrameRequestCallback[] = [];
    const started: string[] = [];
    const scheduler = createScheduler({
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn()
    });

    scheduler.setInteractionState({ cameraState: 'idle', pointerInteractionActive: false });
    scheduler.enqueue({
      kind: 'image',
      nodeId: 'stale.png',
      sourceKey: 'old',
      targetWidth: 320,
      isCurrent: () => false,
      run: () => started.push('stale')
    });
    scheduler.enqueue({
      kind: 'image',
      nodeId: 'background.png',
      sourceKey: 'current',
      targetWidth: 320,
      isCurrent: () => true,
      run: () => started.push('background')
    });

    frames[0]?.(16);

    expect(started).toEqual(['background']);
  });

  it('records scheduler counters', () => {
    const frames: FrameRequestCallback[] = [];
    const counters: string[] = [];
    const perfMonitor = {
      recordCounter: (input) => counters.push(input.name)
    } satisfies Pick<CanvasPerfMonitor, 'recordCounter'>;
    const scheduler = createScheduler({
      perfMonitor,
      now: () => 10,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn()
    });

    scheduler.setInteractionState({ cameraState: 'idle', pointerInteractionActive: false });
    scheduler.enqueue({
      kind: 'text',
      nodeId: 'notes.md',
      sourceKey: 'old',
      targetWidth: 320,
      isCurrent: () => true,
      run: vi.fn()
    });
    scheduler.enqueue({
      kind: 'text',
      nodeId: 'notes.md',
      sourceKey: 'new',
      targetWidth: 640,
      isCurrent: () => true,
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
    const scheduler = createScheduler({
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
    const scheduler = createScheduler({
      perfMonitor,
      requestFrame: vi.fn(),
      cancelFrame: vi.fn()
    });

    scheduler.setInteractionState({ cameraState: 'moving', pointerInteractionActive: false });
    scheduler.setInteractionState({ cameraState: 'idle', pointerInteractionActive: false });
    scheduler.enqueue({
      kind: 'text',
      nodeId: 'notes.md',
      sourceKey: 'source',
      targetWidth: 640,
      isCurrent: () => true,
      run: vi.fn()
    });

    expect(counters).toEqual(['preview-resource-queued']);
  });
});

function createScheduler(
  input: Omit<Parameters<typeof createCanvasPreviewResourceScheduler>[0], 'distanceSquaredForNode'> & {
    distanceSquaredForNode?: (nodeId: string) => number;
  }
) {
  return createCanvasPreviewResourceScheduler({
    distanceSquaredForNode: () => 0,
    ...input
  });
}
