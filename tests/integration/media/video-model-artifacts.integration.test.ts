import { tinyMp4Bytes, tinyPngBase64, tinyPngBytes } from '../../fixtures/mediaModelInputs';
import { executeVideoModelTestRequest } from '../../helpers/videoModelTestRequests';

import type { VideoModelFetch } from '@debrute/capability-runtime';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('video model artifacts', () => {
  it('rejects primary video artifacts with unsupported MIME evidence before writing files', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-unsupported-primary-mime-'));
    const recorded: unknown[] = [];
    const fetch: VideoModelFetch = async (url, init) => {
      if (url.endsWith('/contents/generations/tasks') && init?.method === 'POST') {
        return jsonResponse({ id: 'task-unsupported-primary', status: 'queued' });
      }
      if (url.endsWith('/contents/generations/tasks/task-unsupported-primary')) {
        return jsonResponse({
          id: 'task-unsupported-primary',
          status: 'succeeded',
          content: { video_url: 'https://cdn.example/generated-artifact' }
        });
      }
      if (url === 'https://cdn.example/generated-artifact') {
        return new Response(Buffer.from('{"error":"not a video"}'), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    try {
      const result = await executeVideoModelTestRequest({
        projectRoot,
        invocationId: 'turn-video-unsupported-primary',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: {
            prompt: 'camera slowly moves across a desk',
            output_path: 'generated/unsupported.bin'
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
        fetch,
        recordGeneratedAsset: async (input) => {
          recorded.push(input);
        }
      });

      expect(result).toMatchObject({
        status: 'error',
        error: 'video_request_failed'
      });
      expect(result.content).toContain('Unsupported primary video artifact MIME type: application/json');
      await expect(readFile(join(projectRoot, 'generated/unsupported.bin'))).rejects.toThrow();
      expect(recorded).toEqual([]);
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
        return new Response(tinyMp4Bytes(), { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
      if (url === 'https://cdn.example/last-frame.avif') {
        return new Response(tinyPngBytes(), { status: 200, headers: { 'content-type': 'image/avif' } });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    try {
      const result = await executeVideoModelTestRequest({
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
      await expect(readFile(join(projectRoot, result.artifacts[1]!.projectRelativePath))).resolves.toEqual(tinyPngBytes());
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects last-frame artifacts with unsupported MIME evidence before writing files', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-unsupported-last-frame-mime-'));
    const recorded: unknown[] = [];
    const fetch: VideoModelFetch = async (url, init) => {
      if (url.endsWith('/contents/generations/tasks') && init?.method === 'POST') {
        return jsonResponse({ id: 'task-unsupported-last-frame', status: 'queued' });
      }
      if (url.endsWith('/contents/generations/tasks/task-unsupported-last-frame')) {
        return jsonResponse({
          id: 'task-unsupported-last-frame',
          status: 'succeeded',
          content: {
            video_url: 'https://cdn.example/video.mp4',
            last_frame_url: 'https://cdn.example/last-frame'
          }
        });
      }
      if (url === 'https://cdn.example/video.mp4') {
        return new Response(tinyMp4Bytes(), { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
      if (url === 'https://cdn.example/last-frame') {
        return new Response(Buffer.from('{"error":"not an image"}'), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    try {
      const result = await executeVideoModelTestRequest({
        projectRoot,
        invocationId: 'turn-video-unsupported-last-frame',
        input: {
          model: 'doubao-seedance-2-0-260128',
          arguments: {
            prompt: 'camera slowly moves across a desk',
            output_path: 'generated/primary.mp4',
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
        fetch,
        recordGeneratedAsset: async (input) => {
          recorded.push(input);
        }
      });

      expect(result).toMatchObject({
        status: 'error',
        error: 'video_request_failed'
      });
      expect(result.content).toContain('Unsupported last-frame artifact MIME type: application/json');
      await expect(readFile(join(projectRoot, 'generated/primary.mp4'))).rejects.toThrow();
      expect(recorded).toEqual([]);
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
        return new Response(tinyMp4Bytes(), { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    try {
      const result = await executeVideoModelTestRequest({
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
        modelRunId: expect.any(String),
        projectRelativePath: expect.stringMatching(/^generated\/turn-video-metadata\/.+\.mp4$/),
        artifactRole: 'primary-video',
        artifactIndex: 0,
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
            artifactIndex: 0
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
        return new Response(tinyMp4Bytes(), { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    try {
      await writeFile(join(projectRoot, 'first.png'), tinyPngBytes());
      const result = await executeVideoModelTestRequest({
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
        modelRunId: expect.any(String),
        artifactRole: 'primary-video',
        artifactIndex: 0,
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
});
