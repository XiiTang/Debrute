import { describe, expect, it } from 'vitest';
import {
  apiKeyPreview,
  createAudioModelSettingsView,
  createImageModelSettingsView,
  createVideoModelSettingsView
} from '../src/config';

describe('settings secret view contract', () => {
  it('builds fixed-length API key previews without exposing full keys', () => {
    expect(apiKeyPreview('sk-1234567890abcdefg')).toEqual('sk****************************fg');
    expect(apiKeyPreview('  ab123456cd  ')).toEqual('ab****************************cd');
    expect(apiKeyPreview('short')).toEqual('****');
  });

  it('projects key counts and previews without plaintext secrets', () => {
    const image = createImageModelSettingsView({
      imageModels: [{
        debruteModelId: 'gpt-image-2',
        baseUrlOverride: 'https://images.example.test/v1',
        requestModelIdOverride: null
      }]
    }, {
      imageModelApiKeys: {
        'gpt-image-2': [
          { id: 'img-a', key: 'sk-image-123456fg', label: 'Primary', enabled: true },
          { id: 'img-b', key: 'sk-image-disabled', label: null, enabled: false }
        ]
      },
      videoModelApiKeys: {},
      audioModelApiKeys: {}
    }, [{
      debruteModelId: 'gpt-image-2',
      summary: 'Image generation',
      supportsEditing: true,
      supportsTextRendering: true,
      defaultBaseUrl: 'https://api.openai.com/v1',
      defaultRequestModelId: 'gpt-image-2'
    }]);

    const video = createVideoModelSettingsView({
      videoModels: [{
        debruteModelId: 'sora-2',
        baseUrlOverride: 'https://videos.example.test/v1',
        requestModelIdOverride: null
      }]
    }, {
      imageModelApiKeys: {},
      videoModelApiKeys: {
        'sora-2': [{ id: 'vid-a', key: 'sk-video-123456fg', label: null, enabled: true }]
      },
      audioModelApiKeys: {}
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

    const audio = createAudioModelSettingsView({
      audioModels: [{
        debruteModelId: 'openai-gpt-4o-mini-tts',
        baseUrlOverride: 'https://audio.example.test/v1',
        requestModelIdOverride: null
      }]
    }, {
      imageModelApiKeys: {},
      videoModelApiKeys: {},
      audioModelApiKeys: {
        'openai-gpt-4o-mini-tts': [{ id: 'aud-a', key: 'sk-audio-123456fg', label: 'TTS', enabled: true }]
      }
    }, [{
      debruteModelId: 'openai-gpt-4o-mini-tts',
      kind: 'tts',
      summary: 'TTS generation',
      defaultBaseUrl: 'https://api.openai.com/v1',
      defaultRequestModelId: 'gpt-4o-mini-tts'
    }]);

    expect(image.models[0]).toMatchObject({
      apiKeySet: true,
      apiKeyCount: 2,
      enabledApiKeyCount: 1,
      apiKeyPreviews: [
        { id: 'img-a', label: 'Primary', enabled: true, preview: 'sk****************************fg' },
        { id: 'img-b', label: null, enabled: false, preview: 'sk****************************ed' }
      ]
    });
    expect(video.models[0]).toMatchObject({
      apiKeySet: true,
      apiKeyCount: 1,
      enabledApiKeyCount: 1
    });
    expect(audio.models[0]).toMatchObject({
      apiKeySet: true,
      apiKeyCount: 1,
      enabledApiKeyCount: 1
    });
    expect(image.models[0] as Record<string, unknown>).not.toHaveProperty('apiKey');
    expect(video.models[0] as Record<string, unknown>).not.toHaveProperty('apiKey');
    expect(audio.models[0] as Record<string, unknown>).not.toHaveProperty('apiKey');
    expect(JSON.stringify({ image, video, audio })).not.toContain('sk-image-123456fg');
    expect(JSON.stringify({ image, video, audio })).not.toContain('sk-video-123456fg');
    expect(JSON.stringify({ image, video, audio })).not.toContain('sk-audio-123456fg');
  });

  it('requires at least one enabled key for apiKeySet', () => {
    const view = createImageModelSettingsView({ imageModels: [] }, {
      imageModelApiKeys: {
        'gpt-image-2': [{ id: 'disabled', key: 'sk-disabled', label: null, enabled: false }]
      },
      videoModelApiKeys: {},
      audioModelApiKeys: {}
    }, [{
      debruteModelId: 'gpt-image-2',
      summary: 'Image generation',
      supportsEditing: true,
      supportsTextRendering: true,
      defaultBaseUrl: 'https://api.openai.com/v1',
      defaultRequestModelId: 'gpt-image-2'
    }]);

    expect(view.models[0]).toMatchObject({
      apiKeySet: false,
      apiKeyCount: 1,
      enabledApiKeyCount: 0
    });
  });
});
