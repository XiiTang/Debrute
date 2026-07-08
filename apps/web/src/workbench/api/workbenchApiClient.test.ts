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

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

  it('creates the browser HTTP client without Electron preload', () => {
    installWindow();

    expect(createWorkbenchApiClient()).toMatchObject({
      mode: 'web'
    });
  });

  it('uses same-origin relative Workbench API requests without daemon token headers', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    installWindow();
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ projectId, projectRevision: 1, snapshot: { canvases: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    await createWorkbenchApiClient().openProject({ projectRoot: '/tmp/project' });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('/api/projects/open');
    expect(requests[0]!.init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin'
    });
    expect(JSON.stringify(requests[0]!.init.headers)).not.toContain('x-debrute-daemon-token');
  });

  it('uses runtime product HTTP endpoints without browser daemon tokens', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    installWindow();
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
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
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
      ['GET', '/api/runtime/product'],
      ['POST', '/api/runtime/product/update/check'],
      ['POST', '/api/runtime/product/update/apply']
    ]);
    expect(JSON.stringify(requests)).not.toContain('x-debrute-daemon-token');
  });

  it('subscribes to Workbench events with relative EventSource URLs and no token query', async () => {
    const events: unknown[] = [];
    installWindow({
      sessionStorage: {
        getItem: (key: string) => key === 'debrute.webClientId' ? 'debrute-web-client' : undefined,
        setItem: () => undefined
      }
    });
    vi.stubGlobal('EventSource', FakeEventSource);

    const client = createWorkbenchApiClient();
    const unsubscribe = client.onEvent((event) => events.push(event));

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toBe('/api/workbench/events?clientId=debrute-web-client');

    FakeEventSource.instances[0]!.emit({
      type: 'workbench.preferences.changed',
      preferences: { locale: 'zh-CN', themePreference: 'light' }
    });

    expect(events).toEqual([{
      type: 'workbench.preferences.changed',
      preferences: { locale: 'zh-CN', themePreference: 'light' }
    }]);

    unsubscribe();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
  });

  it('keeps the global event source active when a project event source is added', async () => {
    installWindow({
      sessionStorage: {
        getItem: (key: string) => key === 'debrute.webClientId' ? 'debrute-web-client' : undefined,
        setItem: () => undefined
      }
    });
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('fetch', async (url: string) => {
      expect(url).toBe(`/api/projects/${projectId}`);
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
    const unsubscribe = client.onEvent(() => undefined);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toBe('/api/workbench/events?clientId=debrute-web-client');

    await client.openProject({ projectId });

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[0]!.closed).toBe(false);
    expect(FakeEventSource.instances[1]!.url).toBe(`/api/projects/${projectId}/events?clientId=debrute-web-client`);

    unsubscribe();
    expect(FakeEventSource.instances.every((source) => source.closed)).toBe(true);
  });

  it('calls Workbench preferences routes without daemon token headers', async () => {
    const requests: Array<{ method: string | undefined; path: string; body?: unknown; headers?: RequestInit['headers'] }> = [];
    installWindow();
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const parsed = new URL(url, 'http://debrute.local');
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
        headers: {}
      },
      {
        method: 'PUT',
        path: '/api/settings/workbench-preferences',
        body: { locale: 'zh-CN', themePreference: 'light' },
        headers: { 'content-type': 'application/json' }
      }
    ]);
  });

  it('calls project-scoped Canvas management routes with relative URLs', async () => {
    const requests: Array<{ method: string | undefined; url: string; body?: unknown }> = [];
    installWindow({ pathname: `/projects/${projectId}` });
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
    await client.renameCanvas({ canvasId: 'canvas-1', name: 'Storyboard' });
    await client.deleteCanvas({ canvasId: 'canvas-1' });

    expect(requests.map((request) => [request.method, request.url, request.body])).toEqual([
      ['GET', `/api/projects/${projectId}`, undefined],
      ['POST', `/api/projects/${projectId}/canvases`, { baseRevision: 1 }],
      ['PATCH', `/api/projects/${projectId}/canvases/canvas-1`, { baseRevision: 2, operation: 'rename', name: 'Storyboard' }],
      ['DELETE', `/api/projects/${projectId}/canvases/canvas-1`, { baseRevision: 3 }]
    ]);
    expect(JSON.stringify(requests)).not.toContain('x-debrute-daemon-token');
  });

  it('persists text viewport state without a base revision and remembers the returned revision', async () => {
    const requests: Array<{ method: string | undefined; url: string; body?: unknown }> = [];
    installWindow({ pathname: `/projects/${projectId}` });
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      requests.push({
        method: init.method,
        url,
        body: init.body ? JSON.parse(String(init.body)) : undefined
      });
      const projectRevision = url.includes('/text-viewport') ? 8 : requests.length;
      return new Response(JSON.stringify({
        projectId,
        projectRevision,
        snapshot: {
          canvases: [],
          projections: [],
          canvasRegistry: { status: 'ready', canvasOrder: [] }
        },
        canvas: { id: 'canvas-1', name: 'Canvas', nodeElements: [], annotations: [], preferences: { showDiagnostics: true } },
        projection: { canvasId: 'canvas-1', nodes: [], diagnostics: [] }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    const client = createWorkbenchApiClient();
    await client.openProject({ projectId });
    await client.updateCanvasTextViewportState({
      canvasId: 'canvas-1',
      updates: [{ projectRelativePath: 'notes/readme.md', scrollTop: 72, scrollLeft: 9 }]
    });
    await client.createCanvas();

    expect(requests.map((request) => [request.method, request.url, request.body])).toEqual([
      ['GET', `/api/projects/${projectId}`, undefined],
      ['PATCH', `/api/projects/${projectId}/canvases/canvas-1/text-viewport`, {
        updates: [{ projectRelativePath: 'notes/readme.md', scrollTop: 72, scrollLeft: 9 }]
      }],
      ['POST', `/api/projects/${projectId}/canvases`, { baseRevision: 8 }]
    ]);
  });
});

function installWindow(input: {
  pathname?: string;
  sessionStorage?: { getItem: (key: string) => string | undefined; setItem: (key: string, value: string) => void };
} = {}): void {
  (globalThis as { window?: unknown }).window = {
    location: {
      origin: 'http://127.0.0.1:17321',
      search: '',
      pathname: input.pathname ?? '/',
      hash: ''
    },
    localStorage: { getItem: () => undefined, setItem: () => undefined },
    sessionStorage: input.sessionStorage ?? { getItem: () => undefined, setItem: () => undefined },
    history: { state: {}, replaceState: vi.fn() }
  };
}
