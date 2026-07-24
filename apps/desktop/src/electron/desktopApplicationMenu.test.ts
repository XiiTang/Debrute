import { describe, expect, it, vi } from 'vitest';

import { buildDesktopApplicationMenu } from './desktopApplicationMenu.js';

describe('buildDesktopApplicationMenu', () => {
  it('gives Windows separate Close Window and Product Quit commands', () => {
    const quitProduct = vi.fn();
    const template = buildDesktopApplicationMenu({
      platform: 'win32',
      recentItems: [],
      newWindow: vi.fn(),
      openProject: vi.fn(),
      openProjectInNewWindow: vi.fn(),
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
});
