import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WorkbenchActions, WorkbenchState } from '../../types';
import { ImageModelSettings, LlmSettings } from './SettingsPanel';

describe('SettingsPanel shared UI composition', () => {
  it('renders LLM settings through shared settings patterns and primitives', () => {
    const html = renderToStaticMarkup(
      <LlmSettings
        state={stateWithSettings()}
        actions={actions()}
      />
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
      <ImageModelSettings
        state={stateWithSettings()}
        actions={actions()}
      />
    );

    expect(html).toContain('db-model-card');
    expect(html).toContain('db-model-card__header');
    expect(html).toContain('db-model-card__fields');
    expect(html).toContain('db-secret-field');
    expect(html).not.toContain('settings-model-card');
    expect(html).not.toContain('settings-key-input');
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
