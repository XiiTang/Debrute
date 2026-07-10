// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { unavailableWorkbenchTitleBarState, type DebruteGlobalSettingsView, type DebruteProductState } from '@debrute/app-protocol';
import type { SettingsResource, WorkbenchActions, WorkbenchState } from '../../types';
import { I18nProvider } from '../i18n';
import { createEmptyProjectTreeSelection } from '../project-explorer/projectTreeInteraction';
import { SettingsPanel } from './SettingsPanel';
import { AudioModelSettings, ImageModelSettings } from './MediaModelSettingsPage';
import { GeneralSettingsPage } from './general/GeneralSettingsPage';

describe('SettingsPanel shared UI composition', () => {
  it('groups Settings navigation into General, Models, and Integrations', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <SettingsPanel state={stateWithSettings()} actions={actions()} />
      </I18nProvider>
    );

    expect(html).toContain('class="settings-directory-group"');
    expect(html).toContain('class="settings-directory-group__label">Models</span>');
    expect(html).toContain('class="settings-directory-group__label">Integrations</span>');
    expect(html.indexOf('Image Models')).toBeLessThan(html.indexOf('Integrations</strong>'));
    expect(html.indexOf('Integrations</strong>')).toBeLessThan(html.indexOf('Adobe Bridge'));
  });

  it('renders exactly one selected Settings page title', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <SettingsPanel state={stateWithSettings()} actions={actions()} />
      </I18nProvider>
    );

    expect((html.match(/<h2/g) ?? []).length).toBe(1);
    expect(html).toContain('<h2>General</h2>');
  });

  it('renders media model settings through Settings-owned model-card patterns', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <ImageModelSettings
          settings={readyResourceValue(stateWithSettings().globalSettings).models.image}
          actions={actions()}
        />
      </I18nProvider>
    );

    expect(html).toContain('settings-model-card');
    expect(html).toContain('settings-model-card__header');
    expect(html).toContain('settings-model-card__fields');
    expect(html).toContain('settings-secret-field');
    expect(html).toContain('settings-api-key-summary');
    expect(html).toContain('aria-label="Delete API key"');
    expect(html).toContain('db-workbench-close-button');
    expect(html).toContain('sk****************************aa');
    expect(html).not.toContain('key sk****************************aa');
  });

  it('renders a ready empty state when a media category has no models', () => {
    const imageHtml = renderToStaticMarkup(
      <I18nProvider locale="en">
        <ImageModelSettings settings={{ models: [] }} actions={actions()} />
      </I18nProvider>
    );
    const audioHtml = renderToStaticMarkup(
      <I18nProvider locale="en">
        <AudioModelSettings
          settings={{ models: [] }}
          actions={actions()}
          kind="tts"
        />
      </I18nProvider>
    );

    expect(imageHtml).toContain('class="db-empty-state"');
    expect(imageHtml).toContain('No models are available for this category.');
    expect(audioHtml).toContain('class="db-empty-state"');
    expect(audioHtml).toContain('No models are available for this category.');
  });

  it('saves a single media model API key from the model card', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const saveGlobalSettings = vi.fn(async () => undefined);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <ImageModelSettings
              settings={readyResourceValue(stateWithSettings().globalSettings).models.image}
              actions={{ ...actions(), saveGlobalSettings } as WorkbenchActions}
            />
          </I18nProvider>
        );
      });

      const keyInput = container.querySelector('input[aria-label="API Key"]');
      if (!(keyInput instanceof HTMLInputElement)) {
        throw new Error('Expected API key input.');
      }
      await act(async () => {
        setInputValue(keyInput, 'sk-new');
        keyInput.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => {
        keyInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      });

      expect(saveGlobalSettings).toHaveBeenCalledWith({
        models: {
          image: {
            modelId: 'image/openai/gpt-image-1',
            setting: {
              baseUrlOverride: null,
              requestModelIdOverride: null,
              apiKey: 'sk-new'
            }
          }
        }
      });
    } finally {
      await unmount(root, container);
      restoreActEnvironment();
    }
  });

  it('deletes a configured single media model API key from the preview pill', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const saveGlobalSettings = vi.fn(async () => undefined);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <ImageModelSettings
              settings={readyResourceValue(stateWithSettings().globalSettings).models.image}
              actions={{ ...actions(), saveGlobalSettings } as WorkbenchActions}
            />
          </I18nProvider>
        );
      });

      const deleteButton = requireButton(container, 'Delete API key');
      await act(async () => {
        deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(saveGlobalSettings).toHaveBeenCalledWith({
        models: {
          image: {
            modelId: 'image/openai/gpt-image-1',
            setting: {
              baseUrlOverride: null,
              requestModelIdOverride: null,
              apiKey: ''
            }
          }
        }
      });
    } finally {
      await unmount(root, container);
      restoreActEnvironment();
    }
  });

  it('preserves in-progress media model drafts when unchanged settings arrive as new objects', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const saveGlobalSettings = vi.fn(async () => undefined);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <ImageModelSettings
              settings={readyResourceValue(stateWithSettings().globalSettings).models.image}
              actions={{ ...actions(), saveGlobalSettings } as WorkbenchActions}
            />
          </I18nProvider>
        );
      });

      const keyInput = container.querySelector('input[aria-label="API Key"]');
      if (!(keyInput instanceof HTMLInputElement)) {
        throw new Error('Expected API key input.');
      }
      await act(async () => {
        setInputValue(keyInput, 'sk-draft');
        keyInput.dispatchEvent(new Event('input', { bubbles: true }));
      });

      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <ImageModelSettings
              settings={readyResourceValue(stateWithSettings({
                globalSettings: {
                  status: 'ready',
                  value: globalSettingsFixture({
                    chrome: { recentProjectRoots: ['/projects/alpha'] }
                  })
                }
              }).globalSettings).models.image}
              actions={{ ...actions(), saveGlobalSettings } as WorkbenchActions}
            />
          </I18nProvider>
        );
      });

      const nextKeyInput = container.querySelector('input[aria-label="API Key"]');
      expect(nextKeyInput).toBeInstanceOf(HTMLInputElement);
      expect((nextKeyInput as HTMLInputElement).value).toBe('sk-draft');
      expect(saveGlobalSettings).not.toHaveBeenCalled();
    } finally {
      await unmount(root, container);
      restoreActEnvironment();
    }
  });

  it('omits missing API key status text from model cards', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="zh-CN">
        <ImageModelSettings
          settings={readyResourceValue(stateWithSettings({
            globalSettings: {
              status: 'ready',
              value: globalSettingsFixture({
                models: {
                  ...globalSettingsFixture().models,
                  image: {
                    models: [{
                      debruteModelId: 'image/openai/gpt-image-1',
                      summary: 'OpenAI gpt-image-1 image generation and edits.',
                      supportsEditing: true,
                      supportsTextRendering: true,
                      defaultBaseUrl: 'https://api.openai.com/v1',
                      defaultRequestModelId: 'gpt-image-1',
                      baseUrlOverride: null,
                      requestModelIdOverride: null,
                      apiKeySet: false,
                      apiKeyPreview: null
                    }]
                  }
                }
              })
            }
          }).globalSettings).models.image}
          actions={actions()}
        />
      </I18nProvider>
    );

    expect(html).toContain('settings-model-card');
    expect(html).toContain('API 密钥');
    expect(html).not.toContain('aria-label="Delete API key"');
  });

  it('renders General settings as grouped sections', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <GeneralSettingsPage
          actions={actions()}
          initialProductState={productState()}
          settings={readyResourceValue(stateWithSettings().globalSettings)}
          resolvedTheme="dark"
          onSettingsChange={async () => undefined}
        />
      </I18nProvider>
    );

    expect((html.match(/class="settings-group"/g) ?? []).length).toBe(4);
  });

  it('uses neutral tones for quiet ready states', () => {
    const general = renderToStaticMarkup(
      <I18nProvider locale="en">
        <GeneralSettingsPage
          actions={actions()}
          initialProductState={productState()}
          settings={readyResourceValue(stateWithSettings().globalSettings)}
          resolvedTheme="dark"
          onSettingsChange={async () => undefined}
        />
      </I18nProvider>
    );

    expect(general).toContain('db-status-pill--neutral');
    expect(general).not.toContain('db-status-pill--success');
  });

  it('shows a retryable Product State error instead of a fabricated up-to-date state', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const getProductState = vi.fn()
      .mockRejectedValueOnce(new Error('runtime offline'))
      .mockResolvedValueOnce(productState());

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <GeneralSettingsPage
              actions={{
                getProductState,
                checkProductUpdate: vi.fn(async () => productState()),
                applyProductUpdate: vi.fn(async () => ({ state: productState() }))
              }}
              settings={readyResourceValue(stateWithSettings().globalSettings)}
              resolvedTheme="dark"
              onSettingsChange={async () => undefined}
            />
          </I18nProvider>
        );
        await Promise.resolve();
      });

      expect(container.textContent).toContain('Failed to load product state: runtime offline');
      expect(container.textContent).not.toContain('Up to date');
      expect(container.textContent).not.toContain('unknown');

      await act(async () => {
        requireButton(container, 'Retry').click();
        await Promise.resolve();
      });

      expect(getProductState).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain('0.2.0');
      expect(container.textContent).toContain('Up to date');
    } finally {
      await unmount(root, container);
      restoreActEnvironment();
    }
  });

  it('renders Workbench language and appearance preferences in General settings', () => {
    const saved: unknown[] = [];
    const html = renderToStaticMarkup(
      <I18nProvider locale="zh-CN">
        <GeneralSettingsPage
          actions={actions()}
          initialProductState={productState()}
          settings={{
            workbench: { locale: 'zh-CN', themePreference: 'system', defaultFrontend: 'browser' },
            chrome: { recentProjectRoots: [] },
            models: { image: { models: [] }, video: { models: [] }, audio: { models: [] } },
            integrations: { integrations: [], backends: [] },
            adobeBridge: { enabled: true }
          }}
          resolvedTheme="dark"
          onSettingsChange={async (settings) => {
            saved.push(settings);
          }}
        />
      </I18nProvider>
    );

    expect(html).not.toContain('<h2');
    expect(html).toContain('外观');
    expect(html).toContain('主题');
    expect(html).toContain('跟随系统');
    expect(html).toContain('深色');
    expect(html).toContain('浅色');
    expect(html).toContain('语言');
    expect(html).toContain('简体中文');
    expect(html).toContain('默认前端');
    expect(html).toContain('浏览器');
    expect(html).toContain('仅运行 Runtime');
    expect(saved).toEqual([]);
  });

  it('saves the default frontend through global settings', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onSettingsChange = vi.fn(async () => undefined);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <GeneralSettingsPage
              actions={actions()}
              initialProductState={productState()}
              settings={readyResourceValue(stateWithSettings().globalSettings)}
              resolvedTheme="dark"
              onSettingsChange={onSettingsChange}
            />
          </I18nProvider>
        );
      });

      const select = Array.from(container.querySelectorAll('select'))
        .find((candidate) => candidate.textContent?.includes('Runtime only'));
      if (!(select instanceof HTMLSelectElement)) {
        throw new Error('Expected default frontend select.');
      }
      await act(async () => {
        setSelectValue(select, 'runtime-only');
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });

      expect(onSettingsChange).toHaveBeenCalledWith({
        workbench: { defaultFrontend: 'runtime-only' }
      });
    } finally {
      await unmount(root, container);
      restoreActEnvironment();
    }
  });

  it('preserves rejected General preference drafts and shows each error in its owning section', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onSettingsChange = vi.fn(async (input: Parameters<WorkbenchActions['saveGlobalSettings']>[0]) => {
      if (input.workbench?.themePreference) throw new Error('theme unavailable');
      if (input.workbench?.locale) throw new Error('language unavailable');
      throw new Error('frontend unavailable');
    });

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <GeneralSettingsPage
              actions={actions()}
              initialProductState={productState()}
              settings={readyResourceValue(stateWithSettings().globalSettings)}
              resolvedTheme="dark"
              onSettingsChange={onSettingsChange}
            />
          </I18nProvider>
        );
      });

      const theme = requireSelectWithOption(container, 'Light');
      const language = requireSelectWithOption(container, 'Simplified Chinese');
      const defaultFrontend = requireSelectWithOption(container, 'Runtime only');
      await changeSelect(theme, 'dark');
      await changeSelect(language, 'zh-CN');
      await changeSelect(defaultFrontend, 'runtime-only');

      expect(theme.value).toBe('dark');
      expect(language.value).toBe('zh-CN');
      expect(defaultFrontend.value).toBe('runtime-only');

      const appearanceSection = requireSettingsSection(container, 'Appearance');
      const languageSection = requireSettingsSection(container, 'Language');
      const applicationSection = requireSettingsSection(container, 'Application');
      expect(appearanceSection.textContent).toContain('Failed to save appearance preference: theme unavailable');
      expect(appearanceSection.textContent).not.toContain('language unavailable');
      expect(languageSection.textContent).toContain('Failed to save language preference: language unavailable');
      expect(languageSection.textContent).not.toContain('theme unavailable');
      expect(applicationSection.textContent).toContain('Failed to save default frontend: frontend unavailable');
      expect(applicationSection.textContent).not.toContain('theme unavailable');
    } finally {
      await unmount(root, container);
      restoreActEnvironment();
    }
  });

  it('keeps unrelated General preference fields enabled while one save is pending', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const save = deferred<void>();

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <GeneralSettingsPage
              actions={actions()}
              initialProductState={productState()}
              settings={readyResourceValue(stateWithSettings().globalSettings)}
              resolvedTheme="dark"
              onSettingsChange={() => save.promise}
            />
          </I18nProvider>
        );
      });

      const theme = requireSelectWithOption(container, 'Light');
      const language = requireSelectWithOption(container, 'Simplified Chinese');
      const defaultFrontend = requireSelectWithOption(container, 'Runtime only');
      await act(async () => {
        setSelectValue(theme, 'dark');
        theme.dispatchEvent(new Event('change', { bubbles: true }));
        await Promise.resolve();
      });

      expect(theme.disabled).toBe(true);
      expect(language.disabled).toBe(false);
      expect(defaultFrontend.disabled).toBe(false);

      await act(async () => {
        save.resolve(undefined);
        await save.promise;
      });
    } finally {
      await unmount(root, container);
      restoreActEnvironment();
    }
  });

  it('synchronizes each General draft when its persisted preference changes', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      const renderSettings = async (settings: DebruteGlobalSettingsView) => {
        await act(async () => {
          root.render(
            <I18nProvider locale="en">
              <GeneralSettingsPage
                actions={actions()}
                initialProductState={productState()}
                settings={settings}
                resolvedTheme="light"
                onSettingsChange={async () => undefined}
              />
            </I18nProvider>
          );
        });
      };
      await renderSettings(globalSettingsFixture());
      await renderSettings(globalSettingsFixture({
        workbench: { locale: 'zh-CN', themePreference: 'light', defaultFrontend: 'browser' }
      }));

      expect(requireSelectWithOption(container, 'Light').value).toBe('light');
      expect(requireSelectWithOption(container, 'Simplified Chinese').value).toBe('zh-CN');
      expect(requireSelectWithOption(container, 'Runtime only').value).toBe('browser');
    } finally {
      await unmount(root, container);
      restoreActEnvironment();
    }
  });

  it('renders one audio model kind per settings page', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <AudioModelSettings
          settings={readyResourceValue(stateWithSettings().globalSettings).models.audio}
          actions={actions()}
          kind="tts"
        />
      </I18nProvider>
    );

    expect(html).toContain('audio/openai/gpt-4o-mini-tts');
    expect(html).not.toContain('audio/elevenlabs/music');
    expect(html).not.toContain('audio/elevenlabs/sfx');
  });

  it('opens image, video, TTS, music, and SFX model settings as separate pages', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <SettingsPanel state={stateWithSettings()} actions={actions()} />
          </I18nProvider>
        );
      });

      const imageModelsButton = requireButton(container, 'Image Models');
      const videoModelsButton = requireButton(container, 'Video Models');
      const ttsModelsButton = requireButton(container, 'TTS Models');
      const musicModelsButton = requireButton(container, 'Music Models');
      const sfxModelsButton = requireButton(container, 'SFX Models');

      await act(async () => {
        imageModelsButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(container.querySelector('.settings-page')?.textContent).toContain('image/openai/gpt-image-1');
      expect(container.querySelector('.settings-page')?.textContent).not.toContain('video/google/veo-3');

      await act(async () => {
        videoModelsButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(container.querySelector('.settings-page')?.textContent).not.toContain('image/openai/gpt-image-1');
      expect(container.querySelector('.settings-page')?.textContent).toContain('video/google/veo-3');

      await act(async () => {
        ttsModelsButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(container.querySelector('.settings-page')?.textContent).not.toContain('image/openai/gpt-image-1');
      expect(container.querySelector('.settings-page')?.textContent).not.toContain('video/google/veo-3');
      expect(container.querySelector('.settings-page')?.textContent).toContain('audio/openai/gpt-4o-mini-tts');
      expect(container.querySelector('.settings-page')?.textContent).not.toContain('audio/elevenlabs/music');
      expect(container.querySelector('.settings-page')?.textContent).not.toContain('audio/elevenlabs/sfx');

      await act(async () => {
        musicModelsButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(container.querySelector('.settings-page')?.textContent).not.toContain('audio/openai/gpt-4o-mini-tts');
      expect(container.querySelector('.settings-page')?.textContent).toContain('audio/elevenlabs/music');
      expect(container.querySelector('.settings-page')?.textContent).not.toContain('audio/elevenlabs/sfx');

      await act(async () => {
        sfxModelsButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(container.querySelector('.settings-page')?.textContent).not.toContain('audio/openai/gpt-4o-mini-tts');
      expect(container.querySelector('.settings-page')?.textContent).not.toContain('audio/elevenlabs/music');
      expect(container.querySelector('.settings-page')?.textContent).toContain('audio/elevenlabs/sfx');
    } finally {
      await unmount(root, container);
      restoreActEnvironment();
    }
  });

  it('renders model settings load failures with retry instead of an empty model grid', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const reloadGlobalSettings = vi.fn(async () => undefined);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <SettingsPanel
              state={stateWithSettings({
                globalSettings: { status: 'error', message: 'Secrets config imageModelApiKeys values must be strings.' }
              })}
              actions={{ ...actions(), reloadGlobalSettings } as WorkbenchActions}
            />
          </I18nProvider>
        );
      });

      await act(async () => {
        requireButton(container, 'Image Models').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(container.querySelector('.settings-page')?.textContent).toContain('Failed to load settings: Secrets config imageModelApiKeys values must be strings.');
      expect(container.querySelector('.settings-page')?.textContent).not.toContain('image/openai/gpt-image-1');
      expect(container.querySelector('.settings-page .settings-model-card')).toBeNull();

      await act(async () => {
        requireButton(container, 'Retry').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
      });

      expect(reloadGlobalSettings).toHaveBeenCalledTimes(1);
    } finally {
      await unmount(root, container);
      restoreActEnvironment();
    }
  });

  it('saves persisted Adobe enabled state without reloading live state', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const saveGlobalSettings = vi.fn(async () => undefined);
    const reloadAdobeBridge = vi.fn(async () => undefined);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <SettingsPanel
              state={stateWithSettings()}
              actions={{ ...actions(), saveGlobalSettings, reloadAdobeBridge } as WorkbenchActions}
            />
          </I18nProvider>
        );
      });
      await act(async () => {
        requireButton(container, 'Adobe Bridge').click();
      });
      const enabledSwitch = container.querySelector('input[type="checkbox"]');
      if (!(enabledSwitch instanceof HTMLInputElement)) {
        throw new Error('Expected Adobe Bridge enabled switch.');
      }

      await act(async () => {
        enabledSwitch.click();
        await Promise.resolve();
      });

      expect(saveGlobalSettings).toHaveBeenCalledWith({ adobeBridge: { enabled: false } });
      expect(reloadAdobeBridge).not.toHaveBeenCalled();
    } finally {
      await unmount(root, container);
      restoreActEnvironment();
    }
  });

  it('shows per-client Adobe link progress and preserves failures for retry', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const link = deferred<void>();
    const linkAdobeBridgePhotoshop = vi.fn()
      .mockImplementationOnce(() => link.promise)
      .mockResolvedValueOnce(undefined);
    const state = stateWithSettings({
      projectId: 'project-1',
      adobeBridge: {
        status: 'ready',
        value: {
          settings: { enabled: true, discoveryStatus: 'available' },
          adobeClients: [{
            adobeClientId: 'photoshop-1',
            hostApp: 'photoshop',
            hostVersion: '2026',
            displayName: 'Photoshop 2026',
            documentCount: 0,
            activeDocumentTitle: null,
            connectedAt: '2026-07-10T00:00:00.000Z',
            lastSeenAt: '2026-07-10T00:00:00.000Z'
          }, {
            adobeClientId: 'photoshop-2',
            hostApp: 'photoshop',
            hostVersion: '2026',
            displayName: 'Photoshop 2026 · Second client',
            documentCount: 0,
            activeDocumentTitle: null,
            connectedAt: '2026-07-10T00:00:00.000Z',
            lastSeenAt: '2026-07-10T00:00:00.000Z'
          }],
          projects: [],
          links: [],
          transfers: []
        }
      }
    });

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <SettingsPanel
              state={state}
              actions={{ ...actions(), linkAdobeBridgePhotoshop } as WorkbenchActions}
            />
          </I18nProvider>
        );
      });
      await act(async () => {
        requireButton(container, 'Adobe Bridge').click();
      });

      const connect = requireButton(container, 'Connect');
      await act(async () => {
        connect.click();
        await Promise.resolve();
      });
      expect(connect.disabled).toBe(true);
      expect(connect.getAttribute('aria-busy')).toBe('true');
      const otherConnect = Array.from(container.querySelectorAll('button')).find((candidate) => (
        candidate !== connect && candidate.textContent === 'Connect'
      ));
      expect(otherConnect).toBeInstanceOf(HTMLButtonElement);
      expect((otherConnect as HTMLButtonElement).disabled).toBe(false);

      await act(async () => {
        link.reject(new Error('Photoshop link denied'));
        await link.promise.catch(() => undefined);
        await Promise.resolve();
      });
      expect(connect.disabled).toBe(false);
      expect(connect.getAttribute('aria-busy')).toBeNull();
      expect(connect.closest('.db-record-row')?.textContent).toContain('Photoshop link denied');

      await act(async () => {
        connect.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(linkAdobeBridgePhotoshop).toHaveBeenCalledTimes(2);
      expect(connect.closest('.db-record-row')?.textContent).not.toContain('Photoshop link denied');
    } finally {
      await unmount(root, container);
      restoreActEnvironment();
    }
  });
});

function stateWithSettings(overrides: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    snapshot: undefined,
    titleBarState: unavailableWorkbenchTitleBarState(),
    globalSettings: { status: 'ready', value: globalSettingsFixture() },
    resolvedTheme: 'dark',
    projectOpen: { opening: false },
    explorerSelection: createEmptyProjectTreeSelection(),
    adobeBridge: { status: 'ready', value: { settings: { enabled: true, discoveryStatus: 'available' }, adobeClients: [], projects: [], links: [], transfers: [] } },
    canvasFeedback: undefined,
    textFileBuffers: {},
    textEditorWindows: {},
    notifications: [],
    ...overrides
  };
}

function globalSettingsFixture(overrides: Partial<DebruteGlobalSettingsView> = {}): DebruteGlobalSettingsView {
  return {
    workbench: { locale: 'en', themePreference: 'system', defaultFrontend: 'electron' },
    chrome: { recentProjectRoots: [] },
    models: {
      image: {
        models: [{
          debruteModelId: 'image/openai/gpt-image-1',
          summary: 'OpenAI gpt-image-1 image generation and edits.',
          supportsEditing: true,
          supportsTextRendering: true,
          defaultBaseUrl: 'https://api.openai.com/v1',
          defaultRequestModelId: 'gpt-image-1',
          baseUrlOverride: null,
          requestModelIdOverride: null,
          apiKeySet: true,
          apiKeyPreview: 'sk****************************aa'
        }]
      },
      video: {
        models: [{
          debruteModelId: 'video/google/veo-3',
          summary: 'Google Veo 3 video generation.',
          supportsTextToVideo: true,
          supportsImageReferences: true,
          supportsVideoReferences: false,
          supportsAudioReferences: false,
          supportsGeneratedAudio: true,
          defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
          defaultRequestModelId: 'veo-3.0-generate-preview',
          baseUrlOverride: null,
          requestModelIdOverride: null,
          apiKeySet: false,
          apiKeyPreview: null
        }]
      },
      audio: {
        models: [{
          debruteModelId: 'audio/openai/gpt-4o-mini-tts',
          kind: 'tts',
          summary: 'OpenAI gpt-4o-mini-tts TTS generation.',
          defaultBaseUrl: 'https://api.openai.com/v1',
          defaultRequestModelId: 'gpt-4o-mini-tts',
          baseUrlOverride: null,
          requestModelIdOverride: null,
          apiKeySet: false,
          apiKeyPreview: null
        }, {
          debruteModelId: 'audio/elevenlabs/music',
          kind: 'music',
          summary: 'ElevenLabs music generation.',
          defaultBaseUrl: 'https://api.elevenlabs.io/v1',
          defaultRequestModelId: 'music',
          baseUrlOverride: null,
          requestModelIdOverride: null,
          apiKeySet: false,
          apiKeyPreview: null
        }, {
          debruteModelId: 'audio/elevenlabs/sfx',
          kind: 'sound-effect',
          summary: 'ElevenLabs sound effects generation.',
          defaultBaseUrl: 'https://api.elevenlabs.io/v1',
          defaultRequestModelId: 'sound-generation',
          baseUrlOverride: null,
          requestModelIdOverride: null,
          apiKeySet: false,
          apiKeyPreview: null
        }]
      }
    },
    integrations: { integrations: [], backends: [] },
    adobeBridge: { enabled: true },
    ...overrides
  };
}

function actions(): WorkbenchActions {
  return {
    getProductState: vi.fn(async () => productState()),
    checkProductUpdate: vi.fn(async () => productState()),
    applyProductUpdate: vi.fn(async () => ({ state: productState() })),
    reloadGlobalSettings: vi.fn(async () => undefined),
    reloadAdobeBridge: vi.fn(async () => undefined),
    saveGlobalSettings: vi.fn(async () => undefined),
    runIntegrationOperation: vi.fn(async (input) => ({
      ok: true,
      integrationId: input.integrationId,
      operation: input.operation,
      settings: { integrations: [], backends: [] }
    }))
  } as unknown as WorkbenchActions;
}

function readyResourceValue<T>(resource: SettingsResource<T>): T {
  if (resource.status !== 'ready') {
    throw new Error(`Expected ready resource, got ${resource.status}.`);
  }
  return resource.value;
}

async function unmount(root: Root, container: HTMLDivElement): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

function requireButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => (
    candidate.textContent === label
    || candidate.getAttribute('aria-label') === label
    || candidate.getAttribute('title') === label
  ));
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected button ${label}.`);
  }
  return button;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) {
    throw new Error('Expected HTMLInputElement value setter.');
  }
  setter.call(input, value);
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  if (!setter) {
    throw new Error('Expected HTMLSelectElement value setter.');
  }
  setter.call(select, value);
}

async function changeSelect(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    setSelectValue(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function requireSelectWithOption(container: HTMLElement, option: string): HTMLSelectElement {
  const select = Array.from(container.querySelectorAll('select')).find((candidate) => (
    candidate.textContent?.includes(option)
  ));
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error(`Expected select containing option ${option}.`);
  }
  return select;
}

function requireSettingsSection(container: HTMLElement, title: string): HTMLElement {
  const section = Array.from(container.querySelectorAll<HTMLElement>('.settings-group')).find((candidate) => (
    candidate.querySelector('h3')?.textContent === title
  ));
  if (!section) {
    throw new Error(`Expected Settings section ${title}.`);
  }
  return section;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function installReactActEnvironment(): () => void {
  const globalWithAct = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = globalWithAct.IS_REACT_ACT_ENVIRONMENT;
  globalWithAct.IS_REACT_ACT_ENVIRONMENT = true;
  return () => {
    if (previous === undefined) {
      delete globalWithAct.IS_REACT_ACT_ENVIRONMENT;
    } else {
      globalWithAct.IS_REACT_ACT_ENVIRONMENT = previous;
    }
  };
}

function productState(): DebruteProductState {
  return {
    productVersion: '0.2.0',
    platform: 'darwin',
    cli: {
      status: 'ready',
      version: '0.2.0',
      path: '/Users/me/.debrute/bin/debrute',
      skillsVersion: '0.2.0',
      skillsRoot: '/Users/me/.agents/skills'
    },
    update: {
      type: 'idle',
      currentVersion: '0.2.0',
      updateAvailable: false
    }
  };
}
