import { describe, expect, it } from 'vitest';
import {
  initialCanvasResourceZoom,
  nextCanvasResourceZoom
} from './CanvasResourceZoom.js';

describe('CanvasResourceZoom', () => {
  it('starts at current camera zoom', () => {
    expect(initialCanvasResourceZoom(1.25)).toBe(1.25);
  });

  it('tracks live zoom while idle', () => {
    const resourceZoom = nextCanvasResourceZoom(initialCanvasResourceZoom(1), {
      cameraState: 'idle',
      cameraZoom: 2
    });

    expect(resourceZoom).toBe(2);
  });

  it('keeps the same resource zoom when movement starts', () => {
    const initial = initialCanvasResourceZoom(1);
    const resourceZoom = nextCanvasResourceZoom(initial, {
      cameraState: 'moving',
      cameraZoom: 2
    });

    expect(resourceZoom).toBe(initial);
  });

  it('keeps same resource zoom for whole movement', () => {
    const moving = nextCanvasResourceZoom(initialCanvasResourceZoom(1), {
      cameraState: 'moving',
      cameraZoom: 2
    });
    const continuedMoving = nextCanvasResourceZoom(moving, {
      cameraState: 'moving',
      cameraZoom: 3
    });

    expect(continuedMoving).toBe(moving);
    expect(continuedMoving).toBe(1);
  });

  it('keeps the same resource zoom when a pure pan becomes idle', () => {
    const initial = initialCanvasResourceZoom(1);
    const moving = nextCanvasResourceZoom(initial, {
      cameraState: 'moving',
      cameraZoom: 1
    });
    const idle = nextCanvasResourceZoom(moving, {
      cameraState: 'idle',
      cameraZoom: 1
    });

    expect(moving).toBe(initial);
    expect(idle).toBe(initial);
  });

  it('catches up immediately when movement becomes idle', () => {
    const moving = nextCanvasResourceZoom(initialCanvasResourceZoom(1), {
      cameraState: 'moving',
      cameraZoom: 2
    });
    const idle = nextCanvasResourceZoom(moving, {
      cameraState: 'idle',
      cameraZoom: 3
    });

    expect(idle).toBe(3);
  });

  it('captures last idle resource zoom for next movement', () => {
    const idle = nextCanvasResourceZoom(initialCanvasResourceZoom(1), {
      cameraState: 'idle',
      cameraZoom: 2
    });
    const moving = nextCanvasResourceZoom(idle, {
      cameraState: 'moving',
      cameraZoom: 3
    });

    expect(moving).toBe(2);
  });
});
