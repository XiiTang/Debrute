import { describe, expect, it } from 'vitest';
import { createHttpWorkbenchApiClient } from './httpWorkbenchApiClient.js';
import { jsonResponse, projectId, routeResponse, workbenchSnapshot } from './httpWorkbenchApiClient.testFixtures.js';

describe('HTTP workbench API client desktop bridge', () => {
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
