import { describe, expect, it, vi } from 'vitest';
import {
  createCanvasPerfMonitor,
  type CanvasPerfCounterName,
  type CanvasPerfFrameInput,
  type CanvasPerfTraceEvent
} from './CanvasPerfMonitor';

describe('CanvasPerfMonitor', () => {
  it('records ordered session, counter, frame, mark, LoAF, and summary data', () => {
    const emitted: CanvasPerfTraceEvent[] = [];
    const monitor = createCanvasPerfMonitor({
      enabled: true,
      onEvent: (event) => emitted.push(event)
    });

    const sessionId = monitor.startSession({
      type: 'camera-pan',
      timestamp: 100,
      source: 'CanvasSurface',
      detail: { minimapOpen: false }
    });
    if (!sessionId) {
      throw new Error('Expected enabled monitor to start a session.');
    }

    monitor.recordCounter({ timestamp: 108, source: 'CanvasStageRuntime', name: 'stage-camera-write' });
    monitor.recordFrame(frame(116, 16, { reactCommitCount: 0 }));
    monitor.recordCounter({ timestamp: 120, source: 'CanvasSurface', name: 'react-commit' });
    monitor.recordFrame(frame(132, 24, { reactCommitCount: 1 }));
    monitor.recordLongAnimationFrame({
      timestamp: 140,
      source: 'CanvasPerfBrowserAdapter',
      entry: {
        startTime: 130,
        duration: 72,
        blockingDuration: 40,
        scripts: [{ sourceURL: 'http://localhost/src/canvas.ts', invoker: 'requestAnimationFrame', duration: 38 }]
      }
    });
    monitor.recordMark({
      timestamp: 145,
      source: 'CanvasPerfBrowserAdapter',
      name: 'debrute:canvas:manual-check',
      detail: { reason: 'test' }
    });

    const summary = monitor.endSession({
      sessionId,
      timestamp: 160,
      source: 'CanvasSurface',
      finalState: {
        mountedNodeCount: 8,
        visibleNodeCount: 5,
        culledNodeCount: 3,
        zoomLevel: 1.25,
        cameraState: 'idle'
      }
    });

    expect(sessionId).toBe('camera-pan:1');
    expect(summary).toMatchObject({
      sessionId,
      type: 'camera-pan',
      durationMs: 60,
      frameCount: 2,
      p50FrameMs: 16,
      p95FrameMs: 24,
      p99FrameMs: 24,
      minFrameMs: 16,
      maxFrameMs: 24,
      mountedNodeCount: 8,
      visibleNodeCount: 5,
      culledNodeCount: 3,
      zoomLevel: 1.25,
      cameraState: 'idle',
      counters: {
        'stage-camera-write': 1,
        'react-commit': 1
      },
      longAnimationFrames: [{
        startTime: 130,
        duration: 72,
        blockingDuration: 40,
        scripts: [{ sourceURL: 'http://localhost/src/canvas.ts', invoker: 'requestAnimationFrame', duration: 38 }]
      }]
    });

    const trace = monitor.getTrace();
    expect(trace.events.map((event) => event.kind)).toEqual([
      'session-start',
      'counter',
      'frame',
      'counter',
      'frame',
      'long-animation-frame',
      'mark',
      'session-end'
    ]);
    expect(emitted.map((event) => event.kind)).toEqual(trace.events.map((event) => event.kind));
    expect(monitor.getLastSession()).toEqual(summary);
  });

  it('targets an explicit counter session instead of all active sessions', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const camera = monitor.startSession({ type: 'camera-pan', timestamp: 0, source: 'CanvasSurface' });
    const drag = monitor.startSession({ type: 'drag-move-node', timestamp: 5, source: 'CanvasSurface' });
    if (!camera || !drag) {
      throw new Error('Expected enabled monitor to start sessions.');
    }

    monitor.recordCounter({
      sessionId: drag,
      timestamp: 10,
      source: 'CanvasStageRuntime',
      name: 'stage-node-layout-write',
      value: 2
    });

    const dragSummary = monitor.endSession({ sessionId: drag, timestamp: 20, source: 'CanvasSurface' });
    const cameraSummary = monitor.endSession({ sessionId: camera, timestamp: 30, source: 'CanvasSurface' });

    expect(dragSummary?.counters).toEqual({ 'stage-node-layout-write': 2 });
    expect(cameraSummary?.counters).toEqual({});
  });

  it('targets an explicit session plus matching active session types', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const camera = monitor.startSession({ type: 'camera-pan', timestamp: 0, source: 'CanvasSurface' });
    const drag = monitor.startSession({ type: 'drag-move-node', timestamp: 2, source: 'CanvasSurface' });
    if (!camera || !drag) {
      throw new Error('Expected enabled monitor to start sessions.');
    }

    monitor.recordCounter({
      sessionId: drag,
      sessionTypes: ['camera-pan'],
      timestamp: 10,
      source: 'CanvasImageNodeAsset',
      name: 'image-node-handoff-promote'
    });

    const dragSummary = monitor.endSession({ sessionId: drag, timestamp: 20, source: 'CanvasSurface' });
    const cameraSummary = monitor.endSession({ sessionId: camera, timestamp: 30, source: 'CanvasSurface' });

    expect(dragSummary?.counters).toEqual({ 'image-node-handoff-promote': 1 });
    expect(cameraSummary?.counters).toEqual({ 'image-node-handoff-promote': 1 });
  });

  it('records image node asset counters in totals and summaries', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const sessionId = monitor.startSession({ type: 'camera-pan', timestamp: 0, source: 'CanvasSurface' });
    if (!sessionId) {
      throw new Error('Expected enabled monitor to start a session.');
    }

    monitor.recordCounter({ sessionId, timestamp: 1, source: 'CanvasImageNodeAsset', name: 'image-node-url-resolve' });
    monitor.recordCounter({ sessionId, timestamp: 2, source: 'CanvasImageNodeAsset', name: 'image-node-next-load-start' });
    monitor.recordCounter({ sessionId, timestamp: 3, source: 'CanvasImageNodeAsset', name: 'image-node-next-load-resolve' });
    monitor.recordCounter({ sessionId, timestamp: 4, source: 'CanvasImageNodeAsset', name: 'image-node-handoff-promote' });
    monitor.recordCounter({ sessionId, timestamp: 5, source: 'CanvasImageNodeAsset', name: 'image-node-upgrade-skip-culled' });
    monitor.recordCounter({ sessionId, timestamp: 6, source: 'CanvasPreviewResourceScheduler', name: 'preview-resource-queued' });
    monitor.recordCounter({ sessionId, timestamp: 7, source: 'CanvasPreviewResourceScheduler', name: 'preview-resource-started' });

    const summary = monitor.endSession({ sessionId, timestamp: 10, source: 'CanvasSurface' });

    expect(monitor.getCounterTotals()).toEqual({
      'image-node-url-resolve': 1,
      'image-node-next-load-start': 1,
      'image-node-next-load-resolve': 1,
      'image-node-handoff-promote': 1,
      'image-node-upgrade-skip-culled': 1,
      'preview-resource-queued': 1,
      'preview-resource-started': 1
    });
    expect(summary?.counters).toEqual(monitor.getCounterTotals());
  });

  it('is inert when disabled', () => {
    const listener = vi.fn();
    const monitor = createCanvasPerfMonitor({ enabled: false, onEvent: listener });

    const sessionId = monitor.startSession({ type: 'camera-pan', timestamp: 0, source: 'CanvasSurface' });
    monitor.recordCounter({ timestamp: 1, source: 'CanvasStageRuntime', name: 'stage-camera-write' });
    monitor.recordFrame(frame(2, 16));
    monitor.recordLongAnimationFrame({
      timestamp: 3,
      source: 'CanvasPerfBrowserAdapter',
      entry: { startTime: 0, duration: 80, blockingDuration: 50, scripts: [] }
    });

    expect(sessionId).toBeUndefined();
    expect(monitor.endSession({ sessionId: 'camera-pan:1', timestamp: 20, source: 'CanvasSurface' })).toBeUndefined();
    expect(monitor.getLastSession()).toBeUndefined();
    expect(monitor.getTrace()).toEqual({ enabled: false, events: [], sessions: [] });
    expect(listener).not.toHaveBeenCalled();
  });

  it('returns undefined when ending a missing session', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });

    expect(monitor.endSession({ sessionId: 'camera-pan:999', timestamp: 10, source: 'CanvasSurface' })).toBeUndefined();
    expect(monitor.getTrace().events).toEqual([]);
  });

  it('attaches explicit late LoAF entries to completed sessions', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const sessionId = monitor.startSession({ type: 'camera-pan', timestamp: 100, source: 'CanvasSurface' });
    if (!sessionId) {
      throw new Error('Expected enabled monitor to start a session.');
    }

    monitor.endSession({ sessionId, timestamp: 150, source: 'CanvasSurface' });
    monitor.recordLongAnimationFrame({
      sessionId,
      timestamp: 180,
      source: 'CanvasPerfBrowserAdapter',
      entry: { startTime: 120, duration: 60, blockingDuration: 35, scripts: [] }
    });

    expect(monitor.getTrace().sessions[0]?.longAnimationFrames).toEqual([{
      startTime: 120,
      duration: 60,
      blockingDuration: 35,
      scripts: []
    }]);
    expect(monitor.getLastSession()?.longAnimationFrames).toEqual(monitor.getTrace().sessions[0]?.longAnimationFrames);
  });

  it('does not invent final canvas state when a session has no frame or final state', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const sessionId = monitor.startSession({ type: 'drag-resize-node', timestamp: 0, source: 'CanvasSurface' });
    if (!sessionId) {
      throw new Error('Expected enabled monitor to start a session.');
    }

    const summary = monitor.endSession({ sessionId, timestamp: 10, source: 'CanvasSurface' });

    expect(summary).not.toHaveProperty('mountedNodeCount');
    expect(summary).not.toHaveProperty('zoomLevel');
    expect(summary).not.toHaveProperty('cameraState');
  });
});

function frame(
  timestamp: number,
  elapsedMs: number,
  overrides: Partial<CanvasPerfFrameInput> = {}
): CanvasPerfFrameInput {
  return {
    timestamp,
    source: 'CanvasSurface',
    elapsedMs,
    cameraState: 'moving',
    mountedNodeCount: 8,
    visibleNodeCount: 5,
    culledNodeCount: 3,
    reactCommitCount: 0,
    renderSnapshotBuildCount: 0,
    renderSnapshotReuseCount: 0,
    stageWriteCount: 0,
    imageNodeWorkCount: 0,
    ...overrides
  };
}

export function counterNames(events: readonly CanvasPerfTraceEvent[]): CanvasPerfCounterName[] {
  return events
    .filter((event): event is Extract<CanvasPerfTraceEvent, { kind: 'counter' }> => event.kind === 'counter')
    .map((event) => event.name);
}
