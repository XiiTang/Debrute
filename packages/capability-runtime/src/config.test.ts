import { describe, expect, it } from 'vitest';
import {
  apiKeyPreview,
  createAudioModelSettingsView,
  createImageModelSettingsView,
  createVideoModelSettingsView
} from './config.js';

describe('settings secret view contract', { tags: ['settings'] }, () => {
  it('builds fixed-length API key previews without exposing full keys', () => {
    expect(apiKeyPreview('sk-1234567890abcdefg')).toEqual({
      apiKeySet: true,
      apiKeyPreview: 'sk****************************fg'
    });
    expect(apiKeyPreview('  ab123456cd  ')).toEqual({
      apiKeySet: true,
      apiKeyPreview: 'ab****************************cd'
    });
    expect(apiKeyPreview('short')).toEqual({ apiKeySet: true, apiKeyPreview: '****' });
    expect(apiKeyPreview('   ')).toEqual({ apiKeySet: false, apiKeyPreview: null });
    expect(apiKeyPreview(undefined)).toEqual({ apiKeySet: false, apiKeyPreview: null });
  });

  it('projects single-key state without plaintext secrets', () => {
    const image = createImageModelSettingsView({
      imageModels: [{
        debruteModelId: 'gpt-image-2',
        baseUrlOverride: 'https://images.example.test/v1',
        requestModelIdOverride: null
      }]
    }, {
      imageModelApiKeys: { 'gpt-image-2': 'sk-image-123456fg' },
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
      videoModelApiKeys: { 'sora-2': 'sk-video-123456fg' },
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
      audioModelApiKeys: { 'openai-gpt-4o-mini-tts': 'sk-audio-123456fg' }
    }, [{
      debruteModelId: 'openai-gpt-4o-mini-tts',
      kind: 'tts',
      summary: 'TTS generation',
      defaultBaseUrl: 'https://api.openai.com/v1',
      defaultRequestModelId: 'gpt-4o-mini-tts'
    }]);

    expect(image.models[0]).toMatchObject({
      apiKeySet: true,
      apiKeyPreview: 'sk****************************fg'
    });
    expect(video.models[0]).toMatchObject({
      apiKeySet: true,
      apiKeyPreview: 'sk****************************fg'
    });
    expect(audio.models[0]).toMatchObject({
      apiKeySet: true,
      apiKeyPreview: 'sk****************************fg'
    });
    expect(image.models[0] as Record<string, unknown>).not.toHaveProperty('apiKey');
    expect(video.models[0] as Record<string, unknown>).not.toHaveProperty('apiKey');
    expect(audio.models[0] as Record<string, unknown>).not.toHaveProperty('apiKey');
    expect(JSON.stringify({ image, video, audio })).not.toContain('sk-image-123456fg');
    expect(JSON.stringify({ image, video, audio })).not.toContain('sk-video-123456fg');
    expect(JSON.stringify({ image, video, audio })).not.toContain('sk-audio-123456fg');
  });

  it('treats missing and blank keys as not configured', () => {
    const view = createImageModelSettingsView({ imageModels: [] }, {
      imageModelApiKeys: { 'gpt-image-2': '   ' },
      videoModelApiKeys: {},
      audioModelApiKeys: {}
    }, [{
      debruteModelId: 'gpt-image-2',
      summary: 'Image generation',
      supportsEditing: true,
      supportsTextRendering: true,
      defaultBaseUrl: 'https://api.openai.com/v1',
      defaultRequestModelId: 'gpt-image-2'
    }, {
      debruteModelId: 'wan2.7-image',
      summary: 'Wan image generation',
      supportsEditing: false,
      supportsTextRendering: false,
      defaultBaseUrl: 'https://dashscope.aliyuncs.com/api/v1',
      defaultRequestModelId: 'wan2.7-image'
    }]);

    expect(view.models.find((model) => model.debruteModelId === 'gpt-image-2')).toMatchObject({
      apiKeySet: false,
      apiKeyPreview: null
    });
    expect(view.models.find((model) => model.debruteModelId === 'wan2.7-image')).toMatchObject({
      apiKeySet: false,
      apiKeyPreview: null
    });
  });
});
