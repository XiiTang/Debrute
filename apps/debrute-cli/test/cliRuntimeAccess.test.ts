import { describe, expect, it, vi } from 'vitest';
import type { WorkbenchRuntimeState } from '@debrute/workbench-runtime';
import { runRuntimeBackedCliCommand } from '../src/runtime/cliRuntimeAccess';

describe('CLI runtime access', () => {
  it('does not start runtime for observe-runtime status when no state exists', async () => {
    const ensureRuntime = vi.fn();
    const result = await runRuntimeBackedCliCommand(parsed('runtime.status'), {
      ensureRuntime,
      readRuntimeState: vi.fn(async () => undefined),
      checkHealth: vi.fn(),
      fetch: vi.fn()
    });

    expect(ensureRuntime).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'ok',
      command: 'runtime.status',
      fields: { runtime_state: 'stopped' }
    });
  });

  it('surfaces unreadable runtime state instead of reporting stopped', async () => {
    const result = await runRuntimeBackedCliCommand(parsed('runtime.status'), {
      readRuntimeState: vi.fn(async () => {
        throw new Error('Invalid Debrute workbench runtime state: owner must include kind, ownerId, and pid.');
      }),
      checkHealth: vi.fn(),
      fetch: vi.fn()
    });

    expect(result).toMatchObject({
      status: 'error',
      command: 'runtime.status',
      code: 'runtime_state_unreadable',
      message: 'Debrute workbench runtime state is unreadable: Invalid Debrute workbench runtime state: owner must include kind, ownerId, and pid.'
    });
  });

  it('reports unreadable runtime state as a doctor diagnostic', async () => {
    const result = await runRuntimeBackedCliCommand(parsed('runtime.doctor'), {
      readRuntimeState: vi.fn(async () => {
        throw new Error('Invalid Debrute workbench runtime state: owner must include kind, ownerId, and pid.');
      }),
      checkHealth: vi.fn(),
      fetch: vi.fn()
    });

    expect(result).toMatchObject({
      status: 'ok',
      command: 'runtime.doctor',
      fields: {
        runtime_state: 'unreadable',
        diagnostics: 1
      }
    });
    expect(result.records?.map((record) => record.fields.code)).toEqual([
      'runtime_state_unreadable'
    ]);
  });

  it('reports a stopped-runtime diagnostic for runtime doctor when no state exists', async () => {
    const result = await runRuntimeBackedCliCommand(parsed('runtime.doctor'), {
      readRuntimeState: vi.fn(async () => undefined),
      checkHealth: vi.fn(),
      fetch: vi.fn()
    });

    expect(result).toMatchObject({
      status: 'ok',
      command: 'runtime.doctor',
      fields: {
        runtime_state: 'stopped',
        diagnostics: 1
      }
    });
    expect(result.records?.map((record) => record.fields.code)).toEqual([
      'runtime_stopped'
    ]);
  });

  it('reuses a healthy Desktop-owned runtime for ensure-runtime commands', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      status: 'ok',
      command: 'models.image.list',
      records: [],
      fields: { count: 0 }
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const state = runtimeState({
      owner: { kind: 'desktop', ownerId: 'desktop-session', pid: 200 },
      processControl: 'managed'
    });

    const result = await runRuntimeBackedCliCommand(parsed('models.image.list'), {
      ensureRuntime: vi.fn(async () => ({ runtimeStarted: false, statePath: '/tmp/state.json', state })),
      readRuntimeState: vi.fn(),
      checkHealth: vi.fn(async () => 'healthy'),
      fetch,
      owner: { kind: 'cli', ownerId: 'cli-owner-1', pid: 300 }
    });

    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:17321/api/cli/run', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'x-debrute-daemon-token': 'secret' })
    }));
    expect(result).toMatchObject({ status: 'ok', command: 'models.image.list' });
  });

  it('ensures runtime and posts update through the daemon CLI bridge', async () => {
    const state = runtimeState();
    const ensureRuntime = vi.fn(async () => ({ runtimeStarted: false, statePath: '/tmp/state.json', state }));
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      status: 'ok',
      command: 'update',
      fields: {
        current_version: '0.2.0',
        update_state: 'installing',
        update_version: '0.3.0'
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(runRuntimeBackedCliCommand(parsed('update'), {
      ensureRuntime,
      fetch,
      owner: { kind: 'cli', ownerId: 'cli-owner-1', pid: 300 }
    })).resolves.toMatchObject({
      status: 'ok',
      command: 'update',
      fields: {
        update_state: 'installing'
      }
    });
    expect(ensureRuntime).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:17321/api/cli/run', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        command: 'update',
        positional: [],
        options: {}
      })
    }));
  });

  it('does not allow CLI replacement to terminate a Desktop-owned runtime', async () => {
    const desktopState = runtimeState({
      owner: { kind: 'desktop', ownerId: 'desktop-session', pid: 200 },
      processControl: 'managed'
    });
    const ensureRuntime = vi.fn(async (input: { shouldTerminateStaleRuntime?: (state: WorkbenchRuntimeState) => boolean }) => {
      expect(input.shouldTerminateStaleRuntime?.(desktopState)).toBe(false);
      return { runtimeStarted: true, statePath: '/tmp/state.json', state: runtimeState() };
    });

    await runRuntimeBackedCliCommand(parsed('project.status', ['/tmp/project']), {
      ensureRuntime,
      readRuntimeState: vi.fn(),
      checkHealth: vi.fn(async () => 'daemon-unavailable'),
      owner: { kind: 'cli', ownerId: 'cli-owner-1', pid: 300 },
      fetch: vi.fn(async () => new Response(JSON.stringify({
        status: 'ok',
        command: 'project.status',
        fields: { project_root: '/tmp/project' }
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    });
  });

  it('streams image batch progress and returns exit code 1 when items fail', async () => {
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    const output: string[] = [];
    const fetch = vi.fn(async () => new Response(ndjsonStream([
      { type: 'progress', command: 'generate.image-batch', fields: { total: 2, done: 1, ok: 1, failed: 0 } },
      {
        type: 'result',
        result: {
          status: 'ok',
          command: 'generate.image-batch',
          fields: { total: 2, ok: 1, failed: 1, skipped: 0, log: 'batch/results.jsonl' }
        }
      }
    ]), { status: 200, headers: { 'content-type': 'application/x-ndjson' } }));
    const state = runtimeState();

    try {
      const result = await runRuntimeBackedCliCommand(parsed('generate.image-batch', ['/tmp/project'], {
        'input-jsonl': 'batch/requests.jsonl',
        log: 'batch/results.jsonl',
        concurrency: '2'
      }), {
        ensureRuntime: vi.fn(async () => ({ runtimeStarted: false, statePath: '/tmp/state.json', state })),
        fetch,
        output: (text) => output.push(text),
        owner: { kind: 'cli', ownerId: 'cli-owner-1', pid: 300 }
      });

      expect(result).toMatchObject({
        status: 'ok',
        command: 'generate.image-batch',
        fields: { failed: 1 }
      });
      expect(process.exitCode).toBe(1);
      expect(output).toEqual([
        'debrute/1 progress cmd=generate.image-batch total=2 done=1 ok=1 failed=0'
      ]);
      expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:17321/api/cli/run-stream', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          command: 'generate.image-batch',
          positional: ['/tmp/project'],
          options: {
            'input-jsonl': 'batch/requests.jsonl',
            log: 'batch/results.jsonl',
            concurrency: '2'
          },
          projectRoot: '/tmp/project'
        })
      }));
    } finally {
      process.exitCode = originalExitCode;
    }
  });
});

function parsed(command: string, positional: string[] = [], options: Record<string, string> = {}) {
  return {
    command,
    commandPath: command.split('.'),
    scope: command.startsWith('generate.') ? 'generation' : 'runtime',
    positional,
    options,
    ...(positional[0] ? { projectRoot: positional[0] } : {})
  } as never;
}

function runtimeState(overrides: Partial<WorkbenchRuntimeState> = {}): WorkbenchRuntimeState {
  return {
    runtimeKind: 'desktop-packaged',
    processControl: 'managed',
    owner: { kind: 'cli', ownerId: 'cli-owner-1', pid: 300 },
    daemonUrl: 'http://127.0.0.1:17321',
    webUrl: 'http://127.0.0.1:17322',
    token: 'secret',
    daemonPid: 300,
    webPid: 301,
    daemonLogPath: '/tmp/daemon.log',
    webLogPath: '/tmp/web.log',
    startedAt: '2026-06-13T00:00:00.000Z',
    updatedAt: '2026-06-13T00:00:00.000Z',
    ...overrides
  };
}

function ndjsonStream(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }
      controller.close();
    }
  });
}
