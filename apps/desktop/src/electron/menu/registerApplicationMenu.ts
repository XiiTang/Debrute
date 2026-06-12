import type { BrowserWindow, Menu, MenuItemConstructorOptions } from 'electron';
import type { DesktopState } from '../desktop-state/desktopStateStore.js';
import type { ProjectOpenMenuOptions } from './applicationMenu.js';
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
  readDesktopState(): Promise<DesktopState>;
  chooseProjectRoot(sourceWindow?: BrowserWindow): Promise<string | undefined>;
  newWindow(): Promise<void>;
  openProject(projectRoot: string, sourceWindow: BrowserWindow | undefined, options: ProjectOpenMenuOptions): Promise<void>;
  clearRecentProjectRoots(): Promise<void>;
}

export function createApplicationMenuController(input: CreateApplicationMenuControllerInput): ApplicationMenuController {
  const controller: ApplicationMenuController = {
    async refreshApplicationMenu(): Promise<void> {
      const desktopState = await input.readDesktopState();
      input.menu.setApplicationMenu(input.menu.buildFromTemplate(buildApplicationMenuTemplate({
        recentProjectRoots: desktopState.recentProjectRoots,
        onNewWindow: async () => {
          await input.newWindow();
        },
        onOpenProject: async (sourceWindow, options) => {
          const selectedRoot = await input.chooseProjectRoot(sourceWindow);
          if (!selectedRoot) {
            return;
          }
          await input.openProject(selectedRoot, sourceWindow, options);
        },
        onOpenRecentProject: async (projectRoot, sourceWindow, options) => {
          await input.openProject(projectRoot, sourceWindow, options);
        },
        onClearRecentProjects: async () => {
          await input.clearRecentProjectRoots();
          await controller.refreshApplicationMenu();
        }
      })));
    }
  };
  return controller;
}
