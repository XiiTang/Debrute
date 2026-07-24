import type { WorkbenchMenuCommandId } from '@debrute/app-protocol';

export interface ApplicationMenuCommand {
  commandId: WorkbenchMenuCommandId;
  payload?: Record<string, string | boolean>;
}

export const nativeWindowIpcChannels = {
  getState: 'debrute-shell:getNativeWindowState',
  minimize: 'debrute-shell:minimizeNativeWindow',
  toggleMaximize: 'debrute-shell:toggleMaximizeNativeWindow',
  close: 'debrute-shell:closeNativeWindow',
  executeMenuCommand: 'debrute-shell:executeNativeMenuCommand',
  stateChanged: 'debrute-shell:nativeWindowStateChanged',
  takeDesktopLaunchTicket: 'debrute-shell:takeDesktopLaunchTicket',
  openProjectRequested: 'debrute-shell:openProjectRequested'
} as const;

export interface NativeWindowPreloadApi {
  getNativeWindowState(): Promise<{ maximized: boolean }>;
  minimizeNativeWindow(): Promise<{ maximized: boolean }>;
  toggleMaximizeNativeWindow(): Promise<{ maximized: boolean }>;
  closeNativeWindow(): Promise<{ ok: true }>;
  executeNativeMenuCommand(input: {
    commandId: WorkbenchMenuCommandId;
    payload?: Record<string, string | boolean>;
  }): Promise<{ ok: true }>;
  takeDesktopLaunchTicket(): Promise<string | undefined>;
  onNativeWindowStateChanged(listener: (state: { maximized: boolean }) => void): () => void;
}

interface NativeWindowIpcInvoker {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

interface NativeWindowIpcRenderer<Event> extends NativeWindowIpcInvoker {
  on(channel: string, listener: (event: Event, state: { maximized: boolean }) => void): unknown;
  removeListener(channel: string, listener: (event: Event, state: { maximized: boolean }) => void): unknown;
}

interface NativeWindow {
  isDestroyed(): boolean;
  isMaximized(): boolean;
  minimize(): void;
  maximize(): void;
  unmaximize(): void;
  close(): void;
}

interface NativeWindowIpcMain<Sender> {
  handle(
    channel: string,
    handler: (event: { sender: Sender }, input: ApplicationMenuCommand) => unknown
  ): unknown;
}

export function desktopBrowserWindowChromeOptions(platform: NodeJS.Platform): {
  frame?: false;
  titleBarStyle: 'hiddenInset' | 'hidden';
} {
  if (platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset' };
  }
  return { frame: false, titleBarStyle: 'hidden' };
}

export function createNativeWindowPreloadApi<Event>(
  ipcRenderer: NativeWindowIpcRenderer<Event>
): NativeWindowPreloadApi {
  return {
    getNativeWindowState: () => invoke<{ maximized: boolean }>(ipcRenderer, nativeWindowIpcChannels.getState),
    minimizeNativeWindow: () => invoke<{ maximized: boolean }>(ipcRenderer, nativeWindowIpcChannels.minimize),
    toggleMaximizeNativeWindow: () => invoke<{ maximized: boolean }>(ipcRenderer, nativeWindowIpcChannels.toggleMaximize),
    closeNativeWindow: () => invoke<{ ok: true }>(ipcRenderer, nativeWindowIpcChannels.close),
    executeNativeMenuCommand: (input) => invoke<{ ok: true }>(ipcRenderer, nativeWindowIpcChannels.executeMenuCommand, input),
    takeDesktopLaunchTicket: () => invoke<string | undefined>(ipcRenderer, nativeWindowIpcChannels.takeDesktopLaunchTicket),
    onNativeWindowStateChanged: (listener) => {
      const wrapped = (_event: Event, state: { maximized: boolean }) => listener(state);
      ipcRenderer.on(nativeWindowIpcChannels.stateChanged, wrapped);
      return () => {
        ipcRenderer.removeListener(nativeWindowIpcChannels.stateChanged, wrapped);
      };
    }
  };
}

export function registerNativeWindowIpc<Sender, Window extends NativeWindow>(input: {
  ipcMain: NativeWindowIpcMain<Sender>;
  browserWindow: { fromWebContents(sender: Sender): Window | null };
  executeNativeMenuCommand(window: Window, command: ApplicationMenuCommand): Promise<void>;
  takeDesktopLaunchTicket?(window: Window): string | undefined;
}): void {
  input.ipcMain.handle(nativeWindowIpcChannels.getState, (event) => (
    nativeWindowState(requireSenderWindow(input.browserWindow, event.sender))
  ));
  input.ipcMain.handle(nativeWindowIpcChannels.minimize, (event) => {
    const window = requireSenderWindow(input.browserWindow, event.sender);
    window.minimize();
    return nativeWindowState(window);
  });
  input.ipcMain.handle(nativeWindowIpcChannels.toggleMaximize, (event) => {
    const window = requireSenderWindow(input.browserWindow, event.sender);
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
    return nativeWindowState(window);
  });
  input.ipcMain.handle(nativeWindowIpcChannels.close, (event) => {
    requireSenderWindow(input.browserWindow, event.sender).close();
    return { ok: true };
  });
  input.ipcMain.handle(nativeWindowIpcChannels.executeMenuCommand, async (event, command) => {
    await input.executeNativeMenuCommand(requireSenderWindow(input.browserWindow, event.sender), command);
    return { ok: true };
  });
  input.ipcMain.handle(nativeWindowIpcChannels.takeDesktopLaunchTicket, (event) => (
    input.takeDesktopLaunchTicket?.(requireSenderWindow(input.browserWindow, event.sender))
  ));
}

export function nativeWindowState(window: Pick<NativeWindow, 'isMaximized'>): { maximized: boolean } {
  return { maximized: window.isMaximized() };
}

function requireSenderWindow<Sender, Window extends NativeWindow>(
  browserWindow: { fromWebContents(sender: Sender): Window | null },
  sender: Sender
): Window {
  const window = browserWindow.fromWebContents(sender);
  if (!window || window.isDestroyed()) {
    throw new Error('Debrute native window is not available.');
  }
  return window;
}

function invoke<Result>(
  ipcRenderer: NativeWindowIpcInvoker,
  channel: string,
  ...args: unknown[]
): Promise<Result> {
  return ipcRenderer.invoke(channel, ...args) as Promise<Result>;
}
