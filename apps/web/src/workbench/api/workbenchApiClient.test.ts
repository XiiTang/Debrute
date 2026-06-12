import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkbenchApiClient } from './workbenchApiClient';

describe('workbench API client', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const projectId = '123e4567-e89b-42d3-a456-426614174000';

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
    vi.unstubAllGlobals();
  });

  it('creates the browser HTTP client without Electron preload', () => {
    (globalThis as { window?: unknown }).window = {
      location: { origin: 'http://127.0.0.1:17321', search: '' },
      localStorage: { getItem: () => undefined, setItem: () => undefined },
      sessionStorage: { getItem: () => undefined, setItem: () => undefined }
    };

    expect(createWorkbenchApiClient()).toMatchObject({
      mode: 'web'
    });
  });

  it('uses the current browser origin as the daemon URL', async () => {
    const responses: string[] = [];
    (globalThis as { window?: unknown }).window = {
      location: { origin: 'http://127.0.0.1:17321', search: '' },
      localStorage: { getItem: () => undefined, setItem: () => undefined },
      sessionStorage: { getItem: () => undefined, setItem: () => undefined }
    };
    vi.stubGlobal('fetch', async (url: string) => {
      responses.push(url);
      return new Response(JSON.stringify({ projectId, projectRevision: 1, snapshot: { canvases: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    await createWorkbenchApiClient().openProject({ projectRoot: '/tmp/project' });

    expect(responses).toEqual(['http://127.0.0.1:17321/api/projects/open']);
  });

  it('keeps URL daemon tokens in memory instead of persisting them in browser storage', async () => {
    const setItem = vi.fn();
    const replaceState = vi.fn();
    (globalThis as { window?: unknown }).window = {
      location: { origin: 'http://127.0.0.1:17321', search: '?debrute-token=secret&view=canvas', pathname: '/', hash: '' },
      localStorage: { getItem: () => undefined, setItem },
      sessionStorage: { getItem: () => undefined, setItem: () => undefined },
      history: { state: { existing: true }, replaceState }
    };
    const requests: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      requests.push(init);
      return new Response(JSON.stringify({ projectId, projectRevision: 1, snapshot: { canvases: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    await createWorkbenchApiClient().openProject({ projectRoot: '/tmp/project' });

    expect(requests[0]!.headers).toMatchObject({ 'x-debrute-daemon-token': 'secret' });
    expect(setItem).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledWith({ existing: true, debruteDaemonToken: 'secret' }, '', '/?view=canvas');
  });

  it('recovers the daemon token from browser history state after URL cleanup', async () => {
    (globalThis as { window?: unknown }).window = {
      location: {
        origin: 'http://127.0.0.1:17321',
        search: '',
        pathname: `/projects/${projectId}`,
        hash: ''
      },
      localStorage: { getItem: () => undefined, setItem: () => undefined },
      sessionStorage: { getItem: () => undefined, setItem: () => undefined },
      history: { state: { debruteDaemonToken: 'secret' }, replaceState: vi.fn() }
    };
    const requests: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      requests.push(init);
      return new Response(JSON.stringify({ projectId, projectRevision: 1, snapshot: { canvases: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    await createWorkbenchApiClient().openProject({ projectId });

    expect(requests[0]!.headers).toMatchObject({ 'x-debrute-daemon-token': 'secret' });
  });

  it('calls project-scoped Canvas management routes', async () => {
    const requests: Array<{ method: string | undefined; url: string; body?: unknown }> = [];
    (globalThis as { window?: unknown }).window = {
      location: {
        origin: 'http://127.0.0.1:17321',
        search: '',
        pathname: `/projects/${projectId}`,
        hash: ''
      },
      localStorage: { getItem: () => undefined, setItem: () => undefined },
      sessionStorage: { getItem: () => undefined, setItem: () => undefined },
      history: { state: {}, replaceState: vi.fn() }
    };
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      requests.push({
        method: init.method,
        url,
        body: init.body ? JSON.parse(String(init.body)) : undefined
      });
      return new Response(JSON.stringify({
        projectId,
        projectRevision: requests.length,
        snapshot: {
          canvases: [],
          projections: [],
          canvasRegistry: { status: 'ready', canvasOrder: [] }
        }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    const client = createWorkbenchApiClient();
    await client.openProject({ projectId });
    await client.createCanvas();
    await client.renameCanvas({ canvasId: 'canvas-1', nextCanvasId: 'storyboard' });
    await client.deleteCanvas({ canvasId: 'storyboard' });
    await client.reorderCanvases({ canvasOrder: ['canvas-2', 'canvas-1'] });
    await client.repairCanvasIndex();

    expect(requests.slice(1)).toEqual([
      { method: 'POST', url: `http://127.0.0.1:17321/api/projects/${projectId}/canvases`, body: { baseRevision: 1 } },
      { method: 'PATCH', url: `http://127.0.0.1:17321/api/projects/${projectId}/canvases/canvas-1`, body: { baseRevision: 2, operation: 'rename', nextCanvasId: 'storyboard' } },
      { method: 'DELETE', url: `http://127.0.0.1:17321/api/projects/${projectId}/canvases/storyboard`, body: { baseRevision: 3 } },
      { method: 'PUT', url: `http://127.0.0.1:17321/api/projects/${projectId}/canvases/index`, body: { baseRevision: 4, canvasOrder: ['canvas-2', 'canvas-1'] } },
      { method: 'POST', url: `http://127.0.0.1:17321/api/projects/${projectId}/canvases/index/repair`, body: { baseRevision: 5 } }
    ]);
  });
});
