import { describe, expect, it } from 'vitest';
import type { WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import { createHttpWorkbenchApiClient } from '../apps/web/src/api/httpWorkbenchApiClient';

const projectId = '123e4567-e89b-42d3-a456-426614174000';

describe('HTTP workbench API client', () => {
  it('reads the daemon runtime platform instead of guessing from the browser', async () => {
    const requests: Array<{ method: string; path: string }> = [];
    const client = createHttpWorkbenchApiClient({
      daemonUrl: 'http://127.0.0.1:17456/',
      fetch: async (url, init) => {
        const parsed = new URL(String(url));
        requests.push({ method: init?.method ?? 'GET', path: parsed.pathname });
        return jsonResponse(routeResponse(String(url), init));
      }
    });

    await expect(client.getDesktopPlatform()).resolves.toBe('darwin');
    expect(requests).toContainEqual({ method: 'GET', path: '/api/runtime' });
  });

  it('uses daemon HTTP routes for workbench operations', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createHttpWorkbenchApiClient({
      daemonUrl: 'http://127.0.0.1:17456/',
      token: 'secret',
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        const body = routeResponse(String(url), init);
        if (new URL(String(url)).pathname === '/api/projects/open') {
          expect(JSON.stringify(body)).not.toContain('projectRoot');
          expect(JSON.stringify(body)).not.toContain('/tmp/project');
        }
        return jsonResponse(body);
      }
    });

    expect(client.mode).toBe('web');
    await expect(client.openProject({ projectRoot: '/tmp/project' })).resolves.toMatchObject({
      projectId,
      snapshot: { metadata: { project: { name: 'Test Project' } } }
    });
    await client.readProjectTextFile('briefs/outline.md');
    await client.writeProjectTextFile('briefs/outline.md', '# Outline');
    await client.readGeneratedAsset('asset-1');

    expect(requests.map((request) => [request.init?.method ?? 'GET', request.url])).toEqual([
      ['POST', 'http://127.0.0.1:17456/api/projects/open'],
      ['GET', `http://127.0.0.1:17456/api/projects/${projectId}/files/text/briefs/outline.md`],
      ['PUT', `http://127.0.0.1:17456/api/projects/${projectId}/files/text/briefs/outline.md`],
      ['GET', `http://127.0.0.1:17456/api/projects/${projectId}/generated-assets/asset-1`]
    ]);
    expect(requests[0]!.init?.headers).toMatchObject({ 'x-debrute-daemon-token': 'secret' });
  });

  it('bootstraps a daemon token for HTTP clients without an explicit token', async () => {
    const requests: Array<{ method: string; path: string; headers?: RequestInit['headers'] }> = [];
    const client = createHttpWorkbenchApiClient({
      daemonUrl: 'http://127.0.0.1:17456/',
      fetch: async (url, init) => {
        const parsed = new URL(String(url));
        requests.push({ method: init?.method ?? 'GET', path: parsed.pathname, headers: init?.headers });
        if (parsed.pathname === '/api/browser-session') {
          return jsonResponse({
            token: 'bootstrapped-secret',
            runtime: {
              daemonUrl: 'http://127.0.0.1:17456',
              webBaseUrl: 'http://127.0.0.1:17456',
              platform: 'darwin'
            }
          });
        }
        return jsonResponse(routeResponse(String(url), init));
      }
    });

    await client.openProject({ projectRoot: '/tmp/project' });
    await client.readProjectTextFile('briefs/outline.md');

    expect(requests.map((request) => [request.method, request.path])).toEqual([
      ['GET', '/api/browser-session'],
      ['POST', '/api/projects/open'],
      ['GET', `/api/projects/${projectId}/files/text/briefs/outline.md`]
    ]);
    expect(requests[0]!.headers).toMatchObject({ 'x-debrute-web-origin': 'http://127.0.0.1:17456' });
    expect(requests[1]!.headers).toMatchObject({ 'x-debrute-daemon-token': 'bootstrapped-secret' });
    expect(requests[2]!.headers).toMatchObject({ 'x-debrute-daemon-token': 'bootstrapped-secret' });
  });

  it('opens the project event stream after the daemon returns an opaque project id', async () => {
    const eventSourceUrls: string[] = [];
    const client = createHttpWorkbenchApiClient({
      daemonUrl: 'http://127.0.0.1:17456/',
      token: 'secret',
      fetch: async (url, init) => {
        const body = routeResponse(String(url), init);
        if (new URL(String(url)).pathname === '/api/projects/open') {
          expect(JSON.stringify(body)).not.toContain('projectRoot');
          expect(JSON.stringify(body)).not.toContain('/tmp/project');
        }
        return jsonResponse(body);
      }
    });
    const originalEventSource = globalThis.EventSource;
    globalThis.EventSource = class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string | URL) {
        eventSourceUrls.push(String(url));
      }
      close() {}
    } as typeof EventSource;
    try {
      const unsubscribe = client.onEvent(() => {});
      expect(eventSourceUrls).toEqual([]);

      await client.openProject({ projectRoot: '/tmp/project' });
      expect(eventSourceUrls).toHaveLength(1);
      const eventUrl = new URL(eventSourceUrls[0]!);
      expect(eventUrl.origin + eventUrl.pathname).toBe(`http://127.0.0.1:17456/api/projects/${projectId}/events`);
      const clientId = eventUrl.searchParams.get('clientId');
      expect(clientId).not.toBeNull();
      expect(clientId!).toMatch(/^web:/);
      expect(eventUrl.searchParams.get('debrute-token')).toBe('secret');

      unsubscribe();
    } finally {
      globalThis.EventSource = originalEventSource;
    }
  });

  it('uses the daemon route to copy absolute project path batches', async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const client = createHttpWorkbenchApiClient({
      daemonUrl: 'http://127.0.0.1:17456/',
      token: 'secret',
      fetch: async (url, init) => {
        const parsed = new URL(String(url));
        requests.push({
          method: init?.method ?? 'GET',
          path: parsed.pathname,
          body: init?.body ? JSON.parse(String(init.body)) : undefined
        });
        return jsonResponse(routeResponse(String(url), init));
      }
    });

    await client.openProject({ projectRoot: '/tmp/project' });
    await expect(client.copyProjectAbsolutePaths({
      entries: [
        { projectRelativePath: 'briefs/outline.md', kind: 'file' },
        { projectRelativePath: 'assets', kind: 'directory' }
      ]
    })).resolves.toEqual({
      paths: ['/tmp/project/briefs/outline.md', '/tmp/project/assets']
    });

    expect(requests).toContainEqual({
      method: 'POST',
      path: `/api/projects/${projectId}/files/path/batch/copy-path`,
      body: {
        entries: [
          { projectRelativePath: 'briefs/outline.md', kind: 'file' },
          { projectRelativePath: 'assets', kind: 'directory' }
        ]
      }
    });
  });

  it('uses daemon native routes for reveal and batch trash', async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const client = createHttpWorkbenchApiClient({
      daemonUrl: 'http://127.0.0.1:17456/',
      token: 'secret',
      fetch: async (url, init) => {
        const parsed = new URL(String(url));
        requests.push({
          method: init?.method ?? 'GET',
          path: parsed.pathname,
          body: init?.body ? JSON.parse(String(init.body)) : undefined
        });
        return jsonResponse(routeResponse(String(url), init));
      }
    });

    await client.openProject({ projectRoot: '/tmp/project' });
    await expect(client.revealProjectPathInSystemFileManager({
      projectRelativePath: 'briefs/outline.md',
      kind: 'file'
    })).resolves.toEqual({ ok: true });
    await expect(client.trashProjectPaths({
      entries: [{ projectRelativePath: 'assets/cover.png', kind: 'file' }]
    })).resolves.toMatchObject({
      results: [{ projectRelativePath: 'assets/cover.png', kind: 'file', status: 'ok' }],
      snapshot: { metadata: { project: { name: 'Test Project' } } }
    });

    expect(requests).toContainEqual({
      method: 'POST',
      path: `/api/projects/${projectId}/files/path/briefs/outline.md/reveal`,
      body: { kind: 'file' }
    });
    expect(requests).toContainEqual({
      method: 'POST',
      path: `/api/projects/${projectId}/files/path/batch/trash`,
      body: { baseRevision: 1, entries: [{ projectRelativePath: 'assets/cover.png', kind: 'file' }] }
    });
  });

  it('uses daemon terminal routes and subscribes to per-terminal events', async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const eventSourceUrls: string[] = [];
    let terminalListener: ((event: MessageEvent) => void) | undefined;
    const originalEventSource = globalThis.EventSource;
    globalThis.EventSource = class extends EventTarget {
      closed = false;
      constructor(url: string | URL) {
        super();
        eventSourceUrls.push(String(url));
      }

      addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        if (type === 'terminal') {
          terminalListener = listener as (event: MessageEvent) => void;
        }
      }

      close(): void {
        this.closed = true;
      }
    } as typeof EventSource;
    try {
      const terminalEvents: unknown[] = [];
      const client = createHttpWorkbenchApiClient({
        daemonUrl: 'http://127.0.0.1:17456/',
        token: 'secret',
        fetch: async (url, init) => {
          const parsed = new URL(String(url));
          requests.push({
            method: init?.method ?? 'GET',
            path: parsed.pathname,
            body: init?.body ? JSON.parse(String(init.body)) : undefined
          });
          return jsonResponse(routeResponse(String(url), init));
        }
      });

      await client.openProject({ projectRoot: '/tmp/project' });
      await expect(client.createTerminalSession({
        cwdProjectRelativePath: 'src',
        cols: 100,
        rows: 32
      })).resolves.toMatchObject({
        session: {
          id: 'terminal-1',
          cwdProjectRelativePath: 'src'
        }
      });
      await client.listTerminalSessions();
      await client.writeTerminalInput({ terminalId: 'terminal-1', data: 'pwd\r' });
      await client.resizeTerminal({ terminalId: 'terminal-1', cols: 120, rows: 40 });
      await client.restartTerminalSession({ terminalId: 'terminal-1' });
      await client.closeTerminalSession({ terminalId: 'terminal-1' });
      const subscription = client.subscribeTerminalEvents('terminal-1', (event) => terminalEvents.push(event));

      terminalListener?.(new MessageEvent('terminal', {
        data: JSON.stringify({ type: 'data', terminalId: 'terminal-1', sequence: 1, data: 'ok\r\n' })
      }));
      subscription.close();

      expect(requests).toEqual(expect.arrayContaining([
        {
          method: 'POST',
          path: `/api/projects/${projectId}/terminals`,
          body: { cwdProjectRelativePath: 'src', cols: 100, rows: 32 }
        },
        { method: 'GET', path: `/api/projects/${projectId}/terminals`, body: undefined },
        { method: 'POST', path: `/api/projects/${projectId}/terminals/terminal-1/input`, body: { data: 'pwd\r' } },
        { method: 'POST', path: `/api/projects/${projectId}/terminals/terminal-1/resize`, body: { cols: 120, rows: 40 } },
        { method: 'POST', path: `/api/projects/${projectId}/terminals/terminal-1/restart`, body: undefined },
        { method: 'DELETE', path: `/api/projects/${projectId}/terminals/terminal-1`, body: undefined }
      ]));
      expect(eventSourceUrls).toHaveLength(1);
      const eventUrl = new URL(eventSourceUrls[0]!);
      expect(eventUrl.origin + eventUrl.pathname).toBe(`http://127.0.0.1:17456/api/projects/${projectId}/terminals/terminal-1/events`);
      expect(eventUrl.searchParams.get('debrute-token')).toBe('secret');
      expect(terminalEvents).toEqual([{ type: 'data', terminalId: 'terminal-1', sequence: 1, data: 'ok\r\n' }]);
    } finally {
      globalThis.EventSource = originalEventSource;
    }
  });

  it('does not report terminal event stream errors after a terminal closed event', async () => {
    let terminalListener: ((event: MessageEvent) => void) | undefined;
    let eventSource: EventSource | undefined;
    let sourceClosed = false;
    const originalEventSource = globalThis.EventSource;
    globalThis.EventSource = class extends EventTarget {
      onerror: ((event: Event) => void) | null = null;

      constructor(_url: string | URL) {
        super();
        eventSource = this as EventSource;
      }

      addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        if (type === 'terminal') {
          terminalListener = listener as (event: MessageEvent) => void;
        }
      }

      close(): void {
        sourceClosed = true;
      }
    } as typeof EventSource;
    try {
      const client = createHttpWorkbenchApiClient({
        daemonUrl: 'http://127.0.0.1:17456/',
        fetch: async (url, init) => jsonResponse(routeResponse(String(url), init))
      });
      await client.openProject({ projectRoot: '/tmp/project' });
      const terminalEvents: unknown[] = [];
      const errors: string[] = [];
      const subscription = client.subscribeTerminalEvents(
        'terminal-1',
        (event) => terminalEvents.push(event),
        (error) => errors.push(error.message)
      );

      terminalListener?.(new MessageEvent('terminal', {
        data: JSON.stringify({ type: 'closed', terminalId: 'terminal-1' })
      }));
      eventSource?.onerror?.(new Event('error'));

      subscription.close();

      expect(terminalEvents).toEqual([{ type: 'closed', terminalId: 'terminal-1' }]);
      expect(sourceClosed).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      globalThis.EventSource = originalEventSource;
    }
  });

  it('uses daemon import routes for external local paths and browser uploads', async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const uploadBody = new File(['page'], 'page.png');
    const client = createHttpWorkbenchApiClient({
      daemonUrl: 'http://127.0.0.1:17456/',
      token: 'secret',
      fetch: async (url, init) => {
        const parsed = new URL(String(url));
        requests.push({
          method: init?.method ?? 'GET',
          path: parsed.pathname,
          body: init?.body instanceof FormData
            ? formDataSummary(init.body)
            : init?.body instanceof ArrayBuffer || init?.body instanceof Uint8Array
            ? '<bytes>'
            : init?.body
              ? JSON.parse(String(init.body))
              : undefined
        });
        return jsonResponse(routeResponse(String(url), init));
      }
    });

    await client.openProject({ projectRoot: '/tmp/project' });
    await expect(client.importExternalLocalProjectPaths({
      sources: ['/external/cover.png'],
      targetDirectoryProjectRelativePath: 'assets',
      overwrite: true
    })).resolves.toMatchObject({
      results: [{ projectRelativePath: 'assets/cover.png', kind: 'file', status: 'ok' }]
    });
    await expect(client.importExternalProjectUploads({
      targetDirectoryProjectRelativePath: 'assets',
      entries: [
        { kind: 'directory', projectRelativePath: 'assets/pages' },
        { kind: 'file', projectRelativePath: 'assets/pages/page.png', file: uploadBody }
      ],
      overwrite: true
    })).resolves.toMatchObject({
      results: [
        { projectRelativePath: 'assets/pages', kind: 'directory', status: 'ok' },
        { projectRelativePath: 'assets/pages/page.png', kind: 'file', status: 'ok' }
      ]
    });

    expect(requests).toContainEqual({
      method: 'POST',
      path: `/api/projects/${projectId}/files/import/local`,
      body: {
        baseRevision: 1,
        sources: ['/external/cover.png'],
        targetDirectoryProjectRelativePath: 'assets',
        overwrite: true
      }
    });
    expect(requests).toContainEqual({
      method: 'POST',
      path: `/api/projects/${projectId}/files/import/uploads`,
      body: {
        plan: {
          baseRevision: 2,
          targetDirectoryProjectRelativePath: 'assets',
          overwrite: true,
          entries: [
            { kind: 'directory', projectRelativePath: 'assets/pages' },
            { kind: 'file', projectRelativePath: 'assets/pages/page.png', fileField: 'file:1' }
          ]
        },
        files: [{ field: 'file:1', name: 'page.png', size: 4 }]
      }
    });
  });

  it('sends the current project revision as baseRevision for shared-state mutations', async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const client = createHttpWorkbenchApiClient({
      daemonUrl: 'http://127.0.0.1:17456/',
      token: 'secret',
      fetch: async (url, init) => {
        const parsed = new URL(String(url));
        requests.push({
          method: init?.method ?? 'GET',
          path: parsed.pathname,
          body: init?.body ? JSON.parse(String(init.body)) : undefined
        });
        return jsonResponse(routeResponse(String(url), init));
      }
    });

    await client.openProject({ projectRoot: '/tmp/project' });
    await client.createProjectFile({ parentProjectRelativePath: '', name: 'first.md' });
    await client.renameCanvas({ canvasId: 'canvas-1', nextCanvasId: 'storyboard' });

    expect(requests).toContainEqual({
      method: 'POST',
      path: `/api/projects/${projectId}/files`,
      body: {
        baseRevision: 1,
        kind: 'file',
        parentProjectRelativePath: '',
        name: 'first.md'
      }
    });
    expect(requests).toContainEqual({
      method: 'PATCH',
      path: `/api/projects/${projectId}/canvases/canvas-1`,
      body: {
        baseRevision: 2,
        operation: 'rename',
        nextCanvasId: 'storyboard'
      }
    });
  });

  it('updates its base revision from project events before the next mutation', async () => {
    const requests: Array<{ path: string; body?: unknown }> = [];
    let eventSourceInstance: { onmessage: ((event: MessageEvent) => void) | null; close(): void } | undefined;
    const originalEventSource = globalThis.EventSource;
    globalThis.EventSource = class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor() {
        eventSourceInstance = this;
      }
      close() {}
    } as typeof EventSource;
    try {
      const client = createHttpWorkbenchApiClient({
        daemonUrl: 'http://127.0.0.1:17456/',
        fetch: async (url, init) => {
          const parsed = new URL(String(url));
          requests.push({
            path: parsed.pathname,
            body: init?.body ? JSON.parse(String(init.body)) : undefined
          });
          return jsonResponse(routeResponse(String(url), init));
        }
      });
      client.onEvent(() => undefined);
      await client.openProject({ projectRoot: '/tmp/project' });
      eventSourceInstance!.onmessage!(new MessageEvent('message', {
        data: JSON.stringify({
          type: 'project.changed',
          projectId,
          projectRevision: 7,
          snapshot: workbenchSnapshot()
        })
      }));

      await client.createCanvas();

      expect(requests).toContainEqual({
        path: `/api/projects/${projectId}/canvases`,
        body: { baseRevision: 7 }
      });
    } finally {
      globalThis.EventSource = originalEventSource;
    }
  });

  it('updates its base revision from stale mutation responses before the next mutation', async () => {
    const requests: Array<{ path: string; body?: unknown }> = [];
    let staleResponseSent = false;
    const client = createHttpWorkbenchApiClient({
      daemonUrl: 'http://127.0.0.1:17456/',
      fetch: async (url, init) => {
        const parsed = new URL(String(url));
        requests.push({
          path: parsed.pathname,
          body: init?.body ? JSON.parse(String(init.body)) : undefined
        });
        if (parsed.pathname === `/api/projects/${projectId}/files` && !staleResponseSent) {
          staleResponseSent = true;
          return staleRevisionResponse(4);
        }
        return jsonResponse(routeResponse(String(url), init));
      }
    });

    await client.openProject({ projectRoot: '/tmp/project' });
    await expect(client.createProjectFile({
      parentProjectRelativePath: '',
      name: 'first.md'
    })).rejects.toThrow('Project revision is stale.');
    await client.createProjectFile({
      parentProjectRelativePath: '',
      name: 'second.md'
    });

    expect(requests.filter((request) => request.path === `/api/projects/${projectId}/files`).map((request) => request.body)).toEqual([
      {
        baseRevision: 1,
        kind: 'file',
        parentProjectRelativePath: '',
        name: 'first.md'
      },
      {
        baseRevision: 4,
        kind: 'file',
        parentProjectRelativePath: '',
        name: 'second.md'
      }
    ]);
  });

  it('updates its base revision from stale upload import responses before the next upload', async () => {
    const requests: Array<{ path: string; body?: unknown }> = [];
    let staleResponseSent = false;
    const client = createHttpWorkbenchApiClient({
      daemonUrl: 'http://127.0.0.1:17456/',
      fetch: async (url, init) => {
        const parsed = new URL(String(url));
        requests.push({
          path: parsed.pathname,
          body: init?.body instanceof FormData
            ? formDataSummary(init.body)
            : init?.body
              ? JSON.parse(String(init.body))
              : undefined
        });
        if (parsed.pathname === `/api/projects/${projectId}/files/import/uploads` && !staleResponseSent) {
          staleResponseSent = true;
          return staleRevisionResponse(5);
        }
        return jsonResponse(routeResponse(String(url), init));
      }
    });
    const uploadBody = new File(['page'], 'page.png');
    const input = {
      targetDirectoryProjectRelativePath: 'assets',
      entries: [{ kind: 'file' as const, projectRelativePath: 'assets/page.png', file: uploadBody }]
    };

    await client.openProject({ projectRoot: '/tmp/project' });
    await expect(client.importExternalProjectUploads(input)).rejects.toThrow('Project revision is stale.');
    await client.importExternalProjectUploads(input);

    expect(requests.filter((request) => request.path === `/api/projects/${projectId}/files/import/uploads`).map((request) => request.body)).toEqual([
      {
        plan: {
          baseRevision: 1,
          targetDirectoryProjectRelativePath: 'assets',
          entries: [{ kind: 'file', projectRelativePath: 'assets/page.png', fileField: 'file:0' }]
        },
        files: [{ field: 'file:0', name: 'page.png', size: 4 }]
      },
      {
        plan: {
          baseRevision: 5,
          targetDirectoryProjectRelativePath: 'assets',
          entries: [{ kind: 'file', projectRelativePath: 'assets/page.png', fileField: 'file:0' }]
        },
        files: [{ field: 'file:0', name: 'page.png', size: 4 }]
      }
    ]);
  });

  it('binds the desktop shell window whenever the current project changes', async () => {
    const boundProjectIds: string[] = [];
    const secondProjectId = '22222222-2222-4222-8222-222222222222';
    const client = createHttpWorkbenchApiClient({
      daemonUrl: 'http://127.0.0.1:17456/',
      fetch: async (url, init) => jsonResponse(routeResponse(String(url), init)),
      shell: {
        chooseProjectRoot: async () => undefined,
        bindProjectWindowToProject: async (input) => {
          boundProjectIds.push(input.projectId);
          return { ok: true };
        }
      }
    });

    await client.openProject({ projectRoot: '/tmp/project' });
    await client.openProject({ projectId: secondProjectId });

    expect(boundProjectIds).toEqual([projectId, secondProjectId]);
  });

  it('delegates Electron-loaded project opening to the desktop shell instead of posting directly to the daemon', async () => {
    const openedFromShell: Array<{ forceNewWindow: boolean }> = [];
    const requests: string[] = [];
    const client = createHttpWorkbenchApiClient({
      daemonUrl: 'http://127.0.0.1:17456/',
      fetch: async (url, init) => {
        requests.push(`${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`);
        return jsonResponse(routeResponse(String(url), init));
      },
      shell: {
        chooseProjectRoot: async () => {
          throw new Error('Renderer should not pick project roots for Electron opens.');
        },
        openProject: async (input) => {
          openedFromShell.push({ forceNewWindow: input.forceNewWindow });
          return { opened: true };
        }
      }
    });

    await expect(client.openProjectFromShell({ forceNewWindow: false })).resolves.toEqual({ opened: true });

    expect(openedFromShell).toEqual([{ forceNewWindow: false }]);
    expect(requests).toEqual([]);
  });
});

function formDataSummary(formData: FormData): unknown {
  const plan = JSON.parse(String(formData.get('plan')));
  const files = Array.from(formData.entries())
    .filter(([field]) => field !== 'plan')
    .map(([field, value]) => {
      const file = value as File;
      return { field, name: file.name, size: file.size };
    });
  return { plan, files };
}

function routeResponse(url: string, init?: RequestInit): unknown {
  const path = new URL(url).pathname;
  if (path === '/api/runtime') {
    return {
      daemonUrl: 'http://127.0.0.1:17456',
      webBaseUrl: 'http://127.0.0.1:17456',
      platform: 'darwin'
    };
  }
  if (path === '/api/projects/open') {
    return { projectId, projectRevision: 1, snapshot: workbenchSnapshot() };
  }
  const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(path);
  if (projectMatch?.[1]) {
    return { projectId: decodeURIComponent(projectMatch[1]), projectRevision: 1, snapshot: workbenchSnapshot() };
  }
  if (path === `/api/projects/${projectId}/refresh`) {
    return { projectId, projectRevision: 2, snapshot: workbenchSnapshot() };
  }
  if (path === `/api/projects/${projectId}/terminals`) {
    const session = {
      id: 'terminal-1',
      title: 'src',
      cwdProjectRelativePath: 'src',
      cols: 100,
      rows: 32,
      status: 'running',
      exitCode: null,
      signal: null,
      createdAt: '2026-06-12T00:00:00.000Z',
      updatedAt: '2026-06-12T00:00:00.000Z',
      restartCount: 0
    };
    return init?.method === 'POST' ? { session } : { sessions: [session] };
  }
  if (path.startsWith(`/api/projects/${projectId}/terminals/`)) {
    return path.endsWith('/resize') || path.endsWith('/restart')
      ? {
          session: {
            id: 'terminal-1',
            title: 'src',
            cwdProjectRelativePath: 'src',
            cols: 120,
            rows: 40,
            status: 'running',
            exitCode: null,
            signal: null,
            createdAt: '2026-06-12T00:00:00.000Z',
            updatedAt: '2026-06-12T00:00:00.000Z',
            restartCount: path.endsWith('/restart') ? 1 : 0
          }
        }
      : { ok: true };
  }
  if (path === `/api/projects/${projectId}/files`) {
    return {
      projectId,
      projectRevision: 2,
      projectRelativePath: 'first.md',
      kind: 'file',
      status: 'ok',
      snapshot: workbenchSnapshot()
    };
  }
  if (path === `/api/projects/${projectId}/files/path/batch/copy-path`) {
    return { paths: ['/tmp/project/briefs/outline.md', '/tmp/project/assets'] };
  }
  if (path === `/api/projects/${projectId}/files/path/briefs/outline.md/reveal`) {
    return { ok: true };
  }
  if (path === `/api/projects/${projectId}/files/path/batch/trash`) {
    return {
      projectId,
      projectRevision: 2,
      results: [{ sourceProjectRelativePath: 'assets/cover.png', projectRelativePath: 'assets/cover.png', kind: 'file', status: 'ok' }],
      snapshot: workbenchSnapshot()
    };
  }
  if (path === `/api/projects/${projectId}/files/import/local`) {
    return {
      projectId,
      projectRevision: 2,
      results: [{ sourceProjectRelativePath: '/external/cover.png', projectRelativePath: 'assets/cover.png', kind: 'file', status: 'ok' }],
      snapshot: workbenchSnapshot()
    };
  }
  if (path === `/api/projects/${projectId}/files/import/uploads`) {
    return {
      projectId,
      projectRevision: 3,
      results: [
        { sourceProjectRelativePath: 'assets/pages', projectRelativePath: 'assets/pages', kind: 'directory', status: 'ok' },
        { sourceProjectRelativePath: 'assets/pages/page.png', projectRelativePath: 'assets/pages/page.png', kind: 'file', status: 'ok' }
      ],
      snapshot: workbenchSnapshot()
    };
  }
  if (path.endsWith('/files/text/briefs/outline.md') && (init?.method ?? 'GET') === 'GET') {
    return { projectRelativePath: 'briefs/outline.md', content: '# Outline', language: 'markdown', mimeType: 'text/markdown', revision: 'rev' };
  }
  if (path.endsWith('/files/text/briefs/outline.md') && init?.method === 'PUT') {
    return {
      projectId,
      projectRevision: 2,
      file: { projectRelativePath: 'briefs/outline.md', content: '# Outline', language: 'markdown', mimeType: 'text/markdown', revision: 'rev2' }
    };
  }
  if (path === `/api/projects/${projectId}/canvases`) {
    return {
      projectId,
      projectRevision: 8,
      snapshot: workbenchSnapshot(),
      activeCanvasId: 'canvas-1'
    };
  }
  if (path === `/api/projects/${projectId}/canvases/canvas-1`) {
    return {
      projectId,
      projectRevision: 3,
      snapshot: workbenchSnapshot(),
      activeCanvasId: 'storyboard'
    };
  }
  if (path.endsWith('/generated-assets/asset-1')) {
    return { assetId: 'asset-1', projectRelativePath: 'generated/cover.png', rawUrl: 'raw', record: { recordId: 'asset-1' } };
  }
  return {};
}

function workbenchSnapshot(): WorkbenchProjectSessionSnapshot {
  return {
    metadata: {
      schemaVersion: 1,
      project: {
        id: 'project-record-id',
        name: 'Test Project',
        createdAt: '2026-06-12T00:00:00.000Z',
        updatedAt: '2026-06-12T00:00:00.000Z'
      }
    },
    files: [],
    canvases: [],
    projections: [],
    diagnostics: [],
    canvasRegistry: { status: 'ready', canvasOrder: ['canvas-1'] },
    health: {
      projectName: 'Test Project',
      canvasCount: 0,
      diagnosticCounts: {
        errors: 0,
        warnings: 0,
        infos: 0
      },
      runtimeDataLocation: 'debrute-home',
      checkedAt: '2026-06-02T00:00:00.000Z'
    }
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function staleRevisionResponse(projectRevision: number): Response {
  return new Response(JSON.stringify({
    error: {
      code: 'stale_project_revision',
      message: 'Project revision is stale.',
      details: {
        projectId,
        projectRevision,
        snapshot: workbenchSnapshot()
      }
    }
  }), {
    status: 409,
    headers: { 'content-type': 'application/json' }
  });
}
