import { randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cliError, isAxisCliError, messageFromUnknown } from '../errors/cliErrors.js';
import { packagedExecutablePath } from '../runtime/packagedNodeModules.js';
import { INTERNAL_WORKBENCH_RUNTIME_CHILD_COMMAND } from './workbenchRuntimeChildEntrypoint.js';
import {
  DEFAULT_WORKBENCH_DAEMON_PORT,
  DEFAULT_WORKBENCH_WEB_PORT,
  chooseLoopbackPort,
  ensureRegisteredWorkbenchRuntime,
  isWorkbenchRuntimeHealthy,
  isWorkbenchRuntimeRegistryError,
  terminateManagedWorkbenchRuntime,
  type EnsureRegisteredWorkbenchRuntimeResult,
  type WorkbenchRuntimePaths,
  type WorkbenchRuntimeState
} from '@axis/workbench-runtime';

export {
  DEFAULT_WORKBENCH_DAEMON_PORT,
  DEFAULT_WORKBENCH_WEB_PORT,
  chooseLoopbackPort,
  type WorkbenchRuntimeKind,
  type WorkbenchRuntimeState
} from '@axis/workbench-runtime';

export type EnsureWorkbenchRuntimeResult = EnsureRegisteredWorkbenchRuntimeResult;

export interface EnsureWorkbenchRuntimeServices {
  paths?: WorkbenchRuntimePaths;
  isHealthy?: (state: WorkbenchRuntimeState) => Promise<boolean>;
  launch?: (paths: WorkbenchRuntimePaths) => Promise<WorkbenchRuntimeState>;
}

export async function ensureWorkbenchRuntime(
  services: EnsureWorkbenchRuntimeServices = {}
): Promise<EnsureWorkbenchRuntimeResult> {
  try {
    return await ensureRegisteredWorkbenchRuntime({
      ...(services.paths ? { paths: services.paths } : {}),
      isHealthy: services.isHealthy ?? isWorkbenchRuntimeHealthy,
      launch: services.launch ?? launchWorkbenchRuntime,
      onRuntimeLaunchFailed: terminateManagedWorkbenchRuntime
    });
  } catch (error) {
    if (isAxisCliError(error)) {
      throw error;
    }
    if (isWorkbenchRuntimeRegistryError(error)) {
      throw cliError(error.code, error.message);
    }
    throw cliError('runtime_launch_failed', messageFromUnknown(error));
  }
}

async function launchWorkbenchRuntime(paths: WorkbenchRuntimePaths): Promise<WorkbenchRuntimeState> {
  const sourceRoot = await resolveSourceCheckoutRoot(resolveWorkbenchRuntimeEntryDir());
  return sourceRoot
    ? launchSourceDevRuntime(sourceRoot, paths)
    : launchPackagedRuntime(paths);
}

async function launchSourceDevRuntime(sourceRoot: string, paths: WorkbenchRuntimePaths): Promise<WorkbenchRuntimeState> {
  const daemonPort = await chooseLoopbackPort(DEFAULT_WORKBENCH_DAEMON_PORT);
  const webPort = await chooseLoopbackPort(DEFAULT_WORKBENCH_WEB_PORT, new Set([daemonPort]));
  const token = randomUUID();
  const daemonUrl = `http://127.0.0.1:${daemonPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  const now = new Date().toISOString();
  const daemon = spawnDetached(pnpmExecutable(), [
    '--filter',
    '@axis/daemon',
    'dev',
    '--',
    '--port',
    String(daemonPort),
    '--token',
    token,
    '--web-base-url',
    webUrl
  ], sourceRoot, paths.daemonLogPath, {
    AXIS_DAEMON_PORT: String(daemonPort),
    AXIS_DAEMON_TOKEN: token,
    AXIS_WEB_BASE_URL: webUrl
  });
  const web = spawnDetached(pnpmExecutable(), [
    '--filter',
    '@axis/web',
    'dev',
    '--',
    '--host',
    '127.0.0.1',
    '--port',
    String(webPort),
    '--strictPort'
  ], sourceRoot, paths.webLogPath, {
    AXIS_DAEMON_URL: daemonUrl
  });

  return {
    schemaVersion: 1,
    runtimeKind: 'source-dev',
    processControl: 'managed',
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
}

async function launchPackagedRuntime(paths: WorkbenchRuntimePaths): Promise<WorkbenchRuntimeState> {
  const executablePath = packagedExecutablePath();
  const daemonPort = await chooseLoopbackPort(DEFAULT_WORKBENCH_DAEMON_PORT);
  const token = randomUUID();
  const daemonUrl = `http://127.0.0.1:${daemonPort}`;
  const now = new Date().toISOString();
  const daemon = spawnDetached(executablePath, [
    INTERNAL_WORKBENCH_RUNTIME_CHILD_COMMAND
  ], process.cwd(), paths.daemonLogPath, {
    AXIS_WORKBENCH_RUNTIME_PORT: String(daemonPort),
    AXIS_WORKBENCH_RUNTIME_TOKEN: token,
    AXIS_WORKBENCH_RUNTIME_WEB_DIST_DIR: resolve(dirname(executablePath), 'web'),
    PKG_EXECPATH: ''
  });

  return {
    schemaVersion: 1,
    runtimeKind: 'packaged',
    processControl: 'managed',
    daemonUrl,
    webUrl: daemonUrl,
    token,
    daemonPid: requirePid(daemon, 'daemon'),
    daemonLogPath: paths.daemonLogPath,
    webLogPath: paths.webLogPath,
    startedAt: now,
    updatedAt: now
  };
}

function spawnDetached(
  command: string,
  args: string[],
  cwd: string,
  logPath: string,
  env: Record<string, string>
): ChildProcess {
  const logFd = openSync(logPath, 'a');
  try {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, ...env }
    });
    child.unref();
    return child;
  } finally {
    closeSync(logFd);
  }
}

function requirePid(child: ChildProcess, label: string): number {
  if (!child.pid) {
    throw cliError('runtime_launch_failed', `AXIS ${label} process did not report a pid.`);
  }
  return child.pid;
}

async function resolveSourceCheckoutRoot(startDir: string): Promise<string | undefined> {
  let current = resolve(startDir);
  while (true) {
    if (await isSourceCheckoutRoot(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

async function isSourceCheckoutRoot(path: string): Promise<boolean> {
  return await fileExists(resolve(path, 'package.json'))
    && await fileExists(resolve(path, 'pnpm-workspace.yaml'))
    && await fileExists(resolve(path, 'apps/web/package.json'))
    && await fileExists(resolve(path, 'apps/daemon/package.json'));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function resolveWorkbenchRuntimeEntryDir(
  importMetaUrl?: string,
  execPath = packagedExecutablePath()
): string {
  const moduleUrl = arguments.length === 0 ? import.meta.url : importMetaUrl;
  return typeof moduleUrl === 'string' && moduleUrl.startsWith('file:')
    ? dirname(fileURLToPath(moduleUrl))
    : dirname(packagedExecutablePath(execPath));
}

function pnpmExecutable(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}
