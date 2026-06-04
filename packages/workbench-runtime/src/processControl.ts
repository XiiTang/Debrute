import type { WorkbenchRuntimeState } from './state.js';

export type WorkbenchRuntimeKill = (pid: number, signal: NodeJS.Signals) => unknown;

export function terminateManagedWorkbenchRuntime(
  state: WorkbenchRuntimeState,
  kill: WorkbenchRuntimeKill = process.kill
): void {
  if (state.processControl !== 'managed') {
    return;
  }
  for (const pid of new Set([state.daemonPid, state.webPid].filter((value): value is number => typeof value === 'number'))) {
    try {
      kill(pid, 'SIGTERM');
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ESRCH') {
        throw error;
      }
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string';
}
