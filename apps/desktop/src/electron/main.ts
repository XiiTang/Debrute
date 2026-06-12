import { randomUUID } from 'node:crypto';
import electron from 'electron';
import { join, resolve } from 'node:path';
import { createDebruteDaemonHttpServer, type DebruteDaemonHttpServer, type DebruteDaemonRuntime } from '@debrute/daemon';
import {
  deleteWorkbenchRuntimeState,
  ensureRegisteredWorkbenchRuntime,
  readWorkbenchRuntimeState,
  type WorkbenchRuntimePaths,
  type WorkbenchRuntimeState
} from '@debrute/workbench-runtime';
import { createDesktopStateStore, type DesktopState } from './desktop-state/desktopStateStore.js';
import {
  createAttachedDesktopRuntimeClient,
  createHostedDesktopRuntimeClient,
  type DesktopRuntimeClient
} from './desktopRuntimeClient.js';
import { createDebruteCliInstaller } from './debruteCliInstaller.js';
import { registerDebruteCliShellIpc } from './debruteCliShell.js';
import { loadDebruteProjectShellWindow, waitForDebruteShellUrl } from './desktopShellLoad.js';
import { createElectronNativeShell } from './electronNativeShell.js';
import { resolveDesktopIntegrationEnvPath } from './integrationEnv.js';
import { createApplicationMenuController } from './menu/registerApplicationMenu.js';
import { parseDesktopOpenIntent, syncNativeRecentProjects, type DesktopOpenIntent } from './nativeRecentProjects.js';
import { runProjectWindowOpenOnce, selectProjectWindowOpenTarget } from './windowProjectRouting.js';

const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = electron;
let hostedDaemon: DebruteDaemonHttpServer | undefined;
let runtimeClient: DesktopRuntimeClient | undefined;
let hostedRuntimeState: WorkbenchRuntimeState | undefined;
let hostedRuntimeStatePath: string | undefined;
const projectWindowsByProjectId = new Map<string, Electron.BrowserWindow>();
const projectIdsByWindowId = new Map<number, string>();
const releaseProjectWindowByWindowId = new Map<number, () => void>();
const pendingProjectWindowOpens = new Map<string, Promise<void>>();
const pendingDesktopOpenIntents: DesktopOpenIntent[] = [];

if (!app.requestSingleInstanceLock()) {
  app.quit();
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
      sourceWindow,
      forceNewWindow: options.forceNewWindow
    });
  },
  clearRecentProjectRoots: async () => {
    const desktopState = await desktopStateStore().clearRecentProjectRoots();
    syncDesktopProjectHistory(desktopState);
  }
});
const projectIconPath = join(__dirname, 'icon.png');
const dockIconPath = join(__dirname, 'dock_icon.png');

async function createWindow(initialUrl?: string, projectId?: string): Promise<Electron.BrowserWindow> {
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

  const client = requireRuntimeClient();
  window.once('closed', () => {
    releaseProjectWindow(window.id);
  });
  const urlToLoad = initialUrl ?? client.shellUrl();
  if (projectId) {
    await loadDebruteProjectShellWindow(window, urlToLoad, () => {
      bindProjectWindow(window, projectId);
    });
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
  runtimeClient = await createDesktopRuntimeClient();
  registerShellIpc();
  syncDesktopProjectHistory(await desktopStateStore().readDesktopState());
  await applicationMenu.refreshApplicationMenu();
  const initialIntent = parseDesktopOpenIntent(process.argv);
  if (initialIntent) {
    await handleDesktopOpenIntent(initialIntent);
  } else if (pendingDesktopOpenIntents.length === 0) {
    await createWindow();
  }
  await flushPendingDesktopOpenIntents();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

app.on('before-quit', () => {
  void closeDesktopRuntime();
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
      sourceWindow,
      forceNewWindow: input.forceNewWindow === true
    });
    return { opened: true };
  });
  ipcMain.handle('debrute-shell:bindProjectWindowToProject', (event, input: { projectId: string }) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      throw new Error('Debrute project window is not available.');
    }
    bindProjectWindow(window, input.projectId);
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
    open: () => openProjectInWindow(opened, options),
    reusePending: () => {
      projectWindowsByProjectId.get(opened.projectId)?.focus();
    }
  });
}

async function openProjectInWindow(
  opened: { projectId: string; url: string },
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
    sourceWindowId: options.sourceWindow?.id,
    forceNewWindow: options.forceNewWindow === true,
    windowIdByProjectId,
    liveWindowIds
  });
  if (target.kind === 'focus') {
    BrowserWindow.fromId(target.windowId)?.focus();
    return;
  }
  if (target.kind === 'reuse') {
    const window = BrowserWindow.fromId(target.windowId);
    if (window && !window.isDestroyed()) {
      await loadDebruteProjectShellWindow(window, opened.url, () => {
        bindProjectWindow(window, opened.projectId);
      });
      window.focus();
      return;
    }
  }
  await createWindow(opened.url, opened.projectId);
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

async function createDesktopRuntimeClient(): Promise<DesktopRuntimeClient> {
  if (process.env.DEBRUTE_WORKBENCH_RUNTIME_MODE === 'attached') {
    return createAttachedDesktopRuntimeClient({
      daemonUrl: requireEnv('DEBRUTE_DAEMON_URL'),
      webBaseUrl: requireEnv('DEBRUTE_WEB_URL'),
      token: requireEnv('DEBRUTE_DAEMON_TOKEN')
    });
  }
  if (process.env.DEBRUTE_WORKBENCH_RUNTIME_MODE === 'hosted') {
    await startHostedDesktopDaemon();
    return createHostedDesktopRuntimeClient(requireHostedDaemon());
  }
  const registryResult = await ensureRegisteredWorkbenchRuntime({
    launch: launchPackagedDesktopRuntime,
    onRuntimeLaunchFailed: () => {
      void hostedDaemon?.close();
    }
  });
  if (!registryResult.runtimeStarted) {
    return createAttachedDesktopRuntimeClient({
      daemonUrl: registryResult.state.daemonUrl,
      webBaseUrl: registryResult.state.webUrl,
      token: registryResult.state.token
    });
  }
  hostedRuntimeState = registryResult.state;
  hostedRuntimeStatePath = registryResult.statePath;
  return createHostedDesktopRuntimeClient(requireHostedDaemon());
}

async function startHostedDesktopDaemon(): Promise<DebruteDaemonRuntime> {
  const token = process.env.DEBRUTE_DAEMON_TOKEN ?? randomUUID();
  hostedDaemon = createDebruteDaemonHttpServer({
    appServerOptions: {
      integrationEnvPath: resolveDesktopIntegrationEnvPath()
    },
    host: '127.0.0.1',
    port: process.env.DEBRUTE_DAEMON_PORT ? Number(process.env.DEBRUTE_DAEMON_PORT) : 0,
    token,
    nativeShell: createElectronNativeShell(shell),
    webBaseUrl: process.env.DEBRUTE_WEB_URL ?? null,
    webDistDir: resolve(__dirname, '../dist')
  });
  return hostedDaemon.listen();
}

async function launchPackagedDesktopRuntime(paths: WorkbenchRuntimePaths): Promise<WorkbenchRuntimeState> {
  const runtime = await startHostedDesktopDaemon();
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    runtimeKind: desktopRuntimeKind(),
    processControl: 'external',
    daemonUrl: runtime.daemonUrl,
    webUrl: runtime.webBaseUrl ?? runtime.daemonUrl,
    token: runtime.token,
    daemonPid: process.pid,
    daemonLogPath: paths.daemonLogPath,
    webLogPath: paths.webLogPath,
    startedAt: now,
    updatedAt: now
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function desktopRuntimeKind(): 'desktop-dev' | 'desktop-packaged' {
  return process.env.DEBRUTE_WORKBENCH_RUNTIME_KIND === 'desktop-dev'
    ? 'desktop-dev'
    : 'desktop-packaged';
}

function requireHostedDaemon(): DebruteDaemonHttpServer {
  if (!hostedDaemon) {
    throw new Error('Debrute hosted daemon is not ready.');
  }
  return hostedDaemon;
}

async function closeDesktopRuntime(): Promise<void> {
  await runtimeClient?.close();
  await deleteHostedRuntimeState();
}

async function deleteHostedRuntimeState(): Promise<void> {
  if (!hostedRuntimeState || !hostedRuntimeStatePath) {
    return;
  }
  const current = await readWorkbenchRuntimeState(hostedRuntimeStatePath).catch(() => undefined);
  if (
    current?.daemonUrl === hostedRuntimeState.daemonUrl
    && current.webUrl === hostedRuntimeState.webUrl
    && current.token === hostedRuntimeState.token
  ) {
    await deleteWorkbenchRuntimeState(hostedRuntimeStatePath);
  }
}

function bindProjectWindow(window: Electron.BrowserWindow, projectId: string): void {
  const currentProjectId = projectIdsByWindowId.get(window.id);
  if (currentProjectId === projectId && releaseProjectWindowByWindowId.has(window.id)) {
    return;
  }
  releaseProjectWindow(window.id);
  const release = requireRuntimeClient().registerElectronProjectWindow(projectId, window.id);
  projectWindowsByProjectId.set(projectId, window);
  projectIdsByWindowId.set(window.id, projectId);
  releaseProjectWindowByWindowId.set(window.id, release);
}

function releaseProjectWindow(windowId: number): void {
  const projectId = projectIdsByWindowId.get(windowId);
  if (projectId && projectWindowsByProjectId.get(projectId)?.id === windowId) {
    projectWindowsByProjectId.delete(projectId);
  }
  projectIdsByWindowId.delete(windowId);
  releaseProjectWindowByWindowId.get(windowId)?.();
  releaseProjectWindowByWindowId.delete(windowId);
}
