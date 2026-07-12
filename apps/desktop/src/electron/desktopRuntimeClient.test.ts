import { describe, expect, it } from 'vitest';
import { createAttachedDesktopRuntimeClient } from './desktopRuntimeClient.js';
import type { DebruteDaemonRuntimeLike } from './daemonProjectOpen.js';

describe('desktop runtime client', { tags: ['runtime'] }, () => {
  it('opens projects through an attached runtime over HTTP', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = createAttachedDesktopRuntimeClient(runtimeFixture(), async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ projectId: 'project-1' }), { status: 200 });
    });

    const opened = await client.openProject('/tmp/debrute-project');
    expect(opened.projectId).toBe('project-1');
    expectWorkbenchNavigation(opened.navigation, '/projects/project-1');
    expect(client.mode).toBe('attached');
    expect(requests[0]?.url).toBe('http://127.0.0.1:17321/api/projects/open');
    expect((requests[0]?.init?.headers as Record<string, string>)['x-debrute-daemon-token']).toBe('secret');
  });

  it('includes daemon project-open error details', async () => {
    const client = createAttachedDesktopRuntimeClient(runtimeFixture(), async () => (
      new Response(JSON.stringify({ error: { message: 'projectRoot must resolve to a directory.' } }), { status: 400 })
    ));

    await expect(client.openProject('/missing-project')).rejects.toThrow(
      'Debrute daemon project open failed for /missing-project: 400 projectRoot must resolve to a directory.'
    );
  });

  it('registers and releases Electron project windows through the daemon HTTP lease API', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = createAttachedDesktopRuntimeClient(runtimeFixture(), async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, projectRoot: '/tmp/debrute-project' }), { status: 200 });
    });

    const lease = await client.registerElectronProjectWindow('project-1', 42);
    await lease.release();

    expect(lease.projectRoot).toBe('/tmp/debrute-project');
    expect(requests.map((request) => request.url)).toEqual([
      'http://127.0.0.1:17321/api/projects/project-1/electron-windows/42',
      'http://127.0.0.1:17321/api/projects/project-1/electron-windows/42'
    ]);
    expect(requests.map((request) => request.init?.method)).toEqual(['PUT', 'DELETE']);
    expect((requests[0]?.init?.headers as Record<string, string>)['x-debrute-daemon-token']).toBe('secret');
  });

  it('rejects when Electron project window lease registration fails', async () => {
    const client = createAttachedDesktopRuntimeClient(runtimeFixture(), async () => (
      new Response(JSON.stringify({ error: { code: 'project_not_open' } }), { status: 404 })
    ));

    await expect(client.registerElectronProjectWindow('project-1', 42)).rejects.toThrow(
      'Debrute daemon Electron window lease failed: PUT 404'
    );
  });

  it('rejects when Electron project window lease release fails', async () => {
    const client = createAttachedDesktopRuntimeClient(runtimeFixture(), async (_url, init) => (
      init?.method === 'DELETE'
        ? new Response('', { status: 500 })
        : new Response(JSON.stringify({ ok: true, projectRoot: '/tmp/debrute-project' }), { status: 200 })
    ));

    const lease = await client.registerElectronProjectWindow('project-1', 42);

    await expect(lease.release()).rejects.toThrow('Debrute daemon Electron window lease failed: DELETE 500');
  });

  it('opens projects through the daemon picker route', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = createAttachedDesktopRuntimeClient(runtimeFixture(), async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({
        opened: true,
        projectId: 'project-1',
        projectRevision: 1,
        snapshot: {}
      }), { status: 200 });
    });

    const opened = await client.openProjectFromPicker();
    expect(opened).toMatchObject({
      opened: true,
      projectId: 'project-1'
    });
    if (opened.opened) {
      expectWorkbenchNavigation(opened.navigation, '/projects/project-1');
    }
    expect(requests).toEqual([{
      url: 'http://127.0.0.1:17321/api/projects/open-picker',
      init: {
        method: 'POST',
        headers: { 'x-debrute-daemon-token': 'secret' }
      }
    }]);
  });

  it('reads and clears runtime title-bar state for Electron chrome surfaces', async () => {
    const requests: Array<{ method: string; path: string; search: string }> = [];
    const client = createAttachedDesktopRuntimeClient(runtimeFixture(), async (url, init) => {
      const parsed = new URL(String(url));
      requests.push({ method: init?.method ?? 'GET', path: parsed.pathname, search: parsed.search });
      if (parsed.pathname === '/api/workbench/title-bar') {
        return new Response(JSON.stringify({
          title: 'Desktop Project',
          recentProjectRoots: ['/tmp/project'],
          presentation: {
            platform: 'darwin',
            host: 'desktop',
            showWebMenus: false,
            showWindowControls: false,
            trafficLightSpacer: true
          },
          menus: []
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await expect(client.getWorkbenchTitleBarState()).resolves.toMatchObject({
      title: 'Desktop Project',
      presentation: { host: 'desktop' }
    });
    await expect(client.clearRecentProjectRoots()).resolves.toEqual({ ok: true });
    expect(requests).toEqual([
      { method: 'GET', path: '/api/workbench/title-bar', search: '?host=desktop' },
      { method: 'DELETE', path: '/api/workbench/recent-projects', search: '' }
    ]);
  });

  it('reads global settings and builds browser launch URLs from the attached runtime', async () => {
    const requests: Array<{ method: string; path: string }> = [];
    const client = createAttachedDesktopRuntimeClient(runtimeFixture(), async (url, init) => {
      const parsed = new URL(String(url));
      requests.push({ method: init?.method ?? 'GET', path: parsed.pathname });
      return new Response(JSON.stringify({
        workbench: {
          locale: 'en',
          themePreference: 'light',
          defaultFrontend: 'browser'
        },
        chrome: { recentProjectRoots: ['/tmp/project-a'] },
        models: {
          image: { models: [] },
          video: { models: [] },
          audio: { models: [] }
        },
        integrations: { integrations: [], backends: [] },
        adobeBridge: { enabled: true }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    await expect(client.globalSettingsGet()).resolves.toMatchObject({
      workbench: { defaultFrontend: 'browser' },
      chrome: { recentProjectRoots: ['/tmp/project-a'] }
    });
    const launchUrl = new URL(client.browserLaunchUrl('project-1'));
    expect(launchUrl.origin).toBe('http://127.0.0.1:17322');
    expect(launchUrl.pathname).toMatch(/^\/__debrute\/session\/.+/);
    expect(launchUrl.searchParams.get('next')).toBe('/projects/project-1');
    expect(requests).toEqual([
      { method: 'GET', path: '/api/settings/global' }
    ]);
  });
});

function runtimeFixture(): DebruteDaemonRuntimeLike {
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
