import { describe, expect, it } from 'vitest';
import {
  apiKeyPreview,
  createImageModelSettingsView,
  createLlmProviderSettingsView,
  createVideoModelSettingsView
} from '../src/config';

describe('settings secret view contract', () => {
  it('builds fixed-length API key previews without exposing full keys', () => {
    expect(apiKeyPreview('sk-1234567890abcdefg')).toEqual({
      apiKeySet: true,
      apiKeyPreview: 'sk****************************fg'
    });
    expect(apiKeyPreview('  ab123456cd  ')).toEqual({
      apiKeySet: true,
      apiKeyPreview: 'ab****************************cd'
    });
    expect(apiKeyPreview('short')).toEqual({
      apiKeySet: true,
      apiKeyPreview: '****'
    });
    expect(apiKeyPreview('')).toEqual({ apiKeySet: false });
    expect(apiKeyPreview(undefined)).toEqual({ apiKeySet: false });
  });

  it('omits plaintext keys from LLM settings views', () => {
    const view = createLlmProviderSettingsView({
      defaultModelKey: 'openai-main:gpt-5.1',
      providers: [{
        id: 'openai-main',
        name: 'OpenAI Main',
        providerType: 'openai_compat',
        baseUrl: 'https://api.openai.com/v1',
        enabled: true,
        modelIds: ['gpt-5.1']
      }]
    }, {
      llmProviderApiKeys: { 'openai-main': 'sk-llm-123456fg' },
      imageModelApiKeys: {},
      videoModelApiKeys: {}
    });

    expect(view).toMatchObject({
      availableModelKeys: ['openai-main:gpt-5.1'],
      defaultModelKey: 'openai-main:gpt-5.1',
      providers: [{
        id: 'openai-main',
        apiKeySet: true,
        apiKeyPreview: 'sk****************************fg'
      }]
    });
    expect(view.providers[0] as Record<string, unknown>).not.toHaveProperty('apiKey');
    expect(JSON.stringify(view)).not.toContain('sk-llm-123456fg');
  });

  it('omits plaintext keys from image and video model settings views', () => {
    const image = createImageModelSettingsView({
      imageModels: [{ debruteModelId: 'gpt-image-2', requestModelIdOverride: null }]
    }, {
      llmProviderApiKeys: {},
      imageModelApiKeys: { 'gpt-image-2': 'sk-image-123456fg' },
      videoModelApiKeys: {}
    }, [{
      debruteModelId: 'gpt-image-2',
      summary: 'Image generation',
      supportsEditing: true,
      supportsTextRendering: true,
      defaultBaseUrl: 'https://api.openai.com/v1',
      defaultRequestModelId: 'gpt-image-2'
    }]);

    const video = createVideoModelSettingsView({
      videoModels: [{ debruteModelId: 'sora-2', requestModelIdOverride: null }]
    }, {
      llmProviderApiKeys: {},
      imageModelApiKeys: {},
      videoModelApiKeys: { 'sora-2': 'sk-video-123456fg' }
    }, [{
      debruteModelId: 'sora-2',
      summary: 'Video generation',
      supportsTextToVideo: true,
      supportsImageReferences: true,
      supportsVideoReferences: false,
      supportsAudioReferences: false,
      supportsGeneratedAudio: false,
      defaultBaseUrl: 'https://api.openai.com/v1',
      defaultRequestModelId: 'sora-2'
    }]);

    expect(image.models[0]).toMatchObject({
      apiKeySet: true,
      apiKeyPreview: 'sk****************************fg'
    });
    expect(video.models[0]).toMatchObject({
      apiKeySet: true,
      apiKeyPreview: 'sk****************************fg'
    });
    expect(image.models[0] as Record<string, unknown>).not.toHaveProperty('apiKey');
    expect(video.models[0] as Record<string, unknown>).not.toHaveProperty('apiKey');
    expect(JSON.stringify({ image, video })).not.toContain('sk-image-123456fg');
    expect(JSON.stringify({ image, video })).not.toContain('sk-video-123456fg');
  });
});
