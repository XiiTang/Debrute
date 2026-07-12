import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { createApplicationMenuController } from './registerApplicationMenu.js';

describe('desktop application menu controller', () => {
  it('does not synthesize enabled native menus when runtime title-bar state is unavailable', async () => {
    const templates: MenuItemConstructorOptions[][] = [];
    const setApplicationMenu = vi.fn();
    const controller = createApplicationMenuController({
      platform: 'darwin',
      menu: {
        buildFromTemplate: (template) => {
          templates.push(template);
          return {} as Electron.Menu;
        },
        setApplicationMenu
      },
      readTitleBarState: async () => undefined,
      onCommand: vi.fn()
    });

    await controller.refreshApplicationMenu();

    expect(templates).toHaveLength(1);
    expect(templates[0]?.map((item) => item.label)).toEqual(['Debrute']);
    expect(setApplicationMenu).toHaveBeenCalledTimes(1);
  });
});
