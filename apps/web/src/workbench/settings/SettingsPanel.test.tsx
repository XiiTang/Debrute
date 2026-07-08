// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { unavailableWorkbenchTitleBarState, type DebruteProductState } from '@debrute/app-protocol';
import type { SettingsResource, WorkbenchActions, WorkbenchState } from '../../types';
import { I18nProvider } from '../i18n';
import { createEmptyProjectTreeSelection } from '../project-explorer/projectTreeInteraction';
import { AudioModelSettings, ImageModelSettings, SettingsPanel } from './SettingsPanel';
import { GeneralSettingsPage } from './general/GeneralSettingsPage';

describe('SettingsPanel shared UI composition', () => {
  it('renders media model settings through shared model-card patterns', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <ImageModelSettings
          settings={readyResourceValue(stateWithSettings().imageModelSettings)}
          actions={actions()}
        />
      </I18nProvider>
    );

    expect(html).toContain('db-model-card');
    expect(html).toContain('db-model-card__header');
    expect(html).toContain('db-model-card__fields');
    expect(html).toContain('db-secret-field');
    expect(html).toContain('canvas-feedback-comment-pill');
    expect(html).toContain('aria-label="Delete API key"');
    expect(html).toContain('db-workbench-close-button');
    expect(html).toContain('canvas-feedback-comment-pill-close');
    expect(html).toContain('sk****************************aa');
    expect(html).not.toContain('key sk****************************aa');
    expect(html).not.toContain('db-button--danger');
    expect(html).not.toContain('db-api-key-list');
    expect(html).not.toContain('1 enabled / 2 keys');
    expect(html).not.toContain('settings-model-card');
    expect(html).not.toContain('settings-key-input');
  });

  it('saves a single media model API key from the model card', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const saveImageModelSetting = vi.fn(async () => undefined);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <ImageModelSettings
              settings={readyResourceValue(stateWithSettings().imageModelSettings)}
              actions={{ ...actions(), saveImageModelSetting } as WorkbenchActions}
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

      expect(saveImageModelSetting).toHaveBeenCalledWith('image/openai/gpt-image-1', {
        baseUrlOverride: null,
        requestModelIdOverride: null,
        apiKey: 'sk-new'
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
    const saveImageModelSetting = vi.fn(async () => undefined);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <ImageModelSettings
              settings={readyResourceValue(stateWithSettings().imageModelSettings)}
              actions={{ ...actions(), saveImageModelSetting } as WorkbenchActions}
            />
          </I18nProvider>
        );
      });

      const deleteButton = requireButton(container, 'Delete API key');
      await act(async () => {
        deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(saveImageModelSetting).toHaveBeenCalledWith('image/openai/gpt-image-1', {
        baseUrlOverride: null,
        requestModelIdOverride: null,
        apiKey: ''
      });
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
            imageModelSettings: {
              status: 'ready',
              value: {
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
          }).imageModelSettings)}
          actions={actions()}
        />
      </I18nProvider>
    );

    expect(html).toContain('db-model-card');
    expect(html).toContain('API 密钥');
    expect(html).not.toContain('db-model-card__key-summary');
    expect(html).not.toContain('canvas-feedback-comment-pill');
  });

  it('renders Workbench language and appearance preferences in General settings', () => {
    const saved: Array<{ locale: string; themePreference: string }> = [];
    const html = renderToStaticMarkup(
      <I18nProvider locale="zh-CN">
        <GeneralSettingsPage
          actions={actions()}
          initialProductState={productState()}
          preferences={{ locale: 'zh-CN', themePreference: 'system' }}
          resolvedTheme="dark"
          onPreferencesChange={async (preferences) => {
            saved.push(preferences);
          }}
        />
      </I18nProvider>
    );

    expect(html).toContain('通用');
    expect(html).toContain('外观');
    expect(html).toContain('主题');
    expect(html).toContain('跟随系统');
    expect(html).toContain('深色');
    expect(html).toContain('浅色');
    expect(html).toContain('语言');
    expect(html).toContain('简体中文');
    expect(saved).toEqual([]);
  });

  it('renders one audio model kind per settings page', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <AudioModelSettings
          settings={readyResourceValue(stateWithSettings().audioModelSettings)}
          actions={actions()}
          kind="tts"
          title="TTS Models"
        />
      </I18nProvider>
    );

    expect(html).toContain('TTS Models');
    expect(html).toContain('audio/openai/gpt-4o-mini-tts');
    expect(html).not.toContain('audio/elevenlabs/music');
    expect(html).not.toContain('audio/elevenlabs/sfx');
    expect(html).not.toContain('db-settings-model-group');
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
    const reloadImageModelSettings = vi.fn(async () => undefined);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <SettingsPanel
              state={stateWithSettings({
                imageModelSettings: { status: 'error', message: 'Secrets config imageModelApiKeys values must be strings.' }
              })}
              actions={{ ...actions(), reloadImageModelSettings } as WorkbenchActions}
            />
          </I18nProvider>
        );
      });

      await act(async () => {
        requireButton(container, 'Image Models').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(container.querySelector('.settings-page')?.textContent).toContain('Failed to load settings: Secrets config imageModelApiKeys values must be strings.');
      expect(container.querySelector('.settings-page')?.textContent).not.toContain('image/openai/gpt-image-1');
      expect(container.querySelector('.settings-page .db-model-card')).toBeNull();

      await act(async () => {
        requireButton(container, 'Retry').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
      });

      expect(reloadImageModelSettings).toHaveBeenCalledTimes(1);
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
    workbenchPreferences: { status: 'ready', value: { locale: 'en', themePreference: 'system' } },
    resolvedTheme: 'dark',
    projectOpen: { opening: false },
    explorerSelection: createEmptyProjectTreeSelection(),
    imageModelSettings: {
      status: 'ready',
      value: {
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
      }
    },
    videoModelSettings: {
      status: 'ready',
      value: {
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
      }
    },
    audioModelSettings: {
      status: 'ready',
      value: {
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
    integrationsSettings: { status: 'ready', value: { integrations: [], backends: [] } },
    adobeBridge: { status: 'ready', value: { settings: { enabled: true, discoveryStatus: 'available' }, adobeClients: [], projects: [], links: [], transfers: [] } },
    canvasFeedback: undefined,
    textFileBuffers: {},
    textEditorWindows: {},
    notifications: [],
    ...overrides
  };
}

function actions(): WorkbenchActions {
  return {
    getProductState: vi.fn(async () => productState()),
    checkProductUpdate: vi.fn(async () => productState()),
    applyProductUpdate: vi.fn(async () => ({ state: productState() })),
    reloadWorkbenchPreferences: vi.fn(async () => undefined),
    reloadImageModelSettings: vi.fn(async () => undefined),
    reloadVideoModelSettings: vi.fn(async () => undefined),
    reloadAudioModelSettings: vi.fn(async () => undefined),
    reloadIntegrationsSettings: vi.fn(async () => undefined),
    reloadAdobeBridge: vi.fn(async () => undefined),
    saveWorkbenchPreferences: vi.fn(async () => undefined),
    saveImageModelSetting: vi.fn(async () => undefined),
    saveVideoModelSetting: vi.fn(async () => undefined),
    saveAudioModelSetting: vi.fn(async () => undefined),
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
