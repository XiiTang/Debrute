import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureNodePtySpawnHelperExecutable,
  signalTerminalProcessGroup
} from './NodePtyTerminalPty.js';

const fsMocks = vi.hoisted(() => ({
  chmodSync: vi.fn(),
  existsSync: vi.fn(),
  statSync: vi.fn(() => ({ mode: 0o100644 }))
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  ...fsMocks
}));

describe('NodePtyTerminalPty', { tags: ['terminal'] }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.existsSync.mockImplementation((path) => {
      return String(path) === join('/node-pty', 'prebuilds/darwin-arm64/spawn-helper');
    });
    fsMocks.statSync.mockReturnValue({ mode: 0o100644 });
  });

  it('makes the Unix node-pty spawn helper executable before spawning', () => {
    ensureNodePtySpawnHelperExecutable({
      packageRoot: '/node-pty',
      platform: 'darwin',
      arch: 'arm64'
    });

    expect(fsMocks.chmodSync).toHaveBeenCalledWith(
      join('/node-pty', 'prebuilds/darwin-arm64/spawn-helper'),
      0o100755
    );
  });

  it('signals the Unix terminal process group for graceful and force termination', () => {
    const killProcess = vi.fn();

    signalTerminalProcessGroup({
      pid: 1234,
      signal: 'SIGHUP',
      platform: 'darwin',
      killProcess
    });
    signalTerminalProcessGroup({
      pid: 1234,
      signal: 'SIGKILL',
      platform: 'linux',
      killProcess
    });

    expect(killProcess).toHaveBeenCalledWith(-1234, 'SIGHUP');
    expect(killProcess).toHaveBeenCalledWith(-1234, 'SIGKILL');
  });

  it('uses the node-pty kill primitive on Windows', () => {
    const killPty = vi.fn();
    const killProcess = vi.fn();

    signalTerminalProcessGroup({
      pid: 1234,
      signal: 'SIGHUP',
      platform: 'win32',
      killProcess,
      killPty
    });

    expect(killPty).toHaveBeenCalledWith('SIGHUP');
    expect(killProcess).not.toHaveBeenCalled();
  });

  it('ignores already-exited Unix process groups', () => {
    const error = Object.assign(new Error('missing'), { code: 'ESRCH' });
    const killProcess = vi.fn(() => {
      throw error;
    });

    expect(() => signalTerminalProcessGroup({
      pid: 1234,
      signal: 'SIGHUP',
      platform: 'linux',
      killProcess
    })).not.toThrow();
  });
});
