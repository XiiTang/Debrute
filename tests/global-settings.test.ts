import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DebruteGlobalRuntimeServer,
  GlobalConfigStore,
  GlobalSettingsValidationError
} from '@debrute/app-server';
import type { SaveDebruteGlobalSettingsInput } from '@debrute/app-protocol';
import { IntegrationsService } from '../apps/app-server/src/integrations/IntegrationsService';

const invalidLocaleMessage = 'Workbench locale must be "en" or "zh-CN".';
const invalidThemeMessage = 'Workbench theme preference must be "system", "dark", or "light".';
const invalidDefaultFrontendMessage = 'Global settings defaultFrontend must be "electron", "browser", or "runtime-only".';

describe('runtime-owned global settings final contract', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
    vi.restoreAllMocks();
  });

  it('persists one runtime-owned global settings file', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-global-settings-home-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const store = new GlobalConfigStore({ debruteHome: home });

    await expect(store.readGlobalSettings()).resolves.toMatchObject({
      workbench: {
        locale: 'en',
        themePreference: 'system',
        defaultFrontend: 'electron'
      },
      chrome: { recentProjectRoots: [] },
      models: {
        image: { imageModels: [] },
        video: { videoModels: [] },
        audio: { audioModels: [] }
      },
      adobeBridge: { enabled: true }
    });

    await store.mutateGlobalSettings({
      kind: 'patch',
      input: { workbench: { locale: 'zh-CN', themePreference: 'dark', defaultFrontend: 'browser' } }
    });
    await store.mutateGlobalSettings({
      kind: 'rememberRecentProjectRoot',
      projectRoot: '/tmp/project-a'
    });

    await expect(store.readGlobalSettings()).resolves.toMatchObject({
      workbench: {
        locale: 'zh-CN',
        themePreference: 'dark',
        defaultFrontend: 'browser'
      },
      chrome: { recentProjectRoots: ['/tmp/project-a'] }
    });
    await expect(readFile(configPaths(home).globalSettingsFile, 'utf8')).resolves.toContain('"defaultFrontend": "browser"');
  });

  it('fails when the current settings file is a dangling symlink', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-global-settings-dangling-file-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const paths = configPaths(home);
    await mkdir(paths.root, { recursive: true });
    await symlink(join(home, 'missing-global-settings-target'), paths.globalSettingsFile);

    await expect(new GlobalConfigStore({ debruteHome: home }).readGlobalSettings()).rejects.toMatchObject({
      cause: { code: 'ENOENT' }
    });
  });

  it('fails when the current config directory is a dangling symlink', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-global-settings-dangling-directory-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    await symlink(join(home, 'missing-config-target'), configPaths(home).root);

    await expect(new GlobalConfigStore({ debruteHome: home }).readGlobalSettings()).rejects.toMatchObject({
      cause: { code: 'ENOENT' }
    });
  });

  it('rejects unsupported Workbench locales without adapting them', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-global-settings-invalid-locale-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const store = new GlobalConfigStore({ debruteHome: home });

    await expect(store.mutateGlobalSettings({
      kind: 'patch',
      input: { workbench: { locale: 'fr' as never } }
    })).rejects.toThrow(invalidLocaleMessage);

    const paths = configPaths(home);
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.globalSettingsFile, JSON.stringify({
      workbench: { locale: 'fr', themePreference: 'system', defaultFrontend: 'electron' },
      chrome: { recentProjectRoots: [] },
      models: {
        image: { imageModels: [] },
        video: { videoModels: [] },
        audio: { audioModels: [] }
      },
      adobeBridge: { enabled: true }
    }), 'utf8');
    await expect(store.readGlobalSettings()).rejects.toThrow(invalidLocaleMessage);
  });

  it('rejects unsupported Workbench theme preferences without adapting them', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-global-settings-invalid-theme-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const store = new GlobalConfigStore({ debruteHome: home });

    await expect(store.mutateGlobalSettings({
      kind: 'patch',
      input: { workbench: { themePreference: 'solarized' as never } }
    })).rejects.toThrow(invalidThemeMessage);

    const paths = configPaths(home);
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.globalSettingsFile, JSON.stringify({
      workbench: { locale: 'en', themePreference: 'solarized', defaultFrontend: 'electron' },
      chrome: { recentProjectRoots: [] },
      models: {
        image: { imageModels: [] },
        video: { videoModels: [] },
        audio: { audioModels: [] }
      },
      adobeBridge: { enabled: true }
    }), 'utf8');
    await expect(store.readGlobalSettings()).rejects.toThrow(invalidThemeMessage);
  });

  it('rejects unsupported default frontend values', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-global-settings-invalid-frontend-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const store = new GlobalConfigStore({ debruteHome: home });

    await expect(store.mutateGlobalSettings({
      kind: 'patch',
      input: { workbench: { defaultFrontend: 'native' as never } }
    })).rejects.toThrow(invalidDefaultFrontendMessage);

    const paths = configPaths(home);
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.globalSettingsFile, JSON.stringify({
      workbench: { locale: 'en', themePreference: 'system', defaultFrontend: 'native' },
      chrome: { recentProjectRoots: [] },
      models: {
        image: { imageModels: [] },
        video: { videoModels: [] },
        audio: { audioModels: [] }
      },
      adobeBridge: { enabled: true }
    }), 'utf8');
    await expect(store.readGlobalSettings()).rejects.toThrow(invalidDefaultFrontendMessage);
  });

  it('keeps plaintext API keys out of global settings reads', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-global-settings-secrets-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const store = new GlobalConfigStore({ debruteHome: home });

    await store.mutateGlobalSettings({
      kind: 'patch',
      input: {
        models: {
          image: {
            modelId: 'gpt-image-2',
            setting: {
              baseUrlOverride: null,
              requestModelIdOverride: null,
              apiKey: 'image-secret'
            }
          }
        }
      }
    });

    expect(JSON.stringify(await store.readGlobalSettings())).not.toContain('image-secret');
    expect(JSON.stringify((await store.readGlobalSnapshot()).secrets)).toContain('image-secret');
  });

  it('serves and emits global settings changes from the global runtime', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-global-settings-runtime-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const runtime = new DebruteGlobalRuntimeServer({
      globalConfigStore: new GlobalConfigStore({ debruteHome: home }),
      integrationEnvPath: ''
    });
    cleanups.push(() => runtime.close());
    const events: unknown[] = [];
    runtime.onEvent((event) => events.push(event));

    await expect(runtime.globalSettingsGet()).resolves.toMatchObject({
      workbench: {
        locale: 'en',
        themePreference: 'system',
        defaultFrontend: 'electron'
      }
    });
    await expect(runtime.globalSettingsSave({
      workbench: {
        locale: 'zh-CN',
        themePreference: 'dark',
        defaultFrontend: 'browser'
      }
    })).resolves.toMatchObject({
      workbench: {
        locale: 'zh-CN',
        themePreference: 'dark',
        defaultFrontend: 'browser'
      }
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'globalSettings.changed',
      settings: {
        workbench: {
          locale: 'zh-CN',
          themePreference: 'dark',
          defaultFrontend: 'browser'
        }
      }
    });
  });

  it('emits global settings changes when recent project roots change', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-global-settings-runtime-recent-events-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const runtime = new DebruteGlobalRuntimeServer({
      globalConfigStore: new GlobalConfigStore({ debruteHome: home }),
      integrationEnvPath: ''
    });
    cleanups.push(() => runtime.close());
    const events: unknown[] = [];
    runtime.onEvent((event) => events.push(event));

    await runtime.rememberRecentProjectRoot('/projects/alpha');
    await runtime.clearRecentProjectRoots();

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: 'globalSettings.changed',
      settings: {
        chrome: { recentProjectRoots: ['/projects/alpha'] }
      }
    });
    expect(events[1]).toMatchObject({
      type: 'globalSettings.changed',
      settings: {
        chrome: { recentProjectRoots: [] }
      }
    });
  });

  it('emits complete global settings when recent project roots change before any settings read', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-global-settings-runtime-recent-first-event-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const runtime = new DebruteGlobalRuntimeServer({
      globalConfigStore: new GlobalConfigStore({ debruteHome: home }),
      integrationEnvPath: ''
    });
    cleanups.push(() => runtime.close());
    const events: unknown[] = [];
    runtime.onEvent((event) => events.push(event));

    await runtime.rememberRecentProjectRoot('/projects/alpha');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'globalSettings.changed',
      settings: {
        chrome: { recentProjectRoots: ['/projects/alpha'] },
        integrations: {
          integrations: expect.arrayContaining([expect.objectContaining({ integrationId: 'ffmpeg' })]),
          backends: expect.any(Array)
        }
      }
    });
  });

  it('returns complete integrations when saving before any settings read', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-global-settings-runtime-first-save-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const runtime = new DebruteGlobalRuntimeServer({
      globalConfigStore: new GlobalConfigStore({ debruteHome: home }),
      integrationEnvPath: ''
    });
    cleanups.push(() => runtime.close());
    const events: unknown[] = [];
    runtime.onEvent((event) => events.push(event));

    const settings = await runtime.globalSettingsSave({
      workbench: { locale: 'zh-CN' }
    });

    expect(settings.integrations.integrations.length).toBeGreaterThan(0);
    expect(settings.integrations.backends.length).toBeGreaterThan(0);
    expect(events[0]).toMatchObject({
      type: 'globalSettings.changed',
      settings: {
        integrations: {
          integrations: expect.arrayContaining([expect.objectContaining({ integrationId: 'ffmpeg' })]),
          backends: expect.any(Array)
        }
      }
    });
  });

  it('rejects invalid model patches before writing any global settings fields', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-global-settings-runtime-atomic-save-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const store = new GlobalConfigStore({ debruteHome: home });
    const runtime = new DebruteGlobalRuntimeServer({
      globalConfigStore: store,
      integrationEnvPath: ''
    });
    cleanups.push(() => runtime.close());

    await expect(runtime.globalSettingsSave({
      workbench: { locale: 'zh-CN' },
      models: {
        image: {
          modelId: 'missing-image-model',
          setting: {
            baseUrlOverride: null,
            requestModelIdOverride: null
          }
        }
      }
    })).rejects.toThrow('Unknown image model: missing-image-model');

    await expect(store.readGlobalSettings()).resolves.toMatchObject({
      workbench: { locale: 'en' }
    });
  });

  it('serializes concurrent recent-project mutations without losing a root', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-global-settings-recent-race-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const store = new GlobalConfigStore({ debruteHome: home });

    await Promise.all([
      store.mutateGlobalSettings({ kind: 'rememberRecentProjectRoot', projectRoot: '/projects/alpha' }),
      store.mutateGlobalSettings({ kind: 'rememberRecentProjectRoot', projectRoot: '/projects/beta' })
    ]);

    const roots = (await store.readGlobalSettings()).chrome.recentProjectRoots;
    expect(roots).toHaveLength(2);
    expect(new Set(roots)).toEqual(new Set(['/projects/alpha', '/projects/beta']));
  });

  it('serializes a Workbench patch with a concurrent recent-project mutation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-global-settings-workbench-race-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const store = new GlobalConfigStore({ debruteHome: home });

    await Promise.all([
      store.mutateGlobalSettings({
        kind: 'patch',
        input: { workbench: { locale: 'zh-CN', themePreference: 'dark' } }
      }),
      store.mutateGlobalSettings({ kind: 'rememberRecentProjectRoot', projectRoot: '/projects/alpha' })
    ]);

    await expect(store.readGlobalSettings()).resolves.toMatchObject({
      workbench: { locale: 'zh-CN', themePreference: 'dark' },
      chrome: { recentProjectRoots: ['/projects/alpha'] }
    });
  });

  it('serializes concurrent API-key patches without losing either secret', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-global-settings-secret-race-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const store = new GlobalConfigStore({ debruteHome: home });

    await Promise.all([
      store.mutateGlobalSettings({
        kind: 'patch',
        input: {
          models: {
            image: {
              modelId: 'image-model',
              setting: { baseUrlOverride: null, requestModelIdOverride: null, apiKey: 'image-secret' }
            }
          }
        }
      }),
      store.mutateGlobalSettings({
        kind: 'patch',
        input: {
          models: {
            video: {
              modelId: 'video-model',
              setting: { baseUrlOverride: null, requestModelIdOverride: null, apiKey: 'video-secret' }
            }
          }
        }
      })
    ]);

    await expect(store.readGlobalSnapshot()).resolves.toMatchObject({
      secrets: {
        imageModelApiKeys: { 'image-model': 'image-secret' },
        videoModelApiKeys: { 'video-model': 'video-secret' }
      }
    });
  });

  it('returns changed false and does not replace a file for a same-value mutation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-global-settings-no-op-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const store = new GlobalConfigStore({ debruteHome: home });
    const paths = configPaths(home);

    await store.mutateGlobalSettings({
      kind: 'patch',
      input: { workbench: { locale: 'zh-CN' } }
    });
    const inodeBefore = (await stat(paths.globalSettingsFile)).ino;
    const result = await store.mutateGlobalSettings({
      kind: 'patch',
      input: { workbench: { locale: 'zh-CN' } }
    });

    expect(result.changed).toBe(false);
    expect((await stat(paths.globalSettingsFile)).ino).toBe(inodeBefore);
  });

  it('rejects a present null model section as current input validation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-global-settings-null-model-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const store = new GlobalConfigStore({ debruteHome: home });

    await expect(store.mutateGlobalSettings({
      kind: 'patch',
      input: { models: { image: null } } as unknown as SaveDebruteGlobalSettingsInput
    })).rejects.toBeInstanceOf(GlobalSettingsValidationError);
  });

  it('composes one global view from one Store snapshot and reuses mutation results', async () => {
    class CountingStore extends GlobalConfigStore {
      snapshotReads = 0;

      override async readGlobalSnapshot(): ReturnType<GlobalConfigStore['readGlobalSnapshot']> {
        this.snapshotReads += 1;
        return super.readGlobalSnapshot();
      }
    }

    const home = await mkdtemp(join(tmpdir(), 'debrute-global-settings-snapshot-count-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const store = new CountingStore({ debruteHome: home });
    const runtime = new DebruteGlobalRuntimeServer({ globalConfigStore: store, integrationEnvPath: '' });
    cleanups.push(() => runtime.close());

    await runtime.globalSettingsGet();
    expect(store.snapshotReads).toBe(1);

    store.snapshotReads = 0;
    await runtime.globalSettingsSave({ workbench: { locale: 'zh-CN' } });
    expect(store.snapshotReads).toBe(0);
  });

  it('does not emit a settings event for semantic no-ops', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-global-settings-runtime-no-op-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const runtime = new DebruteGlobalRuntimeServer({
      globalConfigStore: new GlobalConfigStore({ debruteHome: home }),
      integrationEnvPath: ''
    });
    cleanups.push(() => runtime.close());
    const events: unknown[] = [];
    runtime.onEvent((event) => events.push(event));

    await runtime.globalSettingsSave({ workbench: { locale: 'en' } });
    await runtime.rememberRecentProjectRoot('   ');
    await runtime.clearRecentProjectRoots();

    expect(events).toEqual([]);
  });

  it('retains concurrent recent roots through runtime mutation commands', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-global-settings-runtime-recent-race-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const runtime = new DebruteGlobalRuntimeServer({
      globalConfigStore: new GlobalConfigStore({ debruteHome: home }),
      integrationEnvPath: ''
    });
    cleanups.push(() => runtime.close());

    await Promise.all([
      runtime.rememberRecentProjectRoot('/projects/alpha'),
      runtime.rememberRecentProjectRoot('/projects/beta')
    ]);

    const roots = (await runtime.globalSettingsGet()).chrome.recentProjectRoots;
    expect(new Set(roots)).toEqual(new Set(['/projects/alpha', '/projects/beta']));
  });

  it('does not emit a stale final event when concurrent integration reads resolve out of order', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-global-settings-runtime-event-order-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const firstStatus = deferred<{ integrations: []; backends: [] }>();
    const secondStatus = deferred<{ integrations: []; backends: [] }>();
    const listStatus = vi.spyOn(IntegrationsService.prototype, 'listStatus')
      .mockImplementationOnce(() => firstStatus.promise)
      .mockImplementationOnce(() => secondStatus.promise);
    const runtime = new DebruteGlobalRuntimeServer({
      globalConfigStore: new GlobalConfigStore({ debruteHome: home }),
      integrationEnvPath: ''
    });
    cleanups.push(() => runtime.close());
    const events: unknown[] = [];
    runtime.onEvent((event) => events.push(event));

    const alpha = runtime.rememberRecentProjectRoot('/projects/alpha');
    await vi.waitFor(() => expect(listStatus).toHaveBeenCalledTimes(1));
    const beta = runtime.rememberRecentProjectRoot('/projects/beta');
    await vi.waitFor(() => expect(listStatus).toHaveBeenCalledTimes(2));

    secondStatus.resolve({ integrations: [], backends: [] });
    await beta;
    firstStatus.resolve({ integrations: [], backends: [] });
    await alpha;

    expect(events.at(-1)).toMatchObject({
      type: 'globalSettings.changed',
      settings: {
        chrome: {
          recentProjectRoots: expect.arrayContaining(['/projects/alpha', '/projects/beta'])
        }
      }
    });
  });

  it('keeps plaintext API keys out of public settings responses and events', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-global-settings-public-secret-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const store = new GlobalConfigStore({ debruteHome: home });
    const runtime = new DebruteGlobalRuntimeServer({ globalConfigStore: store, integrationEnvPath: '' });
    cleanups.push(() => runtime.close());
    const events: unknown[] = [];
    runtime.onEvent((event) => events.push(event));

    const settings = await runtime.globalSettingsSave({
      models: {
        image: {
          modelId: 'gpt-image-2',
          setting: {
            baseUrlOverride: null,
            requestModelIdOverride: null,
            apiKey: 'plaintext-secret'
          }
        }
      }
    });

    expect((await store.readGlobalSnapshot()).secrets.imageModelApiKeys['gpt-image-2'])
      .toBe('plaintext-secret');
    expect(JSON.stringify(settings)).not.toContain('plaintext-secret');
    expect(JSON.stringify(events)).not.toContain('plaintext-secret');
  });
});

function configPaths(home: string): {
  root: string;
  globalSettingsFile: string;
  secretsFile: string;
} {
  const root = join(home, 'config');
  return {
    root,
    globalSettingsFile: join(root, 'global_settings.json'),
    secretsFile: join(root, 'secrets.json')
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
