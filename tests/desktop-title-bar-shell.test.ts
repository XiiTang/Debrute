import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Desktop title-bar shell boundary', () => {
  it('exposes only focused-window title-bar commands through preload', () => {
    const preload = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/preload.ts'), 'utf8');

    expect(preload).toContain('getNativeWindowState');
    expect(preload).toContain('minimizeNativeWindow');
    expect(preload).toContain('toggleMaximizeNativeWindow');
    expect(preload).toContain('closeNativeWindow');
    expect(preload).toContain('executeNativeMenuCommand');
    expect(preload).not.toContain('executeShellCommand');
    expect(preload).not.toContain('openExternalUrl');
  });

  it('configures real custom chrome on Windows and Linux only', () => {
    const main = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/main.ts'), 'utf8');

    expect(main).toContain('desktopBrowserWindowChromeOptions(process.platform)');
    expect(main).toContain("platform === 'darwin'");
    expect(main).toContain('frame: false');
    expect(main).toContain("titleBarStyle: 'hiddenInset'");
  });

  it('registers focused BrowserWindow handlers for title-bar actions', () => {
    const main = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/main.ts'), 'utf8');

    expect(main).toContain("ipcMain.handle('debrute-shell:getNativeWindowState'");
    expect(main).toContain("ipcMain.handle('debrute-shell:minimizeNativeWindow'");
    expect(main).toContain("ipcMain.handle('debrute-shell:toggleMaximizeNativeWindow'");
    expect(main).toContain("ipcMain.handle('debrute-shell:closeNativeWindow'");
    expect(main).toContain("ipcMain.handle('debrute-shell:executeNativeMenuCommand'");
    expect(main).toContain('BrowserWindow.fromWebContents(event.sender)');
  });

  it('does not create a source window before dispatching native menu commands', () => {
    const main = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/main.ts'), 'utf8');

    expect(main).not.toContain('BrowserWindow.getFocusedWindow() ?? await createWindow()');
    expect(main).not.toContain('sourceWindow ?? BrowserWindow.getFocusedWindow() ??');
  });
});
