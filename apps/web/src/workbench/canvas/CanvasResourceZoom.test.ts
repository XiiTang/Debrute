import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CANVAS_PREVIEW_QUALITY_SETTLE_MS,
  createCanvasResourceZoomSettlement,
  initialCanvasResourceZoom
} from './CanvasResourceZoom';

describe('CanvasResourceZoom', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts at the current camera zoom', () => {
    expect(initialCanvasResourceZoom(1.25)).toBe(1.25);
  });

  it('publishes the settled zoom through one external-store snapshot', () => {
    vi.useFakeTimers();
    const snapshot = cameraSnapshot('moving', 2);
    const settlement = createAttachedSettlement({
      initialZoom: 1,
      getCameraSnapshot: () => snapshot
    });
    const listener = vi.fn();
    const unsubscribe = settlement.subscribe(listener);

    expect(settlement.getSnapshot()).toBe(1);

    settlement.observeCamera(2);
    snapshot.cameraState = 'idle';
    vi.advanceTimersByTime(CANVAS_PREVIEW_QUALITY_SETTLE_MS);

    expect(settlement.getSnapshot()).toBe(2);
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    snapshot.cameraState = 'moving';
    snapshot.camera.z = 3;
    settlement.observeCamera(3);
    snapshot.cameraState = 'idle';
    vi.advanceTimersByTime(CANVAS_PREVIEW_QUALITY_SETTLE_MS);

    expect(settlement.getSnapshot()).toBe(3);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('publishes the latest zoom only after 160ms of uninterrupted camera quiet', () => {
    vi.useFakeTimers();
    const snapshot = cameraSnapshot('moving', 2);
    const settlement = createAttachedSettlement({
      initialZoom: 1,
      getCameraSnapshot: () => snapshot
    });
    const settled = settledZooms(settlement);

    settlement.observeCamera(2);
    snapshot.cameraState = 'idle';
    vi.advanceTimersByTime(159);
    expect(settled).toEqual([]);
    vi.advanceTimersByTime(1);

    expect(settled).toEqual([2]);
  });

  it('restarts the one settlement timer from each live camera update', () => {
    vi.useFakeTimers();
    const snapshot = cameraSnapshot('moving', 2);
    const settlement = createAttachedSettlement({
      initialZoom: 1,
      getCameraSnapshot: () => snapshot
    });
    const settled = settledZooms(settlement);

    settlement.observeCamera(2);
    vi.advanceTimersByTime(80);
    snapshot.camera.z = 3;
    settlement.observeCamera(3);
    snapshot.cameraState = 'idle';
    vi.advanceTimersByTime(159);
    expect(settled).toEqual([]);
    vi.advanceTimersByTime(1);

    expect(settled).toEqual([3]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not add the camera-idle transition as a second timer', () => {
    vi.useFakeTimers();
    const snapshot = cameraSnapshot('moving', 2);
    const settlement = createAttachedSettlement({
      initialZoom: 1,
      getCameraSnapshot: () => snapshot
    });
    const settled = settledZooms(settlement);

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
    const settlement = createAttachedSettlement({
      initialZoom: 1,
      getCameraSnapshot: () => snapshot
    });
    const settled = settledZooms(settlement);

    settlement.observeCamera(2);
    vi.advanceTimersByTime(CANVAS_PREVIEW_QUALITY_SETTLE_MS);

    expect(settled).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not schedule quality work for a pure pan at the current resource zoom', () => {
    vi.useFakeTimers();
    const snapshot = cameraSnapshot('moving', 1);
    const settled = vi.fn();
    const settlement = createAttachedSettlement({
      initialZoom: 1,
      getCameraSnapshot: () => snapshot
    });
    settlement.subscribe(settled);

    settlement.observeCamera(1);

    expect(vi.getTimerCount()).toBe(0);
    expect(settled).not.toHaveBeenCalled();
  });

  it('cancels pending settlement when zoom returns to the current resource zoom', () => {
    vi.useFakeTimers();
    const snapshot = cameraSnapshot('moving', 2);
    const settled = vi.fn();
    const settlement = createAttachedSettlement({
      initialZoom: 1,
      getCameraSnapshot: () => snapshot
    });
    settlement.subscribe(settled);

    settlement.observeCamera(2);
    snapshot.camera.z = 1;
    settlement.observeCamera(1);
    snapshot.cameraState = 'idle';
    vi.advanceTimersByTime(CANVAS_PREVIEW_QUALITY_SETTLE_MS);

    expect(vi.getTimerCount()).toBe(0);
    expect(settled).not.toHaveBeenCalled();
  });

  it('cancels pending settlement when detached', () => {
    vi.useFakeTimers();
    const snapshot = cameraSnapshot('moving', 2);
    const settled = vi.fn();
    const settlement = createCanvasResourceZoomSettlement({
      initialZoom: 1,
      getCameraSnapshot: () => snapshot
    });
    const detach = settlement.attach();
    settlement.subscribe(settled);

    settlement.observeCamera(2);
    detach();
    snapshot.cameraState = 'idle';
    vi.advanceTimersByTime(CANVAS_PREVIEW_QUALITY_SETTLE_MS);

    expect(vi.getTimerCount()).toBe(0);
    expect(settled).not.toHaveBeenCalled();
  });
});

function createAttachedSettlement(
  input: Parameters<typeof createCanvasResourceZoomSettlement>[0]
): ReturnType<typeof createCanvasResourceZoomSettlement> {
  const settlement = createCanvasResourceZoomSettlement(input);
  settlement.attach();
  return settlement;
}

function settledZooms(
  settlement: ReturnType<typeof createCanvasResourceZoomSettlement>
): number[] {
  const settled: number[] = [];
  settlement.subscribe(() => settled.push(settlement.getSnapshot()));
  return settled;
}

function cameraSnapshot(cameraState: 'idle' | 'moving', z: number): {
  cameraState: 'idle' | 'moving';
  camera: { z: number };
} {
  return {
    cameraState,
    camera: { z }
  };
}
