import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CANVAS_PREVIEW_QUALITY_SETTLE_MS,
  createCanvasResourceZoomSettlement,
  initialCanvasResourceZoom
} from './CanvasResourceZoom.js';

describe('CanvasResourceZoom', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts at the current camera zoom', () => {
    expect(initialCanvasResourceZoom(1.25)).toBe(1.25);
  });

  it('publishes the latest zoom only after 500ms of uninterrupted camera quiet', () => {
    vi.useFakeTimers();
    const snapshot = cameraSnapshot('moving', 2);
    const settled: number[] = [];
    const settlement = createCanvasResourceZoomSettlement({
      initialZoom: 1,
      getCameraSnapshot: () => snapshot,
      onSettledZoom: (zoom) => settled.push(zoom)
    });

    settlement.observeCamera(2);
    snapshot.cameraState = 'idle';
    vi.advanceTimersByTime(CANVAS_PREVIEW_QUALITY_SETTLE_MS - 1);
    expect(settled).toEqual([]);
    vi.advanceTimersByTime(1);

    expect(settled).toEqual([2]);
  });

  it('restarts the one settlement timer from each live camera update', () => {
    vi.useFakeTimers();
    const snapshot = cameraSnapshot('moving', 2);
    const settled: number[] = [];
    const settlement = createCanvasResourceZoomSettlement({
      initialZoom: 1,
      getCameraSnapshot: () => snapshot,
      onSettledZoom: (zoom) => settled.push(zoom)
    });

    settlement.observeCamera(2);
    vi.advanceTimersByTime(300);
    snapshot.camera.z = 3;
    settlement.observeCamera(3);
    snapshot.cameraState = 'idle';
    vi.advanceTimersByTime(499);
    expect(settled).toEqual([]);
    vi.advanceTimersByTime(1);

    expect(settled).toEqual([3]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not add the camera-idle transition as a second timer', () => {
    vi.useFakeTimers();
    const snapshot = cameraSnapshot('moving', 2);
    const settled: number[] = [];
    const settlement = createCanvasResourceZoomSettlement({
      initialZoom: 1,
      getCameraSnapshot: () => snapshot,
      onSettledZoom: (zoom) => settled.push(zoom)
    });

    settlement.observeCamera(2);
    snapshot.cameraState = 'idle';
    vi.advanceTimersByTime(64);

    expect(settled).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(CANVAS_PREVIEW_QUALITY_SETTLE_MS - 64);
    expect(settled).toEqual([2]);
  });

  it('does not publish if the camera is moving at the settlement boundary', () => {
    vi.useFakeTimers();
    const snapshot = cameraSnapshot('moving', 2);
    const settled: number[] = [];
    const settlement = createCanvasResourceZoomSettlement({
      initialZoom: 1,
      getCameraSnapshot: () => snapshot,
      onSettledZoom: (zoom) => settled.push(zoom)
    });

    settlement.observeCamera(2);
    vi.advanceTimersByTime(CANVAS_PREVIEW_QUALITY_SETTLE_MS);

    expect(settled).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not schedule quality work for a pure pan at the current resource zoom', () => {
    vi.useFakeTimers();
    const snapshot = cameraSnapshot('moving', 1);
    const settled = vi.fn();
    const settlement = createCanvasResourceZoomSettlement({
      initialZoom: 1,
      getCameraSnapshot: () => snapshot,
      onSettledZoom: settled
    });

    settlement.observeCamera(1);

    expect(vi.getTimerCount()).toBe(0);
    expect(settled).not.toHaveBeenCalled();
  });

  it('cancels pending settlement when zoom returns to the current resource zoom', () => {
    vi.useFakeTimers();
    const snapshot = cameraSnapshot('moving', 2);
    const settled = vi.fn();
    const settlement = createCanvasResourceZoomSettlement({
      initialZoom: 1,
      getCameraSnapshot: () => snapshot,
      onSettledZoom: settled
    });

    settlement.observeCamera(2);
    snapshot.camera.z = 1;
    settlement.observeCamera(1);
    snapshot.cameraState = 'idle';
    vi.advanceTimersByTime(CANVAS_PREVIEW_QUALITY_SETTLE_MS);

    expect(vi.getTimerCount()).toBe(0);
    expect(settled).not.toHaveBeenCalled();
  });

  it('cancels pending settlement when disposed', () => {
    vi.useFakeTimers();
    const snapshot = cameraSnapshot('moving', 2);
    const settled = vi.fn();
    const settlement = createCanvasResourceZoomSettlement({
      initialZoom: 1,
      getCameraSnapshot: () => snapshot,
      onSettledZoom: settled
    });

    settlement.observeCamera(2);
    settlement.dispose();
    snapshot.cameraState = 'idle';
    vi.advanceTimersByTime(CANVAS_PREVIEW_QUALITY_SETTLE_MS);

    expect(vi.getTimerCount()).toBe(0);
    expect(settled).not.toHaveBeenCalled();
  });
});

function cameraSnapshot(cameraState: 'idle' | 'moving', z: number): {
  cameraState: 'idle' | 'moving';
  camera: { z: number };
} {
  return {
    cameraState,
    camera: { z }
  };
}
