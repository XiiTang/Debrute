import { describe, expect, it, vi } from 'vitest';
import { createCanvasInteractionRuntime } from './CanvasInteractionRuntime';

describe('CanvasInteractionRuntime', () => {
  it('owns one semantic node hover across Content and content-island targets', () => {
    const runtime = createCanvasInteractionRuntime();

    runtime.updatePointer({
      screenPoint: { x: 20, y: 30 },
      target: { kind: 'node', projectRelativePath: 'notes/readme.md', mediaKind: 'text', zone: 'content', directManipulation: false, contentControl: false }
    });
    expect(runtime.getSnapshot()).toMatchObject({
      hoveredNodePath: 'notes/readme.md',
      gated: false
    });

    runtime.updatePointer({
      screenPoint: { x: 24, y: 34 },
      target: { kind: 'node', projectRelativePath: 'notes/readme.md', mediaKind: 'text', zone: 'content-island', directManipulation: false, contentControl: false }
    });
    expect(runtime.getSnapshot().hoveredNodePath).toBe('notes/readme.md');
  });

  it('clears and freezes hover while the camera moves, then publishes one final idle reconciliation', () => {
    const runtime = createCanvasInteractionRuntime();
    const listener = vi.fn();
    runtime.subscribe(listener);
    runtime.updatePointer({
      screenPoint: { x: 50, y: 60 },
      target: { kind: 'node', projectRelativePath: 'flow/a.png', mediaKind: 'image', zone: 'manipulation', directManipulation: false, contentControl: false }
    });

    runtime.setCameraState('moving');
    runtime.updatePointer({
      screenPoint: { x: 50, y: 60 },
      target: { kind: 'node', projectRelativePath: 'flow/b.png', mediaKind: 'image', zone: 'manipulation', directManipulation: false, contentControl: false }
    });

    expect(runtime.getSnapshot()).toMatchObject({
      hoveredNodePath: undefined,
      gated: true,
      cameraMoving: true,
      pointerInteractionActive: false,
      reconcilePending: true
    });
    expect(runtime.takeReconcilePoint()).toBeUndefined();

    listener.mockClear();
    runtime.setCameraState('idle');
    expect(runtime.getSnapshot()).toMatchObject({
      hoveredNodePath: undefined,
      gated: false,
      cameraMoving: false,
      reconcilePending: true
    });
    expect(listener).toHaveBeenCalledTimes(1);

    expect(runtime.takeReconcilePoint()).toEqual({ x: 50, y: 60 });
    expect(runtime.takeReconcilePoint()).toBeUndefined();
    expect(runtime.getSnapshot().reconcilePending).toBe(true);

    runtime.reconcile({
      kind: 'node',
      projectRelativePath: 'flow/b.png',
      mediaKind: 'image',
      zone: 'manipulation',
      directManipulation: false,
      contentControl: false
    });
    expect(runtime.getSnapshot()).toMatchObject({
      hoveredNodePath: 'flow/b.png',
      reconcilePending: false
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('publishes the completed reconciliation even when the final hover stays empty', () => {
    const runtime = createCanvasInteractionRuntime();
    const listener = vi.fn();

    runtime.updatePointer({
      screenPoint: { x: 50, y: 60 },
      target: { kind: 'node', projectRelativePath: 'flow/a.png', zone: 'manipulation', directManipulation: false, contentControl: false }
    });
    runtime.setCameraState('moving');
    runtime.setCameraState('idle');
    expect(runtime.takeReconcilePoint()).toEqual({ x: 50, y: 60 });

    runtime.subscribe(listener);
    runtime.reconcile({ kind: 'blocked' });

    expect(runtime.getSnapshot()).toMatchObject({
      hoveredNodePath: undefined,
      reconcilePending: false
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('completes an idle reconciliation when no pointer position is available', () => {
    const runtime = createCanvasInteractionRuntime();
    const listener = vi.fn();

    runtime.setCameraState('moving');
    runtime.setCameraState('idle');
    runtime.subscribe(listener);

    expect(runtime.takeReconcilePoint()).toBeUndefined();
    expect(runtime.getSnapshot()).toMatchObject({
      hoveredNodePath: undefined,
      gated: false,
      reconcilePending: false
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('retains hover while a move is pending and freezes it only after the interaction becomes active', () => {
    const runtime = createCanvasInteractionRuntime();
    const listener = vi.fn();
    runtime.subscribe(listener);
    runtime.updatePointer({
      screenPoint: { x: 10, y: 10 },
      target: { kind: 'node', projectRelativePath: 'flow/a.png', zone: 'manipulation', directManipulation: false, contentControl: false }
    });
    listener.mockClear();

    runtime.setPointerInteractionActive(false);
    expect(runtime.getSnapshot()).toMatchObject({
      hoveredNodePath: 'flow/a.png',
      gated: false
    });
    expect(listener).not.toHaveBeenCalled();

    runtime.setPointerInteractionActive(true);
    expect(runtime.getSnapshot()).toMatchObject({
      hoveredNodePath: undefined,
      gated: true,
      cameraMoving: false,
      pointerInteractionActive: true
    });

    runtime.setPointerInteractionActive(false);
    expect(runtime.takeReconcilePoint()).toEqual({ x: 10, y: 10 });
  });

  it('treats resize as immediately active and clears hover when the pointer leaves the Canvas', () => {
    const runtime = createCanvasInteractionRuntime();
    runtime.updatePointer({
      screenPoint: { x: 1, y: 2 },
      target: { kind: 'node', projectRelativePath: 'flow/a.png', zone: 'resize', directManipulation: false, contentControl: false }
    });
    runtime.setPointerInteractionActive(true);
    expect(runtime.getSnapshot()).toMatchObject({ hoveredNodePath: undefined, gated: true });

    runtime.setPointerInteractionActive(false);
    runtime.leaveSurface();
    expect(runtime.getSnapshot()).toMatchObject({
      hoveredNodePath: undefined
    });
    expect(runtime.takeReconcilePoint()).toBeUndefined();
  });
});
