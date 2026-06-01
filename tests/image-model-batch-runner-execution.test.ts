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
    const tempDir = await mkdtemp(join(tmpdir(), 'axis-batch-runner-'));
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
    const tempDir = await mkdtemp(join(tmpdir(), 'axis-batch-skip-'));
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

  test('retries item-local failures and preserves structured final errors', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'axis-batch-retry-'));
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

  test('propagates unexpected executor throws without rewriting them as failed item results', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'axis-batch-throw-'));
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
