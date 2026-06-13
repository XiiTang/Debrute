import type { MenuItemConstructorOptions } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openProjectThroughDaemon, projectWebShellUrl } from '../apps/desktop/src/electron/daemonProjectOpen';
import { buildApplicationMenuTemplate } from '../apps/desktop/src/electron/menu/applicationMenu';

describe('desktop application menu', () => {
  it('puts project actions under a top-level File menu', () => {
    const template = buildApplicationMenuTemplate({
      recentProjectRoots: ['/tmp/alpha-project', '/tmp/beta-project'],
      onNewWindow: vi.fn(),
      onOpenProject: vi.fn(),
      onOpenRecentProject: vi.fn(),
      onClearRecentProjects: vi.fn()
    });

    const fileMenu = template.find((item) => item.label === 'File');
    expect(fileMenu).toBeDefined();

    const fileItems = fileMenu?.submenu as MenuItemConstructorOptions[];
    expect(fileItems.map((item) => item.label ?? item.role)).toContain('New Window');
    expect(fileItems.map((item) => item.label ?? item.role)).toContain('Open Project...');
    expect(fileItems.map((item) => item.label ?? item.role)).toContain('Open Project in New Window...');

    const openRecent = fileItems.find((item) => item.label === 'Open Recent');
    expect(openRecent).toBeDefined();

    const recentItems = openRecent?.submenu as MenuItemConstructorOptions[];
    expect(recentItems.map((item) => item.label ?? item.role)).toEqual([
      '/tmp/alpha-project',
      '/tmp/beta-project',
      undefined,
      'Clear Recent'
    ]);
  });

  it('keeps the recent-project submenu usable when there are no recents', () => {
    const template = buildApplicationMenuTemplate({
      recentProjectRoots: [],
      onNewWindow: vi.fn(),
      onOpenProject: vi.fn(),
      onOpenRecentProject: vi.fn(),
      onClearRecentProjects: vi.fn()
    });

    const fileMenu = template.find((item) => item.label === 'File');
    const fileItems = fileMenu?.submenu as MenuItemConstructorOptions[];
    const openRecent = fileItems.find((item) => item.label === 'Open Recent');
    const recentItems = openRecent?.submenu as MenuItemConstructorOptions[];

    expect(recentItems.map((item) => item.label ?? item.role)).toEqual([
      'No Recent Projects',
      undefined,
      'Clear Recent'
    ]);
    expect(recentItems[0]?.enabled).toBe(false);
    expect(recentItems[2]?.enabled).toBe(false);
  });

  it('forwards the source window and new-window intent from project menu actions', () => {
    const calls: Array<{ forceNewWindow: boolean; hasSourceWindow: boolean }> = [];
    const onNewWindow = vi.fn();
    const template = buildApplicationMenuTemplate({
      recentProjectRoots: ['/tmp/alpha-project'],
      onNewWindow,
      onOpenProject: (_sourceWindow, options) => calls.push({ forceNewWindow: options.forceNewWindow, hasSourceWindow: Boolean(_sourceWindow) }),
      onOpenRecentProject: (_projectRoot, _sourceWindow, options) => calls.push({ forceNewWindow: options.forceNewWindow, hasSourceWindow: Boolean(_sourceWindow) }),
      onClearRecentProjects: vi.fn()
    });
    const fileMenu = template.find((item) => item.label === 'File')!;
    const fileItems = fileMenu.submenu as MenuItemConstructorOptions[];
    const sourceWindow = { id: 7 } as Electron.BrowserWindow;

    fileItems.find((item) => item.label === 'New Window')!.click!(undefined as never, sourceWindow, undefined as never);
    fileItems.find((item) => item.label === 'Open Project...')!.click!(undefined as never, sourceWindow, undefined as never);
    fileItems.find((item) => item.label === 'Open Project in New Window...')!.click!(undefined as never, sourceWindow, undefined as never);
    const recentItems = fileItems.find((item) => item.label === 'Open Recent')!.submenu as MenuItemConstructorOptions[];
    recentItems[0]!.click!(undefined as never, sourceWindow, undefined as never);

    expect(calls).toEqual([
      { forceNewWindow: false, hasSourceWindow: true },
      { forceNewWindow: true, hasSourceWindow: true },
      { forceNewWindow: false, hasSourceWindow: true }
    ]);
    expect(onNewWindow).toHaveBeenCalledTimes(1);
  });

  it('provides native editing roles including speech controls', () => {
    const template = buildApplicationMenuTemplate({
      recentProjectRoots: [],
      onNewWindow: vi.fn(),
      onOpenProject: vi.fn(),
      onOpenRecentProject: vi.fn(),
      onClearRecentProjects: vi.fn()
    });

    const editMenu = template.find((item) => item.label === 'Edit');
    expect(editMenu).toBeDefined();

    const editItems = editMenu?.submenu as MenuItemConstructorOptions[];
    expect(editItems.map((item) => item.role)).toContain('copy');
    expect(editItems.map((item) => item.role)).toContain('selectAll');

    const speech = editItems.find((item) => item.label === 'Speech');
    const speechItems = speech?.submenu as MenuItemConstructorOptions[];
    expect(speechItems.map((item) => item.role)).toEqual(['startSpeaking', 'stopSpeaking']);
  });

  it('opens menu-selected projects through the daemon route', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const runtime = daemonRuntimeFixture();
    expect(projectWebShellUrl(runtime, '123e4567-e89b-42d3-a456-426614174000')).toBe(
      'http://127.0.0.1:17322/projects/123e4567-e89b-42d3-a456-426614174000?debrute-token=secret'
    );

    await expect(openProjectThroughDaemon(runtime, '/tmp/debrute-project', async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({
        projectId: '123e4567-e89b-42d3-a456-426614174000',
        snapshot: { canvases: [] }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    })).resolves.toEqual({
      projectId: '123e4567-e89b-42d3-a456-426614174000',
      url: 'http://127.0.0.1:17322/projects/123e4567-e89b-42d3-a456-426614174000?debrute-token=secret'
    });

    expect(requests).toEqual([{
      url: 'http://127.0.0.1:17321/api/projects/open',
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-debrute-daemon-token': 'secret'
        },
        body: JSON.stringify({ projectRoot: '/tmp/debrute-project' })
      }
    }]);
  });

  it('keeps Electron main from opening menu projects directly through app-server', () => {
    const main = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/main.ts'), 'utf8');

    expect(main).toContain('openProjectFromShell');
    expect(main).toContain('requireRuntimeClient().openProject(projectRoot)');
    expect(main).not.toContain('const appServer = new DebruteAppServer');
    expect(main).not.toContain('appServer.openProject(projectRoot)');
  });

  it('keeps Electron project windows scoped by daemon project id', () => {
    const main = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/main.ts'), 'utf8');

    expect(main).toContain('projectWindowsByProjectId');
    expect(main).toContain('registerElectronProjectWindow');
    expect(main).toContain("ipcMain.handle('debrute-shell:openProject'");
    expect(main).toContain("ipcMain.handle('debrute-shell:bindProjectWindowToProject'");
    expect(main).toContain('BrowserWindow.fromWebContents');
    expect(main).not.toContain('loadProjectRouteInShell');
    expect(main).not.toContain('Promise.all(windows.map((window) => window.loadURL(url)))');
  });

  it('waits for the Workbench URL before loading Electron windows', () => {
    const main = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/main.ts'), 'utf8');

    expect(main).toContain('waitForDebruteShellUrl');
    expect(main.indexOf('await waitForDebruteShellUrl(urlToLoad)')).toBeLessThan(main.indexOf('await window.loadURL(urlToLoad)'));
  });

  it('syncs desktop project history to native recent project surfaces', () => {
    const main = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/main.ts'), 'utf8');

    expect(main).toContain('syncNativeRecentProjects');
    expect(main).toContain("app.on('open-file'");
    expect(main).toContain("app.on('second-instance'");
    expect(main).toContain('parseDesktopOpenIntent');
  });

  it('does not host the daemon inside Electron main', () => {
    const main = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/main.ts'), 'utf8');

    expect(main).not.toContain('createDebruteDaemonHttpServer');
    expect(main).not.toContain('createHostedDesktopRuntimeClient');
    expect(main).not.toContain("process.env.DEBRUTE_WORKBENCH_RUNTIME_MODE === 'hosted'");
    expect(main).not.toContain('createElectronNativeShell');
  });

  it('keeps Explorer file operations out of the preload shell API', () => {
    const preload = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/preload.ts'), 'utf8');

    expect(preload).not.toContain('revealProjectPathInSystemFileManager');
    expect(preload).not.toContain('trashProjectPath');
    expect(preload).toContain('getDroppedFilePath');
    expect(preload).toContain('webUtils.getPathForFile');
    expect(preload).toContain('chooseProjectRoot');
    expect(preload).toContain('openProject');
    expect(preload).toContain('bindProjectWindowToProject');
  });

  it('uses RuntimeSupervisor and attached runtime client', () => {
    const main = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/main.ts'), 'utf8');

    expect(main).toContain('new RuntimeSupervisor');
    expect(main).toContain('createAttachedDesktopRuntimeClient');
    expect(main).toContain('new TrayController');
    expect(main).toContain('runtimeSupervisor.stopOwnedRuntime()');
    expect(main).toContain('await rememberProjectRootAndRefreshMenu(projectRoot)');
    expect(main).not.toContain('hostedDaemon');
    expect(main).not.toContain('desktopStateStore:');
  });

  it('reopens project windows by project root after a runtime restart', () => {
    const main = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/main.ts'), 'utf8');
    const restartBody = main.slice(
      main.indexOf('async function restartRuntimeAndReloadWindows'),
      main.indexOf('async function showRuntimeStatus')
    );

    expect(main).toContain('projectRootsByWindowId');
    expect(restartBody).toContain('detachProjectWindowLeasesFromStoppedRuntime()');
    expect(restartBody).not.toContain('clearProjectWindowBindings()');
    expect(restartBody).toContain('const projectRoot = projectRootsByWindowId.get(window.id)');
    expect(restartBody).toContain('await runtimeClient.openProject(projectRoot)');
    expect(restartBody).not.toContain('shellUrl(projectId)');
    expect(restartBody).not.toContain('bindProjectWindow(window, projectId)');
  });

  it('keeps stale renderer project bind IPC from hitting the new runtime during restart', () => {
    const main = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/main.ts'), 'utf8');

    expect(main).toContain('function detachProjectWindowLeasesFromStoppedRuntime(): void');
    expect(main).toContain('releaseProjectWindowByWindowId.delete(windowId)');
    expect(main).toContain('detachedProjectWindowLeaseIds.add(windowId)');
    expect(main).toContain('detachedProjectWindowLeaseIds.delete(windowId)');
    expect(main).toContain('function dropProjectWindowBinding(windowId: number): void');
  });

  it('creates the Runtime Status tray before runtime startup can fail', () => {
    const main = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/main.ts'), 'utf8');

    expect(main.indexOf('new TrayController')).toBeGreaterThanOrEqual(0);
    expect(main.indexOf('await runtimeSupervisor.start()')).toBeGreaterThanOrEqual(0);
    expect(main.indexOf('new TrayController')).toBeLessThan(main.indexOf('await runtimeSupervisor.start()'));
    expect(main).toContain('catch (error)');
    expect(main).toContain('await refreshTray()');
  });

  it('keeps the app alive when windows close and routes true quit through owned runtime shutdown', () => {
    const main = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/main.ts'), 'utf8');

    expect(main).toContain("app.on('window-all-closed'");
    expect(main).not.toContain("if (process.platform !== 'darwin') {\n    app.quit();\n  }");
    expect(main).toContain('requestTrueQuit');
    expect(main).toContain("window.on('close'");
  });
});

function daemonRuntimeFixture() {
  return {
    daemonUrl: 'http://127.0.0.1:17321',
    webBaseUrl: 'http://127.0.0.1:17322',
    platform: 'darwin',
    token: 'secret'
  };
}
