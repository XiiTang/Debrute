import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  DEFAULT_WORKBENCH_DAEMON_PORT,
  chooseLoopbackPort,
  type WorkbenchRuntimeOwner,
  type WorkbenchRuntimePaths,
  type WorkbenchRuntimeState
} from '@debrute/workbench-runtime';

export async function launchPackagedDesktopRuntime(
  paths: WorkbenchRuntimePaths,
  owner: WorkbenchRuntimeOwner
): Promise<WorkbenchRuntimeState> {
  const daemonPort = await chooseLoopbackPort(DEFAULT_WORKBENCH_DAEMON_PORT);
  const token = randomUUID();
  await mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 });
  await writeFile(paths.tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  const child = spawnRuntimeHost(paths, owner, daemonPort);
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    runtimeKind: process.env.DEBRUTE_WORKBENCH_RUNTIME_KIND === 'desktop-dev' ? 'desktop-dev' : 'desktop-packaged',
    processControl: 'managed',
    owner,
    daemonUrl: `http://127.0.0.1:${daemonPort}`,
    webUrl: `http://127.0.0.1:${daemonPort}`,
    token,
    daemonPid: requirePid(child),
    daemonLogPath: paths.daemonLogPath,
    webLogPath: paths.webLogPath,
    startedAt: now,
    updatedAt: now
  };
}

function spawnRuntimeHost(
  paths: WorkbenchRuntimePaths,
  owner: WorkbenchRuntimeOwner,
  daemonPort: number
): ChildProcess {
  const logFd = openSync(paths.daemonLogPath, 'a');
  try {
    const child = spawn(process.execPath, [runtimeHostEntryPath()], {
      cwd: dirname(process.execPath),
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DEBRUTE_RUNTIME_HOST_DAEMON_PORT: String(daemonPort),
        DEBRUTE_RUNTIME_HOST_TOKEN_FILE: paths.tokenPath,
        DEBRUTE_RUNTIME_HOST_WEB_DIST_DIR: resolve(__dirname, '../dist')
      }
    });
    child.unref();
    return child;
  } finally {
    closeSync(logFd);
  }
}

function runtimeHostEntryPath(): string {
  return join(__dirname, 'runtime-host.cjs');
}

function requirePid(child: ChildProcess): number {
  if (!child.pid) {
    throw new Error('Debrute runtime host process did not report a pid.');
  }
  return child.pid;
}
