import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkbenchApiClient } from './workbenchApiClient';

describe('workbench API client', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const projectId = '123e4567-e89b-42d3-a456-426614174000';

  class FakeEventSource {
    static instances: FakeEventSource[] = [];

    onmessage: ((event: MessageEvent) => void) | null = null;
    closed = false;

    constructor(readonly url: string) {
      FakeEventSource.instances.push(this);
    }

    emit(data: unknown): void {
      this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
    }

    close(): void {
      this.closed = true;
    }
  }

  function installFakeEventSource(): typeof FakeEventSource {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    return FakeEventSource;
  }

  async function waitForEventSourceCount(EventSource: typeof FakeEventSource, count: number): Promise<void> {
    const deadline = Date.now() + 1000;
    while (EventSource.instances.length !== count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(EventSource.instances).toHaveLength(count);
  }

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

  it('uses runtime product HTTP endpoints with the daemon token', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    (globalThis as { window?: unknown }).window = {
      location: { origin: 'http://127.0.0.1:17321', search: '' },
      localStorage: { getItem: () => undefined, setItem: () => undefined },
      sessionStorage: { getItem: () => undefined, setItem: () => undefined },
      history: { state: { debruteDaemonToken: 'secret' }, replaceState: vi.fn() }
    };
    const state = {
      productVersion: '0.2.0',
      platform: 'darwin',
      cli: {
        status: 'ready',
        version: '0.2.0',
        path: '/Users/me/.debrute/bin/debrute',
        skillsVersion: '0.2.0',
        skillsRoot: '/Users/me/.agents/skills'
      },
      update: {
        type: 'idle',
        currentVersion: '0.2.0',
        updateAvailable: false
      }
    };
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      const body = url.endsWith('/api/runtime/product/update/apply') ? { state } : state;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    const client = createWorkbenchApiClient();
    await expect(client.getProductState()).resolves.toMatchObject({ productVersion: '0.2.0' });
    await expect(client.checkProductUpdate()).resolves.toMatchObject({ productVersion: '0.2.0' });
    await expect(client.applyProductUpdate()).resolves.toMatchObject({ state: { productVersion: '0.2.0' } });

    expect(requests.map((request) => [request.init.method, request.url])).toEqual([
      ['GET', 'http://127.0.0.1:17321/api/runtime/product'],
      ['POST', 'http://127.0.0.1:17321/api/runtime/product/update/check'],
      ['POST', 'http://127.0.0.1:17321/api/runtime/product/update/apply']
    ]);
    expect(requests.every((request) => (
      (request.init.headers as Record<string, string>)['x-debrute-daemon-token'] === 'secret'
    ))).toBe(true);
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

  it('subscribes to global Workbench events before a project is open', async () => {
    const EventSource = installFakeEventSource();
    const events: unknown[] = [];
    (globalThis as { window?: unknown }).window = {
      location: { origin: 'http://127.0.0.1:17321', search: '', pathname: '/', hash: '' },
      localStorage: { getItem: () => undefined, setItem: () => undefined },
      sessionStorage: {
        getItem: (key: string) => key === 'debrute.webClientId' ? 'debrute-web-client' : undefined,
        setItem: () => undefined
      },
      history: { state: {}, replaceState: vi.fn() }
    };
    vi.stubGlobal('fetch', async (url: string) => {
      const parsed = new URL(url);
      expect(parsed.pathname).toBe('/api/browser-session');
      return new Response(JSON.stringify({
        token: 'bootstrapped-secret',
        runtime: {
          daemonUrl: 'http://127.0.0.1:17321',
          webBaseUrl: 'http://127.0.0.1:17321',
          platform: 'darwin'
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const client = createWorkbenchApiClient();
    const unsubscribe = client.onEvent((event) => events.push(event));
    await waitForEventSourceCount(EventSource, 1);

    expect(EventSource.instances[0]!.url).toBe('http://127.0.0.1:17321/api/workbench/events?clientId=debrute-web-client&debrute-token=bootstrapped-secret');

    EventSource.instances[0]!.emit({
      type: 'workbench.preferences.changed',
      preferences: { locale: 'zh-CN', themePreference: 'light' }
    });

    expect(events).toEqual([{
      type: 'workbench.preferences.changed',
      preferences: { locale: 'zh-CN', themePreference: 'light' }
    }]);

    unsubscribe();
    expect(EventSource.instances[0]!.closed).toBe(true);
  });

  it('keeps the global event source active when a project event source is added', async () => {
    const EventSource = installFakeEventSource();
    const events: unknown[] = [];
    (globalThis as { window?: unknown }).window = {
      location: { origin: 'http://127.0.0.1:17321', search: '', pathname: '/', hash: '' },
      localStorage: { getItem: () => undefined, setItem: () => undefined },
      sessionStorage: {
        getItem: (key: string) => key === 'debrute.webClientId' ? 'debrute-web-client' : undefined,
        setItem: () => undefined
      },
      history: { state: { debruteDaemonToken: 'secret' }, replaceState: vi.fn() }
    };
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const parsed = new URL(url);
      expect(init.headers).toMatchObject({ 'x-debrute-daemon-token': 'secret' });
      expect(parsed.pathname).toBe(`/api/projects/${projectId}`);
      return new Response(JSON.stringify({
        projectId,
        projectRevision: 7,
        snapshot: {
          metadata: { project: { name: 'Demo' } },
          canvases: [],
          projections: [],
          canvasRegistry: { status: 'ready', canvasOrder: [] }
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const client = createWorkbenchApiClient();
    const unsubscribe = client.onEvent((event) => events.push(event));

    expect(EventSource.instances).toHaveLength(1);
    expect(EventSource.instances[0]!.url).toBe('http://127.0.0.1:17321/api/workbench/events?clientId=debrute-web-client&debrute-token=secret');

    await client.openProject({ projectId });

    expect(EventSource.instances).toHaveLength(2);
    expect(EventSource.instances[0]!.closed).toBe(false);
    expect(EventSource.instances[1]!.url).toBe(`http://127.0.0.1:17321/api/projects/${projectId}/events?clientId=debrute-web-client&debrute-token=secret`);

    EventSource.instances[0]!.emit({
      type: 'workbench.preferences.changed',
      preferences: { locale: 'zh-CN', themePreference: 'dark' }
    });
    EventSource.instances[1]!.emit({
      type: 'project.changed',
      projectId,
      projectRevision: 8,
      snapshot: {
        metadata: { project: { name: 'Demo' } },
        canvases: [],
        projections: [],
        canvasRegistry: { status: 'ready', canvasOrder: [] }
      }
    });

    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      'workbench.preferences.changed',
      'project.changed'
    ]);

    unsubscribe();
    expect(EventSource.instances.every((source) => source.closed)).toBe(true);
  });

  it('calls Workbench preferences routes', async () => {
    const requests: Array<{ method: string | undefined; path: string; body?: unknown; headers?: RequestInit['headers'] }> = [];
    (globalThis as { window?: unknown }).window = {
      location: { origin: 'http://127.0.0.1:17321', search: '', pathname: '/', hash: '' },
      localStorage: { getItem: () => undefined, setItem: () => undefined },
      sessionStorage: { getItem: () => undefined, setItem: () => undefined },
      history: { state: { debruteDaemonToken: 'secret' }, replaceState: vi.fn() }
    };
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const parsed = new URL(url);
      requests.push({
        method: init.method,
        path: parsed.pathname,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        headers: init.headers
      });
      return new Response(JSON.stringify({
        locale: parsed.pathname === '/api/settings/workbench-preferences' && init.method === 'PUT' ? 'zh-CN' : 'en',
        themePreference: parsed.pathname === '/api/settings/workbench-preferences' && init.method === 'PUT' ? 'light' : 'system'
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    const client = createWorkbenchApiClient();

    await expect(client.workbenchPreferencesGet()).resolves.toEqual({
      locale: 'en',
      themePreference: 'system'
    });
    await expect(client.workbenchPreferencesSave({
      locale: 'zh-CN',
      themePreference: 'light'
    })).resolves.toEqual({
      locale: 'zh-CN',
      themePreference: 'light'
    });

    expect(requests).toEqual([
      {
        method: 'GET',
        path: '/api/settings/workbench-preferences',
        body: undefined,
        headers: { 'x-debrute-daemon-token': 'secret' }
      },
      {
        method: 'PUT',
        path: '/api/settings/workbench-preferences',
        body: { locale: 'zh-CN', themePreference: 'light' },
        headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'secret' }
      }
    ]);
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
    await client.renameCanvas({ canvasId: 'canvas-1', name: '故事板' });
    await client.deleteCanvas({ canvasId: 'canvas-1' });
    await client.reorderCanvases({ canvasOrder: ['canvas-2', 'canvas-1'] });
    await client.repairCanvasIndex();
    await client.resetCanvasNodeLayouts({ canvasId: 'canvas-1', all: true });
    await client.resetCanvasNodeLayouts({ canvasId: 'canvas-1', pathRules: ['outputs/gpt/', 'prompts/cover.md'] });

    expect(requests.slice(1)).toEqual([
      { method: 'POST', url: `http://127.0.0.1:17321/api/projects/${projectId}/canvases`, body: { baseRevision: 1 } },
      { method: 'PATCH', url: `http://127.0.0.1:17321/api/projects/${projectId}/canvases/canvas-1`, body: { baseRevision: 2, operation: 'rename', name: '故事板' } },
      { method: 'DELETE', url: `http://127.0.0.1:17321/api/projects/${projectId}/canvases/canvas-1`, body: { baseRevision: 3 } },
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
      sourcePng: new Blob(['png'], { type: 'image/png' })
    });
    await client.readCanvasTextPreviewSources({
      canvasId: 'canvas-1',
      sources: [{ projectRelativePath: 'notes/a.md', fingerprint: 'fp' }]
    });

    expect(requests.slice(1)).toEqual([
      {
        method: 'POST',
        url: `http://127.0.0.1:17321/api/projects/${projectId}/canvas-text-previews/source`,
        bodyKind: 'form'
      },
      {
        method: 'POST',
        url: `http://127.0.0.1:17321/api/projects/${projectId}/canvas-text-previews/sources`,
        bodyKind: 'json'
      }
    ]);
  });
});
