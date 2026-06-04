import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AxisAppServer, GlobalConfigStore } from '@axis/app-server';
import type { ImageModelFetch } from '@axis/capability-runtime';
import { describe, expect, test } from 'vitest';

const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8AARQAHSQGmK3P7WAAAAABJRU5ErkJggg==';

describe('AxisAppServer image model batch', () => {
  test('runs a batch through configured image model execution and records generated metadata', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-batch-project-'));
    const axisHome = await mkdtemp(join(tmpdir(), 'axis-app-server-batch-home-'));
    const logPath = join(projectRoot, 'batch-results.jsonl');
    const summaryPath = join(projectRoot, 'batch-summary.json');
    const configStore = new GlobalConfigStore({ axisHome });
    await configStore.saveImageModels({
      imageModels: [
        {
          axisModelId: 'gpt-image-2',
          baseUrlOverride: 'https://api.openai.com/v1',
          requestModelIdOverride: 'gpt-image-2'
        }
      ]
    });
    await configStore.saveSecrets({
      llmProviderApiKeys: {},
      imageModelApiKeys: { 'gpt-image-2': 'sk-image' },
      videoModelApiKeys: {}
    });
    const fetch: ImageModelFetch = async (url, init) => {
      expect(url).toBe('https://api.openai.com/v1/images/generations');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'gpt-image-2',
        prompt: 'batch cover'
      });
      return jsonResponse({ data: [{ b64_json: tinyPngBase64 }] });
    };
    const server = new AxisAppServer({
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
      const [result] = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
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
      await rm(axisHome, { recursive: true, force: true });
    }
  });

  test('does not record generated asset metadata for skipped batch outputs', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-batch-skip-project-'));
    const axisHome = await mkdtemp(join(tmpdir(), 'axis-app-server-batch-skip-home-'));
    const logPath = join(projectRoot, 'batch-results.jsonl');
    const server = new AxisAppServer({
      globalConfigStore: new GlobalConfigStore({ axisHome }),
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
      await expect(access(join(projectRoot, '.axis/assets/generated-assets-index.json'))).rejects.toMatchObject({
        code: 'ENOENT'
      });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
      await rm(axisHome, { recursive: true, force: true });
    }
  });

  test('does not read image model configuration when every batch output is skipped', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-batch-skip-config-project-'));
    const logPath = join(projectRoot, 'batch-results.jsonl');
    class ThrowingImageConfigStore extends GlobalConfigStore {
      override async readImageModels(): ReturnType<GlobalConfigStore['readImageModels']> {
        throw new Error('image model settings should not be read for skipped outputs');
      }

      override async readSecrets(): ReturnType<GlobalConfigStore['readSecrets']> {
        throw new Error('secrets should not be read for skipped outputs');
      }
    }
    const server = new AxisAppServer({
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
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-app-server-batch-failed-project-'));
    const axisHome = await mkdtemp(join(tmpdir(), 'axis-app-server-batch-failed-home-'));
    const logPath = join(projectRoot, 'batch-results.jsonl');
    const configStore = new GlobalConfigStore({ axisHome });
    await configStore.saveImageModels({
      imageModels: [
        {
          axisModelId: 'gpt-image-2',
          baseUrlOverride: 'https://api.openai.com/v1',
          requestModelIdOverride: 'gpt-image-2'
        }
      ]
    });
    await configStore.saveSecrets({
      llmProviderApiKeys: {},
      imageModelApiKeys: { 'gpt-image-2': 'sk-image' },
      videoModelApiKeys: {}
    });
    const server = new AxisAppServer({
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
      const [result] = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(result).toMatchObject({
        status: 'failed',
        outputPath: 'generated/failed.png'
      });
      await expect(access(join(projectRoot, 'generated/failed.png'))).rejects.toMatchObject({
        code: 'ENOENT'
      });
      await expect(access(join(projectRoot, '.axis/assets/generated-assets-index.json'))).rejects.toMatchObject({
        code: 'ENOENT'
      });
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
      await rm(axisHome, { recursive: true, force: true });
    }
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
