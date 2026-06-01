import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createVideoModelCatalog,
  executeVideoModelRequest,
  type VideoProviderFetch
} from '@axis/capability-runtime';

const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8AARQAHSQGmK3P7WAAAAABJRU5ErkJggg==';
const tinyPng = Buffer.from(tinyPngBase64, 'base64');
const tinyMp4 = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
const tinyWav = Buffer.from('524946460000000057415645666d7420', 'hex');

describe('video model catalog and tools', () => {
  it('starts with only Seedance 2.0 video models', () => {
    const catalog = createVideoModelCatalog();

    expect(catalog.listAll().map((model) => model.axisModelId)).toEqual([
      'doubao-seedance-2-0-260128',
      'doubao-seedance-2-0-fast-260128'
    ]);
    expect(catalog.get('doubao-seedance-2-0-fast-260128')).toMatchObject({
      provider: 'volcengine-ark',
      supportsGeneratedAudio: true,
      capabilities: expect.objectContaining({ resolutions: ['480p', '720p'] })
    });
  });

  it('defines official routing defaults for video models', () => {
    const catalog = createVideoModelCatalog();

    for (const model of catalog.listAll()) {
      expect(model.defaultBaseUrl).toBe('https://ark.cn-beijing.volces.com/api/v3');
      expect(model.defaultProviderModelId).toBe(model.axisModelId);
    }
  });

  it('lists configured video models in overview mode and details requested models', async () => {
    const catalog = createVideoModelCatalog();
    const configured = catalog.listConfigured(['doubao-seedance-2-0-260128']);

    const overview = catalog.listOverviews(configured);
    expect(overview.map((model) => model.model)).toEqual(['doubao-seedance-2-0-260128']);

    const detail = catalog.details(['doubao-seedance-2-0-260128'], configured);
    expect(detail.details).toHaveLength(1);
    expect(JSON.stringify(detail.details)).toContain('content');

    const unavailable = catalog.details(['missing-model'], configured);
    expect(unavailable.unavailableModels).toEqual(['missing-model']);
  });

});

describe('video model executor', () => {
  it('submits, polls, downloads, and writes a Seedance mp4 artifact', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-video-seedance-'));
    const calls: string[] = [];
    const fetch: VideoProviderFetch = async (url, init) => {
      calls.push(url);
      if (url.endsWith('/contents/generations/tasks') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({
          model: 'doubao-seedance-2-0-260128',
          content: [{ type: 'text', text: 'camera slowly moves across a desk' }],
          resolution: '720p',
          ratio: '16:9',
          duration: 5,
          return_last_frame: true
        });
        expect(init.headers).toMatchObject({ authorization: 'Bearer sk-video' });
        return jsonResponse({ id: 'task-1', status: 'queued' });
      }
      if (url.endsWith('/contents/generations/tasks/task-1')) {
        return jsonResponse({
          id: 'task-1',
          status: 'succeeded',
          content: { video_url: 'https://cdn.example/video.mp4', last_frame_url: 'https://cdn.example/last-frame.png' }
        });
      }
      if (url === 'https://cdn.example/video.mp4') {
        return new Response(tinyMp4, { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
      if (url === 'https://cdn.example/last-frame.png') {
        return new Response(tinyPng, { status: 200, headers: { 'content-type': 'image/png' } });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    try {
      const result = await executeVideoModelRequest({
        projectRoot,
        invocationId: 'turn-video',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: {
            content: [{ type: 'text', text: 'camera slowly moves across a desk' }],
            resolution: '720p',
            ratio: '16:9',
            duration: 5,
            return_last_frame: true
          }
        },
        settings: {
          videoModels: [{
            axisModelId: 'doubao-seedance-2-0-260128',
            baseUrlOverride: 'https://ark.example/api/v3',
            providerModelIdOverride: null
          }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
        pollIntervalMs: 0,
        fetch
      });

      expect(result.status).toBe('ok');
      expect(result.artifacts[0]).toMatchObject({
        projectRelativePath: expect.stringMatching(/^generated\/turn-video\/.+\.mp4$/),
        mimeType: 'video/mp4'
      });
      expect(result.artifacts[1]).toMatchObject({
        projectRelativePath: expect.stringMatching(/^generated\/turn-video\/.+\.png$/),
        mimeType: 'image/png'
      });
      await expect(readFile(join(projectRoot, result.artifacts[0].projectRelativePath))).resolves.toEqual(tinyMp4);
      expect(calls).toEqual([
        'https://ark.example/api/v3/contents/generations/tasks',
        'https://ark.example/api/v3/contents/generations/tasks/task-1',
        'https://cdn.example/video.mp4',
        'https://cdn.example/last-frame.png'
      ]);
      expect(JSON.stringify(result.logs)).not.toContain('sk-video');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('uses catalog defaults when a video model has only an API key configured', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-video-default-route-'));
    try {
      const calls: string[] = [];
      const fetch: VideoProviderFetch = async (url, init) => {
        calls.push(url);
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (String(url).endsWith('/contents/generations/tasks')) {
          expect(body.model).toBe('doubao-seedance-2-0-260128');
          return jsonResponse({ id: 'task-1' });
        }
        return jsonResponse({ status: 'succeeded', content: { video_url: `data:video/mp4;base64,${tinyMp4.toString('base64')}` } });
      };

      const result = await executeVideoModelRequest({
        projectRoot,
        invocationId: 'turn-video-default-route',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: { content: [{ type: 'text', text: 'camera move' }] }
        },
        settings: { videoModels: [] },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
        fetch,
        pollIntervalMs: 0
      });

      expect(result.status).toBe('ok');
      expect(calls[0]).toBe('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('records raw provider request and output metadata for generated video artifacts', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-video-metadata-'));
    const recorded: unknown[] = [];
    const fetch: VideoProviderFetch = async (url, init) => {
      if (url.endsWith('/contents/generations/tasks') && init?.method === 'POST') {
        return jsonResponse({ id: 'task-metadata', status: 'queued' });
      }
      if (url.endsWith('/contents/generations/tasks/task-metadata')) {
        return jsonResponse({ id: 'task-metadata', status: 'succeeded', content: { video_url: 'https://cdn.example/video.mp4' } });
      }
      if (url === 'https://cdn.example/video.mp4') {
        return new Response(tinyMp4, { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    try {
      const result = await executeVideoModelRequest({
        projectRoot,
        invocationId: 'turn-video-metadata',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: {
            content: [{ type: 'text', text: 'camera slowly moves across a desk' }],
            resolution: '720p'
          }
        },
        settings: {
          videoModels: [{ axisModelId: 'doubao-seedance-2-0-260128', baseUrlOverride: 'https://ark.example/api/v3', providerModelIdOverride: null }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
        pollIntervalMs: 0,
        fetch,
        recordGeneratedAsset: async (input) => {
          recorded.push(input);
        }
      });

      expect(result.status).toBe('ok');
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        projectRelativePath: expect.stringMatching(/^generated\/turn-video-metadata\/.+\.mp4$/),
        providerCall: {
          request: {
            method: 'POST',
            url: 'https://ark.example/api/v3/contents/generations/tasks',
            headers: expect.objectContaining({ authorization: 'Bearer sk-video' }),
            body: {
              model: 'doubao-seedance-2-0-260128',
              content: [{ type: 'text', text: 'camera slowly moves across a desk' }],
              resolution: '720p'
            }
          },
          output: {
            responses: [
              expect.objectContaining({ status: 200, body: { id: 'task-metadata', status: 'queued' } }),
              expect.objectContaining({ status: 200, body: { id: 'task-metadata', status: 'succeeded', content: { video_url: 'https://cdn.example/video.mp4' } } })
            ],
            artifactIndex: 0,
            sourceUrl: 'https://cdn.example/video.mp4'
          }
        }
      });
      expect(recorded[0]).not.toHaveProperty('file');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('resolves local image and audio content references but rejects local video references', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-video-references-'));
    try {
      await writeFile(join(projectRoot, 'reference.png'), tinyPng);
      await writeFile(join(projectRoot, 'sound.wav'), tinyWav);
      await writeFile(join(projectRoot, 'clip.mp4'), tinyMp4);

      let submittedContent: unknown;
      const fetch: VideoProviderFetch = async (url, init) => {
        if (url.endsWith('/contents/generations/tasks') && init?.method === 'POST') {
          submittedContent = JSON.parse(String(init.body)).content;
          return jsonResponse({ id: 'task-2', status: 'queued' });
        }
        if (url.endsWith('/contents/generations/tasks/task-2')) {
          return jsonResponse({ id: 'task-2', status: 'succeeded', content: { video_url: 'https://cdn.example/video.mp4' } });
        }
        return new Response(tinyMp4, { status: 200, headers: { 'content-type': 'video/mp4' } });
      };

      const ok = await executeVideoModelRequest({
        projectRoot,
        invocationId: 'turn-refs',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: {
            content: [
              { type: 'text', text: 'animate the product' },
              { type: 'image_url', image_url: { url: 'reference.png' }, role: 'reference_image' },
              { type: 'audio_url', audio_url: { url: 'sound.wav' }, role: 'reference_audio' }
            ]
          }
        },
        settings: {
          videoModels: [{ axisModelId: 'doubao-seedance-2-0-260128', baseUrlOverride: 'https://ark.example/api/v3', providerModelIdOverride: null }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
        pollIntervalMs: 0,
        fetch
      });

      expect(ok.status).toBe('ok');
      expect(JSON.stringify(submittedContent)).toContain(`data:image/png;base64,${tinyPngBase64}`);
      expect(JSON.stringify(submittedContent)).toContain('data:audio/wav;base64,');

      const rejected = await executeVideoModelRequest({
        projectRoot,
        invocationId: 'turn-local-video',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: {
            content: [{ type: 'video_url', video_url: { url: 'clip.mp4' }, role: 'reference_video' }]
          }
        },
        settings: {
          videoModels: [{ axisModelId: 'doubao-seedance-2-0-260128', baseUrlOverride: 'https://ark.example/api/v3', providerModelIdOverride: null }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
        fetch
      });

      expect(rejected.status).toBe('error');
      expect(rejected.error).toBe('invalid_input');
      expect(rejected.content).toContain('public URL or asset://');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns redacted provider details for failed provider responses', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-video-provider-error-'));
    try {
      const result = await executeVideoModelRequest({
        projectRoot,
        invocationId: 'turn-error',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: { content: [{ type: 'text', text: 'bad prompt' }] }
        },
        settings: {
          videoModels: [{ axisModelId: 'doubao-seedance-2-0-260128', baseUrlOverride: 'https://ark.example/api/v3', providerModelIdOverride: null }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
        fetch: async () => new Response(JSON.stringify({ error: { code: 'BadRequest', message: 'prompt rejected', apiKey: 'sk-video' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' }
        })
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('video_request_failed');
      expect(result.providerResponse).toMatchObject({ status: 400, body: expect.objectContaining({ error: expect.objectContaining({ message: 'prompt rejected' }) }) });
      expect(JSON.stringify(result)).not.toContain('sk-video');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}
