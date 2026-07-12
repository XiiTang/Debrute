import { tinyPngBytes } from '../../fixtures/mediaModelInputs';
import { executeImageModelTestRequest } from '../../helpers/imageModelTestRequests';

import type { ImageModelFetch } from '@debrute/capability-runtime';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

function pngResponse(): Response {
  return new Response(tinyPngBytes(), { status: 200, headers: { 'content-type': 'image/png' } });
}

describe('image model lifecycle', () => {
  it('aborts an OpenAI request when the model endpoint does not respond before the timeout', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-openai-timeout-'));
    const fetch: ImageModelFetch = async (_url, init) => {
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new Error('aborted'));
          return;
        }
        signal?.addEventListener(
          'abort',
          () => reject(signal.reason ?? new Error('aborted')),
          { once: true }
        );
      });
    };
    try {
      const result = await executeImageModelTestRequest(projectRoot, 'turn-openai-timeout', {
        input: { model: 'gpt-image-2', arguments: { prompt: 'cover image', size: '1024x1024' } },
        requestTimeoutMs: 5,
        fetch
      });

      expect(result.status).toBe('error');
      if (result.status !== 'error') {
        throw new Error(result.content);
      }
      expect(result.error).toBe('image_request_failed');
      expect(result.content).toContain('timed out');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('cancels a stalled OpenAI response body after the body timeout', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-openai-body-timeout-'));
    let canceled = false;
    const fetch: ImageModelFetch = async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"data":'));
        },
        cancel() {
          canceled = true;
        }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
    try {
      const result = await executeImageModelTestRequest(projectRoot, 'turn-openai-body-timeout', {
        input: { model: 'gpt-image-2', arguments: { prompt: 'cover image', size: '1024x1024' } },
        requestTimeoutMs: 5,
        fetch
      });

      expect(result.status).toBe('error');
      expect(result.content).toContain('timed out');
      expect(canceled).toBe(true);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns a body timeout when response body cancellation does not settle', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-openai-body-cancel-hang-'));
    let canceled = false;
    const fetch: ImageModelFetch = async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"data":'));
        },
        cancel() {
          canceled = true;
          return new Promise(() => undefined);
        }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
    try {
      const pending = executeImageModelTestRequest(projectRoot, 'turn-openai-body-cancel-hang', {
        input: { model: 'gpt-image-2', arguments: { prompt: 'cover image', size: '1024x1024' } },
        requestTimeoutMs: 5,
        fetch
      });
      const outcome = await pending.then((result) => ({ type: 'result' as const, result }));

      expect(canceled).toBe(true);
      expect(outcome.type).toBe('result');
      expect(outcome.result.status).toBe('error');
      expect(outcome.result.content).toContain('timed out');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('aborts an OpenAI request when the caller signal aborts', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-openai-caller-abort-'));
    const controller = new AbortController();
    const fetch: ImageModelFetch = async (_url, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason ?? new Error('aborted'));
        }, { once: true });
        queueMicrotask(() => controller.abort(new Error('caller stopped image request')));
      });
    };
    try {
      const result = await executeImageModelTestRequest(projectRoot, 'turn-openai-caller-abort', {
        input: { model: 'gpt-image-2', arguments: { prompt: 'cover image', size: '1024x1024' } },
        fetch,
        signal: controller.signal
      });

      expect(result.status).toBe('error');
      expect(result.content).toContain('caller stopped image request');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('aborts Wan polling delay when the caller signal aborts', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-wan-caller-abort-'));
    const controller = new AbortController();
    const calls: string[] = [];
    const fetch: ImageModelFetch = async (url) => {
      calls.push(url);
      if (url.endsWith('/services/aigc/image-generation/generation')) {
        return jsonResponse({ output: { task_id: 'task-1' } });
      }
      if (url.endsWith('/tasks/task-1')) {
        controller.abort(new Error('stop polling'));
        return jsonResponse({ output: { task_status: 'RUNNING' } });
      }
      return pngResponse();
    };
    try {
      const result = await executeImageModelTestRequest(projectRoot, 'turn-wan-caller-abort', {
        input: { model: 'wan2.7-image', arguments: { prompt: 'cover image' } },
        settings: { imageModels: [{ debruteModelId: 'wan2.7-image', baseUrlOverride: null, requestModelIdOverride: 'wan2.7-image' }] },
        secrets: { imageModelApiKeys: { 'wan2.7-image': 'sk-wan' } },
        pollIntervalMs: 1_000,
        wanPollMaxAttempts: 10,
        fetch,
        signal: controller.signal
      });

      expect(result.status).toBe('error');
      expect(result.content).toContain('stop polling');
      expect(calls).toEqual([
        'https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation',
        'https://dashscope.aliyuncs.com/api/v1/tasks/task-1'
      ]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns a redacted model response error when the endpoint rejects an image request', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-model-error-'));
    try {
      const result = await executeImageModelTestRequest(projectRoot, 'turn-error', {
        input: {
          model: 'gpt-image-2',
          arguments: { prompt: 'bad prompt', size: '1024x1024' }
        },
        settings: {
          imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: null }]
        },
        secrets: { imageModelApiKeys: { 'gpt-image-2': 'sk-image-secret' } },
        fetch: async () => new Response(JSON.stringify({
          error: {
            code: 'BadRequest',
            message: 'prompt rejected for sk-image-secret',
            apiKey: 'sk-image-secret'
          }
        }), {
          status: 400,
          headers: { 'content-type': 'application/json' }
        })
      });

      expect(result.status).toBe('error');
      if (result.status !== 'error') {
        throw new Error(result.content);
      }
      expect(result.error).toBe('request_failed');
      expect(result.content).toBe('Image request failed: model endpoint responded with HTTP 400.');
      expect(result.logs).toContainEqual(expect.objectContaining({
        stage: 'error',
        endpointResponse: {
          status: 400,
          body: {
            error: {
              code: 'BadRequest',
              message: 'prompt rejected for [redacted]',
              apiKey: '[redacted]'
            }
          }
        }
      }));
      expect(JSON.stringify(result)).not.toContain('sk-image-secret');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns an error without external fetch when the model is disabled', async () => {
    let called = false;
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-disabled-'));
    try {
      const result = await executeImageModelTestRequest(projectRoot, 'turn-1', {
        input: { model: 'gpt-image-2', arguments: { prompt: 'cover image' } },
        settings: { imageModels: [{ debruteModelId: 'gpt-image-2', baseUrlOverride: null, requestModelIdOverride: 'gpt-image-2' }] },
        secrets: { imageModelApiKeys: {} },
        fetch: async () => {
          called = true;
          return new Response('{}');
        }
      });

      expect(result.status).toBe('error');
      expect(called).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
