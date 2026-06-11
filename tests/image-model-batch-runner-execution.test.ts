import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  runImageModelBatch,
  type ImageModelBatchRunnerDependencies
} from '../apps/app-server/src/models/ImageModelBatchService';

describe('image model batch runner execution', () => {
  test('runs a fixed global concurrency queue and writes result JSONL plus summary', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'debrute-batch-runner-'));
    const logPath = join(tempDir, 'results.jsonl');
    const summaryPath = join(tempDir, 'summary.json');
    let active = 0;
    let maxActive = 0;
    const dependencies: ImageModelBatchRunnerDependencies = {
      projectFileExistsWithContent: async () => false,
      executeImageModelRequest: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { status: 'ok', artifacts: [] };
      }
    };

    try {
      const summary = await runImageModelBatch({
        source: {
          kind: 'requests',
          requests: [
            { model: 'gpt-image-2', arguments: { prompt: 'one', output_path: 'generated/one.png' } },
            { model: 'gpt-image-2', arguments: { prompt: 'two', output_path: 'generated/two.png' } },
            { model: 'gpt-image-2', arguments: { prompt: 'three', output_path: 'generated/three.png' } }
          ]
        },
        concurrency: 2,
        retries: 0,
        logPath,
        summaryPath
      }, dependencies);

      expect(maxActive).toBe(2);
      expect(summary).toMatchObject({
        total: 3,
        okCount: 3,
        skippedCount: 0,
        failedCount: 0,
        concurrency: 2,
        retries: 0,
        logPath,
        summaryPath
      });
      const resultLines = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(resultLines).toHaveLength(3);
      expect(resultLines.every((line) => line.status === 'ok')).toBe(true);
      await expect(readFile(summaryPath, 'utf8')).resolves.toContain('"okCount": 3');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('skips existing outputs before executing image requests', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'debrute-batch-skip-'));
    const logPath = join(tempDir, 'results.jsonl');
    let executions = 0;
    const dependencies: ImageModelBatchRunnerDependencies = {
      projectFileExistsWithContent: async ({ projectRelativePath }) => projectRelativePath === 'generated/existing.png',
      executeImageModelRequest: async () => {
        executions += 1;
        return { status: 'ok', artifacts: [] };
      }
    };

    try {
      const summary = await runImageModelBatch({
        source: {
          kind: 'requests',
          requests: [
            { model: 'gpt-image-2', arguments: { prompt: 'skip', output_path: 'generated/existing.png' } },
            { model: 'gpt-image-2', arguments: { prompt: 'run', output_path: 'generated/new.png' } }
          ]
        },
        concurrency: 2,
        retries: 0,
        logPath
      }, dependencies);

      expect(executions).toBe(1);
      expect(summary).toMatchObject({ total: 2, okCount: 1, skippedCount: 1, failedCount: 0 });
      const resultLines = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(resultLines).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'skipped', reason: 'output_exists', outputPath: 'generated/existing.png' }),
        expect.objectContaining({ status: 'ok', outputPath: 'generated/new.png' })
      ]));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('overwrites existing outputs when requested and emits progress snapshots', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'debrute-batch-overwrite-progress-'));
    const logPath = join(tempDir, 'results.jsonl');
    const progress: unknown[] = [];
    let executions = 0;
    const dependencies: ImageModelBatchRunnerDependencies = {
      projectFileExistsWithContent: async () => true,
      executeImageModelRequest: async () => {
        executions += 1;
        return { status: 'ok', artifacts: [] };
      }
    };

    try {
      const summary = await runImageModelBatch({
        source: {
          kind: 'requests',
          requests: [
            { model: 'gpt-image-2', arguments: { prompt: 'one', output_path: 'generated/one.png' } },
            { model: 'gpt-image-2', arguments: { prompt: 'two', output_path: 'generated/two.png' } }
          ]
        },
        concurrency: 1,
        retries: 0,
        timeoutMs: 900000,
        overwriteExisting: true,
        logPath
      }, dependencies, {
        onProgress: (event) => progress.push(event)
      });

      expect(executions).toBe(2);
      expect(summary).toMatchObject({ total: 2, okCount: 2, skippedCount: 0, failedCount: 0 });
      expect(progress).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'started',
          snapshot: expect.objectContaining({ total: 2, done: 0, active: 0 })
        }),
        expect.objectContaining({
          type: 'item_finished',
          snapshot: expect.objectContaining({ total: 2, done: 2, okCount: 2, skippedCount: 0, failedCount: 0 })
        })
      ]));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('retries item-local failures and preserves structured final errors', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'debrute-batch-retry-'));
    const logPath = join(tempDir, 'results.jsonl');
    let attempts = 0;
    const dependencies: ImageModelBatchRunnerDependencies = {
      projectFileExistsWithContent: async () => false,
      executeImageModelRequest: async () => {
        attempts += 1;
        return {
          status: 'failed',
          error: {
            code: 'image_request_failed',
            message: `failed attempt ${attempts}`
          }
        };
      }
    };

    try {
      const summary = await runImageModelBatch({
        source: {
          kind: 'requests',
          requests: [
            { model: 'gpt-image-2', arguments: { prompt: 'will fail' } }
          ]
        },
        concurrency: 1,
        retries: 2,
        logPath
      }, dependencies);

      expect(attempts).toBe(3);
      expect(summary).toMatchObject({ total: 1, okCount: 0, skippedCount: 0, failedCount: 1, retries: 2 });
      const [result] = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(result).toMatchObject({
        status: 'failed',
        attempt: 3,
        error: {
          code: 'image_request_failed',
          message: 'failed attempt 3'
        }
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('lets item-level timeout override the batch default timeout', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'debrute-batch-item-timeout-'));
    const logPath = join(tempDir, 'results.jsonl');
    const seenTimeouts: Array<number | undefined> = [];
    const dependencies: ImageModelBatchRunnerDependencies = {
      projectFileExistsWithContent: async () => false,
      executeImageModelRequest: async (request) => {
        seenTimeouts.push(request.timeoutMs);
        return { status: 'ok', artifacts: [] };
      }
    };

    try {
      await runImageModelBatch({
        source: {
          kind: 'requests',
          requests: [
            { model: 'gpt-image-2', timeoutMs: 123, arguments: { prompt: 'item timeout' } },
            { model: 'gpt-image-2', arguments: { prompt: 'batch timeout' } }
          ]
        },
        concurrency: 1,
        retries: 0,
        timeoutMs: 900000,
        logPath
      }, dependencies);

      expect(seenTimeouts).toEqual([123, 900000]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('defaults batch item attempts to 900000ms when no timeout is provided', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'debrute-batch-default-timeout-'));
    const logPath = join(tempDir, 'results.jsonl');
    const seenTimeouts: Array<number | undefined> = [];
    const dependencies: ImageModelBatchRunnerDependencies = {
      projectFileExistsWithContent: async () => false,
      executeImageModelRequest: async (request) => {
        seenTimeouts.push(request.timeoutMs);
        return { status: 'ok', artifacts: [] };
      }
    };

    try {
      await runImageModelBatch({
        source: {
          kind: 'requests',
          requests: [
            { model: 'gpt-image-2', arguments: { prompt: 'batch default timeout' } }
          ]
        },
        concurrency: 1,
        retries: 0,
        logPath
      }, dependencies);

      expect(seenTimeouts).toEqual([900000]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('aborts each batch item attempt when its timeout expires', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'debrute-batch-attempt-timeout-'));
    const logPath = join(tempDir, 'results.jsonl');
    let sawAbort = false;
    const dependencies: ImageModelBatchRunnerDependencies = {
      projectFileExistsWithContent: async () => false,
      executeImageModelRequest: async (request) => {
        const signal = (request as { signal?: AbortSignal }).signal;
        if (!signal) {
          return {
            status: 'failed',
            error: {
              code: 'image_request_failed',
              message: 'missing batch attempt signal'
            }
          };
        }
        return await new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            sawAbort = true;
            resolve({
              status: 'failed',
              error: {
                code: 'image_request_failed',
                message: signal.reason instanceof Error ? signal.reason.message : String(signal.reason)
              }
            });
          }, { once: true });
        });
      }
    };

    try {
      const summary = await runImageModelBatch({
        source: {
          kind: 'requests',
          requests: [
            { model: 'gpt-image-2', arguments: { prompt: 'will timeout' } }
          ]
        },
        concurrency: 1,
        retries: 0,
        timeoutMs: 5,
        logPath
      }, dependencies);

      expect(summary).toMatchObject({ total: 1, okCount: 0, failedCount: 1 });
      expect(sawAbort).toBe(true);
      const [result] = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(result).toMatchObject({
        status: 'failed',
        attempt: 1,
        error: {
          code: 'image_request_failed',
          message: 'Image batch item 1 attempt 1 timed out after 5ms.'
        }
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('propagates unexpected executor throws without rewriting them as failed item results', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'debrute-batch-throw-'));
    const logPath = join(tempDir, 'results.jsonl');
    const executorError = Object.assign(new Error('project reference is missing'), {
      code: 'project_reference_missing'
    });
    const dependencies: ImageModelBatchRunnerDependencies = {
      projectFileExistsWithContent: async () => false,
      executeImageModelRequest: async () => {
        throw executorError;
      }
    };

    try {
      await expect(runImageModelBatch({
        source: {
          kind: 'requests',
          requests: [
            { model: 'gpt-image-2', arguments: { prompt: 'will throw' } }
          ]
        },
        concurrency: 1,
        retries: 0,
        logPath
      }, dependencies)).rejects.toMatchObject({
        code: 'project_reference_missing',
        message: 'project reference is missing'
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
