import { tinyPngBase64, tinyPngBytes } from '../../fixtures/mediaModelInputs';
import { executeImageModelTestRequest } from '../../helpers/imageModelTestRequests';

import type { ImageModelFetch } from '@debrute/capability-runtime';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

function pngResponse(): Response {
  return new Response(tinyPngBytes(), { status: 200, headers: { 'content-type': 'image/png' } });
}

describe('image model providers', () => {
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
      return new Response(tinyPngBytes(), { status: 200, headers: { 'content-type': 'image/png' } });
    };

    try {
      await writeFile(join(projectRoot, 'wide.jpg'), wideImage);
      const result = await executeImageModelTestRequest(projectRoot, 'turn-wan-autofix', {
        input: { model: 'wan2.7-image', arguments: { prompt: 'use this', image: ['wide.jpg'] } },
        fetch,
        pollIntervalMs: 0
      });

      expect(result.status).toBe('ok');
      const content = ((requestBody?.input as Record<string, unknown>).messages as Array<Record<string, unknown>>)[0]!.content as Array<Record<string, string>>;
      const image = content.find((item) => typeof item.image === 'string')!.image;
      if (image === undefined) {
        throw new Error('Expected the upstream request to include an image data URL.');
      }
      expect(Buffer.from(image.split(',', 2)[1]!, 'base64')).toEqual(wideImage);
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

      const result = await executeImageModelTestRequest(projectRoot, 'turn-default-route', {
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

      const result = await executeImageModelTestRequest(projectRoot, 'turn-url-override', {
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

  it('normalizes Gemini local fileData fileUri values into inlineData parts', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-gemini-local-contents-'));
    try {
      await writeFile(join(projectRoot, 'source.png'), tinyPngBytes());
      let submittedBody: Record<string, unknown> | undefined;
      const fetch: ImageModelFetch = async (_url, init) => {
        submittedBody = JSON.parse(String(init?.body));
        return jsonResponse({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: tinyPngBase64 } }] } }]
        });
      };

      const result = await executeImageModelTestRequest(projectRoot, 'turn-gemini-local-contents', {
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
      await writeFile(join(projectRoot, 'source.png'), tinyPngBytes());
      let submittedBody: Record<string, unknown> | undefined;
      const fetch: ImageModelFetch = async (_url, init) => {
        submittedBody = JSON.parse(String(init?.body));
        return jsonResponse({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: tinyPngBase64 } }] } }]
        });
      };

      const result = await executeImageModelTestRequest(projectRoot, 'turn-gemini-local-registry-mime', {
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

      const result = await executeImageModelTestRequest(projectRoot, 'turn-gemini-remote-registry-mime', {
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
      const result = await executeImageModelTestRequest(projectRoot, 'turn-1', {
        input: { model: debruteModelId, arguments: { prompt: 'cover image' } },
        settings: { imageModels: [{ debruteModelId, baseUrlOverride: null, requestModelIdOverride: debruteModelId }] },
        secrets: {
          imageModelApiKeys: {
            [debruteModelId]: 'sk-image'
          }
        },
        fetch
      });

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') {
        throw new Error(result.content);
      }
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
      const result = await executeImageModelTestRequest(projectRoot, 'turn-gemini-compact', {
        input: {
          model: 'gemini-3.1-flash-image-preview',
          arguments: {
            prompt: 'cover image',
            aspect_ratio: '16:9',
            image_size: '1K'
          }
        },
        fetch,
        recordGeneratedAsset: async (input) => {
          recorded.push(input);
        }
      });

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') {
        throw new Error(result.content);
      }
      const artifact = result.artifacts[0];
      if (artifact === undefined) {
        throw new Error('Expected a generated Gemini image artifact.');
      }
      expect(artifact).toMatchObject({
        projectRelativePath: expect.stringMatching(/^generated\/turn-gemini-compact\/.+\.png$/),
        mimeType: 'image/png',
        width: 1,
        height: 1
      });
      await expect(readFile(join(projectRoot, artifact.projectRelativePath))).resolves.toEqual(tinyPngBytes());
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
                            estimatedBytes: tinyPngBytes().length,
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
      const result = await executeImageModelTestRequest(projectRoot, 'turn-1', {
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
      const result = await executeImageModelTestRequest(projectRoot, 'turn-1', {
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
});
