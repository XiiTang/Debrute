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
      frameCount: 2,
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

  it('tolerates browsers that reject mark detail or missing start marks', () => {
    const mark = vi.fn((_: string, options?: PerformanceMarkOptions) => {
      if (options?.detail) {
        throw new Error('detail rejected');
      }
    });
    const measure = vi.fn(() => {
      throw new Error('start mark missing');
    });
    const adapter = createCanvasPerfBrowserAdapter({
      performanceApi: { mark, measure }
    });

    adapter.recordEvent(sessionEnd('camera-pan:1', 'camera-pan'));

    expect(mark).toHaveBeenCalledWith('debrute:canvas:camera-pan:camera-pan:1:end', expect.any(Object));
    expect(mark).toHaveBeenCalledWith('debrute:canvas:camera-pan:camera-pan:1:end');
    expect(measure).toHaveBeenCalled();
  });

  it('swallows mark failures after detail fallback also fails', () => {
    const adapter = createCanvasPerfBrowserAdapter({
      performanceApi: {
        mark: () => {
          throw new Error('mark unavailable');
        },
        measure: vi.fn()
      }
    });

    expect(() => adapter.recordEvent(sessionStart('camera-pan:1', 'camera-pan'))).not.toThrow();
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

    expect(observed).toEqual([{ type: 'long-animation-frame', buffered: true }]);
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

  it('attributes delayed long animation frame callbacks to the session time window', () => {
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

    expect(longAnimationFrames).toEqual([{
      sessionId: 'camera-pan:1',
      timestamp: expect.any(Number),
      source: 'CanvasPerfBrowserAdapter',
      entry: {
        startTime: 120,
        duration: 60,
        blockingDuration: 35,
        scripts: []
      }
    }]);
  });

  it('ignores high-volume frame and counter events unless explicitly enabled', () => {
    const mark = vi.fn();
    const adapter = createCanvasPerfBrowserAdapter({ performanceApi: { mark, measure: vi.fn() } });

    adapter.recordEvent({ kind: 'counter', timestamp: 1, source: 'CanvasSurface', name: 'react-commit', value: 1 });
    adapter.recordEvent({
      kind: 'frame',
      timestamp: 2,
      source: 'CanvasSurface',
      elapsedMs: 16,
      cameraState: 'moving',
      mountedNodeCount: 1,
      visibleNodeCount: 1,
      culledNodeCount: 0,
      activeImageLoadCount: 0,
      pendingImageCount: 0,
      decodedImageCount: 0,
      reactCommitCount: 0,
      renderSnapshotBuildCount: 0,
      renderSnapshotReuseCount: 0,
      stageWriteCount: 0,
      imageRuntimeWorkCount: 0
    });

    expect(mark).not.toHaveBeenCalled();
  });
});

function sessionStart(sessionId: 'camera-pan:1', sessionType: 'camera-pan'): CanvasPerfTraceEvent {
  return {
    kind: 'session-start',
    sessionId,
    type: sessionType,
    timestamp: 100,
    source: 'CanvasSurface',
    detail: { minimapOpen: false }
  };
}

function sessionEnd(sessionId: 'camera-pan:1', sessionType: 'camera-pan'): CanvasPerfTraceEvent {
  return {
    kind: 'session-end',
    sessionId,
    timestamp: 150,
    source: 'CanvasSurface',
    summary: {
      sessionId,
      type: sessionType,
      durationMs: 50,
      frameCount: 2,
      p50FrameMs: 16,
      p95FrameMs: 24,
      p99FrameMs: 24,
      minFrameMs: 16,
      maxFrameMs: 24,
      mountedNodeCount: 8,
      visibleNodeCount: 5,
      culledNodeCount: 3,
      activeImageLoadCount: 1,
      pendingImageCount: 2,
      decodedImageCount: 4,
      zoomLevel: 1.25,
      cameraState: 'idle',
      counters: {}
    }
  };
}
