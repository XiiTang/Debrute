import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CanvasSettingsPage, SettingsPanel } from '../apps/web/src/workbench/settings/SettingsPanel';
import type { WorkbenchActions, WorkbenchState } from '../apps/web/src/types';

describe('web Settings pages', () => {
  it('uses a directory layout without obsolete desktop CLI or update pages', () => {
    const html = renderToStaticMarkup(React.createElement(SettingsPanel, {
      state: {
        llmSettings: { providers: [], availableModelKeys: [], defaultModelKey: null },
        imageModelSettings: {
          models: [{
            axisModelId: 'gpt-image-2',
            summary: 'Image generation',
            defaultBaseUrl: 'https://api.openai.com/v1',
            defaultRequestModelId: 'gpt-image-2',
            baseUrlOverride: null,
            requestModelIdOverride: null,
            apiKeySet: true
          }, {
            axisModelId: 'missing-image',
            summary: 'Missing configuration',
            defaultBaseUrl: 'https://api.openai.com/v1',
            defaultRequestModelId: 'missing-image',
            baseUrlOverride: null,
            requestModelIdOverride: null,
            apiKeySet: false
          }]
        },
        videoModelSettings: { models: [] },
        canvasSettings: { imagePreviewsEnabled: true }
      } as unknown as WorkbenchState,
      actions: {} as unknown as WorkbenchActions
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
    expect(html).not.toContain('Command install and PATH');
    expect(html).not.toContain('Updates');
    expect(html).toContain('Image Models');
    expect(html).toContain('placeholder="https://api.openai.com/v1"');
    expect(html).toContain('placeholder="gpt-image-2"');
    expect(html).toContain('aria-label="Base URL override"');
    expect(html).toContain('aria-label="Request model ID override"');
    expect(html).toContain('aria-label="API Key"');
    expect(html).toContain('Leave blank to keep existing key');
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

});
