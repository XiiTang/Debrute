#!/usr/bin/env tsx
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import { packageManagerCommand } from './package-manager-command.mjs';
import {
  buildRustRuntime,
  chooseDevelopmentPort,
  ensureRustRuntime,
  runtimeAssetsDirectory,
  runtimeEntrypoint,
  workspaceRoot
} from './rust-runtime-dev.js';
import { parseWorkbenchDevelopmentOptions } from './workbench-development-options.js';

const developmentOptions = parseWorkbenchDevelopmentOptions(process.argv.slice(2));
const desktopRoot = join(workspaceRoot, 'apps/desktop');
const desktopRequire = createRequire(join(desktopRoot, 'package.json'));
const electronEntrypoint = desktopRequire('electron') as string;
const electronArguments = ['.'];
let vite: ChildProcess | undefined;
let electron: ChildProcess | undefined;
let shutdown: Promise<void> | undefined;
const VITE_STARTUP_TIMEOUT_MS = 60_000;

ensureDevelopmentElectronIsSigned();
const runtimeRebuilt = await buildRustRuntime();
const control = await ensureRustRuntime({
  desktopEntrypoint: electronEntrypoint,
  desktopArguments: [desktopRoot],
  restartExisting: runtimeRebuilt
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void requestShutdown().finally(() => process.exit(0)));
}
const vitePort = await chooseDevelopmentPort();
const viteOrigin = `http://127.0.0.1:${vitePort}`;

const buildCommand = packageManagerCommand(workspaceRoot, [
  '--filter',
  '@debrute/desktop',
  'build:electron:dev'
]);
const build = spawnSync(buildCommand.command, buildCommand.args, {
  cwd: workspaceRoot,
  stdio: 'inherit'
});
if (build.error) {
  control.close();
  throw build.error;
}
if (build.status !== 0) {
  control.close();
  process.exit(build.status ?? 1);
}

const registration = await control.registerDevWorkbenchOrigin(viteOrigin);
if (registration.result !== 'dev_workbench_origin_registered') {
  control.close();
  throw new Error(`Runtime rejected source Workbench registration: ${registration.result}`);
}

const viteCommand = packageManagerCommand(workspaceRoot, [
  '--filter',
  '@debrute/web',
  'dev',
  '--port',
  String(vitePort),
  '--strictPort'
]);
vite = spawn(viteCommand.command, viteCommand.args, {
  cwd: workspaceRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    DEBRUTE_RUNTIME_ORIGIN: registration.runtime_origin,
    VITE_DEBRUTE_CANVAS_PERF: developmentOptions.canvasPerfEnabled ? '1' : '0'
  }
});
try {
  await waitForVite(viteOrigin);
  process.stdout.write(`Canvas performance probe: ${developmentOptions.canvasPerfEnabled ? 'enabled' : 'disabled'}\n`);

  electron = spawn(electronEntrypoint, electronArguments, {
    cwd: desktopRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      DEBRUTE_RUNTIME_ENTRYPOINT: runtimeEntrypoint,
      DEBRUTE_RUNTIME_WEB_ASSETS_DIR: runtimeAssetsDirectory,
      DEBRUTE_DESKTOP_VITE_ORIGIN: viteOrigin
    }
  });

  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    electron?.once('error', reject);
    electron?.once('exit', resolveExit);
  });
  electron = undefined;
  if (exitCode !== 0) {
    process.exitCode = exitCode ?? 1;
  }
} finally {
  await requestShutdown();
}

function requestShutdown(): Promise<void> {
  shutdown ??= Promise.all([stopChild(electron), stopChild(vite)]).then(() => {
    control.close();
  });
  return shutdown;
}

function ensureDevelopmentElectronIsSigned(): void {
  if (process.platform !== 'darwin') {
    return;
  }
  const application = resolve(dirname(electronEntrypoint), '../..');
  const verification = spawnSync('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    application
  ], { stdio: 'ignore' });
  if (verification.error) {
    throw verification.error;
  }
  if (verification.status === 0) {
    return;
  }
  const frameworks = join(application, 'Contents/Frameworks');
  const inheritedEntitlements = join(desktopRoot, 'build/entitlements.mac.inherit.plist');
  for (const name of readdirSync(frameworks).filter((name) => (
    name.startsWith('Electron Helper') && name.endsWith('.app')
  ))) {
    codesign([
      '--force',
      '--deep',
      '--sign',
      '-',
      '--entitlements',
      inheritedEntitlements,
      join(frameworks, name)
    ]);
  }
  for (const name of readdirSync(frameworks).filter((name) => name.endsWith('.framework'))) {
    codesign(['--force', '--deep', '--sign', '-', join(frameworks, name)]);
  }
  codesign([
    '--force',
    '--sign',
    '-',
    '--entitlements',
    join(desktopRoot, 'build/entitlements.mac.plist'),
    application
  ]);
  codesign(['--verify', '--deep', '--strict', application]);
}

function codesign(arguments_: string[]): void {
  const result = spawnSync('/usr/bin/codesign', arguments_, { stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`macOS development signing failed with code ${result.status ?? 'unknown'}.`);
  }
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolveExit) => {
    child.once('exit', () => resolveExit());
    child.kill('SIGTERM');
  });
}

async function waitForVite(origin: string): Promise<void> {
  const deadline = Date.now() + VITE_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (vite?.exitCode !== null) {
      throw new Error(`Vite exited during startup with code ${vite?.exitCode}.`);
    }
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        return;
      }
    } catch {
      // Vite has not bound yet; this is bounded startup synchronization.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error('Vite did not start in time.');
}
