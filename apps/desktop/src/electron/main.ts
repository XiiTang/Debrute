import { randomUUID } from 'node:crypto';
import electron from 'electron';
import { autoUpdater } from 'electron-updater';
import { join } from 'node:path';
import {
  createDesktopAppUpdateService,
  fetchLatestDebruteRelease,
  type DesktopAppUpdateService
} from './app-update/appUpdateService.js';
import { registerAppUpdateShellIpc } from './app-update/appUpdateShell.js';
import { createAttachedDesktopRuntimeClient, type DesktopRuntimeClient } from './desktopRuntimeClient.js';
import { createDebruteCliInstaller } from './debruteCliInstaller.js';
import { registerDebruteCliShellIpc } from './debruteCliShell.js';
import { loadDebruteProjectShellWindow, waitForDebruteShellUrl } from './desktopShellLoad.js';
import { createApplicationMenuController } from './menu/registerApplicationMenu.js';
import type { ApplicationMenuCommand } from './menu/applicationMenu.js';
import { parseDesktopOpenIntent, syncNativeRecentProjects, type DesktopOpenIntent } from './nativeRecentProjects.js';
import { RuntimeSupervisor } from './runtime/runtimeSupervisor.js';
import { TrayController } from './tray/trayController.js';
import { runProjectWindowOpenOnce, selectProjectWindowOpenTarget } from './windowProjectRouting.js';

const { app, BrowserWindow, dialog, ipcMain, Menu } = electron;
let runtimeSupervisor: RuntimeSupervisor | undefined;
let runtimeClient: DesktopRuntimeClient | undefined;
let trayController: TrayController | undefined;
let appUpdateService: DesktopAppUpdateService | undefined;
let trueQuitRequested = false;
const projectWindowsByProjectId = new Map<string, Electron.BrowserWindow>();
const projectIdsByWindowId = new Map<number, string>();
const projectRootsByWindowId = new Map<number, string>();
const releaseProjectWindowByWindowId = new Map<number, () => Promise<void>>();
const detachedProjectWindowLeaseIds = new Set<number>();
const pendingProjectWindowOpens = new Map<string, Promise<void>>();
const pendingDesktopOpenIntents: DesktopOpenIntent[] = [];

if (!app.requestSingleInstanceLock()) {
  console.error(
    'Debrute desktop is already running. Quit the existing Debrute desktop instance before running pnpm dev:electron again.'
  );
  app.quit();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    detachProjectWindowLeasesFromStoppedRuntime();
    void requestTrueQuit();
  });
}

const applicationMenu = createApplicationMenuController({
  menu: Menu,
  platform: process.platform,
  readTitleBarState: async () => runtimeClient?.getWorkbenchTitleBarState(),
  onCommand: async (sourceWindow, command) => {
    await executeNativeMenuCommand(sourceWindow, command);
  }
});
const projectIconPath = join(__dirname, 'icon.png');
const dockIconPath = join(__dirname, 'dock_icon.png');

async function createWindow(initialUrl?: string, projectId?: string, projectRoot?: string): Promise<Electron.BrowserWindow> {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1100,
    minHeight: 720,
    ...desktopBrowserWindowChromeOptions(process.platform),
    backgroundColor: '#181818',
    icon: projectIconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  window.on('close', (event) => {
    if (process.platform === 'win32' && !trueQuitRequested) {
      event.preventDefault();
      window.hide();
    }
  });
  window.once('closed', () => {
    void releaseProjectWindow(window.id).catch((error) => {
      if (trueQuitRequested) {
        return;
      }
      console.error(`Debrute Electron window lease release failed: ${messageFromUnknown(error)}`);
    });
  });
  const sendNativeWindowState = () => {
    if (!window.isDestroyed()) {
      window.webContents.send('debrute-shell:nativeWindowStateChanged', nativeWindowState(window));
    }
  };
  window.on('maximize', sendNativeWindowState);
  window.on('unmaximize', sendNativeWindowState);
  window.on('restore', sendNativeWindowState);

  const client = requireRuntimeClient();
  const urlToLoad = initialUrl ?? client.shellUrl();
  if (projectId) {
    await loadDebruteProjectShellWindow(window, urlToLoad, () => prepareProjectWindowBinding(window, projectId, projectRoot));
  } else {
    await waitForDebruteShellUrl(urlToLoad);
    await window.loadURL(urlToLoad);
  }
  return window;
}

function desktopBrowserWindowChromeOptions(platform: NodeJS.Platform): Electron.BrowserWindowConstructorOptions {
  if (platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset'
    };
  }
  return {
    frame: false,
    titleBarStyle: 'hidden'
  };
}

app.on('open-file', (event, projectRoot) => {
  event.preventDefault();
  void handleDesktopOpenIntent({ kind: 'open-project', projectRoot });
});

app.on('second-instance', (_event, argv) => {
  void handleDesktopOpenIntent(parseDesktopOpenIntent(argv));
});

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    app.dock!.setIcon(dockIconPath);
  }
  runtimeSupervisor = new RuntimeSupervisor({
    owner: {
      kind: 'desktop',
      ownerId: randomUUID(),
      pid: process.pid
    }
  });
  trayController = new TrayController({
    app,
    Tray: electron.Tray,
    Menu,
    nativeImage: electron.nativeImage,
    runtimeSupervisor,
    readRecentProjectRoots: async () => (
      runtimeClient ? (await runtimeClient.getWorkbenchTitleBarState()).recentProjectRoots : []
    ),
    actions: {
      openDebrute: () => {
        void openDebruteRootWindow();
      },
      openRecent: (projectRoot) => {
        void openProjectRootFromDesktop(projectRoot, { forceNewWindow: false });
      },
      showRuntimeStatus: () => {
        void showRuntimeStatus();
      },
      restartRuntime: () => {
        void restartRuntimeAndReloadWindows();
      },
      quitDebrute: () => {
        void requestTrueQuit();
      }
    }
  });
  await trayController.start();
  appUpdateService = createDesktopAppUpdateService({
    app,
    platform: process.platform,
    driver: autoUpdater,
    openExternal: (url) => electron.shell.openExternal(url),
    linuxReleaseChecker: () => fetchLatestDebruteRelease({ fetch })
  });
  registerShellIpc();
  appUpdateService.startDelayedBackgroundCheck();
  await applicationMenu.refreshApplicationMenu();
  try {
    const runtimeState = await runtimeSupervisor.start();
    runtimeClient = createAttachedDesktopRuntimeClient({
      daemonUrl: runtimeState.daemonUrl,
      webBaseUrl: runtimeState.webUrl,
      token: runtimeState.token,
      platform: process.platform
    });
    await refreshProjectHistorySurfaces();
  } catch (error) {
    console.error(`Debrute runtime failed to start: ${messageFromUnknown(error)}`);
    await refreshTray();
    await applicationMenu.refreshApplicationMenu();
    return;
  }
  const initialIntent = parseDesktopOpenIntent(process.argv);
  if (initialIntent) {
    await handleDesktopOpenIntent(initialIntent);
  } else if (pendingDesktopOpenIntents.length === 0) {
    await createWindow();
  }
  await flushPendingDesktopOpenIntents();
});

app.on('window-all-closed', () => {
  // Debrute remains present in the menu bar or tray until a true quit action.
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

app.on('before-quit', (event) => {
  if (trueQuitRequested) {
    return;
  }
  event.preventDefault();
  void requestTrueQuit();
});

function registerShellIpc(): void {
  ipcMain.handle('debrute-shell:bindProjectWindowToProject', async (event, input: { projectId: string }) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      throw new Error('Debrute project window is not available.');
    }
    await bindProjectWindow(window, input.projectId);
    return { ok: true };
  });
  ipcMain.handle('debrute-shell:getWorkbenchTitleBarState', async (_event, input: { projectId?: string } | undefined) => (
    requireRuntimeClient().getWorkbenchTitleBarState(input?.projectId)
  ));
  ipcMain.handle('debrute-shell:clearRecentProjectRoots', async () => {
    const result = await requireRuntimeClient().clearRecentProjectRoots();
    await refreshProjectHistorySurfaces();
    return result;
  });
  ipcMain.handle('debrute-shell:getNativeWindowState', (event) => nativeWindowState(requireFocusedWindow(event)));
  ipcMain.handle('debrute-shell:minimizeNativeWindow', (event) => {
    const window = requireFocusedWindow(event);
    window.minimize();
    return nativeWindowState(window);
  });
  ipcMain.handle('debrute-shell:toggleMaximizeNativeWindow', (event) => {
    const window = requireFocusedWindow(event);
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
    return nativeWindowState(window);
  });
  ipcMain.handle('debrute-shell:closeNativeWindow', (event) => {
    requireFocusedWindow(event).close();
    return { ok: true };
  });
  ipcMain.handle('debrute-shell:executeNativeMenuCommand', async (event, input: ApplicationMenuCommand) => {
    await executeNativeMenuCommand(requireFocusedWindow(event), input);
    return { ok: true };
  });
  registerDebruteCliShellIpc({
    ipcMain,
    installer: createDebruteCliInstaller({
      desktopVersion: app.getVersion(),
      userHome: app.getPath('home')
    })
  });
  if (appUpdateService) {
    registerAppUpdateShellIpc({
      ipcMain,
      service: appUpdateService,
      windows: () => BrowserWindow.getAllWindows()
    });
  }
}

function requireFocusedWindow(event: Electron.IpcMainInvokeEvent): Electron.BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.isDestroyed()) {
    throw new Error('Debrute native window is not available.');
  }
  return window;
}

function nativeWindowState(window: Electron.BrowserWindow): { maximized: boolean } {
  return { maximized: window.isMaximized() };
}

async function executeNativeMenuCommand(
  sourceWindow: Electron.BrowserWindow | undefined,
  command: ApplicationMenuCommand
): Promise<void> {
  switch (command.commandId) {
    case 'window.new':
      await createWindow();
      return;
    case 'project.open-picker':
      await openProjectFromPickerFromShell({
        ...(sourceWindow ? { sourceWindow } : {}),
        forceNewWindow: false
      });
      return;
    case 'project.open-picker-new-window':
      await openProjectFromPickerFromShell({
        ...(sourceWindow ? { sourceWindow } : {}),
        forceNewWindow: true
      });
      return;
    case 'project.open-recent': {
      const projectRoot = typeof command.payload?.projectRoot === 'string' ? command.payload.projectRoot : '';
      if (!projectRoot) {
        throw new Error('Recent project command requires projectRoot.');
      }
      await openProjectRootFromDesktop(projectRoot, {
        ...(sourceWindow ? { sourceWindow } : {}),
        forceNewWindow: false
      });
      return;
    }
    case 'project.clear-recent':
      await requireRuntimeClient().clearRecentProjectRoots();
      await refreshProjectHistorySurfaces();
      return;
    case 'window.close':
      requireNativeMenuWindow(sourceWindow, command.commandId).close();
      return;
    case 'view.reload':
      requireNativeMenuWindow(sourceWindow, command.commandId).reload();
      return;
    case 'view.toggle-devtools':
      requireNativeMenuWindow(sourceWindow, command.commandId).webContents.toggleDevTools();
      return;
    default:
      executeFocusedEditCommand(requireNativeMenuWindow(sourceWindow, command.commandId), command.commandId);
  }
}

function requireNativeMenuWindow(
  window: Electron.BrowserWindow | undefined,
  commandId: ApplicationMenuCommand['commandId']
): Electron.BrowserWindow {
  if (!window || window.isDestroyed()) {
    throw new Error(`Debrute native menu command requires a window: ${commandId}`);
  }
  return window;
}

function executeFocusedEditCommand(window: Electron.BrowserWindow, commandId: ApplicationMenuCommand['commandId']): void {
  const webContents = window.webContents;
  if (commandId === 'edit.undo') webContents.undo();
  else if (commandId === 'edit.redo') webContents.redo();
  else if (commandId === 'edit.cut') webContents.cut();
  else if (commandId === 'edit.copy') webContents.copy();
  else if (commandId === 'edit.paste') webContents.paste();
  else if (commandId === 'edit.paste-and-match-style') webContents.pasteAndMatchStyle();
  else if (commandId === 'edit.delete') webContents.delete();
  else if (commandId === 'edit.select-all') webContents.selectAll();
}

async function handleDesktopOpenIntent(intent: DesktopOpenIntent | undefined): Promise<void> {
  if (!intent) {
    return;
  }
  if (!runtimeClient) {
    pendingDesktopOpenIntents.push(intent);
    return;
  }
  if (intent.kind === 'new-window') {
    await createWindow();
    return;
  }
  await openProjectRootFromDesktop(intent.projectRoot, { forceNewWindow: false });
}

async function flushPendingDesktopOpenIntents(): Promise<void> {
  while (pendingDesktopOpenIntents.length > 0) {
    await handleDesktopOpenIntent(pendingDesktopOpenIntents.shift());
  }
}

async function openProjectRootFromDesktop(
  projectRoot: string,
  options: { sourceWindow?: Electron.BrowserWindow; forceNewWindow?: boolean } = {}
): Promise<void> {
  const opened = await requireRuntimeClient().openProject(projectRoot);
  await refreshProjectHistorySurfaces();
  await runProjectWindowOpenOnce({
    projectId: opened.projectId,
    pendingProjectOpens: pendingProjectWindowOpens,
    open: () => openProjectInWindow({ ...opened, projectRoot }, options),
    reusePending: () => {
      projectWindowsByProjectId.get(opened.projectId)?.focus();
    }
  });
}

async function openProjectFromPickerFromShell(
  options: { sourceWindow?: Electron.BrowserWindow; forceNewWindow?: boolean } = {}
): Promise<void> {
  const opened = await requireRuntimeClient().openProjectFromPicker();
  if (!opened.opened) {
    return;
  }
  await refreshProjectHistorySurfaces();
  await runProjectWindowOpenOnce({
    projectId: opened.projectId,
    pendingProjectOpens: pendingProjectWindowOpens,
    open: () => openProjectInWindow(opened, options),
    reusePending: () => {
      projectWindowsByProjectId.get(opened.projectId)?.focus();
    }
  });
}

async function openProjectInWindow(
  opened: { projectId: string; url: string; projectRoot?: string },
  options: { sourceWindow?: Electron.BrowserWindow; forceNewWindow?: boolean }
): Promise<void> {
  const liveWindowIds = new Set(BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()).map((window) => window.id));
  const windowIdByProjectId = new Map(
    [...projectWindowsByProjectId.entries()]
      .filter(([, window]) => !window.isDestroyed())
      .map(([projectId, window]) => [projectId, window.id])
  );
  const target = selectProjectWindowOpenTarget({
    projectId: opened.projectId,
    forceNewWindow: options.forceNewWindow === true,
    windowIdByProjectId,
    liveWindowIds,
    ...(options.sourceWindow ? { sourceWindowId: options.sourceWindow.id } : {})
  });
  if (target.kind === 'focus') {
    BrowserWindow.fromId(target.windowId)?.focus();
    return;
  }
  if (target.kind === 'reuse') {
    const window = BrowserWindow.fromId(target.windowId);
    if (window && !window.isDestroyed()) {
      await loadDebruteProjectShellWindow(window, opened.url, () => prepareProjectWindowBinding(window, opened.projectId, opened.projectRoot));
      window.focus();
      return;
    }
  }
  await createWindow(opened.url, opened.projectId, opened.projectRoot);
}

function requireRuntimeClient(): DesktopRuntimeClient {
  if (!runtimeClient) {
    throw new Error('Debrute desktop runtime client is not ready.');
  }
  return runtimeClient;
}

function requireRuntimeSupervisor(): RuntimeSupervisor {
  if (!runtimeSupervisor) {
    throw new Error('Debrute runtime supervisor is not ready.');
  }
  return runtimeSupervisor;
}

async function openDebruteRootWindow(): Promise<void> {
  const rootWindow = BrowserWindow.getAllWindows().find((window) => (
    !window.isDestroyed() && !projectIdsByWindowId.has(window.id)
  ));
  if (rootWindow) {
    rootWindow.show();
    rootWindow.focus();
    return;
  }
  await createWindow();
}

async function restartRuntimeAndReloadWindows(): Promise<void> {
  const windows = BrowserWindow.getAllWindows()
    .filter((window) => !window.isDestroyed())
    .map((window) => {
      const projectRoot = projectRootsByWindowId.get(window.id);
      return { window, projectRoot };
    });
  detachProjectWindowLeasesFromStoppedRuntime();
  const state = await requireRuntimeSupervisor().restart();
  runtimeClient = createAttachedDesktopRuntimeClient({
    daemonUrl: state.daemonUrl,
    webBaseUrl: state.webUrl,
    token: state.token,
    platform: process.platform
  });
  for (const { window, projectRoot } of windows) {
    if (window.isDestroyed()) {
      continue;
    }
    if (projectRoot) {
      const opened = await runtimeClient.openProject(projectRoot);
      await loadDebruteProjectShellWindow(window, opened.url, () => prepareProjectWindowBinding(window, opened.projectId, projectRoot));
    } else {
      const url = runtimeClient.shellUrl();
      await waitForDebruteShellUrl(url);
      await window.loadURL(url);
      dropProjectWindowBinding(window.id);
    }
  }
  await refreshProjectHistorySurfaces();
}

async function showRuntimeStatus(): Promise<void> {
  await dialog.showMessageBox({
    type: 'info',
    title: 'Debrute Runtime Status',
    message: runtimeStatusMessage(requireRuntimeSupervisor().snapshot())
  });
}

function runtimeStatusMessage(snapshot: ReturnType<RuntimeSupervisor['snapshot']>): string {
  const state = snapshot.state;
  return [
    `Status: ${snapshot.status}`,
    `Runtime kind: ${state?.runtimeKind ?? 'none'}`,
    `Process control: ${state?.processControl ?? 'none'}`,
    `Owner: ${state ? `${state.owner.kind}:${state.owner.ownerId} pid=${state.owner.pid}` : 'none'}`,
    `Daemon URL: ${state?.daemonUrl ?? 'none'}`,
    `Web URL: ${state?.webUrl ?? 'none'}`,
    `Daemon pid: ${state?.daemonPid ?? 'none'}`,
    `Web pid: ${state?.webPid ?? 'none'}`,
    `Daemon log: ${state?.daemonLogPath ?? 'none'}`,
    `Web log: ${state?.webLogPath ?? 'none'}`,
    `Last health: ${snapshot.lastHealth ?? 'none'}`,
    `Last error: ${snapshot.lastError ?? 'none'}`
  ].join('\n');
}

async function requestTrueQuit(): Promise<void> {
  if (trueQuitRequested) {
    return;
  }
  trueQuitRequested = true;
  if (runtimeSupervisor) {
    await runtimeSupervisor.stopOwnedRuntime();
  }
  trayController?.destroy();
  runtimeClient = undefined;
  app.quit();
}

async function refreshProjectHistorySurfaces(): Promise<void> {
  const state = await requireRuntimeClient().getWorkbenchTitleBarState();
  syncNativeRecentProjects(app, process.platform, process.execPath, state.recentProjectRoots);
  await applicationMenu.refreshApplicationMenu();
  await refreshTray();
}

async function refreshTray(): Promise<void> {
  await trayController?.refresh();
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function bindProjectWindow(window: Electron.BrowserWindow, projectId: string, projectRoot?: string): Promise<void> {
  const binding = await prepareProjectWindowBinding(window, projectId, projectRoot);
  await binding.commit();
}

async function prepareProjectWindowBinding(window: Electron.BrowserWindow, projectId: string, projectRoot?: string) {
  const currentProjectId = projectIdsByWindowId.get(window.id);
  const hasActiveLease = releaseProjectWindowByWindowId.has(window.id);
  const hasDetachedLease = detachedProjectWindowLeaseIds.has(window.id);
  if (
    currentProjectId === projectId
    && (hasActiveLease || (hasDetachedLease && !projectRoot))
  ) {
    return {
      commit: () => {
        if (projectRoot) {
          projectRootsByWindowId.set(window.id, projectRoot);
          void refreshProjectHistorySurfaces().catch((error) => {
            if (!trueQuitRequested) {
              console.error(`Debrute recent project update failed: ${messageFromUnknown(error)}`);
            }
          });
        }
      },
      rollback: () => undefined
    };
  }
  const lease = await requireRuntimeClient().registerElectronProjectWindow(projectId, window.id);
  const release = lease.release;
  const boundProjectRoot = projectRoot ?? lease.projectRoot;
  let finalized = false;
  return {
    commit: async () => {
      if (finalized) {
        return;
      }
      finalized = true;
      try {
        await releaseProjectWindow(window.id);
      } catch (error) {
        await release();
        throw error;
      }
      projectWindowsByProjectId.set(projectId, window);
      projectIdsByWindowId.set(window.id, projectId);
      if (boundProjectRoot) {
        projectRootsByWindowId.set(window.id, boundProjectRoot);
        void refreshProjectHistorySurfaces().catch((error) => {
          if (!trueQuitRequested) {
            console.error(`Debrute recent project update failed: ${messageFromUnknown(error)}`);
          }
        });
      }
      detachedProjectWindowLeaseIds.delete(window.id);
      releaseProjectWindowByWindowId.set(window.id, release);
    },
    rollback: async () => {
      if (finalized) {
        return;
      }
      finalized = true;
      await release();
    }
  };
}

async function releaseProjectWindow(windowId: number): Promise<void> {
  const projectId = projectIdsByWindowId.get(windowId);
  const release = releaseProjectWindowByWindowId.get(windowId);
  try {
    if (release) {
      await release();
    }
  } finally {
    dropProjectWindowBinding(windowId);
  }
}

function detachProjectWindowLeasesFromStoppedRuntime(): void {
  for (const windowId of releaseProjectWindowByWindowId.keys()) {
    releaseProjectWindowByWindowId.delete(windowId);
    detachedProjectWindowLeaseIds.add(windowId);
  }
}

function dropProjectWindowBinding(windowId: number): void {
  const projectId = projectIdsByWindowId.get(windowId);
  if (projectId && projectWindowsByProjectId.get(projectId)?.id === windowId) {
    projectWindowsByProjectId.delete(projectId);
  }
  projectRootsByWindowId.delete(windowId);
  projectIdsByWindowId.delete(windowId);
  releaseProjectWindowByWindowId.delete(windowId);
  detachedProjectWindowLeaseIds.delete(windowId);
}
