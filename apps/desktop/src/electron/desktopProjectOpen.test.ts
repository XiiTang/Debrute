import { describe, expect, it, vi } from 'vitest';

import { dispatchDesktopProjectOpen } from './desktopProjectOpen.js';

describe('Desktop Project open targeting', () => {
  it('delivers a sourced request only to its live source window', async () => {
    const source = {};
    const send = vi.fn();
    const openWindow = vi.fn();

    await dispatchDesktopProjectOpen({
      projectRoot: '/projects/alpha',
      preferredWindow: source,
      isLiveWindow: (window) => window === source,
      singleLiveWindow: () => ({}),
      openWindow,
      send
    });

    expect(send).toHaveBeenCalledWith(source, '/projects/alpha');
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('discards a sourced request when its source window was destroyed', async () => {
    const send = vi.fn();
    const openWindow = vi.fn();

    await dispatchDesktopProjectOpen({
      projectRoot: '/projects/missing',
      preferredWindow: {},
      isLiveWindow: () => false,
      singleLiveWindow: () => ({}),
      openWindow,
      send
    });

    expect(send).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('uses the one live window for a request without a source', async () => {
    const target = {};
    const send = vi.fn();

    await dispatchDesktopProjectOpen({
      projectRoot: '/projects/alpha',
      isLiveWindow: () => false,
      singleLiveWindow: () => target,
      openWindow: vi.fn(),
      send
    });

    expect(send).toHaveBeenCalledWith(target, '/projects/alpha');
  });

  it('creates one ordinary window carrying the initial Project when no target is unique', async () => {
    const openWindow = vi.fn(async () => undefined);
    const send = vi.fn();

    await dispatchDesktopProjectOpen({
      projectRoot: '/projects/cold-start',
      isLiveWindow: () => false,
      singleLiveWindow: () => undefined,
      openWindow,
      send
    });

    expect(openWindow).toHaveBeenCalledWith('/projects/cold-start');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not create another window after the selected target rejects its request', async () => {
    const target = {};
    const openWindow = vi.fn();

    await expect(dispatchDesktopProjectOpen({
      projectRoot: '/projects/damaged',
      isLiveWindow: () => true,
      singleLiveWindow: () => target,
      openWindow,
      send: () => { throw new Error('target rejected'); }
    })).rejects.toThrow('target rejected');

    expect(openWindow).not.toHaveBeenCalled();
  });
});
