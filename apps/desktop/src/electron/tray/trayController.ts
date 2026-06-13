import { join } from 'node:path';
import type electron from 'electron';
import type { DesktopRuntimeStatus } from '../runtime/runtimeStatus.js';
import type { RuntimeSupervisor } from '../runtime/runtimeSupervisor.js';
import { buildRuntimeTrayMenuTemplate, type RuntimeTrayActions } from './runtimeTrayMenu.js';

export interface TrayControllerInput {
  app: Electron.App;
  Tray: typeof electron.Tray;
  Menu: typeof electron.Menu;
  runtimeSupervisor: RuntimeSupervisor;
  readRecentProjectRoots(): Promise<string[]>;
  actions: RuntimeTrayActions;
}

export class TrayController {
  private tray: Electron.Tray | undefined;

  constructor(private readonly input: TrayControllerInput) {}

  async start(): Promise<void> {
    this.tray = new this.input.Tray(this.iconPath(this.input.runtimeSupervisor.snapshot().status));
    this.input.runtimeSupervisor.on('change', () => {
      void this.refresh();
    });
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.tray) {
      return;
    }
    const snapshot = this.input.runtimeSupervisor.snapshot();
    this.tray.setImage(this.iconPath(snapshot.status));
    this.tray.setToolTip(`Debrute Runtime: ${snapshot.status}`);
    if (process.platform === 'darwin') {
      this.tray.setTitle(snapshot.status);
    }
    const template = buildRuntimeTrayMenuTemplate({
      platform: process.platform,
      snapshot,
      recentProjectRoots: await this.input.readRecentProjectRoots(),
      actions: this.input.actions
    });
    this.tray.setContextMenu(this.input.Menu.buildFromTemplate(template));
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = undefined;
  }

  private iconPath(status: DesktopRuntimeStatus): string {
    return join(__dirname, trayIconFileNameForStatus(status));
  }
}

export function trayIconFileNameForStatus(status: DesktopRuntimeStatus): string {
  return `tray_icon_${status}.png`;
}
