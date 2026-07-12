import { tinyMp4Bytes } from '../../fixtures/mediaModelInputs';
import { executeVideoModelTestRequest } from '../../helpers/videoModelTestRequests';

import type { VideoModelFetch } from '@debrute/capability-runtime';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('video model lifecycle', () => {
  it('applies video timeout to the whole task polling operation', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-operation-timeout-'));
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
      const result = await executeVideoModelTestRequest({
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
        fetch
      });

      expect(pollCount).toBeGreaterThan(0);
      expect(result.status).toBe('error');
      if (result.status !== 'error') {
        throw new Error(result.content);
      }
      expect(result.error).toBe('video_request_failed');
      expect(result.content).toContain('Video request timed out after 25ms');
    } finally {
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
      const pending = executeVideoModelTestRequest({
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
      const outcome = await pending.then((result) => ({ type: 'result' as const, result }));

      expect(canceled).toBe(true);
      expect(outcome.type).toBe('result');
      expect(outcome.result.status).toBe('error');
      if (outcome.result.status !== 'error') {
        throw new Error(outcome.result.content);
      }
      expect(outcome.result.error).toBe('video_request_failed');
      expect(outcome.result.content).toContain('timed out');
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
            controller.enqueue(tinyMp4Bytes());
          },
          cancel() {
            canceled = true;
          }
        }),
        { status: 200, headers: { 'content-type': 'video/mp4' } }
      );
    };
    try {
      const pending = executeVideoModelTestRequest({
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
      const outcome = await pending.then((result) => ({ type: 'result' as const, result }));

      expect(canceled).toBe(true);
      expect(outcome.type).toBe('result');
      expect(outcome.result.status).toBe('error');
      if (outcome.result.status !== 'error') {
        throw new Error(outcome.result.content);
      }
      expect(outcome.result.error).toBe('video_request_failed');
      expect(outcome.result.content).toContain('timed out');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns a redacted model response error when the endpoint rejects a video request', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-model-error-'));
    try {
      const result = await executeVideoModelTestRequest({
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
      if (result.status !== 'error') {
        throw new Error(result.content);
      }
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

  it('passes the operation timeout signal to artifact writes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-write-timeout-'));
    const writeSignals: Array<AbortSignal | undefined> = [];
    vi.resetModules();
    vi.doMock('@debrute/project-core', async (importOriginal) => {
      const original = await importOriginal<typeof import('@debrute/project-core')>();
      return {
        ...original,
        writeProjectFile: async (
          projectRoot: string,
          projectRelativePath: string,
          content: string | Uint8Array,
          options?: { signal?: AbortSignal }
        ) => {
          writeSignals.push(options?.signal);
          await new Promise<void>((_resolve, reject) => {
            const onAbort = () => {
              reject(options?.signal?.reason ?? new Error('write aborted'));
            };
            if (options?.signal?.aborted) {
              onAbort();
              return;
            }
            options?.signal?.addEventListener('abort', onAbort, { once: true });
          });
          return original.writeProjectFile(projectRoot, projectRelativePath, content);
        }
      };
    });
    const { executeVideoModelRequest: executeVideoModelRequestWithTrackedWrites } = await import('@debrute/capability-runtime');
    const fetch: VideoModelFetch = async (url, init) => {
      if (url.endsWith('/contents/generations/tasks') && init?.method === 'POST') {
        return jsonResponse({ id: 'task-write-timeout', status: 'queued' });
      }
      if (url.endsWith('/contents/generations/tasks/task-write-timeout')) {
        return jsonResponse({
          id: 'task-write-timeout',
          status: 'succeeded',
          content: { video_url: 'https://cdn.example/video.mp4' }
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    try {
      const result = await executeVideoModelRequestWithTrackedWrites({
        projectRoot,
        invocationId: 'turn-video-write-timeout',
        input: {
          model: 'doubao-seedance-2-0-260128',
          timeoutMs: 100,
          arguments: { prompt: 'cover video', output_path: 'generated/timeout.mp4' }
        },
        settings: {
          videoModels: [{ debruteModelId: 'doubao-seedance-2-0-260128', baseUrlOverride: null, requestModelIdOverride: null }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
        pollIntervalMs: 0,
        remoteUrlLookup: async (hostname) => {
          expect(hostname).toBe('cdn.example');
          return [{ address: '93.184.216.34', family: 4 }];
        },
        remoteHttpTransport: async (input) => {
          expect(input.url).toBe('https://cdn.example/video.mp4');
          return new Response(tinyMp4Bytes(), { status: 200, headers: { 'content-type': 'video/mp4' } });
        },
        fetch
      });

      expect(writeSignals).toHaveLength(1);
      expect(writeSignals[0]).toBeInstanceOf(AbortSignal);
      expect(result.status).toBe('error');
      expect(result.content).toContain('Video request timed out after 100ms');
      await expect(readFile(join(projectRoot, 'generated/timeout.mp4'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      vi.doUnmock('@debrute/project-core');
      vi.resetModules();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
