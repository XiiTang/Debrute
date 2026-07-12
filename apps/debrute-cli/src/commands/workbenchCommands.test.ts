import { describe, expect, it, vi } from 'vitest';
import type { WorkbenchRuntimeState } from '@debrute/workbench-runtime';
import { DebruteCliError, exitCodeForCliError } from '../errors/cliErrors.js';
import { commandSpecs, specForCommandPath } from './helpSpec.js';
import { parseDebruteArgs } from '../parser/parseDebruteArgs.js';
import { renderAgentRecord } from '../output/renderAgentRecord.js';
import { runWorkbenchCommand } from './workbenchCommands.js';

describe('debrute workbench start CLI metadata', () => {
  it('parses workbench start without a project path', () => {
    const parsed = parseDebruteArgs(['workbench', 'start']);

    expect(parsed.command).toBe('workbench.start');
    expect(parsed.scope).toBe('runtime');
    expect(parsed.commandPath).toEqual(['workbench', 'start']);
    expect(parsed.projectRoot).toBeUndefined();
    expect(parsed.positional).toEqual([]);
  });

  it('parses workbench start launch next path', () => {
    const parsed = parseDebruteArgs(['workbench', 'start', '--next', '/open?path=%2Ftmp%2Fproject']);

    expect(parsed).toMatchObject({
      command: 'workbench.start',
      positional: [],
      options: {
        next: '/open?path=%2Ftmp%2Fproject'
      }
    });
  });

  it('lists workbench start in command specs', () => {
    expect(commandSpecs).toContainEqual(expect.objectContaining({
      command: 'workbench.start',
      path: ['workbench', 'start'],
      scope: 'runtime',
      risk: 'write',
      requires: 'none',
      writes: 'logs',
      input: '[--next <same-origin-path>]',
      output: 'Workbench stable URL, launch URL, and port fields'
    }));
    expect(specForCommandPath(['workbench', 'start'])?.errors).toEqual(expect.arrayContaining([
      'runtime_launch_failed',
      'runtime_health_failed',
      'runtime_state_unreadable',
      'runtime_state_write_failed',
      'runtime_lock_timeout'
    ]));
  });

  it('rejects workbench start project paths and json output mode', () => {
    expect(() => parseDebruteArgs(['workbench', 'start', '.'])).toThrow(/Unexpected argument/);
    expect(() => parseDebruteArgs(['workbench', 'start', '--json'])).toThrow(/--json is not supported/);
  });

  it('assigns runtime failures to configuration exit code', () => {
    expect(exitCodeForCliError(new DebruteCliError('runtime_launch_failed', 'failed'))).toBe(3);
    expect(exitCodeForCliError(new DebruteCliError('runtime_health_failed', 'failed'))).toBe(3);
    expect(exitCodeForCliError(new DebruteCliError('runtime_state_unreadable', 'failed'))).toBe(3);
    expect(exitCodeForCliError(new DebruteCliError('runtime_state_write_failed', 'failed'))).toBe(3);
    expect(exitCodeForCliError(new DebruteCliError('runtime_lock_timeout', 'failed'))).toBe(3);
  });
});

describe('runWorkbenchCommand', () => {
  it('starts or reuses the runtime and returns stable and launch URL fields', async () => {
    const result = await runWorkbenchCommand(parseDebruteArgs(['workbench', 'start']), {
      ensureRuntime: async () => ({
        runtimeStarted: false,
        statePath: '/home/user/.debrute/runtime/workbench-runtime.json',
        state: runtimeState()
      })
    });

    expect(result).toMatchObject({
      status: 'ok',
      command: 'workbench.start',
      fields: {
        web_url: 'http://127.0.0.1:17322',
        launch_url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:17322\/__debrute\/session\/.+/),
        daemon_url: 'http://127.0.0.1:17321',
        web_port: 17322,
        daemon_port: 17321,
        runtime_started: false,
        runtime_kind: 'source-dev',
        state_path: '/home/user/.debrute/runtime/workbench-runtime.json'
      }
    });
    const launchUrl = new URL(String(result.fields.launch_url));
    expect(launchUrl.searchParams.get('next')).toBe('/');
    expect(renderAgentRecord(result)).not.toContain('project_url');
    expect(renderAgentRecord(result)).not.toContain('project_id');
  });

  it('uses the requested same-origin next path in the launch URL', async () => {
    const result = await runWorkbenchCommand(
      parseDebruteArgs(['workbench', 'start', '--next', '/open?path=%2Ftmp%2Fproject']),
      {
        ensureRuntime: async () => ({
          runtimeStarted: false,
          statePath: '/home/user/.debrute/runtime/workbench-runtime.json',
          state: runtimeState()
        })
      }
    );

    expect(result).toMatchObject({
      status: 'ok',
      fields: {
        web_url: 'http://127.0.0.1:17322',
        launch_url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:17322\/__debrute\/session\/.+/)
      }
    });
    const launchUrl = new URL(String(result.fields.launch_url));
    expect(launchUrl.searchParams.get('next')).toBe('/open?path=%2Ftmp%2Fproject');
  });

  it('rejects invalid launch next paths without starting the runtime', async () => {
    const ensureRuntime = vi.fn();
    const result = await runWorkbenchCommand(
      parseDebruteArgs(['workbench', 'start', '--next', 'https://example.com/open']),
      { ensureRuntime }
    );

    expect(result).toMatchObject({
      status: 'error',
      command: 'workbench.start',
      code: 'invalid_input',
      message: 'Debrute Workbench launch next path must be a normalized same-origin path: https://example.com/open'
    });
    expect(ensureRuntime).not.toHaveBeenCalled();
  });

  it('reports desktop runtime kind when reusing a registered desktop runtime', async () => {
    const result = await runWorkbenchCommand(parseDebruteArgs(['workbench', 'start']), {
      ensureRuntime: async () => ({
        runtimeStarted: false,
        statePath: '/home/user/.debrute/runtime/workbench-runtime.json',
        state: runtimeState({ runtimeKind: 'desktop-packaged', processControl: 'external' })
      })
    });

    expect(result).toMatchObject({
      status: 'ok',
      fields: {
        runtime_started: false,
        runtime_kind: 'desktop-packaged'
      }
    });
  });
});

function runtimeState(overrides: Partial<WorkbenchRuntimeState> = {}): WorkbenchRuntimeState {
  return {
    runtimeKind: 'source-dev',
    processControl: 'managed',
    owner: {
      kind: 'cli',
      ownerId: 'cli-owner-1',
      pid: 12345
    },
    daemonUrl: 'http://127.0.0.1:17321',
    webUrl: 'http://127.0.0.1:17322',
    token: 'secret',
    daemonPid: 10,
    webPid: 11,
    daemonLogPath: '/home/user/.debrute/runtime/workbench-daemon.log',
    webLogPath: '/home/user/.debrute/runtime/workbench-web.log',
    startedAt: '2026-06-13T00:00:00.000Z',
    updatedAt: '2026-06-13T00:00:00.000Z',
    ...overrides
  };
}
