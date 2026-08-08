import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';

import { terminateWindowsProcessTree } from '../../scripts/terminate-windows-process-tree.mjs';

describe('terminateWindowsProcessTree', () => {
  it('uses the absolute System32 taskkill path and waits for the owned child to exit', async () => {
    const child = fakeChild(4242);
    let command;
    let args;
    let settled = false;

    const termination = terminateWindowsProcessTree(child, { timeoutMs: 1_000 }, {
      platform: 'win32',
      windowsDirectory: 'D:\\Windows',
      runTaskkill: async (nextCommand, nextArgs) => {
        command = nextCommand;
        args = nextArgs;
      }
    }).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(command).toBe('D:\\Windows\\System32\\taskkill.exe');
    expect(args).toEqual(['/PID', '4242', '/T', '/F']);
    expect(settled).toBe(false);

    child.exitCode = 1;
    child.emit('exit', 1, null);
    await termination;
  });

  it('rejects use outside Windows without launching a command', async () => {
    let launched = false;

    await expect(terminateWindowsProcessTree(fakeChild(4242), {}, {
      platform: 'darwin',
      windowsDirectory: undefined,
      runTaskkill: async () => {
        launched = true;
      }
    })).rejects.toThrow('can only be used on Windows');
    expect(launched).toBe(false);
  });

  it('propagates taskkill failures', async () => {
    const child = fakeChild(4242);
    await expect(terminateWindowsProcessTree(child, { timeoutMs: 10 }, {
      platform: 'win32',
      windowsDirectory: 'C:\\Windows',
      runTaskkill: async () => {
        throw new Error('access denied');
      }
    })).rejects.toThrow('access denied');
    expect(child.listenerCount('exit')).toBe(0);
  });

  it('propagates taskkill failure even after the target exit is confirmed', async () => {
    const child = fakeChild(4242);

    await expect(terminateWindowsProcessTree(child, {}, {
      platform: 'win32',
      windowsDirectory: 'C:\\Windows',
      runTaskkill: async () => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
        throw new Error('target already exited');
      }
    })).rejects.toThrow('target already exited');
  });

  it('requires the native WINDIR instead of guessing a Windows installation', async () => {
    await expect(terminateWindowsProcessTree(fakeChild(4242), {}, {
      platform: 'win32',
      windowsDirectory: undefined,
      runTaskkill: async () => undefined
    })).rejects.toThrow('WINDIR is required');
  });

  it('does not launch taskkill when the child exits while the exit listener is attached', async () => {
    const child = fakeChild(4242);
    const once = child.once.bind(child);
    child.once = ((event: string, listener: (...args: unknown[]) => void) => {
      const result = once(event, listener);
      if (event === 'exit') {
        child.exitCode = 0;
      }
      return result;
    }) as typeof child.once;
    let launched = false;

    await terminateWindowsProcessTree(child, {}, {
      platform: 'win32',
      windowsDirectory: 'C:\\Windows',
      runTaskkill: async () => {
        launched = true;
      }
    });

    expect(launched).toBe(false);
  });

  it('allows an owned child a bounded graceful exit before launching taskkill', async () => {
    const child = fakeChild(4242);
    let launched = false;

    const termination = terminateWindowsProcessTree(child, {
      gracePeriodMs: 1_000
    }, {
      platform: 'win32',
      windowsDirectory: 'C:\\Windows',
      runTaskkill: async () => {
        launched = true;
      }
    });
    await Promise.resolve();
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await termination;

    expect(launched).toBe(false);
  });

  it('terminates a real Windows parent and grandchild process', async () => {
    if (process.platform !== 'win32') {
      return;
    }

    const parentProgram = `
      const { spawn } = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
        windowsHide: true
      });
      process.stdout.write(String(grandchild.pid) + '\\n');
      setInterval(() => {}, 1000);
    `;
    const parent = spawn(process.execPath, ['-e', parentProgram], {
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true
    });
    let grandchildPid: number | undefined;

    try {
      grandchildPid = await readPid(parent);
      await terminateWindowsProcessTree(parent, {
        label: 'process-tree contract fixture',
        timeoutMs: 5_000
      });

      await expectProcessGone(parent.pid!);
      await expectProcessGone(grandchildPid);
    } finally {
      await cleanupProcessTreeFixture(parent.pid, grandchildPid);
    }
  });

  it('propagates a real taskkill race while a detached descendant remains alive', async () => {
    if (process.platform !== 'win32') {
      return;
    }

    const parentProgram = `
      const { spawn } = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      grandchild.unref();
      process.stdout.write(String(grandchild.pid) + '\\n');
      process.stdin.once('data', () => process.exit(0));
    `;
    const parent = spawn(process.execPath, ['-e', parentProgram], {
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true
    });
    let grandchildPid: number | undefined;
    let taskkillExitCode: number | null = null;

    try {
      grandchildPid = await readPid(parent);
      const windowsDirectory = process.env.WINDIR;
      if (!windowsDirectory) {
        throw new Error('WINDIR is required for the real taskkill race fixture.');
      }
      await expect(terminateWindowsProcessTree(parent, {
        label: 'detached process-tree race fixture',
        timeoutMs: 2_000
      }, {
        platform: 'win32',
        windowsDirectory,
        runTaskkill: async (command, args, timeoutMs) => {
          if (parent.exitCode === null && parent.signalCode === null) {
            parent.stdin?.end('exit\n');
            await once(parent, 'exit');
          }
          const result = spawnSync(command, args, {
            timeout: timeoutMs,
            windowsHide: true,
            encoding: 'utf8'
          });
          if (result.error) {
            throw result.error;
          }
          taskkillExitCode = result.status;
          if (result.status !== 0) {
            throw new Error(`taskkill exited with code ${result.status}: ${result.stderr}`);
          }
        }
      })).rejects.toThrow('taskkill exited with code');

      expect(taskkillExitCode).not.toBe(0);
      await expectProcessGone(parent.pid!);
      expect(isProcessAlive(grandchildPid), `PID ${grandchildPid} should expose the cleanup gap`).toBe(true);
    } finally {
      await cleanupProcessTreeFixture(parent.pid, grandchildPid);
    }
  });
});

function fakeChild(pid: number) {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null
  });
}

function readPid(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Timed out waiting for grandchild PID.')), 5_000);
    child.stdout?.on('data', (chunk) => {
      output += String(chunk);
      const line = output.split(/\r?\n/, 1)[0];
      const pid = Number(line);
      if (Number.isInteger(pid) && pid > 0) {
        clearTimeout(timer);
        resolve(pid);
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      if (!Number.isInteger(Number(output.trim()))) {
        clearTimeout(timer);
        reject(new Error(`Process-tree fixture exited with code ${code} before reporting a PID.`));
      }
    });
  });
}

async function expectProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(isProcessAlive(pid), `PID ${pid} should have exited`).toBe(false);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cleanupProcessTreeFixture(...pids: Array<number | undefined>): Promise<void> {
  const results = await Promise.allSettled(pids.map(forceKillIfAlive));
  const failures = results.flatMap((result) => (
    result.status === 'rejected' ? [result.reason] : []
  ));
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Process-tree fixture cleanup failed.');
  }
}

async function forceKillIfAlive(pid: number | undefined): Promise<void> {
  if (!pid || !isProcessAlive(pid)) {
    return;
  }
  const windowsDirectory = process.env.WINDIR;
  if (!windowsDirectory) {
    throw new Error('WINDIR is required to clean the Windows process-tree fixture.');
  }
  const result = spawnSync(win32.join(windowsDirectory, 'System32', 'taskkill.exe'), [
    '/PID',
    String(pid),
    '/T',
    '/F'
  ], { stdio: 'ignore', windowsHide: true });
  if (result.error) {
    throw result.error;
  }
  await expectProcessGone(pid);
}
