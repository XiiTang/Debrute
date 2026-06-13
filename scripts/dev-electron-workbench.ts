#!/usr/bin/env tsx
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_WORKBENCH_DAEMON_PORT,
  DEFAULT_WORKBENCH_WEB_PORT,
  chooseLoopbackPort,
  deleteWorkbenchRuntimeState,
  ensureRegisteredWorkbenchRuntime,
  isWorkbenchRuntimeHealthy,
  readWorkbenchRuntimeState,
  resolveWorkbenchRuntimePaths,
  type WorkbenchRuntimeState
} from '@debrute/workbench-runtime';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopRoot = join(workspaceRoot, 'apps/desktop');
const paths = resolveWorkbenchRuntimePaths();
const children: ChildProcess[] = [];
const ownerId = randomUUID();
let currentRuntimeState: WorkbenchRuntimeState | undefined;
let deleteOwnState = false;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(currentRuntimeState, deleteOwnState).finally(() => process.exit(0));
  });
}

const build = spawnSync(pnpmExecutable(), ['--filter', '@debrute/desktop', 'build:electron:dev'], {
  cwd: workspaceRoot,
  stdio: 'inherit'
});
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const result = await ensureRegisteredWorkbenchRuntime({
  paths,
  isHealthy: async (state) => isDesktopDevRuntimeForCurrentSession(state) && await isWorkbenchRuntimeHealthy(state),
  launch: launchDesktopDevRuntime,
  onRuntimeLaunchFailed: killChildren
});
currentRuntimeState = result.state;
deleteOwnState = result.runtimeStarted;

const electron = launchElectron();
children.push(electron);

await new Promise((resolveExit) => electron.once('exit', resolveExit));
await shutdown(currentRuntimeState, deleteOwnState);

async function launchDesktopDevRuntime(): Promise<WorkbenchRuntimeState> {
  const daemonPort = await chooseLoopbackPort(DEFAULT_WORKBENCH_DAEMON_PORT);
  const webPort = await chooseLoopbackPort(DEFAULT_WORKBENCH_WEB_PORT, new Set([daemonPort]));
  const token = randomUUID();
  await writeRuntimeTokenFile(token);
  const daemonUrl = `http://127.0.0.1:${daemonPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  const daemon = spawnPnpm([
    '--filter',
    '@debrute/daemon',
    'dev',
    '--port',
    String(daemonPort),
    '--token-file',
    paths.tokenPath,
    '--web-base-url',
    webUrl
  ], {
    DEBRUTE_DAEMON_PORT: String(daemonPort),
    DEBRUTE_DAEMON_TOKEN_FILE: paths.tokenPath,
    DEBRUTE_WEB_BASE_URL: webUrl
  });
  const web = spawnPnpm([
    '--filter',
    '@debrute/web',
    'dev',
    '--host',
    '127.0.0.1',
    '--port',
    String(webPort),
    '--strictPort'
  ], {
    DEBRUTE_DAEMON_URL: daemonUrl
  });
  const now = new Date().toISOString();
  const state: WorkbenchRuntimeState = {
    schemaVersion: 2,
    runtimeKind: 'desktop-dev',
    processControl: 'external',
    owner: {
      kind: 'dev',
      ownerId,
      pid: process.pid
    },
    daemonUrl,
    webUrl,
    token,
    daemonPid: requirePid(daemon, 'daemon'),
    webPid: requirePid(web, 'web'),
    daemonLogPath: paths.daemonLogPath,
    webLogPath: paths.webLogPath,
    startedAt: now,
    updatedAt: now
  };
  children.push(daemon, web);
  return state;
}

function launchElectron(): ChildProcess {
  return spawnElectron();
}

function spawnElectron(): ChildProcess {
  return spawn(electronExecutable(), ['.'], {
    cwd: desktopRoot,
    stdio: 'inherit',
    env: process.env
  });
}

function spawnPnpm(args: string[], env: Record<string, string>): ChildProcess {
  return spawn(pnpmExecutable(), args, {
    cwd: workspaceRoot,
    stdio: 'inherit',
    env: { ...process.env, ...env }
  });
}

async function writeRuntimeTokenFile(token: string): Promise<void> {
  await mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 });
  await writeFile(paths.tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
}

function requirePid(child: ChildProcess, label: string): number {
  if (!child.pid) {
    throw new Error(`Debrute ${label} process did not report a pid.`);
  }
  return child.pid;
}

function isDesktopDevRuntimeForCurrentSession(state: WorkbenchRuntimeState): boolean {
  return state.runtimeKind === 'desktop-dev'
    && state.owner.kind === 'dev'
    && state.owner.ownerId === ownerId;
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
