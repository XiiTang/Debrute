import { describe, expect, it, vi } from 'vitest';
import {
  WORKBENCH_DARK_BACKGROUND,
  WORKBENCH_LIGHT_BACKGROUND,
  workbenchStartupBackgroundColor,
  workbenchStartupBackgroundColorForRuntime
} from './workbenchAppearance.js';

describe('Workbench startup background', () => {
  it('uses explicit Workbench theme preferences', () => {
    expect(workbenchStartupBackgroundColor({
      workbench: { locale: 'en', themePreference: 'dark', defaultFrontend: 'electron' },
      nativeTheme: { shouldUseDarkColors: false }
    })).toBe(WORKBENCH_DARK_BACKGROUND);

    expect(workbenchStartupBackgroundColor({
      workbench: { locale: 'en', themePreference: 'light', defaultFrontend: 'electron' },
      nativeTheme: { shouldUseDarkColors: true }
    })).toBe(WORKBENCH_LIGHT_BACKGROUND);
  });

  it('resolves the system preference from the native theme', () => {
    const workbench = { locale: 'en', themePreference: 'system', defaultFrontend: 'electron' } as const;

    expect(workbenchStartupBackgroundColor({
      workbench,
      nativeTheme: { shouldUseDarkColors: true }
    })).toBe(WORKBENCH_DARK_BACKGROUND);
    expect(workbenchStartupBackgroundColor({
      workbench,
      nativeTheme: { shouldUseDarkColors: false }
    })).toBe(WORKBENCH_LIGHT_BACKGROUND);
  });

  it('reads the persisted Workbench preference from the runtime', async () => {
    const globalSettingsGet = vi.fn(async () => ({
      workbench: { locale: 'en' as const, themePreference: 'light' as const, defaultFrontend: 'electron' as const },
      chrome: { recentProjectRoots: [] },
      models: {
        image: { models: [] },
        video: { models: [] },
        audio: { models: [] }
      },
      integrations: { integrations: [], backends: [] },
      adobeBridge: { enabled: true }
    }));

    await expect(workbenchStartupBackgroundColorForRuntime(
      { globalSettingsGet },
      { shouldUseDarkColors: true }
    )).resolves.toBe(WORKBENCH_LIGHT_BACKGROUND);
    expect(globalSettingsGet).toHaveBeenCalledOnce();
  });
});
