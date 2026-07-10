import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureNodePtySpawnHelperExecutable,
  signalTerminalProcessGroup
} from '../apps/app-server/src/terminal/NodePtyTerminalPty';

describe('NodePtyTerminalPty', () => {
  const roots: string[] = [];

  afterEach(async () => {
    while (roots.length > 0) {
      await rm(roots.pop()!, { recursive: true, force: true });
    }
  });

  it('makes the Unix node-pty spawn helper executable before spawning', async () => {
    const root = await tempRoot();
    const helperPath = join(root, 'prebuilds/darwin-arm64/spawn-helper');
    await mkdir(join(root, 'prebuilds/darwin-arm64'), { recursive: true });
    await writeFile(helperPath, 'helper', { mode: 0o644 });

    ensureNodePtySpawnHelperExecutable({
      packageRoot: root,
      platform: 'darwin',
      arch: 'arm64'
    });

    expect((await stat(helperPath)).mode & 0o111).toBe(0o111);
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

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'debrute-node-pty-'));
    roots.push(root);
    return root;
  }
});
