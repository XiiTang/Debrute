import type { MenuItemConstructorOptions } from 'electron';
import type { DesktopRuntimeSnapshot } from '../runtime/runtimeStatus.js';

export interface RuntimeTrayActions {
  openDebrute(): void;
  openInElectron(): void;
  openInBrowser(): void;
  copyBrowserUrl(): void;
  openProjectInElectron(): void;
  openRecentInElectron(projectRoot: string): void;
  showRuntimeStatus(): void;
  restartRuntime(): void;
  quitDebrute(): void;
}

export interface BuildRuntimeTrayMenuInput {
  platform: NodeJS.Platform;
  snapshot: DesktopRuntimeSnapshot;
  recentProjectRoots: string[];
  actions: RuntimeTrayActions;
}

export function buildRuntimeTrayMenuTemplate(input: BuildRuntimeTrayMenuInput): MenuItemConstructorOptions[] {
  const runtimeUsable = input.snapshot.status === 'running' || input.snapshot.status === 'degraded';
  return [
    { label: `Runtime: ${input.snapshot.status}`, enabled: false },
    { label: 'Open Debrute', enabled: runtimeUsable, click: input.actions.openDebrute },
    { label: 'Open in Electron', enabled: runtimeUsable, click: input.actions.openInElectron },
    { label: 'Open in Browser', enabled: runtimeUsable, click: input.actions.openInBrowser },
    { label: 'Copy Browser URL', enabled: runtimeUsable, click: input.actions.copyBrowserUrl },
    { label: 'Open Project in Electron...', enabled: runtimeUsable, click: input.actions.openProjectInElectron },
    {
      label: 'Open Recent in Electron',
      enabled: runtimeUsable && input.recentProjectRoots.length > 0,
      submenu: input.recentProjectRoots.length > 0
        ? input.recentProjectRoots.map((projectRoot) => ({
          label: projectRoot,
          click: () => input.actions.openRecentInElectron(projectRoot)
        }))
        : [{ label: 'No Recent Projects', enabled: false }]
    },
    { label: 'Runtime Status', click: input.actions.showRuntimeStatus },
    { label: 'Restart Runtime', enabled: input.snapshot.ownsRuntime, click: input.actions.restartRuntime },
    { type: 'separator' },
    { label: input.platform === 'win32' ? 'Exit Debrute' : 'Quit Debrute', click: input.actions.quitDebrute }
  ];
}
