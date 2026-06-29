import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DebruteProductState } from '@debrute/app-protocol';
import type { WorkbenchActions, WorkbenchState } from '../../types';
import { I18nProvider } from '../i18n';
import { ImageModelSettings } from './SettingsPanel';
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
});

function stateWithSettings(): WorkbenchState {
  return {
    snapshot: undefined,
    titleBarState: { available: false },
    workbenchPreferences: { locale: 'en', themePreference: 'system' },
    resolvedTheme: 'dark',
    projectOpen: { opening: false },
    explorerSelection: { selectedPaths: [], focusedPath: undefined, anchorPath: undefined },
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
    getProductState: vi.fn(async () => productState()),
    checkProductUpdate: vi.fn(async () => productState()),
    applyProductUpdate: vi.fn(async () => ({ state: productState() })),
    saveWorkbenchPreferences: vi.fn(async () => undefined),
    saveImageModelSetting: vi.fn(async () => undefined),
    saveVideoModelSetting: vi.fn(async () => undefined)
  } as unknown as WorkbenchActions;
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
