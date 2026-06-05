#!/usr/bin/env tsx
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
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
} from '@debrute/workbench-runtime';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const paths = resolveWorkbenchRuntimePaths();
const children: ChildProcess[] = [];
let currentRuntimeState: WorkbenchRuntimeState | undefined;
let deleteOwnState = false;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(currentRuntimeState, deleteOwnState).finally(() => process.exit(0));
  });
}

const result = await ensureRegisteredWorkbenchRuntime({
  paths,
  launch: launchSourceDevRuntime,
  onRuntimeLaunchFailed: killChildren
});
currentRuntimeState = result.state;
deleteOwnState = result.runtimeStarted;

process.stdout.write(`Debrute Workbench: ${result.state.webUrl}\n`);

if (!deleteOwnState) {
  process.exit(0);
}

await new Promise((resolveExit) => {
  for (const child of children) {
    child.once('exit', resolveExit);
  }
});
await shutdown(currentRuntimeState, deleteOwnState);

async function launchSourceDevRuntime(): Promise<WorkbenchRuntimeState> {
  const daemonPort = await chooseLoopbackPort(DEFAULT_WORKBENCH_DAEMON_PORT);
  const webPort = await chooseLoopbackPort(DEFAULT_WORKBENCH_WEB_PORT, new Set([daemonPort]));
  const token = randomUUID();
  const daemonUrl = `http://127.0.0.1:${daemonPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  const daemon = spawnPnpm([
    '--filter',
    '@debrute/daemon',
    'dev',
    '--',
    '--port',
    String(daemonPort),
    '--token',
    token,
    '--web-base-url',
    webUrl
  ], {
    DEBRUTE_DAEMON_PORT: String(daemonPort),
    DEBRUTE_DAEMON_TOKEN: token,
    DEBRUTE_WEB_BASE_URL: webUrl
  });
  const web = spawnPnpm([
    '--filter',
    '@debrute/web',
    'dev',
    '--',
    '--host',
    '127.0.0.1',
    '--port',
    String(webPort),
    '--strictPort'
  ], {
    DEBRUTE_DAEMON_URL: daemonUrl
  });
  children.push(daemon, web);
  const now = new Date().toISOString();
  const state: WorkbenchRuntimeState = {
    schemaVersion: 1,
    runtimeKind: 'source-dev',
    processControl: 'external',
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
  currentRuntimeState = state;
  deleteOwnState = true;
  return state;
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
    throw new Error(`Debrute ${label} process did not report a pid.`);
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

function pnpmExecutable(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}
