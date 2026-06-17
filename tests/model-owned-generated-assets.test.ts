import { describe, expect, it } from 'vitest';
import {
  createImageModelCatalog,
  createImageModelSettingsView,
  createVideoModelCatalog,
  createVideoModelSettingsView
} from '@debrute/capability-runtime';
import type { GeneratedAssetRecord } from '@debrute/app-protocol';

describe('model-owned generated asset contracts', () => {
  it('exposes image and video settings without provider-shaped fields', () => {
    const imageEntry = createImageModelCatalog().get('gpt-image-2')!;
    const videoEntry = createVideoModelCatalog().get('doubao-seedance-2-0-260128')!;

    expect(imageEntry).toMatchObject({
      debruteModelId: 'gpt-image-2',
      defaultRequestModelId: 'gpt-image-2'
    });
    expect(videoEntry).toMatchObject({
      debruteModelId: 'doubao-seedance-2-0-260128',
      defaultRequestModelId: 'doubao-seedance-2-0-260128'
    });

    const imageSettings = createImageModelSettingsView(
      { imageModels: [{ debruteModelId: 'gpt-image-2', requestModelIdOverride: 'gpt-image-2-custom' }] },
      { llmProviderApiKeys: {}, imageModelApiKeys: { 'gpt-image-2': 'sk-image' }, videoModelApiKeys: {} },
      [imageEntry]
    );
    const videoSettings = createVideoModelSettingsView(
      { videoModels: [{ debruteModelId: 'doubao-seedance-2-0-260128', requestModelIdOverride: 'seedance-custom' }] },
      { llmProviderApiKeys: {}, imageModelApiKeys: {}, videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
      [videoEntry]
    );

    expect(imageSettings.models[0]).toEqual({
      debruteModelId: 'gpt-image-2',
      summary: expect.any(String),
      supportsEditing: expect.any(Boolean),
      supportsTextRendering: expect.any(Boolean),
      defaultBaseUrl: expect.any(String),
      defaultRequestModelId: 'gpt-image-2',
      requestModelIdOverride: 'gpt-image-2-custom',
      apiKeySet: true,
      apiKey: 'sk-image'
    });
    expect(videoSettings.models[0]).toEqual({
      debruteModelId: 'doubao-seedance-2-0-260128',
      summary: expect.any(String),
      supportsTextToVideo: expect.any(Boolean),
      supportsImageReferences: expect.any(Boolean),
      supportsVideoReferences: expect.any(Boolean),
      supportsAudioReferences: expect.any(Boolean),
      supportsGeneratedAudio: expect.any(Boolean),
      defaultBaseUrl: expect.any(String),
      defaultRequestModelId: 'doubao-seedance-2-0-260128',
      requestModelIdOverride: 'seedance-custom',
      apiKeySet: true,
      apiKey: 'sk-video'
    });
  });

  it('stores generated asset provenance as a model run', () => {
	    const record: GeneratedAssetRecord = {
	      schemaVersion: 1,
	      recordId: 'record-1',
	      projectRelativePath: 'generated/cover.png',
	      createdAt: '2026-06-01T00:00:00.000Z',
      fingerprint: { algorithm: 'sha256', hash: 'a'.repeat(64) },
      modelRun: {
        request: { model: 'gpt-image-2', prompt: 'cover' },
        output: { artifactIndex: 0 }
      }
    };

    expect(record.modelRun.request).toEqual({ model: 'gpt-image-2', prompt: 'cover' });
  });

  it('keeps video model catalog entries model-owned without provider fields', () => {
    for (const entry of createVideoModelCatalog().listAll()) {
      expect(entry).toHaveProperty('debruteModelId');
      expect(entry).not.toHaveProperty('provider');
      expect(entry).not.toHaveProperty('providerType');
      expect(entry.requestExample.input.model).toBe(entry.debruteModelId);
      expect(JSON.stringify(entry.requestExample.input.arguments)).not.toContain('"content"');
    }
  });
});
