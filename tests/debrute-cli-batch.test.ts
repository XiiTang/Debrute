import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const serverInstances = vi.hoisted(() => [] as FakeDebruteAppServer[]);

vi.mock('@debrute/app-server', () => {
  class DebruteAppServer {
    openProject = vi.fn(async () => fakeSnapshot());
    runImageModelBatch = vi.fn(async () => ({
      total: 2,
      okCount: 2,
      skippedCount: 0,
      failedCount: 0,
      durationSeconds: 1.25,
      concurrency: 2,
      retries: 0,
      logPath: '/tmp/results.jsonl'
    }));
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
  close: ReturnType<typeof vi.fn>;
}

describe('debrute cli image generation batch', () => {
  beforeEach(() => {
    serverInstances.length = 0;
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
        logPath
      });
      expect(serverInstances[0]!.close).toHaveBeenCalledTimes(1);
      expect(lines).toEqual([[
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
      });
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
