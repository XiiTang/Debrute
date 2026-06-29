import { describe, expect, it } from 'vitest';
import {
  apiKeyPreview,
  createImageModelSettingsView,
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

  it('omits plaintext keys from image and video model settings views', () => {
    const image = createImageModelSettingsView({
      imageModels: [{
        debruteModelId: 'gpt-image-2',
        baseUrlOverride: 'https://images.example.test/v1',
        requestModelIdOverride: null
      }]
    }, {
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
      videoModels: [{
        debruteModelId: 'sora-2',
        baseUrlOverride: 'https://videos.example.test/v1',
        requestModelIdOverride: null
      }]
    }, {
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
      baseUrlOverride: 'https://images.example.test/v1',
      apiKeySet: true,
      apiKeyPreview: 'sk****************************fg'
    });
    expect(video.models[0]).toMatchObject({
      baseUrlOverride: 'https://videos.example.test/v1',
      apiKeySet: true,
      apiKeyPreview: 'sk****************************fg'
    });
    expect(image.models[0] as Record<string, unknown>).not.toHaveProperty('apiKey');
    expect(video.models[0] as Record<string, unknown>).not.toHaveProperty('apiKey');
    expect(JSON.stringify({ image, video })).not.toContain('sk-image-123456fg');
    expect(JSON.stringify({ image, video })).not.toContain('sk-video-123456fg');
  });
});
