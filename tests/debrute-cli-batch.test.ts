import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const serverInstances = vi.hoisted(() => [] as FakeDebruteAppServer[]);
const batchRun = vi.hoisted(() => ({
  implementation: undefined as undefined | ((input: unknown, options: { onProgress?: (event: unknown) => void } | undefined) => Promise<unknown>)
}));

vi.mock('@debrute/app-server', () => {
  class DebruteAppServer {
    openProject = vi.fn(async () => fakeSnapshot());
    runImageModelBatch = vi.fn(async (input, options) => {
      if (batchRun.implementation) {
        return batchRun.implementation(input, options);
      }
      options?.onProgress?.({ type: 'started', snapshot: { total: 2, done: 0, active: 0, okCount: 0, skippedCount: 0, failedCount: 0, retryCount: 0 } });
      return {
        total: 2,
        okCount: 2,
        skippedCount: 0,
        failedCount: 0,
        durationSeconds: 1.25,
        concurrency: 2,
        retries: 0,
        logPath: '/tmp/results.jsonl'
      };
    });
    runImageModelRequestForCli = vi.fn(async () => ({
      status: 'error',
      error: {
        code: 'request_failed',
        message: 'Image request failed: model endpoint responded with HTTP 429.'
      },
      outputs: {
        content: 'Image request failed: model endpoint responded with HTTP 429.',
        model: 'gpt-image-2'
      },
      logs: [{ stage: 'execute_request', status: 429 }]
    }));
    runVideoModelRequestForCli = vi.fn(async () => ({
      status: 'ok',
      outputs: { content: 'Generated 1 video artifact(s).', model: 'doubao-seedance-2-0-260128' },
      artifacts: []
    }));
    close = vi.fn();

    constructor() {
      serverInstances.push(this as unknown as FakeDebruteAppServer);
    }
  }
  return { DebruteAppServer };
});
import { runCli } from '../apps/debrute-cli/src/index';

interface FakeDebruteAppServer {
  openProject: ReturnType<typeof vi.fn>;
  runImageModelBatch: ReturnType<typeof vi.fn>;
  runImageModelRequestForCli: ReturnType<typeof vi.fn>;
  runVideoModelRequestForCli: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

describe('debrute cli image generation batch', () => {
  beforeEach(() => {
    serverInstances.length = 0;
    batchRun.implementation = undefined;
    process.exitCode = undefined;
  });

  test('opens the project once and delegates image batches to app-server', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'debrute-cli-batch-'));
    const projectRoot = join(tempDir, 'project');
    await mkdir(projectRoot);
    const logPath = join(tempDir, 'batch.jsonl');
    const inputPath = join(tempDir, 'requests.jsonl');
    const lines: string[] = [];
    await writeFile(inputPath, [
      JSON.stringify({ model: 'gpt-image-2', arguments: { prompt: 'one', output_path: 'generated/one.png' } }),
      JSON.stringify({ model: 'gemini-3.1-flash-image-preview', arguments: { prompt: 'two', output_path: 'generated/two.png' } })
    ].join('\n'));

    try {
      await runCli([
        'generate',
        'image-batch',
        projectRoot,
        '--input-jsonl',
        inputPath,
        '--concurrency',
        '2',
        '--retries',
        '0',
        '--log',
        logPath
      ], (text) => lines.push(text));

      expect(process.exitCode).toBeUndefined();
      expect(serverInstances).toHaveLength(1);
      expect(serverInstances[0]!.openProject).toHaveBeenCalledTimes(1);
      expect(serverInstances[0]!.openProject).toHaveBeenCalledWith(projectRoot, {
        initializeIfMissing: false,
        createDefaultCanvas: false,
        watchFiles: false
      });
      expect(serverInstances[0]!.runImageModelBatch).toHaveBeenCalledWith({
        source: { kind: 'jsonl', path: inputPath },
        concurrency: 2,
        retries: 0,
        timeoutMs: 900000,
        logPath
      }, expect.any(Object));
      expect(serverInstances[0]!.close).toHaveBeenCalledTimes(1);
      expect(lines).toEqual([[
        'debrute/1 progress cmd=generate.image-batch total=2 done=0 ok=0 failed=0 skipped=0 active=0 retries=0 timeout_ms=900000 log=' + logPath + ' concurrency=2',
      ].join('\n'), [
        'debrute/1 ok cmd=generate.image-batch',
        'total=2',
        'ok=2',
        'failed=0',
        'skipped=0',
        'log=/tmp/results.jsonl',
        'concurrency=2',
        'retries=0',
        'duration_seconds=1.25'
      ].join('\n')]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('passes manifest batch sources to app-server without CLI expansion', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'debrute-cli-manifest-'));
    const projectRoot = join(tempDir, 'project');
    await mkdir(projectRoot);
    const manifestPath = join(tempDir, 'manifest.json');
    const logPath = join(tempDir, 'manifest-results.jsonl');
    const summaryPath = join(tempDir, 'manifest-summary.json');
    await writeFile(manifestPath, JSON.stringify({ requests: [] }));

    try {
      await runCli([
        'generate',
        'image-batch',
        projectRoot,
        '--manifest',
        manifestPath,
        '--concurrency',
        '4',
        '--retries',
        '1',
        '--timeout-ms',
        '900000',
        '--log',
        logPath,
        '--summary',
        summaryPath
      ], () => {});

      expect(serverInstances).toHaveLength(1);
      expect(serverInstances[0]!.runImageModelBatch).toHaveBeenCalledWith({
        source: { kind: 'manifest', path: manifestPath },
        concurrency: 4,
        retries: 1,
        timeoutMs: 900000,
        logPath,
        summaryPath
      }, expect.any(Object));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('requires a log path for image batches before creating the app-server', async () => {
    const lines: string[] = [];

    await runCli([
      'generate',
      'image-batch',
      '/tmp/project',
      '--input-jsonl',
      '/tmp/requests.jsonl'
    ], (text) => lines.push(text));

    expect(process.exitCode).toBe(2);
    expect(serverInstances).toHaveLength(0);
    expect(lines).toEqual([[
      'debrute/1 error cmd=generate.image-batch code=missing_argument',
      'message="--log is required."'
    ].join('\n')]);
  });

  test('prints the current model request failure payload', async () => {
    const lines: string[] = [];

    await runCli([
      'generate',
      'image',
      '/tmp/project',
      '--input-json',
      '{"model":"gpt-image-2","arguments":{"prompt":"cover"}}'
    ], (text) => lines.push(text));

    expect(process.exitCode).toBe(4);
    expect(serverInstances).toHaveLength(1);
    expect(serverInstances[0]!.runImageModelRequestForCli).toHaveBeenCalledWith({
      model: 'gpt-image-2',
      arguments: { prompt: 'cover' }
    });
    expect(lines).toEqual([[
      'debrute/1 error cmd=generate.image code=model_request_failed',
      'message="Image request failed: model endpoint responded with HTTP 429."',
      'content="Image request failed: model endpoint responded with HTTP 429."',
      'model=gpt-image-2'
    ].join('\n')]);
  });

  test('passes single image CLI timeout to app-server', async () => {
    const lines: string[] = [];

    await runCli([
      'generate',
      'image',
      '/tmp/project',
      '--input-json',
      '{"model":"gpt-image-2","timeoutMs":111,"arguments":{"prompt":"cover"}}',
      '--timeout-ms',
      '600000'
    ], (text) => lines.push(text));

    expect(serverInstances[0]!.runImageModelRequestForCli).toHaveBeenCalledWith({
      model: 'gpt-image-2',
      arguments: { prompt: 'cover' },
      timeoutMs: 600000
    });
    expect(lines[0]).toContain('cmd=generate.image');
  });

  test('passes single video CLI timeout to app-server', async () => {
    await runCli([
      'generate',
      'video',
      '/tmp/project',
      '--input-json',
      '{"model":"doubao-seedance-2-0-260128","timeoutMs":111,"arguments":{"prompt":"camera move"}}',
      '--timeout-ms',
      '600000'
    ], () => {});

    expect(serverInstances[0]!.runVideoModelRequestForCli).toHaveBeenCalledWith({
      model: 'doubao-seedance-2-0-260128',
      arguments: { prompt: 'camera move' },
      timeoutMs: 600000
    });
  });

  test('passes image batch default timeout and overwrite flag to app-server', async () => {
    await runCli([
      'generate',
      'image-batch',
      '/tmp/project',
      '--input-jsonl',
      '/tmp/requests.jsonl',
      '--log',
      '/tmp/results.jsonl',
      '--overwrite-existing'
    ], () => {});

    expect(serverInstances[0]!.runImageModelBatch).toHaveBeenCalledWith({
      source: { kind: 'jsonl', path: '/tmp/requests.jsonl' },
      concurrency: 4,
      retries: 0,
      timeoutMs: 900000,
      logPath: '/tmp/results.jsonl',
      overwriteExisting: true
    }, expect.any(Object));
  });

  test('prints sparse batch progress at start and crossed 10 percent boundaries', async () => {
    const lines: string[] = [];
    batchRun.implementation = async (_input, options) => {
      options?.onProgress?.({ type: 'started', snapshot: { total: 10, done: 0, active: 0, okCount: 0, skippedCount: 0, failedCount: 0, retryCount: 0 } });
      options?.onProgress?.({ type: 'item_finished', result: { status: 'ok', index: 1, model: 'gpt-image-2', attempt: 1, durationSeconds: 1 }, snapshot: { total: 10, done: 1, active: 2, okCount: 1, skippedCount: 0, failedCount: 0, retryCount: 0 } });
      options?.onProgress?.({ type: 'item_finished', result: { status: 'failed', index: 2, model: 'gpt-image-2', attempt: 1, durationSeconds: 1, error: { code: 'request_failed' } }, snapshot: { total: 10, done: 2, active: 2, okCount: 1, skippedCount: 0, failedCount: 1, retryCount: 0 } });
      return {
        total: 10,
        okCount: 9,
        skippedCount: 0,
        failedCount: 1,
        durationSeconds: 1.25,
        concurrency: 2,
        retries: 0,
        logPath: '/tmp/results.jsonl'
      };
    };

    await runCli([
      'generate',
      'image-batch',
      '/tmp/project',
      '--input-jsonl',
      '/tmp/requests.jsonl',
      '--concurrency',
      '2',
      '--log',
      '/tmp/results.jsonl'
    ], (text) => lines.push(text));

    expect(lines).toEqual([
      'debrute/1 progress cmd=generate.image-batch total=10 done=0 ok=0 failed=0 skipped=0 active=0 retries=0 timeout_ms=900000 log=/tmp/results.jsonl concurrency=2',
      'debrute/1 progress cmd=generate.image-batch total=10 done=1 ok=1 failed=0 skipped=0 active=2 retries=0',
      'debrute/1 progress cmd=generate.image-batch total=10 done=2 ok=1 failed=1 skipped=0 active=2 retries=0',
      [
        'debrute/1 ok cmd=generate.image-batch',
        'total=10',
        'ok=9',
        'failed=1',
        'skipped=0',
        'log=/tmp/results.jsonl',
        'concurrency=2',
        'retries=0',
        'duration_seconds=1.25'
      ].join('\n')
    ]);
  });

  test('prints configured retry budget in the start progress record', async () => {
    const lines: string[] = [];
    batchRun.implementation = async (_input, options) => {
      options?.onProgress?.({ type: 'started', snapshot: { total: 5, done: 0, active: 0, okCount: 0, skippedCount: 0, failedCount: 0, retryCount: 0 } });
      return {
        total: 5,
        okCount: 5,
        skippedCount: 0,
        failedCount: 0,
        durationSeconds: 1.25,
        concurrency: 2,
        retries: 2,
        logPath: '/tmp/results.jsonl'
      };
    };

    await runCli([
      'generate',
      'image-batch',
      '/tmp/project',
      '--input-jsonl',
      '/tmp/requests.jsonl',
      '--concurrency',
      '2',
      '--retries',
      '2',
      '--log',
      '/tmp/results.jsonl'
    ], (text) => lines.push(text));

    expect(lines[0]).toBe('debrute/1 progress cmd=generate.image-batch total=5 done=0 ok=0 failed=0 skipped=0 active=0 retries=2 timeout_ms=900000 log=/tmp/results.jsonl concurrency=2');
  });
});

function fakeSnapshot() {
  return {
    projectRoot: '/tmp/project',
    metadata: { schemaVersion: 1, project: { id: 'project', name: 'Project', createdAt: '', updatedAt: '' } },
    files: [],
    canvases: [],
    projections: [],
    diagnostics: [],
    health: {
      projectName: 'Project',
      canvasCount: 0,
      diagnosticCounts: { errors: 0, warnings: 0, infos: 0 },
      runtimeDataLocation: '/tmp/runtime',
      checkedAt: ''
    }
  };
}
