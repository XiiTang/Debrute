import type { WorkbenchApiClient } from '../../types';

export function createWorkbenchApiClient(): WorkbenchApiClient {
  if (typeof window === 'undefined' || !window.axisDesktop) {
    throw new Error('AXIS desktop preload API is required. Start the workbench through Electron.');
  }
  return {
    ...window.axisDesktop,
    mode: 'desktop'
  };
}
