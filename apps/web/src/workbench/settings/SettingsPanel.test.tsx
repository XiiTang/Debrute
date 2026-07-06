// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { unavailableWorkbenchTitleBarState, type DebruteProductState } from '@debrute/app-protocol';
import type { WorkbenchActions, WorkbenchState } from '../../types';
import { I18nProvider } from '../i18n';
import { createEmptyProjectTreeSelection } from '../project-explorer/projectTreeInteraction';
import { AudioModelSettings, ImageModelSettings, SettingsPanel } from './SettingsPanel';
import { GeneralSettingsPage } from './general/GeneralSettingsPage';
import { ModelApiKeyListEditor } from './ModelApiKeyListEditor';

describe('SettingsPanel shared UI composition', () => {
  it('renders media model settings through shared model-card patterns', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <ImageModelSettings
          state={stateWithSettings()}
          actions={actions()}
        />
      </I18nProvider>
    );

    expect(html).toContain('db-model-card');
    expect(html).toContain('db-model-card__header');
    expect(html).toContain('db-model-card__fields');
    expect(html).toContain('db-api-key-list');
    expect(html).toContain('1 enabled / 2 keys');
    expect(html).toContain('Primary');
    expect(html).toContain('sk****************************aa');
    expect(html).not.toContain('settings-model-card');
    expect(html).not.toContain('settings-key-input');
  });

  it('saves media model API key list edits', async () => {
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
              state={stateWithSettings()}
              actions={{ ...actions(), saveImageModelSetting } as WorkbenchActions}
            />
          </I18nProvider>
        );
      });

      const addButton = requireButton(container, 'Add key');
      await act(async () => {
        addButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      const keyInput = container.querySelector('input[aria-label="New API key"]');
      if (!(keyInput instanceof HTMLInputElement)) {
        throw new Error('Expected new API key input.');
      }
      await act(async () => {
        setInputValue(keyInput, 'sk-new');
        keyInput.dispatchEvent(new Event('input', { bubbles: true }));
      });

      const saveButton = container.querySelector('button[aria-label="Save key"]');
      if (!(saveButton instanceof HTMLButtonElement)) {
        throw new Error('Expected save key button.');
      }
      await act(async () => {
        saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(saveImageModelSetting).toHaveBeenCalledWith('image/openai/gpt-image-1', expect.objectContaining({
        apiKeys: expect.arrayContaining([
          expect.objectContaining({ key: 'sk-new', enabled: true })
        ])
      }));
    } finally {
      await unmount(root, container);
      restoreActEnvironment();
    }
  });

  it('saves label, enabled, delete, and clear edits from the API key list editor', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onSave = vi.fn(async () => undefined);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <ModelApiKeyListEditor
              previews={[
                { id: 'key-a', label: 'Primary', enabled: true, preview: 'sk****************************aa' },
                { id: 'key-b', label: null, enabled: false, preview: 'sk****************************bb' }
              ]}
              onSave={onSave}
            />
          </I18nProvider>
        );
      });

      const labelInputs = Array.from(container.querySelectorAll('input[aria-label="Key label"]'));
      const firstLabel = labelInputs[0];
      if (!(firstLabel instanceof HTMLInputElement)) {
        throw new Error('Expected first key label input.');
      }
      await act(async () => {
        setInputValue(firstLabel, 'Renamed');
        firstLabel.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => {
        firstLabel.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      });
      expect(onSave).toHaveBeenLastCalledWith([
        { id: 'key-a', label: 'Renamed', enabled: true },
        { id: 'key-b', label: null, enabled: false }
      ]);

      const switches = Array.from(container.querySelectorAll('input[type="checkbox"]'));
      const secondSwitch = switches[1];
      if (!(secondSwitch instanceof HTMLInputElement)) {
        throw new Error('Expected second enabled switch.');
      }
      await act(async () => {
        secondSwitch.click();
      });
      expect(onSave).toHaveBeenLastCalledWith([
        { id: 'key-a', label: 'Renamed', enabled: true },
        { id: 'key-b', label: null, enabled: true }
      ]);

      const deleteButtons = Array.from(container.querySelectorAll('button[aria-label="Delete key"]'));
      const firstDelete = deleteButtons[0];
      if (!(firstDelete instanceof HTMLButtonElement)) {
        throw new Error('Expected delete key button.');
      }
      await act(async () => {
        firstDelete.click();
      });
      expect(onSave).toHaveBeenLastCalledWith([
        { id: 'key-b', label: null, enabled: false }
      ]);

      onSave.mockClear();
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <ModelApiKeyListEditor
              previews={[
                { id: 'only-key', label: null, enabled: true, preview: 'sk****************************aa' }
              ]}
              onSave={onSave}
            />
          </I18nProvider>
        );
      });
      const clearButton = container.querySelector('button[aria-label="Delete key"]');
      if (!(clearButton instanceof HTMLButtonElement)) {
        throw new Error('Expected clear-by-delete button.');
      }
      await act(async () => {
        clearButton.click();
      });
      expect(onSave).toHaveBeenLastCalledWith([]);
    } finally {
      await unmount(root, container);
      restoreActEnvironment();
    }
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
          state={stateWithSettings()}
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
});

function stateWithSettings(): WorkbenchState {
  return {
    snapshot: undefined,
    titleBarState: unavailableWorkbenchTitleBarState(),
    workbenchPreferences: { locale: 'en', themePreference: 'system' },
    resolvedTheme: 'dark',
    projectOpen: { opening: false },
    explorerSelection: createEmptyProjectTreeSelection(),
    imageModelSettings: {
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
        apiKeyCount: 2,
        enabledApiKeyCount: 1,
        apiKeyPreviews: [
          { id: 'key-a', label: 'Primary', enabled: true, preview: 'sk****************************aa' },
          { id: 'key-b', label: null, enabled: false, preview: 'sk****************************bb' }
        ]
      }]
    },
    videoModelSettings: {
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
        apiKeySet: true,
        apiKeyCount: 2,
        enabledApiKeyCount: 1,
        apiKeyPreviews: [
          { id: 'key-a', label: 'Primary', enabled: true, preview: 'sk****************************aa' },
          { id: 'key-b', label: null, enabled: false, preview: 'sk****************************bb' }
        ]
      }]
    },
    audioModelSettings: {
      models: [{
        debruteModelId: 'audio/openai/gpt-4o-mini-tts',
        kind: 'tts',
        summary: 'OpenAI gpt-4o-mini-tts TTS generation.',
        defaultBaseUrl: 'https://api.openai.com/v1',
        defaultRequestModelId: 'gpt-4o-mini-tts',
        baseUrlOverride: null,
        requestModelIdOverride: null,
        apiKeySet: true,
        apiKeyCount: 2,
        enabledApiKeyCount: 1,
        apiKeyPreviews: [
          { id: 'key-a', label: 'Primary', enabled: true, preview: 'sk****************************aa' },
          { id: 'key-b', label: null, enabled: false, preview: 'sk****************************bb' }
        ]
      }, {
        debruteModelId: 'audio/elevenlabs/music',
        kind: 'music',
        summary: 'ElevenLabs music generation.',
        defaultBaseUrl: 'https://api.elevenlabs.io/v1',
        defaultRequestModelId: 'music',
        baseUrlOverride: null,
        requestModelIdOverride: null,
        apiKeySet: true,
        apiKeyCount: 2,
        enabledApiKeyCount: 1,
        apiKeyPreviews: [
          { id: 'key-a', label: 'Primary', enabled: true, preview: 'sk****************************aa' },
          { id: 'key-b', label: null, enabled: false, preview: 'sk****************************bb' }
        ]
      }, {
        debruteModelId: 'audio/elevenlabs/sfx',
        kind: 'sound-effect',
        summary: 'ElevenLabs sound effects generation.',
        defaultBaseUrl: 'https://api.elevenlabs.io/v1',
        defaultRequestModelId: 'sound-generation',
        baseUrlOverride: null,
        requestModelIdOverride: null,
        apiKeySet: true,
        apiKeyCount: 2,
        enabledApiKeyCount: 1,
        apiKeyPreviews: [
          { id: 'key-a', label: 'Primary', enabled: true, preview: 'sk****************************aa' },
          { id: 'key-b', label: null, enabled: false, preview: 'sk****************************bb' }
        ]
      }]
    },
    integrationsSettings: undefined,
    adobeBridge: undefined,
    canvasFeedback: undefined,
    textFileBuffers: {},
    textEditorWindows: {},
    notifications: []
  };
}

function actions(): WorkbenchActions {
  return {
    getProductState: vi.fn(async () => productState()),
    checkProductUpdate: vi.fn(async () => productState()),
    applyProductUpdate: vi.fn(async () => ({ state: productState() })),
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

async function unmount(root: Root, container: HTMLDivElement): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

function requireButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent === label);
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
