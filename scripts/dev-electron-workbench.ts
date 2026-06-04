#!/usr/bin/env tsx
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_WORKBENCH_DAEMON_PORT,
  DEFAULT_WORKBENCH_WEB_PORT,
  chooseLoopbackPort,
  deleteWorkbenchRuntimeState,
  ensureRegisteredWorkbenchRuntime,
  readWorkbenchRuntimeState,
  resolveWorkbenchRuntimePaths,
  type WorkbenchRuntimeState
} from '@axis/workbench-runtime';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopRoot = join(workspaceRoot, 'apps/desktop');
const paths = resolveWorkbenchRuntimePaths();
const children: ChildProcess[] = [];
let currentElectronChild: ChildProcess | undefined;
let currentRuntimeState: WorkbenchRuntimeState | undefined;
let deleteOwnState = false;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(currentRuntimeState, deleteOwnState).finally(() => process.exit(0));
  });
}

const build = spawnSync(pnpmExecutable(), ['--filter', '@axis/desktop', 'build:electron:dev'], {
  cwd: workspaceRoot,
  stdio: 'inherit'
});
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const result = await ensureRegisteredWorkbenchRuntime({
  paths,
  launch: launchDesktopDevRuntime,
  onRuntimeLaunchFailed: killChildren
});
currentRuntimeState = result.state;
deleteOwnState = result.runtimeStarted;

let electron = currentElectronChild;
if (!result.runtimeStarted) {
  electron = launchElectronAttached(result.state);
  children.push(electron);
}
if (!electron) {
  throw new Error('Electron process was not launched.');
}

await new Promise((resolveExit) => electron.once('exit', resolveExit));
await shutdown(currentRuntimeState, deleteOwnState);

async function launchDesktopDevRuntime(): Promise<WorkbenchRuntimeState> {
  const daemonPort = await chooseLoopbackPort(DEFAULT_WORKBENCH_DAEMON_PORT);
  const webPort = await chooseLoopbackPort(DEFAULT_WORKBENCH_WEB_PORT, new Set([daemonPort]));
  const token = randomUUID();
  const daemonUrl = `http://127.0.0.1:${daemonPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  const web = spawnPnpm([
    '--filter',
    '@axis/web',
    'dev',
    '--',
    '--host',
    '127.0.0.1',
    '--port',
    String(webPort),
    '--strictPort'
  ], {
    AXIS_DAEMON_URL: daemonUrl
  });
  const electron = spawnElectron({
    AXIS_WORKBENCH_RUNTIME_MODE: 'hosted',
    AXIS_WEB_URL: webUrl,
    AXIS_DAEMON_PORT: String(daemonPort),
    AXIS_DAEMON_TOKEN: token,
    AXIS_WORKBENCH_RUNTIME_KIND: 'desktop-dev'
  });
  currentElectronChild = electron;
  children.push(web, electron);
  const now = new Date().toISOString();
  const state: WorkbenchRuntimeState = {
    schemaVersion: 1,
    runtimeKind: 'desktop-dev',
    processControl: 'external',
    daemonUrl,
    webUrl,
    token,
    daemonPid: requirePid(electron, 'electron'),
    webPid: requirePid(web, 'web'),
    daemonLogPath: paths.daemonLogPath,
    webLogPath: paths.webLogPath,
    startedAt: now,
    updatedAt: now
  };
  currentRuntimeState = state;
  deleteOwnState = true;
  return state;
}

function launchElectronAttached(state: WorkbenchRuntimeState): ChildProcess {
  return spawnElectron({
    AXIS_WORKBENCH_RUNTIME_MODE: 'attached',
    AXIS_DAEMON_URL: state.daemonUrl,
    AXIS_WEB_URL: state.webUrl,
    AXIS_DAEMON_TOKEN: state.token
  });
}

function spawnElectron(env: Record<string, string>): ChildProcess {
  return spawn(electronExecutable(), ['.'], {
    cwd: desktopRoot,
    stdio: 'inherit',
    env: { ...process.env, ...env }
  });
}

function spawnPnpm(args: string[], env: Record<string, string>): ChildProcess {
  return spawn(pnpmExecutable(), args, {
    cwd: workspaceRoot,
    stdio: 'inherit',
    env: { ...process.env, ...env }
  });
}

function requirePid(child: ChildProcess, label: string): number {
  if (!child.pid) {
    throw new Error(`AXIS ${label} process did not report a pid.`);
  }
  return child.pid;
}

async function shutdown(state: WorkbenchRuntimeState | undefined, shouldDeleteState: boolean): Promise<void> {
  killChildren();
  if (!state || !shouldDeleteState) {
    return;
  }
  const current = await readWorkbenchRuntimeState(paths.statePath).catch(() => undefined);
  if (current?.daemonUrl === state.daemonUrl && current.webUrl === state.webUrl && current.token === state.token) {
    await deleteWorkbenchRuntimeState(paths.statePath);
  }
}

function killChildren(): void {
  for (const child of children) {
    if (child.pid) {
      child.kill('SIGTERM');
    }
  }
}

function electronExecutable(): string {
  return process.platform === 'win32'
    ? join(desktopRoot, 'node_modules/.bin/electron.cmd')
    : join(desktopRoot, 'node_modules/.bin/electron');
}

function pnpmExecutable(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}
