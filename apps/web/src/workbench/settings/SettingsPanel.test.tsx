import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WorkbenchActions, WorkbenchState } from '../../types';
import { I18nProvider } from '../i18n';
import { ImageModelSettings, LlmSettings } from './SettingsPanel';
import { GeneralSettingsPage } from './general/GeneralSettingsPage';

describe('SettingsPanel shared UI composition', () => {
  it('renders LLM settings through shared settings patterns and primitives', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <LlmSettings
          state={stateWithSettings()}
          actions={actions()}
        />
      </I18nProvider>
    );

    expect(html).toContain('db-settings-section');
    expect(html).toContain('db-settings-section__header');
    expect(html).toContain('db-form-grid');
    expect(html).toContain('db-action-row');
    expect(html).toContain('db-card');
    expect(html).toContain('db-field');
    expect(html).toContain('db-input');
    expect(html).toContain('db-select');
    expect(html).not.toContain('settings-actions');
    expect(html).not.toContain('settings-grid');
  });

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

  it('renders the Workbench language preference in General settings', () => {
    const saved: string[] = [];
    const html = renderToStaticMarkup(
      <I18nProvider locale="zh-CN">
        <GeneralSettingsPage
          shell={undefined}
          locale="zh-CN"
          onLocaleChange={(locale) => {
            saved.push(locale);
          }}
        />
      </I18nProvider>
    );

    expect(html).toContain('通用');
    expect(html).toContain('语言');
    expect(html).toContain('简体中文');
    expect(saved).toEqual([]);
  });
});

function stateWithSettings(): WorkbenchState {
  return {
    snapshot: undefined,
    titleBarState: { available: false },
    projectOpen: { opening: false },
    explorerSelection: { selectedPaths: [], focusedPath: undefined, anchorPath: undefined },
    llmSettings: {
      defaultModelKey: null,
      availableModelKeys: ['openai:gpt-4.1'],
      providers: [{
        id: 'openai',
        name: 'OpenAI',
        providerType: 'openai_compat',
        baseUrl: 'https://api.openai.com/v1',
        enabled: true,
        apiKeySet: true,
        apiKeyPreview: 'sk-...',
        modelKeys: ['openai:gpt-4.1']
      }]
    },
    imageModelSettings: {
      models: [{
        debruteModelId: 'image/openai/gpt-image-1',
        provider: 'openai',
        defaultBaseUrl: 'https://api.openai.com/v1',
        defaultRequestModelId: 'gpt-image-1',
        baseUrlOverride: null,
        requestModelIdOverride: null,
        apiKeySet: false,
        apiKeyPreview: null
      }]
    },
    videoModelSettings: { models: [] },
    integrationsSettings: undefined,
    adobeBridge: undefined,
    canvasFeedback: undefined,
    textFileBuffers: {},
    textEditorWindows: {},
    notifications: []
  } as unknown as WorkbenchState;
}

function actions(): WorkbenchActions {
  return {
    saveLlmProviderSetting: vi.fn(async () => undefined),
    deleteLlmProviderSetting: vi.fn(async () => undefined),
    setDefaultLlmModelKey: vi.fn(async () => undefined),
    discoverLlmProviderModels: vi.fn(async () => ({
      supportsDiscovery: false,
      endpoint: 'https://api.openai.com/v1/models',
      models: [],
      modelsCount: 0
    })),
    saveImageModelSetting: vi.fn(async () => undefined),
    saveVideoModelSetting: vi.fn(async () => undefined)
  } as unknown as WorkbenchActions;
}
