import { describe, expect, it } from 'vitest';
import { createHttpWorkbenchApiClient } from './httpWorkbenchApiClient.js';
import { captureEventSources, emitProjectChanged, formDataSummary, jsonResponse, projectId, routeResponse, staleRevisionResponse, workbenchSnapshot } from './httpWorkbenchApiClient.testFixtures.js';

describe('HTTP workbench API client mutations', () => {
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
});
