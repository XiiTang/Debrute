import { tinyMp4Bytes, tinyPngBase64, tinyPngBytes } from '../../fixtures/mediaModelInputs';
import { executeVideoModelRequestAndCaptureBody, executeVideoModelTestRequest } from '../../helpers/videoModelTestRequests';

import type { VideoModelFetch } from '@debrute/capability-runtime';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('video model providers', () => {
  it('submits, polls, downloads, and writes a Seedance mp4 artifact', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-seedance-'));
    const calls: string[] = [];
    const recorded: unknown[] = [];
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
        return new Response(tinyMp4Bytes(), { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
      if (url === 'https://cdn.example/last-frame.png') {
        return new Response(tinyPngBytes(), { status: 200, headers: { 'content-type': 'image/png' } });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    try {
      const result = await executeVideoModelTestRequest({
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
        fetch,
        recordGeneratedAsset: async (input) => {
          recorded.push(input);
        }
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
      await expect(readFile(join(projectRoot, result.artifacts[0]!.projectRelativePath))).resolves.toEqual(tinyMp4Bytes());
      expect(recorded).toEqual([
        expect.objectContaining({ artifactRole: 'primary-video', artifactIndex: 0 }),
        expect.objectContaining({ artifactRole: 'last-frame', artifactIndex: 1 })
      ]);
      expect((recorded[0] as { modelRunId: string }).modelRunId).toBe((recorded[1] as { modelRunId: string }).modelRunId);
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
        return new Response(tinyMp4Bytes(), { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    try {
      const result = await executeVideoModelTestRequest({
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
        return new Response(tinyMp4Bytes(), { status: 200, headers: { 'content-type': 'video/mp4' } });
      };

      const result = await executeVideoModelTestRequest({
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

  it('builds Seedance content from Debrute-native generate intent', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-generate-routing-'));
    try {
      await writeFile(join(projectRoot, 'first.png'), tinyPngBytes());
      await writeFile(join(projectRoot, 'last.png'), tinyPngBytes());

      const textOnly = await executeVideoModelRequestAndCaptureBody({
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

      const firstFrame = await executeVideoModelRequestAndCaptureBody({
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

      const firstLast = await executeVideoModelRequestAndCaptureBody({
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
});
