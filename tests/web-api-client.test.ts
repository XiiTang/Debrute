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
      snapshot: { metadata: { name: 'Test Project' } }
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

  it('opens the project event stream after the daemon returns an opaque project id', async () => {
    const eventSourceUrls: string[] = [];
    const client = createHttpWorkbenchApiClient({
      daemonUrl: 'http://127.0.0.1:17456/',
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
      snapshot: { metadata: { name: 'Test Project' } }
    });

    expect(requests).toContainEqual({
      method: 'POST',
      path: `/api/projects/${projectId}/files/path/briefs/outline.md/reveal`,
      body: { kind: 'file' }
    });
    expect(requests).toContainEqual({
      method: 'POST',
      path: `/api/projects/${projectId}/files/path/batch/trash`,
      body: { entries: [{ projectRelativePath: 'assets/cover.png', kind: 'file' }] }
    });
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
    return { projectId, snapshot: workbenchSnapshot() };
  }
  const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(path);
  if (projectMatch?.[1]) {
    return { projectId: decodeURIComponent(projectMatch[1]), snapshot: workbenchSnapshot() };
  }
  if (path === `/api/projects/${projectId}/refresh`) {
    return workbenchSnapshot();
  }
  if (path === `/api/projects/${projectId}/files/path/batch/copy-path`) {
    return { paths: ['/tmp/project/briefs/outline.md', '/tmp/project/assets'] };
  }
  if (path === `/api/projects/${projectId}/files/path/briefs/outline.md/reveal`) {
    return { ok: true };
  }
  if (path === `/api/projects/${projectId}/files/path/batch/trash`) {
    return {
      results: [{ sourceProjectRelativePath: 'assets/cover.png', projectRelativePath: 'assets/cover.png', kind: 'file', status: 'ok' }],
      snapshot: workbenchSnapshot()
    };
  }
  if (path === `/api/projects/${projectId}/files/import/local`) {
    return {
      results: [{ sourceProjectRelativePath: '/external/cover.png', projectRelativePath: 'assets/cover.png', kind: 'file', status: 'ok' }],
      snapshot: workbenchSnapshot()
    };
  }
  if (path === `/api/projects/${projectId}/files/import/uploads`) {
    return {
      results: [
        { sourceProjectRelativePath: 'assets/pages', projectRelativePath: 'assets/pages', kind: 'directory', status: 'ok' },
        { sourceProjectRelativePath: 'assets/pages/page.png', projectRelativePath: 'assets/pages/page.png', kind: 'file', status: 'ok' }
      ],
      snapshot: workbenchSnapshot()
    };
  }
  if (path.endsWith('/files/text/briefs/outline.md') && (init?.method ?? 'GET') === 'GET') {
    return { projectRelativePath: 'briefs/outline.md', content: '# Outline', language: 'markdown', revision: 'rev' };
  }
  if (path.endsWith('/files/text/briefs/outline.md') && init?.method === 'PUT') {
    return { projectRelativePath: 'briefs/outline.md', content: '# Outline', language: 'markdown', revision: 'rev2' };
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
      name: 'Test Project'
    },
    files: [],
    canvases: [],
    projections: [],
    diagnostics: [],
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
