import type { WorkbenchRuntimeHealthStatus, WorkbenchRuntimeState } from '@debrute/workbench-runtime';

export type DesktopRuntimeStatus = 'starting' | 'running' | 'degraded' | 'stopped' | 'error';

export interface DesktopRuntimeSnapshot {
  status: DesktopRuntimeStatus;
  state?: WorkbenchRuntimeState;
  ownsRuntime: boolean;
  lastHealth?: WorkbenchRuntimeHealthStatus;
  lastError?: string;
}

export function desktopStatusFromHealth(health: WorkbenchRuntimeHealthStatus): DesktopRuntimeStatus {
  if (health === 'healthy') {
    return 'running';
  }
  if (health === 'web-unavailable') {
    return 'degraded';
  }
  return 'error';
}
