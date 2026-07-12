import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DebruteGlobalRuntimeServer, GlobalConfigStore, GlobalSettingsValidationError } from '@debrute/app-server';
import {
  type SaveDebruteGlobalSettingsInput,
  type AudioModelSettingsView,
  type ImageModelSettingsView,
  type SaveAudioModelSettingInput,
  type SaveImageModelSettingInput,
  type SaveVideoModelSettingInput,
  type VideoModelSettingsView
} from '@debrute/app-protocol';
import { IntegrationsService } from '../../../apps/app-server/src/integrations/IntegrationsService';

describe('app-server global settings', { tags: ['settings'] }, () => {
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
      await symlink(join(home, 'missing-global-settings-target'), paths.globalSettingsFile, directoryLinkType());
      await expect(new GlobalConfigStore({ debruteHome: home }).readGlobalSettings()).rejects.toMatchObject({
        cause: { code: 'ENOENT' }
      });
    });

    it('fails when the current config directory is a dangling symlink', async () => {
      const home = await mkdtemp(join(tmpdir(), 'debrute-global-settings-dangling-directory-'));
      cleanups.push(() => rm(home, { recursive: true, force: true }));
      await symlink(join(home, 'missing-config-target'), configPaths(home).root, directoryLinkType());
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

    it('emits narrow recent project events without integration scans', async () => {
      const home = await mkdtemp(join(tmpdir(), 'debrute-global-settings-runtime-recent-events-'));
      cleanups.push(() => rm(home, { recursive: true, force: true }));
      const store = new GlobalConfigStore({ debruteHome: home });
      const listStatus = vi.spyOn(IntegrationsService.prototype, 'listStatus')
        .mockRejectedValue(new Error('integration scan must not run'));
      const runtime = new DebruteGlobalRuntimeServer({
        globalConfigStore: store
      });
      cleanups.push(() => runtime.close());
      const events: unknown[] = [];
      runtime.onEvent((event) => events.push(event));
      await runtime.rememberRecentProjectRoot('/projects/alpha');
      expect(listStatus).not.toHaveBeenCalled();
      expect(events).toEqual([{
        type: 'recentProjects.changed',
        recentProjectRoots: ['/projects/alpha']
      }]);
      await runtime.rememberRecentProjectRoot('/projects/alpha');
      expect(events).toHaveLength(1);
      await expect(runtime.workbenchTitleBarState({ host: 'web', platform: 'linux' }))
        .resolves.toMatchObject({ recentProjectRoots: ['/projects/alpha'] });
      await expect(store.readGlobalSettings()).resolves.toMatchObject({
        chrome: { recentProjectRoots: ['/projects/alpha'] }
      });
      await runtime.clearRecentProjectRoots();
      expect(listStatus).not.toHaveBeenCalled();
      expect(events).toEqual([{
        type: 'recentProjects.changed',
        recentProjectRoots: ['/projects/alpha']
      }, {
        type: 'recentProjects.changed',
        recentProjectRoots: []
      }]);
      await runtime.clearRecentProjectRoots();
      expect(events).toHaveLength(2);
      await expect(runtime.workbenchTitleBarState({ host: 'web', platform: 'linux' }))
        .resolves.toMatchObject({ recentProjectRoots: [] });
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
      const roots = (await runtime.workbenchTitleBarState({ host: 'web', platform: 'linux' })).recentProjectRoots;
      expect(new Set(roots)).toEqual(new Set(['/projects/alpha', '/projects/beta']));
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

  it('preserves, replaces, and clears media model API keys through settings saves', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-settings-secret-semantics-home-'));
    const configStore = new GlobalConfigStore({ debruteHome: home });
    const globalRuntime = new DebruteGlobalRuntimeServer({ globalConfigStore: configStore, integrationEnvPath: '' });
    try {
      await saveGlobalImageModelSetting(globalRuntime, 'gpt-image-2', {
        baseUrlOverride: null,
        requestModelIdOverride: 'gpt-image-2',
        apiKey: 'sk-image-initial'
      });
      await saveGlobalImageModelSetting(globalRuntime, 'gpt-image-2', {
        baseUrlOverride: null,
        requestModelIdOverride: null
      });
      await saveGlobalVideoModelSetting(globalRuntime, 'doubao-seedance-2-0-260128', {
        baseUrlOverride: null,
        requestModelIdOverride: null,
        apiKey: 'sk-video-initial'
      });
      await saveGlobalVideoModelSetting(globalRuntime, 'doubao-seedance-2-0-260128', {
        baseUrlOverride: null,
        requestModelIdOverride: 'doubao-seedance-2-0-260128'
      });
      let secrets = (await configStore.readGlobalSnapshot()).secrets;
      expect(secrets.imageModelApiKeys['gpt-image-2']).toBe('sk-image-initial');
      expect(secrets.videoModelApiKeys['doubao-seedance-2-0-260128']).toBe('sk-video-initial');
      await saveGlobalImageModelSetting(globalRuntime, 'gpt-image-2', {
        baseUrlOverride: null,
        requestModelIdOverride: null,
        apiKey: 'sk-image-replaced'
      });
      await saveGlobalVideoModelSetting(globalRuntime, 'doubao-seedance-2-0-260128', {
        baseUrlOverride: null,
        requestModelIdOverride: null,
        apiKey: 'sk-video-replaced'
      });
      secrets = (await configStore.readGlobalSnapshot()).secrets;
      expect(secrets.imageModelApiKeys['gpt-image-2']).toBe('sk-image-replaced');
      expect(secrets.videoModelApiKeys['doubao-seedance-2-0-260128']).toBe('sk-video-replaced');
      const imageView = await saveGlobalImageModelSetting(globalRuntime, 'gpt-image-2', {
        baseUrlOverride: null,
        requestModelIdOverride: null,
        apiKey: ''
      });
      const videoView = await saveGlobalVideoModelSetting(globalRuntime, 'doubao-seedance-2-0-260128', {
        baseUrlOverride: null,
        requestModelIdOverride: null,
        apiKey: ''
      });
      const audioView = await saveGlobalAudioModelSetting(globalRuntime, 'openai-gpt-4o-mini-tts', {
        baseUrlOverride: null,
        requestModelIdOverride: null,
        apiKey: '   '
      });
      secrets = (await configStore.readGlobalSnapshot()).secrets;
      expect(secrets.imageModelApiKeys).not.toHaveProperty('gpt-image-2');
      expect(secrets.videoModelApiKeys).not.toHaveProperty('doubao-seedance-2-0-260128');
      expect(secrets.audioModelApiKeys).not.toHaveProperty('openai-gpt-4o-mini-tts');
      expect(imageView.models.find((model) => model.debruteModelId === 'gpt-image-2')).toMatchObject({
        apiKeySet: false,
        apiKeyPreview: null
      });
      expect(videoView.models.find((model) => model.debruteModelId === 'doubao-seedance-2-0-260128')).toMatchObject({
        apiKeySet: false,
        apiKeyPreview: null
      });
      expect(audioView.models.find((model) => model.debruteModelId === 'openai-gpt-4o-mini-tts')).toMatchObject({
        apiKeySet: false,
        apiKeyPreview: null
      });
      expect(JSON.stringify({ imageView, videoView, audioView })).not.toContain('sk-');
    } finally {
      globalRuntime.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('saves media model request-model overrides and derives configured state from API keys', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-media-model-settings-home-'));
    const globalRuntime = new DebruteGlobalRuntimeServer({
      globalConfigStore: new GlobalConfigStore({ debruteHome: home }),
      integrationEnvPath: ''
    });
    try {
      const imageSettings = await saveGlobalImageModelSetting(globalRuntime, 'gpt-image-2', {
        baseUrlOverride: 'https://images.example.test/v1',
        requestModelIdOverride: 'custom-image-model',
        apiKey: 'sk-image'
      });
      const videoSettings = await saveGlobalVideoModelSetting(globalRuntime, 'doubao-seedance-2-0-260128', {
        baseUrlOverride: 'https://videos.example.test/v1',
        requestModelIdOverride: 'custom-video-model',
        apiKey: 'sk-video'
      });
      const imageModel = imageSettings.models.find((model) => model.debruteModelId === 'gpt-image-2');
      const videoModel = videoSettings.models.find((model) => model.debruteModelId === 'doubao-seedance-2-0-260128');
      expect(imageModel).toEqual({
        debruteModelId: 'gpt-image-2',
        summary: expect.any(String),
        supportsEditing: expect.any(Boolean),
        supportsTextRendering: expect.any(Boolean),
        defaultBaseUrl: 'https://api.openai.com/v1',
        defaultRequestModelId: 'gpt-image-2',
        baseUrlOverride: 'https://images.example.test/v1',
        requestModelIdOverride: 'custom-image-model',
        apiKeySet: true,
        apiKeyPreview: 'sk****************************ge'
      });
      expect(videoModel).toEqual({
        debruteModelId: 'doubao-seedance-2-0-260128',
        summary: expect.any(String),
        supportsTextToVideo: expect.any(Boolean),
        supportsImageReferences: expect.any(Boolean),
        supportsVideoReferences: expect.any(Boolean),
        supportsAudioReferences: expect.any(Boolean),
        supportsGeneratedAudio: expect.any(Boolean),
        defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        defaultRequestModelId: 'doubao-seedance-2-0-260128',
        baseUrlOverride: 'https://videos.example.test/v1',
        requestModelIdOverride: 'custom-video-model',
        apiKeySet: true,
        apiKeyPreview: 'sk****************************eo'
      });
      expect(imageModel as Record<string, unknown>).not.toHaveProperty('apiKey');
      expect(videoModel as Record<string, unknown>).not.toHaveProperty('apiKey');
    } finally {
      globalRuntime.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('stores API-key-only media settings only in secrets', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-media-model-api-key-only-home-'));
    const configStore = new GlobalConfigStore({ debruteHome: home });
    const globalRuntime = new DebruteGlobalRuntimeServer({ globalConfigStore: configStore, integrationEnvPath: '' });
    try {
      const settings = await saveGlobalImageModelSetting(globalRuntime, 'gpt-image-2', {
        baseUrlOverride: null,
        requestModelIdOverride: null,
        apiKey: 'sk-image'
      });
      const imageModel = settings.models.find((model) => model.debruteModelId === 'gpt-image-2');
      expect(imageModel).toEqual({
        debruteModelId: 'gpt-image-2',
        summary: expect.any(String),
        supportsEditing: expect.any(Boolean),
        supportsTextRendering: expect.any(Boolean),
        defaultBaseUrl: 'https://api.openai.com/v1',
        defaultRequestModelId: 'gpt-image-2',
        baseUrlOverride: null,
        requestModelIdOverride: null,
        apiKeySet: true,
        apiKeyPreview: 'sk****************************ge'
      });
      expect(imageModel as Record<string, unknown>).not.toHaveProperty('apiKey');
      await expect(configStore.readGlobalSnapshot()).resolves.toMatchObject({
        settings: { models: { image: { imageModels: [] } } },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } }
      });
    } finally {
      globalRuntime.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('clears media model URL overrides without clearing configured API keys', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-media-model-clear-url-home-'));
    const configStore = new GlobalConfigStore({ debruteHome: home });
    const globalRuntime = new DebruteGlobalRuntimeServer({ globalConfigStore: configStore, integrationEnvPath: '' });
    try {
      await saveGlobalImageModelSetting(globalRuntime, 'gpt-image-2', {
        baseUrlOverride: 'https://images.example.test/v1',
        requestModelIdOverride: null,
        apiKey: 'sk-image'
      });
      const settings = await saveGlobalImageModelSetting(globalRuntime, 'gpt-image-2', {
        baseUrlOverride: null,
        requestModelIdOverride: null
      });
      const imageModel = settings.models.find((model) => model.debruteModelId === 'gpt-image-2');
      expect(imageModel).toMatchObject({
        baseUrlOverride: null,
        requestModelIdOverride: null,
        apiKeySet: true,
        apiKeyPreview: 'sk****************************ge'
      });
      await expect(configStore.readGlobalSnapshot()).resolves.toMatchObject({
        settings: { models: { image: { imageModels: [] } } },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } }
      });
    } finally {
      globalRuntime.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('rejects malformed media model setting saves instead of clearing overrides', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-media-model-invalid-save-home-'));
    const globalRuntime = new DebruteGlobalRuntimeServer({
      globalConfigStore: new GlobalConfigStore({ debruteHome: home }),
      integrationEnvPath: ''
    });
    try {
      await expect(saveGlobalImageModelSetting(globalRuntime, 'gpt-image-2', {} as never))
        .rejects.toThrow('Image model baseUrlOverride must be a string or null.');
      await expect(saveGlobalVideoModelSetting(globalRuntime, 'doubao-seedance-2-0-260128', {
        baseUrlOverride: null,
        requestModelIdOverride: '   '
      })).rejects.toThrow('Video model requestModelIdOverride must be null or a non-empty string.');
    } finally {
      globalRuntime.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('rejects malformed media model config records instead of filling missing fields', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-media-model-strict-config-home-'));
    const configStore = new GlobalConfigStore({ debruteHome: home });
    const configDir = join(home, 'config');
    const globalSettingsFile = join(configDir, 'global_settings.json');
    try {
      await mkdir(configDir, { recursive: true });
      await writeFile(globalSettingsFile, JSON.stringify({
        workbench: { locale: 'en', themePreference: 'system', defaultFrontend: 'electron' },
        chrome: { recentProjectRoots: [] },
        models: {
          image: {
            imageModels: [{ debruteModelId: 'gpt-image-2', requestModelIdOverride: null }]
          },
          video: { videoModels: [] },
          audio: { audioModels: [] }
        },
        adobeBridge: { enabled: true }
      }), 'utf8');
      await expect(configStore.readGlobalSettings()).rejects.toThrow('Image model baseUrlOverride must be a string or null.');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('rejects malformed media API key secret records', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-malformed-secret-home-'));
    const configStore = new GlobalConfigStore({ debruteHome: home });
    const configDir = join(home, 'config');
    const secretsFile = join(configDir, 'secrets.json');
    try {
      await mkdir(configDir, { recursive: true });
      await writeFile(secretsFile, JSON.stringify({
        imageModelApiKeys: {
          'gpt-image-2': 42
        },
        videoModelApiKeys: {},
        audioModelApiKeys: {}
      }), 'utf8');
      await expect(configStore.readGlobalSnapshot()).rejects.toThrow('Secrets config imageModelApiKeys values must be strings.');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('writes secrets with private config directory and file permissions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-secret-permissions-home-'));
    const configStore = new GlobalConfigStore({ debruteHome: home });
    const configDir = join(home, 'config');
    const secretsFile = join(configDir, 'secrets.json');
    try {
      await configStore.mutateGlobalSettings({
        kind: 'patch',
        input: {
          models: {
            image: {
              modelId: 'gpt-image-2',
              setting: { baseUrlOverride: null, requestModelIdOverride: null, apiKey: 'sk-image' }
            },
            video: {
              modelId: 'doubao-seedance-2-0-260128',
              setting: { baseUrlOverride: null, requestModelIdOverride: null, apiKey: 'sk-video' }
            },
            audio: {
              modelId: 'openai-gpt-4o-mini-tts',
              setting: { baseUrlOverride: null, requestModelIdOverride: null, apiKey: 'sk-audio' }
            }
          }
        }
      });
      if (process.platform !== 'win32') {
        expect((await stat(configDir)).mode & 0o777).toBe(0o700);
        expect((await stat(secretsFile)).mode & 0o777).toBe(0o600);
        await chmod(secretsFile, 0o644);
        expect((await stat(secretsFile)).mode & 0o777).toBe(0o644);
      }
      await configStore.mutateGlobalSettings({
        kind: 'patch',
        input: {
          models: {
            image: {
              modelId: 'gpt-image-2',
              setting: { baseUrlOverride: null, requestModelIdOverride: null, apiKey: 'sk-image-next' }
            }
          }
        }
      });
      if (process.platform !== 'win32') {
        expect((await stat(configDir)).mode & 0o777).toBe(0o700);
        expect((await stat(secretsFile)).mode & 0o777).toBe(0o600);
      }
      await expect(readFile(secretsFile, 'utf8')).resolves.toContain('sk-image-next');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  describe('global Workbench chrome state', () => {
    it('stores recent project roots in current runtime config', async () => {
      const debruteHome = await mkdtemp(join(tmpdir(), 'debrute-workbench-chrome-'));
      const server = new DebruteGlobalRuntimeServer({
        globalConfigStore: new GlobalConfigStore({ debruteHome }),
        integrationEnvPath: ''
      });
      try {
        await server.rememberRecentProjectRoot('/projects/alpha');
        await server.rememberRecentProjectRoot('/projects/beta');
        await server.rememberRecentProjectRoot('/projects/alpha');
        await expect(server.workbenchTitleBarState({
          host: 'desktop',
          platform: 'darwin',
          projectTitle: 'Alpha'
        })).resolves.toMatchObject({
          title: 'Alpha',
          recentProjectRoots: ['/projects/alpha', '/projects/beta'],
          presentation: { showWebMenus: false, trafficLightSpacer: true }
        });
        await expect(readFile(join(debruteHome, 'config/global_settings.json'), 'utf8')).resolves.toContain('/projects/alpha');
      } finally {
        server.close();
        await rm(debruteHome, { recursive: true, force: true });
      }
    });

    it('clears recent project roots through runtime state only', async () => {
      const debruteHome = await mkdtemp(join(tmpdir(), 'debrute-workbench-chrome-clear-'));
      const server = new DebruteGlobalRuntimeServer({
        globalConfigStore: new GlobalConfigStore({ debruteHome }),
        integrationEnvPath: ''
      });
      try {
        await server.rememberRecentProjectRoot('/projects/alpha');
        await server.clearRecentProjectRoots();
        await expect(server.workbenchTitleBarState({
          host: 'web',
          platform: 'linux'
        })).resolves.toMatchObject({
          title: 'Debrute',
          recentProjectRoots: []
        });
      } finally {
        server.close();
        await rm(debruteHome, { recursive: true, force: true });
      }
    });
  });
  async function saveGlobalImageModelSetting(
    runtime: DebruteGlobalRuntimeServer,
    modelId: string,
    setting: SaveImageModelSettingInput
  ): Promise<ImageModelSettingsView> {
    const settings = await runtime.globalSettingsSave({ models: { image: { modelId, setting } } });
    return settings.models.image;
  }

  async function saveGlobalVideoModelSetting(
    runtime: DebruteGlobalRuntimeServer,
    modelId: string,
    setting: SaveVideoModelSettingInput
  ): Promise<VideoModelSettingsView> {
    const settings = await runtime.globalSettingsSave({ models: { video: { modelId, setting } } });
    return settings.models.video;
  }

  async function saveGlobalAudioModelSetting(
    runtime: DebruteGlobalRuntimeServer,
    modelId: string,
    setting: SaveAudioModelSettingInput
  ): Promise<AudioModelSettingsView> {
    const settings = await runtime.globalSettingsSave({ models: { audio: { modelId, setting } } });
    return settings.models.audio;
  }
});

function directoryLinkType(): 'dir' | 'junction' {
  return process.platform === 'win32' ? 'junction' : 'dir';
}
