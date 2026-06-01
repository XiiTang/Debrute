import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CanvasSettingsPage, SettingsPanel, UpdatesSettingsPage } from '../apps/desktop/src/workbench/settings/SettingsPanel';
import type { DesktopUpdateState, WorkbenchActions, WorkbenchState } from '../apps/desktop/src/types';

describe('desktop Settings update page', () => {
  it('uses a directory layout with LLM, model, Canvas, integrations, CLI, and update pages', () => {
    const html = renderToStaticMarkup(React.createElement(SettingsPanel, {
      state: {
        updateState: { type: 'idle', currentVersion: '0.1.0' },
        llmSettings: { providers: [], availableModelKeys: [], defaultModelKey: null },
        imageModelSettings: {
          models: [{
            axisModelId: 'gpt-image-2',
            provider: 'openai',
            summary: 'Image generation',
            defaultBaseUrl: 'https://api.openai.com/v1',
            defaultProviderModelId: 'gpt-image-2',
            baseUrlOverride: null,
            providerModelIdOverride: null,
            apiKeySet: true
          }, {
            axisModelId: 'missing-image',
            provider: 'openai',
            summary: 'Missing configuration',
            defaultBaseUrl: 'https://api.openai.com/v1',
            defaultProviderModelId: 'missing-image',
            baseUrlOverride: null,
            providerModelIdOverride: null,
            apiKeySet: false
          }]
        },
        videoModelSettings: { models: [] },
        canvasSettings: { imagePreviewsEnabled: true }
      } as unknown as WorkbenchState,
      actions: {
        updateNow: async () => undefined
      } as unknown as WorkbenchActions
    }));

    expect(html).toContain('settings-directory');
    expect(html).toContain('settings-nav-icon');
    expect(html).toContain('Model routing and provider credentials');
    expect(html).toContain('Generation endpoints and API keys');
    expect(html).toContain('LLM');
    expect(html).toContain('Models');
    expect(html).toContain('Canvas');
    expect(html).toContain('Canvas rendering resources');
    expect(html).toContain('Integrations');
    expect(html).toContain('Optional local capabilities');
    expect(html).toContain('CLI');
    expect(html).toContain('Command install and PATH');
    expect(html).toContain('Updates');
    expect(html).not.toContain('Skills');
    expect(html).not.toContain('AXIS capability packages');
    expect(html).toContain('Image Models');
    expect(html).not.toContain('Image generation');
    expect(html).not.toContain('Missing configuration');
    expect(html).not.toContain('settings-model-check-toggle');
    expect(html).not.toContain('aria-label="Disable gpt-image-2"');
    expect(html).toContain('placeholder="https://api.openai.com/v1"');
    expect(html).toContain('placeholder="gpt-image-2"');
    expect(html).toContain('aria-label="Base URL override"');
    expect(html).toContain('aria-label="Provider Model ID override"');
    expect(html).toContain('aria-label="API Key"');
    expect(html).toContain('Leave blank to keep existing key');
    expect(html).not.toContain('>Edit<');
    expect(html).not.toContain('Save Image Model');
    expect(html).not.toContain('>Save<');
    expect(html).not.toContain('Saving');
    expect(html).not.toContain('Saved');
    expect(html).not.toContain('settings-availability-toggle');
    expect(html).toContain('configured');
    expect(html).toContain('no key');
  });

  it('renders the Canvas image previews toggle', () => {
    const html = renderToStaticMarkup(React.createElement(CanvasSettingsPage, {
      settings: { imagePreviewsEnabled: false },
      onSave: async () => undefined
    }));

    expect(html).toContain('Canvas image previews');
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('checked=""');
  });

  it('renders one update action that is disabled while downloading', () => {
    const state: DesktopUpdateState = {
      type: 'downloading',
      currentVersion: '0.1.0',
      updateVersion: '0.2.0',
      percent: 52
    };
    const html = renderToStaticMarkup(React.createElement(UpdatesSettingsPage, {
      updateState: state,
      onUpdateNow: async () => undefined
    }));

    expect(html).toContain('Current version 0.1.0');
    expect(html).toContain('Downloading update');
    expect(html).toContain('0.2.0');
    expect(html).toContain('更新');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('Download Update');
    expect(html).not.toContain('Restart to Update');
  });
});
