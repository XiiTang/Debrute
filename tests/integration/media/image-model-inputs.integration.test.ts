import { tinyPngBase64, tinyPngBytes } from '../../fixtures/mediaModelInputs';
import { executeImageModelTestRequest } from '../../helpers/imageModelTestRequests';

import type { ImageModelFetch } from '@debrute/capability-runtime';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

function pngResponse(): Response {
  return new Response(tinyPngBytes(), { status: 200, headers: { 'content-type': 'image/png' } });
}

describe('image model inputs', () => {
  it('rejects unsupported local reference image types before upstream image requests', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-wan-reference-type-reject-'));
    let modelRuns = 0;
    try {
      await writeFile(join(projectRoot, 'source.gif'), Buffer.from('GIF89a'));
      const result = await executeImageModelTestRequest(projectRoot, 'turn-wan-type', {
        input: { model: 'wan2.7-image', arguments: { prompt: 'use this', image: ['source.gif'] } },
        fetch: async () => {
          modelRuns += 1;
          throw new Error('upstream request should not run for unsupported local image types');
        },
        pollIntervalMs: 0
      });

      expect(result.status).toBe('error');
      if (result.status !== 'error') {
        throw new Error(result.content);
      }
      expect(result.error).toBe('invalid_image_input');
      expect(result.content).toContain('Unsupported Debrute project image reference: source.gif');
      expect(modelRuns).toBe(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('validates data:image MIME types against the project image registry', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-data-url-registry-'));
    let acceptedRuns = 0;
    try {
      const accepted = await executeImageModelTestRequest(projectRoot, 'turn-image-data-url-avif', {
        input: {
          model: 'wan2.7-image',
          arguments: { prompt: 'use this', image: [`data:image/avif;base64,${tinyPngBase64}`] }
        },
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

      const rejected = await executeImageModelTestRequest(projectRoot, 'turn-image-data-url-gif', {
        input: {
          model: 'wan2.7-image',
          arguments: { prompt: 'use this', image: [`data:image/gif;base64,${tinyPngBase64}`] }
        },
        fetch: async () => {
          throw new Error('upstream request should not run for unsupported data image types');
        },
        pollIntervalMs: 0
      });

      expect(rejected.status).toBe('error');
      if (rejected.status !== 'error') {
        throw new Error(rejected.content);
      }
      expect(rejected.error).toBe('invalid_image_input');
      expect(rejected.content).toContain('Unsupported Debrute project image data URL MIME type: image/gif');

      const objectRejected = await executeImageModelTestRequest(projectRoot, 'turn-image-object-data-url-gif', {
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'use this',
            image: [{ image_url: `data:image/gif;base64,${tinyPngBase64}` }]
          }
        },
        fetch: async () => {
          throw new Error('upstream request should not run for unsupported object data image types');
        }
      });

      expect(objectRejected.status).toBe('error');
      if (objectRejected.status !== 'error') {
        throw new Error(objectRejected.content);
      }
      expect(objectRejected.error).toBe('invalid_image_input');
      expect(objectRejected.content).toContain('Unsupported Debrute project image data URL MIME type: image/gif');

      const rawObjectRejected = await executeImageModelTestRequest(projectRoot, 'turn-image-object-raw-gif', {
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'use this',
            image: [{ data: tinyPngBase64, mime_type: 'image/gif' }]
          }
        },
        fetch: async () => {
          throw new Error('upstream request should not run for unsupported raw object image types');
        }
      });

      expect(rawObjectRejected.status).toBe('error');
      if (rawObjectRejected.status !== 'error') {
        throw new Error(rawObjectRejected.content);
      }
      expect(rawObjectRejected.error).toBe('invalid_image_input');
      expect(rawObjectRejected.content).toContain('Unsupported Debrute project image MIME type: image/gif');
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
      const result = await executeImageModelTestRequest(projectRoot, 'turn-missing-image-input', {
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'retouch the image',
            image: ['missing/source.png']
          }
        },
        fetch
      });

      expect(result.status).toBe('error');
      if (result.status !== 'error') {
        throw new Error(result.content);
      }
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
      const result = await executeImageModelTestRequest(projectRoot, 'turn-invalid-image-input-path', {
        input: { model, arguments: args },
        settings: { imageModels: [{ debruteModelId: model, baseUrlOverride: null, requestModelIdOverride: model }] },
        secrets: {
          imageModelApiKeys: {
            [model]: 'sk-image'
          }
        },
        fetch
      });

      expect(result.status).toBe('error');
      if (result.status !== 'error') {
        throw new Error(result.content);
      }
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
      const result = await executeImageModelTestRequest(projectRoot, 'turn-unsupported-image-input-field', {
        input: {
          model: 'fal-ai/flux/dev',
          arguments: {
            prompt: 'generate a product render',
            image_url: 'https://cdn.example/source.png'
          }
        },
        fetch
      });

      expect(result.status).toBe('error');
      if (result.status !== 'error') {
        throw new Error(result.content);
      }
      expect(result.error).toBe('invalid_image_input');
      expect(result.content).toBe('Image input field "image_url" is not supported by model "fal-ai/flux/dev".');
      expect(modelRuned).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it.each([
    {
      title: 'rejects null image inputs before model requests',
      temporaryPrefix: 'debrute-image-null-input-',
      invocationId: 'turn-null-image-input',
      arguments: { prompt: 'retouch the image', image: null },
      fixturePaths: [],
      expected: 'Image input field "image" must not be null.'
    },
    {
      title: 'rejects scalar values for array image input fields before model requests',
      temporaryPrefix: 'debrute-image-scalar-array-field-',
      invocationId: 'turn-scalar-array-image-input',
      arguments: { prompt: 'retouch the image', image: 'source.png' },
      fixturePaths: ['source.png'],
      expected: 'Image input field "image" must be an array of strings or objects.'
    },
    {
      title: 'rejects array values for single image input fields before model requests',
      temporaryPrefix: 'debrute-image-array-single-field-',
      invocationId: 'turn-array-single-image-input',
      arguments: { prompt: 'retouch the image', image: ['source.png'], mask: ['mask-1.png', 'mask-2.png'] },
      fixturePaths: ['source.png', 'mask-1.png', 'mask-2.png'],
      expected: 'Image input field "mask" must be a single string or object.'
    },
    {
      title: 'rejects masks without input images before model requests',
      temporaryPrefix: 'debrute-image-mask-without-input-',
      invocationId: 'turn-mask-without-input',
      arguments: { prompt: 'retouch the image', mask: 'mask.png' },
      fixturePaths: ['mask.png'],
      expected: 'Image input field "mask" requires non-empty "image".'
    }
  ])('$title', async ({ temporaryPrefix, invocationId, arguments: modelArguments, fixturePaths, expected }) => {
    const projectRoot = await mkdtemp(join(tmpdir(), temporaryPrefix));
    const fetch: ImageModelFetch = async () => {
      throw new Error('model fetch should not be called for invalid image inputs');
    };
    try {
      await Promise.all(fixturePaths.map((fixturePath) => writeFile(join(projectRoot, fixturePath), tinyPngBytes())));
      const result = await executeImageModelTestRequest(projectRoot, invocationId, {
        input: { model: 'gpt-image-2', arguments: modelArguments },
        fetch
      });

      expect(result.status).toBe('error');
      if (result.status !== 'error') {
        throw new Error(result.content);
      }
      expect(result.error).toBe('invalid_image_input');
      expect(result.content).toBe(expected);
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
      const result = await executeImageModelTestRequest(projectRoot, 'turn-empty-input-images', {
        input: { model: 'gpt-image-2', arguments: { prompt: 'cover image', image: [], size: '1024x1024' } },
        fetch
      });

      expect(result.status).toBe('error');
      if (result.status !== 'error') {
        throw new Error(result.content);
      }
      expect(result.error).toBe('invalid_image_input');
      expect(result.content).toBe('Image input field "image" must not be empty.');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
