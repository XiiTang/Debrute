import { describe, expect, it } from 'vitest';
import {
  createCanvasPerfMonitor,
  type CanvasPerfFrameInput
} from './CanvasPerfMonitor';

describe('CanvasPerfMonitor', () => {
  it('summarizes camera frame timings and runtime counts', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });

    monitor.startCameraSession({
      type: 'panning',
      timestamp: 100,
      minimapOpen: true
    });

    const frames: CanvasPerfFrameInput[] = [
      { elapsedMs: 8, mountedNodeCount: 20, visibleNodeCount: 8, culledNodeCount: 12, activeImageLoadCount: 1, pendingImageCount: 3, decodedImageCount: 0, reactCommitCount: 0 },
      { elapsedMs: 16, mountedNodeCount: 20, visibleNodeCount: 9, culledNodeCount: 11, activeImageLoadCount: 1, pendingImageCount: 2, decodedImageCount: 1, reactCommitCount: 0 },
      { elapsedMs: 24, mountedNodeCount: 22, visibleNodeCount: 10, culledNodeCount: 12, activeImageLoadCount: 0, pendingImageCount: 1, decodedImageCount: 2, reactCommitCount: 1 }
    ];

    for (const frame of frames) {
      monitor.recordFrame(frame);
    }

    const summary = monitor.endCameraSession({ timestamp: 160 });

    expect(summary).toEqual({
      type: 'panning',
      durationMs: 60,
      frameCount: 3,
      p50FrameMs: 16,
      p95FrameMs: 24,
      p99FrameMs: 24,
      mountedNodeCount: 22,
      visibleNodeCount: 10,
      culledNodeCount: 12,
      activeImageLoadCount: 0,
      pendingImageCount: 1,
      decodedImageCount: 2,
      minimapOpen: true,
      reactCommitCount: 1
    });
  });

  it('is inert when disabled', () => {
    const monitor = createCanvasPerfMonitor({ enabled: false });

    monitor.startCameraSession({ type: 'zooming', timestamp: 0, minimapOpen: false });
    monitor.recordFrame({ elapsedMs: 20, mountedNodeCount: 1, visibleNodeCount: 1, culledNodeCount: 0, activeImageLoadCount: 0, pendingImageCount: 0, decodedImageCount: 0, reactCommitCount: 0 });

    expect(monitor.endCameraSession({ timestamp: 20 })).toBeUndefined();
    expect(monitor.getLastCameraSession()).toBeUndefined();
  });
});
