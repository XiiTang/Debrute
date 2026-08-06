import electron from 'electron';
import { join } from 'node:path';

import type {
  ControlEvent,
  NativeEditCommandId,
  NativeMenuCommand,
  NativeMenuCommandResult
} from '@debrute/app-protocol';
import type { RuntimeControlClient } from '@debrute/runtime-control-client';

import {
  buildDesktopApplicationMenu,
  buildDesktopDockMenu
} from './desktopApplicationMenu.js';
import { createDesktopOpenAdmission } from './desktopOpenAdmission.js';
import { dispatchDesktopProjectOpen } from './desktopProjectOpen.js';
import { requireDesktopPlatform } from './desktopPlatform.js';
import { DesktopWindowHost } from './desktopWindowHost.js';
import { DesktopProductQuit } from './desktopProductQuit.js';
import { ElectronDesktopWindow } from './electronDesktopWindow.js';
import {
  nativeWindowIpcChannels,
  registerNativeWindowIpc
} from './nativeWindowShell.js';
import {
  parseDesktopOpenIntent,
  syncNativeRecentProjects,
  type DesktopOpenIntent
} from './nativeRecentProjects.js';
import { connectOrLaunchDesktopRuntime } from './runtime/desktopRuntimeLauncher.js';
import { desktopRuntimeLaunchConfiguration } from './runtime/desktopProductBootstrap.js';
import {
  productUpdateFailureTransaction,
  readDesktopProductUpdateFailure
} from './runtime/desktopProductUpdateFailure.js';

const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage } = electron;
const projectIconPath = join(__dirname, 'icon.png');
const dockIconPath = join(__dirname, 'dock_icon.png');
const desktopPlatform = requireDesktopPlatform(process.platform);

if (desktopPlatform === 'win32') {
  app.setAppUserModelId('io.github.xiitang.debrute');
}

let control: RuntimeControlClient | undefined;
let windowHost: DesktopWindowHost<Electron.BrowserWindow, ElectronDesktopWindow> | undefined;
let appQuitAllowed = false;
const productQuit = new DesktopProductQuit();
let runtimeLossReported = false;
let recentProjectRoots: string[] = [];
let productUpdateFailureShown = false;
const desktopOpenAdmission = createDesktopOpenAdmission<
  Electron.BrowserWindow,
  NativeMenuCommandResult
>(async (
  intent,
  preferredWindow
) => {
  const activeHost = windowHost;
  if (!activeHost) {
    throw new Error('Debrute window host is not available for Desktop activation.');
  }
  return activateOpenIntent(activeHost, intent, preferredWindow);
});

if (app.requestSingleInstanceLock()) {
  registerDesktopLifecycle();
} else {
  appQuitAllowed = true;
  app.quit();
}

function registerDesktopLifecycle(): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      appQuitAllowed = true;
      control?.close();
      app.quit();
    });
  }

  app.on('open-file', (event, projectRoot) => {
    event.preventDefault();
    runDesktopOpenAction(dispatchDesktopOpen({ kind: 'open-project-path', projectRoot }));
  });

  app.on('second-instance', (_event, argv) => {
    try {
      const transactionId = productUpdateFailureTransaction(argv);
      if (transactionId) {
        runDesktopAction(showProductUpdateFailure(transactionId));
        return;
      }
    } catch (error) {
      reportDesktopError(error);
      return;
    }
    runDesktopOpenAction(dispatchDesktopOpen(
      parseDesktopOpenIntent(argv) ?? { kind: 'new-window' }
    ));
  });

  app.on('window-all-closed', () => {
    // DesktopWindowHost closes Control and exits Desktop locally.
  });

  app.on('before-quit', (event) => {
    if (appQuitAllowed) {
      return;
    }
    event.preventDefault();
    requestProductQuit();
  });

  void app.whenReady().then(startDesktop).catch((error: unknown) => {
    dialog.showErrorBox('Debrute Desktop could not start', messageFromUnknown(error));
    appQuitAllowed = true;
    app.quit();
  });
}

async function startDesktop(): Promise<void> {
  const updateFailureTransaction = productUpdateFailureTransaction(process.argv);
  if (updateFailureTransaction) {
    await showProductUpdateFailure(updateFailureTransaction);
    appQuitAllowed = true;
    app.quit();
    return;
  }
  if (desktopPlatform === 'darwin') {
    const dock = app.dock;
    if (!dock) {
      throw new Error('Debrute Desktop requires the macOS Dock integration.');
    }
    dock.setIcon(nativeImage.createFromPath(dockIconPath));
    dock.setMenu(Menu.buildFromTemplate(buildDesktopDockMenu(() => {
      runDesktopAction(dispatchDesktopOpen({ kind: 'new-window' }));
    })));
  }
  registerNativeWindowIpc<Electron.WebContents, Electron.BrowserWindow>({
    ipcMain,
    browserWindow: BrowserWindow,
    executeNativeMenuCommand,
    takeDesktopLaunchContext: (browserWindow) => (
      windowHost?.takeDesktopLaunchContext(browserWindow)
    )
  });
  const runtime = runtimeLaunchConfiguration();
  control = await connectOrLaunchDesktopRuntime({
    productVersion: app.getVersion(),
    runtimeEntrypoint: runtime.entrypoint,
    runtimeArguments: runtime.arguments,
    webAssetsDirectory: runtime.webAssetsDirectory,
    runtimeLogPath: join(app.getPath('logs'), 'debrute-runtime.log'),
    desktopEntrypoint: process.execPath,
    desktopArguments: app.isPackaged ? [] : [app.getAppPath()],
    environment: process.env
  });
  const activeControl = control;
  windowHost = new DesktopWindowHost({
    control: activeControl,
    createWindow: ({ windowKey }) => new ElectronDesktopWindow({
      windowKey,
      platform: desktopPlatform,
      projectIconPath,
      preloadDirectory: __dirname,
      onRendererGone: (reason) => {
        dialog.showErrorBox(
          'Debrute Workbench stopped',
          `The window renderer ended (${reason}). Use View > Reload Workbench to start a fresh connection.`
        );
      }
    }),
    quitDesktop: () => {
      appQuitAllowed = true;
      control = undefined;
      windowHost = undefined;
      app.quit();
    },
    onError: reportDesktopError
  });
  activeControl.onEvent(handleControlEvent);
  activeControl.onRuntimeLost((error) => {
    if (appQuitAllowed || productQuit.requested || runtimeLossReported) {
      return;
    }
    runtimeLossReported = true;
    dialog.showErrorBox('Debrute Runtime connection ended', error.message);
    appQuitAllowed = true;
    app.quit();
  });
  if (await productQuit.sendRecordedRequest(activeControl)) {
    return;
  }
  installApplicationMenu();

  await desktopOpenAdmission.start(parseDesktopOpenIntent(process.argv));
}

async function activateOpenIntent(
  activeHost: DesktopWindowHost<Electron.BrowserWindow, ElectronDesktopWindow>,
  intent: DesktopOpenIntent,
  preferredWindow?: Electron.BrowserWindow
): Promise<NativeMenuCommandResult> {
  if (intent.kind === 'new-window') {
    await activeHost.openWindow();
  } else {
    await openDesktopProject(activeHost, intent.projectRoot, preferredWindow);
  }
  return { result: 'completed' };
}

function handleControlEvent(event: ControlEvent): void {
  if (event.event === 'desktop_project_open_requested') {
    const activeHost = windowHost;
    if (!activeHost) {
      return;
    }
    const preferredWindow = event.preferred_window_key
      ? activeHost.identityForWindowKey(event.preferred_window_key)
      : undefined;
    if (event.preferred_window_key && !preferredWindow) {
      return;
    }
    runDesktopOpenAction(openDesktopProject(
      activeHost,
      event.project_root,
      preferredWindow
    ));
    return;
  }
  if (event.event !== 'desktop_recent_projects_changed') {
    return;
  }
  recentProjectRoots = event.recent_project_roots;
  const jumpListResult = syncNativeRecentProjects(
    app,
    desktopPlatform,
    process.execPath,
    recentProjectRoots
  );
  if (jumpListResult && jumpListResult !== 'ok') {
    console.warn(`Windows rejected the Debrute Jump List: ${jumpListResult}`);
  }
  installApplicationMenu();
}

function installApplicationMenu(): void {
  const recentItems: Electron.MenuItemConstructorOptions[] = recentProjectRoots.length === 0
    ? [{ label: 'No Recent Projects', enabled: false }]
    : recentProjectRoots.map((projectRoot) => ({
        label: projectRoot,
        click: (_item, window) => {
          const browserWindow = desktopBrowserWindow(window);
          runDesktopOpenAction(dispatchDesktopOpen(
            { kind: 'open-project-path', projectRoot },
            browserWindow
          ));
        }
      }));
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildDesktopApplicationMenu({
    platform: desktopPlatform,
    recentItems,
    newWindow: () => runDesktopAction(dispatchDesktopOpen({ kind: 'new-window' })),
    openProject: (window) => {
      const browserWindow = desktopBrowserWindow(window);
      runDesktopOpenAction(chooseProject(browserWindow));
    },
    reloadWorkbench: (window) => {
      if (window instanceof BrowserWindow && !window.isDestroyed()) {
        runDesktopAction(reloadWindow(window));
      }
    },
    dispatchEditCommand: (window, command) => {
      const browserWindow = desktopBrowserWindow(window);
      if (browserWindow) {
        sendNativeEditCommand(browserWindow, command);
      }
    },
    quitProduct: requestProductQuit
  })));
}

async function chooseProject(
  window: Electron.BrowserWindow | undefined
): Promise<NativeMenuCommandResult> {
  const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] };
  const result = window && !window.isDestroyed()
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  const projectRoot = result.filePaths[0];
  if (result.canceled || !projectRoot) {
    return { result: 'cancelled' };
  }
  return dispatchAdmittedDesktopOpen({ kind: 'open-project-path', projectRoot }, window);
}

async function reloadWindow(window: Electron.BrowserWindow): Promise<void> {
  if (!windowHost) {
    throw new Error('Debrute window host is not available.');
  }
  await windowHost.reload(window);
}

async function executeNativeMenuCommand(
  window: Electron.BrowserWindow,
  command: NativeMenuCommand
): Promise<NativeMenuCommandResult> {
  if (window.isDestroyed()) {
    throw new Error('Debrute native window is not available.');
  }
  switch (command.commandId) {
    case 'window.new':
      return dispatchAdmittedDesktopOpen({ kind: 'new-window' });
    case 'project.open-picker': return chooseProject(window);
    case 'project.open-path': {
      if (typeof command.projectRoot !== 'string' || command.projectRoot.length === 0) {
        throw new Error('Native Project activation requires projectRoot.');
      }
      return dispatchAdmittedDesktopOpen(
        { kind: 'open-project-path', projectRoot: command.projectRoot },
        window
      );
    }
    case 'window.close': window.close(); return { result: 'completed' };
    case 'view.reload': await reloadWindow(window); return { result: 'completed' };
    case 'view.toggle-devtools': window.webContents.toggleDevTools(); return { result: 'completed' };
    case 'edit.undo': window.webContents.undo(); return { result: 'completed' };
    case 'edit.redo': window.webContents.redo(); return { result: 'completed' };
    case 'edit.cut': sendNativeEditCommand(window, command.commandId); return { result: 'completed' };
    case 'edit.copy': sendNativeEditCommand(window, command.commandId); return { result: 'completed' };
    case 'edit.paste': sendNativeEditCommand(window, command.commandId); return { result: 'completed' };
    case 'edit.paste-and-match-style': window.webContents.pasteAndMatchStyle(); return { result: 'completed' };
    case 'edit.delete': sendNativeEditCommand(window, command.commandId); return { result: 'completed' };
    case 'edit.select-all': sendNativeEditCommand(window, command.commandId); return { result: 'completed' };
    default: throw new Error('Unsupported native menu command.');
  }
}

function sendNativeEditCommand(
  window: Electron.BrowserWindow,
  command: NativeEditCommandId
): void {
  window.webContents.send(nativeWindowIpcChannels.editCommand, command);
}

function requestProductQuit(): void {
  if (productQuit.requested || appQuitAllowed) {
    return;
  }
  runDesktopAction(productQuit.request(control));
}

function runDesktopAction(action: Promise<unknown>): void {
  void action.catch(reportDesktopError);
}

function runDesktopOpenAction(
  action: Promise<unknown>
): void {
  void action.catch(reportDesktopError);
}

async function openDesktopProject(
  activeHost: DesktopWindowHost<Electron.BrowserWindow, ElectronDesktopWindow>,
  projectRoot: string,
  preferredWindow?: Electron.BrowserWindow
): Promise<void> {
  await dispatchDesktopProjectOpen({
    projectRoot,
    preferredWindow,
    isLiveWindow: (window) => activeHost.isLiveWindow(window),
    singleLiveWindow: () => activeHost.singleLiveWindow(),
    openWindow: (initialProjectRoot) => activeHost.openWindow(initialProjectRoot),
    send: (window, requestedProjectRoot) => {
      window.webContents.send(
        nativeWindowIpcChannels.projectOpenRequested,
        requestedProjectRoot
      );
    }
  });
}

function dispatchDesktopOpen(
  intent: DesktopOpenIntent,
  preferredWindow?: Electron.BrowserWindow
): Promise<NativeMenuCommandResult | undefined> {
  return intent.kind === 'new-window'
    ? desktopOpenAdmission.dispatch(intent)
    : desktopOpenAdmission.dispatch(intent, preferredWindow);
}

async function dispatchAdmittedDesktopOpen(
  intent: DesktopOpenIntent,
  preferredWindow?: Electron.BrowserWindow
): Promise<NativeMenuCommandResult> {
  const result = await dispatchDesktopOpen(intent, preferredWindow);
  if (!result) {
    throw new Error('Desktop open admission is not live.');
  }
  return result;
}

function desktopBrowserWindow(
  window: Electron.BaseWindow | null | undefined
): Electron.BrowserWindow | undefined {
  return window instanceof BrowserWindow && !window.isDestroyed() ? window : undefined;
}

function runtimeLaunchConfiguration(): {
  entrypoint: string;
  arguments: string[];
  webAssetsDirectory: string;
  failureProbe?: { entrypoint: string; productRoot: string };
} {
  return desktopRuntimeLaunchConfiguration({
    ...(process.env.DEBRUTE_RUNTIME_ENTRYPOINT
      ? { configuredEntrypoint: process.env.DEBRUTE_RUNTIME_ENTRYPOINT }
      : {}),
    ...(process.env.DEBRUTE_RUNTIME_WEB_ASSETS_DIR
      ? { configuredWebAssetsDirectory: process.env.DEBRUTE_RUNTIME_WEB_ASSETS_DIR }
      : {}),
    resourcesPath: process.resourcesPath,
    homePath: app.getPath('home'),
    executablePath: process.execPath,
    platform: desktopPlatform
  });
}

async function showProductUpdateFailure(transactionId: string): Promise<void> {
  if (productUpdateFailureShown) {
    return;
  }
  productUpdateFailureShown = true;
  const runtime = runtimeLaunchConfiguration();
  const logPath = join(app.getPath('logs'), 'debrute-runtime.log');
  try {
    if (!runtime.failureProbe) {
      throw new Error('The installed Desktop does not provide a Product-update failure probe.');
    }
    const failure = readDesktopProductUpdateFailure(runtime.failureProbe, transactionId);
    dialog.showErrorBox(
      `Debrute ${failure.targetVersion} could not start`,
      `${failure.message}\n\nStage: ${failure.stage}\nRuntime log: ${logPath}\n\nRestart Debrute after resolving the reported problem; the same update transaction will continue.`
    );
  } catch (error) {
    dialog.showErrorBox(
      'Debrute update could not complete',
      `${messageFromUnknown(error)}\n\nRuntime log: ${logPath}\nTransaction: ${transactionId}`
    );
  }
}

function reportDesktopError(error: unknown): void {
  dialog.showErrorBox('Debrute Desktop error', messageFromUnknown(error));
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
