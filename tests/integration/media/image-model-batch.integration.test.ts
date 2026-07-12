import { tinyPngBase64 } from '../../fixtures/mediaModelInputs';
import { runImageModelBatch } from '../../../apps/app-server/src/models/ImageModelBatchService';
import type { ImageModelBatchRunnerDependencies } from '../../../apps/app-server/src/models/ImageModelBatchService';
import { DebruteAppServer, GlobalConfigStore } from '@debrute/app-server';
import type { ImageModelFetch } from '@debrute/capability-runtime';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, test } from 'vitest';

describe('image model batch runner execution', () => {
  function resolvedBatchOutput(logPath: string, summaryPath?: string) {
    return {
      logPath,
      logProjectRelativePath: 'results.jsonl',
      ...(summaryPath ? { summaryPath, summaryProjectRelativePath: 'summary.json' } : {})
    };
  }

  test('runs a fixed global concurrency queue and writes result JSONL plus summary', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'debrute-batch-runner-'));
    const logPath = join(tempDir, 'results.jsonl');
    const summaryPath = join(tempDir, 'summary.json');
    const reachedLimit = deferred<void>();
    const release = deferred<void>();
    let active = 0;
    let maxActive = 0;
    const dependencies: ImageModelBatchRunnerDependencies = {
      projectFileExistsWithContent: async () => false,
      executeImageModelRequest: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (active === 2) reachedLimit.resolve();
        await release.promise;
        active -= 1;
        return { status: 'ok', artifacts: [] };
      }
    };

    try {
      const pending = runImageModelBatch({
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
        ...resolvedBatchOutput(logPath, summaryPath)
      }, dependencies);
      await reachedLimit.promise;
      release.resolve();
      const summary = await pending;

      expect(maxActive).toBe(2);
      expect(summary).toMatchObject({
        total: 3,
        okCount: 3,
        skippedCount: 0,
        failedCount: 0,
        concurrency: 2,
        retries: 0,
        logPath: 'results.jsonl',
        summaryPath: 'summary.json'
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
        ...resolvedBatchOutput(logPath)
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
        ...resolvedBatchOutput(logPath)
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
        ...resolvedBatchOutput(logPath)
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
        ...resolvedBatchOutput(logPath)
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
        ...resolvedBatchOutput(logPath)
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
        ...resolvedBatchOutput(logPath)
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
        ...resolvedBatchOutput(logPath)
      }, dependencies)).rejects.toMatchObject({
        code: 'project_reference_missing',
        message: 'project reference is missing'
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function configureBatchImageModel(configStore: GlobalConfigStore, apiKey: string): Promise<void> {
  await configStore.mutateGlobalSettings({
    kind: 'patch',
    input: {
      models: {
        image: {
          modelId: 'gpt-image-2',
          setting: {
            baseUrlOverride: null,
            requestModelIdOverride: 'gpt-image-2',
            apiKey
          }
        }
      }
    }
  });
}

describe('DebruteAppServer image model batch', () => {
  test('runs a batch through configured image model execution and records generated metadata', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-batch-project-'));
    const debruteHome = await mkdtemp(join(tmpdir(), 'debrute-app-server-batch-home-'));
    const logPath = 'batch-results.jsonl';
    const summaryPath = 'batch-summary.json';
    const configStore = new GlobalConfigStore({ debruteHome });
    await configureBatchImageModel(configStore, 'sk-image');
    const fetch: ImageModelFetch = async (url, init) => {
      expect(url).toBe('https://api.openai.com/v1/images/generations');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'gpt-image-2',
        prompt: 'batch cover'
      });
      return jsonResponse({ data: [{ b64_json: tinyPngBase64 }] });
    };
    const server = new DebruteAppServer({
      globalConfigStore: configStore,
      imageModelFetch: fetch
    });

    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: false
      });
      const summary = await server.runImageModelBatch({
        source: {
          kind: 'requests',
          requests: [
            {
              model: 'gpt-image-2',
              arguments: {
                prompt: 'batch cover',
                size: '1024x1024',
                output_path: 'generated/batch-cover.png'
              },
              outputPath: 'generated/batch-cover.png'
            }
          ]
        },
        concurrency: 1,
        retries: 0,
        logPath,
        summaryPath
      });

      expect(summary).toMatchObject({
        total: 1,
        okCount: 1,
        skippedCount: 0,
        failedCount: 0,
        concurrency: 1,
        retries: 0,
        logPath,
        summaryPath
      });
      const [result] = (await readFile(join(projectRoot, logPath), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(result).toMatchObject({
        status: 'ok',
        index: 1,
        model: 'gpt-image-2',
        outputPath: 'generated/batch-cover.png'
      });
      await expect(readFile(join(projectRoot, 'generated/batch-cover.png'))).resolves.toBeInstanceOf(Buffer);
      const lookup = await server.lookupGeneratedAssetMetadata({ projectRelativePath: 'generated/batch-cover.png' });
      expect(lookup.status).toBe('matched');
      if (lookup.status === 'matched') {
        expect(lookup.records).toHaveLength(1);
        expect(lookup.records[0]).toMatchObject({
          modelRun: {
            request: {
              body: {
                prompt: 'batch cover'
              }
            }
          }
        });
      }
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
      await rm(debruteHome, { recursive: true, force: true });
    }
  });

  test('rejects image batch absolute and symlinked output paths before creating files', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-batch-boundary-project-'));
    const debruteHome = await mkdtemp(join(tmpdir(), 'debrute-app-server-batch-boundary-home-'));
    const externalRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-batch-boundary-external-'));
    const server = new DebruteAppServer({
      globalConfigStore: new GlobalConfigStore({ debruteHome }),
      imageModelFetch: async () => {
        throw new Error('model request should not run for invalid batch paths');
      }
    });

    try {
      await mkdir(join(projectRoot, 'batch'), { recursive: true });
      await symlink(externalRoot, join(projectRoot, 'batch/outside'), directoryLinkType());
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: false
      });

      const baseInput = {
        source: { kind: 'requests' as const, requests: [{ model: 'gpt-image-2', arguments: { prompt: 'blocked' } }] },
        concurrency: 1,
        retries: 0
      };

      await expect(server.runImageModelBatch({
        ...baseInput,
        logPath: '/tmp/results.jsonl'
      })).rejects.toThrow('Project path must be relative');

      await expect(server.runImageModelBatch({
        ...baseInput,
        logPath: 'batch/outside/results.jsonl'
      })).rejects.toThrow('Project path escapes project root through a symlink');

      await expect(server.runImageModelBatch({
        ...baseInput,
        source: { kind: 'jsonl', path: '/tmp/requests.jsonl' },
        logPath: 'batch/results.jsonl'
      })).rejects.toThrow('Project path must be relative');

      await expect(access(join(externalRoot, 'results.jsonl'))).rejects.toBeDefined();
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
      await rm(debruteHome, { recursive: true, force: true });
      await rm(externalRoot, { recursive: true, force: true });
    }
  });

  test('does not record generated asset metadata for skipped batch outputs', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-batch-skip-project-'));
    const debruteHome = await mkdtemp(join(tmpdir(), 'debrute-app-server-batch-skip-home-'));
    const logPath = 'batch-results.jsonl';
    const server = new DebruteAppServer({
      globalConfigStore: new GlobalConfigStore({ debruteHome }),
      imageModelFetch: async () => {
        throw new Error('model request should not run for skipped output');
      }
    });

    try {
      await mkdir(join(projectRoot, 'generated'), { recursive: true });
      await writeFile(join(projectRoot, 'generated/existing.png'), Buffer.from('existing'));
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: false
      });

      const summary = await server.runImageModelBatch({
        source: {
          kind: 'requests',
          requests: [
            {
              model: 'gpt-image-2',
              arguments: {
                prompt: 'skip existing',
                output_path: 'generated/existing.png'
              },
              outputPath: 'generated/existing.png'
            }
          ]
        },
        concurrency: 1,
        retries: 0,
        logPath
      });

      expect(summary).toMatchObject({
        total: 1,
        okCount: 0,
        skippedCount: 1,
        failedCount: 0
      });
      const lookup = await server.lookupGeneratedAssetMetadata({ projectRelativePath: 'generated/existing.png' });
      expect(lookup.status).toBe('unmatched');
      await expect(access(join(projectRoot, '.debrute/assets/generated-assets-index.json'))).rejects.toMatchObject({
        code: 'ENOENT'
      });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
      await rm(debruteHome, { recursive: true, force: true });
    }
  });

  test('overwrites existing batch outputs through app-server input', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-batch-overwrite-project-'));
    const debruteHome = await mkdtemp(join(tmpdir(), 'debrute-app-server-batch-overwrite-home-'));
    const logPath = 'batch-results.jsonl';
    const configStore = new GlobalConfigStore({ debruteHome });
    await configureBatchImageModel(configStore, 'sk-image');
    let executions = 0;
    const server = new DebruteAppServer({
      globalConfigStore: configStore,
      imageModelFetch: async () => {
        executions += 1;
        return jsonResponse({ data: [{ b64_json: tinyPngBase64 }] });
      }
    });

    try {
      await mkdir(join(projectRoot, 'generated'), { recursive: true });
      await writeFile(join(projectRoot, 'generated/existing.png'), Buffer.from('existing'));
      await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: false });

      const summary = await server.runImageModelBatch({
        source: {
          kind: 'requests',
          requests: [{
            model: 'gpt-image-2',
            arguments: { prompt: 'overwrite', output_path: 'generated/existing.png' },
            outputPath: 'generated/existing.png'
          }]
        },
        concurrency: 1,
        retries: 0,
        timeoutMs: 900000,
        overwriteExisting: true,
        logPath
      });

      expect(executions).toBe(1);
      expect(summary).toMatchObject({ okCount: 1, skippedCount: 0, failedCount: 0 });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
      await rm(debruteHome, { recursive: true, force: true });
    }
  });

  test('does not read image model configuration when every batch output is skipped', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-batch-skip-config-project-'));
    const logPath = 'batch-results.jsonl';
    class ThrowingImageConfigStore extends GlobalConfigStore {
      override async readGlobalSnapshot(): ReturnType<GlobalConfigStore['readGlobalSnapshot']> {
        throw new Error('global model settings should not be read for skipped outputs');
      }
    }
    const server = new DebruteAppServer({
      globalConfigStore: new ThrowingImageConfigStore(),
      imageModelFetch: async () => {
        throw new Error('model request should not run for skipped output');
      }
    });

    try {
      await mkdir(join(projectRoot, 'generated'), { recursive: true });
      await writeFile(join(projectRoot, 'generated/existing.png'), Buffer.from('existing'));
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: false
      });

      const summary = await server.runImageModelBatch({
        source: {
          kind: 'requests',
          requests: [
            {
              model: 'gpt-image-2',
              arguments: {
                prompt: 'skip existing',
                output_path: 'generated/existing.png'
              },
              outputPath: 'generated/existing.png'
            }
          ]
        },
        concurrency: 1,
        retries: 0,
        logPath
      });

      expect(summary).toMatchObject({
        total: 1,
        okCount: 0,
        skippedCount: 1,
        failedCount: 0
      });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test('does not record generated asset metadata for failed batch items', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-batch-failed-project-'));
    const debruteHome = await mkdtemp(join(tmpdir(), 'debrute-app-server-batch-failed-home-'));
    const logPath = 'batch-results.jsonl';
    const configStore = new GlobalConfigStore({ debruteHome });
    await configureBatchImageModel(configStore, 'sk-image');
    const server = new DebruteAppServer({
      globalConfigStore: configStore,
      imageModelFetch: async () => jsonResponse({ error: { message: 'model endpoint rejected request' } }, 500)
    });

    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: false
      });

      const summary = await server.runImageModelBatch({
        source: {
          kind: 'requests',
          requests: [
            {
              model: 'gpt-image-2',
              arguments: {
                prompt: 'will fail',
                output_path: 'generated/failed.png'
              },
              outputPath: 'generated/failed.png'
            }
          ]
        },
        concurrency: 1,
        retries: 0,
        logPath
      });

      expect(summary).toMatchObject({
        total: 1,
        okCount: 0,
        skippedCount: 0,
        failedCount: 1
      });
      const [result] = (await readFile(join(projectRoot, logPath), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(result).toMatchObject({
        status: 'failed',
        outputPath: 'generated/failed.png'
      });
      await expect(access(join(projectRoot, 'generated/failed.png'))).rejects.toMatchObject({
        code: 'ENOENT'
      });
      await expect(access(join(projectRoot, '.debrute/assets/generated-assets-index.json'))).rejects.toMatchObject({
        code: 'ENOENT'
      });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
      await rm(debruteHome, { recursive: true, force: true });
    }
  });

  test('redacts active image API keys from failed batch JSONL output', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-app-server-batch-redaction-project-'));
    const debruteHome = await mkdtemp(join(tmpdir(), 'debrute-app-server-batch-redaction-home-'));
    const logPath = 'batch-results.jsonl';
    const configStore = new GlobalConfigStore({ debruteHome });
    await configureBatchImageModel(configStore, 'sk-image-batch-secret');
    const server = new DebruteAppServer({
      globalConfigStore: configStore,
      imageModelFetch: async () => new Response(JSON.stringify({
        error: {
          message: 'provider echoed sk-image-batch-secret',
          apiKey: 'sk-image-batch-secret'
        }
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' }
      })
    });

    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: false
      });

      await server.runImageModelBatch({
        source: {
          kind: 'requests',
          requests: [{
            model: 'gpt-image-2',
            arguments: {
              prompt: 'will fail',
              output_path: 'generated/failed.png'
            },
            outputPath: 'generated/failed.png'
          }]
        },
        concurrency: 1,
        retries: 0,
        logPath
      });

      const content = await readFile(join(projectRoot, logPath), 'utf8');
      expect(content).toContain('[redacted]');
      expect(content).not.toContain('sk-image-batch-secret');
      const [result] = content.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(result).toMatchObject({
        status: 'failed',
        error: {
          code: 'request_failed'
        }
      });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
      await rm(debruteHome, { recursive: true, force: true });
    }
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function directoryLinkType(): 'dir' | 'junction' {
  return process.platform === 'win32' ? 'junction' : 'dir';
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('DebruteAppServer image model batch paths', () => {
  it('rejects batch log paths that target protected project metadata', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-batch-log-path-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true,
        watchFiles: false
      });

      for (const logPath of PROTECTED_BATCH_OUTPUT_PATHS) {
        await expect(server.runImageModelBatch(imageBatchInput({
          logPath
        }))).rejects.toThrow(/Project path is (not visible in the Project Tree|protected by the Project Document System)/);
      }
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects batch summary paths that target protected project metadata', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-batch-summary-path-'));
    const server = new DebruteAppServer();
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true,
        watchFiles: false
      });

      for (const summaryPath of PROTECTED_BATCH_OUTPUT_PATHS) {
        await expect(server.runImageModelBatch(imageBatchInput({
          logPath: 'batch/results.jsonl',
          summaryPath
        }))).rejects.toThrow(/Project path is (not visible in the Project Tree|protected by the Project Document System)/);
      }
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('allows visible batch log and summary paths', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-image-batch-visible-paths-'));
    const debruteHome = await mkdtemp(join(tmpdir(), 'debrute-image-batch-visible-paths-home-'));
    const server = new DebruteAppServer({
      globalConfigStore: new GlobalConfigStore({ debruteHome })
    });
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true,
        watchFiles: false
      });

      const summary = await server.runImageModelBatch(imageBatchInput({
        logPath: 'batch/results.jsonl',
        summaryPath: 'batch/summary.json'
      }));

      expect(summary).toMatchObject({
        total: 1,
        failedCount: 1,
        logPath: 'batch/results.jsonl',
        summaryPath: 'batch/summary.json'
      });
      expect(await readFile(join(projectRoot, 'batch/results.jsonl'), 'utf8')).toContain('"status":"failed"');
      expect(JSON.parse(await readFile(join(projectRoot, 'batch/summary.json'), 'utf8'))).toMatchObject({
        total: 1,
        failedCount: 1,
        logPath: 'batch/results.jsonl',
        summaryPath: 'batch/summary.json'
      });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
      await rm(debruteHome, { recursive: true, force: true });
    }
  });
});

const PROTECTED_BATCH_OUTPUT_PATHS = ['.git/config', '.debrute/project.json'] as const;

function imageBatchInput(input: { logPath: string; summaryPath?: string }) {
  return {
    source: {
      kind: 'requests' as const,
      requests: [{
        model: 'missing-image-model',
        arguments: { prompt: 'test' }
      }]
    },
    concurrency: 1,
    retries: 0,
    logPath: input.logPath,
    ...(input.summaryPath === undefined ? {} : { summaryPath: input.summaryPath })
  };
}
