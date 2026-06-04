import type { Menu, MenuItemConstructorOptions } from 'electron';
import type { DesktopState } from '../desktop-state/desktopStateStore.js';
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
  chooseProjectRoot(): Promise<string | undefined>;
  openProject(projectRoot: string): Promise<void>;
  clearRecentProjectRoots(): Promise<void>;
}

export function createApplicationMenuController(input: CreateApplicationMenuControllerInput): ApplicationMenuController {
  const controller: ApplicationMenuController = {
    async refreshApplicationMenu(): Promise<void> {
      const desktopState = await input.readDesktopState();
      input.menu.setApplicationMenu(input.menu.buildFromTemplate(buildApplicationMenuTemplate({
        recentProjectRoots: desktopState.recentProjectRoots,
        onOpenProject: async () => {
          const selectedRoot = await input.chooseProjectRoot();
          if (!selectedRoot) {
            return;
          }
          await input.openProject(selectedRoot);
        },
        onOpenRecentProject: async (projectRoot) => {
          await input.openProject(projectRoot);
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
