import type { BrowserWindow, Menu, MenuItemConstructorOptions } from 'electron';
import { unavailableWorkbenchTitleBarState, type WorkbenchTitleBarState } from '@debrute/app-protocol';
import type { ApplicationMenuCommand } from './applicationMenu.js';
import { buildApplicationMenuTemplate } from './applicationMenu.js';

interface ElectronMenuModule {
  buildFromTemplate(template: MenuItemConstructorOptions[]): Menu;
  setApplicationMenu(menu: Menu | null): void;
}

export interface ApplicationMenuController {
  refreshApplicationMenu(): Promise<void>;
}

export interface CreateApplicationMenuControllerInput {
  menu: ElectronMenuModule;
  platform: NodeJS.Platform;
  readTitleBarState(): Promise<WorkbenchTitleBarState | undefined>;
  onCommand(sourceWindow: BrowserWindow | undefined, command: ApplicationMenuCommand): Promise<void>;
}

export function createApplicationMenuController(input: CreateApplicationMenuControllerInput): ApplicationMenuController {
  const controller: ApplicationMenuController = {
    async refreshApplicationMenu(): Promise<void> {
      if (input.platform !== 'darwin') {
        input.menu.setApplicationMenu(null);
        return;
      }
      const state = await input.readTitleBarState() ?? unavailableWorkbenchTitleBarState();
      input.menu.setApplicationMenu(input.menu.buildFromTemplate(buildApplicationMenuTemplate({
        state,
        onCommand: input.onCommand
      })));
    }
  };
  return controller;
}
