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

describe('image model artifacts', () => {
  it('writes OpenAI image artifacts into generated/<turn-id>', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-openai-'));
    const fetch: ImageModelFetch = async (url, init) => {
      expect(url).toBe('https://api.openai.com/v1/images/generations');
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'gpt-image-2', prompt: 'cover image' });
      return jsonResponse({ data: [{ b64_json: tinyPngBase64 }] });
    };
    try {
      const result = await executeImageModelTestRequest(projectRoot, 'turn-1', {
        input: { model: 'gpt-image-2', arguments: { prompt: 'cover image', size: '1024x1024' } },
        fetch
      });

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') {
        throw new Error(result.content);
      }
      const artifact = result.artifacts[0];
      if (artifact === undefined) {
        throw new Error('Expected a generated OpenAI image artifact.');
      }
      expect(artifact).toMatchObject({
        projectRelativePath: expect.stringMatching(/^generated\/turn-1\/.+\.png$/),
        mimeType: 'image/png',
        width: 1,
        height: 1
      });
      await expect(readFile(join(projectRoot, artifact.projectRelativePath))).resolves.toBeInstanceOf(Buffer);
      expect(JSON.stringify(result.logs)).not.toContain('sk-image');
      expect(JSON.stringify(result.logs)).not.toContain(tinyPngBase64);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('stores supported generated image URL path MIME types with registry extensions', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-artifact-registry-extension-'));
    try {
      const result = await executeImageModelTestRequest(projectRoot, 'turn-artifact-avif', {
        input: { model: 'wan2.7-image', arguments: { prompt: 'make an icon' } },
        fetch: async (url) => {
          if (url === 'https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation') {
            return jsonResponse({ output: { task_id: 'task-avif' } });
          }
          if (url === 'https://dashscope.aliyuncs.com/api/v1/tasks/task-avif') {
            return jsonResponse({ output: { task_status: 'SUCCEEDED', choices: [{ message: { content: [{ image: 'https://cdn.example/out.avif?token=SIGNED' }] } }] } });
          }
          expect(url).toBe('https://cdn.example/out.avif?token=SIGNED');
          const bytes = await imageFixture({ width: 12, height: 10, channels: 4, alpha: 1, format: 'avif' });
          return new Response(new Uint8Array([...bytes]).buffer, {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' }
          });
        },
        pollIntervalMs: 0
      });

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') {
        throw new Error(result.content);
      }
      const artifact = result.artifacts[0];
      if (artifact === undefined) {
        throw new Error('Expected a generated AVIF image artifact.');
      }
      expect(artifact).toMatchObject({
        projectRelativePath: expect.stringMatching(/^generated\/turn-artifact-avif\/.+\.avif$/),
        mimeType: 'image/avif'
      });
      await expect(readFile(join(projectRoot, artifact.projectRelativePath))).resolves.toBeInstanceOf(Buffer);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects generated image URL artifacts with unsupported MIME evidence before writing files', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-artifact-unsupported-mime-'));
    const recorded: unknown[] = [];
    try {
      const result = await executeImageModelTestRequest(projectRoot, 'turn-artifact-unsupported-mime', {
        input: {
          model: 'wan2.7-image',
          arguments: {
            prompt: 'make an icon',
            output_path: 'generated/unsupported.bin'
          }
        },
        fetch: async (url) => {
          if (url === 'https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation') {
            return jsonResponse({ output: { task_id: 'task-unsupported-mime' } });
          }
          if (url === 'https://dashscope.aliyuncs.com/api/v1/tasks/task-unsupported-mime') {
            return jsonResponse({
              output: {
                task_status: 'SUCCEEDED',
                choices: [{ message: { content: [{ image: 'https://cdn.example/generated-artifact' }] } }]
              }
            });
          }
          expect(url).toBe('https://cdn.example/generated-artifact');
          return new Response(Buffer.from('{"error":"not an image"}'), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        },
        pollIntervalMs: 0,
        recordGeneratedAsset: async (input) => {
          recorded.push(input);
        }
      });

      expect(result).toMatchObject({
        status: 'error',
        error: 'image_request_failed'
      });
      expect(result.content).toContain('Unsupported image artifact MIME type: application/json');
      await expect(readFile(join(projectRoot, 'generated/unsupported.bin'))).rejects.toThrow();
      expect(recorded).toEqual([]);
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
      const result = await executeImageModelTestRequest(projectRoot, 'turn-metadata', {
        input: { model: 'gpt-image-2', arguments: { prompt: 'cover image', size: '1024x1024' } },
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
                    estimatedBytes: tinyPngBytes().length,
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
      await writeFile(join(projectRoot, 'source.png'), tinyPngBytes());
      const result = await executeImageModelTestRequest(projectRoot, 'turn-edit-metadata', {
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'retouch the image',
            size: '1024x1024',
            image: ['source.png']
          }
        },
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
                    bytes: tinyPngBytes().length
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
      const result = await executeImageModelTestRequest(projectRoot, 'turn-openai-download-failure', {
        input: { model: 'gpt-image-2', arguments: { prompt: 'cover image', size: '1024x1024' } },
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
});
