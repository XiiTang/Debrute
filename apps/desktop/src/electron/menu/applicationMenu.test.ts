import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { buildWorkbenchTitleBarState } from '@debrute/app-protocol';
import { buildApplicationMenuTemplate } from './applicationMenu.js';

describe('desktop application menu', () => {
  it('puts project actions under a top-level File menu', () => {
    const template = buildApplicationMenuTemplate({
      state: buildWorkbenchTitleBarState({
        platform: 'darwin',
        host: 'desktop',
        projectTitle: 'Debrute',
        recentProjectRoots: ['/tmp/alpha-project', '/tmp/beta-project']
      }),
      onCommand: vi.fn()
    });

    expect(template.find((item) => item.label === 'Debrute')).toBeDefined();
    expect(template.find((item) => item.label === 'File')).toBeDefined();
    expect(template.find((item) => item.label === 'Edit')).toBeDefined();
    expect(template.find((item) => item.label === 'View')).toBeDefined();

    const fileMenu = template.find((item) => item.label === 'File');
    expect(fileMenu).toBeDefined();

    const fileItems = fileMenu?.submenu as MenuItemConstructorOptions[];
    expect(fileItems.map((item) => item.label ?? item.role)).toContain('New Window');
    expect(fileItems.map((item) => item.label ?? item.role)).toContain('Open Project...');
    expect(fileItems.map((item) => item.label ?? item.role)).toContain('Open Project in New Window...');

    const openRecent = fileItems.find((item) => item.label === 'Open Recent');
    expect(openRecent).toBeDefined();

    const recentItems = openRecent?.submenu as MenuItemConstructorOptions[];
    expect(recentItems.map((item) => item.label ?? item.role)).toEqual([
      '/tmp/alpha-project',
      '/tmp/beta-project'
    ]);
  });

  it('keeps the recent-project submenu disabled when there are no recents', () => {
    const template = buildApplicationMenuTemplate({
      state: buildWorkbenchTitleBarState({
        platform: 'darwin',
        host: 'desktop',
        recentProjectRoots: []
      }),
      onCommand: vi.fn()
    });

    const fileMenu = template.find((item) => item.label === 'File');
    const fileItems = fileMenu?.submenu as MenuItemConstructorOptions[];
    const openRecent = fileItems.find((item) => item.label === 'Open Recent');
    const recentItems = openRecent?.submenu as MenuItemConstructorOptions[];

    expect(openRecent?.enabled).toBe(false);
    expect(fileItems.find((item) => item.label === 'Clear Recent')?.enabled).toBe(false);
    expect(recentItems.map((item) => item.label ?? item.role)).toEqual(['No Recent Projects']);
    expect(recentItems[0]?.enabled).toBe(false);
  });

  it('forwards shared command ids from project menu actions', () => {
    const commands: Array<{ commandId: string; projectRoot?: string }> = [];
    const template = buildApplicationMenuTemplate({
      state: buildWorkbenchTitleBarState({
        platform: 'darwin',
        host: 'desktop',
        recentProjectRoots: ['/tmp/alpha-project']
      }),
      onCommand: (_sourceWindow, command) => {
        const projectRoot = command.payload?.projectRoot;
        commands.push(typeof projectRoot === 'string'
          ? { commandId: command.commandId, projectRoot }
          : { commandId: command.commandId });
      }
    });
    const fileMenu = template.find((item) => item.label === 'File')!;
    const fileItems = fileMenu.submenu as MenuItemConstructorOptions[];
    const sourceWindow = { id: 7 } as Electron.BrowserWindow;

    fileItems.find((item) => item.label === 'New Window')!.click!(undefined as never, sourceWindow, undefined as never);
    fileItems.find((item) => item.label === 'Open Project...')!.click!(undefined as never, sourceWindow, undefined as never);
    fileItems.find((item) => item.label === 'Open Project in New Window...')!.click!(undefined as never, sourceWindow, undefined as never);
    const recentItems = fileItems.find((item) => item.label === 'Open Recent')!.submenu as MenuItemConstructorOptions[];
    recentItems[0]!.click!(undefined as never, sourceWindow, undefined as never);

    expect(commands).toEqual([
      { commandId: 'window.new' },
      { commandId: 'project.open-picker' },
      { commandId: 'project.open-picker-new-window' },
      { commandId: 'project.open-recent', projectRoot: '/tmp/alpha-project' }
    ]);
  });

  it('provides native editing roles including speech controls', () => {
    const template = buildApplicationMenuTemplate({
      state: buildWorkbenchTitleBarState({
        platform: 'darwin',
        host: 'desktop',
        recentProjectRoots: []
      }),
      onCommand: vi.fn()
    });

    const editMenu = template.find((item) => item.label === 'Edit');
    expect(editMenu).toBeDefined();

    const editItems = editMenu?.submenu as MenuItemConstructorOptions[];
    expect(editItems.map((item) => item.role).filter(Boolean)).toEqual([
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
      'pasteAndMatchStyle',
      'delete',
      'selectAll',
      'startSpeaking',
      'stopSpeaking'
    ]);
    for (const item of editItems) {
      if (item.role) {
        expect(item.click).toBeUndefined();
      }
    }
  });
});
