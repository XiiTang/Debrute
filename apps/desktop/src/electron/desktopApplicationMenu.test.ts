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
      quitProduct
    });
    const file = template.find((item) => item.label === 'File');
    const submenu = Array.isArray(file?.submenu) ? file.submenu : [];
    const close = submenu.find((item) => 'label' in item && item.label === 'Close Window');
    const quit = submenu.find((item) => 'label' in item && item.label === 'Quit Debrute');

    expect(close).toMatchObject({ role: 'close', accelerator: 'Ctrl+W' });
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
      quitProduct: vi.fn()
    });
    const file = template.find((item) => item.label === 'File');
    const submenu = Array.isArray(file?.submenu) ? file.submenu : [];

    expect(submenu.filter((item) => 'label' in item && item.label === 'Open Project…')).toHaveLength(1);
    expect(submenu.some((item) => (
      'label' in item && item.label === 'Open Project in New Window…'
    ))).toBe(false);
  });
});
