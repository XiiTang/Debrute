import { describe, expect, it } from 'vitest';
import {
  createCanvasPerfDebugBridge,
  type DebruteCanvasPerfCanvasSnapshot,
  type DebruteCanvasPerfDebugGlobal
} from './CanvasPerfDebugBridge';
import type { CanvasPerfCounterTotals, CanvasPerfMonitor, CanvasPerfTrace } from './CanvasPerfMonitor';

describe('CanvasPerfDebugBridge', () => {
  it('registers only when enabled and unregisters only its own API', () => {
    const globalObject: DebruteCanvasPerfDebugGlobal = {};
    const first = createCanvasPerfDebugBridge({
      enabled: false,
      globalObject,
      perfMonitor: monitor(),
      getCanvasSnapshot: snapshot
    });
    first.register();
    expect(globalObject.__debruteCanvasPerf).toBeUndefined();

    const second = createCanvasPerfDebugBridge({
      enabled: true,
      globalObject,
      perfMonitor: monitor(),
      getCanvasSnapshot: snapshot
    });
    second.register();
    const secondApi = globalObject.__debruteCanvasPerf;
    expect(secondApi).toBeDefined();

    const third = createCanvasPerfDebugBridge({
      enabled: true,
      globalObject,
      perfMonitor: monitor(),
      getCanvasSnapshot: snapshot
    });
    third.register();
    expect(globalObject.__debruteCanvasPerf).not.toBe(secondApi);

    second.unregister();
    expect(globalObject.__debruteCanvasPerf).toBeDefined();

    third.unregister();
    expect(globalObject.__debruteCanvasPerf).toBeUndefined();
  });

  it('starts a clean capture by resetting the monitor and setting state metadata', () => {
    const fakeMonitor = monitor();
    const bridge = createCanvasPerfDebugBridge({
      enabled: true,
      globalObject: {},
      perfMonitor: fakeMonitor,
      getCanvasSnapshot: snapshot,
      now: times(100)
    });

    const state = bridge.api.startCapture({ label: 'pan-heavy-canvas' });

    expect(fakeMonitor.resetCount).toBe(1);
    expect(state).toEqual({
      enabled: true,
      capturing: true,
      label: 'pan-heavy-canvas',
      startedAt: 100
    });
    expect(bridge.api.getState()).toEqual(state);
  });

  it('restarts capture cleanly when startCapture is called while active', () => {
    const fakeMonitor = monitor();
    const bridge = createCanvasPerfDebugBridge({
      enabled: true,
      globalObject: {},
      perfMonitor: fakeMonitor,
      getCanvasSnapshot: snapshot,
      now: times(10, 20)
    });

    bridge.api.startCapture({ label: 'first' });
    const state = bridge.api.startCapture({ label: 'second' });

    expect(fakeMonitor.resetCount).toBe(2);
    expect(state).toEqual({
      enabled: true,
      capturing: true,
      label: 'second',
      startedAt: 20
    });
  });

  it('stops capture and returns trace, counters, duration, label, and canvas snapshot', () => {
    const fakeMonitor = monitor();
    const bridge = createCanvasPerfDebugBridge({
      enabled: true,
      globalObject: {},
      perfMonitor: fakeMonitor,
      getCanvasSnapshot: snapshot,
      now: times(100, 160)
    });

    bridge.api.startCapture({ label: 'drag' });
    fakeMonitor.trace = {
      enabled: true,
      events: [{
        kind: 'counter',
        timestamp: 110,
        source: 'CanvasStageRuntime',
        name: 'stage-camera-write',
        value: 2
      }],
      sessions: []
    };
    fakeMonitor.counters = { 'stage-camera-write': 2 };
    const capture = bridge.api.stopCapture();

    expect(capture).toEqual({
      version: 1,
      label: 'drag',
      startedAt: 100,
      endedAt: 160,
      durationMs: 60,
      trace: fakeMonitor.trace,
      counterTotals: { 'stage-camera-write': 2 },
      canvas: snapshot()
    });
    expect(bridge.api.getState()).toEqual({
      enabled: true,
      capturing: false,
      label: 'drag',
      startedAt: 100,
      lastExportedAt: 160
    });
  });

  it('exports clean hot-path counters without requiring image runtime work counters', () => {
    const fakeMonitor = monitor();
    const bridge = createCanvasPerfDebugBridge({
      enabled: true,
      globalObject: {},
      perfMonitor: fakeMonitor,
      getCanvasSnapshot: snapshot,
      now: times(100, 140)
    });

    bridge.api.startCapture({ label: 'clean-pan' });
    fakeMonitor.trace = {
      enabled: true,
      events: [{
        kind: 'counter',
        timestamp: 110,
        source: 'CanvasStageRuntime',
        name: 'stage-camera-write',
        value: 12
      }, {
        kind: 'counter',
        timestamp: 111,
        source: 'CanvasImageAssetViewportScheduler',
        name: 'image-moving-queued',
        value: 1
      }],
      sessions: []
    };
    fakeMonitor.counters = {
      'stage-camera-write': 12,
      'image-moving-queued': 1
    };
    const capture = bridge.api.stopCapture();

    expect(capture.counterTotals).toEqual({
      'stage-camera-write': 12,
      'image-moving-queued': 1
    });
    expect(capture.counterTotals).not.toHaveProperty('image-plan-rebuild');
    expect(capture.counterTotals).not.toHaveProperty('image-pump');
    expect(capture.counterTotals).not.toHaveProperty('image-node-publish');
  });

  it('returns the latest export when stopCapture is called while inactive', () => {
    const bridge = createCanvasPerfDebugBridge({
      enabled: true,
      globalObject: {},
      perfMonitor: monitor(),
      getCanvasSnapshot: snapshot,
      now: times(100, 120)
    });

    bridge.api.startCapture({ label: 'first' });
    const first = bridge.api.stopCapture();
    const second = bridge.api.stopCapture();

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it('returns an empty capture when stopCapture is called before any capture started', () => {
    const bridge = createCanvasPerfDebugBridge({
      enabled: true,
      globalObject: {},
      perfMonitor: monitor({
        trace: {
          enabled: true,
          events: [{
            kind: 'counter',
            timestamp: 120,
            source: 'CanvasSurface',
            name: 'react-commit',
            value: 1
          }],
          sessions: []
        },
        counters: { 'react-commit': 1 }
      }),
      getCanvasSnapshot: snapshot,
      now: times(250)
    });

    expect(bridge.api.stopCapture()).toEqual({
      version: 1,
      startedAt: 250,
      endedAt: 250,
      durationMs: 0,
      trace: { enabled: true, events: [], sessions: [] },
      counterTotals: {},
      canvas: snapshot()
    });
  });

  it('exports a live capture without changing capture state', () => {
    const bridge = createCanvasPerfDebugBridge({
      enabled: true,
      globalObject: {},
      perfMonitor: monitor(),
      getCanvasSnapshot: snapshot,
      now: times(10, 40)
    });

    bridge.api.startCapture({ label: 'live' });
    const capture = bridge.api.exportCapture();

    expect(capture).toMatchObject({
      version: 1,
      label: 'live',
      startedAt: 10,
      endedAt: 40,
      durationMs: 30
    });
    expect(bridge.api.getState()).toEqual({
      enabled: true,
      capturing: true,
      label: 'live',
      startedAt: 10,
      lastExportedAt: 40
    });
  });

  it('reset clears monitor state, capture metadata, and latest export', () => {
    const fakeMonitor = monitor();
    const bridge = createCanvasPerfDebugBridge({
      enabled: true,
      globalObject: {},
      perfMonitor: fakeMonitor,
      getCanvasSnapshot: snapshot,
      now: times(1, 2, 3)
    });

    bridge.api.startCapture({ label: 'before-reset' });
    bridge.api.stopCapture();
    const state = bridge.api.reset();

    expect(fakeMonitor.resetCount).toBe(2);
    expect(state).toEqual({ enabled: true, capturing: false });
    expect(bridge.api.getState()).toEqual({ enabled: true, capturing: false });
  });

  it('returns JSON-safe export copies that future events cannot mutate', () => {
    const fakeMonitor = monitor();
    const bridge = createCanvasPerfDebugBridge({
      enabled: true,
      globalObject: {},
      perfMonitor: fakeMonitor,
      getCanvasSnapshot: snapshot,
      now: times(1, 2, 3)
    });

    bridge.api.startCapture();
    fakeMonitor.trace = {
      enabled: true,
      events: [{
        kind: 'mark',
        timestamp: 1,
        source: 'CanvasPerfBrowserAdapter',
        name: 'debrute:canvas:test',
        detail: { reason: 'initial' }
      }],
      sessions: []
    };
    const first = bridge.api.exportCapture();
    fakeMonitor.trace.events.push({
      kind: 'counter',
      timestamp: 2,
      source: 'CanvasSurface',
      name: 'react-commit',
      value: 1
    });
    const second = bridge.api.exportCapture();

    expect(first.trace.events).toHaveLength(1);
    expect(second.trace.events).toHaveLength(2);
    expect(() => JSON.stringify(second)).not.toThrow();
    expect(JSON.stringify(second)).not.toContain('[object Map]');
    expect(JSON.stringify(second)).not.toContain('[object Set]');
  });

  it('captures snapshot errors in the payload instead of throwing', () => {
    const bridge = createCanvasPerfDebugBridge({
      enabled: true,
      globalObject: {},
      perfMonitor: monitor(),
      getCanvasSnapshot: () => {
        throw new Error('snapshot unavailable');
      },
      now: times(5)
    });

    const capture = bridge.api.exportCapture();

    expect(capture.canvas).toBeUndefined();
    expect(capture.error).toEqual({ message: 'snapshot unavailable' });
  });
});

interface FakeCanvasPerfMonitor extends Pick<CanvasPerfMonitor, 'getTrace' | 'getCounterTotals' | 'reset'> {
  trace: CanvasPerfTrace;
  counters: CanvasPerfCounterTotals;
  resetCount: number;
}

function monitor(input: {
  trace?: CanvasPerfTrace;
  counters?: CanvasPerfCounterTotals;
} = {}): FakeCanvasPerfMonitor {
  return {
    trace: input.trace ?? { enabled: true, events: [], sessions: [] },
    counters: input.counters ?? {},
    resetCount: 0,
    getTrace() {
      return this.trace;
    },
    getCounterTotals() {
      return this.counters;
    },
    reset() {
      this.resetCount += 1;
      this.trace = { enabled: true, events: [], sessions: [] };
      this.counters = {};
    }
  };
}

function snapshot(): DebruteCanvasPerfCanvasSnapshot {
  return {
    canvasId: 'canvas-1',
    camera: { x: 10, y: 20, z: 1.25 },
    cameraState: 'idle',
    mountedNodeCount: 8,
    visibleNodeCount: 5,
    culledNodeCount: 3,
    activeImageLoadCount: 1,
    pendingImageCount: 2,
    decodedImageCount: 4,
    retainedDecodedImagePixels: 64_000_000,
    oversizedRetainedImageCount: 3,
    downshiftStartCount: 4,
    downshiftResolveCount: 3,
    highResolutionEvictionCount: 2,
    imageResourceZoom: 0.75,
    visiblePreviewWidths: { 300: 2, 1200: 2 },
    nextPreviewWidths: { 600: 1, 2400: 1 },
    imageWorkIntentCounts: {
      'display-critical': 1,
      'downshift-visible': 1,
      'evict-oversized': 1,
      'prefetch-near': 2,
      'upgrade-idle': 1,
      deferred: 4
    },
    imageCancellationReasons: {
      'moving-upgrade': 1,
      'budget-high-resolution': 2
    },
    imageEvictionReasons: {
      'far-high-resolution': 1
    },
    imageLayers: {
      visible: 4,
      next: 2,
      previewSources: 6,
      rawSources: 0
    }
  };
}

function times(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}
