import { describe, expect, it, vi } from 'vitest';
import type { WorkbenchRuntimeState } from '@debrute/workbench-runtime';
import type { SkillRecord, SkillsStatusSnapshot } from '@debrute/app-protocol';
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

  it('reports a stopped-runtime diagnostic for runtime doctor when no state exists', async () => {
    const result = await runRuntimeBackedCliCommand(parsed('runtime.doctor'), {
      readRuntimeState: vi.fn(async () => undefined),
      checkHealth: vi.fn(),
      skillsStatus: vi.fn(async () => skillsSnapshot({ skills: [] })),
      fetch: vi.fn()
    });

    expect(result).toMatchObject({
      status: 'ok',
      command: 'runtime.doctor',
      fields: {
        runtime_state: 'stopped',
        diagnostics: 2
      }
    });
    expect(result.records?.map((record) => record.fields.code)).toEqual([
      'runtime_stopped',
      'skills_not_installed'
    ]);
  });

  it('adds CLI-owned Skills status to observed runtime status', async () => {
    const state = runtimeState();
    const result = await runRuntimeBackedCliCommand(parsed('runtime.status'), {
      readRuntimeState: vi.fn(async () => state),
      checkHealth: vi.fn(async () => 'healthy'),
      skillsStatus: vi.fn(async () => skillsSnapshot({
        skills: [
          skillRecord('debrute-core'),
          skillRecord('debrute-image-director')
        ],
        diagnostics: [{
          source: 'debrute-sync',
          root: '/Debrute/skills',
          code: 'skills_bundle_unavailable',
          severity: 'warning',
          message: 'Bundled Debrute Skills are unavailable.'
        }]
      })),
      fetch: vi.fn(async () => new Response(JSON.stringify({
        status: 'ok',
        command: 'runtime.status',
        fields: {
          ok: true,
          image_models: 1,
          diagnostics: 2
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    });

    expect(result).toMatchObject({
      status: 'ok',
      command: 'runtime.status',
      fields: {
        ok: true,
        image_models: 1,
        skills: 2,
        diagnostics: 3
      }
    });
  });

  it('adds CLI-owned Skills diagnostics to observed runtime doctor', async () => {
    const state = runtimeState();
    const result = await runRuntimeBackedCliCommand(parsed('runtime.doctor'), {
      readRuntimeState: vi.fn(async () => state),
      checkHealth: vi.fn(async () => 'healthy'),
      skillsStatus: vi.fn(async () => skillsSnapshot({
        skills: [],
        bundledRootAvailable: false,
        diagnostics: [{
          source: 'debrute-sync',
          root: '/Debrute/skills',
          code: 'skills_bundle_unavailable',
          severity: 'warning',
          message: 'Bundled Debrute Skills are unavailable.'
        }]
      })),
      fetch: vi.fn(async () => new Response(JSON.stringify({
        status: 'ok',
        command: 'runtime.doctor',
        records: [{
          name: 'diagnostic',
          fields: {
            code: 'llm_model_not_configured',
            severity: 'warning',
            message: 'No available LLM model is configured.'
          }
        }],
        fields: { diagnostics: 1 }
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    });

    expect(result.status).toBe('ok');
    expect(result.fields).toEqual({ diagnostics: 3 });
    expect(result.records?.map((record) => record.fields.code)).toEqual([
      'llm_model_not_configured',
      'skills_bundle_unavailable',
      'skills_not_installed'
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
          fields: { total: 2, ok: 1, failed: 1, skipped: 0, log: '/tmp/results.jsonl' }
        }
      }
    ]), { status: 200, headers: { 'content-type': 'application/x-ndjson' } }));
    const state = runtimeState();

    try {
      const result = await runRuntimeBackedCliCommand(parsed('generate.image-batch', ['/tmp/project'], {
        'input-jsonl': '/tmp/requests.jsonl',
        log: '/tmp/results.jsonl',
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
            'input-jsonl': '/tmp/requests.jsonl',
            log: '/tmp/results.jsonl',
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
    schemaVersion: 2,
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

function skillsSnapshot(overrides: Partial<SkillsStatusSnapshot> = {}): SkillsStatusSnapshot {
  return {
    sources: [{ source: 'shared-agents', root: '/home/user/.agents/skills' }],
    skills: [skillRecord('debrute-core')],
    diagnostics: [],
    statePath: '/home/user/.debrute/skills-state.json',
    currentDebruteVersion: '1.2.3',
    sharedSkillsRoot: '/home/user/.agents/skills',
    bundledSkillsRoot: '/Debrute/skills',
    bundledRootAvailable: true,
    bundledSkills: ['debrute-core'],
    missingBundledSkills: [],
    missingBundledSkillCount: 0,
    skippedDeletedSkills: [],
    ...overrides
  };
}

function skillRecord(name: string): SkillRecord {
  return {
    name,
    description: 'Core',
    source: 'shared-agents',
    root: '/home/user/.agents/skills',
    skillDir: `/home/user/.agents/skills/${name}`,
    skillPath: `/home/user/.agents/skills/${name}/SKILL.md`,
    debruteVersion: '1.2.3'
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
