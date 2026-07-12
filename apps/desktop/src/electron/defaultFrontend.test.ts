import { describe, expect, it, vi } from 'vitest';
import type { DebruteGlobalSettingsView } from '@debrute/app-protocol';

describe('desktop default frontend execution', () => {
  it('records browser launch failures without opening an Electron fallback', async () => {
    const { executeDefaultFrontend } = await loadDefaultFrontendModule();
    const openElectron = vi.fn(async () => undefined);
    const openBrowser = vi.fn(async () => {
      throw new Error('Browser launch failed.');
    });
    const failures: Array<{ source: string; message: string }> = [];

    await expect(executeDefaultFrontend({
      runtimeClient: {
        globalSettingsGet: async () => globalSettingsFixture('browser')
      },
      openElectron,
      openBrowser,
      source: 'tray-open-debrute',
      recordFailure: (failure) => failures.push(failure)
    })).resolves.toBeUndefined();

    expect(openBrowser).toHaveBeenCalledTimes(1);
    expect(openElectron).not.toHaveBeenCalled();
    expect(failures).toEqual([{
      source: 'tray-open-debrute',
      message: 'Browser launch failed.'
    }]);
  });

  it('records settings read failures without opening any frontend', async () => {
    const { executeDefaultFrontend } = await loadDefaultFrontendModule();
    const openElectron = vi.fn(async () => undefined);
    const openBrowser = vi.fn(async () => undefined);
    const failures: Array<{ source: string; message: string }> = [];

    await expect(executeDefaultFrontend({
      runtimeClient: {
        globalSettingsGet: async () => {
          throw new Error('Global settings unavailable.');
        }
      },
      openElectron,
      openBrowser,
      source: 'startup',
      recordFailure: (failure) => failures.push(failure)
    })).resolves.toBeUndefined();

    expect(openElectron).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
    expect(failures).toEqual([{
      source: 'startup',
      message: 'Global settings unavailable.'
    }]);
  });
});

async function loadDefaultFrontendModule(): Promise<{
  executeDefaultFrontend(input: {
    runtimeClient: { globalSettingsGet(): Promise<DebruteGlobalSettingsView> };
    openElectron(): Promise<void>;
    openBrowser(): Promise<void>;
    source: string;
    recordFailure(failure: { source: string; message: string }): void;
  }): Promise<void>;
}> {
  const modulePath = './defaultFrontend.js';
  const loaded = await import(modulePath).catch(() => undefined);
  expect(loaded).toBeDefined();
  return loaded as Awaited<ReturnType<typeof loadDefaultFrontendModule>>;
}

function globalSettingsFixture(defaultFrontend: DebruteGlobalSettingsView['workbench']['defaultFrontend']): DebruteGlobalSettingsView {
  return {
    workbench: {
      locale: 'en',
      themePreference: 'system',
      defaultFrontend
    },
    chrome: { recentProjectRoots: [] },
    models: {
      image: { models: [] },
      video: { models: [] },
      audio: { models: [] }
    },
    integrations: { integrations: [], backends: [] },
    adobeBridge: { enabled: true }
  };
}
