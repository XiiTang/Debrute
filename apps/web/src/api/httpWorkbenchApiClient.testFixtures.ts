import type { WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';

export const projectId = '123e4567-e89b-42d3-a456-426614174000';

interface CapturedEventSource {
  onmessage: ((event: MessageEvent) => void) | null;
  close(): void;
}

export function captureEventSources(): { sources: CapturedEventSource[]; restore(): void } {
  const originalEventSource = globalThis.EventSource;
  const sources: CapturedEventSource[] = [];
  globalThis.EventSource = class {
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor() {
      sources.push(this);
    }
    close() {}
  } as unknown as typeof EventSource;
  return {
    sources,
    restore: () => {
      globalThis.EventSource = originalEventSource;
    }
  };
}

export function emitProjectChanged(source: CapturedEventSource, eventProjectId: string, projectRevision: number): void {
  source.onmessage!(new MessageEvent('message', {
    data: JSON.stringify({
      type: 'project.changed',
      projectId: eventProjectId,
      projectRevision,
      snapshot: workbenchSnapshot()
    })
  }));
}

export function formDataSummary(formData: FormData): unknown {
  const plan = JSON.parse(String(formData.get('plan')));
  const files = Array.from(formData.entries())
    .filter(([field]) => field !== 'plan')
    .map(([field, value]) => {
      const file = value as File;
      return { field, name: file.name, size: file.size };
    });
  return { plan, files };
}

export function routeResponse(url: string, init?: RequestInit): unknown {
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

export function workbenchSnapshot(): WorkbenchProjectSessionSnapshot {
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

export function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

export function staleRevisionResponse(projectRevision: number): Response {
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
