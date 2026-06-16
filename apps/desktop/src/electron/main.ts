import { randomUUID } from 'node:crypto';
import electron from 'electron';
import { join } from 'node:path';
import { createDesktopStateStore, type DesktopState } from './desktop-state/desktopStateStore.js';
import { createAttachedDesktopRuntimeClient, type DesktopRuntimeClient } from './desktopRuntimeClient.js';
import { createDebruteCliInstaller } from './debruteCliInstaller.js';
import { registerDebruteCliShellIpc } from './debruteCliShell.js';
import { loadDebruteProjectShellWindow, waitForDebruteShellUrl } from './desktopShellLoad.js';
import { createApplicationMenuController } from './menu/registerApplicationMenu.js';
import { parseDesktopOpenIntent, syncNativeRecentProjects, type DesktopOpenIntent } from './nativeRecentProjects.js';
import { RuntimeSupervisor } from './runtime/runtimeSupervisor.js';
import { TrayController } from './tray/trayController.js';
import { runProjectWindowOpenOnce, selectProjectWindowOpenTarget } from './windowProjectRouting.js';

const { app, BrowserWindow, dialog, ipcMain, Menu } = electron;
let runtimeSupervisor: RuntimeSupervisor | undefined;
let runtimeClient: DesktopRuntimeClient | undefined;
let trayController: TrayController | undefined;
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
  readDesktopState: () => desktopStateStore().readDesktopState(),
  chooseProjectRoot,
  newWindow: async () => {
    await createWindow();
  },
  openProject: async (projectRoot, sourceWindow, options) => {
    await openProjectFromShell(projectRoot, {
      forceNewWindow: options.forceNewWindow,
      ...(sourceWindow ? { sourceWindow } : {})
    });
  },
  clearRecentProjectRoots: async () => {
    const desktopState = await desktopStateStore().clearRecentProjectRoots();
    syncDesktopProjectHistory(desktopState);
    await refreshTray();
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
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#151616',
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
    readRecentProjectRoots: async () => (await desktopStateStore().readDesktopState()).recentProjectRoots,
    actions: {
      openDebrute: () => {
        void openDebruteRootWindow();
      },
      openRecent: (projectRoot) => {
        void openProjectFromShell(projectRoot, { forceNewWindow: false });
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
  registerShellIpc();
  syncDesktopProjectHistory(await desktopStateStore().readDesktopState());
  await applicationMenu.refreshApplicationMenu();
  try {
    const runtimeState = await runtimeSupervisor.start();
    runtimeClient = createAttachedDesktopRuntimeClient({
      daemonUrl: runtimeState.daemonUrl,
      webBaseUrl: runtimeState.webUrl,
      token: runtimeState.token,
      platform: process.platform
    });
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
  ipcMain.handle('debrute-shell:chooseProjectRoot', async (event) => (
    chooseProjectRoot(BrowserWindow.fromWebContents(event.sender) ?? undefined)
  ));
  ipcMain.handle('debrute-shell:openProject', async (event, input: { forceNewWindow?: boolean } = {}) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const selectedRoot = await chooseProjectRoot(sourceWindow);
    if (!selectedRoot) {
      return { opened: false };
    }
    await openProjectFromShell(selectedRoot, {
      forceNewWindow: input.forceNewWindow === true,
      ...(sourceWindow ? { sourceWindow } : {})
    });
    return { opened: true };
  });
  ipcMain.handle('debrute-shell:bindProjectWindowToProject', async (event, input: { projectId: string }) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      throw new Error('Debrute project window is not available.');
    }
    await bindProjectWindow(window, input.projectId);
    return { ok: true };
  });
  registerDebruteCliShellIpc({
    ipcMain,
    installer: createDebruteCliInstaller({
      desktopVersion: app.getVersion(),
      userHome: app.getPath('home')
    })
  });
}

async function chooseProjectRoot(parentWindow?: Electron.BrowserWindow): Promise<string | undefined> {
  const options: Electron.OpenDialogOptions = {
    title: 'Open Debrute Project',
    properties: ['openDirectory', 'createDirectory']
  };
  const result = parentWindow && !parentWindow.isDestroyed()
    ? await dialog.showOpenDialog(parentWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? undefined : result.filePaths[0];
}

async function rememberProjectRootAndRefreshMenu(projectRoot: string): Promise<DesktopState> {
  const desktopState = await desktopStateStore().rememberProjectRoot(projectRoot);
  syncDesktopProjectHistory(desktopState);
  await applicationMenu.refreshApplicationMenu();
  await refreshTray();
  return desktopState;
}

function syncDesktopProjectHistory(desktopState: DesktopState): void {
  syncNativeRecentProjects(app, process.platform, process.execPath, desktopState.recentProjectRoots);
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
  await openProjectFromShell(intent.projectRoot, { forceNewWindow: false });
}

async function flushPendingDesktopOpenIntents(): Promise<void> {
  while (pendingDesktopOpenIntents.length > 0) {
    await handleDesktopOpenIntent(pendingDesktopOpenIntents.shift());
  }
}

async function openProjectFromShell(
  projectRoot: string,
  options: { sourceWindow?: Electron.BrowserWindow; forceNewWindow?: boolean } = {}
): Promise<void> {
  const opened = await requireRuntimeClient().openProject(projectRoot);
  await rememberProjectRootAndRefreshMenu(projectRoot);
  await runProjectWindowOpenOnce({
    projectId: opened.projectId,
    pendingProjectOpens: pendingProjectWindowOpens,
    open: () => openProjectInWindow({ ...opened, projectRoot }, options),
    reusePending: () => {
      projectWindowsByProjectId.get(opened.projectId)?.focus();
    }
  });
}

async function openProjectInWindow(
  opened: { projectId: string; url: string; projectRoot: string },
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

function desktopStateStore() {
  return createDesktopStateStore(app.getPath('userData'));
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
  await refreshTray();
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
        }
      },
      rollback: () => undefined
    };
  }
  const release = await requireRuntimeClient().registerElectronProjectWindow(projectId, window.id);
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
      if (projectRoot) {
        projectRootsByWindowId.set(window.id, projectRoot);
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
