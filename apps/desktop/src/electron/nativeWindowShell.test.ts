import { describe, expect, it, vi } from 'vitest';
import {
  createNativeWindowPreloadApi,
  desktopBrowserWindowChromeOptions,
  nativeWindowIpcChannels,
  registerNativeWindowIpc
} from './nativeWindowShell.js';

describe('native window shell', () => {
  it('uses native inset chrome on macOS and custom frames on Windows and Linux', () => {
    expect(desktopBrowserWindowChromeOptions('darwin')).toEqual({ titleBarStyle: 'hiddenInset' });
    expect(desktopBrowserWindowChromeOptions('win32')).toEqual({ frame: false, titleBarStyle: 'hidden' });
    expect(desktopBrowserWindowChromeOptions('linux')).toEqual({ frame: false, titleBarStyle: 'hidden' });
  });

  it('maps the preload native-window API to the public IPC channels', async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const on = vi.fn();
    const removeListener = vi.fn();
    const api = createNativeWindowPreloadApi({ invoke, on, removeListener });

    await api.getNativeWindowState();
    await api.minimizeNativeWindow();
    await api.toggleMaximizeNativeWindow();
    await api.closeNativeWindow();
    await api.executeNativeMenuCommand({ commandId: 'window.new' });
    const listener = vi.fn();
    const unsubscribe = api.onNativeWindowStateChanged(listener);
    const stateListener = on.mock.calls[0]?.[1] as ((event: unknown, state: { maximized: boolean }) => void);
    stateListener({}, { maximized: true });
    unsubscribe();

    expect(invoke.mock.calls).toEqual([
      [nativeWindowIpcChannels.getState],
      [nativeWindowIpcChannels.minimize],
      [nativeWindowIpcChannels.toggleMaximize],
      [nativeWindowIpcChannels.close],
      [nativeWindowIpcChannels.executeMenuCommand, { commandId: 'window.new' }]
    ]);
    expect(on).toHaveBeenCalledWith(nativeWindowIpcChannels.stateChanged, stateListener);
    expect(listener).toHaveBeenCalledWith({ maximized: true });
    expect(removeListener).toHaveBeenCalledWith(nativeWindowIpcChannels.stateChanged, stateListener);
  });

  it('binds every native-window handler to the BrowserWindow for event.sender', async () => {
    const handlers = new Map<string, (event: { sender: object }, input: { commandId: 'window.new' }) => unknown>();
    const window = nativeWindow();
    const sender = {};
    const fromWebContents = vi.fn(() => window);
    const executeNativeMenuCommand = vi.fn(async () => undefined);
    registerNativeWindowIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      browserWindow: { fromWebContents },
      executeNativeMenuCommand
    });

    await handlers.get(nativeWindowIpcChannels.getState)?.({ sender }, { commandId: 'window.new' });
    await handlers.get(nativeWindowIpcChannels.minimize)?.({ sender }, { commandId: 'window.new' });
    await handlers.get(nativeWindowIpcChannels.toggleMaximize)?.({ sender }, { commandId: 'window.new' });
    await handlers.get(nativeWindowIpcChannels.close)?.({ sender }, { commandId: 'window.new' });
    await handlers.get(nativeWindowIpcChannels.executeMenuCommand)?.({ sender }, { commandId: 'window.new' });

    expect(fromWebContents).toHaveBeenCalledTimes(5);
    expect(fromWebContents).toHaveBeenCalledWith(sender);
    expect(window.minimize).toHaveBeenCalledOnce();
    expect(window.maximize).toHaveBeenCalledOnce();
    expect(window.close).toHaveBeenCalledOnce();
    expect(executeNativeMenuCommand).toHaveBeenCalledWith(window, { commandId: 'window.new' });
  });

  it('rejects native menu commands without a sender window', async () => {
    const handlers = new Map<string, (event: { sender: object }, input: { commandId: 'window.new' }) => unknown>();
    const executeNativeMenuCommand = vi.fn(async () => undefined);
    registerNativeWindowIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      browserWindow: { fromWebContents: vi.fn(() => null) },
      executeNativeMenuCommand
    });

    await expect(handlers.get(nativeWindowIpcChannels.executeMenuCommand)?.(
      { sender: {} },
      { commandId: 'window.new' }
    )).rejects.toThrow('Debrute native window is not available.');
    expect(executeNativeMenuCommand).not.toHaveBeenCalled();
  });
});

function nativeWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    close: vi.fn()
  };
}
