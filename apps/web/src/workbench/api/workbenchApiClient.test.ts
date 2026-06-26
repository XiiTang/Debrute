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
      sessionStorage: { getItem: () => undefined, setItem: () => undefined },
      history: { state: { debruteDaemonToken: 'secret' }, replaceState: vi.fn() }
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
      sessionStorage: { getItem: () => undefined, setItem: () => undefined },
      history: { state: { debruteDaemonToken: 'secret' }, replaceState: vi.fn() }
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

  it('bootstraps a daemon token when the browser has no URL or history token', async () => {
    (globalThis as { window?: unknown }).window = {
      location: {
        origin: 'http://127.0.0.1:17321',
        search: '',
        pathname: '/open',
        hash: ''
      },
      localStorage: { getItem: () => undefined, setItem: () => undefined },
      sessionStorage: { getItem: () => undefined, setItem: () => undefined },
      history: { state: {}, replaceState: vi.fn() }
    };
    const requests: Array<{ method: string | undefined; path: string; headers?: RequestInit['headers'] }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const parsed = new URL(url);
      requests.push({ method: init.method, path: parsed.pathname, headers: init.headers });
      if (parsed.pathname === '/api/browser-session') {
        return new Response(JSON.stringify({
          token: 'bootstrapped-secret',
          runtime: {
            daemonUrl: 'http://127.0.0.1:17321',
            webBaseUrl: 'http://127.0.0.1:17321',
            platform: 'darwin'
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ projectId, projectRevision: 1, snapshot: { canvases: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    await createWorkbenchApiClient().openProject({ projectRoot: '/tmp/project' });

    expect(requests.map((request) => [request.method ?? 'GET', request.path])).toEqual([
      ['GET', '/api/browser-session'],
      ['POST', '/api/projects/open']
    ]);
    expect(requests[0]!.headers).toMatchObject({ 'x-debrute-web-origin': 'http://127.0.0.1:17321' });
    expect(requests[1]!.headers).toMatchObject({ 'x-debrute-daemon-token': 'bootstrapped-secret' });
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
      history: { state: { debruteDaemonToken: 'secret' }, replaceState: vi.fn() }
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
    await client.resetCanvasNodeLayouts({ canvasId: 'canvas-1', all: true });
    await client.resetCanvasNodeLayouts({ canvasId: 'canvas-1', pathRules: ['outputs/gpt/', 'prompts/cover.md'] });

    expect(requests.slice(1)).toEqual([
      { method: 'POST', url: `http://127.0.0.1:17321/api/projects/${projectId}/canvases`, body: { baseRevision: 1 } },
      { method: 'PATCH', url: `http://127.0.0.1:17321/api/projects/${projectId}/canvases/canvas-1`, body: { baseRevision: 2, operation: 'rename', nextCanvasId: 'storyboard' } },
      { method: 'DELETE', url: `http://127.0.0.1:17321/api/projects/${projectId}/canvases/storyboard`, body: { baseRevision: 3 } },
      { method: 'PUT', url: `http://127.0.0.1:17321/api/projects/${projectId}/canvases/index`, body: { baseRevision: 4, canvasOrder: ['canvas-2', 'canvas-1'] } },
      { method: 'POST', url: `http://127.0.0.1:17321/api/projects/${projectId}/canvases/index/repair`, body: { baseRevision: 5 } },
      { method: 'POST', url: `http://127.0.0.1:17321/api/projects/${projectId}/canvases/canvas-1/reset-layout`, body: { baseRevision: 6, all: true } },
      { method: 'POST', url: `http://127.0.0.1:17321/api/projects/${projectId}/canvases/canvas-1/reset-layout`, body: { baseRevision: 7, pathRules: ['outputs/gpt/', 'prompts/cover.md'] } }
    ]);
  });

  it('calls project-scoped Canvas text preview routes', async () => {
    const requests: Array<{ method: string | undefined; url: string; bodyKind: string }> = [];
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
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      requests.push({
        method: init.method,
        url,
        bodyKind: init.body instanceof FormData ? 'form' : init.body ? 'json' : 'none'
      });
      return new Response(JSON.stringify({ projectId, projectRevision: 1, snapshot: { canvases: [] }, descriptors: {}, variants: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    const client = createWorkbenchApiClient();
    await client.openProject({ projectId });
    await client.saveCanvasTextPreviewSource({
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/a.md',
      fingerprint: 'fp',
      contentCssWidth: 600,
      contentCssHeight: 320,
      scrollTop: 0,
      scrollLeft: 0,
      sourcePng: new Blob(['png'], { type: 'image/png' })
    });
    await client.readCanvasTextPreviewDescriptors({ canvasId: 'canvas-1', nodes: [] });
    await client.reconcileCanvasTextPreviews({ canvasId: 'canvas-1', nodes: [], devicePixelRatio: 2 });

    expect(requests.slice(1)).toEqual([
      {
        method: 'POST',
        url: `http://127.0.0.1:17321/api/projects/${projectId}/canvas-text-previews/source`,
        bodyKind: 'form'
      },
      {
        method: 'POST',
        url: `http://127.0.0.1:17321/api/projects/${projectId}/canvas-text-previews/descriptors`,
        bodyKind: 'json'
      },
      {
        method: 'POST',
        url: `http://127.0.0.1:17321/api/projects/${projectId}/canvas-text-previews/reconcile`,
        bodyKind: 'json'
      }
    ]);
  });
});
