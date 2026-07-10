import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as pty from 'node-pty';
import type { TerminalPtyFactory } from './TerminalPty.js';

// Electron bundles this ESM source into CJS, where esbuild lowers import.meta to an empty object.
const nodeRequire = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);

export const nodePtyTerminalPtyFactory: TerminalPtyFactory = (input) => {
  ensureNodePtySpawnHelperExecutable();
  const spawned = pty.spawn(input.shell, input.args, {
    name: 'xterm-256color',
    cwd: input.cwd,
    env: input.env,
    cols: input.cols,
    rows: input.rows
  });
  return {
    get pid() {
      return spawned.pid;
    },
    write: (data) => spawned.write(data),
    resize: (cols, rows) => spawned.resize(cols, rows),
    terminate: () => signalTerminalProcessGroup({
      pid: spawned.pid,
      signal: 'SIGHUP',
      killPty: (signal) => spawned.kill(signal)
    }),
    forceKill: () => signalTerminalProcessGroup({
      pid: spawned.pid,
      signal: 'SIGKILL',
      killPty: (signal) => spawned.kill(signal)
    }),
    onData: (listener) => spawned.onData(listener),
    onExit: (listener) => spawned.onExit(listener)
  };
};

export function signalTerminalProcessGroup(input: {
  pid: number;
  signal: 'SIGHUP' | 'SIGKILL';
  platform?: NodeJS.Platform;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  killPty?: (signal?: string) => void;
}): void {
  const platform = input.platform ?? process.platform;
  if (platform === 'win32') {
    input.killPty?.(input.signal);
    return;
  }

  const killProcess = input.killProcess ?? process.kill;
  try {
    killProcess(-input.pid, input.signal);
  } catch (error) {
    if (isMissingProcessError(error)) {
      return;
    }
    throw error;
  }
}

function isMissingProcessError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code: unknown }).code === 'ESRCH';
}

export function ensureNodePtySpawnHelperExecutable(input: {
  packageRoot?: string;
  platform?: NodeJS.Platform;
  arch?: string;
} = {}): void {
  const platform = input.platform ?? process.platform;
  if (platform === 'win32') return;

  const arch = input.arch ?? process.arch;
  const packageRoot = input.packageRoot ?? dirname(nodeRequire.resolve('node-pty/package.json'));
  const helperPaths = [
    join(packageRoot, 'build/Release/spawn-helper'),
    join(packageRoot, 'prebuilds', `${platform}-${arch}`, 'spawn-helper')
  ];

  for (const helperPath of helperPaths) {
    if (!existsSync(helperPath)) continue;
    const mode = statSync(helperPath).mode;
    if ((mode & 0o111) !== 0o111) {
      chmodSync(helperPath, mode | 0o755);
    }
  }
}
