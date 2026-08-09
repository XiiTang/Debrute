import { describe, expect, it } from 'vitest';
import {
  createCanvasPerfMonitor,
  type CanvasPerfCounterName,
  type CanvasPerfFrameIntervalInput,
  type CanvasPerfTraceEvent
} from './CanvasPerfMonitor';

describe('CanvasPerfMonitor', () => {
  it('records ordered session, counter, frame interval, mark, LoAF, and summary data', () => {
    const emitted: CanvasPerfTraceEvent[] = [];
    const monitor = createCanvasPerfMonitor({
      onEvent: (event) => emitted.push(event)
    });

    const sessionId = monitor.startSession({
      type: 'camera-pan',
      timestamp: 100,
      source: 'CanvasSurface',
      detail: { minimapOpen: false }
    });

    monitor.recordCounter({ timestamp: 108, source: 'CanvasStageRuntime', name: 'stage-camera-write' });
    monitor.recordFrameInterval(frameInterval(116, 16));
    monitor.recordCounter({ timestamp: 120, source: 'CanvasSurface', name: 'react-commit' });
    monitor.recordFrameInterval(frameInterval(132, 24));
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
      'frame-interval',
      'counter',
      'frame-interval',
      'long-animation-frame',
      'mark',
      'session-end'
    ]);
    expect(emitted.map((event) => event.kind)).toEqual(trace.events.map((event) => event.kind));
    expect(monitor.getLastSession()).toEqual(summary);
  });

  it('targets an explicit counter session instead of all active sessions', () => {
    const monitor = createCanvasPerfMonitor();
    const camera = monitor.startSession({ type: 'camera-pan', timestamp: 0, source: 'CanvasSurface' });
    const drag = monitor.startSession({ type: 'pointer-move-node', timestamp: 5, source: 'CanvasSurface' });

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
    const monitor = createCanvasPerfMonitor();
    const camera = monitor.startSession({ type: 'camera-pan', timestamp: 0, source: 'CanvasSurface' });
    const drag = monitor.startSession({ type: 'pointer-move-node', timestamp: 2, source: 'CanvasSurface' });

    monitor.recordCounter({
      sessionId: drag,
      sessionTypes: ['camera-pan'],
      timestamp: 10,
      source: 'CanvasRasterPreviewPresentation',
      name: 'raster-preview-published'
    });

    const dragSummary = monitor.endSession({ sessionId: drag, timestamp: 20, source: 'CanvasSurface' });
    const cameraSummary = monitor.endSession({ sessionId: camera, timestamp: 30, source: 'CanvasSurface' });

    expect(dragSummary?.counters).toEqual({ 'raster-preview-published': 1 });
    expect(cameraSummary?.counters).toEqual({ 'raster-preview-published': 1 });
  });

  it('records shared raster presentation counters in totals and summaries', () => {
    const monitor = createCanvasPerfMonitor();
    const sessionId = monitor.startSession({ type: 'camera-pan', timestamp: 0, source: 'CanvasSurface' });

    monitor.recordCounter({ sessionId, timestamp: 1, source: 'CanvasRasterPreviewPresentation', name: 'raster-preview-requested' });
    monitor.recordCounter({ sessionId, timestamp: 2, source: 'CanvasRasterPreviewPresentation', name: 'raster-preview-pending-mounted' });
    monitor.recordCounter({ sessionId, timestamp: 3, source: 'CanvasRasterPreviewPresentation', name: 'raster-preview-decoded' });
    monitor.recordCounter({ sessionId, timestamp: 4, source: 'CanvasRasterPreviewPresentation', name: 'raster-preview-published' });
    monitor.recordCounter({ sessionId, timestamp: 5, source: 'CanvasRasterPreviewPresentation', name: 'raster-preview-failed' });
    monitor.recordCounter({ sessionId, timestamp: 6, source: 'CanvasPreviewResourceScheduler', name: 'preview-resource-queued' });
    monitor.recordCounter({ sessionId, timestamp: 7, source: 'CanvasPreviewResourceScheduler', name: 'preview-resource-started' });

    const summary = monitor.endSession({ sessionId, timestamp: 10, source: 'CanvasSurface' });

    expect(monitor.getCounterTotals()).toEqual({
      'raster-preview-requested': 1,
      'raster-preview-pending-mounted': 1,
      'raster-preview-decoded': 1,
      'raster-preview-published': 1,
      'raster-preview-failed': 1,
      'preview-resource-queued': 1,
      'preview-resource-started': 1
    });
    expect(summary?.counters).toEqual(monitor.getCounterTotals());
  });

  it('records text preview counters in totals and summaries', () => {
    const monitor = createCanvasPerfMonitor();
    const sessionId = monitor.startSession({ type: 'camera-pan', timestamp: 0, source: 'CanvasSurface' });

    monitor.recordCounter({ sessionId, timestamp: 1, source: 'CanvasTextPreviewRuntime', name: 'text-preview-source-check-requested' });
    monitor.recordCounter({ sessionId, timestamp: 2, source: 'CanvasTextPreviewRuntime', name: 'text-preview-source-availability-resolved' });
    monitor.recordCounter({ sessionId, timestamp: 3, source: 'CanvasTextPreviewRuntime', name: 'text-preview-capture-ready' });
    monitor.recordCounter({ sessionId, timestamp: 4, source: 'CanvasTextPreviewRuntime', name: 'text-preview-dom-snapshot-completed' });
    monitor.recordCounter({ sessionId, timestamp: 5, source: 'CanvasTextPreviewRuntime', name: 'text-preview-raster-completed' });
    monitor.recordCounter({ sessionId, timestamp: 6, source: 'CanvasTextPreviewRuntime', name: 'text-preview-source-upload-completed' });
    monitor.recordCounter({ sessionId, timestamp: 7, source: 'CanvasTextPreviewRuntime', name: 'text-preview-failed' });

    const summary = monitor.endSession({ sessionId, timestamp: 11, source: 'CanvasSurface' });

    expect(monitor.getCounterTotals()).toEqual({
      'text-preview-source-check-requested': 1,
      'text-preview-source-availability-resolved': 1,
      'text-preview-capture-ready': 1,
      'text-preview-dom-snapshot-completed': 1,
      'text-preview-raster-completed': 1,
      'text-preview-source-upload-completed': 1,
      'text-preview-failed': 1
    });
    expect(summary?.counters).toEqual(monitor.getCounterTotals());
  });

  it('returns undefined when ending a missing session', () => {
    const monitor = createCanvasPerfMonitor();

    expect(monitor.endSession({ sessionId: 'camera-pan:999', timestamp: 10, source: 'CanvasSurface' })).toBeUndefined();
    expect(monitor.getTrace().events).toEqual([]);
  });

  it('attaches explicit late LoAF entries to completed sessions', () => {
    const monitor = createCanvasPerfMonitor();
    const sessionId = monitor.startSession({ type: 'camera-pan', timestamp: 100, source: 'CanvasSurface' });

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
    const monitor = createCanvasPerfMonitor();
    const sessionId = monitor.startSession({ type: 'pointer-resize-node', timestamp: 0, source: 'CanvasSurface' });

    const summary = monitor.endSession({ sessionId, timestamp: 10, source: 'CanvasSurface' });

    expect(summary).not.toHaveProperty('mountedNodeCount');
    expect(summary).not.toHaveProperty('zoomLevel');
    expect(summary).not.toHaveProperty('cameraState');
  });
});

function frameInterval(
  timestamp: number,
  frameIntervalMs: number,
  overrides: Partial<CanvasPerfFrameIntervalInput> = {}
): CanvasPerfFrameIntervalInput {
  return {
    timestamp,
    source: 'CanvasPerfBrowserAdapter',
    frameIntervalMs,
    ...overrides
  };
}

export function counterNames(events: readonly CanvasPerfTraceEvent[]): CanvasPerfCounterName[] {
  return events
    .filter((event): event is Extract<CanvasPerfTraceEvent, { kind: 'counter' }> => event.kind === 'counter')
    .map((event) => event.name);
}
