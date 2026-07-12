import { describe, expect, it } from 'vitest';

import { createVideoModelCatalog } from './catalog.js';

describe('video model catalog and tools', () => {
  it('starts with only Seedance 2.0 video models', () => {
    const catalog = createVideoModelCatalog();

    expect(catalog.listAll().map((model) => model.debruteModelId)).toEqual([
      'doubao-seedance-2-0-260128',
      'doubao-seedance-2-0-fast-260128'
    ]);
    expect(catalog.get('doubao-seedance-2-0-fast-260128')).toMatchObject({
      supportsGeneratedAudio: true,
      capabilities: expect.objectContaining({ resolutions: ['480p', '720p'] })
    });
  });

  it('defines official routing defaults for video models', () => {
    const catalog = createVideoModelCatalog();

    for (const model of catalog.listAll()) {
      expect(model.defaultBaseUrl).toBe('https://ark.cn-beijing.volces.com/api/v3');
      expect(model.defaultRequestModelId).toBe(model.debruteModelId);
    }
  });

  it('lists configured video models in overview mode and details requested models', () => {
    const catalog = createVideoModelCatalog();
    const configured = catalog.listConfigured(['doubao-seedance-2-0-260128']);

    const overview = catalog.listOverviews(configured);
    expect(overview.map((model) => model.model)).toEqual(['doubao-seedance-2-0-260128']);

    const detail = catalog.details(['doubao-seedance-2-0-260128'], configured);
    expect(detail.details).toHaveLength(1);
    expect(detail.details[0]?.argumentsSchema).toMatchObject({
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: expect.objectContaining({ type: 'string' }),
        intent: expect.objectContaining({ enum: ['generate', 'reference', 'audio_driven', 'extend', 'edit'] }),
        references: expect.objectContaining({ type: 'array' })
      }
    });
    expect(JSON.stringify(detail.details[0])).not.toContain('"content"');
    expect(detail.details[0]?.requestExample.input.arguments).toMatchObject({
      prompt: expect.any(String),
      intent: 'generate'
    });

    const unavailable = catalog.details(['missing-model'], configured);
    expect(unavailable.unavailableModels).toEqual(['missing-model']);
  });
});
