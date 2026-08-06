import { describe, expect, it, vi } from 'vitest';
import type { NativeMenuCommand } from '@debrute/app-protocol';
import {
  createNativeWindowPreloadApi,
  desktopBrowserWindowChromeOptions,
  nativeWindowIpcChannels,
  registerNativeWindowIpc
} from './nativeWindowShell.js';

describe('native window shell', () => {
  it('uses native inset chrome on macOS and custom frames on Windows', () => {
    expect(desktopBrowserWindowChromeOptions('darwin')).toEqual({ titleBarStyle: 'hiddenInset' });
    expect(desktopBrowserWindowChromeOptions('win32')).toEqual({ frame: false, titleBarStyle: 'hidden' });
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
    await api.executeNativeMenuCommand({ commandId: 'project.open-path', projectRoot: '/projects/alpha' });
    await api.takeDesktopLaunchContext();
    const listener = vi.fn();
    const unsubscribe = api.onNativeWindowStateChanged(listener);
    const stateListener = on.mock.calls[0]?.[1] as ((event: unknown, state: { maximized: boolean }) => void);
    stateListener({}, { maximized: true });
    const editListener = vi.fn();
    const unsubscribeEdit = api.onNativeEditCommand(editListener);
    const nativeEditListener = on.mock.calls[1]?.[1] as ((event: unknown, command: string) => void);
    nativeEditListener({}, 'edit.copy');
    const projectOpenListener = vi.fn();
    const unsubscribeProjectOpen = api.onNativeProjectOpenRequested(projectOpenListener);
    const nativeProjectOpenListener = on.mock.calls[2]?.[1] as ((event: unknown, projectRoot: unknown) => void);
    nativeProjectOpenListener({}, '/projects/alpha');
    unsubscribe();
    unsubscribeEdit();
    unsubscribeProjectOpen();

    expect(invoke.mock.calls).toEqual([
      [nativeWindowIpcChannels.getState],
      [nativeWindowIpcChannels.minimize],
      [nativeWindowIpcChannels.toggleMaximize],
      [nativeWindowIpcChannels.close],
      [nativeWindowIpcChannels.executeMenuCommand, {
        commandId: 'project.open-path',
        projectRoot: '/projects/alpha'
      }],
      [nativeWindowIpcChannels.takeDesktopLaunchContext]
    ]);
    expect(on).toHaveBeenCalledWith(nativeWindowIpcChannels.stateChanged, stateListener);
    expect(listener).toHaveBeenCalledWith({ maximized: true });
    expect(on).toHaveBeenCalledWith(nativeWindowIpcChannels.editCommand, nativeEditListener);
    expect(editListener).toHaveBeenCalledWith('edit.copy');
    expect(on).toHaveBeenCalledWith(
      nativeWindowIpcChannels.projectOpenRequested,
      nativeProjectOpenListener
    );
    expect(projectOpenListener).toHaveBeenCalledWith('/projects/alpha');
    expect(removeListener).toHaveBeenCalledWith(nativeWindowIpcChannels.stateChanged, stateListener);
    expect(removeListener).toHaveBeenCalledWith(nativeWindowIpcChannels.editCommand, nativeEditListener);
    expect(removeListener).toHaveBeenCalledWith(
      nativeWindowIpcChannels.projectOpenRequested,
      nativeProjectOpenListener
    );
  });

  it('binds every native-window handler to the BrowserWindow for event.sender', async () => {
    const handlers = new Map<
      string,
      (event: { sender: object }, input: NativeMenuCommand) => unknown
    >();
    const window = nativeWindow();
    const sender = {};
    const fromWebContents = vi.fn(() => window);
    const executeNativeMenuCommand = vi.fn(async () => ({ result: 'completed' as const }));
    const launchContext = {
      desktopLaunchTicket: 'ticket-1',
      initialProjectRoot: '/projects/alpha'
    };
    const takeDesktopLaunchContext = vi.fn(() => launchContext);
    registerNativeWindowIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      browserWindow: { fromWebContents },
      executeNativeMenuCommand,
      takeDesktopLaunchContext
    });

    await handlers.get(nativeWindowIpcChannels.getState)?.({ sender }, { commandId: 'window.new' });
    await handlers.get(nativeWindowIpcChannels.minimize)?.({ sender }, { commandId: 'window.new' });
    await handlers.get(nativeWindowIpcChannels.toggleMaximize)?.({ sender }, { commandId: 'window.new' });
    await handlers.get(nativeWindowIpcChannels.close)?.({ sender }, { commandId: 'window.new' });
    const menuResult = await handlers.get(nativeWindowIpcChannels.executeMenuCommand)?.(
      { sender },
      { commandId: 'project.open-path', projectRoot: '/projects/alpha' }
    );
    const consumedLaunchContext = await handlers.get(nativeWindowIpcChannels.takeDesktopLaunchContext)?.(
      { sender },
      { commandId: 'window.new' }
    );

    expect(fromWebContents).toHaveBeenCalledTimes(6);
    expect(fromWebContents).toHaveBeenCalledWith(sender);
    expect(window.minimize).toHaveBeenCalledOnce();
    expect(window.maximize).toHaveBeenCalledOnce();
    expect(window.close).toHaveBeenCalledOnce();
    expect(executeNativeMenuCommand).toHaveBeenCalledWith(window, {
      commandId: 'project.open-path',
      projectRoot: '/projects/alpha'
    });
    expect(menuResult).toEqual({ result: 'completed' });
    expect(takeDesktopLaunchContext).toHaveBeenCalledWith(window);
    expect(consumedLaunchContext).toEqual(launchContext);
  });

  it('rejects native menu commands without a sender window', async () => {
    const handlers = new Map<
      string,
      (event: { sender: object }, input: NativeMenuCommand) => unknown
    >();
    const executeNativeMenuCommand = vi.fn(async () => ({ result: 'completed' as const }));
    registerNativeWindowIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      browserWindow: { fromWebContents: vi.fn(() => null) },
      executeNativeMenuCommand,
      takeDesktopLaunchContext: () => undefined
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
