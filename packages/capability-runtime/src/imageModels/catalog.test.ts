import { describe, expect, it } from 'vitest';

import { createImageModelCatalog } from './catalog.js';

describe('image model catalog and tools', () => {
  it('restores the full model-keyed image catalog from the reference implementation', () => {
    const catalog = createImageModelCatalog();

    expect(catalog.listAll().map((model) => model.debruteModelId)).toEqual([
      'doubao-seedream-5-0-lite-260128',
      'fal-ai/flux/dev',
      'fal-ai/flux/dev/image-to-image',
      'gemini-3-pro-image-preview',
      'gemini-3.1-flash-image',
      'gemini-3.1-flash-image-preview',
      'gpt-image-1',
      'gpt-image-2',
      'grok-imagine',
      'image-01',
      'wan2.7-image'
    ]);
    expect(catalog.get('gpt-image-2')).toMatchObject({
      debruteModelId: 'gpt-image-2',
      supportsEditing: true,
      supportsTextRendering: true
    });
    expect(catalog.get('wan2.7-image')).toMatchObject({ supportsEditing: true });
  });

  it('defines official routing defaults and original-parameter list summaries for image models', () => {
    const catalog = createImageModelCatalog();
    const models = catalog.listAll();

    for (const model of models) {
      expect(model.defaultBaseUrl).toMatch(/^https:\/\//);
      expect(model.defaultRequestModelId).toEqual(expect.any(String));
      expect(model.defaultRequestModelId.trim()).not.toBe('');
      expect(Object.keys(model.listParameters).length).toBeGreaterThan(0);
      expect(model.listParameters).toHaveProperty('prompt');
    }

    expect(catalog.get('gpt-image-2')).toMatchObject({
      defaultBaseUrl: 'https://api.openai.com/v1',
      defaultRequestModelId: 'gpt-image-2',
      listParameters: {
        prompt: expect.stringContaining('required'),
        size: expect.stringContaining('WIDTHxHEIGHT'),
        image: expect.stringContaining('reference'),
        mask: expect.stringContaining('alpha channel'),
        quality: 'auto|low|medium|high',
        output_format: 'png|jpeg|webp',
        n: '1..10'
      }
    });
    expect(catalog.get('gpt-image-2')?.listParameters.size).toContain('both dimensions divisible by 16');
    expect(catalog.get('gpt-image-2')?.listParameters.size).toContain('aspect ratio between 1:3 and 3:1');
    expect(catalog.get('gpt-image-2')?.listParameters.size).toContain('maximum supported resolution 3840x2160');
    expect(catalog.get('gpt-image-2')?.argumentsSchema.properties).toHaveProperty('image');
    expect(catalog.get('gpt-image-2')?.argumentsSchema.properties).toHaveProperty('mask');

    expect(catalog.get('fal-ai/flux/dev')).toMatchObject({
      defaultBaseUrl: 'https://fal.run',
      defaultRequestModelId: 'fal-ai/flux/dev',
      listParameters: {
        prompt: expect.stringContaining('required'),
        image_size: expect.stringContaining('landscape_4_3'),
        num_images: expect.stringContaining('default 1'),
        output_format: 'jpeg|png'
      }
    });

    expect(catalog.get('fal-ai/flux/dev/image-to-image')).toMatchObject({
      defaultBaseUrl: 'https://fal.run',
      defaultRequestModelId: 'fal-ai/flux/dev/image-to-image',
      listParameters: {
        image_url: expect.stringContaining('required'),
        strength: expect.stringContaining('default 0.95'),
        prompt: expect.stringContaining('required')
      }
    });
    expect(catalog.get('fal-ai/flux/dev/image-to-image')?.argumentsSchema.properties).toHaveProperty('image_url');
  });

  it('keeps list parameter roots present in each model argument schema', () => {
    const catalog = createImageModelCatalog();

    for (const model of catalog.listAll()) {
      const properties = model.argumentsSchema.properties as Record<string, unknown>;
      const schemaKeys = new Set(Object.keys(properties));
      const missing = Object.keys(model.listParameters)
        .map((key) => key.split('.')[0]!)
        .filter((key, index, keys) => !schemaKeys.has(key) && keys.indexOf(key) === index);

      expect(missing, model.debruteModelId).toEqual([]);
    }
  });

  it('lists configured image models in overview mode and details requested models', () => {
    const catalog = createImageModelCatalog();
    const configured = catalog.listConfigured(['gpt-image-2', 'wan2.7-image']);

    const overview = catalog.listOverviews(configured);
    expect(overview.map((model) => model.model)).toEqual(['gpt-image-2', 'wan2.7-image']);

    const detail = catalog.details(['gpt-image-2'], configured);
    expect(detail.details).toHaveLength(1);
    expect(JSON.stringify(detail.details)).toContain('argumentsSchema');

    const unavailable = catalog.details(['missing-model'], configured);
    expect(unavailable.unavailableModels).toEqual(['missing-model']);
  });

  it('describes image inputs as model-scoped direct inputs', () => {
    const catalog = createImageModelCatalog();
    const configured = catalog.listConfigured([
      'doubao-seedream-5-0-lite-260128',
      'fal-ai/flux/dev/image-to-image',
      'gemini-3.1-flash-image-preview',
      'gpt-image-1',
      'gpt-image-2',
      'image-01',
      'wan2.7-image'
    ]);

    const overviewModels = catalog.listOverviews(configured) as Array<Record<string, unknown>>;
    expect(overviewModels.find((model) => model.model === 'gpt-image-2')).toMatchObject({
      supportsImageInputs: true
    });

    const detail = catalog.details([
      'doubao-seedream-5-0-lite-260128',
      'fal-ai/flux/dev/image-to-image',
      'gemini-3.1-flash-image-preview',
      'gpt-image-1',
      'gpt-image-2',
      'image-01',
      'wan2.7-image'
    ], configured);

    const detailModels = detail.details as Array<{
      model: string;
      argumentsSchema: { properties: Record<string, unknown> };
      imageInputRules?: Array<{ field: string; acceptedValueFormat: string }>;
    }>;
    expect(detailModels.find((model) => model.model === 'gpt-image-2')?.imageInputRules).toEqual([
      {
        field: 'image',
        acceptedValueFormat: 'Array of Project-relative image paths, http(s) image URLs, or data:image URLs. Model-specific objects: OpenAI image objects with `image_url` or base64 `data` plus `mime_type`.'
      },
      {
        field: 'mask',
        acceptedValueFormat: 'Project-relative image path, http(s) image URL, or data:image URL. Model-specific objects: OpenAI image objects with `image_url` or base64 `data` plus `mime_type`.'
      }
    ]);
    expect(detailModels.find((model) => model.model === 'doubao-seedream-5-0-lite-260128')?.imageInputRules).toEqual([
      {
        field: 'image',
        acceptedValueFormat: 'Array of Project-relative image paths, http(s) image URLs, or data:image URLs.'
      }
    ]);
    expect(detailModels.find((model) => model.model === 'fal-ai/flux/dev/image-to-image')?.imageInputRules).toEqual([
      {
        field: 'image_url',
        acceptedValueFormat: 'Project-relative image path, http(s) image URL, or data:image URL.'
      }
    ]);
    expect(detailModels.find((model) => model.model === 'image-01')?.imageInputRules).toEqual([
      {
        field: 'subject_reference',
        acceptedValueFormat: 'Array of Project-relative image paths, http(s) image URLs, or data:image URLs. Model-specific objects: MiniMax `subject_reference` objects with `image_file` public URL or data:image URL.'
      }
    ]);
    const doubaoImageSchema = detailModels.find((model) => model.model === 'doubao-seedream-5-0-lite-260128')
      ?.argumentsSchema.properties.image;
    const falImageSchema = detailModels.find((model) => model.model === 'fal-ai/flux/dev/image-to-image')
      ?.argumentsSchema.properties.image_url;
    const wanImageSchema = detailModels.find((model) => model.model === 'wan2.7-image')
      ?.argumentsSchema.properties.image;
    const geminiContentsSchema = detailModels.find((model) => model.model === 'gemini-3.1-flash-image-preview')
      ?.argumentsSchema.properties.contents;
    const gptImage1Schema = detailModels.find((model) => model.model === 'gpt-image-1')
      ?.argumentsSchema.properties.image;
    const gptImageSchema = detailModels.find((model) => model.model === 'gpt-image-2')
      ?.argumentsSchema.properties.image;
    const gptMaskSchema = detailModels.find((model) => model.model === 'gpt-image-2')
      ?.argumentsSchema.properties.mask;
    const minimaxSubjectReferenceSchema = detailModels.find((model) => model.model === 'image-01')
      ?.argumentsSchema.properties.subject_reference;
    expect(doubaoImageSchema).toMatchObject({ items: { type: 'string' } });
    expect(falImageSchema).toMatchObject({ type: 'string' });
    expect(wanImageSchema).toMatchObject({ items: { type: 'string' } });
    expect(gptImage1Schema).toMatchObject({
      items: {
        anyOf: expect.arrayContaining([
          { type: 'string' },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              image_url: { type: 'string', pattern: '^(https?://|data:image/)' },
              data: { type: 'string' },
              mime_type: { type: 'string' }
            },
            anyOf: [
              { required: ['image_url'] },
              { required: ['data', 'mime_type'] }
            ]
          }
        ])
      }
    });
    expect(gptImageSchema).toMatchObject({
      items: {
        anyOf: expect.arrayContaining([
          { type: 'string' },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              image_url: { type: 'string', pattern: '^(https?://|data:image/)' },
              data: { type: 'string' },
              mime_type: { type: 'string' }
            },
            anyOf: [
              { required: ['image_url'] },
              { required: ['data', 'mime_type'] }
            ]
          }
        ])
      }
    });
    expect(gptMaskSchema).toMatchObject({
      anyOf: expect.arrayContaining([
        { type: 'string' },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            image_url: { type: 'string', pattern: '^(https?://|data:image/)' },
            data: { type: 'string' },
            mime_type: { type: 'string' }
          },
          anyOf: [
            { required: ['image_url'] },
            { required: ['data', 'mime_type'] }
          ]
        }
      ])
    });
    expect(geminiContentsSchema).toMatchObject({ type: 'array' });
    expect(minimaxSubjectReferenceSchema).toMatchObject({
      items: {
        anyOf: expect.arrayContaining([
          { type: 'string' },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { const: 'character' },
              image_file: { type: 'string', pattern: '^(https?://|data:image/)' }
            },
            required: ['type', 'image_file']
          }
        ])
      }
    });
    expect(JSON.stringify([gptImage1Schema, gptImageSchema, gptMaskSchema, minimaxSubjectReferenceSchema]))
      .not.toContain('"additionalProperties":true');

    const serialized = JSON.stringify(detail.details);
    expect(serialized).toContain('Project-relative image path');
    expect(serialized).toContain('data:image URL');
  });
});
