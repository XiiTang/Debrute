import { describe, expect, it, vi } from 'vitest';
import { createCanvasStateChangeIntake } from './CanvasStateChangeIntake';

describe('CanvasStateChangeIntake', () => {
  it('drains accepted changes in order when the Canvas Runtime mounts', () => {
    const intake = createCanvasStateChangeIntake();
    const acceptCanvasStateChange = vi.fn();
    const first = {
      nodeStates: [{ projectRelativePath: 'a.png', state: { videoPlayback: { currentTimeMs: 1 } } }]
    };
    const second = {
      nodeStates: [{ projectRelativePath: 'b.png', state: { videoPlayback: { currentTimeMs: 2 } } }]
    };

    intake.accept(first);
    intake.accept(second);
    expect(acceptCanvasStateChange).not.toHaveBeenCalled();

    intake.setRuntime({ acceptCanvasStateChange });

    expect(acceptCanvasStateChange.mock.calls).toEqual([[first], [second]]);
  });

  it('routes later changes directly to the mounted Runtime', () => {
    const intake = createCanvasStateChangeIntake();
    const acceptCanvasStateChange = vi.fn();
    intake.setRuntime({ acceptCanvasStateChange });
    const change = { nodeStates: [], occlusionOrder: ['a.png'] };

    intake.accept(change);

    expect(acceptCanvasStateChange).toHaveBeenCalledWith(change);
  });
});
