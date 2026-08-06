import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
  loadURL: vi.fn(async (_url: string) => undefined)
}));

vi.mock('electron', () => ({
  default: {
    BrowserWindow: class {
      readonly webContents = { on: vi.fn() };
      readonly loadURL = electronMock.loadURL;

      isDestroyed(): boolean { return false; }
      show(): void {}
      focus(): void {}
      setBackgroundColor(): void {}
      destroy(): void {}
      once(): void {}
      removeListener(): void {}
    },
    nativeTheme: { shouldUseDarkColors: false }
  }
}));

import { ElectronDesktopWindow } from './electronDesktopWindow.js';

describe('ElectronDesktopWindow', () => {
  beforeEach(() => {
    electronMock.loadURL.mockClear();
  });

  it('loads the complete Runtime launch URL unchanged', async () => {
    const launchUrl = 'http://127.0.0.1:5173/open?path=%2FUsers%2Fme%2FReference+Projects';
    const input = {
      windowKey: 'window-1',
      platform: 'darwin' as const,
      projectIconPath: '/tmp/debrute.png',
      preloadDirectory: '/tmp',
      onRendererGone: vi.fn()
    };
    const window = new ElectronDesktopWindow(input);

    await window.load(launchUrl);

    expect(electronMock.loadURL).toHaveBeenCalledWith(launchUrl);
  });
});
