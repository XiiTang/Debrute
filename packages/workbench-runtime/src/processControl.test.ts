import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  terminateManagedWorkbenchRuntime,
  terminateOwnedWorkbenchRuntime,
  type WorkbenchRuntimeProcessOperations
} from './processControl.js';
import type { WorkbenchRuntimeState } from './state.js';

describe('workbench runtime process control', { tags: ['runtime'] }, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends SIGTERM once to the managed daemon and web pids', async () => {
    const signalProcess = vi.fn();
    const probeProcess = vi.fn(() => {
      throw nodeError('ESRCH');
    });

    await terminateManagedWorkbenchRuntime(
      runtimeState({ daemonPid: 10, webPid: 11 }),
      operations({ signalProcess, probeProcess })
    );

    expect(signalProcess).toHaveBeenCalledTimes(2);
    expect(signalProcess).toHaveBeenCalledWith(10, 'SIGTERM');
    expect(signalProcess).toHaveBeenCalledWith(11, 'SIGTERM');
  });

  it('signals a duplicated recorded pid only once', async () => {
    const signalProcess = vi.fn();

    await terminateManagedWorkbenchRuntime(
      runtimeState({ daemonPid: 10, webPid: 10 }),
      operations({
        signalProcess,
        probeProcess: () => {
          throw nodeError('ESRCH');
        }
      })
    );

    expect(signalProcess).toHaveBeenCalledTimes(1);
    expect(signalProcess).toHaveBeenCalledWith(10, 'SIGTERM');
  });

  it('leaves external runtimes untouched', async () => {
    const signalProcess = vi.fn();
    const probeProcess = vi.fn();

    await terminateManagedWorkbenchRuntime(
      runtimeState({ processControl: 'external' }),
      operations({ signalProcess, probeProcess })
    );

    expect(signalProcess).not.toHaveBeenCalled();
    expect(probeProcess).not.toHaveBeenCalled();
  });

  it('terminates a managed runtime owned by the requested owner', async () => {
    const owner = { kind: 'desktop' as const, ownerId: 'desktop-session', pid: 200 };
    const signalProcess = vi.fn();

    await terminateOwnedWorkbenchRuntime(
      runtimeState({ owner, daemonPid: 10, webPid: 10 }),
      owner,
      operations({
        signalProcess,
        probeProcess: () => {
          throw nodeError('ESRCH');
        }
      })
    );

    expect(signalProcess).toHaveBeenCalledOnce();
    expect(signalProcess).toHaveBeenCalledWith(10, 'SIGTERM');
  });

  it('checks ownership before terminating a managed runtime', async () => {
    const owner = { kind: 'desktop' as const, ownerId: 'desktop-session', pid: 200 };
    const signalProcess = vi.fn();
    const probeProcess = vi.fn();

    await terminateOwnedWorkbenchRuntime(
      runtimeState({ owner: { ...owner, ownerId: 'other-session' } }),
      owner,
      operations({ signalProcess, probeProcess })
    );

    expect(signalProcess).not.toHaveBeenCalled();
    expect(probeProcess).not.toHaveBeenCalled();
  });

  it('resolves only after every recorded pid is absent', async () => {
    vi.useFakeTimers();
    const livePids = new Set([10, 11]);
    const events: string[] = [];
    const termination = terminateManagedWorkbenchRuntime(
      runtimeState({ daemonPid: 10, webPid: 11 }),
      operations({
        signalProcess: vi.fn(),
        probeProcess: (pid) => livePids.has(pid)
      })
    ).then(() => events.push('resolved'));

    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([]);

    livePids.delete(10);
    await vi.advanceTimersByTimeAsync(50);
    expect(events).toEqual([]);

    livePids.delete(11);
    await vi.advanceTimersByTimeAsync(50);
    await termination;
    expect(events).toEqual(['resolved']);
  });

  it('treats ESRCH from signalling and probing as an exited process', async () => {
    const signalProcess = vi.fn((pid: number) => {
      if (pid === 10) {
        throw nodeError('ESRCH');
      }
    });
    const probeProcess = vi.fn(() => {
      throw nodeError('ESRCH');
    });

    await expect(terminateManagedWorkbenchRuntime(
      runtimeState({ daemonPid: 10, webPid: 11 }),
      operations({ signalProcess, probeProcess })
    )).resolves.toBeUndefined();

    expect(probeProcess).toHaveBeenCalledTimes(1);
    expect(probeProcess).toHaveBeenCalledWith(11);
  });

  it('rejects non-ESRCH signalling errors', async () => {
    const failure = nodeError('EPERM');

    await expect(terminateManagedWorkbenchRuntime(
      runtimeState({ daemonPid: 10, webPid: 10 }),
      operations({
        signalProcess: () => {
          throw failure;
        },
        probeProcess: vi.fn()
      })
    )).rejects.toBe(failure);
  });

  it('attempts every unique SIGTERM before surfacing a signalling error', async () => {
    const failure = nodeError('EPERM');
    const signalProcess = vi.fn((pid: number) => {
      if (pid === 10) {
        throw failure;
      }
    });

    await expect(terminateManagedWorkbenchRuntime(
      runtimeState({ daemonPid: 10, webPid: 11 }),
      operations({ signalProcess, probeProcess: vi.fn() })
    )).rejects.toBe(failure);

    expect(signalProcess).toHaveBeenCalledTimes(2);
    expect(signalProcess).toHaveBeenNthCalledWith(1, 10, 'SIGTERM');
    expect(signalProcess).toHaveBeenNthCalledWith(2, 11, 'SIGTERM');
  });

  it('surfaces every SIGTERM failure after attempting all unique pids', async () => {
    const daemonFailure = nodeError('EPERM');
    const webFailure = nodeError('EACCES');

    const error = await terminateManagedWorkbenchRuntime(
      runtimeState({ daemonPid: 10, webPid: 11 }),
      operations({
        signalProcess: (pid) => {
          throw pid === 10 ? daemonFailure : webFailure;
        },
        probeProcess: vi.fn()
      })
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({ errors: [daemonFailure, webFailure] });
  });

  it('rejects non-ESRCH liveness probe errors', async () => {
    const failure = nodeError('EPERM');

    await expect(terminateManagedWorkbenchRuntime(
      runtimeState({ daemonPid: 10, webPid: 10 }),
      operations({
        signalProcess: vi.fn(),
        probeProcess: () => {
          throw failure;
        }
      })
    )).rejects.toBe(failure);
  });

  it('rejects at the termination deadline with every named live pid', async () => {
    vi.useFakeTimers();
    let now = 0;
    const termination = terminateManagedWorkbenchRuntime(
      runtimeState({ daemonPid: 10, webPid: 11 }),
      operations({
        signalProcess: vi.fn(),
        probeProcess: () => true,
        monotonicNow: () => now
      })
    );
    const rejection = expect(termination).rejects.toThrow(/daemonPid=10, webPid=11/);

    await vi.advanceTimersByTimeAsync(0);
    now = Number.MAX_SAFE_INTEGER;
    await vi.advanceTimersByTimeAsync(50);

    await rejection;
  });
});

function operations(
  overrides: Partial<WorkbenchRuntimeProcessOperations> = {}
): WorkbenchRuntimeProcessOperations {
  return {
    signalProcess: vi.fn(),
    probeProcess: () => false,
    monotonicNow: () => 0,
    ...overrides
  };
}

function nodeError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function runtimeState(overrides: Partial<WorkbenchRuntimeState> = {}): WorkbenchRuntimeState {
  return {
    runtimeKind: 'source-dev',
    processControl: 'managed',
    owner: { kind: 'cli', ownerId: 'cli-session', pid: 100 },
    daemonUrl: 'http://127.0.0.1:17321',
    webUrl: 'http://127.0.0.1:17322',
    token: 'secret',
    daemonPid: 10,
    webPid: 11,
    daemonLogPath: '/tmp/daemon.log',
    webLogPath: '/tmp/web.log',
    startedAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
    ...overrides
  };
}
