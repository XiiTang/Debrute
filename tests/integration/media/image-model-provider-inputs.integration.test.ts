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

describe('image model provider inputs', () => {
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

      const result = await executeImageModelTestRequest(projectRoot, 'turn-gemini-contents-prompt', {
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

  it('rejects unsupported model-specific image input objects before model requests', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-invalid-input-object-'));
    const fetch: ImageModelFetch = async () => {
      throw new Error('model fetch should not be called for invalid image inputs');
    };
    try {
      const result = await executeImageModelTestRequest(projectRoot, 'turn-invalid-image-input-object', {
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
      if (result.status !== 'error') {
        throw new Error(result.content);
      }
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
      const result = await executeImageModelTestRequest(projectRoot, 'turn-cross-model-image-input-object', {
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
      if (result.status !== 'error') {
        throw new Error(result.content);
      }
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
      const result = await executeImageModelTestRequest(projectRoot, 'turn-openai-object-local-path', {
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'retouch the image',
            image: [{ image_url: 'assets/source.png' }]
          }
        },
        fetch
      });

      expect(result.status).toBe('error');
      if (result.status !== 'error') {
        throw new Error(result.content);
      }
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
      const result = await executeImageModelTestRequest(projectRoot, 'turn-gemini-snake-case-object', {
        input: {
          model: 'gemini-3.1-flash-image-preview',
          arguments: {
            prompt: 'restyle the image',
            image: [{ inline_data: { mime_type: 'image/png', data: tinyPngBase64 } }]
          }
        },
        fetch
      });

      expect(result.status).toBe('error');
      if (result.status !== 'error') {
        throw new Error(result.content);
      }
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
      const result = await executeImageModelTestRequest(projectRoot, 'turn-minimax-object-local-path', {
        input: {
          model: 'image-01',
          arguments: {
            prompt: 'keep the character consistent',
            subject_reference: [{ type: 'character', image_file: 'assets/source.png' }]
          }
        },
        fetch
      });

      expect(result.status).toBe('error');
      if (result.status !== 'error') {
        throw new Error(result.content);
      }
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
      const result = await executeImageModelTestRequest(projectRoot, 'turn-minimax-object-image-data', {
        input: {
          model: 'image-01',
          arguments: {
            prompt: 'keep the character consistent',
            subject_reference: [{ type: 'character', image_data: tinyPngBase64 }]
          }
        },
        fetch
      });

      expect(result.status).toBe('error');
      if (result.status !== 'error') {
        throw new Error(result.content);
      }
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
      const result = await executeImageModelTestRequest(projectRoot, 'turn-extra-model-object', {
        input: {
          model,
          arguments: requestArguments
        },
        settings: { imageModels: [{ debruteModelId: model, baseUrlOverride: null, requestModelIdOverride: requestModelId }] },
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
      await writeFile(join(projectRoot, 'source.png'), tinyPngBytes());
      const result = await executeImageModelTestRequest(projectRoot, 'turn-minimax-local-subject-reference', {
        input: {
          model: 'image-01',
          arguments: {
            prompt: 'keep the character consistent',
            subject_reference: ['source.png']
          }
        },
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
      const result = await executeImageModelTestRequest(projectRoot, 'turn-minimax-model-subject-reference', {
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
        fetch
      });

      expect(result.status).toBe('ok');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
