import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as pty from 'node-pty';
import type { TerminalPtyFactory } from './TerminalPty.js';

// Electron bundles this ESM source into CJS, where esbuild lowers import.meta to an empty object.
const nodeRequire = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);

export const nodePtyTerminalPtyFactory: TerminalPtyFactory = (input) => {
  ensureNodePtySpawnHelperExecutable();
  return pty.spawn(input.shell, input.args, {
    name: 'xterm-256color',
    cwd: input.cwd,
    env: input.env,
    cols: input.cols,
    rows: input.rows
  });
};

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
