import { describe, expect, it } from 'vitest';
import { createHttpWorkbenchApiClient } from './httpWorkbenchApiClient.js';
import type { RunIntegrationOperationResult } from '@debrute/app-protocol';
import { formDataSummary, jsonResponse, projectId, routeResponse, workbenchSnapshot } from './httpWorkbenchApiClient.testFixtures.js';

describe('HTTP workbench API client requests', () => {
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
        requests.push({ url: String(url), ...(init === undefined ? {} : { init }) });
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
    await client.writeProjectTextFile({
      projectRelativePath: 'briefs/outline.md',
      content: '# Outline',
      expectedRevision: 'rev'
    });
    await client.readGeneratedAsset('asset-1');

    expect(requests.map((request) => [request.init?.method ?? 'GET', request.url])).toEqual([
      ['POST', '/api/projects/open'],
      ['GET', `/api/projects/${projectId}/files/text/briefs/outline.md`],
      ['PUT', `/api/projects/${projectId}/files/text/briefs/outline.md`],
      ['GET', `/api/projects/${projectId}/generated-assets/asset-1`]
    ]);
    expect(JSON.stringify(requests)).not.toContain('x-debrute-daemon-token');
    expect(JSON.parse(String(requests[2]!.init?.body))).toEqual({
      baseRevision: 1,
      content: '# Outline',
      expectedRevision: 'rev'
    });
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

  it('aborts text preview source requests when the project generation changes', async () => {
    const projectA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const projectB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const pendingRequests: Array<{
      signal: AbortSignal | undefined;
      reject(error: unknown): void;
    }> = [];
    const client = createHttpWorkbenchApiClient({
      fetch: async (url, init) => {
        const parsed = new URL(String(url), 'http://127.0.0.1:17456');
        if (parsed.pathname === '/api/projects/open') {
          const body = JSON.parse(String(init?.body)) as { projectRoot: string };
          const openedProjectId = body.projectRoot === '/tmp/project-a' ? projectA : projectB;
          return jsonResponse({
            projectId: openedProjectId,
            projectRevision: 1,
            snapshot: workbenchSnapshot()
          });
        }
        if (parsed.pathname.endsWith('/canvas-text-previews/source')
          || parsed.pathname.endsWith('/canvas-text-previews/sources')) {
          return new Promise<Response>((_resolve, reject) => {
            pendingRequests.push({ signal: init?.signal ?? undefined, reject });
          });
        }
        throw new Error(`Unexpected request: ${parsed.pathname}`);
      }
    });

    await client.openProject({ projectRoot: '/tmp/project-a' });
    const upload = client.saveCanvasTextPreviewSource({
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/a.md',
      fingerprint: 'sha256:a',
      sourcePng: new Blob(['png'], { type: 'image/png' })
    });
    const availability = client.readCanvasTextPreviewSources({
      canvasId: 'canvas-1',
      sources: [{ projectRelativePath: 'notes/a.md', fingerprint: 'sha256:a' }]
    });
    const uploadRejected = expect(upload).rejects.toThrow('Project changed while the request was in flight.');
    const availabilityRejected = expect(availability).rejects.toThrow('Project changed while the request was in flight.');
    await Promise.resolve();

    await client.openProject({ projectRoot: '/tmp/project-b' });
    const aborted = pendingRequests.map((request) => request.signal?.aborted);
    for (const request of pendingRequests) {
      request.reject(new DOMException('aborted', 'AbortError'));
    }

    expect(aborted).toEqual([true, true]);
    await uploadRejected;
    await availabilityRejected;
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
    } as unknown as typeof EventSource;
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
});
