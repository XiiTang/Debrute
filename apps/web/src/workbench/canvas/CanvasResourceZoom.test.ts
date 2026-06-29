import { describe, expect, it } from 'vitest';
import {
  initialCanvasResourceZoomState,
  nextCanvasResourceZoomState
} from './CanvasResourceZoom';

describe('CanvasResourceZoom', () => {
  it('starts idle at current camera zoom', () => {
    expect(initialCanvasResourceZoomState(1.25)).toEqual({
      cameraState: 'idle',
      resourceZoom: 1.25
    });
  });

  it('tracks live zoom while idle', () => {
    const state = nextCanvasResourceZoomState(initialCanvasResourceZoomState(1), {
      cameraState: 'idle',
      cameraZoom: 2
    });

    expect(state).toEqual({
      cameraState: 'idle',
      resourceZoom: 2
    });
  });

  it('freezes at the zoom before movement starts', () => {
    const state = nextCanvasResourceZoomState(initialCanvasResourceZoomState(1), {
      cameraState: 'moving',
      cameraZoom: 2
    });

    expect(state).toEqual({
      cameraState: 'moving',
      resourceZoom: 1
    });
  });

  it('keeps same resource zoom for whole movement', () => {
    const moving = nextCanvasResourceZoomState(initialCanvasResourceZoomState(1), {
      cameraState: 'moving',
      cameraZoom: 2
    });
    const continuedMoving = nextCanvasResourceZoomState(moving, {
      cameraState: 'moving',
      cameraZoom: 3
    });

    expect(continuedMoving).toBe(moving);
    expect(continuedMoving).toEqual({
      cameraState: 'moving',
      resourceZoom: 1
    });
  });

  it('catches up immediately when movement becomes idle', () => {
    const moving = nextCanvasResourceZoomState(initialCanvasResourceZoomState(1), {
      cameraState: 'moving',
      cameraZoom: 2
    });
    const idle = nextCanvasResourceZoomState(moving, {
      cameraState: 'idle',
      cameraZoom: 3
    });

    expect(idle).toEqual({
      cameraState: 'idle',
      resourceZoom: 3
    });
  });

  it('captures last idle resource zoom for next movement', () => {
    const idle = nextCanvasResourceZoomState(initialCanvasResourceZoomState(1), {
      cameraState: 'idle',
      cameraZoom: 2
    });
    const moving = nextCanvasResourceZoomState(idle, {
      cameraState: 'moving',
      cameraZoom: 3
    });

    expect(moving).toEqual({
      cameraState: 'moving',
      resourceZoom: 2
    });
  });
});
