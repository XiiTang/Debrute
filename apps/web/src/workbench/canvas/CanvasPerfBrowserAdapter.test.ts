import { describe, expect, it, vi } from 'vitest';
import { createCanvasPerfBrowserAdapter } from './CanvasPerfBrowserAdapter';
import type { CanvasPerfTraceEvent } from './CanvasPerfMonitor';

describe('CanvasPerfBrowserAdapter', () => {
  it('writes performance marks and measures for session events', () => {
    const marks: Array<{ name: string; detail: unknown }> = [];
    const measures: Array<{ name: string; start: string; end: string }> = [];
    const adapter = createCanvasPerfBrowserAdapter({
      performanceApi: {
        mark: (name, options) => marks.push({ name, detail: options?.detail }),
        measure: (name, start, end) => measures.push({ name, start, end })
      }
    });

    adapter.recordEvent(sessionStart('camera-pan:1', 'camera-pan'));
    adapter.recordEvent(sessionEnd('camera-pan:1', 'camera-pan'));

    expect(marks.map((mark) => mark.name)).toEqual([
      'debrute:canvas:camera-pan:camera-pan:1:start',
      'debrute:canvas:camera-pan:camera-pan:1:end'
    ]);
    expect(marks[1]?.detail).toEqual({
      durationMs: 50,
      frameIntervalCount: 2,
      mountedNodeCount: 8,
      visibleNodeCount: 5,
      culledNodeCount: 3
    });
    expect(measures).toEqual([{
      name: 'debrute:canvas:camera-pan:camera-pan:1',
      start: 'debrute:canvas:camera-pan:camera-pan:1:start',
      end: 'debrute:canvas:camera-pan:camera-pan:1:end'
    }]);
  });

  it('isolates mark and measure failures without retrying alternate mark shapes', () => {
    const mark = vi.fn(() => {
      throw new Error('mark unavailable');
    });
    const measure = vi.fn(() => {
      throw new Error('measure unavailable');
    });
    const adapter = createCanvasPerfBrowserAdapter({
      performanceApi: { mark, measure }
    });

    expect(() => adapter.recordEvent(sessionEnd('camera-pan:1', 'camera-pan'))).not.toThrow();

    expect(mark).toHaveBeenCalledTimes(1);
    expect(mark).toHaveBeenCalledWith('debrute:canvas:camera-pan:camera-pan:1:end', expect.any(Object));
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it('observes long animation frames only while sessions are active', () => {
    const callbacks: Array<(list: { getEntries(): unknown[] }) => void> = [];
    const observed: unknown[] = [];
    const disconnect = vi.fn();
    const longAnimationFrames: unknown[] = [];
    const adapter = createCanvasPerfBrowserAdapter({
      performanceApi: { mark: vi.fn(), measure: vi.fn() },
      supportedEntryTypes: ['long-animation-frame'],
      performanceObserverFactory: (callback) => {
        callbacks.push(callback);
        return {
          observe: (options) => observed.push(options),
          disconnect
        };
      },
      onLongAnimationFrame: (entry) => longAnimationFrames.push(entry)
    });

    expect(callbacks).toEqual([]);

    adapter.recordEvent(sessionStart('camera-pan:1', 'camera-pan'));
    callbacks[0]?.({
      getEntries: () => [{
        startTime: 120,
        duration: 72,
        blockingDuration: 40,
        scripts: [{
          sourceURL: 'http://localhost/src/canvas.ts',
          invoker: 'requestAnimationFrame',
          duration: 38
        }]
      }]
    });
    adapter.recordEvent(sessionEnd('camera-pan:1', 'camera-pan'));

    expect(observed).toEqual([{ type: 'long-animation-frame', buffered: false }]);
    expect(longAnimationFrames).toEqual([{
      sessionId: 'camera-pan:1',
      timestamp: expect.any(Number),
      source: 'CanvasPerfBrowserAdapter',
      entry: {
        startTime: 120,
        duration: 72,
        blockingDuration: 40,
        scripts: [{
          sourceURL: 'http://localhost/src/canvas.ts',
          invoker: 'requestAnimationFrame',
          duration: 38
        }]
      }
    }]);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('drops delayed long animation frame callbacks after the observed session ends', () => {
    const callbacks: Array<(list: { getEntries(): unknown[] }) => void> = [];
    const longAnimationFrames: unknown[] = [];
    const adapter = createCanvasPerfBrowserAdapter({
      performanceApi: { mark: vi.fn(), measure: vi.fn() },
      supportedEntryTypes: ['long-animation-frame'],
      performanceObserverFactory: (callback) => {
        callbacks.push(callback);
        return {
          observe: vi.fn(),
          disconnect: vi.fn()
        };
      },
      onLongAnimationFrame: (entry) => longAnimationFrames.push(entry)
    });

    adapter.recordEvent(sessionStart('camera-pan:1', 'camera-pan'));
    adapter.recordEvent(sessionEnd('camera-pan:1', 'camera-pan'));
    callbacks[0]?.({
      getEntries: () => [{
        startTime: 120,
        duration: 60,
        blockingDuration: 35,
        scripts: []
      }]
    });

    expect(longAnimationFrames).toEqual([]);
  });

  it('samples full rAF frame intervals while a session is active', () => {
    const animationFrames = manualAnimationFrames();
    const frameIntervals: unknown[] = [];
    const adapter = createCanvasPerfBrowserAdapter({
      performanceApi: { mark: vi.fn(), measure: vi.fn() },
      requestAnimationFrame: animationFrames.request,
      cancelAnimationFrame: animationFrames.cancel,
      onFrameInterval: (frameInterval) => frameIntervals.push(frameInterval)
    });

    adapter.recordEvent(sessionStart('camera-pan:1', 'camera-pan'));
    animationFrames.fire(100);
    animationFrames.fire(116);
    animationFrames.fire(132);
    animationFrames.fire(182);
    adapter.recordEvent(sessionEnd('camera-pan:1', 'camera-pan'));

    expect(frameIntervals).toEqual([
      { timestamp: 116, source: 'CanvasPerfBrowserAdapter', frameIntervalMs: 16 },
      { timestamp: 132, source: 'CanvasPerfBrowserAdapter', frameIntervalMs: 16 },
      { timestamp: 182, source: 'CanvasPerfBrowserAdapter', frameIntervalMs: 50 }
    ]);
    expect(animationFrames.cancel).toHaveBeenCalledTimes(1);
  });

  it('shares one sampler across overlapping sessions and stops after the last session', () => {
    const animationFrames = manualAnimationFrames();
    const frameIntervals: unknown[] = [];
    const adapter = createCanvasPerfBrowserAdapter({
      performanceApi: { mark: vi.fn(), measure: vi.fn() },
      requestAnimationFrame: animationFrames.request,
      cancelAnimationFrame: animationFrames.cancel,
      onFrameInterval: (frameInterval) => frameIntervals.push(frameInterval)
    });

    adapter.recordEvent(sessionStart('camera-pan:1', 'camera-pan'));
    expect(animationFrames.pendingCount()).toBe(1);
    adapter.recordEvent(sessionStart('pointer-move-node:2', 'pointer-move-node'));
    expect(animationFrames.pendingCount()).toBe(1);

    animationFrames.fire(100);
    adapter.recordEvent(sessionEnd('camera-pan:1', 'camera-pan'));
    expect(animationFrames.pendingCount()).toBe(1);
    animationFrames.fire(116);
    adapter.recordEvent(sessionEnd('pointer-move-node:2', 'pointer-move-node'));

    expect(frameIntervals).toEqual([
      { timestamp: 116, source: 'CanvasPerfBrowserAdapter', frameIntervalMs: 16 }
    ]);
    expect(animationFrames.pendingCount()).toBe(0);
    expect(animationFrames.cancel).toHaveBeenCalledTimes(1);
  });

  it('measures browser frames independently of high-volume business events', () => {
    const animationFrames = manualAnimationFrames();
    const frameIntervals: unknown[] = [];
    const adapter = createCanvasPerfBrowserAdapter({
      performanceApi: { mark: vi.fn(), measure: vi.fn() },
      requestAnimationFrame: animationFrames.request,
      cancelAnimationFrame: animationFrames.cancel,
      onFrameInterval: (frameInterval) => frameIntervals.push(frameInterval)
    });

    adapter.recordEvent(sessionStart('camera-pan:1', 'camera-pan'));
    animationFrames.fire(100);
    for (let index = 0; index < 20; index += 1) {
      adapter.recordEvent({
        kind: 'counter',
        timestamp: 101 + index,
        source: 'CanvasStageRuntime',
        name: 'stage-camera-write',
        value: 1
      });
    }
    animationFrames.fire(120);
    adapter.recordEvent(sessionEnd('camera-pan:1', 'camera-pan'));

    expect(frameIntervals).toEqual([
      { timestamp: 120, source: 'CanvasPerfBrowserAdapter', frameIntervalMs: 20 }
    ]);
  });

  it('ignores high-volume frame intervals and counter events unless explicitly enabled', () => {
    const mark = vi.fn();
    const adapter = createCanvasPerfBrowserAdapter({ performanceApi: { mark, measure: vi.fn() } });

    adapter.recordEvent({ kind: 'counter', timestamp: 1, source: 'CanvasSurface', name: 'react-commit', value: 1 });
    adapter.recordEvent({
      kind: 'counter',
      timestamp: 3,
      source: 'CanvasPreviewResourceScheduler',
      name: 'preview-resource-started',
      value: 1
    });
    adapter.recordEvent({
      kind: 'frame-interval',
      timestamp: 2,
      source: 'CanvasPerfBrowserAdapter',
      frameIntervalMs: 16
    });

    expect(mark).not.toHaveBeenCalled();
  });
});

function sessionStart(
  sessionId: 'camera-pan:1' | 'pointer-move-node:2',
  sessionType: 'camera-pan' | 'pointer-move-node'
): CanvasPerfTraceEvent {
  return {
    kind: 'session-start',
    sessionId,
    type: sessionType,
    timestamp: 100,
    source: 'CanvasSurface',
    detail: { minimapOpen: false }
  };
}

function sessionEnd(
  sessionId: 'camera-pan:1' | 'pointer-move-node:2',
  sessionType: 'camera-pan' | 'pointer-move-node'
): CanvasPerfTraceEvent {
  return {
    kind: 'session-end',
    sessionId,
    timestamp: 150,
    source: 'CanvasSurface',
    summary: {
      sessionId,
      type: sessionType,
      durationMs: 50,
      frameIntervalCount: 2,
      p50FrameIntervalMs: 16,
      p95FrameIntervalMs: 24,
      p99FrameIntervalMs: 24,
      minFrameIntervalMs: 16,
      maxFrameIntervalMs: 24,
      mountedNodeCount: 8,
      visibleNodeCount: 5,
      culledNodeCount: 3,
      zoomLevel: 1.25,
      cameraState: 'idle',
      counters: {}
    }
  };
}

function manualAnimationFrames(): {
  request: (callback: FrameRequestCallback) => number;
  cancel: ReturnType<typeof vi.fn<(id: number) => void>>;
  fire: (timestamp: number) => void;
  pendingCount: () => number;
} {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const request = (callback: FrameRequestCallback) => {
    const id = nextId;
    nextId += 1;
    callbacks.set(id, callback);
    return id;
  };
  const cancel = vi.fn<(id: number) => void>((id) => {
    callbacks.delete(id);
  });
  return {
    request,
    cancel,
    fire(timestamp) {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) {
        callback(timestamp);
      }
    },
    pendingCount: () => callbacks.size
  };
}
