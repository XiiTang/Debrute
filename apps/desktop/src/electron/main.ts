import electron from 'electron';
import { join } from 'node:path';

import type {
  ActivationIntent,
  ControlEvent,
  RecentProject
} from '@debrute/app-protocol';
import type { RuntimeControlClient } from '@debrute/runtime-control-client';

import { buildDesktopApplicationMenu } from './desktopApplicationMenu.js';
import { requireDesktopPlatform } from './desktopPlatform.js';
import { DesktopWindowHost } from './desktopWindowHost.js';
import { DesktopProductQuit } from './desktopProductQuit.js';
import { ElectronDesktopWindow } from './electronDesktopWindow.js';
import {
  nativeWindowIpcChannels,
  registerNativeWindowIpc,
  type ApplicationMenuCommand
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

let control: RuntimeControlClient | undefined;
let windowHost: DesktopWindowHost<Electron.BrowserWindow, ElectronDesktopWindow> | undefined;
let appQuitAllowed = false;
const productQuit = new DesktopProductQuit();
let runtimeLossReported = false;
let recentProjects: RecentProject[] = [];
const pendingOpenIntents: DesktopOpenIntent[] = [];

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
    void dispatchOpenIntent({ kind: 'open-project-path', projectRoot });
  });

  app.on('second-instance', (_event, argv) => {
    void dispatchOpenIntent(parseDesktopOpenIntent(argv) ?? { kind: 'new-window' })
      .catch(reportDesktopError);
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
    app.dock?.setIcon(nativeImage.createFromPath(dockIconPath));
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

  const initialIntent = parseDesktopOpenIntent(process.argv) ?? { kind: 'new-window' };
  await dispatchOpenIntent(initialIntent);
  while (pendingOpenIntents.length > 0) {
    await dispatchOpenIntent(pendingOpenIntents.shift());
  }
}

async function dispatchOpenIntent(intent: DesktopOpenIntent | undefined): Promise<void> {
  if (!intent) {
    return;
  }
  if (!control) {
    pendingOpenIntents.push(intent);
    return;
  }
  const activation: ActivationIntent = intent.kind === 'open-project-path'
    ? { kind: 'open_project', project_root: intent.projectRoot, frontend: 'desktop' }
    : intent.kind === 'open-project-id'
      ? { kind: 'open_known_project', project_id: intent.projectId, frontend: 'desktop' }
      : { kind: 'open_desktop' };
  const response = await control.activate(activation);
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
  try {
    syncNativeRecentProjects(
      app,
      desktopPlatform,
      process.execPath,
      recentProjects.map((project) => project.projectRoot)
    );
  } catch (error) {
    reportDesktopError(error);
  }
  installApplicationMenu();
}

function installApplicationMenu(): void {
  const recentItems: Electron.MenuItemConstructorOptions[] = recentProjects.length === 0
    ? [{ label: 'No Recent Projects', enabled: false }]
    : recentProjects.map((project) => ({
        label: project.projectRoot,
        click: (_item, window) => void openProjectInWindow(
          window as Electron.BrowserWindow | undefined,
          project
        )
      }));
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildDesktopApplicationMenu({
    platform: desktopPlatform,
    recentItems,
    newWindow: () => void dispatchOpenIntent({ kind: 'new-window' }),
    openProject: (window) => void chooseProject(window as Electron.BrowserWindow | undefined),
    openProjectInNewWindow: () => void chooseProject(undefined, true),
    reloadWorkbench: (window) => {
      if (window instanceof BrowserWindow && !window.isDestroyed()) {
        void reloadWindow(window).catch(reportDesktopError);
      }
    },
    quitProduct: requestProductQuit
  })));
}

async function chooseProject(
  window: Electron.BrowserWindow | undefined,
  openInNewWindow = false
): Promise<void> {
  const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] };
  const result = window && !window.isDestroyed()
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  const projectRoot = result.filePaths[0];
  if (!result.canceled && projectRoot) {
    if (openInNewWindow) {
      await dispatchOpenIntent({ kind: 'open-project-path', projectRoot });
    } else {
      await openProjectInWindow(window, { projectId: '', projectRoot });
    }
  }
}

async function openProjectInWindow(
  window: Electron.BrowserWindow | undefined,
  project: RecentProject
): Promise<void> {
  if (window && !window.isDestroyed()) {
    window.webContents.send(nativeWindowIpcChannels.openProjectRequested, project.projectRoot);
    return;
  }
  await dispatchOpenIntent(project.projectId
    ? { kind: 'open-project-id', projectId: project.projectId }
    : { kind: 'open-project-path', projectRoot: project.projectRoot });
}

async function reloadWindow(window: Electron.BrowserWindow): Promise<void> {
  if (!windowHost) {
    throw new Error('Debrute window host is not available.');
  }
  await windowHost.reload(window);
}

async function executeNativeMenuCommand(
  window: Electron.BrowserWindow,
  command: ApplicationMenuCommand
): Promise<void> {
  if (window.isDestroyed()) {
    throw new Error('Debrute native window is not available.');
  }
  switch (command.commandId) {
    case 'window.new': await dispatchOpenIntent({ kind: 'new-window' }); return;
    case 'project.open-picker-new-window': await chooseProject(undefined, true); return;
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
  void productQuit.request(control).catch(reportDesktopError);
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
