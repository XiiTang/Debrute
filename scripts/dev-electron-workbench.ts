#!/usr/bin/env tsx
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageManagerCommand } from './package-manager-command.mjs';
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
const desktopRequire = createRequire(join(desktopRoot, 'package.json'));
const paths = resolveWorkbenchRuntimePaths();
const runtimeChildren: ChildProcess[] = [];
const CHILD_EXIT_GRACE_MS = 5_000;
const ownerId = randomUUID();
let currentRuntimeState: WorkbenchRuntimeState | undefined;
let deleteOwnState = false;
let electron: ChildProcess | undefined;
let shutdownPromise: Promise<void> | undefined;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void requestShutdown().finally(() => process.exit(0));
  });
}

process.once('exit', () => {
  deleteOwnRuntimeStateSync();
});

const buildCommand = packageManagerCommand(workspaceRoot, ['--filter', '@debrute/desktop', 'build:electron:dev']);
const build = spawnSync(buildCommand.command, buildCommand.args, {
  cwd: workspaceRoot,
  stdio: 'inherit'
});
if (build.error) {
  console.error(build.error);
}
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const result = await ensureRegisteredWorkbenchRuntime({
  paths,
  isHealthy: async (state) => isDesktopDevRuntimeForCurrentSession(state) && await isWorkbenchRuntimeHealthy(state),
  launch: launchDesktopDevRuntime,
  onRuntimeLaunchFailed: killRuntimeChildren
});
currentRuntimeState = result.state;
deleteOwnState = result.runtimeStarted;

electron = launchElectron();

await new Promise((resolveExit) => electron.once('exit', resolveExit));
await requestShutdown();

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
    DEBRUTE_WEB_BASE_URL: webUrl,
    ...sourceDevProductEnv()
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
    DEBRUTE_DAEMON_URL: daemonUrl,
    DEBRUTE_DAEMON_TOKEN_FILE: paths.tokenPath
  });
  const now = new Date().toISOString();
  const state: WorkbenchRuntimeState = {
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
  runtimeChildren.push(daemon, web);
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
  const command = packageManagerCommand(workspaceRoot, args);
  return spawn(command.command, command.args, {
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
  if (electron) {
    await stopElectron(electron);
    electron = undefined;
  }
  await stopRuntimeChildren();
  if (!state || !shouldDeleteState) {
    return;
  }
  const current = await readWorkbenchRuntimeState(paths.statePath).catch(() => undefined);
  if (current?.daemonUrl === state.daemonUrl && current.webUrl === state.webUrl && current.token === state.token) {
    await deleteWorkbenchRuntimeState(paths.statePath);
  }
}

function requestShutdown(): Promise<void> {
  shutdownPromise ??= shutdown(currentRuntimeState, deleteOwnState);
  return shutdownPromise;
}

function deleteOwnRuntimeStateSync(): void {
  if (currentRuntimeState && deleteOwnState) {
    rmSync(paths.statePath, { force: true });
  }
}

function killRuntimeChildren(): void {
  for (const child of runtimeChildren) {
    if (child.pid) {
      terminateRuntimeChild(child);
    }
  }
}

async function stopRuntimeChildren(): Promise<void> {
  await Promise.all(runtimeChildren.map((child) => stopChild(child)));
}

function terminateRuntimeChild(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill('SIGTERM');
}

async function stopElectron(child: ChildProcess): Promise<void> {
  await stopChild(child);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolveExit) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolveExit();
    }, CHILD_EXIT_GRACE_MS);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolveExit();
    });
    child.kill('SIGTERM');
  });
}

function electronExecutable(): string {
  return desktopRequire('electron') as string;
}

function sourceDevProductEnv(): Record<string, string> {
  return {
    DEBRUTE_DAEMON_PRODUCT_VERSION: readRootProductVersion(),
    DEBRUTE_DAEMON_CLI_PATH: join(workspaceRoot, 'apps/debrute-cli/src/index.ts'),
    DEBRUTE_DAEMON_SKILLS_PAYLOAD_DIR: join(workspaceRoot, 'skills')
  };
}

function readRootProductVersion(): string {
  const parsed = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as unknown;
  if (!isRecord(parsed) || typeof parsed.version !== 'string' || parsed.version.trim() === '') {
    throw new Error(`Invalid Debrute root package version: ${join(workspaceRoot, 'package.json')}.`);
  }
  return parsed.version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
