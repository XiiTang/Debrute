import { tinyPngBase64, tinyPngBytes } from '../../fixtures/mediaModelInputs';
import { executeImageModelTestRequest } from '../../helpers/imageModelTestRequests';

import type { ImageModelFetch, PublicRemoteHostLookup } from '@debrute/capability-runtime';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const privateRemoteLookup: PublicRemoteHostLookup = async () => [{ address: '169.254.169.254', family: 4 }];

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

function pngResponse(): Response {
  return new Response(tinyPngBytes(), { status: 200, headers: { 'content-type': 'image/png' } });
}

describe('image model remote policy', () => {
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
      const result = await executeImageModelTestRequest(projectRoot, 'turn-openai-loopback-input', {
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'retouch the image',
            image: ['http://127.0.0.1/private.png']
          }
        },
        fetch
      });

      expect(result.status).toBe('error');
      if (result.status !== 'error') {
        throw new Error(result.content);
      }
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
      const result = await executeImageModelTestRequest(projectRoot, 'turn-openai-ipv6-input', {
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
      const result = await executeImageModelTestRequest(projectRoot, 'turn-openai-dns-private-input', {
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
      const result = await executeImageModelTestRequest(projectRoot, 'turn-openai-object-loopback-input', {
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'retouch the image',
            image: [{ image_url: 'http://127.0.0.1/private.png' }]
          }
        },
        fetch
      });

      expect(result.status).toBe('error');
      if (result.status !== 'error') {
        throw new Error(result.content);
      }
      expect(result.error).toBe('invalid_image_input');
      expect(result.content).toBe('Remote image URLs must not target local or private network hosts: http://127.0.0.1/private.png');
      expect(modelRuned).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects unsupported remote image URL paths through the project image registry', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-url-registry-'));
    try {
      const rejected = await executeImageModelTestRequest(projectRoot, 'turn-image-url-gif', {
        input: {
          model: 'wan2.7-image',
          arguments: { prompt: 'use this', image: ['https://cdn.example/source.gif'] }
        },
        fetch: async () => {
          throw new Error('upstream request should not run for unsupported image URL paths');
        },
        pollIntervalMs: 0
      });

      expect(rejected.status).toBe('error');
      if (rejected.status !== 'error') {
        throw new Error(rejected.content);
      }
      expect(rejected.error).toBe('invalid_image_input');
      expect(rejected.content).toBe('Unsupported Debrute project image URL reference: https://cdn.example/source.gif');

      const objectRejected = await executeImageModelTestRequest(projectRoot, 'turn-image-object-url-gif', {
        input: {
          model: 'gpt-image-2',
          arguments: {
            prompt: 'use this',
            image: [{ image_url: 'https://cdn.example/source.gif' }]
          }
        },
        fetch: async () => {
          throw new Error('upstream request should not run for unsupported object image URL paths');
        }
      });

      expect(objectRejected.status).toBe('error');
      if (objectRejected.status !== 'error') {
        throw new Error(objectRejected.content);
      }
      expect(objectRejected.error).toBe('invalid_image_input');
      expect(objectRejected.content).toBe('Unsupported Debrute project image URL reference: https://cdn.example/source.gif');
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
      const result = await executeImageModelTestRequest(projectRoot, 'turn-image-pinned-remote-download', {
        input: { model: 'gpt-image-2', arguments: { prompt: 'cover image', size: '1024x1024' } },
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
});
