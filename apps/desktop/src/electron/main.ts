import electron from 'electron';
import { join } from 'node:path';

import type {
  ActivationIntent,
  ControlEvent,
  RecentProject
} from '@debrute/app-protocol';
import type { RuntimeControlClient } from '@debrute/runtime-control-client';

import {
  DesktopWindowControlAdapter,
  type DesktopNativeWindow
} from './desktopWindowControlAdapter.js';
import {
  desktopBrowserWindowChromeOptions,
  nativeWindowIpcChannels,
  nativeWindowState,
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

let control: RuntimeControlClient | undefined;
let windows: DesktopWindowControlAdapter<ElectronDesktopWindow> | undefined;
let appQuitAllowed = false;
let productQuitRequested = false;
let runtimeLossReported = false;
let recentProjects: RecentProject[] = [];
const pendingOpenIntents: DesktopOpenIntent[] = [];
const nativeWindows = new Map<string, ElectronDesktopWindow>();

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
    // DesktopWindowControlAdapter reports the final close to Runtime before
    // performing the Desktop-only app exit.
  });

  app.on('before-quit', (event) => {
    if (appQuitAllowed) {
      return;
    }
    event.preventDefault();
    void requestProductQuit();
  });

  void app.whenReady().then(startDesktop).catch((error: unknown) => {
    dialog.showErrorBox('Debrute Desktop could not start', messageFromUnknown(error));
    appQuitAllowed = true;
    app.quit();
  });
}

async function startDesktop(): Promise<void> {
  if (process.platform === 'darwin') {
    app.dock?.setIcon(nativeImage.createFromPath(dockIconPath));
  }
  registerNativeWindowIpc<Electron.WebContents, Electron.BrowserWindow>({
    ipcMain,
    browserWindow: BrowserWindow,
    executeNativeMenuCommand,
    takeDesktopLaunchTicket: (browserWindow) => (
      findNativeWindow(browserWindow)?.takeDesktopLaunchTicket()
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
  windows = new DesktopWindowControlAdapter({
    control: activeControl,
    createWindow: createNativeWindow,
    quitDesktop: () => {
      appQuitAllowed = true;
      control = undefined;
      app.quit();
    },
    onError: reportDesktopError
  });
  activeControl.onEvent(handleControlEvent);
  activeControl.onRuntimeLost((error) => {
    if (appQuitAllowed || productQuitRequested || runtimeLossReported) {
      return;
    }
    runtimeLossReported = true;
    dialog.showErrorBox('Debrute Runtime connection ended', error.message);
    appQuitAllowed = true;
    app.quit();
  });
  installApplicationMenu();

  const initialIntent = parseDesktopOpenIntent(process.argv) ?? { kind: 'new-window' };
  const handledElsewhere = await dispatchOpenIntent(initialIntent);
  if (handledElsewhere) {
    appQuitAllowed = true;
    activeControl.close();
    app.quit();
    return;
  }
  while (pendingOpenIntents.length > 0) {
    await dispatchOpenIntent(pendingOpenIntents.shift());
  }
}

async function createNativeWindow(input: {
  windowKey: string;
  ticket: string;
  url: string;
}): Promise<ElectronDesktopWindow> {
  const browserWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    ...desktopBrowserWindowChromeOptions(process.platform),
    backgroundColor: '#111318',
    icon: projectIconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      partition: `debrute-${input.windowKey}`
    }
  });
  const nativeWindow = new ElectronDesktopWindow(
    input.windowKey,
    browserWindow,
    input.ticket
  );
  nativeWindows.set(input.windowKey, nativeWindow);
  nativeWindow.onClosed(() => nativeWindows.delete(input.windowKey));
  browserWindow.webContents.on('render-process-gone', (_event, details) => {
    dialog.showErrorBox(
      'Debrute Workbench stopped',
      `The window renderer ended (${details.reason}). Use View > Reload Workbench to start a fresh connection.`
    );
  });
  await nativeWindow.load(input.url);
  nativeWindow.show();
  return nativeWindow;
}

class ElectronDesktopWindow implements DesktopNativeWindow {
  private launchTicket: string | undefined;

  constructor(
    readonly windowKey: string,
    readonly window: Electron.BrowserWindow,
    launchTicket: string
  ) {
    this.launchTicket = launchTicket;
  }

  isDestroyed(): boolean {
    return this.window.isDestroyed();
  }

  show(): void {
    this.window.show();
  }

  focus(): void {
    this.window.focus();
  }

  setLaunchTicket(ticket: string): void {
    this.launchTicket = ticket;
  }

  takeDesktopLaunchTicket(): string | undefined {
    const ticket = this.launchTicket;
    this.launchTicket = undefined;
    return ticket;
  }

  async load(url: string): Promise<void> {
    await this.window.loadURL(rewriteRuntimeUrlForDevelopment(url));
  }

  destroy(): void {
    this.launchTicket = undefined;
    if (!this.window.isDestroyed()) {
      this.window.destroy();
    }
  }

  onClosed(listener: () => void): () => void {
    this.window.once('closed', listener);
    return () => this.window.removeListener('closed', listener);
  }
}

async function dispatchOpenIntent(intent: DesktopOpenIntent | undefined): Promise<boolean> {
  if (!intent) {
    return false;
  }
  if (!control) {
    pendingOpenIntents.push(intent);
    return false;
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
  return response.outcome === 'handled_by_existing_desktop';
}

function handleControlEvent(event: ControlEvent): void {
  if (event.event !== 'desktop_recent_projects_changed') {
    return;
  }
  recentProjects = event.recent_projects;
  syncNativeRecentProjects(
    app,
    process.platform,
    process.execPath,
    recentProjects.map((project) => project.projectRoot)
  );
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
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{
      label: 'Debrute',
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => void dispatchOpenIntent({ kind: 'new-window' }) },
        { type: 'separator' },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: (_item, window) => void chooseProject(window as Electron.BrowserWindow | undefined) },
        { label: 'Open Project in New Window…', accelerator: 'CmdOrCtrl+Shift+O', click: () => void chooseProject(undefined, true) },
        { label: 'Open Recent', submenu: recentItems },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        ...(process.platform === 'darwin' ? [{ role: 'pasteAndMatchStyle' as const }] : []),
        { role: 'delete' }, { role: 'selectAll' },
        ...(process.platform === 'darwin' ? [
          { type: 'separator' as const },
          {
            label: 'Speech',
            submenu: [
              { role: 'startSpeaking' as const },
              { role: 'stopSpeaking' as const }
            ]
          }
        ] : [])
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload Workbench', accelerator: 'CmdOrCtrl+R', click: (_item, window) => void reloadWindow(window as Electron.BrowserWindow | undefined) },
        { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' },
        { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]));
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

async function reloadWindow(window: Electron.BrowserWindow | undefined): Promise<void> {
  const nativeWindow = findNativeWindow(window);
  if (nativeWindow) {
    await windows?.reloadWindow(nativeWindow.windowKey);
  }
}

async function executeNativeMenuCommand(
  window: Electron.BrowserWindow | undefined,
  command: { commandId: string }
): Promise<void> {
  if (!window || window.isDestroyed()) {
    return;
  }
  if (command.commandId === 'window.new') await dispatchOpenIntent({ kind: 'new-window' });
  else if (command.commandId === 'project.open-picker-new-window') await chooseProject(undefined, true);
  else if (command.commandId === 'window.close') window.close();
  else if (command.commandId === 'view.reload') await reloadWindow(window);
  else if (command.commandId === 'view.toggle-devtools') window.webContents.toggleDevTools();
  else if (command.commandId === 'edit.undo') window.webContents.undo();
  else if (command.commandId === 'edit.redo') window.webContents.redo();
  else if (command.commandId === 'edit.cut') window.webContents.cut();
  else if (command.commandId === 'edit.copy') window.webContents.copy();
  else if (command.commandId === 'edit.paste') window.webContents.paste();
  else if (command.commandId === 'edit.select-all') window.webContents.selectAll();
}

async function requestProductQuit(): Promise<void> {
  if (productQuitRequested || appQuitAllowed) {
    return;
  }
  productQuitRequested = true;
  try {
    const response = await control?.quitProduct();
    if (!response) {
      appQuitAllowed = true;
      app.quit();
    } else if (response.result === 'rejected') {
      productQuitRequested = false;
      dialog.showErrorBox('Debrute could not quit', `Runtime rejected Product Quit: ${response.code}`);
    } else if (response.result !== 'ok') {
      throw new Error(`Runtime returned an unexpected Product Quit response: ${response.result}`);
    }
  } catch (error) {
    productQuitRequested = false;
    reportDesktopError(error);
  }
}

function findNativeWindow(
  browserWindow: Electron.BrowserWindow | undefined
): ElectronDesktopWindow | undefined {
  return [...nativeWindows.values()].find((candidate) => candidate.window === browserWindow);
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
    configuredArguments: environmentArguments('DEBRUTE_RUNTIME_ARGUMENTS_JSON'),
    ...(process.env.DEBRUTE_RUNTIME_WEB_ASSETS_DIR
      ? { configuredWebAssetsDirectory: process.env.DEBRUTE_RUNTIME_WEB_ASSETS_DIR }
      : {}),
    sourceWebAssetsDirectory: join(__dirname, '../dist'),
    resourcesPath: process.resourcesPath,
    homePath: app.getPath('home'),
    executablePath: process.execPath,
    applicationPath: app.getAppPath(),
    packaged: app.isPackaged,
    platform: process.platform
  });
}

function environmentArguments(name: string): string[] {
  const value = process.env[name];
  if (!value) {
    return [];
  }
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((argument) => typeof argument !== 'string')) {
    throw new Error(`${name} must be a JSON array of strings.`);
  }
  return parsed;
}

function rewriteRuntimeUrlForDevelopment(url: string): string {
  const developmentOrigin = process.env.DEBRUTE_DESKTOP_VITE_ORIGIN;
  if (!developmentOrigin) {
    return url;
  }
  const source = new URL(url);
  const target = new URL(developmentOrigin);
  target.pathname = source.pathname;
  return target.toString();
}

function reportDesktopError(error: unknown): void {
  dialog.showErrorBox('Debrute Desktop error', messageFromUnknown(error));
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
