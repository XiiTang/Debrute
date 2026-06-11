import { join } from 'node:path';

export interface WorkbenchRuntimePaths {
  runtimeDir: string;
  statePath: string;
  lockPath: string;
  tokenPath: string;
  daemonLogPath: string;
  webLogPath: string;
}

export function resolveWorkbenchRuntimePaths(debruteHome = resolveDebruteHomeDir()): WorkbenchRuntimePaths {
  const runtimeDir = join(debruteHome, 'runtime');
  return {
    runtimeDir,
    statePath: join(runtimeDir, 'workbench-runtime.json'),
    lockPath: join(runtimeDir, 'workbench-runtime.lock'),
    tokenPath: join(runtimeDir, 'workbench-runtime.token'),
    daemonLogPath: join(runtimeDir, 'workbench-daemon.log'),
    webLogPath: join(runtimeDir, 'workbench-web.log')
  };
}

function resolveDebruteHomeDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    throw new Error('User home directory is not available.');
  }
  return join(home, '.debrute');
}
