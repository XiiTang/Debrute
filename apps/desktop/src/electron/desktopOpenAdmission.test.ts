import { describe, expect, it, vi } from 'vitest';

import { createDesktopOpenAdmission } from './desktopOpenAdmission.js';

describe('Desktop open admission', () => {
  it('opens one root window when startup has no explicit intent', async () => {
    const activate = vi.fn(async () => undefined);
    const admission = createDesktopOpenAdmission(activate);

    await admission.start(undefined);

    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith({ kind: 'new-window' });
  });

  it('uses the first native startup intent instead of opening a default root window', async () => {
    const activate = vi.fn(async () => undefined);
    const admission = createDesktopOpenAdmission(activate);
    await admission.dispatch({ kind: 'open-project-path', projectRoot: '/projects/alpha' });

    await admission.start(undefined);

    expect(activate.mock.calls).toEqual([[
      { kind: 'open-project-path', projectRoot: '/projects/alpha' }
    ]]);
  });

  it('preserves the native source window while an open waits for startup admission', async () => {
    const activate = vi.fn(async () => undefined);
    const admission = createDesktopOpenAdmission(activate);
    const sourceWindow = {};
    await admission.dispatch(
      { kind: 'open-project-path', projectRoot: '/projects/alpha' },
      sourceWindow
    );

    await admission.start(undefined);

    expect(activate).toHaveBeenCalledWith(
      { kind: 'open-project-path', projectRoot: '/projects/alpha' },
      sourceWindow
    );
  });

  it('runs an explicit process intent before queued native startup intents', async () => {
    const activate = vi.fn(async () => undefined);
    const admission = createDesktopOpenAdmission(activate);
    await admission.dispatch({ kind: 'open-project-path', projectRoot: '/projects/native' });

    await admission.start({ kind: 'open-project-id', projectId: 'explicit' });

    expect(activate.mock.calls).toEqual([
      [{ kind: 'open-project-id', projectId: 'explicit' }],
      [{ kind: 'open-project-path', projectRoot: '/projects/native' }]
    ]);
  });

  it('drains intents arriving while startup activation is in flight', async () => {
    let releaseFirst!: () => void;
    const firstActivation = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const activate = vi.fn()
      .mockImplementationOnce(() => firstActivation)
      .mockResolvedValue(undefined);
    const admission = createDesktopOpenAdmission(activate);

    const startup = admission.start({ kind: 'open-project-id', projectId: 'first' });
    await Promise.resolve();
    await admission.dispatch({ kind: 'open-project-id', projectId: 'second' });
    releaseFirst();
    await startup;

    expect(activate.mock.calls).toEqual([
      [{ kind: 'open-project-id', projectId: 'first' }],
      [{ kind: 'open-project-id', projectId: 'second' }]
    ]);
  });

  it('dispatches directly after startup admission completes', async () => {
    const activate = vi.fn(async () => undefined);
    const admission = createDesktopOpenAdmission(activate);
    await admission.start(undefined);

    await admission.dispatch({ kind: 'open-project-id', projectId: 'later' });

    expect(activate.mock.calls.at(-1)).toEqual([
      { kind: 'open-project-id', projectId: 'later' }
    ]);
  });
});
