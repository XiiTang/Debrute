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
import { ImageModelSettings, SettingsPanel } from './SettingsPanel';
import { GeneralSettingsPage } from './general/GeneralSettingsPage';

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
    expect(html).toContain('db-secret-field');
    expect(html).not.toContain('settings-model-card');
    expect(html).not.toContain('settings-key-input');
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

  it('opens image and video model settings as separate pages', async () => {
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
        apiKeySet: false
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
        apiKeySet: false
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
    saveVideoModelSetting: vi.fn(async () => undefined)
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
