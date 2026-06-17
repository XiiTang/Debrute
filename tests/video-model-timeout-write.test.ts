import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const tinyMp4 = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
const writeSignals = vi.hoisted(() => [] as Array<AbortSignal | undefined>);

vi.mock('@debrute/project-core', async (importOriginal) => {
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
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(options?.signal?.reason ?? new Error('write aborted'));
        };
        const timer = setTimeout(() => {
          options?.signal?.removeEventListener('abort', onAbort);
          resolve();
        }, 40);
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

const { executeVideoModelRequest } = await import('@debrute/capability-runtime');
type VideoModelFetch = NonNullable<Parameters<typeof executeVideoModelRequest>[0]['fetch']>;

describe('video model artifact write timeout', () => {
  it('passes the operation timeout signal to artifact writes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-write-timeout-'));
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
      if (url === 'https://cdn.example/video.mp4') {
        return new Response(tinyMp4, { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    try {
      const result = await executeVideoModelRequest({
        projectRoot,
        invocationId: 'turn-video-write-timeout',
        input: {
          model: 'doubao-seedance-2-0-260128',
          timeoutMs: 5,
          arguments: { prompt: 'cover video', output_path: 'generated/timeout.mp4' }
        },
        settings: {
          videoModels: [{ debruteModelId: 'doubao-seedance-2-0-260128', requestModelIdOverride: null }]
        },
        secrets: { videoModelApiKeys: { 'doubao-seedance-2-0-260128': 'sk-video' } },
        pollIntervalMs: 0,
        fetch
      });

      expect(writeSignals).toHaveLength(1);
      expect(writeSignals[0]).toBeInstanceOf(AbortSignal);
      expect(result.status).toBe('error');
      expect(result.content).toContain('Video request timed out after 5ms');
      await expect(readFile(join(projectRoot, 'generated/timeout.mp4'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      writeSignals.length = 0;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}
