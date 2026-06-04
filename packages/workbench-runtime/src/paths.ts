import { join } from 'node:path';

export interface WorkbenchRuntimePaths {
  runtimeDir: string;
  statePath: string;
  lockPath: string;
  daemonLogPath: string;
  webLogPath: string;
}

export function resolveWorkbenchRuntimePaths(axisHome = resolveAxisHomeDir()): WorkbenchRuntimePaths {
  const runtimeDir = join(axisHome, 'runtime');
  return {
    runtimeDir,
    statePath: join(runtimeDir, 'workbench-runtime.json'),
    lockPath: join(runtimeDir, 'workbench-runtime.lock'),
    daemonLogPath: join(runtimeDir, 'workbench-daemon.log'),
    webLogPath: join(runtimeDir, 'workbench-web.log')
  };
}

function resolveAxisHomeDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    throw new Error('User home directory is not available.');
  }
  return join(home, '.axis');
}
