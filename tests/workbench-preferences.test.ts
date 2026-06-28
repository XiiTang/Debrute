import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DebruteGlobalRuntimeServer, GlobalConfigStore } from '@debrute/app-server';

const invalidLocaleMessage = 'Workbench locale must be "en" or "zh-CN".';
const invalidThemeMessage = 'Workbench theme preference must be "system", "dark", or "light".';

describe('Workbench preferences', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it('persists global Workbench preferences under the config directory', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-workbench-preferences-home-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const store = new GlobalConfigStore({ debruteHome: home });

    expect(store.paths().workbenchPreferencesFile).toBe(join(home, 'config', 'workbench_preferences.json'));
    await expect(store.readWorkbenchPreferences()).resolves.toEqual({
      locale: 'en',
      themePreference: 'system'
    });

    await store.saveWorkbenchPreferences({ locale: 'zh-CN', themePreference: 'light' });

    await expect(store.readWorkbenchPreferences()).resolves.toEqual({
      locale: 'zh-CN',
      themePreference: 'light'
    });
    await expect(readFile(join(home, 'config', 'workbench_preferences.json'), 'utf8')).resolves.toBe('{\n  "locale": "zh-CN",\n  "themePreference": "light"\n}\n');
  });

  it('rejects unsupported Workbench locales without adapting them', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-workbench-invalid-locale-home-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const store = new GlobalConfigStore({ debruteHome: home });

    await expect(store.saveWorkbenchPreferences({ locale: 'fr' as never, themePreference: 'system' })).rejects.toThrow(invalidLocaleMessage);

    await mkdir(store.paths().root, { recursive: true });
    await writeFile(store.paths().workbenchPreferencesFile, JSON.stringify({ locale: 'fr', themePreference: 'system' }), 'utf8');
    await expect(store.readWorkbenchPreferences()).rejects.toThrow(invalidLocaleMessage);
  });

  it('rejects unsupported Workbench theme preferences without adapting them', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-workbench-invalid-theme-home-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const store = new GlobalConfigStore({ debruteHome: home });

    await expect(store.saveWorkbenchPreferences({
      locale: 'en',
      themePreference: 'solarized' as never
    })).rejects.toThrow(invalidThemeMessage);

    await mkdir(store.paths().root, { recursive: true });
    await writeFile(store.paths().workbenchPreferencesFile, JSON.stringify({
      locale: 'en',
      themePreference: 'solarized'
    }), 'utf8');
    await expect(store.readWorkbenchPreferences()).rejects.toThrow(invalidThemeMessage);
  });

  it('serves and emits Workbench preference changes from the global runtime', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-workbench-runtime-preferences-home-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const runtime = new DebruteGlobalRuntimeServer({
      globalConfigStore: new GlobalConfigStore({ debruteHome: home })
    });
    cleanups.push(() => runtime.close());
    const events: unknown[] = [];
    runtime.onEvent((event) => events.push(event));

    await expect(runtime.workbenchPreferencesGet()).resolves.toEqual({
      locale: 'en',
      themePreference: 'system'
    });
    await expect(runtime.workbenchPreferencesSave({
      locale: 'zh-CN',
      themePreference: 'dark'
    })).resolves.toEqual({
      locale: 'zh-CN',
      themePreference: 'dark'
    });

    expect(events).toEqual([
      {
        type: 'workbench.preferences.changed',
        preferences: { locale: 'zh-CN', themePreference: 'dark' }
      }
    ]);
  });
});
