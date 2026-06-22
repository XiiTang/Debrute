import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createVideoModelCatalog,
  executeVideoModelRequest as executeVideoModelRequestBase,
  type ExecuteVideoModelRequestInput,
  type PublicRemoteHostLookup,
  type PublicRemoteHttpTransport,
  type VideoModelFetch
} from '@debrute/capability-runtime';

const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8AARQAHSQGmK3P7WAAAAABJRU5ErkJggg==';
const tinyPng = Buffer.from(tinyPngBase64, 'base64');
const tinyMp4 = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
const tinyWav = Buffer.from('524946460000000057415645666d7420', 'hex');
const publicRemoteLookup: PublicRemoteHostLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const privateRemoteLookup: PublicRemoteHostLookup = async () => [{ address: '169.254.169.254', family: 4 }];

function executeVideoModelRequest(input: ExecuteVideoModelRequestInput) {
  const fetchImpl = input.fetch;
  const remoteHttpTransport: PublicRemoteHttpTransport | undefined = input.remoteHttpTransport
    ?? (fetchImpl
      ? ({ url, method, headers, signal }) => fetchImpl(url, { method, headers, signal })
      : undefined);
  return executeVideoModelRequestBase({
    remoteUrlLookup: publicRemoteLookup,
    ...input,
    ...(remoteHttpTransport ? { remoteHttpTransport } : {})
  });
}

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

describe('video model executor', () => {
  it('submits, polls, downloads, and writes a Seedance mp4 artifact', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-seedance-'));
    const calls: string[] = [];
    const apiKey = 'sk-video';
    const fetch: VideoModelFetch = async (url, init) => {
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
        expect(init.headers).toMatchObject({ authorization: `Bearer ${apiKey}` });
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
            prompt: 'camera slowly moves across a desk',
            resolution: '720p',
            ratio: '16:9',
            duration: 5,
            return_last_frame: true
          }
        },
        settings: {
          videoModels: [{
            debruteModelId: 'doubao-seedance-2-0-260128',
            baseUrlOverride: null,
            requestModelIdOverride: null
          }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': apiKey } },
        pollIntervalMs: 0,
        fetch
      });

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') {
        throw new Error(result.content);
      }
      expect(result.artifacts[0]).toMatchObject({
        projectRelativePath: expect.stringMatching(/^generated\/turn-video\/.+\.mp4$/),
        mimeType: 'video/mp4'
      });
      expect(result.artifacts[1]).toMatchObject({
        projectRelativePath: expect.stringMatching(/^generated\/turn-video\/.+\.png$/),
        mimeType: 'image/png'
      });
      await expect(readFile(join(projectRoot, result.artifacts[0]!.projectRelativePath))).resolves.toEqual(tinyMp4);
      expect(calls).toEqual([
        'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks',
        'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/task-1',
        'https://cdn.example/video.mp4',
        'https://cdn.example/last-frame.png'
      ]);
      expect(JSON.stringify(result.logs)).not.toContain('sk-video');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('stores supported last-frame image MIME types with registry extensions', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-last-frame-registry-extension-'));
    const fetch: VideoModelFetch = async (url, init) => {
      if (url.endsWith('/contents/generations/tasks') && init?.method === 'POST') {
        return jsonResponse({ id: 'task-last-frame-avif', status: 'queued' });
      }
      if (url.endsWith('/contents/generations/tasks/task-last-frame-avif')) {
        return jsonResponse({
          id: 'task-last-frame-avif',
          status: 'succeeded',
          content: { video_url: 'https://cdn.example/video.mp4', last_frame_url: 'https://cdn.example/last-frame.avif' }
        });
      }
      if (url === 'https://cdn.example/video.mp4') {
        return new Response(tinyMp4, { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
      if (url === 'https://cdn.example/last-frame.avif') {
        return new Response(tinyPng, { status: 200, headers: { 'content-type': 'image/avif' } });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    try {
      const result = await executeVideoModelRequest({
        projectRoot,
        invocationId: 'turn-video-last-frame-avif',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: {
            prompt: 'camera slowly moves across a desk',
            return_last_frame: true
          }
        },
        settings: {
          videoModels: [{
            debruteModelId: 'doubao-seedance-2-0-260128',
            baseUrlOverride: null,
            requestModelIdOverride: null
          }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
        pollIntervalMs: 0,
        fetch
      });

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') {
        throw new Error(result.content);
      }
      expect(result.artifacts[1]).toMatchObject({
        projectRelativePath: expect.stringMatching(/^generated\/turn-video-last-frame-avif\/.+\.avif$/),
        mimeType: 'image/avif'
      });
      await expect(readFile(join(projectRoot, result.artifacts[1]!.projectRelativePath))).resolves.toEqual(tinyPng);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('uses configured base URL overrides for video model requests', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-url-override-'));
    const calls: string[] = [];
    const fetch: VideoModelFetch = async (url, init) => {
      calls.push(url);
      if (url.endsWith('/contents/generations/tasks') && init?.method === 'POST') {
        return jsonResponse({ id: 'task-override', status: 'queued' });
      }
      if (url.endsWith('/contents/generations/tasks/task-override')) {
        return jsonResponse({
          id: 'task-override',
          status: 'succeeded',
          content: { video_url: 'https://cdn.example/video.mp4' }
        });
      }
      if (url === 'https://cdn.example/video.mp4') {
        return new Response(tinyMp4, { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    try {
      const result = await executeVideoModelRequest({
        projectRoot,
        invocationId: 'turn-video-override',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: {
            prompt: 'camera slowly moves across a desk',
            resolution: '720p',
            ratio: '16:9',
            duration: 5
          }
        },
        settings: {
          videoModels: [{
            debruteModelId: 'doubao-seedance-2-0-260128',
            baseUrlOverride: 'https://videos.example.test/api/v3',
            requestModelIdOverride: null
          }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
        pollIntervalMs: 0,
        fetch
      });

      expect(result.status).toBe('ok');
      expect(calls.slice(0, 2)).toEqual([
        'https://videos.example.test/api/v3/contents/generations/tasks',
        'https://videos.example.test/api/v3/contents/generations/tasks/task-override'
      ]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects loopback provider artifact URLs before download', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-loopback-artifact-'));
    const calls: string[] = [];
    const fetch: VideoModelFetch = async (url, init) => {
      calls.push(url);
      if (url.endsWith('/contents/generations/tasks') && init?.method === 'POST') {
        return jsonResponse({ id: 'task-loopback', status: 'queued' });
      }
      if (url.endsWith('/contents/generations/tasks/task-loopback')) {
        return jsonResponse({
          id: 'task-loopback',
          status: 'succeeded',
          content: { video_url: 'http://127.0.0.1:54321/private.mp4' }
        });
      }
      return new Response(tinyMp4, { status: 200, headers: { 'content-type': 'video/mp4' } });
    };
    try {
      const result = await executeVideoModelRequest({
        projectRoot,
        invocationId: 'turn-video-loopback-artifact',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: { prompt: 'camera slowly moves across a desk' }
        },
        settings: {
          videoModels: [{
            debruteModelId: 'doubao-seedance-2-0-260128',
            baseUrlOverride: null,
            requestModelIdOverride: null
          }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
        pollIntervalMs: 0,
        fetch
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('video_request_failed');
      expect(result.content).toBe('Video request failed: Remote artifact URLs must not target local or private network hosts: http://127.0.0.1:54321/private.mp4');
      expect(calls).toEqual([
        'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks',
        'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/task-loopback'
      ]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects DNS-resolved private provider artifact URLs before download', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-dns-private-artifact-'));
    const calls: string[] = [];
    const fetch: VideoModelFetch = async (url, init) => {
      calls.push(url);
      if (url.endsWith('/contents/generations/tasks') && init?.method === 'POST') {
        return jsonResponse({ id: 'task-dns-private', status: 'queued' });
      }
      if (url.endsWith('/contents/generations/tasks/task-dns-private')) {
        return jsonResponse({
          id: 'task-dns-private',
          status: 'succeeded',
          content: { video_url: 'https://private.example/video.mp4' }
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    try {
      const result = await executeVideoModelRequest({
        projectRoot,
        invocationId: 'turn-video-dns-private-artifact',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: { prompt: 'camera slowly moves across a desk' }
        },
        settings: {
          videoModels: [{
            debruteModelId: 'doubao-seedance-2-0-260128',
            baseUrlOverride: null,
            requestModelIdOverride: null
          }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
        pollIntervalMs: 0,
        fetch,
        remoteUrlLookup: privateRemoteLookup
      });

      expect(result.status).toBe('error');
      expect(result.content).toContain('Remote artifact URLs must not target local or private network hosts');
      expect(calls).toEqual([
        'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks',
        'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/task-dns-private'
      ]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('downloads provider artifact URLs through the validated remote transport', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-pinned-remote-download-'));
    const remoteResolutions: unknown[] = [];
    const fetch: VideoModelFetch = async (url, init) => {
      if (url.endsWith('/contents/generations/tasks') && init?.method === 'POST') {
        return jsonResponse({ id: 'task-pinned-download', status: 'queued' });
      }
      if (url.endsWith('/contents/generations/tasks/task-pinned-download')) {
        return jsonResponse({
          id: 'task-pinned-download',
          status: 'succeeded',
          content: { video_url: 'https://cdn.example/pinned-video.mp4' }
        });
      }
      throw new Error(`unexpected provider URL: ${url}`);
    };
    try {
      const result = await executeVideoModelRequest({
        projectRoot,
        invocationId: 'turn-video-pinned-remote-download',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: { prompt: 'camera move' }
        },
        settings: {
          videoModels: [{ debruteModelId: 'doubao-seedance-2-0-260128', baseUrlOverride: null, requestModelIdOverride: null }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
        pollIntervalMs: 0,
        fetch,
        remoteHttpTransport: async (input) => {
          expect(input.url).toBe('https://cdn.example/pinned-video.mp4');
          remoteResolutions.push(input.resolved);
          return new Response(tinyMp4, { status: 200, headers: { 'content-type': 'video/mp4' } });
        }
      });

      expect(result.status).toBe('ok');
      expect(remoteResolutions).toEqual([{
        url: 'https://cdn.example/pinned-video.mp4',
        hostname: 'cdn.example',
        address: '93.184.216.34',
        family: 4
      }]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('uses catalog defaults when a video model has only an API key configured', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-default-route-'));
    try {
      const calls: string[] = [];
      const fetch: VideoModelFetch = async (url, init) => {
        calls.push(url);
        if (String(url).endsWith('/contents/generations/tasks')) {
          const body = init?.body ? JSON.parse(String(init.body)) : {};
          expect(body.model).toBe('doubao-seedance-2-0-260128');
          return jsonResponse({ id: 'task-1' });
        }
        if (String(url).endsWith('/contents/generations/tasks/task-1')) {
          return jsonResponse({ status: 'succeeded', content: { video_url: 'https://cdn.example/video.mp4' } });
        }
        return new Response(tinyMp4, { status: 200, headers: { 'content-type': 'video/mp4' } });
      };

      const result = await executeVideoModelRequest({
        projectRoot,
        invocationId: 'turn-video-default-route',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: { prompt: 'camera move' }
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

  it('records redacted Debrute and upstream metadata for generated video artifacts', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-metadata-'));
    const recorded: unknown[] = [];
    const fetch: VideoModelFetch = async (url, init) => {
      if (url.endsWith('/contents/generations/tasks') && init?.method === 'POST') {
        return jsonResponse({ id: 'task-metadata', status: 'queued' });
      }
      if (url.endsWith('/contents/generations/tasks/task-metadata')) {
        return jsonResponse({ id: 'task-metadata', status: 'succeeded', content: { video_url: 'https://cdn.example/video.mp4?token=SIGNED' } });
      }
      if (url === 'https://cdn.example/video.mp4?token=SIGNED') {
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
            prompt: 'camera slowly moves across a desk',
            resolution: '720p'
          }
        },
        settings: {
          videoModels: [{ debruteModelId: 'doubao-seedance-2-0-260128', baseUrlOverride: null, requestModelIdOverride: null }]
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
        modelRun: {
          request: {
            debrute: {
              prompt: 'camera slowly moves across a desk',
              resolution: '720p'
            },
            upstream: {
              method: 'POST',
              url: 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks',
              headers: expect.objectContaining({ authorization: '[redacted]' }),
              body: {
                model: 'doubao-seedance-2-0-260128',
                content: [{ type: 'text', text: 'camera slowly moves across a desk' }],
                resolution: '720p'
              }
            }
          },
          output: {
            responses: [
              expect.objectContaining({ status: 200, body: { id: 'task-metadata', status: 'queued' } }),
              expect.objectContaining({ status: 200, body: { id: 'task-metadata', status: 'succeeded', content: { video_url: 'https://cdn.example/video.mp4?token=%5Bredacted%5D' } } })
            ],
            artifactIndex: 0,
            sourceUrl: 'https://cdn.example/video.mp4?token=%5Bredacted%5D'
          }
        }
      });
      expect(JSON.stringify(recorded)).not.toContain('sk-video');
      expect(JSON.stringify(recorded)).not.toContain('SIGNED');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('redacts local video reference data URL payloads from generated asset metadata', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-reference-metadata-'));
    const recorded: unknown[] = [];
    const fetch: VideoModelFetch = async (url, init) => {
      if (url.endsWith('/contents/generations/tasks') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        expect(JSON.stringify(body.content)).toContain(`data:image/png;base64,${tinyPngBase64}`);
        return jsonResponse({ id: 'task-reference-metadata', status: 'queued' });
      }
      if (url.endsWith('/contents/generations/tasks/task-reference-metadata')) {
        return jsonResponse({ id: 'task-reference-metadata', status: 'succeeded', content: { video_url: 'https://cdn.example/video.mp4' } });
      }
      if (url === 'https://cdn.example/video.mp4') {
        return new Response(tinyMp4, { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    try {
      await writeFile(join(projectRoot, 'first.png'), tinyPng);
      const result = await executeVideoModelRequest({
        projectRoot,
        invocationId: 'turn-video-reference-metadata',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: {
            prompt: 'animate the product',
            intent: 'generate',
            references: [{ source: 'first.png' }]
          }
        },
        settings: {
          videoModels: [{ debruteModelId: 'doubao-seedance-2-0-260128', baseUrlOverride: null, requestModelIdOverride: null }]
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
        modelRun: {
          request: {
            upstream: {
              body: {
                content: [
                  { type: 'text', text: 'animate the product' },
                  {
                    type: 'image_url',
                    image_url: { url: 'data:image/png;base64,[redacted]' },
                    role: 'first_frame'
                  }
                ]
              }
            }
          }
        }
      });
      expect(JSON.stringify(recorded)).not.toContain(tinyPngBase64);
      expect(JSON.stringify(recorded)).not.toContain('sk-video');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('builds Seedance content from Debrute-native generate intent', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-generate-routing-'));
    try {
      await writeFile(join(projectRoot, 'first.png'), tinyPng);
      await writeFile(join(projectRoot, 'last.png'), tinyPng);

      const textOnly = await runVideoRequestAndCaptureBody({
        projectRoot,
        invocationId: 'turn-video-generate-text',
        arguments: { prompt: 'camera slowly moves across a desk', resolution: '720p', ratio: '16:9', duration: 5 }
      });
      expect(textOnly.result.status).toBe('ok');
      expect(textOnly.body).toMatchObject({
        model: 'doubao-seedance-2-0-260128',
        content: [{ type: 'text', text: 'camera slowly moves across a desk' }],
        resolution: '720p',
        ratio: '16:9',
        duration: 5
      });

      const firstFrame = await runVideoRequestAndCaptureBody({
        projectRoot,
        invocationId: 'turn-video-generate-first',
        arguments: {
          prompt: 'animate the product',
          intent: 'generate',
          references: [{ source: 'first.png' }]
        }
      });
      expect(firstFrame.result.status).toBe('ok');
      expect(JSON.stringify(firstFrame.body?.content)).toContain('"role":"first_frame"');
      expect(JSON.stringify(firstFrame.body?.content)).toContain(`data:image/png;base64,${tinyPngBase64}`);

      const firstLast = await runVideoRequestAndCaptureBody({
        projectRoot,
        invocationId: 'turn-video-generate-first-last',
        arguments: {
          prompt: 'move from opening frame to closing frame',
          intent: 'generate',
          references: [{ source: 'first.png' }, { source: 'last.png' }]
        }
      });
      expect(firstLast.result.status).toBe('ok');
      expect(firstLast.body?.content).toEqual([
        { type: 'text', text: 'move from opening frame to closing frame' },
        expect.objectContaining({ type: 'image_url', role: 'first_frame' }),
        expect.objectContaining({ type: 'image_url', role: 'last_frame' })
      ]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('infers supported project image formats for Seedance references through the image registry', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-image-registry-'));
    try {
      await writeFile(join(projectRoot, 'first.avif'), tinyPng);
      await writeFile(join(projectRoot, 'last.jfif'), tinyPng);

      const captured = await runVideoRequestAndCaptureBody({
        projectRoot,
        invocationId: 'turn-video-registry-images',
        arguments: {
          prompt: 'animate the product',
          intent: 'generate',
          references: [{ source: 'first.avif' }, { source: 'last.jfif' }]
        }
      });

      expect(captured.result.status).toBe('ok');
      expect(JSON.stringify(captured.body?.content)).toContain(`data:image/avif;base64,${tinyPngBase64}`);
      expect(JSON.stringify(captured.body?.content)).toContain(`data:image/jpeg;base64,${tinyPngBase64}`);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('infers all-purpose reference routing from reference media types', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-reference-routing-'));
    try {
      await writeFile(join(projectRoot, 'reference.png'), tinyPng);
      await writeFile(join(projectRoot, 'sound.wav'), tinyWav);

      const captured = await runVideoRequestAndCaptureBody({
        projectRoot,
        invocationId: 'turn-video-reference',
        arguments: {
          prompt: 'combine the visual reference, motion reference, and music',
          intent: 'reference',
          references: [
            { source: 'reference.png' },
            { source: 'https://cdn.example/motion.mp4' },
            { source: 'sound.wav' }
          ],
          generate_audio: true
        }
      });

      expect(captured.result.status).toBe('ok');
      expect(captured.body?.content).toEqual([
        { type: 'text', text: 'combine the visual reference, motion reference, and music' },
        expect.objectContaining({ type: 'image_url', role: 'reference_image' }),
        expect.objectContaining({ type: 'video_url', role: 'reference_video', video_url: { url: 'https://cdn.example/motion.mp4' } }),
        expect.objectContaining({ type: 'audio_url', role: 'reference_audio' })
      ]);
      expect(JSON.stringify(captured.body?.content)).toContain('data:audio/wav;base64,');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('routes project-local video references through the upload service boundary', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-upload-boundary-'));
    try {
      await writeFile(join(projectRoot, 'clip.mp4'), tinyMp4);
      const uploads: unknown[] = [];

      const captured = await runVideoRequestAndCaptureBody({
        projectRoot,
        invocationId: 'turn-video-local-upload',
        arguments: {
          prompt: 'use the local motion reference',
          intent: 'reference',
          references: [{ source: 'clip.mp4' }]
        },
        uploadVideoReference: async (input) => {
          uploads.push(input);
          return { url: 'https://uploads.example/clip.mp4', expiresAt: '2026-06-09T12:00:00.000Z' };
        }
      });

      expect(captured.result.status).toBe('ok');
      expect(uploads).toEqual([{
        projectPath: projectRoot,
        projectRelativePath: 'clip.mp4',
        contentType: 'video/mp4',
        byteLength: tinyMp4.byteLength
      }]);
      expect(captured.body?.content).toEqual([
        { type: 'text', text: 'use the local motion reference' },
        { type: 'video_url', video_url: { url: 'https://uploads.example/clip.mp4' }, role: 'reference_video' }
      ]);

      const missingUpload = await executeVideoModelRequest({
        projectRoot,
        invocationId: 'turn-video-local-upload-missing',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: {
            prompt: 'use the local motion reference',
            intent: 'reference',
            references: [{ source: 'clip.mp4' }]
          }
        },
        settings: {
          videoModels: [{ debruteModelId: 'doubao-seedance-2-0-260128', baseUrlOverride: null, requestModelIdOverride: null }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
        fetch: async () => {
          throw new Error('upstream request should not run without upload service');
        }
      });

      expect(missingUpload.status).toBe('error');
      expect(missingUpload.error).toBe('video_reference_upload_unavailable');
      expect(missingUpload.content).toContain('Seedance-reachable URL or asset reference');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('routes large project-local video references through upload without local size validation', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-large-upload-boundary-'));
    try {
      const largeVideo = Buffer.alloc(20 * 1024 * 1024 + 1, 1);
      await writeFile(join(projectRoot, 'large.mp4'), largeVideo);
      const uploads: unknown[] = [];

      const captured = await runVideoRequestAndCaptureBody({
        projectRoot,
        invocationId: 'turn-video-large-local-upload',
        arguments: {
          prompt: 'use the large local motion reference',
          intent: 'reference',
          references: [{ source: 'large.mp4' }]
        },
        uploadVideoReference: async (input) => {
          uploads.push(input);
          return { url: 'https://uploads.example/large.mp4' };
        }
      });

      expect(captured.result.status).toBe('ok');
      expect(uploads).toEqual([{
        projectPath: projectRoot,
        projectRelativePath: 'large.mp4',
        contentType: 'video/mp4',
        byteLength: largeVideo.byteLength
      }]);
      expect(captured.body?.content).toContainEqual({
        type: 'video_url',
        video_url: { url: 'https://uploads.example/large.mp4' },
        role: 'reference_video'
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('routes edit masks through image data URLs and rejects unknown reference fields', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-edit-mask-'));
    try {
      const captured = await runVideoRequestAndCaptureBody({
        projectRoot,
        invocationId: 'turn-video-edit-mask',
        arguments: {
          prompt: 'replace the background',
          intent: 'edit',
          references: [{
            source: `data:image/png;base64,${tinyPngBase64}`,
            media_type: 'mask'
          }]
        }
      });

      expect(captured.result.status).toBe('ok');
      expect(captured.body?.content).toEqual([
        { type: 'text', text: 'replace the background' },
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${tinyPngBase64}` },
          role: 'mask'
        }
      ]);

      const result = await executeVideoModelRequest({
        projectRoot,
        invocationId: 'turn-video-reference-extra-field',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: {
            prompt: 'reject extra reference field',
            references: [{ source: 'https://cdn.example/frame.png', weight: 0.5 }]
          }
        },
        settings: {
          videoModels: [{ debruteModelId: 'doubao-seedance-2-0-260128', baseUrlOverride: null, requestModelIdOverride: null }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
        fetch: async () => {
          throw new Error('upstream request should not run for unsupported reference fields');
        }
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('video_argument_invalid');
      expect(result.content).toContain('Unsupported video reference argument: references[0].weight');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('validates video image data URLs through the image registry', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-data-image-registry-'));
    try {
      const accepted = await runVideoRequestAndCaptureBody({
        projectRoot,
        invocationId: 'turn-video-data-avif',
        arguments: {
          prompt: 'animate the product',
          intent: 'generate',
          references: [{ source: `data:image/avif;base64,${tinyPngBase64}` }]
        }
      });

      expect(accepted.result.status).toBe('ok');
      expect(JSON.stringify(accepted.body?.content)).toContain(`data:image/avif;base64,${tinyPngBase64}`);

      const rejected = await executeVideoModelRequest({
        projectRoot,
        invocationId: 'turn-video-data-gif',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: {
            prompt: 'reject gif',
            intent: 'generate',
            references: [{ source: `data:image/gif;base64,${tinyPngBase64}` }]
          }
        },
        settings: {
          videoModels: [{ debruteModelId: 'doubao-seedance-2-0-260128', baseUrlOverride: null, requestModelIdOverride: null }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
        fetch: async () => {
          throw new Error('upstream request should not run for unsupported image data URLs');
        }
      });

      expect(rejected.status).toBe('error');
      expect(rejected.error).toBe('video_reference_type_unsupported');
      expect(rejected.content).toContain('Unsupported Debrute project image data URL MIME type: image/gif');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects unsupported video image URL paths through the image registry', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-image-url-registry-'));
    try {
      const result = await executeVideoModelRequest({
        projectRoot,
        invocationId: 'turn-video-image-url-gif',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: {
            prompt: 'reject gif reference',
            intent: 'generate',
            references: [{ source: 'https://cdn.example/source.gif', media_type: 'image' }]
          }
        },
        settings: {
          videoModels: [{ debruteModelId: 'doubao-seedance-2-0-260128', baseUrlOverride: null, requestModelIdOverride: null }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
        fetch: async () => {
          throw new Error('upstream request should not run for unsupported image URL paths');
        }
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('video_reference_type_unsupported');
      expect(result.content).toBe('Unsupported Debrute project image URL reference: https://cdn.example/source.gif');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects loopback video reference URLs before upstream requests', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-loopback-reference-'));
    let modelRuned = false;
    try {
      const result = await executeVideoModelRequest({
        projectRoot,
        invocationId: 'turn-video-loopback-reference',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: {
            prompt: 'use this frame',
            intent: 'generate',
            references: [{ source: 'http://127.0.0.1/private.png' }]
          }
        },
        settings: {
          videoModels: [{ debruteModelId: 'doubao-seedance-2-0-260128', baseUrlOverride: null, requestModelIdOverride: null }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
        fetch: async () => {
          modelRuned = true;
          throw new Error('upstream request should not run for unsafe reference URLs');
        }
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('video_argument_invalid');
      expect(result.content).toBe('Remote video reference URLs must not target local or private network hosts: http://127.0.0.1/private.png');
      expect(modelRuned).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects unsupported public video arguments before upstream execution', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-unsupported-argument-'));
    try {
      const result = await executeVideoModelRequest({
        projectRoot,
        invocationId: 'turn-video-unsupported-argument',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: { prompt: 'request brief', content: [{ type: 'text', text: 'not public schema' }] }
        },
        settings: {
          videoModels: [{ debruteModelId: 'doubao-seedance-2-0-260128', baseUrlOverride: null, requestModelIdOverride: null }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
        fetch: async () => {
          throw new Error('upstream request should not run for unsupported arguments');
        }
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('video_argument_invalid');
      expect(result.content).toContain('Unsupported video request argument: content');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects invalid Seedance argument values before upstream execution', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-invalid-argument-values-'));
    try {
      for (const args of [
        { prompt: 'request brief', resolution: '1080p' },
        { prompt: 'request brief', ratio: '2:1' },
        { prompt: 'request brief', return_last_frame: 'yes' },
        { prompt: 'request brief', duration: 0 },
        { prompt: 'request brief', duration: 99 }
      ]) {
        const result = await executeVideoModelRequest({
          projectRoot,
          invocationId: 'turn-video-invalid-argument-values',
          input: {
            model: 'doubao-seedance-2-0-fast-260128',
            arguments: args
          },
          settings: {
            videoModels: [{ debruteModelId: 'doubao-seedance-2-0-fast-260128', baseUrlOverride: null, requestModelIdOverride: null }]
          },
          secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-fast-260128': 'sk-video' } },
          fetch: async () => {
            throw new Error('upstream request should not run for invalid argument values');
          }
        });

        expect(result.status).toBe('error');
        expect(result.error).toBe('video_argument_invalid');
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects bracketed IPv6 video reference URLs before upstream requests', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-ipv6-reference-'));
    try {
      const result = await executeVideoModelRequest({
        projectRoot,
        invocationId: 'turn-video-ipv6-reference',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: {
            prompt: 'use unsafe reference',
            references: [{ source: 'http://[::1]/private.png' }]
          }
        },
        settings: {
          videoModels: [{
            debruteModelId: 'doubao-seedance-2-0-260128',
            baseUrlOverride: null,
            requestModelIdOverride: null
          }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
        fetch: async () => {
          throw new Error('upstream request should not run for unsafe reference URLs');
        }
      });

      expect(result.status).toBe('error');
      expect(result.content).toContain('Remote video reference URLs must not target local or private network hosts');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('validates video intent reference combinations before local video upload', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-reference-preflight-'));
    let uploadCalls = 0;
    try {
      await writeFile(join(projectRoot, 'clip.mp4'), tinyMp4);

      const result = await executeVideoModelRequest({
        projectRoot,
        invocationId: 'turn-video-reference-preflight',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: {
            prompt: 'request brief',
            intent: 'generate',
            references: [{ source: 'clip.mp4' }]
          }
        },
        settings: {
          videoModels: [{ debruteModelId: 'doubao-seedance-2-0-260128', baseUrlOverride: null, requestModelIdOverride: null }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
        uploadVideoReference: async () => {
          uploadCalls += 1;
          return { url: 'https://uploads.example/clip.mp4' };
        },
        fetch: async () => {
          throw new Error('upstream request should not run for invalid reference combinations');
        }
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('video_reference_type_unsupported');
      expect(uploadCalls).toBe(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('applies video timeout to the whole task polling operation', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-operation-timeout-'));
    const controller = new AbortController();
    const cleanupTimer = setTimeout(() => controller.abort(new Error('cleanup abort')), 80);
    let pollCount = 0;
    const fetch: VideoModelFetch = async (url, init) => {
      if (url.endsWith('/contents/generations/tasks') && init?.method === 'POST') {
        return jsonResponse({ id: 'task-operation-timeout', status: 'queued' });
      }
      if (url.endsWith('/contents/generations/tasks/task-operation-timeout')) {
        pollCount += 1;
        return jsonResponse({ id: 'task-operation-timeout', status: 'running' });
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    try {
      const result = await executeVideoModelRequest({
        projectRoot,
        invocationId: 'turn-video-operation-timeout',
        input: {
          model: 'doubao-seedance-2-0-260128',
          timeoutMs: 25,
          arguments: { prompt: 'cover video' }
        },
        settings: {
          videoModels: [{ debruteModelId: 'doubao-seedance-2-0-260128', baseUrlOverride: null, requestModelIdOverride: null }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
        pollIntervalMs: 10,
        pollMaxAttempts: 1000,
        fetch,
        signal: controller.signal
      });

      expect(pollCount).toBeGreaterThan(0);
      expect(result.status).toBe('error');
      expect(result.error).toBe('video_request_failed');
      expect(result.content).toContain('Video request timed out after 25ms');
    } finally {
      clearTimeout(cleanupTimer);
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('cancels a stalled model JSON response body after the body timeout', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-json-body-timeout-'));
    let canceled = false;
    const fetch: VideoModelFetch = async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":'));
        },
        cancel() {
          canceled = true;
        }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
    try {
      const pending = executeVideoModelRequest({
        projectRoot,
        invocationId: 'turn-video-json-body-timeout',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: { prompt: 'cover video' }
        },
        settings: {
          videoModels: [{ debruteModelId: 'doubao-seedance-2-0-260128', baseUrlOverride: null, requestModelIdOverride: null }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
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
        expect(outcome.result.error).toBe('video_request_failed');
        expect(outcome.result.content).toContain('timed out');
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('cancels a stalled video artifact response body after the body timeout', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-artifact-body-timeout-'));
    let canceled = false;
    const fetch: VideoModelFetch = async (url, init) => {
      if (url.endsWith('/contents/generations/tasks') && init?.method === 'POST') {
        return jsonResponse({ id: 'task-body-timeout', status: 'queued' });
      }
      if (url.endsWith('/contents/generations/tasks/task-body-timeout')) {
        return jsonResponse({ id: 'task-body-timeout', status: 'succeeded', content: { video_url: 'https://cdn.example/video.mp4' } });
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(tinyMp4);
          },
          cancel() {
            canceled = true;
          }
        }),
        { status: 200, headers: { 'content-type': 'video/mp4' } }
      );
    };
    try {
      const pending = executeVideoModelRequest({
        projectRoot,
        invocationId: 'turn-video-artifact-body-timeout',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: { prompt: 'cover video' }
        },
        settings: {
          videoModels: [{ debruteModelId: 'doubao-seedance-2-0-260128', baseUrlOverride: null, requestModelIdOverride: null }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
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
        expect(outcome.result.error).toBe('video_request_failed');
        expect(outcome.result.content).toContain('timed out');
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns a redacted model response error when the endpoint rejects a video request', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-model-error-'));
    try {
      const result = await executeVideoModelRequest({
        projectRoot,
        invocationId: 'turn-error',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: { prompt: 'bad prompt' }
        },
        settings: {
          videoModels: [{ debruteModelId: 'doubao-seedance-2-0-260128', baseUrlOverride: null, requestModelIdOverride: null }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
        fetch: async () => new Response(JSON.stringify({ error: { code: 'BadRequest', message: 'prompt rejected', apiKey: 'sk-video' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' }
        })
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('video_request_failed');
      expect(result.content).toBe('Video request failed: model endpoint responded with HTTP 400.');
      expect(result.logs).toContainEqual(expect.objectContaining({
        stage: 'model_failure',
        endpointResponse: {
          status: 400,
          body: {
            error: {
              code: 'BadRequest',
              message: 'prompt rejected',
              apiKey: '[redacted]'
            }
          }
        }
      }));
      expect(JSON.stringify(result)).not.toContain('sk-video');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

async function runVideoRequestAndCaptureBody(input: {
  projectRoot: string;
  invocationId: string;
  arguments: Record<string, unknown>;
  uploadVideoReference?: ExecuteVideoModelRequestInput['uploadVideoReference'];
}): Promise<{ result: Awaited<ReturnType<typeof executeVideoModelRequest>>; body: Record<string, unknown> | undefined }> {
  let body: Record<string, unknown> | undefined;
  const fetch: VideoModelFetch = async (url, init) => {
    if (url.endsWith('/contents/generations/tasks') && init?.method === 'POST') {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse({ id: 'task-capture', status: 'queued' });
    }
    if (url.endsWith('/contents/generations/tasks/task-capture')) {
      return jsonResponse({ id: 'task-capture', status: 'succeeded', content: { video_url: 'https://cdn.example/video.mp4' } });
    }
    if (url === 'https://cdn.example/video.mp4') {
      return new Response(tinyMp4, { status: 200, headers: { 'content-type': 'video/mp4' } });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const result = await executeVideoModelRequest({
    projectRoot: input.projectRoot,
    invocationId: input.invocationId,
    input: {
      model: 'doubao-seedance-2-0-260128',
      arguments: input.arguments
    },
    settings: {
      videoModels: [{
        debruteModelId: 'doubao-seedance-2-0-260128',
        baseUrlOverride: null,
        requestModelIdOverride: null
      }]
    },
    secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
    pollIntervalMs: 0,
    fetch,
    ...(input.uploadVideoReference ? { uploadVideoReference: input.uploadVideoReference } : {})
  });

  return { result, body };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}
