import { describe, expect, it, vi } from 'vitest';
import { createWorkbenchStartupTimeline } from './workbenchStartupTimeline.js';

describe('Workbench startup timeline', () => {
  it('publishes each first milestone relative to one origin', () => {
    const publish = vi.fn();
    const mark = vi.fn();
    const values = [112, 140];
    const timeline = createWorkbenchStartupTimeline({
      enabled: true,
      originMs: 100,
      now: () => values.shift() ?? 140,
      mark,
      publish
    });

    timeline.mark('main-evaluated');
    timeline.mark('global-snapshot-ready');
    timeline.mark('global-snapshot-ready');

    expect(publish.mock.calls).toEqual([
      [{ milestone: 'main-evaluated', elapsedMs: 12 }],
      [{ milestone: 'global-snapshot-ready', elapsedMs: 40 }]
    ]);
    expect(mark).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('does no work when the diagnostic is disabled', () => {
    const publish = vi.fn();
    const mark = vi.fn();
    const now = vi.fn(() => 1);
    const timeline = createWorkbenchStartupTimeline({
      enabled: false,
      now,
      mark,
      publish
    });

    timeline.markFeatureRequested('settings');
    timeline.markFeatureReady('settings');

    expect(mark).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });
});
