import electron from 'electron';
import { join, resolve } from 'node:path';
import { autoUpdater } from 'electron-updater';
import { createDesktopStateStore } from './desktop-state/desktopStateStore.js';
import { createAxisCliManager, type AxisCliManager } from './axis-cli/axisCliManager.js';
import { createDesktopAppServer } from './app-server/createDesktopAppServer.js';
import { createHotExitStore, type HotExitStore } from './hot-exit/hotExitStore.js';
import { requestHotExitSnapshot as collectHotExitSnapshot } from './hot-exit/requestHotExitSnapshot.js';
import { resolveDesktopIntegrationEnvPath } from './integrationEnv.js';
import { registerWorkbenchIpc } from './ipc/registerWorkbenchIpc.js';
import { createApplicationMenuController } from './menu/registerApplicationMenu.js';
import {
  CANVAS_PREVIEW_PROTOCOL,
  PROJECT_FILE_PROTOCOL
} from './protocols/projectProtocols.js';
import { registerProjectFileProtocols } from './protocols/registerProjectProtocols.js';
import { createDesktopUpdateService, type DesktopUpdateService } from './update/updateService.js';

const { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } = electron;
const server = createDesktopAppServer({
  integrationEnvPath: resolveDesktopIntegrationEnvPath()
});
let hotExitStore: HotExitStore | undefined;
let updateService: DesktopUpdateService | undefined;
let axisCliManager: AxisCliManager | undefined;
const applicationMenu = createApplicationMenuController({
  menu: Menu,
  readDesktopState: () => desktopStateStore().readDesktopState(),
  chooseProjectRoot,
  openProject: async (projectRoot) => {
    const snapshot = await server.openProject(projectRoot);
    await rememberProjectRootAndRefreshMenu(projectRoot);
    broadcastDesktopEvent({ type: 'project.opened', snapshot });
  },
  clearRecentProjectRoots: async () => {
    await desktopStateStore().clearRecentProjectRoots();
  }
});

protocol.registerSchemesAsPrivileged([
  {
    scheme: PROJECT_FILE_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  },
  {
    scheme: CANVAS_PREVIEW_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

async function createWindow(): Promise<void> {
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

  if (!app.isPackaged) {
    await window.loadURL(process.env.VITE_DEV_SERVER_URL ?? 'http://127.0.0.1:5173');
  } else {
    await window.loadFile(resolve(__dirname, '../dist/index.html'));
  }
}

registerWorkbenchIpc({
  ipcMain,
  dialog,
  shell,
  server,
  platform: process.platform,
  axisCliManager: requireAxisCliManager,
  readDesktopState: loadDesktopStateFromStore,
  setSetupCompleted: (completed) => desktopStateStore().setSetupCompleted(completed),
  chooseProjectRoot,
  rememberProjectRoot: rememberProjectRootAndRefreshMenu,
  updateService: requireUpdateService,
  hotExitStore: requireHotExitStore
});

server.onEvent((event) => {
  broadcastDesktopEvent(event);
});

app.whenReady().then(async () => {
  registerProjectFileProtocols({ protocol, net, server });
  axisCliManager = createAxisCliManager({
    appVersion: app.getVersion(),
    homeDir: app.getPath('home'),
    packaged: app.isPackaged,
    ...(!app.isPackaged ? { repoRoot: resolve(__dirname, '../../..') } : {}),
    onStatusChange: (status) => broadcastDesktopEvent({ type: 'desktop.axisCli.changed', status }),
    ...(!app.isPackaged ? {
      releaseClient: {
        getLatestVersion: async () => undefined,
        installLatest: async () => {
          throw Object.assign(new Error('Release install is unavailable in development mode.'), { code: 'release_not_found' });
        }
      }
    } : {})
  });
  if (!app.isPackaged) {
    await axisCliManager.refreshDevelopmentLink();
  }
  hotExitStore = createHotExitStore(app.getPath('userData'));
  updateService = createDesktopUpdateService({
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    updater: autoUpdater,
    requestHotExitSnapshot: () => collectHotExitSnapshot({ browserWindows: BrowserWindow, ipcMain }),
    writeHotExitSnapshot: (snapshot) => requireHotExitStore().writeHotExitSnapshot(snapshot)
  });
  updateService.onStateChange((state) => broadcastDesktopEvent({ type: 'desktop.updateState.changed', state }));
  await applicationMenu.refreshApplicationMenu();
  await createWindow();
  setTimeout(() => {
    void updateService?.checkForUpdates(false);
  }, 3000);
});

function broadcastDesktopEvent(event: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('axis:event', event);
  }
}

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

async function chooseProjectRoot(): Promise<string | undefined> {
  const result = await dialog.showOpenDialog({
    title: 'Open AXIS Project',
    properties: ['openDirectory', 'createDirectory']
  });
  return result.canceled ? undefined : result.filePaths[0];
}

function loadDesktopStateFromStore() {
  return desktopStateStore().readDesktopState();
}

async function rememberProjectRootAndRefreshMenu(projectRoot: string): Promise<void> {
  await desktopStateStore().rememberProjectRoot(projectRoot);
  await applicationMenu.refreshApplicationMenu();
}

function desktopStateStore() {
  return createDesktopStateStore(app.getPath('userData'));
}

function requireUpdateService(): DesktopUpdateService {
  if (!updateService) {
    throw new Error('Desktop update service is not ready.');
  }
  return updateService;
}

function requireHotExitStore(): HotExitStore {
  if (!hotExitStore) {
    throw new Error('Desktop Hot Exit store is not ready.');
  }
  return hotExitStore;
}

function requireAxisCliManager(): AxisCliManager {
  if (!axisCliManager) {
    throw new Error('AXIS CLI manager is not ready.');
  }
  return axisCliManager;
}
