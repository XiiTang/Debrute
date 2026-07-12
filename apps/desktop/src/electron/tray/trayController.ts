import { join } from 'node:path';
import type electron from 'electron';
import type { DesktopRuntimeStatus } from '../runtime/runtimeStatus.js';
import type { RuntimeSupervisor } from '../runtime/runtimeSupervisor.js';
import { buildRuntimeTrayMenuTemplate, type RuntimeTrayActions } from './runtimeTrayMenu.js';

export interface TrayControllerInput {
  Tray: typeof electron.Tray;
  Menu: typeof electron.Menu;
  nativeImage: typeof electron.nativeImage;
  runtimeSupervisor: RuntimeSupervisor;
  readRecentProjectRoots(): Promise<string[]>;
  onInteraction(): void;
  actions: RuntimeTrayActions;
}

export class TrayController {
  private tray: Electron.Tray | undefined;

  constructor(private readonly input: TrayControllerInput) {}

  async start(): Promise<void> {
    this.tray = new this.input.Tray(this.trayImage(this.input.runtimeSupervisor.snapshot().status));
    this.input.runtimeSupervisor.on('change', () => {
      void this.refresh();
    });
    this.tray.on('click', this.input.onInteraction);
    this.tray.on('right-click', this.input.onInteraction);
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.tray) {
      return;
    }
    const snapshot = this.input.runtimeSupervisor.snapshot();
    this.tray.setImage(this.trayImage(snapshot.status));
    this.tray.setToolTip(`Debrute Runtime: ${snapshot.status}`);
    if (process.platform === 'darwin') {
      this.tray.setTitle('');
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

  private trayImage(status: DesktopRuntimeStatus): string | Electron.NativeImage {
    if (process.platform !== 'darwin') {
      return this.iconPath(status);
    }
    const image = this.input.nativeImage.createFromPath(join(__dirname, 'tray_icon_template@2x.png'));
    image.setTemplateImage(true);
    return image;
  }
}

export function trayIconFileNameForStatus(status: DesktopRuntimeStatus): string {
  return `tray_icon_${status}.png`;
}
