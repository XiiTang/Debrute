import electron from 'electron';
import { join } from 'node:path';

import type {
  ActivationIntent,
  ControlEvent,
  NativeMenuCommand,
  RecentProject
} from '@debrute/app-protocol';
import type { RuntimeControlClient } from '@debrute/runtime-control-client';

import {
  buildDesktopApplicationMenu,
  buildDesktopDockMenu
} from './desktopApplicationMenu.js';
import { createDesktopOpenAdmission } from './desktopOpenAdmission.js';
import { requireDesktopPlatform } from './desktopPlatform.js';
import { DesktopWindowHost } from './desktopWindowHost.js';
import { DesktopProductQuit } from './desktopProductQuit.js';
import { ElectronDesktopWindow } from './electronDesktopWindow.js';
import {
  registerNativeWindowIpc
} from './nativeWindowShell.js';
import {
  parseDesktopOpenIntent,
  syncNativeRecentProjects,
  type DesktopOpenIntent
} from './nativeRecentProjects.js';
import { connectOrLaunchDesktopRuntime } from './runtime/desktopRuntimeLauncher.js';
import { desktopRuntimeLaunchConfiguration } from './runtime/desktopProductBootstrap.js';

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
let recentProjects: RecentProject[] = [];
const desktopOpenAdmission = createDesktopOpenAdmission<Electron.BrowserWindow>(async (
  intent,
  preferredWindow
) => {
  const activeHost = windowHost;
  if (!activeHost) {
    throw new Error('Debrute window host is not available for Desktop activation.');
  }
  await activateOpenIntent(activeHost, intent, preferredWindow);
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
    runDesktopAction(dispatchDesktopOpen({ kind: 'open-project-path', projectRoot }));
  });

  app.on('second-instance', (_event, argv) => {
    runDesktopAction(dispatchDesktopOpen(
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
    takeDesktopLaunchTicket: (browserWindow) => (
      windowHost?.takeDesktopLaunchTicket(browserWindow)
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
      developmentOrigin: process.env.DEBRUTE_DESKTOP_VITE_ORIGIN,
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
): Promise<void> {
  const activation: ActivationIntent = intent.kind === 'open-project-path'
    ? { kind: 'open_project', project_root: intent.projectRoot, frontend: 'desktop' }
    : intent.kind === 'open-project-id'
      ? { kind: 'open_known_project', project_id: intent.projectId, frontend: 'desktop' }
      : { kind: 'open_desktop' };
  const response = await activeHost.activate(activation, preferredWindow);
  if (response.result === 'rejected') {
    throw new Error(`Runtime rejected Desktop activation: ${response.code}`);
  }
  if (response.result !== 'activation') {
    throw new Error(`Runtime returned an unexpected activation response: ${response.result}`);
  }
}

function handleControlEvent(event: ControlEvent): void {
  if (event.event !== 'desktop_recent_projects_changed') {
    return;
  }
  recentProjects = event.recent_projects;
  const jumpListResult = syncNativeRecentProjects(
    app,
    desktopPlatform,
    process.execPath,
    recentProjects.map((project) => project.projectRoot)
  );
  if (jumpListResult && jumpListResult !== 'ok') {
    console.warn(`Windows rejected the Debrute Jump List: ${jumpListResult}`);
  }
  installApplicationMenu();
}

function installApplicationMenu(): void {
  const recentItems: Electron.MenuItemConstructorOptions[] = recentProjects.length === 0
    ? [{ label: 'No Recent Projects', enabled: false }]
    : recentProjects.map((project) => ({
        label: project.projectRoot,
        click: (_item, window) => runDesktopAction(dispatchDesktopOpen(
          { kind: 'open-project-id', projectId: project.projectId },
          desktopBrowserWindow(window)
        ))
      }));
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildDesktopApplicationMenu({
    platform: desktopPlatform,
    recentItems,
    newWindow: () => runDesktopAction(dispatchDesktopOpen({ kind: 'new-window' })),
    openProject: (window) => runDesktopAction(chooseProject(
      window as Electron.BrowserWindow | undefined
    )),
    reloadWorkbench: (window) => {
      if (window instanceof BrowserWindow && !window.isDestroyed()) {
        runDesktopAction(reloadWindow(window));
      }
    },
    quitProduct: requestProductQuit
  })));
}

async function chooseProject(
  window: Electron.BrowserWindow | undefined
): Promise<void> {
  const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] };
  const result = window && !window.isDestroyed()
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  const projectRoot = result.filePaths[0];
  if (!result.canceled && projectRoot) {
    await dispatchDesktopOpen({ kind: 'open-project-path', projectRoot }, window);
  }
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
): Promise<void> {
  if (window.isDestroyed()) {
    throw new Error('Debrute native window is not available.');
  }
  switch (command.commandId) {
    case 'window.new': await dispatchDesktopOpen({ kind: 'new-window' }); return;
    case 'project.open-picker': await chooseProject(window); return;
    case 'project.open-known': {
      if (typeof command.projectId !== 'string' || command.projectId.length === 0) {
        throw new Error('Native Project activation requires projectId.');
      }
      await dispatchDesktopOpen(
        { kind: 'open-project-id', projectId: command.projectId },
        window
      );
      return;
    }
    case 'window.close': window.close(); return;
    case 'view.reload': await reloadWindow(window); return;
    case 'view.toggle-devtools': window.webContents.toggleDevTools(); return;
    case 'edit.undo': window.webContents.undo(); return;
    case 'edit.redo': window.webContents.redo(); return;
    case 'edit.cut': window.webContents.cut(); return;
    case 'edit.copy': window.webContents.copy(); return;
    case 'edit.paste': window.webContents.paste(); return;
    case 'edit.paste-and-match-style': window.webContents.pasteAndMatchStyle(); return;
    case 'edit.delete': window.webContents.delete(); return;
    case 'edit.select-all': window.webContents.selectAll(); return;
    default: throw new Error('Unsupported native menu command.');
  }
}

function requestProductQuit(): void {
  if (productQuit.requested || appQuitAllowed) {
    return;
  }
  runDesktopAction(productQuit.request(control));
}

function runDesktopAction(action: Promise<void>): void {
  void action.catch(reportDesktopError);
}

function dispatchDesktopOpen(
  intent: DesktopOpenIntent,
  preferredWindow?: Electron.BrowserWindow
): Promise<void> {
  return intent.kind === 'new-window'
    ? desktopOpenAdmission.dispatch(intent)
    : desktopOpenAdmission.dispatch(intent, preferredWindow);
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

function reportDesktopError(error: unknown): void {
  dialog.showErrorBox('Debrute Desktop error', messageFromUnknown(error));
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
