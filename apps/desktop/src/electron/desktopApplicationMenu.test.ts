import { describe, expect, it, vi } from 'vitest';

import {
  buildDesktopApplicationMenu,
  buildDesktopDockMenu
} from './desktopApplicationMenu.js';

describe('buildDesktopApplicationMenu', () => {
  it('gives Windows separate Close Window and Product Quit commands', () => {
    const quitProduct = vi.fn();
    const template = buildDesktopApplicationMenu({
      platform: 'win32',
      recentItems: [],
      newWindow: vi.fn(),
      openProject: vi.fn(),
      reloadWorkbench: vi.fn(),
      dispatchEditCommand: vi.fn(),
      quitProduct
    });
    const file = template.find((item) => item.label === 'File');
    const submenu = Array.isArray(file?.submenu) ? file.submenu : [];
    const close = submenu.find((item) => 'label' in item && item.label === 'Close Window');
    const quit = submenu.find((item) => 'label' in item && item.label === 'Quit Debrute');

    expect(close).toMatchObject({ role: 'close', accelerator: 'CmdOrCtrl+W' });
    expect(quit).toMatchObject({ accelerator: 'Ctrl+Q' });
    expect(submenu.at(-2)).toMatchObject({ type: 'separator' });

    if (quit && 'click' in quit && typeof quit.click === 'function') {
      quit.click({} as never, undefined, {} as never);
    }
    expect(quitProduct).toHaveBeenCalledOnce();
  });

  it('offers one Dock command that opens a new root window', () => {
    const newWindow = vi.fn();
    const template = buildDesktopDockMenu(newWindow);

    expect(template).toHaveLength(1);
    expect(template[0]).toMatchObject({ label: 'New Window' });
    const item = template[0];
    if (item && 'click' in item && typeof item.click === 'function') {
      item.click({} as never, undefined, {} as never);
    }
    expect(newWindow).toHaveBeenCalledOnce();
  });

  it('uses one Project-open command because every Desktop Project opens in its own window', () => {
    const template = buildDesktopApplicationMenu({
      platform: 'darwin',
      recentItems: [],
      newWindow: vi.fn(),
      openProject: vi.fn(),
      reloadWorkbench: vi.fn(),
      dispatchEditCommand: vi.fn(),
      quitProduct: vi.fn()
    });
    const file = template.find((item) => item.label === 'File');
    const submenu = Array.isArray(file?.submenu) ? file.submenu : [];

    expect(submenu.filter((item) => 'label' in item && item.label === 'Open Project…')).toHaveLength(1);
    expect(submenu.some((item) => (
      'label' in item && item.label === 'Open Project in New Window…'
    ))).toBe(false);
  });

  it('dispatches Canvas-aware Edit commands to the renderer instead of executing Electron roles', () => {
    const dispatchEditCommand = vi.fn();
    const template = buildDesktopApplicationMenu({
      platform: 'darwin',
      recentItems: [],
      newWindow: vi.fn(),
      openProject: vi.fn(),
      reloadWorkbench: vi.fn(),
      dispatchEditCommand,
      quitProduct: vi.fn()
    });
    const edit = template.find((item) => item.label === 'Edit');
    const submenu = Array.isArray(edit?.submenu) ? edit.submenu : [];
    const copy = submenu.find((item) => 'label' in item && item.label === 'Copy');
    const deleteItem = submenu.find((item) => 'label' in item && item.label === 'Delete');
    const window = {} as Electron.BaseWindow;

    expect(copy).toMatchObject({ accelerator: 'CmdOrCtrl+C' });
    expect(copy).not.toHaveProperty('role');
    expect(deleteItem).toMatchObject({ accelerator: 'Command+Backspace' });
    if (copy && 'click' in copy && typeof copy.click === 'function') {
      copy.click({} as never, window, {} as never);
    }
    expect(dispatchEditCommand).toHaveBeenCalledWith(window, 'edit.copy');
  });

  it('derives every active Edit accelerator from the shared shortcut contract', () => {
    const template = buildDesktopApplicationMenu({
      platform: 'win32',
      recentItems: [],
      newWindow: vi.fn(),
      openProject: vi.fn(),
      reloadWorkbench: vi.fn(),
      dispatchEditCommand: vi.fn(),
      quitProduct: vi.fn()
    });
    const edit = template.find((item) => item.label === 'Edit');
    const submenu = Array.isArray(edit?.submenu) ? edit.submenu : [];

    expect(submenu.find((item) => 'role' in item && item.role === 'undo'))
      .toMatchObject({ accelerator: 'CmdOrCtrl+Z' });
    expect(submenu.find((item) => 'role' in item && item.role === 'redo'))
      .toMatchObject({ accelerator: 'CmdOrCtrl+Y' });
    expect(submenu.find((item) => 'role' in item && item.role === 'pasteAndMatchStyle'))
      .toMatchObject({ accelerator: 'CmdOrCtrl+Shift+V' });
  });
});
