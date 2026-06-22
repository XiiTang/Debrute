import { describe, expect, it } from 'vitest';
import { createAttachedDesktopRuntimeClient } from '../apps/desktop/src/electron/desktopRuntimeClient';
import type { DebruteDaemonRuntimeLike } from '../apps/desktop/src/electron/daemonProjectOpen';

describe('desktop runtime client', () => {
  it('opens projects through an attached runtime over HTTP', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createAttachedDesktopRuntimeClient(runtimeFixture(), async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ projectId: 'project-1' }), { status: 200 });
    });

    await expect(client.openProject('/tmp/debrute-project')).resolves.toEqual({
      projectId: 'project-1',
      url: 'http://127.0.0.1:17322/projects/project-1?debrute-token=secret'
    });
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
    const requests: Array<{ url: string; init?: RequestInit }> = [];
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
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createAttachedDesktopRuntimeClient(runtimeFixture(), async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({
        opened: true,
        projectId: 'project-1',
        projectRevision: 1,
        snapshot: {}
      }), { status: 200 });
    });

    await expect(client.openProjectFromPicker()).resolves.toEqual({
      opened: true,
      projectId: 'project-1',
      url: 'http://127.0.0.1:17322/projects/project-1?debrute-token=secret'
    });
    expect(requests).toEqual([{
      url: 'http://127.0.0.1:17321/api/projects/open-picker',
      init: {
        method: 'POST',
        headers: { 'x-debrute-daemon-token': 'secret' }
      }
    }]);
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
