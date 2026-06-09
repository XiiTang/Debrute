import type { MenuItemConstructorOptions } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DebruteDaemonRuntime } from '@debrute/daemon';
import { openProjectThroughDaemon, projectWebShellUrl } from '../apps/desktop/src/electron/daemonProjectOpen';
import { buildApplicationMenuTemplate } from '../apps/desktop/src/electron/menu/applicationMenu';

describe('desktop application menu', () => {
  it('puts project actions under a top-level File menu', () => {
    const template = buildApplicationMenuTemplate({
      recentProjectRoots: ['/tmp/alpha-project', '/tmp/beta-project'],
      onOpenProject: vi.fn(),
      onOpenRecentProject: vi.fn(),
      onClearRecentProjects: vi.fn()
    });

    const fileMenu = template.find((item) => item.label === 'File');
    expect(fileMenu).toBeDefined();

    const fileItems = fileMenu?.submenu as MenuItemConstructorOptions[];
    expect(fileItems.map((item) => item.label ?? item.role)).toContain('Open Project...');

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

  it('provides native editing roles including speech controls', () => {
    const template = buildApplicationMenuTemplate({
      recentProjectRoots: [],
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
    expect(main).toContain("ipcMain.handle('debrute-shell:bindProjectWindowToProject'");
    expect(main).toContain('BrowserWindow.fromWebContents');
    expect(main).not.toContain('loadProjectRouteInShell');
    expect(main).not.toContain('Promise.all(windows.map((window) => window.loadURL(url)))');
  });

  it('injects Electron shell as the hosted daemon native shell adapter', () => {
    const main = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/main.ts'), 'utf8');
    const revealChannel = 'debrute-shell' + ':revealProjectPathInSystemFileManager';
    const trashChannel = 'debrute-shell' + ':trashProjectPath';

    expect(main).toContain('createElectronNativeShell');
    expect(main).toContain('nativeShell: createElectronNativeShell(shell)');
    expect(main).not.toContain(`ipcMain.handle('${revealChannel}'`);
    expect(main).not.toContain(`ipcMain.handle('${trashChannel}'`);
  });

  it('keeps Explorer file operations out of the preload shell API', () => {
    const preload = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/preload.ts'), 'utf8');

    expect(preload).not.toContain('revealProjectPathInSystemFileManager');
    expect(preload).not.toContain('trashProjectPath');
    expect(preload).toContain('getDroppedFilePath');
    expect(preload).toContain('webUtils.getPathForFile');
    expect(preload).toContain('chooseProjectRoot');
    expect(preload).toContain('bindProjectWindowToProject');
  });

  it('participates in the shared Workbench runtime registry', () => {
    const main = readFileSync(join(process.cwd(), 'apps/desktop/src/electron/main.ts'), 'utf8');

    expect(main).toContain('ensureRegisteredWorkbenchRuntime');
    expect(main).toContain('runtimeKind: desktopRuntimeKind()');
    expect(main).toContain("'desktop-packaged'");
    expect(main).toContain("processControl: 'external'");
    expect(main).toContain('createAttachedDesktopRuntimeClient');
    expect(main).toContain('createHostedDesktopRuntimeClient');
    expect(main).toContain("process.env.DEBRUTE_WORKBENCH_RUNTIME_MODE === 'hosted'");
    expect(main).toContain('await rememberProjectRootAndRefreshMenu(projectRoot)');
    expect(main).not.toContain('desktopStateStore:');
  });
});

function daemonRuntimeFixture(): DebruteDaemonRuntime {
  return {
    daemonUrl: 'http://127.0.0.1:17321',
    webBaseUrl: 'http://127.0.0.1:17322',
    platform: 'darwin',
    token: 'secret'
  };
}
