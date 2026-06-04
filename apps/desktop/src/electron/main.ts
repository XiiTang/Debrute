import { randomUUID } from 'node:crypto';
import electron from 'electron';
import { join, resolve } from 'node:path';
import { createAxisDaemonHttpServer, type AxisDaemonHttpServer, type AxisDaemonRuntime } from '@axis/daemon';
import {
  deleteWorkbenchRuntimeState,
  ensureRegisteredWorkbenchRuntime,
  readWorkbenchRuntimeState,
  type WorkbenchRuntimePaths,
  type WorkbenchRuntimeState
} from '@axis/workbench-runtime';
import { createDesktopStateStore, type DesktopState } from './desktop-state/desktopStateStore.js';
import {
  createAttachedDesktopRuntimeClient,
  createHostedDesktopRuntimeClient,
  type DesktopRuntimeClient
} from './desktopRuntimeClient.js';
import { resolveDesktopIntegrationEnvPath } from './integrationEnv.js';
import { createApplicationMenuController } from './menu/registerApplicationMenu.js';

const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = electron;
let hostedDaemon: AxisDaemonHttpServer | undefined;
let runtimeClient: DesktopRuntimeClient | undefined;
let hostedRuntimeState: WorkbenchRuntimeState | undefined;
let hostedRuntimeStatePath: string | undefined;
const projectWindowsByProjectId = new Map<string, Electron.BrowserWindow>();
const projectIdsByWindowId = new Map<number, string>();
const releaseProjectWindowByWindowId = new Map<number, () => void>();

const applicationMenu = createApplicationMenuController({
  menu: Menu,
  readDesktopState: () => desktopStateStore().readDesktopState(),
  chooseProjectRoot,
  openProject: async (projectRoot) => {
    await openProjectFromShell(projectRoot);
  },
  clearRecentProjectRoots: async () => {
    await desktopStateStore().clearRecentProjectRoots();
  }
});

async function createWindow(initialUrl?: string, projectId?: string): Promise<Electron.BrowserWindow> {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1100,
    minHeight: 720,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#151616',
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
  if (projectId) {
    bindProjectWindow(window, projectId);
  }
  await window.loadURL(initialUrl ?? client.shellUrl());
  return window;
}

app.whenReady().then(async () => {
  runtimeClient = await createDesktopRuntimeClient();
  registerShellIpc();
  await applicationMenu.refreshApplicationMenu();
  await createWindow();
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
  ipcMain.handle('axis-shell:chooseProjectRoot', async (event) => (
    chooseProjectRoot(BrowserWindow.fromWebContents(event.sender) ?? undefined)
  ));
  ipcMain.handle('axis-shell:bindProjectWindowToProject', (event, input: { projectId: string }) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      throw new Error('AXIS project window is not available.');
    }
    bindProjectWindow(window, input.projectId);
    return { ok: true };
  });
  ipcMain.handle('axis-shell:revealProjectPathInSystemFileManager', async (_event, input: {
    projectId: string;
    projectRelativePath: string;
    kind: 'file' | 'directory';
  }) => {
    const absolutePath = await requireRuntimeClient().resolveProjectPath(input.projectId, input.projectRelativePath, input.kind);
    if (input.kind === 'directory') {
      await shell.openPath(absolutePath);
    } else {
      shell.showItemInFolder(absolutePath);
    }
    return { ok: true };
  });
}

async function chooseProjectRoot(parentWindow?: Electron.BrowserWindow): Promise<string | undefined> {
  const options: Electron.OpenDialogOptions = {
    title: 'Open AXIS Project',
    properties: ['openDirectory', 'createDirectory']
  };
  const result = parentWindow && !parentWindow.isDestroyed()
    ? await dialog.showOpenDialog(parentWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? undefined : result.filePaths[0];
}

async function rememberProjectRootAndRefreshMenu(projectRoot: string): Promise<DesktopState> {
  const desktopState = await desktopStateStore().rememberProjectRoot(projectRoot);
  await applicationMenu.refreshApplicationMenu();
  return desktopState;
}

async function openProjectFromShell(projectRoot: string): Promise<void> {
  const opened = await requireRuntimeClient().openProject(projectRoot);
  await rememberProjectRootAndRefreshMenu(projectRoot);
  const existingWindow = projectWindowsByProjectId.get(opened.projectId);
  if (existingWindow && !existingWindow.isDestroyed()) {
    existingWindow.focus();
    return;
  }
  await createWindow(opened.url, opened.projectId);
}

function desktopStateStore() {
  return createDesktopStateStore(app.getPath('userData'));
}

function requireRuntimeClient(): DesktopRuntimeClient {
  if (!runtimeClient) {
    throw new Error('AXIS desktop runtime client is not ready.');
  }
  return runtimeClient;
}

async function createDesktopRuntimeClient(): Promise<DesktopRuntimeClient> {
  if (process.env.AXIS_WORKBENCH_RUNTIME_MODE === 'attached') {
    return createAttachedDesktopRuntimeClient({
      daemonUrl: requireEnv('AXIS_DAEMON_URL'),
      webBaseUrl: requireEnv('AXIS_WEB_URL'),
      token: requireEnv('AXIS_DAEMON_TOKEN')
    });
  }
  if (process.env.AXIS_WORKBENCH_RUNTIME_MODE === 'hosted') {
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

async function startHostedDesktopDaemon(): Promise<AxisDaemonRuntime> {
  const token = process.env.AXIS_DAEMON_TOKEN ?? randomUUID();
  hostedDaemon = createAxisDaemonHttpServer({
    appServerOptions: {
      integrationEnvPath: resolveDesktopIntegrationEnvPath()
    },
    host: '127.0.0.1',
    port: process.env.AXIS_DAEMON_PORT ? Number(process.env.AXIS_DAEMON_PORT) : 0,
    token,
    webBaseUrl: process.env.AXIS_WEB_URL ?? null,
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
  return process.env.AXIS_WORKBENCH_RUNTIME_KIND === 'desktop-dev'
    ? 'desktop-dev'
    : 'desktop-packaged';
}

function requireHostedDaemon(): AxisDaemonHttpServer {
  if (!hostedDaemon) {
    throw new Error('AXIS hosted daemon is not ready.');
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
