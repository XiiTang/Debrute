import type {
  DebruteProductPlatform,
  DebruteShellApi,
  NativeMenuCommandResult,
  NativeEditCommandId,
  NativeMenuCommand,
  NativeProjectOpenFailure,
  NativeWindowState
} from '@debrute/app-protocol';

export const nativeWindowIpcChannels = {
  getState: 'debrute-shell:getNativeWindowState',
  minimize: 'debrute-shell:minimizeNativeWindow',
  toggleMaximize: 'debrute-shell:toggleMaximizeNativeWindow',
  close: 'debrute-shell:closeNativeWindow',
  executeMenuCommand: 'debrute-shell:executeNativeMenuCommand',
  stateChanged: 'debrute-shell:nativeWindowStateChanged',
  editCommand: 'debrute-shell:nativeEditCommand',
  projectOpenFailed: 'debrute-shell:nativeProjectOpenFailed',
  takeDesktopLaunchTicket: 'debrute-shell:takeDesktopLaunchTicket'
} as const;

export type NativeWindowPreloadApi = Pick<
  DebruteShellApi,
  | 'getNativeWindowState'
  | 'minimizeNativeWindow'
  | 'toggleMaximizeNativeWindow'
  | 'closeNativeWindow'
  | 'executeNativeMenuCommand'
  | 'takeDesktopLaunchTicket'
  | 'onNativeWindowStateChanged'
  | 'onNativeEditCommand'
  | 'onNativeProjectOpenFailed'
>;

interface NativeWindowIpcInvoker {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

interface NativeWindowIpcRenderer<Event> extends NativeWindowIpcInvoker {
  on(channel: string, listener: (event: Event, payload: unknown) => void): unknown;
  removeListener(channel: string, listener: (event: Event, payload: unknown) => void): unknown;
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
    handler: (event: { sender: Sender }, input: NativeMenuCommand) => unknown
  ): unknown;
}

export function desktopBrowserWindowChromeOptions(platform: DebruteProductPlatform): {
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
    getNativeWindowState: () => invoke<NativeWindowState>(ipcRenderer, nativeWindowIpcChannels.getState),
    minimizeNativeWindow: () => invoke<NativeWindowState>(ipcRenderer, nativeWindowIpcChannels.minimize),
    toggleMaximizeNativeWindow: () => invoke<NativeWindowState>(ipcRenderer, nativeWindowIpcChannels.toggleMaximize),
    closeNativeWindow: () => invoke<{ ok: true }>(ipcRenderer, nativeWindowIpcChannels.close),
    executeNativeMenuCommand: (input) => invoke<NativeMenuCommandResult>(ipcRenderer, nativeWindowIpcChannels.executeMenuCommand, input),
    takeDesktopLaunchTicket: () => invoke<string | undefined>(ipcRenderer, nativeWindowIpcChannels.takeDesktopLaunchTicket),
    onNativeWindowStateChanged: (listener) => {
      const wrapped = (_event: Event, state: unknown) => listener(state as NativeWindowState);
      ipcRenderer.on(nativeWindowIpcChannels.stateChanged, wrapped);
      return () => {
        ipcRenderer.removeListener(nativeWindowIpcChannels.stateChanged, wrapped);
      };
    },
    onNativeEditCommand: (listener) => {
      const wrapped = (_event: Event, command: unknown) => listener(command as NativeEditCommandId);
      ipcRenderer.on(nativeWindowIpcChannels.editCommand, wrapped);
      return () => {
        ipcRenderer.removeListener(nativeWindowIpcChannels.editCommand, wrapped);
      };
    },
    onNativeProjectOpenFailed: (listener) => {
      const wrapped = (_event: Event, failure: unknown) => listener(failure as NativeProjectOpenFailure);
      ipcRenderer.on(nativeWindowIpcChannels.projectOpenFailed, wrapped);
      return () => {
        ipcRenderer.removeListener(nativeWindowIpcChannels.projectOpenFailed, wrapped);
      };
    }
  };
}

export function registerNativeWindowIpc<Sender, Window extends NativeWindow>(input: {
  ipcMain: NativeWindowIpcMain<Sender>;
  browserWindow: { fromWebContents(sender: Sender): Window | null };
  executeNativeMenuCommand(window: Window, command: NativeMenuCommand): Promise<NativeMenuCommandResult>;
  takeDesktopLaunchTicket(window: Window): string | undefined;
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
    return input.executeNativeMenuCommand(
      requireSenderWindow(input.browserWindow, event.sender),
      command
    );
  });
  input.ipcMain.handle(nativeWindowIpcChannels.takeDesktopLaunchTicket, (event) => (
    input.takeDesktopLaunchTicket(requireSenderWindow(input.browserWindow, event.sender))
  ));
}

function nativeWindowState(window: Pick<NativeWindow, 'isMaximized'>): NativeWindowState {
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
