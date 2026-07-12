import { tinyMp4Bytes } from '../../fixtures/mediaModelInputs';
import { executeVideoModelTestRequest } from '../../helpers/videoModelTestRequests';

import type { PublicRemoteHostLookup, VideoModelFetch } from '@debrute/capability-runtime';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const privateRemoteLookup: PublicRemoteHostLookup = async () => [{ address: '169.254.169.254', family: 4 }];

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('video model remote policy', () => {
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
      return new Response(tinyMp4Bytes(), { status: 200, headers: { 'content-type': 'video/mp4' } });
    };
    try {
      const result = await executeVideoModelTestRequest({
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
      if (result.status !== 'error') {
        throw new Error(result.content);
      }
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
      const result = await executeVideoModelTestRequest({
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
      const result = await executeVideoModelTestRequest({
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
          return new Response(tinyMp4Bytes(), { status: 200, headers: { 'content-type': 'video/mp4' } });
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

  it('rejects loopback video reference URLs before upstream requests', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-loopback-reference-'));
    let modelRuned = false;
    try {
      const result = await executeVideoModelTestRequest({
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
      if (result.status !== 'error') {
        throw new Error(result.content);
      }
      expect(result.error).toBe('video_argument_invalid');
      expect(result.content).toBe('Remote video reference URLs must not target local or private network hosts: http://127.0.0.1/private.png');
      expect(modelRuned).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects bracketed IPv6 video reference URLs before upstream requests', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-ipv6-reference-'));
    try {
      const result = await executeVideoModelTestRequest({
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
});
