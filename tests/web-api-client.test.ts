import { describe, expect, it } from 'vitest';
import type { RunIntegrationOperationResult, WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import { createHttpWorkbenchApiClient } from '../apps/web/src/api/httpWorkbenchApiClient';

const projectId = '123e4567-e89b-42d3-a456-426614174000';

describe('HTTP workbench API client', () => {
  it('reads the daemon runtime platform instead of guessing from the browser', async () => {
    const requests: Array<{ method: string; path: string }> = [];
    const client = createHttpWorkbenchApiClient({
      fetch: async (url, init) => {
        const parsed = new URL(String(url), 'http://127.0.0.1:17456');
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
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        const body = routeResponse(String(url), init);
        if (new URL(String(url), 'http://127.0.0.1:17456').pathname === '/api/projects/open') {
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
      ['POST', '/api/projects/open'],
      ['GET', `/api/projects/${projectId}/files/text/briefs/outline.md`],
      ['PUT', `/api/projects/${projectId}/files/text/briefs/outline.md`],
      ['GET', `/api/projects/${projectId}/generated-assets/asset-1`]
    ]);
    expect(JSON.stringify(requests)).not.toContain('x-debrute-daemon-token');
  });

  it('runs integration operations through daemon HTTP routes', async () => {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const client = createHttpWorkbenchApiClient({
      fetch: async (url, init) => {
        const parsed = new URL(String(url), 'http://127.0.0.1:17456');
        requests.push({
          method: init?.method ?? 'GET',
          path: parsed.pathname,
          body: init?.body ? JSON.parse(String(init.body)) : undefined
        });
        return jsonResponse({
          ok: true,
          integrationId: 'imagemagick',
          operation: 'install',
          settings: { integrations: [], backends: [] }
        } satisfies RunIntegrationOperationResult);
      }
    });

    await expect(client.integrationsRunOperation({ integrationId: 'imagemagick', operation: 'install' })).resolves.toMatchObject({
      ok: true,
      integrationId: 'imagemagick',
      operation: 'install'
    });
    expect(requests).toEqual([{
      method: 'POST',
      path: '/api/integrations/imagemagick/install',
      body: {}
    }]);
  });

  it('does not bootstrap or send daemon tokens from browser requests', async () => {
    const requests: Array<{ method: string; path: string; headers?: RequestInit['headers'] }> = [];
    const client = createHttpWorkbenchApiClient({
      fetch: async (url, init) => {
        const parsed = new URL(String(url), 'http://127.0.0.1:17456');
        requests.push({ method: init?.method ?? 'GET', path: parsed.pathname, headers: init?.headers });
        return jsonResponse(routeResponse(String(url), init));
      }
    });

    await client.openProject({ projectRoot: '/tmp/project' });
    await client.readProjectTextFile('briefs/outline.md');

    expect(requests.map((request) => [request.method, request.path])).toEqual([
      ['POST', '/api/projects/open'],
      ['GET', `/api/projects/${projectId}/files/text/briefs/outline.md`]
    ]);
    expect(JSON.stringify(requests)).not.toContain('x-debrute-daemon-token');
  });

  it('opens projects from the daemon picker and tracks the opened project', async () => {
    const requests: Array<{ method: string; path: string; headers?: RequestInit['headers'] }> = [];
    const client = createHttpWorkbenchApiClient({
      fetch: async (url, init) => {
        const parsed = new URL(String(url), 'http://127.0.0.1:17456');
        requests.push({ method: init?.method ?? 'GET', path: parsed.pathname, headers: init?.headers });
        return jsonResponse(routeResponse(String(url), init));
      }
    });

    await expect(client.openProjectFromPicker()).resolves.toMatchObject({
      opened: true,
      projectId,
      snapshot: { metadata: { project: { name: 'Test Project' } } }
    });
    await client.readProjectTextFile('briefs/outline.md');

    expect(requests.map((request) => [request.method, request.path])).toEqual([
      ['POST', '/api/projects/open-picker'],
      ['GET', `/api/projects/${projectId}/files/text/briefs/outline.md`]
    ]);
    expect(JSON.stringify(requests)).not.toContain('x-debrute-daemon-token');
  });

  it('keeps the newest project when concurrent open requests resolve out of order', async () => {
    const projectA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const projectB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    let resolveProjectA!: (response: Response) => void;
    let resolveProjectB!: (response: Response) => void;
    const projectAResponse = new Promise<Response>((resolve) => { resolveProjectA = resolve; });
    const projectBResponse = new Promise<Response>((resolve) => { resolveProjectB = resolve; });
    const mutationRequests: Array<{ path: string; body?: unknown }> = [];
    const client = createHttpWorkbenchApiClient({
      fetch: async (url, init) => {
        const parsed = new URL(String(url), 'http://127.0.0.1:17456');
        if (parsed.pathname === '/api/projects/open') {
          const body = init?.body ? JSON.parse(String(init.body)) as { projectRoot?: string } : {};
          return body.projectRoot === '/tmp/project-a' ? projectAResponse : projectBResponse;
        }
        if (parsed.pathname === `/api/projects/${projectB}/files`) {
          mutationRequests.push({
            path: parsed.pathname,
            body: init?.body ? JSON.parse(String(init.body)) : undefined
          });
          return jsonResponse({
            projectId: projectB,
            projectRevision: 11,
            projectRelativePath: 'project-b.md',
            kind: 'file',
            snapshot: workbenchSnapshot()
          });
        }
        throw new Error(`Unexpected request: ${parsed.pathname}`);
      }
    });

    const openProjectA = client.openProject({ projectRoot: '/tmp/project-a' });
    const openProjectB = client.openProject({ projectRoot: '/tmp/project-b' });
    resolveProjectB(jsonResponse({ projectId: projectB, projectRevision: 10, snapshot: workbenchSnapshot() }));
    await expect(openProjectB).resolves.toMatchObject({ projectId: projectB });
    resolveProjectA(jsonResponse({ projectId: projectA, projectRevision: 1, snapshot: workbenchSnapshot() }));
    await expect(openProjectA).rejects.toThrow('Another project open request completed first.');

    await client.createProjectFile({ parentProjectRelativePath: '', name: 'project-b.md' });
    expect(mutationRequests).toEqual([{
      path: `/api/projects/${projectB}/files`,
      body: {
        baseRevision: 10,
        kind: 'file',
        parentProjectRelativePath: '',
        name: 'project-b.md'
      }
    }]);
  });

  it('serializes native window binding with the latest project open commit', async () => {
    const projectA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const projectB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    let resolveProjectABind!: () => void;
    let resolveProjectBBind!: () => void;
    let resolveProjectABindStarted!: () => void;
    let resolveProjectBBindStarted!: () => void;
    const projectABind = new Promise<void>((resolve) => { resolveProjectABind = resolve; });
    const projectBBind = new Promise<void>((resolve) => { resolveProjectBBind = resolve; });
    const projectABindStarted = new Promise<void>((resolve) => { resolveProjectABindStarted = resolve; });
    const projectBBindStarted = new Promise<void>((resolve) => { resolveProjectBBindStarted = resolve; });
    const bindCalls: string[] = [];
    const mutationRequests: Array<{ path: string; body?: unknown }> = [];
    const client = createHttpWorkbenchApiClient({
      fetch: async (url, init) => {
        const parsed = new URL(String(url), 'http://127.0.0.1:17456');
        if (parsed.pathname === `/api/projects/${projectA}`) {
          return jsonResponse({ projectId: projectA, projectRevision: 1, snapshot: workbenchSnapshot() });
        }
        if (parsed.pathname === `/api/projects/${projectB}`) {
          return jsonResponse({ projectId: projectB, projectRevision: 10, snapshot: workbenchSnapshot() });
        }
        if (parsed.pathname === `/api/projects/${projectB}/files`) {
          mutationRequests.push({
            path: parsed.pathname,
            body: init?.body ? JSON.parse(String(init.body)) : undefined
          });
          return jsonResponse({
            projectId: projectB,
            projectRevision: 11,
            projectRelativePath: 'project-b.md',
            kind: 'file',
            snapshot: workbenchSnapshot()
          });
        }
        throw new Error(`Unexpected request: ${parsed.pathname}`);
      },
      shell: {
        bindProjectWindowToProject: async ({ projectId: bindingProjectId }) => {
          bindCalls.push(bindingProjectId);
          if (bindingProjectId === projectA) {
            resolveProjectABindStarted();
          } else {
            resolveProjectBBindStarted();
          }
          await (bindingProjectId === projectA ? projectABind : projectBBind);
          return { ok: true };
        }
      }
    });

    const openProjectA = client.openProject({ projectId: projectA });
    await projectABindStarted;
    expect(bindCalls).toEqual([projectA]);

    const openProjectB = client.openProject({ projectId: projectB });
    await Promise.resolve();
    await Promise.resolve();
    expect(bindCalls).toEqual([projectA]);

    resolveProjectABind();
    await expect(openProjectA).resolves.toMatchObject({ projectId: projectA });
    await projectBBindStarted;
    expect(bindCalls).toEqual([projectA, projectB]);

    resolveProjectBBind();
    await expect(openProjectB).resolves.toMatchObject({ projectId: projectB });
    await client.createProjectFile({ parentProjectRelativePath: '', name: 'project-b.md' });

    expect(mutationRequests).toEqual([{
      path: `/api/projects/${projectB}/files`,
      body: {
        baseRevision: 10,
        kind: 'file',
        parentProjectRelativePath: '',
        name: 'project-b.md'
      }
    }]);
  });

  it('keeps a binding transaction valid when a newer project request fails to open', async () => {
    const projectA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const projectB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    let resolveProjectABind!: () => void;
    let resolveProjectABindStarted!: () => void;
    const projectABind = new Promise<void>((resolve) => { resolveProjectABind = resolve; });
    const projectABindStarted = new Promise<void>((resolve) => { resolveProjectABindStarted = resolve; });
    const mutationRequests: Array<{ path: string; body?: unknown }> = [];
    const client = createHttpWorkbenchApiClient({
      fetch: async (url, init) => {
        const parsed = new URL(String(url), 'http://127.0.0.1:17456');
        if (parsed.pathname === `/api/projects/${projectA}`) {
          return jsonResponse({ projectId: projectA, projectRevision: 1, snapshot: workbenchSnapshot() });
        }
        if (parsed.pathname === `/api/projects/${projectB}`) {
          throw new Error('Project B failed to open.');
        }
        if (parsed.pathname === `/api/projects/${projectA}/files`) {
          mutationRequests.push({
            path: parsed.pathname,
            body: init?.body ? JSON.parse(String(init.body)) : undefined
          });
          return jsonResponse({
            projectId: projectA,
            projectRevision: 2,
            projectRelativePath: 'project-a.md',
            kind: 'file',
            snapshot: workbenchSnapshot()
          });
        }
        throw new Error(`Unexpected request: ${parsed.pathname}`);
      },
      shell: {
        bindProjectWindowToProject: async ({ projectId: bindingProjectId }) => {
          if (bindingProjectId !== projectA) {
            throw new Error(`Unexpected binding: ${bindingProjectId}`);
          }
          resolveProjectABindStarted();
          await projectABind;
          return { ok: true };
        }
      }
    });

    const openProjectA = client.openProject({ projectId: projectA });
    await projectABindStarted;
    await expect(client.openProject({ projectId: projectB })).rejects.toThrow('Project B failed to open.');
    resolveProjectABind();
    await expect(openProjectA).resolves.toMatchObject({ projectId: projectA });
    await client.createProjectFile({ parentProjectRelativePath: '', name: 'project-a.md' });

    expect(mutationRequests).toEqual([{
      path: `/api/projects/${projectA}/files`,
      body: {
        baseRevision: 1,
        kind: 'file',
        parentProjectRelativePath: '',
        name: 'project-a.md'
      }
    }]);
  });

  it('keeps the client unopened when the daemon picker is canceled', async () => {
    const client = createHttpWorkbenchApiClient({
      fetch: async (url) => {
        const parsed = new URL(String(url), 'http://127.0.0.1:17456');
        if (parsed.pathname === '/api/projects/open-picker') {
          return jsonResponse({ opened: false });
        }
        return jsonResponse(routeResponse(String(url)));
      }
    });

    await expect(client.openProjectFromPicker()).resolves.toEqual({ opened: false });
    expect(() => client.readProjectTextFile('briefs/outline.md')).toThrow('Debrute project is not open.');
  });

  it('opens the global event stream before adding the project event stream for an opaque project id', async () => {
    const eventSourceUrls: string[] = [];
    const client = createHttpWorkbenchApiClient({
      fetch: async (url, init) => {
        const body = routeResponse(String(url), init);
        if (new URL(String(url), 'http://127.0.0.1:17456').pathname === '/api/projects/open') {
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
      expect(eventSourceUrls).toHaveLength(1);
      const globalEventUrl = new URL(eventSourceUrls[0]!, 'http://127.0.0.1:17456');
      expect(globalEventUrl.pathname).toBe('/api/workbench/events');
      expect(globalEventUrl.searchParams.get('clientId')).toMatch(/^web:/);
      expect([...globalEventUrl.searchParams.keys()]).toEqual(['clientId']);

      await client.openProject({ projectRoot: '/tmp/project' });
      expect(eventSourceUrls).toHaveLength(2);
      const eventUrl = new URL(eventSourceUrls[1]!, 'http://127.0.0.1:17456');
      expect(eventUrl.pathname).toBe(`/api/projects/${projectId}/events`);
      const clientId = eventUrl.searchParams.get('clientId');
      expect(clientId).not.toBeNull();
      expect(clientId!).toMatch(/^web:/);
      expect([...eventUrl.searchParams.keys()]).toEqual(['clientId']);

      unsubscribe();
    } finally {
      globalThis.EventSource = originalEventSource;
    }
  });

  it('uses the daemon route to copy absolute project path batches', async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const client = createHttpWorkbenchApiClient({
      fetch: async (url, init) => {
        const parsed = new URL(String(url), 'http://127.0.0.1:17456');
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
      fetch: async (url, init) => {
        const parsed = new URL(String(url), 'http://127.0.0.1:17456');
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
        fetch: async (url, init) => {
          const parsed = new URL(String(url), 'http://127.0.0.1:17456');
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
        { method: 'DELETE', path: `/api/projects/${projectId}/terminals/terminal-1`, body: undefined }
      ]));
      expect(eventSourceUrls).toHaveLength(1);
      const eventUrl = new URL(eventSourceUrls[0]!, 'http://127.0.0.1:17456');
      expect(eventUrl.pathname).toBe(`/api/projects/${projectId}/terminals/terminal-1/events`);
      expect([...eventUrl.searchParams.keys()]).toEqual([]);
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
      fetch: async (url, init) => {
        const parsed = new URL(String(url), 'http://127.0.0.1:17456');
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
      fetch: async (url, init) => {
        const parsed = new URL(String(url), 'http://127.0.0.1:17456');
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
    await client.renameCanvas({ canvasId: 'canvas-1', name: 'Storyboard' });

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
        name: 'Storyboard'
      }
    });
  });

  it('serializes shared-state mutations so each uses the latest project revision', async () => {
    const mutationRequests: Array<{ path: string; body?: unknown }> = [];
    let resolveFirstMutation: ((response: Response) => void) | undefined;
    const firstMutationResponse = new Promise<Response>((resolve) => {
      resolveFirstMutation = resolve;
    });
    const client = createHttpWorkbenchApiClient({
      fetch: async (url, init) => {
        const parsed = new URL(String(url), 'http://127.0.0.1:17456');
        if (parsed.pathname === '/api/projects/open') {
          return jsonResponse(routeResponse(String(url), init));
        }
        if (parsed.pathname === `/api/projects/${projectId}/files`) {
          mutationRequests.push({
            path: parsed.pathname,
            body: init?.body ? JSON.parse(String(init.body)) : undefined
          });
          return firstMutationResponse;
        }
        if (parsed.pathname === `/api/projects/${projectId}/canvases/canvas-1`) {
          mutationRequests.push({
            path: parsed.pathname,
            body: init?.body ? JSON.parse(String(init.body)) : undefined
          });
          return jsonResponse(routeResponse(String(url), init));
        }
        return jsonResponse(routeResponse(String(url), init));
      }
    });

    await client.openProject({ projectRoot: '/tmp/project' });
    const firstMutation = client.createProjectFile({ parentProjectRelativePath: '', name: 'first.md' });
    const secondMutation = client.renameCanvas({ canvasId: 'canvas-1', name: 'Storyboard' });

    await Promise.resolve();

    expect(mutationRequests).toEqual([{
      path: `/api/projects/${projectId}/files`,
      body: {
        baseRevision: 1,
        kind: 'file',
        parentProjectRelativePath: '',
        name: 'first.md'
      }
    }]);

    resolveFirstMutation!(jsonResponse({
      projectId,
      projectRevision: 2,
      projectRelativePath: 'first.md',
      kind: 'file',
      status: 'ok',
      snapshot: workbenchSnapshot()
    }));
    await Promise.all([firstMutation, secondMutation]);

    expect(mutationRequests).toEqual([
      {
        path: `/api/projects/${projectId}/files`,
        body: {
          baseRevision: 1,
          kind: 'file',
          parentProjectRelativePath: '',
          name: 'first.md'
        }
      },
      {
        path: `/api/projects/${projectId}/canvases/canvas-1`,
        body: {
          baseRevision: 2,
          operation: 'rename',
          name: 'Storyboard'
        }
      }
    ]);
  });

  it('invalidates in-flight and queued mutations when another project opens', async () => {
    const projectA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const projectB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const mutationRequests: Array<{ path: string; body?: unknown }> = [];
    let resolveProjectAMutation!: (response: Response) => void;
    const projectAMutationResponse = new Promise<Response>((resolve) => {
      resolveProjectAMutation = resolve;
    });
    const client = createHttpWorkbenchApiClient({
      fetch: async (url, init) => {
        const parsed = new URL(String(url), 'http://127.0.0.1:17456');
        if (parsed.pathname === '/api/projects/open') {
          return jsonResponse({ projectId: projectA, projectRevision: 1, snapshot: workbenchSnapshot() });
        }
        if (parsed.pathname === `/api/projects/${projectB}`) {
          return jsonResponse({ projectId: projectB, projectRevision: 10, snapshot: workbenchSnapshot() });
        }
        if (parsed.pathname === `/api/projects/${projectA}/files`) {
          mutationRequests.push({
            path: parsed.pathname,
            body: init?.body ? JSON.parse(String(init.body)) : undefined
          });
          return projectAMutationResponse;
        }
        if (parsed.pathname === `/api/projects/${projectB}/files`) {
          mutationRequests.push({
            path: parsed.pathname,
            body: init?.body ? JSON.parse(String(init.body)) : undefined
          });
          return jsonResponse({
            projectId: projectB,
            projectRevision: 11,
            projectRelativePath: 'project-b.md',
            kind: 'file',
            snapshot: workbenchSnapshot()
          });
        }
        throw new Error(`Unexpected request: ${parsed.pathname}`);
      }
    });

    await client.openProject({ projectRoot: '/tmp/project-a' });
    const inFlightProjectA = client.createProjectFile({ parentProjectRelativePath: '', name: 'in-flight-a.md' });
    const queuedProjectA = client.createProjectFile({ parentProjectRelativePath: '', name: 'queued-a.md' });
    await Promise.resolve();

    await client.openProject({ projectId: projectB });
    resolveProjectAMutation(jsonResponse({
      projectId: projectA,
      projectRevision: 2,
      projectRelativePath: 'in-flight-a.md',
      kind: 'file',
      snapshot: workbenchSnapshot()
    }));

    await expect(inFlightProjectA).rejects.toThrow('Project changed while the request was in flight.');
    await expect(queuedProjectA).rejects.toThrow('Project changed before the request started.');
    await client.createProjectFile({ parentProjectRelativePath: '', name: 'project-b.md' });

    expect(mutationRequests).toEqual([
      {
        path: `/api/projects/${projectA}/files`,
        body: {
          baseRevision: 1,
          kind: 'file',
          parentProjectRelativePath: '',
          name: 'in-flight-a.md'
        }
      },
      {
        path: `/api/projects/${projectB}/files`,
        body: {
          baseRevision: 10,
          kind: 'file',
          parentProjectRelativePath: '',
          name: 'project-b.md'
        }
      }
    ]);
  });

  it('rejects a mutation response for a different project without accepting its revision', async () => {
    const projectA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const projectB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const mutationBodies: unknown[] = [];
    let mutationCount = 0;
    const client = createHttpWorkbenchApiClient({
      fetch: async (url, init) => {
        const parsed = new URL(String(url), 'http://127.0.0.1:17456');
        if (parsed.pathname === '/api/projects/open') {
          return jsonResponse({ projectId: projectA, projectRevision: 1, snapshot: workbenchSnapshot() });
        }
        if (parsed.pathname === `/api/projects/${projectA}/files`) {
          mutationCount += 1;
          mutationBodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
          return jsonResponse({
            projectId: mutationCount === 1 ? projectB : projectA,
            projectRevision: mutationCount === 1 ? 50 : 2,
            projectRelativePath: mutationCount === 1 ? 'wrong.md' : 'right.md',
            kind: 'file',
            snapshot: workbenchSnapshot()
          });
        }
        throw new Error(`Unexpected request: ${parsed.pathname}`);
      }
    });

    await client.openProject({ projectRoot: '/tmp/project-a' });
    await expect(client.createProjectFile({ parentProjectRelativePath: '', name: 'wrong.md' }))
      .rejects.toThrow(`Project response ${projectB} does not match request project ${projectA}.`);
    await client.createProjectFile({ parentProjectRelativePath: '', name: 'right.md' });

    expect(mutationBodies).toEqual([
      { baseRevision: 1, kind: 'file', parentProjectRelativePath: '', name: 'wrong.md' },
      { baseRevision: 1, kind: 'file', parentProjectRelativePath: '', name: 'right.md' }
    ]);
  });

  it('serializes Canvas text viewport mutations with other shared-state mutations', async () => {
    const mutationRequests: Array<{ path: string; body?: unknown }> = [];
    let resolveFirstMutation: ((response: Response) => void) | undefined;
    const firstMutationResponse = new Promise<Response>((resolve) => {
      resolveFirstMutation = resolve;
    });
    const client = createHttpWorkbenchApiClient({
      fetch: async (url, init) => {
        const parsed = new URL(String(url), 'http://127.0.0.1:17456');
        if (parsed.pathname === '/api/projects/open') {
          return jsonResponse(routeResponse(String(url), init));
        }
        if (parsed.pathname === `/api/projects/${projectId}/files`) {
          mutationRequests.push({
            path: parsed.pathname,
            body: init?.body ? JSON.parse(String(init.body)) : undefined
          });
          return firstMutationResponse;
        }
        if (parsed.pathname === `/api/projects/${projectId}/canvases/canvas-1/text-viewport`) {
          mutationRequests.push({
            path: parsed.pathname,
            body: init?.body ? JSON.parse(String(init.body)) : undefined
          });
          return jsonResponse({
            projectId,
            projectRevision: 3,
            canvas: { id: 'canvas-1', name: 'Canvas 1', nodeElements: [] },
            projection: { canvasId: 'canvas-1', nodes: [], edges: [] }
          });
        }
        return jsonResponse(routeResponse(String(url), init));
      }
    });

    await client.openProject({ projectRoot: '/tmp/project' });
    const firstMutation = client.createProjectFile({ parentProjectRelativePath: '', name: 'first.md' });
    const secondMutation = client.updateCanvasTextViewportState({
      canvasId: 'canvas-1',
      updates: [{ projectRelativePath: 'notes/a.md', scrollTop: 20, scrollLeft: 4 }]
    });

    await Promise.resolve();

    expect(mutationRequests).toEqual([{
      path: `/api/projects/${projectId}/files`,
      body: {
        baseRevision: 1,
        kind: 'file',
        parentProjectRelativePath: '',
        name: 'first.md'
      }
    }]);

    resolveFirstMutation!(jsonResponse({
      projectId,
      projectRevision: 2,
      projectRelativePath: 'first.md',
      kind: 'file',
      status: 'ok',
      snapshot: workbenchSnapshot()
    }));
    await Promise.all([firstMutation, secondMutation]);

    expect(mutationRequests).toEqual([
      {
        path: `/api/projects/${projectId}/files`,
        body: {
          baseRevision: 1,
          kind: 'file',
          parentProjectRelativePath: '',
          name: 'first.md'
        }
      },
      {
        path: `/api/projects/${projectId}/canvases/canvas-1/text-viewport`,
        body: {
          baseRevision: 2,
          updates: [{ projectRelativePath: 'notes/a.md', scrollTop: 20, scrollLeft: 4 }]
        }
      }
    ]);
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
        fetch: async (url, init) => {
          const parsed = new URL(String(url), 'http://127.0.0.1:17456');
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

  it('rejects a mutation response superseded by a newer project event without rolling back the base revision', async () => {
    const mutationBodies: unknown[] = [];
    const eventSources = captureEventSources();
    let resolveFirstMutation!: (response: Response) => void;
    const firstMutationResponse = new Promise<Response>((resolve) => {
      resolveFirstMutation = resolve;
    });
    let mutationCount = 0;
    try {
      const client = createHttpWorkbenchApiClient({
        fetch: async (url, init) => {
          const parsed = new URL(String(url), 'http://127.0.0.1:17456');
          if (parsed.pathname === '/api/projects/open') {
            return jsonResponse({ projectId, projectRevision: 1, snapshot: workbenchSnapshot() });
          }
          if (parsed.pathname === `/api/projects/${projectId}/files`) {
            mutationCount += 1;
            mutationBodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
            if (mutationCount === 1) {
              return firstMutationResponse;
            }
            return jsonResponse({
              projectId,
              projectRevision: 4,
              projectRelativePath: 'second.md',
              kind: 'file',
              snapshot: workbenchSnapshot()
            });
          }
          throw new Error(`Unexpected request: ${parsed.pathname}`);
        }
      });
      client.onEvent(() => undefined);
      await client.openProject({ projectRoot: '/tmp/project' });

      const firstMutation = client.createProjectFile({ parentProjectRelativePath: '', name: 'first.md' });
      await Promise.resolve();
      emitProjectChanged(eventSources.sources[1]!, projectId, 3);
      resolveFirstMutation(jsonResponse({
        projectId,
        projectRevision: 2,
        projectRelativePath: 'first.md',
        kind: 'file',
        snapshot: workbenchSnapshot()
      }));

      await expect(firstMutation).rejects.toMatchObject({ name: 'ProjectResponseSupersededError' });
      await client.createProjectFile({ parentProjectRelativePath: '', name: 'second.md' });

      expect(mutationBodies).toEqual([
        { baseRevision: 1, kind: 'file', parentProjectRelativePath: '', name: 'first.md' },
        { baseRevision: 3, kind: 'file', parentProjectRelativePath: '', name: 'second.md' }
      ]);
    } finally {
      eventSources.restore();
    }
  });

  it('ignores older project events while still delivering events at the current revision', async () => {
    const eventSources = captureEventSources();
    try {
      const client = createHttpWorkbenchApiClient({
        fetch: async (url, init) => jsonResponse(routeResponse(String(url), init))
      });
      const revisions: number[] = [];
      client.onEvent((event) => {
        if ('projectRevision' in event) {
          revisions.push(event.projectRevision);
        }
      });
      await client.openProject({ projectRoot: '/tmp/project' });
      const projectEvents = eventSources.sources[1]!;

      for (const revision of [7, 6, 7]) {
        emitProjectChanged(projectEvents, projectId, revision);
      }

      expect(revisions).toEqual([7, 7]);
    } finally {
      eventSources.restore();
    }
  });

  it('ignores events from a project stream that was replaced by another project', async () => {
    const projectA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const projectB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const requests: Array<{ path: string; body?: unknown }> = [];
    const eventSources = captureEventSources();
    try {
      const client = createHttpWorkbenchApiClient({
        fetch: async (url, init) => {
          const parsed = new URL(String(url), 'http://127.0.0.1:17456');
          requests.push({
            path: parsed.pathname,
            body: init?.body ? JSON.parse(String(init.body)) : undefined
          });
          if (parsed.pathname === '/api/projects/open') {
            return jsonResponse({ projectId: projectA, projectRevision: 1, snapshot: workbenchSnapshot() });
          }
          if (parsed.pathname === `/api/projects/${projectB}`) {
            return jsonResponse({ projectId: projectB, projectRevision: 10, snapshot: workbenchSnapshot() });
          }
          if (parsed.pathname === `/api/projects/${projectB}/files`) {
            return jsonResponse({
              projectId: projectB,
              projectRevision: 11,
              projectRelativePath: 'project-b.md',
              kind: 'file',
              snapshot: workbenchSnapshot()
            });
          }
          throw new Error(`Unexpected request: ${parsed.pathname}`);
        }
      });
      const projectEvents: unknown[] = [];
      client.onEvent((event) => projectEvents.push(event));
      await client.openProject({ projectRoot: '/tmp/project-a' });
      const projectAEventSource = eventSources.sources[1]!;
      await client.openProject({ projectId: projectB });

      emitProjectChanged(projectAEventSource, projectA, 99);
      await client.createProjectFile({ parentProjectRelativePath: '', name: 'project-b.md' });

      expect(projectEvents).toEqual([]);
      expect(requests).toContainEqual({
        path: `/api/projects/${projectB}/files`,
        body: {
          baseRevision: 10,
          kind: 'file',
          parentProjectRelativePath: '',
          name: 'project-b.md'
        }
      });
    } finally {
      eventSources.restore();
    }
  });

  it('updates its base revision from stale mutation responses before the next mutation', async () => {
    const requests: Array<{ path: string; body?: unknown }> = [];
    let staleResponseSent = false;
    const client = createHttpWorkbenchApiClient({
      fetch: async (url, init) => {
        const parsed = new URL(String(url), 'http://127.0.0.1:17456');
        requests.push({
          path: parsed.pathname,
          body: init?.body ? JSON.parse(String(init.body)) : undefined
        });
        if (parsed.pathname === `/api/projects/${projectId}/files` && !staleResponseSent) {
          staleResponseSent = true;
          return staleRevisionResponse(4);
        }
        if (parsed.pathname === `/api/projects/${projectId}/files`) {
          return jsonResponse({
            projectId,
            projectRevision: 5,
            projectRelativePath: 'second.md',
            kind: 'file',
            snapshot: workbenchSnapshot()
          });
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

  it('does not roll back its base revision from older stale mutation details', async () => {
    const mutationBodies: unknown[] = [];
    const eventSources = captureEventSources();
    let mutationCount = 0;
    try {
      const client = createHttpWorkbenchApiClient({
        fetch: async (url, init) => {
          const parsed = new URL(String(url), 'http://127.0.0.1:17456');
          if (parsed.pathname === '/api/projects/open') {
            return jsonResponse({ projectId, projectRevision: 1, snapshot: workbenchSnapshot() });
          }
          if (parsed.pathname === `/api/projects/${projectId}/files`) {
            mutationCount += 1;
            mutationBodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
            if (mutationCount === 1) {
              return staleRevisionResponse(4);
            }
            return jsonResponse({
              projectId,
              projectRevision: 8,
              projectRelativePath: 'second.md',
              kind: 'file',
              snapshot: workbenchSnapshot()
            });
          }
          throw new Error(`Unexpected request: ${parsed.pathname}`);
        }
      });
      client.onEvent(() => undefined);
      await client.openProject({ projectRoot: '/tmp/project' });
      emitProjectChanged(eventSources.sources[1]!, projectId, 7);

      await expect(client.createProjectFile({ parentProjectRelativePath: '', name: 'first.md' }))
        .rejects.toThrow('Project revision is stale.');
      await client.createProjectFile({ parentProjectRelativePath: '', name: 'second.md' });

      expect(mutationBodies).toEqual([
        { baseRevision: 7, kind: 'file', parentProjectRelativePath: '', name: 'first.md' },
        { baseRevision: 7, kind: 'file', parentProjectRelativePath: '', name: 'second.md' }
      ]);
    } finally {
      eventSources.restore();
    }
  });

  it('updates its base revision from stale upload import responses before the next upload', async () => {
    const requests: Array<{ path: string; body?: unknown }> = [];
    let staleResponseSent = false;
    const client = createHttpWorkbenchApiClient({
      fetch: async (url, init) => {
        const parsed = new URL(String(url), 'http://127.0.0.1:17456');
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
        if (parsed.pathname === `/api/projects/${projectId}/files/import/uploads`) {
          return jsonResponse({
            projectId,
            projectRevision: 6,
            results: [{
              sourceProjectRelativePath: 'assets/page.png',
              projectRelativePath: 'assets/page.png',
              kind: 'file',
              status: 'ok'
            }],
            snapshot: workbenchSnapshot()
          });
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
      fetch: async (url, init) => jsonResponse(routeResponse(String(url), init)),
      shell: {
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

  it('reads and clears Workbench title-bar state through daemon HTTP', async () => {
    const requests: Array<{ method: string; path: string; search: string }> = [];
    const client = createHttpWorkbenchApiClient({
      fetch: async (url, init) => {
        const parsed = new URL(String(url), 'http://127.0.0.1:17456');
        requests.push({ method: init?.method ?? 'GET', path: parsed.pathname, search: parsed.search });
        if (parsed.pathname === '/api/workbench/title-bar') {
          return jsonResponse({
            title: 'Test Project',
            recentProjectRoots: ['/tmp/project'],
            presentation: {
              platform: 'linux',
              host: parsed.searchParams.get('host') ?? 'web',
              showWebMenus: true,
              showWindowControls: false,
              trafficLightSpacer: false
            },
            menus: []
          });
        }
        return jsonResponse({ ok: true });
      }
    });

    await expect(client.getWorkbenchTitleBarState({ host: 'web', projectId })).resolves.toMatchObject({
      title: 'Test Project',
      recentProjectRoots: ['/tmp/project']
    });
    await expect(client.clearRecentProjectRoots()).resolves.toEqual({ ok: true });

    expect(requests).toEqual([
      { method: 'GET', path: '/api/workbench/title-bar', search: `?host=web&projectId=${projectId}` },
      { method: 'DELETE', path: '/api/workbench/recent-projects', search: '' }
    ]);
  });
});

interface CapturedEventSource {
  onmessage: ((event: MessageEvent) => void) | null;
  close(): void;
}

function captureEventSources(): { sources: CapturedEventSource[]; restore(): void } {
  const originalEventSource = globalThis.EventSource;
  const sources: CapturedEventSource[] = [];
  globalThis.EventSource = class {
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor() {
      sources.push(this);
    }
    close() {}
  } as typeof EventSource;
  return {
    sources,
    restore: () => {
      globalThis.EventSource = originalEventSource;
    }
  };
}

function emitProjectChanged(source: CapturedEventSource, eventProjectId: string, projectRevision: number): void {
  source.onmessage!(new MessageEvent('message', {
    data: JSON.stringify({
      type: 'project.changed',
      projectId: eventProjectId,
      projectRevision,
      snapshot: workbenchSnapshot()
    })
  }));
}

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
  const path = new URL(url, 'http://127.0.0.1:17456').pathname;
  if (path === '/api/runtime') {
    return {
      webBaseUrl: 'http://127.0.0.1:17456',
      platform: 'darwin'
    };
  }
  if (path === '/api/projects/open') {
    return { projectId, projectRevision: 1, snapshot: workbenchSnapshot() };
  }
  if (path === '/api/projects/open-picker') {
    return {
      opened: true,
      projectId,
      projectRevision: 1,
      snapshot: workbenchSnapshot()
    };
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
      updatedAt: '2026-06-12T00:00:00.000Z'
    };
    return init?.method === 'POST' ? { session } : { sessions: [session] };
  }
  if (path.startsWith(`/api/projects/${projectId}/terminals/`)) {
    return path.endsWith('/resize')
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
            updatedAt: '2026-06-12T00:00:00.000Z'
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
