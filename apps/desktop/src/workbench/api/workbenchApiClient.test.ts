import { afterEach, describe, expect, it } from 'vitest';
import { createWorkbenchApiClient } from './workbenchApiClient';

describe('workbench API client', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
  });

  it('requires the Electron preload API', () => {
    (globalThis as { window?: unknown }).window = {};

    expect(() => createWorkbenchApiClient()).toThrow(/desktop preload/i);
  });

  it('wraps the preload API with desktop mode', () => {
    const preloadApi = {
      getDesktopState: async () => ({ recentProjectRoots: [] })
    } as unknown;
    (globalThis as { window?: unknown }).window = { axisDesktop: preloadApi };

    expect(createWorkbenchApiClient()).toMatchObject({
      mode: 'desktop',
      getDesktopState: (preloadApi as { getDesktopState: unknown }).getDesktopState
    });
  });
});
