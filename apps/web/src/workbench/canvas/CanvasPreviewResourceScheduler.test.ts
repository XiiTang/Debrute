import { describe, expect, it, vi } from 'vitest';
import { createCanvasPreviewResourceScheduler } from './CanvasPreviewResourceScheduler';
import type { CanvasPerfMonitor } from './CanvasPerfMonitor';

describe('CanvasPreviewResourceScheduler', () => {
  it('starts at most three current visible requests per frame while idle', () => {
    const frames: FrameRequestCallback[] = [];
    const started: string[] = [];
    const scheduler = createTestScheduler({
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

  it('waits for each idle request enqueue time to settle before starting work', () => {
    const frames: FrameRequestCallback[] = [];
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const started: string[] = [];
    let time = 0;
    const scheduler = createTestScheduler({
      now: () => time,
      settleMs: 500,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn(),
      setTimeout: (callback, delay) => {
        timers.push({ callback, delay });
        return timers.length;
      },
      clearTimeout: vi.fn()
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

    expect(frames).toEqual([]);
    expect(timers[0]?.delay).toBe(500);

    time = 500;
    timers[0]?.callback();
    frames[0]?.(516);

    expect(started).toEqual(['cover.png']);
  });

  it('coalesces by preview kind and node id with newest request winning', () => {
    const frames: FrameRequestCallback[] = [];
    const started: string[] = [];
    const scheduler = createTestScheduler({
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
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const started: string[] = [];
    let time = 0;
    const scheduler = createTestScheduler({
      now: () => time,
      settleMs: 500,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn(),
      setTimeout: (callback, delay) => {
        timers.push({ callback, delay });
        return timers.length;
      }
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

    time = 64;
    scheduler.setInteractionState({ cameraState: 'idle', dragActive: false });
    expect(frames).toEqual([]);
    expect(timers[0]?.delay).toBe(436);

    time = 500;
    timers[0]?.callback();
    frames[0]?.(16);

    expect(started).toEqual(['notes.md']);
  });

  it('cancels a pending start frame when interaction begins before the frame fires', () => {
    const frames: FrameRequestCallback[] = [];
    const canceled: number[] = [];
    const started: string[] = [];
    let time = 0;
    const scheduler = createTestScheduler({
      now: () => time,
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

    time = 500;
    scheduler.setInteractionState({ cameraState: 'idle', dragActive: false });
    frames[1]?.(32);

    expect(started).toEqual(['cover.png']);
  });

  it('waits for the preview settle window after movement before starting queued requests', () => {
    const frames: FrameRequestCallback[] = [];
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const started: string[] = [];
    let time = 0;
    const scheduler = createTestScheduler({
      now: () => time,
      settleMs: 500,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn(),
      setTimeout: (callback, delay) => {
        timers.push({ callback, delay });
        return timers.length;
      },
      clearTimeout: vi.fn()
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
    expect(timers).toEqual([]);

    time = 64;
    scheduler.setInteractionState({ cameraState: 'idle', dragActive: false });

    expect(frames).toEqual([]);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.delay).toBe(436);

    time = 500;
    timers[0]?.callback();
    frames[0]?.(516);

    expect(started).toEqual(['notes.md']);
  });

  it('refreshes the settle window while movement continues', () => {
    const frames: FrameRequestCallback[] = [];
    const timers: Array<{ callback: () => void; delay: number }> = [];
    let time = 0;
    const scheduler = createTestScheduler({
      now: () => time,
      settleMs: 500,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn(),
      setTimeout: (callback, delay) => {
        timers.push({ callback, delay });
        return timers.length;
      },
      clearTimeout: vi.fn()
    });

    scheduler.setInteractionState({ cameraState: 'moving', dragActive: false });
    scheduler.enqueue({
      kind: 'text',
      nodeId: 'notes.md',
      sourceKey: 'source',
      targetWidth: 640,
      isCurrent: () => true,
      isCulled: () => false,
      run: vi.fn()
    });
    time = 250;
    scheduler.setInteractionState({ cameraState: 'moving', dragActive: false });
    time = 314;
    scheduler.setInteractionState({ cameraState: 'idle', dragActive: false });

    expect(frames).toEqual([]);
    expect(timers[0]?.delay).toBe(436);
  });

  it('settles requests queued after movement before starting them', () => {
    const frames: FrameRequestCallback[] = [];
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const started: string[] = [];
    let time = 0;
    const scheduler = createTestScheduler({
      now: () => time,
      settleMs: 500,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn(),
      setTimeout: (callback, delay) => {
        timers.push({ callback, delay });
        return timers.length;
      },
      clearTimeout: vi.fn()
    });

    scheduler.setInteractionState({ cameraState: 'moving', dragActive: false });
    time = 500;
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

    expect(frames).toEqual([]);
    expect(timers[0]?.delay).toBe(500);

    time = 1000;
    timers[0]?.callback();
    frames[0]?.(1016);

    expect(started).toEqual(['cover.png']);
  });

  it('cancels the preview settle timer when movement resumes', () => {
    const frames: FrameRequestCallback[] = [];
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const clearedTimers: number[] = [];
    let time = 0;
    const scheduler = createTestScheduler({
      now: () => time,
      settleMs: 500,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn(),
      setTimeout: (callback, delay) => {
        timers.push({ callback, delay });
        return timers.length;
      },
      clearTimeout: (handle) => clearedTimers.push(handle)
    });

    scheduler.setInteractionState({ cameraState: 'moving', dragActive: false });
    scheduler.enqueue({
      kind: 'image',
      nodeId: 'cover.png',
      sourceKey: 'source',
      targetWidth: 640,
      isCurrent: () => true,
      isCulled: () => false,
      run: vi.fn()
    });
    time = 64;
    scheduler.setInteractionState({ cameraState: 'idle', dragActive: false });
    time = 120;
    scheduler.setInteractionState({ cameraState: 'moving', dragActive: false });
    timers[0]?.callback();

    expect(clearedTimers).toEqual([1]);
    expect(frames).toEqual([]);
  });

  it('cancels the preview settle timer when the final queued request is canceled', () => {
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const clearedTimers: number[] = [];
    let time = 0;
    const scheduler = createTestScheduler({
      now: () => time,
      settleMs: 500,
      requestFrame: vi.fn(),
      cancelFrame: vi.fn(),
      setTimeout: (callback, delay) => {
        timers.push({ callback, delay });
        return timers.length;
      },
      clearTimeout: (handle) => clearedTimers.push(handle)
    });

    scheduler.setInteractionState({ cameraState: 'moving', dragActive: false });
    scheduler.enqueue({
      kind: 'image',
      nodeId: 'cover.png',
      sourceKey: 'source',
      targetWidth: 640,
      isCurrent: () => true,
      isCulled: () => false,
      run: vi.fn()
    });
    time = 64;
    scheduler.setInteractionState({ cameraState: 'idle', dragActive: false });
    scheduler.cancel('image', 'cover.png');

    expect(timers).toHaveLength(1);
    expect(clearedTimers).toEqual([1]);
  });

  it('skips stale and culled requests at start time', () => {
    const frames: FrameRequestCallback[] = [];
    const started: string[] = [];
    const scheduler = createTestScheduler({
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
    const scheduler = createTestScheduler({
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

  it('does not report an idle settle wait as paused moving work', () => {
    const counters: string[] = [];
    const perfMonitor = {
      recordCounter: (input) => counters.push(input.name)
    } satisfies Pick<CanvasPerfMonitor, 'recordCounter'>;
    let time = 0;
    const scheduler = createTestScheduler({
      perfMonitor,
      now: () => time,
      settleMs: 500,
      requestFrame: vi.fn(),
      cancelFrame: vi.fn(),
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn()
    });

    scheduler.setInteractionState({ cameraState: 'moving', dragActive: false });
    time = 64;
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

function createTestScheduler(
  input: Parameters<typeof createCanvasPreviewResourceScheduler>[0]
): ReturnType<typeof createCanvasPreviewResourceScheduler> {
  return createCanvasPreviewResourceScheduler({
    settleMs: 0,
    setTimeout: () => {
      throw new Error('Unexpected preview resource settle timer.');
    },
    clearTimeout: vi.fn(),
    ...input
  });
}
