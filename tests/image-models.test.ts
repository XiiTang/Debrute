import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  createImageModelCatalog,
  executeImageModelRequest as executeImageModelRequestBase,
  type ExecuteImageModelRequestInput,
  type ImageModelFetch,
  type PublicRemoteHostLookup,
  type PublicRemoteHttpTransport
} from '@debrute/capability-runtime';

const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8AARQAHSQGmK3P7WAAAAABJRU5ErkJggg==';
const tinyPng = Buffer.from(tinyPngBase64, 'base64');
const publicRemoteLookup: PublicRemoteHostLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const privateRemoteLookup: PublicRemoteHostLookup = async () => [{ address: '169.254.169.254', family: 4 }];

function executeImageModelRequest(input: ExecuteImageModelRequestInput) {
  const fetchImpl = input.fetch;
  const remoteHttpTransport: PublicRemoteHttpTransport | undefined = input.remoteHttpTransport
    ?? (fetchImpl
      ? ({ url, method, headers, signal }) => fetchImpl(url, { method, headers, signal })
      : undefined);
  return executeImageModelRequestBase({
    remoteUrlLookup: publicRemoteLookup,
    ...input,
    ...(remoteHttpTransport ? { remoteHttpTransport } : {})
  });
}

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

  it('lists configured image models in overview mode and details requested models', async () => {
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

  it('describes image inputs as model-scoped direct inputs', async () => {
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

describe('image model executors', () => {
  it('passes wan local reference images to upstream without local rewriting', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-wan-reference-pass-through-'));
    let requestBody: Record<string, unknown> | undefined;
    const wideImage = await sharp({
      create: {
        width: 9000,
        height: 100,
        channels: 3,
        background: { r: 240, g: 240, b: 240 }
      }
    }).jpeg().toBuffer();
    const fetch: ImageModelFetch = async (url, init) => {
      if (url === 'https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation') {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ output: { task_id: 'task-1' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === 'https://dashscope.aliyuncs.com/api/v1/tasks/task-1') {
        return new Response(JSON.stringify({ output: { task_status: 'SUCCEEDED', choices: [{ message: { content: [{ image: 'https://cdn.example/out.png' }] } }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(tinyPng, { status: 200, headers: { 'content-type': 'image/png' } });
    };

    try {
      await writeFile(join(projectRoot, 'wide.jpg'), wideImage);
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-wan-autofix',
        input: { model: 'wan2.7-image', arguments: { prompt: 'use this', image: ['wide.jpg'] } },
        settings: { imageModels: [{ debruteModelId: 'wan2.7-image', baseUrlOverride: null, requestModelIdOverride: 'wan2.7-image' }] },
        secrets: { imageModelApiKeys: { 'wan2.7-image': 'sk-image' } },
        fetch,
        pollIntervalMs: 0
      });

      expect(result.status).toBe('ok');
      const content = ((requestBody?.input as Record<string, unknown>).messages as Array<Record<string, unknown>>)[0]!.content as Array<Record<string, string>>;
      const image = content.find((item) => typeof item.image === 'string')!.image;
      expect(Buffer.from(image.split(',', 2)[1]!, 'base64')).toEqual(wideImage);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects unsupported local reference image types before upstream image requests', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-wan-reference-type-reject-'));
    let modelRuns = 0;
    try {
      await writeFile(join(projectRoot, 'source.gif'), Buffer.from('GIF89a'));
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-wan-type',
        input: { model: 'wan2.7-image', arguments: { prompt: 'use this', image: ['source.gif'] } },
        settings: { imageModels: [{ debruteModelId: 'wan2.7-image', baseUrlOverride: null, requestModelIdOverride: 'wan2.7-image' }] },
        secrets: { imageModelApiKeys: { 'wan2.7-image': 'sk-image' } },
        fetch: async () => {
          modelRuns += 1;
          throw new Error('upstream request should not run for unsupported local image types');
        },
        pollIntervalMs: 0
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('invalid_image_input');
      expect(result.content).toContain('Unsupported Debrute project image reference: source.gif');
      expect(modelRuns).toBe(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('uses catalog defaults when an image model has only an API key configured', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-default-route-'));
    try {
      const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
      const fetch: ImageModelFetch = async (url, init) => {
        calls.push({ url, body: JSON.parse(String(init?.body)) });
        return jsonResponse({ data: [{ b64_json: tinyPngBase64 }] });
      };

      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-default-route',
        input: { model: 'gpt-image-2', arguments: { prompt: 'cover image' } },
        settings: { imageModels: [] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        fetch
      });

      expect(result.status).toBe('ok');
      expect(calls).toEqual([{
        url: 'https://api.openai.com/v1/images/generations',
        body: { model: 'gpt-image-2', prompt: 'cover image' }
      }]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('uses configured base URL overrides for image model requests', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-url-override-'));
    try {
      const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
      const fetch: ImageModelFetch = async (url, init) => {
        calls.push({ url, body: JSON.parse(String(init?.body)) });
        return jsonResponse({ data: [{ b64_json: tinyPngBase64 }] });
      };

      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-url-override',
        input: { model: 'gpt-image-2', arguments: { prompt: 'cover image' } },
        settings: {
          imageModels: [{
            debruteModelId: 'gpt-image-2',
            baseUrlOverride: 'https://images.example.test/v1',
            requestModelIdOverride: null
          }]
        },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        fetch
      });

      expect(result.status).toBe('ok');
      expect(calls).toEqual([{
        url: 'https://images.example.test/v1/images/generations',
        body: { model: 'gpt-image-2', prompt: 'cover image' }
      }]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps Gemini prompts when contents include model-specific image parts', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-gemini-contents-prompt-'));
    try {
      let submittedBody: Record<string, unknown> | undefined;
      const fetch: ImageModelFetch = async (_url, init) => {
        submittedBody = JSON.parse(String(init?.body));
        return jsonResponse({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: tinyPngBase64 } }] } }]
        });
      };

      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-gemini-contents-prompt',
        input: {
          model: 'gemini-3.1-flash-image-preview',
          arguments: {
            prompt: 'Make the subject red',
            contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: tinyPngBase64 } }] }]
          }
        },
        settings: { imageModels: [] },
        secrets: { imageModelApiKeys: { 'gemini-3.1-flash-image-preview': 'sk-gemini' } },
        fetch
      });

      expect(result.status).toBe('ok');
      expect(submittedBody?.contents).toEqual([{
        role: 'user',
        parts: [
          { text: 'Make the subject red' },
          { inlineData: { mimeType: 'image/png', data: tinyPngBase64 } }
        ]
      }]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('normalizes Gemini local fileData fileUri values into inlineData parts', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-gemini-local-contents-'));
    try {
      await writeFile(join(projectRoot, 'source.png'), tinyPng);
      let submittedBody: Record<string, unknown> | undefined;
      const fetch: ImageModelFetch = async (_url, init) => {
        submittedBody = JSON.parse(String(init?.body));
        return jsonResponse({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: tinyPngBase64 } }] } }]
        });
      };

      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-gemini-local-contents',
        input: {
          model: 'gemini-3.1-flash-image-preview',
          arguments: {
            prompt: 'Use this reference',
            contents: [{ role: 'user', parts: [{ fileData: { fileUri: 'source.png' } }] }]
          }
        },
        settings: { imageModels: [] },
        secrets: { imageModelApiKeys: { 'gemini-3.1-flash-image-preview': 'sk-gemini' } },
        fetch
      });

      expect(result.status).toBe('ok');
      expect(submittedBody?.contents).toEqual([{
        role: 'user',
        parts: [
          { text: 'Use this reference' },
          { inlineData: { mimeType: 'image/png', data: tinyPngBase64 } }
        ]
      }]);
      expect(JSON.stringify(submittedBody)).not.toContain('source.png');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('uses registry MIME types for Gemini local fileData parts instead of caller MIME overrides', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-gemini-local-registry-mime-'));
    try {
      await writeFile(join(projectRoot, 'source.png'), tinyPng);
      let submittedBody: Record<string, unknown> | undefined;
      const fetch: ImageModelFetch = async (_url, init) => {
        submittedBody = JSON.parse(String(init?.body));
        return jsonResponse({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: tinyPngBase64 } }] } }]
        });
      };

      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-gemini-local-registry-mime',
        input: {
          model: 'gemini-3.1-flash-image-preview',
          arguments: {
            prompt: 'Use this reference',
            contents: [{ role: 'user', parts: [{ fileData: { fileUri: 'source.png', mimeType: 'image/gif' } }] }]
          }
        },
        settings: { imageModels: [] },
        secrets: { imageModelApiKeys: { 'gemini-3.1-flash-image-preview': 'sk-gemini' } },
        fetch
      });

      expect(result.status).toBe('ok');
      expect(submittedBody?.contents).toEqual([{
        role: 'user',
        parts: [
          { text: 'Use this reference' },
          { inlineData: { mimeType: 'image/png', data: tinyPngBase64 } }
        ]
      }]);
      expect(JSON.stringify(submittedBody)).not.toContain('image/gif');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('uses registry MIME types for Gemini remote fileData parts instead of caller MIME overrides', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-gemini-remote-registry-mime-'));
    try {
      let submittedBody: Record<string, unknown> | undefined;
      const fetch: ImageModelFetch = async (_url, init) => {
        submittedBody = JSON.parse(String(init?.body));
        return jsonResponse({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: tinyPngBase64 } }] } }]
        });
      };

      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-gemini-remote-registry-mime',
        input: {
          model: 'gemini-3.1-flash-image-preview',
          arguments: {
            prompt: 'Use these references',
            contents: [{
              role: 'user',
              parts: [
                { fileData: { fileUri: 'https://cdn.example/source.avif?token=SIGNED', mimeType: 'image/gif' } },
                { fileData: { fileUri: 'https://cdn.example/icon.svgz' } }
              ]
            }]
          }
        },
        settings: { imageModels: [] },
        secrets: { imageModelApiKeys: { 'gemini-3.1-flash-image-preview': 'sk-gemini' } },
        fetch
      });

      expect(result.status).toBe('ok');
      expect(submittedBody?.contents).toEqual([{
        role: 'user',
        parts: [
          { text: 'Use these references' },
          { fileData: { fileUri: 'https://cdn.example/source.avif?token=SIGNED', mimeType: 'image/avif' } },
          { fileData: { fileUri: 'https://cdn.example/icon.svgz', mimeType: 'image/svg+xml' } }
        ]
      }]);
      expect(JSON.stringify(submittedBody)).not.toContain('image/gif');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('writes OpenAI image artifacts into generated/<turn-id>', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-openai-'));
    const fetch: ImageModelFetch = async (url, init) => {
      expect(url).toBe('https://api.openai.com/v1/images/generations');
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'gpt-image-2', prompt: 'cover image' });
      return jsonResponse({ data: [{ b64_json: tinyPngBase64 }] });
    };
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-1',
        input: { model: 'gpt-image-2', arguments: { prompt: 'cover image', size: '1024x1024' } },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: 'gpt-image-2' }] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        fetch
      });

      expect(result.status).toBe('ok');
      expect(result.artifacts[0]).toMatchObject({
        projectRelativePath: expect.stringMatching(/^generated\/turn-1\/.+\.png$/),
        mimeType: 'image/png',
        width: 1,
        height: 1
      });
      await expect(readFile(join(projectRoot, result.artifacts[0].projectRelativePath))).resolves.toBeInstanceOf(Buffer);
      expect(JSON.stringify(result.logs)).not.toContain('sk-image');
      expect(JSON.stringify(result.logs)).not.toContain(tinyPngBase64);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('stores supported generated image URL path MIME types with registry extensions', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-artifact-registry-extension-'));
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-artifact-avif',
        input: { model: 'wan2.7-image', arguments: { prompt: 'make an icon' } },
        settings: { imageModels: [{ debruteModelId: 'wan2.7-image', baseUrlOverride: null, requestModelIdOverride: 'wan2.7-image' }] },
        secrets: { imageModelApiKeys: { 'wan2.7-image': 'sk-image' } },
        fetch: async (url) => {
          if (url === 'https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation') {
            return jsonResponse({ output: { task_id: 'task-avif' } });
          }
          if (url === 'https://dashscope.aliyuncs.com/api/v1/tasks/task-avif') {
            return jsonResponse({ output: { task_status: 'SUCCEEDED', choices: [{ message: { content: [{ image: 'https://cdn.example/out.avif?token=SIGNED' }] } }] } });
          }
          expect(url).toBe('https://cdn.example/out.avif?token=SIGNED');
          return new Response(await imageFixture({ width: 12, height: 10, channels: 4, alpha: 1, format: 'avif' }), {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' }
          });
        },
        pollIntervalMs: 0
      });

      expect(result.status).toBe('ok');
      expect(result.artifacts[0]).toMatchObject({
        projectRelativePath: expect.stringMatching(/^generated\/turn-artifact-avif\/.+\.avif$/),
        mimeType: 'image/avif'
      });
      await expect(readFile(join(projectRoot, result.artifacts[0].projectRelativePath))).resolves.toBeInstanceOf(Buffer);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('records compact model request and output metadata for generated OpenAI images', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-metadata-'));
    const recorded: unknown[] = [];
    const fetch: ImageModelFetch = async (url) => {
      expect(url).toBe('https://api.openai.com/v1/images/generations');
      return jsonResponse({ data: [{ b64_json: tinyPngBase64, revised_prompt: 'refined cover' }] });
    };
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-metadata',
        input: { model: 'gpt-image-2', arguments: { prompt: 'cover image', size: '1024x1024' } },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: 'gpt-image-2' }] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        fetch,
        recordGeneratedAsset: async (input) => {
          recorded.push(input);
        }
      });

      expect(result.status).toBe('ok');
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        modelRunId: expect.any(String),
        projectRelativePath: expect.stringMatching(/^generated\/turn-metadata\/.+\.png$/),
        artifactRole: 'primary-image',
        artifactIndex: 0,
        modelRun: {
          request: {
            method: 'POST',
            url: 'https://api.openai.com/v1/images/generations',
            headers: expect.objectContaining({ authorization: '[redacted]' }),
            body: { model: 'gpt-image-2', prompt: 'cover image', size: '1024x1024' }
          },
          output: {
            responses: [expect.objectContaining({
              status: 200,
              body: {
                data: [{
                  b64_json: {
                    omitted: 'base64_image',
                    encoding: 'base64',
                    chars: tinyPngBase64.length,
                    estimatedBytes: tinyPng.length,
                    mimeType: 'image/png'
                  },
                  revised_prompt: 'refined cover'
                }]
              }
            })],
            parsed: { revised_prompts: ['refined cover'] },
            artifactIndex: 0
          }
        }
      });
      expect(JSON.stringify(recorded[0])).not.toContain(tinyPngBase64);
      expect(JSON.stringify(recorded[0])).not.toContain('sk-image');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('records complete multipart model request metadata for OpenAI edits', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-edit-metadata-'));
    const recorded: unknown[] = [];
    const fetch: ImageModelFetch = async (url, init) => {
      expect(url).toBe('https://api.openai.com/v1/images/edits');
      expect(init?.body).toBeInstanceOf(FormData);
      return jsonResponse({ data: [{ b64_json: tinyPngBase64 }] });
    };
    try {
      await writeFile(join(projectRoot, 'source.png'), tinyPng);
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-edit-metadata',
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'retouch the image',
            size: '1024x1024',
            image: ['source.png']
          }
        },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: 'gpt-image-2' }] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        fetch,
        recordGeneratedAsset: async (input) => {
          recorded.push(input);
        }
      });

      expect(result.status).toBe('ok');
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        modelRunId: expect.any(String),
        projectRelativePath: expect.stringMatching(/^generated\/turn-edit-metadata\/.+\.png$/),
        artifactRole: 'primary-image',
        artifactIndex: 0,
        modelRun: {
          request: {
            method: 'POST',
            url: 'https://api.openai.com/v1/images/edits',
            headers: expect.objectContaining({ authorization: '[redacted]' }),
            body: {
              fields: {
                model: 'gpt-image-2',
                prompt: 'retouch the image',
                size: '1024x1024'
              },
              files: [
                {
                  field: 'image[]',
                  filename: 'image-0.png',
                  mimeType: 'image/png',
                  source: {
                    kind: 'project-file',
                    projectRelativePath: 'source.png',
                    bytes: tinyPng.length
                  }
                }
              ]
            }
          }
        }
      });
      expect(JSON.stringify(recorded[0])).not.toContain(tinyPngBase64);
      expect(JSON.stringify(recorded[0])).not.toContain('sk-image');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('includes a project mask when an OpenAI edit input image is remote', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-openai-remote-input-local-mask-'));
    const downloaded: string[] = [];
    let modelRuns = 0;
    const fetch: ImageModelFetch = async (url, init) => {
      if (url === 'https://cdn.example/source.png') {
        downloaded.push(url);
        return pngResponse();
      }
      expect(url).toBe('https://api.openai.com/v1/images/edits');
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      expect(form.getAll('image[]')).toHaveLength(1);
      expect(form.get('mask')).toBeInstanceOf(Blob);
      modelRuns += 1;
      return jsonResponse({ data: [{ b64_json: tinyPngBase64 }] });
    };
    try {
      await writeFile(join(projectRoot, 'mask.png'), tinyPng);
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-openai-remote-input-local-mask',
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'retouch the image',
            image: ['https://cdn.example/source.png'],
            mask: 'mask.png'
          }
        },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: 'gpt-image-2' }] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        fetch
      });

      expect(result.status).toBe('ok');
      expect(downloaded).toEqual(['https://cdn.example/source.png']);
      expect(modelRuns).toBe(1);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('passes OpenAI local edit masks to upstream without physical validation', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-openai-mask-pass-through-'));
    let modelRuns = 0;
    try {
      await writeFile(join(projectRoot, 'source.png'), await imageFixture({ width: 16, height: 16, channels: 4, alpha: 1 }));
      await writeFile(join(projectRoot, 'mask.png'), await imageFixture({ width: 8, height: 8, channels: 3 }));
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-openai-mask-pass-through',
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'retouch the image',
            image: ['source.png'],
            mask: 'mask.png'
          }
        },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: 'gpt-image-2' }] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        fetch: async (url, init) => {
          expect(url).toBe('https://api.openai.com/v1/images/edits');
          expect(init?.body).toBeInstanceOf(FormData);
          modelRuns += 1;
          return jsonResponse({ data: [{ b64_json: tinyPngBase64 }] });
        }
      });

      expect(result.status).toBe('ok');
      expect(modelRuns).toBe(1);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('passes supported project image aliases to OpenAI edits with registry MIME types', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-openai-registry-inputs-'));
    try {
      await writeFile(join(projectRoot, 'source.avif'), await imageFixture({ width: 16, height: 16, channels: 4, alpha: 1, format: 'avif' }));
      await writeFile(join(projectRoot, 'mask.jfif'), await imageFixture({ width: 16, height: 16, channels: 3, format: 'jpeg' }));
      const seenFiles: Array<{ name: string; type: string }> = [];

      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-openai-registry-inputs',
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'retouch the image',
            image: ['source.avif'],
            mask: 'mask.jfif'
          }
        },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: 'gpt-image-2' }] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        fetch: async (url, init) => {
          expect(url).toBe('https://api.openai.com/v1/images/edits');
          expect(init?.body).toBeInstanceOf(FormData);
          for (const [_key, value] of (init!.body as FormData).entries()) {
            if (value instanceof File) {
              seenFiles.push({ name: value.name, type: value.type });
            }
          }
          return jsonResponse({ data: [{ b64_json: tinyPngBase64 }] });
        }
      });

      expect(result.status).toBe('ok');
      expect(seenFiles).toEqual([
        { name: 'image-0.avif', type: 'image/avif' },
        { name: 'mask.jpg', type: 'image/jpeg' }
      ]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('passes OpenAI object data edit masks to upstream without physical validation', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-openai-mask-data-pass-through-'));
    let modelRuns = 0;
    try {
      const image = await imageFixture({ width: 16, height: 16, channels: 4, alpha: 1 });
      const mask = await imageFixture({ width: 16, height: 16, channels: 4, alpha: 0.5, format: 'webp' });
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-openai-mask-data-validation',
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'retouch the image',
            image: [{ data: image.toString('base64'), mime_type: 'image/png' }],
            mask: { data: mask.toString('base64'), mime_type: 'image/webp' }
          }
        },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: 'gpt-image-2' }] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        fetch: async (url, init) => {
          expect(url).toBe('https://api.openai.com/v1/images/edits');
          expect(init?.body).toBeInstanceOf(FormData);
          modelRuns += 1;
          return jsonResponse({ data: [{ b64_json: tinyPngBase64 }] });
        }
      });

      expect(result.status).toBe('ok');
      expect(modelRuns).toBe(1);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects OpenAI raw object data image inputs without declared registry MIME types', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-openai-raw-data-missing-mime-'));
    let modelRuned = false;
    const fetch: ImageModelFetch = async () => {
      modelRuned = true;
      throw new Error('model fetch should not be called for raw image data without MIME types');
    };
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-openai-raw-data-missing-mime',
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'retouch the image',
            image: [{ data: tinyPngBase64 }]
          }
        },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: 'gpt-image-2' }] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        fetch
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('invalid_image_input');
      expect(result.content).toBe('Raw image data objects must include a registry-supported mime_type.');
      expect(modelRuned).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('includes a remote mask when an OpenAI edit input image is a project file', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-openai-local-input-remote-mask-'));
    const downloaded: string[] = [];
    let modelRuns = 0;
    const fetch: ImageModelFetch = async (url, init) => {
      if (url === 'https://cdn.example/mask.png') {
        downloaded.push(url);
        return pngResponse();
      }
      expect(url).toBe('https://api.openai.com/v1/images/edits');
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      expect(form.getAll('image[]')).toHaveLength(1);
      expect(form.get('mask')).toBeInstanceOf(Blob);
      modelRuns += 1;
      return jsonResponse({ data: [{ b64_json: tinyPngBase64 }] });
    };
    try {
      await writeFile(join(projectRoot, 'source.png'), tinyPng);
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-openai-local-input-remote-mask',
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'retouch the image',
            image: ['source.png'],
            mask: 'https://cdn.example/mask.png'
          }
        },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: 'gpt-image-2' }] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        fetch
      });

      expect(result.status).toBe('ok');
      expect(downloaded).toEqual(['https://cdn.example/mask.png']);
      expect(modelRuns).toBe(1);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects loopback OpenAI edit image URLs before external fetches', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-openai-loopback-input-'));
    const fetched: string[] = [];
    const fetch: ImageModelFetch = async (url) => {
      fetched.push(url);
      if (url === 'http://127.0.0.1/private.png') {
        return pngResponse();
      }
      return jsonResponse({ data: [{ b64_json: tinyPngBase64 }] });
    };
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-openai-loopback-input',
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'retouch the image',
            image: ['http://127.0.0.1/private.png']
          }
        },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: 'gpt-image-2' }] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        fetch
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('invalid_image_input');
      expect(result.content).toBe('Remote image URLs must not target local or private network hosts: http://127.0.0.1/private.png');
      expect(fetched).toEqual([]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects bracketed IPv6 OpenAI image URLs before external fetches', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-openai-ipv6-input-'));
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-openai-ipv6-input',
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'use this reference',
            image: ['http://[::1]/private.png']
          }
        },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: null }] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        fetch: async () => {
          throw new Error('external fetch should not run for unsafe reference URLs');
        }
      });

      expect(result.status).toBe('error');
      expect(result.content).toContain('Remote image URLs must not target local or private network hosts');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects DNS-resolved private OpenAI image URLs before external fetches', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-openai-dns-private-input-'));
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-openai-dns-private-input',
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'use this reference',
            image: ['https://private.example/reference.png']
          }
        },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: null }] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        fetch: async () => {
          throw new Error('external fetch should not run for unsafe reference URLs');
        },
        remoteUrlLookup: privateRemoteLookup
      });

      expect(result.status).toBe('error');
      expect(result.content).toContain('Remote image URLs must not target local or private network hosts');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects loopback OpenAI object image URLs before upstream requests', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-openai-object-loopback-input-'));
    let modelRuned = false;
    const fetch: ImageModelFetch = async () => {
      modelRuned = true;
      throw new Error('model fetch should not be called for unsafe object image URLs');
    };
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-openai-object-loopback-input',
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'retouch the image',
            image: [{ image_url: 'http://127.0.0.1/private.png' }]
          }
        },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: 'gpt-image-2' }] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        fetch
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('invalid_image_input');
      expect(result.content).toBe('Remote image URLs must not target local or private network hosts: http://127.0.0.1/private.png');
      expect(modelRuned).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('validates data:image MIME types against the project image registry', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-data-url-registry-'));
    let acceptedRuns = 0;
    try {
      const accepted = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-image-data-url-avif',
        input: {
          model: 'wan2.7-image',
          arguments: { prompt: 'use this', image: [`data:image/avif;base64,${tinyPngBase64}`] }
        },
        settings: { imageModels: [{ debruteModelId: 'wan2.7-image', baseUrlOverride: null, requestModelIdOverride: 'wan2.7-image' }] },
        secrets: { imageModelApiKeys: { 'wan2.7-image': 'sk-image' } },
        fetch: async (url) => {
          if (url === 'https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation') {
            acceptedRuns += 1;
            return jsonResponse({ output: { task_id: 'task-1' } });
          }
          if (url === 'https://dashscope.aliyuncs.com/api/v1/tasks/task-1') {
            return jsonResponse({ output: { task_status: 'SUCCEEDED', choices: [{ message: { content: [{ image: 'https://cdn.example/out.png' }] } }] } });
          }
          return pngResponse();
        },
        pollIntervalMs: 0
      });

      expect(accepted.status).toBe('ok');
      expect(acceptedRuns).toBe(1);

      const rejected = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-image-data-url-gif',
        input: {
          model: 'wan2.7-image',
          arguments: { prompt: 'use this', image: [`data:image/gif;base64,${tinyPngBase64}`] }
        },
        settings: { imageModels: [{ debruteModelId: 'wan2.7-image', baseUrlOverride: null, requestModelIdOverride: 'wan2.7-image' }] },
        secrets: { imageModelApiKeys: { 'wan2.7-image': 'sk-image' } },
        fetch: async () => {
          throw new Error('upstream request should not run for unsupported data image types');
        },
        pollIntervalMs: 0
      });

      expect(rejected.status).toBe('error');
      expect(rejected.error).toBe('invalid_image_input');
      expect(rejected.content).toContain('Unsupported Debrute project image data URL MIME type: image/gif');

      const objectRejected = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-image-object-data-url-gif',
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'use this',
            image: [{ image_url: `data:image/gif;base64,${tinyPngBase64}` }]
          }
        },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: 'gpt-image-2' }] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        fetch: async () => {
          throw new Error('upstream request should not run for unsupported object data image types');
        }
      });

      expect(objectRejected.status).toBe('error');
      expect(objectRejected.error).toBe('invalid_image_input');
      expect(objectRejected.content).toContain('Unsupported Debrute project image data URL MIME type: image/gif');

      const rawObjectRejected = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-image-object-raw-gif',
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'use this',
            image: [{ data: tinyPngBase64, mime_type: 'image/gif' }]
          }
        },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: 'gpt-image-2' }] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        fetch: async () => {
          throw new Error('upstream request should not run for unsupported raw object image types');
        }
      });

      expect(rawObjectRejected.status).toBe('error');
      expect(rawObjectRejected.error).toBe('invalid_image_input');
      expect(rawObjectRejected.content).toContain('Unsupported Debrute project image MIME type: image/gif');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects unsupported remote image URL paths through the project image registry', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-url-registry-'));
    try {
      const rejected = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-image-url-gif',
        input: {
          model: 'wan2.7-image',
          arguments: { prompt: 'use this', image: ['https://cdn.example/source.gif'] }
        },
        settings: { imageModels: [{ debruteModelId: 'wan2.7-image', baseUrlOverride: null, requestModelIdOverride: 'wan2.7-image' }] },
        secrets: { imageModelApiKeys: { 'wan2.7-image': 'sk-image' } },
        fetch: async () => {
          throw new Error('upstream request should not run for unsupported image URL paths');
        },
        pollIntervalMs: 0
      });

      expect(rejected.status).toBe('error');
      expect(rejected.error).toBe('invalid_image_input');
      expect(rejected.content).toBe('Unsupported Debrute project image URL reference: https://cdn.example/source.gif');

      const objectRejected = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-image-object-url-gif',
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'use this',
            image: [{ image_url: 'https://cdn.example/source.gif' }]
          }
        },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: 'gpt-image-2' }] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        fetch: async () => {
          throw new Error('upstream request should not run for unsupported object image URL paths');
        }
      });

      expect(objectRejected.status).toBe('error');
      expect(objectRejected.error).toBe('invalid_image_input');
      expect(objectRejected.content).toBe('Unsupported Debrute project image URL reference: https://cdn.example/source.gif');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns direct image input errors for missing project image paths', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-missing-input-'));
    const fetch: ImageModelFetch = async () => {
      throw new Error('model fetch should not be called for missing image inputs');
    };
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-missing-image-input',
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'retouch the image',
            image: ['missing/source.png']
          }
        },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: 'gpt-image-2' }] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        fetch
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('invalid_image_input');
      expect(result.content).toBe('Image input not found in project: missing/source.png');
      expect(JSON.stringify(result)).not.toContain('reference');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it.each([
    {
      model: 'gpt-image-2',
      arguments: {
        prompt: 'retouch the image',
        image: ['../outside.png']
      }
    },
    {
      model: 'doubao-seedream-5-0-lite-260128',
      arguments: {
        prompt: 'restyle the image',
        image: ['../outside.png']
      }
    }
  ])('preserves project path validation errors for $model image inputs', async ({ model, arguments: args }) => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-invalid-path-input-'));
    const fetch: ImageModelFetch = async () => {
      throw new Error('model fetch should not be called for invalid image input paths');
    };
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-invalid-image-input-path',
        input: { model, arguments: args },
        settings: { imageModels: [{ debruteModelId: model, baseUrlOverride: null, requestModelIdOverride: model }] },
        secrets: { imageModelApiKeys: { [model]: 'sk-image' } },
        fetch
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('invalid_image_input');
      expect(result.content).toBe('Project path must not contain "." or ".." segments: ../outside.png');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects image input fields on models that do not declare them', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-unsupported-input-field-'));
    let modelRuned = false;
    const fetch: ImageModelFetch = async () => {
      modelRuned = true;
      throw new Error('model fetch should not be called for unsupported image input fields');
    };
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-unsupported-image-input-field',
        input: {
          model: 'fal-ai/flux/dev',
          arguments: {
            prompt: 'generate a product render',
            image_url: 'https://cdn.example/source.png'
          }
        },
        settings: { imageModels: [{ debruteModelId: 'fal-ai/flux/dev', baseUrlOverride: null, requestModelIdOverride: 'fal-ai/flux/dev' }] },
        secrets: { imageModelApiKeys: { 'fal-ai/flux/dev': 'sk-image' } },
        fetch
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('invalid_image_input');
      expect(result.content).toBe('Image input field "image_url" is not supported by model "fal-ai/flux/dev".');
      expect(modelRuned).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects null image inputs before model requests', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-null-input-'));
    const fetch: ImageModelFetch = async () => {
      throw new Error('model fetch should not be called for null image inputs');
    };
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-null-image-input',
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'retouch the image',
            image: null
          }
        },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: 'gpt-image-2' }] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        fetch
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('invalid_image_input');
      expect(result.content).toBe('Image input field "image" must not be null.');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects scalar values for array image input fields before model requests', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-scalar-array-field-'));
    const fetch: ImageModelFetch = async () => {
      throw new Error('model fetch should not be called for scalar array image inputs');
    };
    try {
      await writeFile(join(projectRoot, 'source.png'), tinyPng);
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-scalar-array-image-input',
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'retouch the image',
            image: 'source.png'
          }
        },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: 'gpt-image-2' }] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        fetch
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('invalid_image_input');
      expect(result.content).toBe('Image input field "image" must be an array of strings or objects.');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects array values for single image input fields before model requests', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-array-single-field-'));
    const fetch: ImageModelFetch = async () => {
      throw new Error('model fetch should not be called for array mask inputs');
    };
    try {
      await writeFile(join(projectRoot, 'source.png'), tinyPng);
      await writeFile(join(projectRoot, 'mask-1.png'), tinyPng);
      await writeFile(join(projectRoot, 'mask-2.png'), tinyPng);
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-array-single-image-input',
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'retouch the image',
            image: ['source.png'],
            mask: ['mask-1.png', 'mask-2.png']
          }
        },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: 'gpt-image-2' }] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        fetch
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('invalid_image_input');
      expect(result.content).toBe('Image input field "mask" must be a single string or object.');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects masks without input images before model requests', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-mask-without-input-'));
    const fetch: ImageModelFetch = async () => {
      throw new Error('model fetch should not be called when mask has no input images');
    };
    try {
      await writeFile(join(projectRoot, 'mask.png'), tinyPng);
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-mask-without-input',
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'retouch the image',
            mask: 'mask.png'
          }
        },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: 'gpt-image-2' }] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        fetch
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('invalid_image_input');
      expect(result.content).toBe('Image input field "mask" requires non-empty "image".');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects unsupported model-specific image input objects before model requests', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-invalid-input-object-'));
    const fetch: ImageModelFetch = async () => {
      throw new Error('model fetch should not be called for invalid image inputs');
    };
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-invalid-image-input-object',
        input: {
          model: 'doubao-seedream-5-0-lite-260128',
          arguments: {
            prompt: 'restyle the image',
            image: [{ fileData: { fileUri: 'https://cdn.example/source.png', mimeType: 'image/png' } }]
          }
        },
        settings: { imageModels: [{ debruteModelId: 'doubao-seedream-5-0-lite-260128', baseUrlOverride: null, requestModelIdOverride: 'doubao-image' }] },
        secrets: { imageModelApiKeys: { 'doubao-seedream-5-0-lite-260128': 'sk-image' } },
        fetch
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('invalid_image_input');
      expect(result.content).toBe('Unsupported model-specific image input object for field "image".');
      expect(JSON.stringify(result)).not.toContain('reference');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects model-specific image objects that do not belong to the selected model field', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-cross-model-object-'));
    const fetch: ImageModelFetch = async () => {
      throw new Error('model fetch should not be called for cross-model image input objects');
    };
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-cross-model-image-input-object',
        input: {
          model: 'doubao-seedream-5-0-lite-260128',
          arguments: {
            prompt: 'restyle the image',
            image: [{ image_file: 'https://cdn.example/source.png' }]
          }
        },
        settings: { imageModels: [{ debruteModelId: 'doubao-seedream-5-0-lite-260128', baseUrlOverride: null, requestModelIdOverride: 'doubao-image' }] },
        secrets: { imageModelApiKeys: { 'doubao-seedream-5-0-lite-260128': 'sk-image' } },
        fetch
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('invalid_image_input');
      expect(result.content).toBe('Unsupported model-specific image input object for field "image".');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects OpenAI model-specific image_url objects with project-relative paths before model requests', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-openai-object-local-path-'));
    let modelRuned = false;
    const fetch: ImageModelFetch = async () => {
      modelRuned = true;
      throw new Error('model fetch should not be called for model-specific image_url local paths');
    };
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-openai-object-local-path',
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'retouch the image',
            image: [{ image_url: 'assets/source.png' }]
          }
        },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: 'gpt-image-2' }] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        fetch
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('invalid_image_input');
      expect(result.content).toBe('Unsupported model-specific image input object for field "image".');
      expect(modelRuned).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects Gemini snake_case model-specific image part objects before model requests', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-gemini-snake-case-object-'));
    let modelRuned = false;
    const fetch: ImageModelFetch = async () => {
      modelRuned = true;
      throw new Error('model fetch should not be called for snake_case Gemini image input objects');
    };
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-gemini-snake-case-object',
        input: {
          model: 'gemini-3.1-flash-image-preview',
          arguments: {
            prompt: 'restyle the image',
            image: [{ inline_data: { mime_type: 'image/png', data: tinyPngBase64 } }]
          }
        },
        settings: { imageModels: [{ debruteModelId: 'gemini-3.1-flash-image-preview', baseUrlOverride: null, requestModelIdOverride: 'gemini-3.1-flash-image-preview' }] },
        secrets: { imageModelApiKeys: { 'gemini-3.1-flash-image-preview': 'sk-image' } },
        fetch
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('invalid_image_input');
      expect(result.content).toBe('Image input field "image" is not supported by model "gemini-3.1-flash-image-preview".');
      expect(modelRuned).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects MiniMax model-specific image_file objects with project-relative paths before model requests', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-minimax-object-local-path-'));
    let modelRuned = false;
    const fetch: ImageModelFetch = async () => {
      modelRuned = true;
      throw new Error('model fetch should not be called for MiniMax image_file local paths');
    };
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-minimax-object-local-path',
        input: {
          model: 'image-01',
          arguments: {
            prompt: 'keep the character consistent',
            subject_reference: [{ type: 'character', image_file: 'assets/source.png' }]
          }
        },
        settings: { imageModels: [{ debruteModelId: 'image-01', baseUrlOverride: null, requestModelIdOverride: 'image-01' }] },
        secrets: { imageModelApiKeys: { 'image-01': 'sk-image' } },
        fetch
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('invalid_image_input');
      expect(result.content).toBe('Unsupported model-specific image input object for field "subject_reference".');
      expect(modelRuned).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects MiniMax model-specific image_data objects before model requests', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-minimax-object-image-data-'));
    let modelRuned = false;
    const fetch: ImageModelFetch = async () => {
      modelRuned = true;
      throw new Error('model fetch should not be called for MiniMax image_data objects');
    };
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-minimax-object-image-data',
        input: {
          model: 'image-01',
          arguments: {
            prompt: 'keep the character consistent',
            subject_reference: [{ type: 'character', image_data: tinyPngBase64 }]
          }
        },
        settings: { imageModels: [{ debruteModelId: 'image-01', baseUrlOverride: null, requestModelIdOverride: 'image-01' }] },
        secrets: { imageModelApiKeys: { 'image-01': 'sk-image' } },
        fetch
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('invalid_image_input');
      expect(result.content).toBe('Unsupported model-specific image input object for field "subject_reference".');
      expect(modelRuned).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: 'OpenAI',
      model: 'gpt-image-2',
      requestModelId: 'gpt-image-2',
      arguments: {
        prompt: 'retouch the image',
        image: [{ data: tinyPngBase64, mime_type: 'image/png', extra: true }]
      },
      field: 'image'
    },
    {
      name: 'MiniMax',
      model: 'image-01',
      requestModelId: 'image-01',
      arguments: {
        prompt: 'keep the character consistent',
        subject_reference: [{ type: 'character', image_file: 'https://cdn.example/source.png', extra: true }]
      },
      field: 'subject_reference'
    }
  ])('rejects $name model-specific image input objects with extra fields before model requests', async ({ model, requestModelId, arguments: requestArguments, field }) => {
    const projectRoot = await mkdtemp(join(tmpdir(), `debrute-image-extra-object-${model.replace(/[^a-z0-9]+/gi, '-')}-`));
    let modelRuned = false;
    const fetch: ImageModelFetch = async () => {
      modelRuned = true;
      throw new Error('model fetch should not be called for model-specific image input objects with extra fields');
    };
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-extra-model-object',
        input: {
          model,
          arguments: requestArguments
        },
        settings: { imageModels: [{ debruteModelId: model, baseUrlOverride: null, requestModelIdOverride: requestModelId }] },
        secrets: { imageModelApiKeys: { [model]: 'sk-image' } },
        fetch
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('invalid_image_input');
      expect(result.content).toBe(`Unsupported model-specific image input object for field "${field}".`);
      expect(modelRuned).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('encodes MiniMax project subject_reference paths as image_file data URLs', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-minimax-local-subject-reference-'));
    const fetch: ImageModelFetch = async (url, init) => {
      expect(url).toBe('https://api.minimax.io/v1/image_generation');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'image-01',
        prompt: 'keep the character consistent',
        subject_reference: [
          {
            type: 'character',
            image_file: `data:image/png;base64,${tinyPngBase64}`
          }
        ]
      });
      return jsonResponse({ base_resp: { status_code: 0 }, data: { image_base64: [tinyPngBase64] } });
    };
    try {
      await writeFile(join(projectRoot, 'source.png'), tinyPng);
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-minimax-local-subject-reference',
        input: {
          model: 'image-01',
          arguments: {
            prompt: 'keep the character consistent',
            subject_reference: ['source.png']
          }
        },
        settings: { imageModels: [{ debruteModelId: 'image-01', baseUrlOverride: null, requestModelIdOverride: 'image-01' }] },
        secrets: { imageModelApiKeys: { 'image-01': 'sk-image' } },
        fetch
      });

      expect(result.status).toBe('ok');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('passes MiniMax model-specific subject_reference objects through to the model request', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-minimax-model-subject-reference-'));
    const fetch: ImageModelFetch = async (url, init) => {
      expect(url).toBe('https://api.minimax.io/v1/image_generation');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'image-01',
        prompt: 'keep the character consistent',
        subject_reference: [
          {
            type: 'character',
            image_file: 'https://cdn.example/source.png'
          }
        ]
      });
      return jsonResponse({ base_resp: { status_code: 0 }, data: { image_base64: [tinyPngBase64] } });
    };
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-minimax-model-subject-reference',
        input: {
          model: 'image-01',
          arguments: {
            prompt: 'keep the character consistent',
            subject_reference: [
              {
                type: 'character',
                image_file: 'https://cdn.example/source.png'
              }
            ]
          }
        },
        settings: { imageModels: [{ debruteModelId: 'image-01', baseUrlOverride: null, requestModelIdOverride: 'image-01' }] },
        secrets: { imageModelApiKeys: { 'image-01': 'sk-image' } },
        fetch
      });

      expect(result.status).toBe('ok');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects empty image input arrays before model requests', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-openai-empty-input-images-'));
    const fetch: ImageModelFetch = async () => {
      throw new Error('model fetch should not be called for empty image input arrays');
    };
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-empty-input-images',
        input: { model: 'gpt-image-2', arguments: { prompt: 'cover image', image: [], size: '1024x1024' } },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: 'gpt-image-2' }] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        fetch
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('invalid_image_input');
      expect(result.content).toBe('Image input field "image" must not be empty.');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('aborts an OpenAI request when the model endpoint does not respond before the timeout', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-openai-timeout-'));
    const fetch: ImageModelFetch = async (_url, init) => {
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new Error('aborted'));
          return;
        }
        signal?.addEventListener(
          'abort',
          () => reject(signal.reason ?? new Error('aborted')),
          { once: true }
        );
      });
    };
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-openai-timeout',
        input: { model: 'gpt-image-2', arguments: { prompt: 'cover image', size: '1024x1024' } },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: 'gpt-image-2' }] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        requestTimeoutMs: 5,
        fetch
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('image_request_failed');
      expect(result.content).toContain('timed out');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('cancels a stalled OpenAI response body after the body timeout', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-openai-body-timeout-'));
    let canceled = false;
    const fetch: ImageModelFetch = async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"data":'));
        },
        cancel() {
          canceled = true;
        }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-openai-body-timeout',
        input: { model: 'gpt-image-2', arguments: { prompt: 'cover image', size: '1024x1024' } },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: 'gpt-image-2' }] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        requestTimeoutMs: 5,
        fetch
      });

      expect(result.status).toBe('error');
      expect(result.content).toContain('timed out');
      expect(canceled).toBe(true);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns a body timeout when response body cancellation does not settle', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-openai-body-cancel-hang-'));
    let canceled = false;
    const fetch: ImageModelFetch = async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"data":'));
        },
        cancel() {
          canceled = true;
          return new Promise(() => undefined);
        }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
    try {
      const pending = executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-openai-body-cancel-hang',
        input: { model: 'gpt-image-2', arguments: { prompt: 'cover image', size: '1024x1024' } },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: 'gpt-image-2' }] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        requestTimeoutMs: 5,
        fetch
      });
      const outcome = await Promise.race([
        pending.then((result) => ({ type: 'result' as const, result })),
        sleep(100).then(() => ({ type: 'pending' as const }))
      ]);

      expect(canceled).toBe(true);
      expect(outcome.type).toBe('result');
      if (outcome.type === 'result') {
        expect(outcome.result.status).toBe('error');
        expect(outcome.result.content).toContain('timed out');
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('aborts an OpenAI request when the caller signal aborts', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-openai-caller-abort-'));
    const controller = new AbortController();
    const fetch: ImageModelFetch = async (_url, init) => {
      setTimeout(() => controller.abort(new Error('caller stopped image request')), 0);
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason ?? new Error('aborted'));
        }, { once: true });
      });
    };
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-openai-caller-abort',
        input: { model: 'gpt-image-2', arguments: { prompt: 'cover image', size: '1024x1024' } },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: 'gpt-image-2' }] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        fetch,
        signal: controller.signal
      });

      expect(result.status).toBe('error');
      expect(result.content).toContain('caller stopped image request');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('aborts Wan polling delay when the caller signal aborts', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-wan-caller-abort-'));
    const controller = new AbortController();
    const calls: string[] = [];
    const fetch: ImageModelFetch = async (url) => {
      calls.push(url);
      if (url.endsWith('/services/aigc/image-generation/generation')) {
        return jsonResponse({ output: { task_id: 'task-1' } });
      }
      if (url.endsWith('/tasks/task-1')) {
        setTimeout(() => controller.abort(new Error('stop polling')), 0);
        return jsonResponse({ output: { task_status: 'RUNNING' } });
      }
      return pngResponse();
    };
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-wan-caller-abort',
        input: { model: 'wan2.7-image', arguments: { prompt: 'cover image' } },
        settings: { imageModels: [{ debruteModelId: 'wan2.7-image', baseUrlOverride: null, requestModelIdOverride: 'wan2.7-image' }] },
        secrets: { imageModelApiKeys: { 'wan2.7-image': 'sk-wan' } },
        pollIntervalMs: 1_000,
        wanPollMaxAttempts: 10,
        fetch,
        signal: controller.signal
      });

      expect(result.status).toBe('error');
      expect(result.content).toContain('stop polling');
      expect(calls).toEqual([
        'https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation',
        'https://dashscope.aliyuncs.com/api/v1/tasks/task-1'
      ]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns the current image download failure error payload', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-openai-download-failure-'));
    const fetch: ImageModelFetch = async (url) => {
      if (url === 'https://cdn.example/original-output.png') {
        throw new TypeError('fetch failed');
      }
      return jsonResponse({
        data: [
          {
            url: 'https://cdn.example/original-output.png',
            revised_prompt: 'refined cover'
          }
        ]
      });
    };
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-openai-download-failure',
        input: { model: 'gpt-image-2', arguments: { prompt: 'cover image', size: '1024x1024' } },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: 'gpt-image-2' }] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        fetch
      });

      expect(result.status).toBe('error');
      expect(result).toMatchObject({
        status: 'error',
        error: 'image_request_failed',
        content: 'Image request failed: fetch failed'
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('downloads provider image URLs through the validated remote transport', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-pinned-remote-download-'));
    const remoteResolutions: unknown[] = [];
    const fetch: ImageModelFetch = async (url) => {
      expect(url).toBe('https://api.openai.com/v1/images/generations');
      return jsonResponse({ data: [{ url: 'https://cdn.example/pinned-output.png' }] });
    };
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-image-pinned-remote-download',
        input: { model: 'gpt-image-2', arguments: { prompt: 'cover image', size: '1024x1024' } },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: 'gpt-image-2' }] },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image' } },
        fetch,
        remoteHttpTransport: async (input) => {
          expect(input.url).toBe('https://cdn.example/pinned-output.png');
          remoteResolutions.push(input.resolved);
          return pngResponse();
        }
      });

      expect(result.status).toBe('ok');
      expect(remoteResolutions).toEqual([{
        url: 'https://cdn.example/pinned-output.png',
        hostname: 'cdn.example',
        address: '93.184.216.34',
        family: 4
      }]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it.each([
    {
      debruteModelId: 'doubao-seedream-5-0-lite-260128',
      expectedFirstUrl: 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
      response: { data: [{ url: 'https://cdn.example/doubao.png' }] }
    },
    {
      debruteModelId: 'gemini-3.1-flash-image-preview',
      expectedFirstUrl: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=sk-image',
      response: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: tinyPngBase64 } }] } }] }
    },
    {
      debruteModelId: 'fal-ai/flux/dev',
      expectedFirstUrl: 'https://fal.run/fal-ai/flux/dev',
      response: { images: [{ url: 'https://cdn.example/fal.png' }], seed: 123 }
    },
    {
      debruteModelId: 'image-01',
      expectedFirstUrl: 'https://api.minimax.io/v1/image_generation',
      response: { base_resp: { status_code: 0 }, data: { image_base64: [tinyPngBase64] } }
    }
  ])('executes the $debruteModelId executor branch', async ({ debruteModelId, expectedFirstUrl, response }) => {
    const projectRoot = await mkdtemp(join(tmpdir(), `debrute-image-${debruteModelId.replace(/[^a-z0-9]+/gi, '-')}-`));
    const calls: string[] = [];
    const fetch: ImageModelFetch = async (url) => {
      calls.push(url);
      if (url.startsWith('https://cdn.example/')) {
        return pngResponse();
      }
      return jsonResponse(response);
    };
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-1',
        input: { model: debruteModelId, arguments: { prompt: 'cover image' } },
        settings: { imageModels: [{ debruteModelId, baseUrlOverride: null, requestModelIdOverride: debruteModelId }] },
        secrets: { imageModelApiKeys: { [debruteModelId]: 'sk-image' } },
        fetch
      });

      expect(result.status).toBe('ok');
      expect(calls[0]).toBe(expectedFirstUrl);
      expect(result.artifacts).toHaveLength(1);
      expect(JSON.stringify(result.logs)).not.toContain('sk-image');
      expect(JSON.stringify(result.logs)).not.toContain(tinyPngBase64);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('uses Gemini 3.1 image responseFormat and records compact inline image metadata', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-gemini-compact-'));
    const recorded: unknown[] = [];
    const fetch: ImageModelFetch = async (url, init) => {
      expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=sk-image');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          responseFormat: {
            image: {
              aspectRatio: '16:9',
              imageSize: '1K'
            }
          }
        }
      });
      return jsonResponse({
        candidates: [{
          content: {
            parts: [
              { text: 'done' },
              { inlineData: { mimeType: 'image/png', data: tinyPngBase64 } }
            ]
          }
        }]
      });
    };
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-gemini-compact',
        input: {
          model: 'gemini-3.1-flash-image-preview',
          arguments: {
            prompt: 'cover image',
            aspect_ratio: '16:9',
            image_size: '1K'
          }
        },
        settings: { imageModels: [{ debruteModelId: 'gemini-3.1-flash-image-preview', baseUrlOverride: null, requestModelIdOverride: 'gemini-3.1-flash-image-preview' }] },
        secrets: { imageModelApiKeys: { 'gemini-3.1-flash-image-preview': 'sk-image' } },
        fetch,
        recordGeneratedAsset: async (input) => {
          recorded.push(input);
        }
      });

      expect(result.status).toBe('ok');
      expect(result.artifacts[0]).toMatchObject({
        projectRelativePath: expect.stringMatching(/^generated\/turn-gemini-compact\/.+\.png$/),
        mimeType: 'image/png',
        width: 1,
        height: 1
      });
      await expect(readFile(join(projectRoot, result.artifacts[0].projectRelativePath))).resolves.toEqual(tinyPng);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        modelRunId: expect.any(String),
        artifactRole: 'primary-image',
        artifactIndex: 0,
        modelRun: {
          request: {
            method: 'POST',
            url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=%5Bredacted%5D'
          },
          output: {
            responses: [{
              body: {
                candidates: [{
                  content: {
                    parts: [
                      { text: 'done' },
                      {
                        inlineData: {
                          mimeType: 'image/png',
                          data: {
                            omitted: 'base64_image',
                            encoding: 'base64',
                            chars: tinyPngBase64.length,
                            estimatedBytes: tinyPng.length,
                            mimeType: 'image/png'
                          }
                        }
                      }
                    ]
                  }
                }]
              }
            }]
          }
        }
      });
      expect(JSON.stringify(recorded[0])).not.toContain(tinyPngBase64);
      expect(JSON.stringify(recorded[0])).not.toContain('sk-image');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('executes the Wan async polling executor branch', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-wan-'));
    const calls: string[] = [];
    const fetch: ImageModelFetch = async (url) => {
      calls.push(url);
      if (url.endsWith('/services/aigc/image-generation/generation')) {
        return jsonResponse({ output: { task_id: 'task-1' } });
      }
      if (url.endsWith('/tasks/task-1')) {
        return jsonResponse({ output: { task_status: 'SUCCEEDED', choices: [{ message: { content: [{ image: 'https://cdn.example/wan.png' }] } }] } });
      }
      return pngResponse();
    };
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-1',
        input: { model: 'wan2.7-image', arguments: { prompt: 'cover image' } },
        settings: { imageModels: [{ debruteModelId: 'wan2.7-image', baseUrlOverride: null, requestModelIdOverride: 'wan2.7-image' }] },
        secrets: { imageModelApiKeys: { 'wan2.7-image': 'sk-wan' } },
        pollIntervalMs: 0,
        fetch
      });

      expect(result.status).toBe('ok');
      expect(calls).toEqual([
        'https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation',
        'https://dashscope.aliyuncs.com/api/v1/tasks/task-1',
        'https://cdn.example/wan.png'
      ]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('executes the Vydra async polling executor branch', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-vydra-'));
    const calls: string[] = [];
    const fetch: ImageModelFetch = async (url) => {
      calls.push(url);
      if (url.endsWith('/models/grok-imagine')) {
        return jsonResponse({ jobId: 'job-1' });
      }
      if (url.endsWith('/jobs/job-1')) {
        return jsonResponse({ status: 'completed', output: { url: 'https://cdn.example/grok.png' } });
      }
      return pngResponse();
    };
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-1',
        input: { model: 'grok-imagine', arguments: { prompt: 'cover image' } },
        settings: { imageModels: [{ debruteModelId: 'grok-imagine', baseUrlOverride: null, requestModelIdOverride: 'grok-imagine' }] },
        secrets: { imageModelApiKeys: { 'grok-imagine': 'sk-grok' } },
        pollIntervalMs: 0,
        fetch
      });

      expect(result.status).toBe('ok');
      expect(calls).toEqual([
        'https://api.vydra.ai/api/v1/models/grok-imagine',
        'https://api.vydra.ai/api/v1/jobs/job-1',
        'https://cdn.example/grok.png'
      ]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns a redacted model response error when the endpoint rejects an image request', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-model-error-'));
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-error',
        input: {
          model: 'gpt-image-2',
          arguments: { prompt: 'bad prompt', size: '1024x1024' }
        },
        settings: {
          imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: null }]
        },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image-secret' } },
        fetch: async () => new Response(JSON.stringify({
          error: {
            code: 'BadRequest',
            message: 'prompt rejected for sk-image-secret',
            apiKey: 'sk-image-secret'
          }
        }), {
          status: 400,
          headers: { 'content-type': 'application/json' }
        })
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('request_failed');
      expect(result.content).toBe('Image request failed: model endpoint responded with HTTP 400.');
      expect(result.logs).toContainEqual(expect.objectContaining({
        stage: 'error',
        endpointResponse: {
          status: 400,
          body: {
            error: {
              code: 'BadRequest',
              message: 'prompt rejected for [redacted]',
              apiKey: '[redacted]'
            }
          }
        }
      }));
      expect(JSON.stringify(result)).not.toContain('sk-image-secret');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns an error without external fetch when the model is disabled', async () => {
    let called = false;
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-disabled-'));
    try {
      const result = await executeImageModelRequest({
        projectRoot,
        invocationId: 'turn-1',
        input: { model: 'gpt-image-2', arguments: { prompt: 'cover image' } },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: 'gpt-image-2' }] },
        secrets: { imageModelApiKeys: {} },
        fetch: async () => {
          called = true;
          return new Response('{}');
        }
      });

      expect(result.status).toBe('error');
      expect(called).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

function pngResponse(): Response {
  return new Response(tinyPng, { status: 200, headers: { 'content-type': 'image/png' } });
}

function imageFixture(input: {
  width: number;
  height: number;
  channels: 3 | 4;
  alpha?: number;
  format?: 'png' | 'webp' | 'jpeg' | 'avif' | 'tiff';
}): Promise<Buffer> {
  const create = input.channels === 4
    ? {
        width: input.width,
        height: input.height,
        channels: 4 as const,
        background: { r: 255, g: 255, b: 255, alpha: input.alpha ?? 1 }
      }
    : {
        width: input.width,
        height: input.height,
        channels: 3 as const,
        background: { r: 255, g: 255, b: 255 }
      };
  const pipeline = sharp({ create });
  if (input.format === 'webp') return pipeline.webp().toBuffer();
  if (input.format === 'jpeg') return pipeline.jpeg().toBuffer();
  if (input.format === 'avif') return pipeline.avif().toBuffer();
  if (input.format === 'tiff') return pipeline.tiff().toBuffer();
  return pipeline.png().toBuffer();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
