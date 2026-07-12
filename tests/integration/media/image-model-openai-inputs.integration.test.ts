import { tinyPngBase64, tinyPngBytes } from '../../fixtures/mediaModelInputs';
import { executeImageModelTestRequest } from '../../helpers/imageModelTestRequests';

import type { ImageModelFetch } from '@debrute/capability-runtime';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

describe('OpenAI image model inputs', () => {
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
      await writeFile(join(projectRoot, 'mask.png'), tinyPngBytes());
      const result = await executeImageModelTestRequest(projectRoot, 'turn-openai-remote-input-local-mask', {
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'retouch the image',
            image: ['https://cdn.example/source.png'],
            mask: 'mask.png'
          }
        },
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
      const result = await executeImageModelTestRequest(projectRoot, 'turn-openai-mask-pass-through', {
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'retouch the image',
            image: ['source.png'],
            mask: 'mask.png'
          }
        },
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

      const result = await executeImageModelTestRequest(projectRoot, 'turn-openai-registry-inputs', {
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'retouch the image',
            image: ['source.avif'],
            mask: 'mask.jfif'
          }
        },
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
      const result = await executeImageModelTestRequest(projectRoot, 'turn-openai-mask-data-validation', {
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'retouch the image',
            image: [{ data: image.toString('base64'), mime_type: 'image/png' }],
            mask: { data: mask.toString('base64'), mime_type: 'image/webp' }
          }
        },
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
      const result = await executeImageModelTestRequest(projectRoot, 'turn-openai-raw-data-missing-mime', {
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'retouch the image',
            image: [{ data: tinyPngBase64 }]
          }
        },
        fetch
      });

      expect(result.status).toBe('error');
      if (result.status !== 'error') {
        throw new Error(result.content);
      }
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
      await writeFile(join(projectRoot, 'source.png'), tinyPngBytes());
      const result = await executeImageModelTestRequest(projectRoot, 'turn-openai-local-input-remote-mask', {
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'retouch the image',
            image: ['source.png'],
            mask: 'https://cdn.example/mask.png'
          }
        },
        fetch
      });

      expect(result.status).toBe('ok');
      expect(downloaded).toEqual(['https://cdn.example/mask.png']);
      expect(modelRuns).toBe(1);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
