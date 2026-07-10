import type { MenuItemConstructorOptions } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildWorkbenchTitleBarState } from '@debrute/app-protocol';
import { openProjectFromPickerThroughDaemon, openProjectThroughDaemon, projectWebShellNavigation } from '../apps/desktop/src/electron/daemonProjectOpen';
import { buildApplicationMenuTemplate } from '../apps/desktop/src/electron/menu/applicationMenu';
import { createApplicationMenuController } from '../apps/desktop/src/electron/menu/registerApplicationMenu';

describe('desktop application menu', () => {
  it('puts project actions under a top-level File menu', () => {
    const template = buildApplicationMenuTemplate({
      state: buildWorkbenchTitleBarState({
        platform: 'darwin',
        host: 'desktop',
        projectTitle: 'Debrute',
        recentProjectRoots: ['/tmp/alpha-project', '/tmp/beta-project']
      }),
      onCommand: vi.fn()
    });

    expect(template.find((item) => item.label === 'Debrute')).toBeDefined();
    expect(template.find((item) => item.label === 'File')).toBeDefined();
    expect(template.find((item) => item.label === 'Edit')).toBeDefined();
    expect(template.find((item) => item.label === 'View')).toBeDefined();

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
      '/tmp/beta-project'
    ]);
  });

  it('keeps the recent-project submenu disabled when there are no recents', () => {
    const template = buildApplicationMenuTemplate({
      state: buildWorkbenchTitleBarState({
        platform: 'darwin',
        host: 'desktop',
        recentProjectRoots: []
      }),
      onCommand: vi.fn()
    });

    const fileMenu = template.find((item) => item.label === 'File');
    const fileItems = fileMenu?.submenu as MenuItemConstructorOptions[];
    const openRecent = fileItems.find((item) => item.label === 'Open Recent');
    const recentItems = openRecent?.submenu as MenuItemConstructorOptions[];

    expect(openRecent?.enabled).toBe(false);
    expect(fileItems.find((item) => item.label === 'Clear Recent')?.enabled).toBe(false);
    expect(recentItems.map((item) => item.label ?? item.role)).toEqual(['No Recent Projects']);
    expect(recentItems[0]?.enabled).toBe(false);
  });

  it('forwards shared command ids from project menu actions', () => {
    const commands: Array<{ commandId: string; projectRoot?: string }> = [];
    const template = buildApplicationMenuTemplate({
      state: buildWorkbenchTitleBarState({
        platform: 'darwin',
        host: 'desktop',
        recentProjectRoots: ['/tmp/alpha-project']
      }),
      onCommand: (_sourceWindow, command) => commands.push({
        commandId: command.commandId,
        projectRoot: typeof command.payload?.projectRoot === 'string' ? command.payload.projectRoot : undefined
      })
    });
    const fileMenu = template.find((item) => item.label === 'File')!;
    const fileItems = fileMenu.submenu as MenuItemConstructorOptions[];
    const sourceWindow = { id: 7 } as Electron.BrowserWindow;

    fileItems.find((item) => item.label === 'New Window')!.click!(undefined as never, sourceWindow, undefined as never);
    fileItems.find((item) => item.label === 'Open Project...')!.click!(undefined as never, sourceWindow, undefined as never);
    fileItems.find((item) => item.label === 'Open Project in New Window...')!.click!(undefined as never, sourceWindow, undefined as never);
    const recentItems = fileItems.find((item) => item.label === 'Open Recent')!.submenu as MenuItemConstructorOptions[];
    recentItems[0]!.click!(undefined as never, sourceWindow, undefined as never);

    expect(commands).toEqual([
      { commandId: 'window.new' },
      { commandId: 'project.open-picker' },
      { commandId: 'project.open-picker-new-window' },
      { commandId: 'project.open-recent', projectRoot: '/tmp/alpha-project' }
    ]);
  });

  it('provides native editing roles including speech controls', () => {
    const template = buildApplicationMenuTemplate({
      state: buildWorkbenchTitleBarState({
        platform: 'darwin',
        host: 'desktop',
        recentProjectRoots: []
      }),
      onCommand: vi.fn()
    });

    const editMenu = template.find((item) => item.label === 'Edit');
    expect(editMenu).toBeDefined();

    const editItems = editMenu?.submenu as MenuItemConstructorOptions[];
    expect(editItems.map((item) => item.role).filter(Boolean)).toEqual([
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
      'pasteAndMatchStyle',
      'delete',
      'selectAll',
      'startSpeaking',
      'stopSpeaking'
    ]);
    for (const item of editItems) {
      if (item.role) {
        expect(item.click).toBeUndefined();
      }
    }
  });

  it('does not synthesize enabled native menus when runtime title-bar state is unavailable', async () => {
    const templates: MenuItemConstructorOptions[][] = [];
    const setApplicationMenu = vi.fn();
    const controller = createApplicationMenuController({
      platform: 'darwin',
      menu: {
        buildFromTemplate: (template) => {
          templates.push(template);
          return {} as Electron.Menu;
        },
        setApplicationMenu
      },
      readTitleBarState: async () => undefined,
      onCommand: vi.fn()
    });

    await controller.refreshApplicationMenu();

    expect(templates).toHaveLength(1);
    expect(templates[0]?.map((item) => item.label)).toEqual(['Debrute']);
    expect(setApplicationMenu).toHaveBeenCalledTimes(1);
  });

  it('opens menu-selected projects through the daemon route', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const runtime = daemonRuntimeFixture();
    expectWorkbenchNavigation(
      projectWebShellNavigation(runtime, '123e4567-e89b-42d3-a456-426614174000'),
      '/projects/123e4567-e89b-42d3-a456-426614174000'
    );

    const opened = await openProjectThroughDaemon(runtime, '/tmp/debrute-project', async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({
        projectId: '123e4567-e89b-42d3-a456-426614174000',
        snapshot: { canvases: [] }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    expect(opened.projectId).toBe('123e4567-e89b-42d3-a456-426614174000');
    expectWorkbenchNavigation(opened.navigation, '/projects/123e4567-e89b-42d3-a456-426614174000');

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

  it('opens menu picker projects through the daemon picker route', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const runtime = daemonRuntimeFixture();

    const opened = await openProjectFromPickerThroughDaemon(runtime, async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({
        opened: true,
        projectId: '123e4567-e89b-42d3-a456-426614174000',
        projectRevision: 1,
        snapshot: { canvases: [] }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    expect(opened).toMatchObject({
      opened: true,
      projectId: '123e4567-e89b-42d3-a456-426614174000'
    });
    if (opened.opened) {
      expectWorkbenchNavigation(opened.navigation, '/projects/123e4567-e89b-42d3-a456-426614174000');
    }

    expect(requests).toEqual([{
      url: 'http://127.0.0.1:17321/api/projects/open-picker',
      init: {
        method: 'POST',
        headers: { 'x-debrute-daemon-token': 'secret' }
      }
    }]);
  });

  it('keeps Electron main from opening menu projects directly through app-server', () => {
    const main = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/main.ts'), 'utf8');

    expect(main).toContain('openProjectFromPickerFromShell');
    expect(main).toContain('requireRuntimeClient().openProjectFromPicker()');
    expect(main).toContain('openProjectRootFromDesktop(projectRoot');
    expect(main).toContain('requireRuntimeClient().openProject(projectRoot)');
    expect(main).not.toContain('const appServer = new DebruteAppServer');
    expect(main).not.toContain('appServer.openProject(projectRoot)');
  });

  it('routes desktop startup and tray default actions through runtime default frontend', () => {
    const main = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/main.ts'), 'utf8');
    const defaultFrontend = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/defaultFrontend.ts'), 'utf8');

    expect(main).toContain('async function executeDefaultFrontend(source: string)');
    expect(main).toContain('executeConfiguredDefaultFrontend');
    expect(defaultFrontend).toContain("settings.workbench.defaultFrontend === 'browser'");
    expect(main).toContain('await shell.openExternal(requireRuntimeClient().browserLaunchUrl())');
    expect(main).toContain('clipboard.writeText(requireRuntimeClient().browserLaunchUrl())');
    expect(main).toContain("void executeDefaultFrontend('tray-open-debrute');");
    expect(main).toContain("await executeDefaultFrontend('startup');");
    expect(main).not.toContain('await createWindow();\n  }\n  await flushPendingDesktopOpenIntents();');
  });

  it('keeps Electron project windows scoped by daemon project id', () => {
    const main = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/main.ts'), 'utf8');

    expect(main).toContain('projectWindowsByProjectId');
    expect(main).toContain('registerElectronProjectWindow');
    expect(main).toContain("ipcMain.handle('debrute-shell:bindProjectWindowToProject'");
    expect(main).toContain('BrowserWindow.fromWebContents');
    expect(main).not.toContain('loadProjectRouteInShell');
    expect(main).not.toContain('Promise.all(windows.map((window) => window.loadURL(url)))');
  });

  it('waits for the Workbench URL before loading Electron windows', () => {
    const main = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/main.ts'), 'utf8');

    expect(main).toContain('waitForDebruteShellUrl');
    expect(main.indexOf('await waitForDebruteShellUrl(navigation.readyUrl)')).toBeLessThan(main.indexOf('await window.loadURL(navigation.loadUrl)'));
  });

  it('syncs desktop project history from a narrow title-bar source', () => {
    const main = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/main.ts'), 'utf8');

    expect(main).toContain('syncNativeRecentProjects');
    expect(main).toContain("app.on('open-file'");
    expect(main).toContain("app.on('second-instance'");
    expect(main).toContain('parseDesktopOpenIntent');
    expect(main).toContain('(await runtimeClient.getWorkbenchTitleBarState()).recentProjectRoots');
    expect(main).not.toContain('(await runtimeClient.globalSettingsGet()).chrome.recentProjectRoots');
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
    expect(preload).toContain('bindProjectWindowToProject');
  });

  it('uses RuntimeSupervisor and attached runtime client', () => {
    const main = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/main.ts'), 'utf8');

    expect(main).toContain('new RuntimeSupervisor');
    expect(main).toContain('createAttachedDesktopRuntimeClient');
    expect(main).toContain('new TrayController');
    expect(main).toContain('runtimeSupervisor.stopOwnedRuntime()');
    expect(main).toContain('refreshProjectHistorySurfaces');
    expect(main).not.toContain('hostedDaemon');
    expect(main).not.toContain('desktopStateStore:');
  });

  it('does not keep an Electron-owned recent project store', () => {
    const main = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/main.ts'), 'utf8');

    expect(main).not.toContain('desktopStateStore');
    expect(main).not.toContain('createDesktopStateStore');
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
    expect(restartBody).toContain('const navigation = runtimeClient.shellNavigation()');
    expect(restartBody).toContain('await waitForDebruteShellUrl(navigation.readyUrl)');
    expect(restartBody).toContain('await window.loadURL(navigation.loadUrl)');
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

function expectWorkbenchNavigation(navigation: { readyUrl: string; loadUrl: string }, next: string): void {
  expect(navigation.readyUrl).toBe(`http://127.0.0.1:17322${next}`);
  const parsed = new URL(navigation.loadUrl);
  expect(parsed.origin).toBe('http://127.0.0.1:17322');
  expect(parsed.pathname).toMatch(/^\/__debrute\/session\/.+/);
  expect(parsed.searchParams.get('next')).toBe(next);
}
