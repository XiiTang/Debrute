import { describe, expect, it, vi } from 'vitest';
import type { DebruteAppServer } from '@debrute/app-server';
import type { DebruteAgentCommandResult } from '@debrute/app-protocol';
import { createDebruteDaemonHttpServer } from '../apps/daemon/src/http/createDebruteDaemonHttpServer';
import { runDaemonCliCommand } from '../apps/daemon/src/http/cliCommandRoutes';

describe('daemon CLI command routes', () => {
  it('returns audio model counts in runtime status records', async () => {
    const server = {
      runtimeStatusForCli: vi.fn(async () => ({
        ok: true,
        imageModels: 11,
        availableImageModels: 1,
        videoModels: 2,
        availableVideoModels: 1,
        audioModels: 16,
        availableAudioModels: 3,
        diagnostics: 0
      }))
    } as unknown as DebruteAppServer;

    await expect(runDaemonCliCommand({
      command: 'runtime.status',
      positional: [],
      options: {}
    }, { server })).resolves.toMatchObject({
      status: 'ok',
      command: 'runtime.status',
      fields: {
        audio_models: 16,
        available_audio_models: 3
      }
    });
  });

  it('preserves CLI invalid_input errors for malformed generation input', async () => {
    const server = {
      openProject: vi.fn(async () => undefined),
      runImageModelRequestForCli: vi.fn()
    } as unknown as DebruteAppServer;

    await expect(runDaemonCliCommand({
      command: 'generate.image',
      positional: ['/tmp/project'],
      projectRoot: '/tmp/project',
      options: { 'input-json': '{}' }
    }, { server })).resolves.toMatchObject({
      status: 'error',
      command: 'generate.image',
      code: 'invalid_input',
      message: '--input-json requires string field "model".'
    });
  });

  it('routes TTS generation through the audio model CLI service', async () => {
    const server = {
      openProject: vi.fn(async () => undefined),
      runAudioModelRequestForCli: vi.fn(async () => ({
        status: 'ok',
        artifacts: [{
          artifactId: 'artifact-1',
          title: 'voice.mp3',
          projectRelativePath: 'generated/voice.mp3',
          mimeType: 'audio/mpeg'
        }],
        outputs: {}
      }))
    } as unknown as DebruteAppServer;

    const result = await runDaemonCliCommand({
      command: 'generate.tts',
      positional: ['/tmp/project'],
      projectRoot: '/tmp/project',
      options: {
        'input-json': JSON.stringify({ model: 'openai-gpt-4o-mini-tts', arguments: { text: 'line' } })
      }
    }, { server });

    expect(server.runAudioModelRequestForCli).toHaveBeenCalledWith('tts', {
      model: 'openai-gpt-4o-mini-tts',
      arguments: { text: 'line' }
    });
    expect(result).toMatchObject({
      status: 'ok',
      command: 'generate.tts',
      fields: { artifacts: 1 },
      records: [expect.objectContaining({
        fields: expect.objectContaining({
          path: 'generated/voice.mp3',
          mime: 'audio/mpeg'
        })
      })]
    });
  });

  it('normalizes missing audio official docs as runtime config errors', async () => {
    const error = Object.assign(new Error('Official docs are missing.'), {
      code: 'audio_model_official_doc_missing'
    });
    const server = {
      describeAudioModelForCli: vi.fn(async () => {
        throw error;
      })
    } as unknown as DebruteAppServer;

    await expect(runDaemonCliCommand({
      command: 'models.tts.describe',
      positional: ['openai-gpt-4o-mini-tts'],
      options: {}
    }, { server })).resolves.toMatchObject({
      status: 'error',
      command: 'models.tts.describe',
      code: 'runtime_config_error',
      message: 'Official docs are missing.'
    });
  });

  it('keeps image batch progress sparse at startup and crossed 10 percent boundaries', async () => {
    const onProgress = vi.fn();
    const server = {
      openProject: vi.fn(async () => undefined),
      runImageModelBatch: vi.fn(async (_input, options: { onProgress?: (event: unknown) => void } | undefined) => {
        options?.onProgress?.({ type: 'started', snapshot: snapshot(20, 0, 0) });
        options?.onProgress?.({ type: 'item_finished', snapshot: snapshot(20, 1, 0) });
        options?.onProgress?.({ type: 'item_finished', snapshot: snapshot(20, 2, 0) });
        return {
          total: 20,
          okCount: 19,
          failedCount: 1,
          skippedCount: 0,
          logPath: 'batch/results.jsonl',
          concurrency: 2,
          retries: 0,
          durationSeconds: 1.25
        };
      })
    } as unknown as DebruteAppServer;

    const result = await runDaemonCliCommand({
      command: 'generate.image-batch',
      positional: ['/tmp/project'],
      projectRoot: '/tmp/project',
      options: {
        'input-jsonl': 'batch/requests.jsonl',
        log: 'batch/results.jsonl',
        concurrency: '2'
      }
    }, { server, onProgress });

    expect(result).toMatchObject({
      status: 'ok',
      command: 'generate.image-batch',
      fields: { total: 20, ok: 19, failed: 1 }
    });
    expect(result.fields).not.toHaveProperty('summary');
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ total: 20, done: 0, ok: 0, failed: 0, timeout_ms: 900_000 }),
      expect.objectContaining({ total: 20, done: 2, ok: 2, failed: 0 })
    ]);
    expect(onProgress.mock.calls[1]?.[1]).not.toHaveProperty('log');
    expect(onProgress.mock.calls[1]?.[1]).not.toHaveProperty('timeout_ms');
  });

  it('rejects image batch bridge requests without exactly one source before opening the project', async () => {
    const server = {
      openProject: vi.fn(async () => undefined),
      runImageModelBatch: vi.fn()
    } as unknown as DebruteAppServer;

    await expect(runDaemonCliCommand({
      command: 'generate.image-batch',
      positional: ['/tmp/project'],
      projectRoot: '/tmp/project',
      options: { log: '/tmp/results.jsonl' }
    }, { server })).resolves.toMatchObject({
      status: 'error',
      command: 'generate.image-batch',
      code: 'invalid_input',
      message: 'generate.image-batch requires exactly one of --manifest or --input-jsonl.'
    });

    await expect(runDaemonCliCommand({
      command: 'generate.image-batch',
      positional: ['/tmp/project'],
      projectRoot: '/tmp/project',
      options: {
        manifest: '/tmp/manifest.json',
        'input-jsonl': '/tmp/requests.jsonl',
        log: '/tmp/results.jsonl'
      }
    }, { server })).resolves.toMatchObject({
      status: 'error',
      command: 'generate.image-batch',
      code: 'invalid_input',
      message: 'generate.image-batch requires exactly one of --manifest or --input-jsonl.'
    });

    expect(server.openProject).not.toHaveBeenCalled();
    expect(server.runImageModelBatch).not.toHaveBeenCalled();
  });

  it('rejects image batch bridge requests without a log path before opening the project', async () => {
    const server = {
      openProject: vi.fn(async () => undefined),
      runImageModelBatch: vi.fn()
    } as unknown as DebruteAppServer;

    await expect(runDaemonCliCommand({
      command: 'generate.image-batch',
      positional: ['/tmp/project'],
      projectRoot: '/tmp/project',
      options: { 'input-jsonl': '/tmp/requests.jsonl' }
    }, { server })).resolves.toMatchObject({
      status: 'error',
      command: 'generate.image-batch',
      code: 'missing_argument',
      message: '--log is required.'
    });

    expect(server.openProject).not.toHaveBeenCalled();
    expect(server.runImageModelBatch).not.toHaveBeenCalled();
  });

  it('rejects absolute image batch project paths before opening the project', async () => {
    const server = {
      openProject: vi.fn(async () => undefined),
      runImageModelBatch: vi.fn()
    } as unknown as DebruteAppServer;

    await expect(runDaemonCliCommand({
      command: 'generate.image-batch',
      positional: ['/tmp/project'],
      projectRoot: '/tmp/project',
      options: {
        'input-jsonl': 'batch/requests.jsonl',
        log: '/tmp/results.jsonl'
      }
    }, { server })).resolves.toMatchObject({
      status: 'error',
      command: 'generate.image-batch',
      code: 'invalid_input',
      message: '--log must be a project-relative path.'
    });

    await expect(runDaemonCliCommand({
      command: 'generate.image-batch',
      positional: ['/tmp/project'],
      projectRoot: '/tmp/project',
      options: {
        manifest: 'batch/manifest.json',
        log: 'batch/results.jsonl',
        summary: '/tmp/summary.json'
      }
    }, { server })).resolves.toMatchObject({
      status: 'error',
      command: 'generate.image-batch',
      code: 'invalid_input',
      message: '--summary must be a project-relative path.'
    });

    await expect(runDaemonCliCommand({
      command: 'generate.image-batch',
      positional: ['/tmp/project'],
      projectRoot: '/tmp/project',
      options: {
        'input-jsonl': '/tmp/requests.jsonl',
        log: 'batch/results.jsonl'
      }
    }, { server })).resolves.toMatchObject({
      status: 'error',
      command: 'generate.image-batch',
      code: 'invalid_input',
      message: '--input-jsonl must be a project-relative path.'
    });

    expect(server.openProject).not.toHaveBeenCalled();
    expect(server.runImageModelBatch).not.toHaveBeenCalled();
  });

  it('passes normalized project-relative image batch paths and reports relative progress fields', async () => {
    const onProgress = vi.fn();
    const server = {
      openProject: vi.fn(async () => undefined),
      runImageModelBatch: vi.fn(async (input, options: { onProgress?: (event: unknown) => void } | undefined) => {
        expect(input).toMatchObject({
          source: { kind: 'jsonl', path: 'batch/requests.jsonl' },
          logPath: 'batch/results.jsonl',
          summaryPath: 'batch/summary.json'
        });
        options?.onProgress?.({ type: 'started', snapshot: snapshot(1, 0, 0) });
        return {
          total: 1,
          okCount: 1,
          failedCount: 0,
          skippedCount: 0,
          logPath: 'batch/results.jsonl',
          summaryPath: 'batch/summary.json',
          concurrency: 2,
          retries: 0,
          durationSeconds: 1
        };
      })
    } as unknown as DebruteAppServer;

    const result = await runDaemonCliCommand({
      command: 'generate.image-batch',
      positional: ['/tmp/project'],
      projectRoot: '/tmp/project',
      options: {
        'input-jsonl': 'batch/requests.jsonl',
        log: 'batch/results.jsonl',
        summary: 'batch/summary.json',
        concurrency: '2'
      }
    }, { server, onProgress });

    expect(result).toMatchObject({
      status: 'ok',
      command: 'generate.image-batch',
      fields: {
        log: 'batch/results.jsonl',
        summary: 'batch/summary.json'
      }
    });
    expect(onProgress.mock.calls[0]?.[1]).toMatchObject({
      log: 'batch/results.jsonl',
      summary: 'batch/summary.json'
    });
  });

  it('runs canvas reset layout through the project CLI bridge', async () => {
    const server = {
      openProject: vi.fn(async () => undefined),
      resetCanvasNodeLayouts: vi.fn(async () => ({
        resetCount: 3
      }))
    } as unknown as DebruteAppServer;

    await expect(runDaemonCliCommand({
      command: 'canvas.reset-layout',
      positional: ['/tmp/project', 'canvas-1'],
      projectRoot: '/tmp/project',
      options: {
        path: '["outputs/gpt/","prompts/cover [draft].md"]',
        glob: '["outputs/**/*.png"]'
      }
    }, { server })).resolves.toMatchObject({
      status: 'ok',
      command: 'canvas.reset-layout',
      fields: {
        canvas: 'canvas-1',
        mode: 'paths',
        reset: 3
      }
    });
    expect(server.openProject).toHaveBeenCalledWith('/tmp/project', {
      initializeIfMissing: false,
      createDefaultCanvas: false,
      watchFiles: false
    });
    expect(server.resetCanvasNodeLayouts).toHaveBeenCalledWith({
      canvasId: 'canvas-1',
      pathRules: {
        paths: ['outputs/gpt/', 'prompts/cover [draft].md'],
        globs: ['outputs/**/*.png']
      }
    });
  });

  it('isolates concurrent project CLI HTTP commands with a fresh App Server per request', async () => {
    const alphaRoot = '/tmp/debrute-alpha-project';
    const betaRoot = '/tmp/debrute-beta-project';
    let releaseAlphaAfterBeta!: () => void;
    const betaOpened = new Promise<void>((resolveBetaOpened) => {
      releaseAlphaAfterBeta = resolveBetaOpened;
    });
    const createdServers: Array<{ close: ReturnType<typeof vi.fn> }> = [];

    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null,
      createAppServer: () => {
        let projectRoot = '';
        const close = vi.fn();
        const server = {
          close,
          openProject: vi.fn(async (root: string) => {
            projectRoot = root;
            if (root === alphaRoot) {
              await betaOpened;
            } else if (root === betaRoot) {
              releaseAlphaAfterBeta();
            }
          }),
          runImageModelRequestForCli: vi.fn(async () => ({
            status: 'ok',
            outputs: { project_root: projectRoot },
            artifacts: []
          }))
        };
        createdServers.push({ close });
        return server as unknown as DebruteAppServer;
      }
    });

    try {
      const runtime = await daemon.listen();
      const [alpha, beta] = await Promise.all([
        requestCliRun(runtime.daemonUrl, alphaRoot),
        requestCliRun(runtime.daemonUrl, betaRoot)
      ]);

      expect(alpha.fields).toMatchObject({ project_root: alphaRoot });
      expect(beta.fields).toMatchObject({ project_root: betaRoot });
      expect(createdServers).toHaveLength(2);
      expect(createdServers.every((server) => server.close.mock.calls.length === 1)).toBe(true);
    } finally {
      await daemon.close();
    }
  });
});

async function requestCliRun(daemonUrl: string, projectRoot: string): Promise<DebruteAgentCommandResult> {
  const response = await fetch(`${daemonUrl}/api/cli/run`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-debrute-daemon-token': 'test-token'
    },
    body: JSON.stringify({
      command: 'generate.image',
      positional: [projectRoot],
      projectRoot,
      options: {
        'input-json': JSON.stringify({ model: 'test-model', arguments: { prompt: 'test' } })
      }
    })
  });
  expect(response.status).toBe(200);
  return await response.json() as DebruteAgentCommandResult;
}

function snapshot(total: number, done: number, failedCount: number) {
  return {
    total,
    done,
    active: done < total ? 1 : 0,
    okCount: done - failedCount,
    skippedCount: 0,
    failedCount,
    retryCount: 0
  };
}
