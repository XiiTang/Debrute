import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DebruteAppServer } from '@debrute/app-server';
import { createDebruteDaemonHttpServer } from '@debrute/daemon';
import type { AppServerEvent } from '@debrute/app-protocol';
import sharp from 'sharp';

const SHORT_PROJECT_IDLE_TTL_MS = 200;
const AFTER_SHORT_PROJECT_IDLE_TTL_MS = 260;

describe('daemon HTTP runtime', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it('serves runtime metadata and protects mutating routes with the daemon token', async () => {
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null
    });
    cleanups.push(() => daemon.close());
    const runtime = await daemon.listen();

    const status = await fetch(`${runtime.daemonUrl}/api/status`).then((response) => response.json());
    expect(status).toMatchObject({
      ok: true,
      runtime: {
        daemonUrl: runtime.daemonUrl,
        webBaseUrl: runtime.webBaseUrl,
        platform: process.platform
      }
    });
    expect(JSON.stringify(status)).not.toContain('test-token');

    const publicRuntime = await fetch(`${runtime.daemonUrl}/api/runtime`).then((response) => response.json());
    expect(publicRuntime).toMatchObject({
      daemonUrl: runtime.daemonUrl,
      webBaseUrl: runtime.webBaseUrl,
      platform: process.platform
    });
    expect(publicRuntime).not.toHaveProperty('token');

    const rejectedRuntimeProbe = await fetch(`${runtime.daemonUrl}/api/runtime`, {
      method: 'POST'
    });
    expect(rejectedRuntimeProbe.status).toBe(405);
    await expect(rejectedRuntimeProbe.json()).resolves.toMatchObject({
      error: {
        code: 'method_not_allowed'
      }
    });

    const rejectedTokenedRuntimeProbe = await fetch(`${runtime.daemonUrl}/api/runtime`, {
      method: 'POST',
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    expect(rejectedTokenedRuntimeProbe.status).toBe(405);

    const rejected = await fetch(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });

    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toMatchObject({
      error: {
        code: 'forbidden'
      }
    });

  });

  it('protects project read routes with the daemon token', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-read-token-'));
    await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');

    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string; projectRevision: number }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });

    const tokenlessText = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/files/text/brief.md`);
    expect(tokenlessText.status).toBe(403);

    const authorizedText = await requestJson<{ content: string }>(`${runtime.daemonUrl}/api/projects/${opened.projectId}/files/text/brief.md`, {
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    expect(authorizedText.content).toBe('# Brief');

    const tokenlessEvents = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/events?clientId=security-test`);
    expect(tokenlessEvents.status).toBe(403);

    const authorizedEvents = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/events?clientId=security-test&debrute-token=test-token`);
    expect(authorizedEvents.status).toBe(200);
    await authorizedEvents.body?.cancel();
  });

  it('rejects non-loopback daemon bind hosts before listening', async () => {
    const daemon = createDebruteDaemonHttpServer({
      host: '0.0.0.0',
      port: 0,
      token: 'test-token',
      webBaseUrl: null
    });
    cleanups.push(() => daemon.close());

    await expect(daemon.listen()).rejects.toThrow('Debrute daemon host must be loopback');
    expect(daemon.runtime()).toBeUndefined();
  });

  it('allows only daemon and web origins on API requests', async () => {
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: 'http://127.0.0.1:17322'
    });
    cleanups.push(() => daemon.close());
    const runtime = await daemon.listen();

    const allowed = await fetch(`${runtime.daemonUrl}/api/runtime`, {
      headers: { origin: 'http://127.0.0.1:17322' }
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:17322');

    const daemonOrigin = await fetch(`${runtime.daemonUrl}/api/runtime`, {
      headers: { origin: runtime.daemonUrl }
    });
    expect(daemonOrigin.status).toBe(200);
    expect(daemonOrigin.headers.get('access-control-allow-origin')).toBe(runtime.daemonUrl);

    const preflight = await fetch(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'OPTIONS',
      headers: { origin: 'http://127.0.0.1:17322' }
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:17322');

    const rejected = await fetch(`${runtime.daemonUrl}/api/runtime`, {
      headers: { origin: 'http://example.com' }
    });
    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: 'forbidden' }
    });
  });

  it('opens a project and exposes text file routes through HTTP', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-project-'));
    await mkdir(join(projectRoot, 'briefs'), { recursive: true });
    await writeFile(join(projectRoot, 'briefs/outline.md'), '# Outline', 'utf8');

    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();

    const opened = await requestJson<{
      projectId: string;
      projectRevision: number;
      snapshot: { files: Array<{ projectRelativePath: string }> };
    }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });

    expect(JSON.stringify(opened)).not.toContain(projectRoot);
    expect(opened.projectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(opened.projectId).not.toBe(Buffer.from(projectRoot, 'utf8').toString('base64url'));
    expect(opened.snapshot).not.toHaveProperty('projectRoot');
    expect(opened.snapshot.files.map((file) => file.projectRelativePath)).toContain('briefs/outline.md');

    const textFile = await requestJson<Record<string, unknown>>(`${runtime.daemonUrl}/api/projects/${opened.projectId}/files/text/briefs/outline.md`);
    expect(textFile).toMatchObject({
      projectRelativePath: 'briefs/outline.md',
      content: '# Outline'
    });
    expect(textFile).not.toHaveProperty('absolutePath');
    expect(JSON.stringify(textFile)).not.toContain(projectRoot);

    await requestJson(`${runtime.daemonUrl}/api/projects/${opened.projectId}/files/text/briefs/outline.md`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ baseRevision: opened.projectRevision, content: '# Updated' })
    });

    await expect(readFile(join(projectRoot, 'briefs/outline.md'), 'utf8')).resolves.toBe('# Updated');

    const unscoped = await fetch(`${runtime.daemonUrl}/not-a-project/files/text/briefs/outline.md`);
    expect(unscoped.status).toBe(404);

  });

  it('returns project revisions on project open, live project listing, and mutation responses', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-revision-envelope-'));
    await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();

    const opened = await requestJson<{ projectId: string; projectRevision: number }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot })
    });
    expect(opened.projectRevision).toBe(1);

    await expect(requestJson(`${runtime.daemonUrl}/api/projects`)).resolves.toMatchObject({
      projects: [{ projectId: opened.projectId, projectRevision: 1 }]
    });

    const created = await requestJson<{ projectRevision: number; snapshot: { files: unknown[] } }>(`${runtime.daemonUrl}/api/projects/${opened.projectId}/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({
        baseRevision: 1,
        kind: 'file',
        parentProjectRelativePath: '',
        name: 'next.md'
      })
    });

    expect(created.projectRevision).toBe(2);
    expect(created.snapshot.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectRelativePath: 'next.md' })
    ]));
  });

  it('rejects stale shared-state mutations with the current revision and snapshot', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-stale-revision-'));
    await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string; projectRevision: number }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot })
    });

    await requestJson(`${runtime.daemonUrl}/api/projects/${opened.projectId}/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({
        baseRevision: opened.projectRevision,
        kind: 'file',
        parentProjectRelativePath: '',
        name: 'first.md'
      })
    });

    const stale = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({
        baseRevision: opened.projectRevision,
        kind: 'file',
        parentProjectRelativePath: '',
        name: 'second.md'
      })
    });

    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      error: {
        code: 'stale_project_revision',
        details: {
          projectId: opened.projectId,
          projectRevision: 2,
          snapshot: {
            files: expect.arrayContaining([
              expect.objectContaining({ projectRelativePath: 'first.md' })
            ])
          }
        }
      }
    });
  });

  it('refreshes after draining queued project changes without stale revision rejection', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-refresh-drain-'));
    const listeners = new Set<(event: AppServerEvent) => void>();
    let currentSnapshot = projectSnapshotFixture(projectRoot);
    const emitChanged = (files: Array<{ projectRelativePath: string; kind: 'file' }>) => {
      currentSnapshot = {
        ...projectSnapshotFixture(projectRoot),
        files
      };
      for (const listener of listeners) {
        listener({ type: 'project.changed', snapshot: currentSnapshot });
      }
    };
    const appServer = {
      openProject: async (root: string) => {
        currentSnapshot = projectSnapshotFixture(root);
        return currentSnapshot;
      },
      getSnapshot: () => currentSnapshot,
      currentSnapshot: () => currentSnapshot,
      drainSessionOperations: async () => {
        emitChanged([{ projectRelativePath: 'external.md', kind: 'file' }]);
      },
      refreshProject: async () => {
        emitChanged([
          { projectRelativePath: 'external.md', kind: 'file' },
          { projectRelativePath: 'refreshed.md', kind: 'file' }
        ]);
        return currentSnapshot;
      },
      onEvent: (listener: (event: AppServerEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close: () => undefined
    } as unknown as DebruteAppServer;
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null,
      createAppServer: () => appServer
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string; projectRevision: number }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot })
    });

    const response = await apiFetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/refresh`, {
      method: 'POST',
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const refreshed = JSON.parse(body) as {
      projectRevision: number;
      snapshot: { files: Array<{ projectRelativePath: string }> };
    };

    expect(refreshed.projectRevision).toBe(3);
    expect(refreshed.snapshot.files.map((file) => file.projectRelativePath)).toEqual([
      'external.md',
      'refreshed.md'
    ]);
  });

  it('emits project-scoped SSE events with project revisions', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-revision-sse-'));
    await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string; projectRevision: number }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot })
    });

    const events = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/events?clientId=client-a&debrute-token=test-token`);
    expect(events.status).toBe(200);
    await requestJson(`${runtime.daemonUrl}/api/projects/${opened.projectId}/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({
        baseRevision: opened.projectRevision,
        kind: 'file',
        parentProjectRelativePath: '',
        name: 'evented.md'
      })
    });

    await expect(readNextSseMessage<{ projectId: string; projectRevision: number; type: string }>(events))
      .resolves.toMatchObject({
        type: 'project.changed',
        projectId: opened.projectId,
        projectRevision: 2
      });
  });

  it('rejects raw project file requests without a revision query', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-raw-revision-'));
    await mkdir(join(projectRoot, 'generated'), { recursive: true });
    await writeFile(join(projectRoot, 'generated/cover.png'), 'asset-bytes', 'utf8');

    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string; projectRevision: number }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });

    const response = await apiFetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/files/raw/generated/cover.png`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'missing_revision' }
    });
  });

  it('protects native project path operations with daemon token and validates project paths', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-native-path-'));
    await mkdir(join(projectRoot, 'briefs'), { recursive: true });
    await writeFile(join(projectRoot, 'briefs/outline.md'), '# Outline', 'utf8');
    const nativeShell = {
      platform: 'darwin' as NodeJS.Platform,
      showItemInFolder: vi.fn(async () => undefined),
      openPath: vi.fn(async () => undefined),
      trashItem: vi.fn(async () => undefined)
    };

    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
      nativeShell
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string; projectRevision: number }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': runtime.token
      },
      body: JSON.stringify({ projectRoot })
    });

    const rejectedCopy = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/files/path/batch/copy-path`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries: [{ projectRelativePath: 'briefs/outline.md', kind: 'file' }] })
    });
    expect(rejectedCopy.status).toBe(403);

    const canonicalProjectRoot = await realpath(projectRoot);
    await expect(requestJson<{ paths: string[] }>(
      `${runtime.daemonUrl}/api/projects/${opened.projectId}/files/path/batch/copy-path`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-debrute-daemon-token': runtime.token
        },
        body: JSON.stringify({
          entries: [
            { projectRelativePath: 'briefs/outline.md', kind: 'file' },
            { projectRelativePath: 'briefs', kind: 'directory' }
          ]
        })
      }
    )).resolves.toEqual({
      paths: [
        join(canonicalProjectRoot, 'briefs/outline.md'),
        join(canonicalProjectRoot, 'briefs')
      ]
    });

    await expect(requestJson(
      `${runtime.daemonUrl}/api/projects/${opened.projectId}/files/path/briefs/outline.md/reveal`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-debrute-daemon-token': runtime.token
        },
        body: JSON.stringify({ kind: 'file' })
      }
    )).resolves.toEqual({ ok: true });
    expect(nativeShell.showItemInFolder).toHaveBeenCalledWith(join(canonicalProjectRoot, 'briefs/outline.md'));

    const trashResult = await requestJson<{
      results: Array<{ projectRelativePath: string; kind: 'file' | 'directory'; status: string }>;
      snapshot: { files: Array<{ projectRelativePath: string }> };
    }>(
      `${runtime.daemonUrl}/api/projects/${opened.projectId}/files/path/batch/trash`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-debrute-daemon-token': runtime.token
        },
        body: JSON.stringify({
          baseRevision: opened.projectRevision,
          entries: [{ projectRelativePath: 'briefs/outline.md', kind: 'file' }]
        })
      }
    );
    expect(trashResult.results).toMatchObject([
      { projectRelativePath: 'briefs/outline.md', kind: 'file', status: 'ok' }
    ]);
    expect(JSON.stringify(trashResult)).not.toContain(projectRoot);
    expect(nativeShell.trashItem).toHaveBeenCalledWith(join(canonicalProjectRoot, 'briefs/outline.md'));
  });

  it('serves batch project file operation routes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-batch-file-ops-'));
    await mkdir(join(projectRoot, 'briefs'), { recursive: true });
    await writeFile(join(projectRoot, 'briefs/outline.md'), '# Outline', 'utf8');
    await writeFile(join(projectRoot, 'cover.png'), 'cover', 'utf8');

    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret'
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string; projectRevision: number }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': runtime.token
      },
      body: JSON.stringify({ projectRoot })
    });
    const headers = {
      'content-type': 'application/json',
      'x-debrute-daemon-token': runtime.token
    };

    const copied = await requestJson<{
      projectRevision: number;
      results: Array<{ projectRelativePath: string; status: string }>;
      snapshot: { files: Array<{ projectRelativePath: string }> };
    }>(`${runtime.daemonUrl}/api/projects/${opened.projectId}/files/batch/copy`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        baseRevision: opened.projectRevision,
        entries: [{ projectRelativePath: 'cover.png', kind: 'file' }],
        targetDirectoryProjectRelativePath: 'briefs'
      })
    });
    expect(copied.results).toMatchObject([
      { projectRelativePath: 'briefs/cover.png', status: 'ok' }
    ]);
    expect(JSON.stringify(copied)).not.toContain(projectRoot);

    const moved = await requestJson<{
      projectRevision: number;
      results: Array<{ projectRelativePath: string; status: string }>;
      snapshot: { files: Array<{ projectRelativePath: string }> };
    }>(`${runtime.daemonUrl}/api/projects/${opened.projectId}/files/batch/move`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        baseRevision: copied.projectRevision,
        entries: [{ projectRelativePath: 'briefs/cover.png', kind: 'file' }],
        targetDirectoryProjectRelativePath: '',
        overwrite: true
      })
    });
    expect(moved.results).toMatchObject([
      { projectRelativePath: 'cover.png', status: 'ok' }
    ]);

    const deleted = await requestJson<{
      results: Array<{ projectRelativePath: string; status: string }>;
      snapshot: { files: Array<{ projectRelativePath: string }> };
    }>(`${runtime.daemonUrl}/api/projects/${opened.projectId}/files/batch/delete-permanently`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        baseRevision: moved.projectRevision,
        entries: [{ projectRelativePath: 'cover.png', kind: 'file' }]
      })
    });
    expect(deleted.results).toMatchObject([
      { projectRelativePath: 'cover.png', status: 'ok' }
    ]);
    expect(deleted.snapshot.files.map((file) => file.projectRelativePath)).not.toContain('cover.png');
  });

  it('serves external import routes for local paths and browser uploads', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-external-import-'));
    const externalRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-external-source-'));
    await mkdir(join(projectRoot, 'assets'), { recursive: true });
    await writeFile(join(externalRoot, 'cover.png'), 'cover', 'utf8');

    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret'
    });
    cleanups.push(
      () => daemon.close(),
      () => rm(projectRoot, { recursive: true, force: true }),
      () => rm(externalRoot, { recursive: true, force: true })
    );
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string; projectRevision: number }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': runtime.token
      },
      body: JSON.stringify({ projectRoot })
    });

    const localImport = await requestJson<{
      projectRevision: number;
      results: Array<{ projectRelativePath: string; status: string }>;
      snapshot: { files: Array<{ projectRelativePath: string }> };
    }>(`${runtime.daemonUrl}/api/projects/${opened.projectId}/files/import/local`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': runtime.token
      },
      body: JSON.stringify({
        baseRevision: opened.projectRevision,
        sources: [join(externalRoot, 'cover.png')],
        targetDirectoryProjectRelativePath: 'assets'
      })
    });
    expect(localImport.results).toMatchObject([
      { projectRelativePath: 'assets/cover.png', status: 'ok' }
    ]);
    expect(JSON.stringify(localImport)).not.toContain(projectRoot);

    const uploadForm = new FormData();
    uploadForm.append('plan', JSON.stringify({
      baseRevision: localImport.projectRevision,
      targetDirectoryProjectRelativePath: 'assets',
      entries: [
        { kind: 'directory', projectRelativePath: 'assets/pages' },
        { kind: 'file', projectRelativePath: 'assets/pages/page.png', fileField: 'file:1' }
      ]
    }));
    uploadForm.append('file:1', new File(['page'], 'page.png'));
    const upload = await requestJson<{
      results: Array<{ projectRelativePath: string; status: string }>;
      snapshot: { files: Array<{ projectRelativePath: string }> };
    }>(`${runtime.daemonUrl}/api/projects/${opened.projectId}/files/import/uploads`, {
      method: 'POST',
      headers: {
        'x-debrute-daemon-token': runtime.token
      },
      body: uploadForm
    });
    expect(upload.results).toMatchObject([
      { projectRelativePath: 'assets/pages', status: 'ok' },
      { projectRelativePath: 'assets/pages/page.png', status: 'ok' }
    ]);
    await expect(readFile(join(projectRoot, 'assets/pages/page.png'), 'utf8')).resolves.toBe('page');
  });

  it('streams browser upload request bodies beyond the previous 100MB limit', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-upload-stream-'));
    await mkdir(join(projectRoot, 'assets'), { recursive: true });
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret'
    });
    cleanups.push(
      () => daemon.close(),
      () => rm(projectRoot, { recursive: true, force: true })
    );
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string; projectRevision: number }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': runtime.token
      },
      body: JSON.stringify({ projectRoot })
    });

    const byteLength = 100 * 1024 * 1024 + 1;
    const uploadForm = new FormData();
    uploadForm.append('plan', JSON.stringify({
      baseRevision: opened.projectRevision,
      targetDirectoryProjectRelativePath: 'assets',
      entries: [{ kind: 'file', projectRelativePath: 'assets/large.bin', fileField: 'file:0' }]
    }));
    uploadForm.append('file:0', new File([new Uint8Array(byteLength)], 'large.bin'));
    const response = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/files/import/uploads`, {
      method: 'POST',
      headers: {
        'x-debrute-daemon-token': runtime.token
      },
      body: uploadForm
    });

    expect(response.status).toBe(200);
    const upload = await response.json() as { results: Array<{ projectRelativePath: string; kind: 'file' }> };
    expect(upload.results).toMatchObject([{ projectRelativePath: 'assets/large.bin', kind: 'file' }]);
    await expect(stat(join(projectRoot, 'assets/large.bin')).then((fileStat) => fileStat.size)).resolves.toBe(byteLength);
  }, 30_000);

  it('does not parse upload bodies through Request.formData buffering', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-upload-no-formdata-'));
    await mkdir(join(projectRoot, 'assets'), { recursive: true });
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret'
    });
    const originalFormData = Request.prototype.formData;
    Request.prototype.formData = async function blockedFormData(): Promise<FormData> {
      throw new Error('Request.formData must not be used for upload imports.');
    };
    cleanups.push(
      () => {
        Request.prototype.formData = originalFormData;
      },
      () => daemon.close(),
      () => rm(projectRoot, { recursive: true, force: true })
    );
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string; projectRevision: number }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': runtime.token
      },
      body: JSON.stringify({ projectRoot })
    });

    const uploadForm = new FormData();
    uploadForm.append('plan', JSON.stringify({
      baseRevision: opened.projectRevision,
      targetDirectoryProjectRelativePath: 'assets',
      entries: [{ kind: 'file', projectRelativePath: 'assets/page.png', fileField: 'file:0' }]
    }));
    uploadForm.append('file:0', new File(['page'], 'page.png'));
    const response = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/files/import/uploads`, {
      method: 'POST',
      headers: {
        'x-debrute-daemon-token': runtime.token
      },
      body: uploadForm
    });

    expect(response.status).toBe(200);
    await expect(readFile(join(projectRoot, 'assets/page.png'), 'utf8')).resolves.toBe('page');
  });

  it('honors project ids on project-scoped routes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-project-id-'));
    await mkdir(join(projectRoot, 'briefs'), { recursive: true });
    await writeFile(join(projectRoot, 'briefs/outline.md'), '# Outline', 'utf8');

    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();

    const opened = await requestJson<{ projectId: string; projectRevision: number }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });

    await expect(requestJson(`${runtime.daemonUrl}/api/projects/${opened.projectId}/files/text/briefs/outline.md`))
      .resolves.toMatchObject({ content: '# Outline' });

    const rejected = await apiFetch(`${runtime.daemonUrl}/api/projects/unknown-project-id/files/text/briefs/outline.md`);
    expect(rejected.status).toBe(404);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: 'project_not_open' }
    });
  });

  it('opens two live projects at the same time and isolates project routes', async () => {
    const alphaRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-alpha-'));
    const betaRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-beta-'));
    await writeFile(join(alphaRoot, 'brief.md'), '# Alpha', 'utf8');
    await writeFile(join(betaRoot, 'brief.md'), '# Beta', 'utf8');

    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null,
      projectIdleTtlMs: 1000
    });
    cleanups.push(() => daemon.close(), () => rm(alphaRoot, { recursive: true, force: true }), () => rm(betaRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();

    const alpha = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot: alphaRoot })
    });
    const beta = await requestJson<{ projectId: string; projectRevision: number }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot: betaRoot })
    });

    expect(alpha.projectId).not.toBe(beta.projectId);
    await expect(requestJson(`${runtime.daemonUrl}/api/projects/${alpha.projectId}/files/text/brief.md`))
      .resolves.toMatchObject({ content: '# Alpha' });
    await expect(requestJson(`${runtime.daemonUrl}/api/projects/${beta.projectId}/files/text/brief.md`))
      .resolves.toMatchObject({ content: '# Beta' });
  });

  it('reuses the live project id for the same canonical root', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-reuse-root-'));
    await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');

    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null,
      projectIdleTtlMs: 1000
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();

    const first = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot })
    });
    const second = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot: join(projectRoot, '.') })
    });

    expect(second.projectId).toBe(first.projectId);
  });

  it('rejects project files that resolve outside the project through symlinks', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-symlink-project-'));
    const outsideFile = join(tmpdir(), `debrute-daemon-symlink-outside-${Date.now()}.txt`);
    await writeFile(outsideFile, 'outside', 'utf8');
    await symlink(outsideFile, join(projectRoot, 'linked.txt'));

    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null
    });
    cleanups.push(
      () => daemon.close(),
      () => rm(projectRoot, { recursive: true, force: true }),
      () => rm(outsideFile, { force: true })
    );
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });

    const response = await apiFetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/files/text/linked.txt`);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'project_path_forbidden' }
    });
  });

  it('requires an explicit project root when opening a project', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-project-open-input-'));
    await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');

    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();

    const response = await fetch(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({})
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_input' }
    });
    await expect(apiFetch(`${runtime.daemonUrl}/api/projects`).then((projectsResponse) => projectsResponse.json())).resolves.toEqual({
      projects: []
    });
  });

  it('returns invalid_input for project-open roots that do not resolve to directories', async () => {
    const filePath = join(tmpdir(), `debrute-daemon-project-root-file-${Date.now()}`);
    await writeFile(filePath, 'not a directory', 'utf8');
    const missingPath = join(tmpdir(), `debrute-daemon-project-root-missing-${Date.now()}`);

    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null
    });
    cleanups.push(() => daemon.close(), () => rm(filePath, { force: true }));
    const runtime = await daemon.listen();

    for (const projectRoot of [missingPath, filePath]) {
      const response = await fetch(`${runtime.daemonUrl}/api/projects/open`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-debrute-daemon-token': 'test-token'
        },
        body: JSON.stringify({ projectRoot })
      });

      expect(response.status, projectRoot).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'invalid_input' }
      });
    }

    await expect(apiFetch(`${runtime.daemonUrl}/api/projects`).then((projectsResponse) => projectsResponse.json())).resolves.toEqual({
      projects: []
    });
  });

  it('does not expose projects opened outside HTTP project-open routes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-direct-open-'));
    await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');

    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null
    });
    const privateAppServer = new DebruteAppServer();
    cleanups.push(() => daemon.close(), () => privateAppServer.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();

    await privateAppServer.openProject(projectRoot);

    await expect(fetch(`${runtime.daemonUrl}/api/runtime`).then((response) => response.json())).resolves.toEqual({
      daemonUrl: runtime.daemonUrl,
      webBaseUrl: runtime.webBaseUrl,
      platform: process.platform
    });
    await expect(apiFetch(`${runtime.daemonUrl}/api/projects`).then((response) => response.json())).resolves.toEqual({
      projects: []
    });
  });

  it('serves generated asset metadata and raw files from browser-facing asset routes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-generated-asset-'));
    await mkdir(join(projectRoot, 'generated'), { recursive: true });
    await writeFile(join(projectRoot, 'generated/cover.png'), 'asset-bytes', 'utf8');

    let appServer: DebruteAppServer | undefined;
    const daemon = createDebruteDaemonHttpServer({
      createAppServer: () => {
        appServer = new DebruteAppServer();
        return appServer;
      },
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string; projectRevision: number }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });
    if (!appServer) {
      throw new Error('Daemon did not create a project app server.');
    }
    expect(opened.projectRevision).toBe(1);
    const events = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/events?clientId=generated-assets-client&debrute-token=test-token`);
    expect(events.status).toBe(200);
    const record = await appServer.recordGeneratedAssetMetadata({
      projectRelativePath: 'generated/cover.png',
      modelRun: {
        request: { prompt: 'cover' },
        output: { ok: true }
      }
    });

    await expect(readNextSseMessage<{
      type: string;
      projectId: string;
      projectRevision: number;
      record: { recordId: string; projectRelativePath: string };
    }>(events)).resolves.toMatchObject({
      type: 'generatedAsset.metadata.changed',
      projectId: opened.projectId,
      projectRevision: 2,
      record: {
        recordId: record.recordId,
        projectRelativePath: 'generated/cover.png'
      }
    });
    const liveProjects = await requestJson<{ projects: Array<{ projectId: string; projectRevision: number }> }>(`${runtime.daemonUrl}/api/projects`);
    expect(liveProjects.projects).toEqual([
      expect.objectContaining({
        projectId: opened.projectId,
        projectRevision: 2
      })
    ]);

    const list = await requestJson<{
      assets: Array<{ assetId: string; projectRelativePath: string; rawUrl: string }>;
    }>(`${runtime.daemonUrl}/api/projects/${opened.projectId}/generated-assets`);
    expect(list.assets).toEqual([
      expect.objectContaining({
        assetId: record.recordId,
        projectRelativePath: 'generated/cover.png',
        rawUrl: `${runtime.daemonUrl}/api/projects/${opened.projectId}/generated-assets/${record.recordId}/raw?debrute-token=test-token`
      })
    ]);
    expect(JSON.stringify(list)).not.toContain(projectRoot);

    const detail = await requestJson<Record<string, unknown>>(`${runtime.daemonUrl}/api/projects/${opened.projectId}/generated-assets/${record.recordId}`);
    expect(detail).toMatchObject({
      assetId: record.recordId,
      projectRelativePath: 'generated/cover.png',
      record
    });
    expect(JSON.stringify(detail)).not.toContain(projectRoot);

    await expect(fetch(list.assets[0]!.rawUrl).then((response) => response.text()))
      .resolves.toBe('asset-bytes');
  });

  it('rejects generated asset lookup paths that resolve outside the project through symlinks', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-generated-asset-symlink-'));
    const outsideFile = join(tmpdir(), `debrute-daemon-generated-asset-outside-${Date.now()}.png`);
    await mkdir(join(projectRoot, 'generated'), { recursive: true });
    await writeFile(outsideFile, 'outside', 'utf8');
    await symlink(outsideFile, join(projectRoot, 'generated/linked.png'));

    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null
    });
    cleanups.push(
      () => daemon.close(),
      () => rm(projectRoot, { recursive: true, force: true }),
      () => rm(outsideFile, { force: true })
    );
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });

    const response = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/generated-assets/lookup`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRelativePath: 'generated/linked.png' })
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'project_path_forbidden' }
    });
  });

  it('returns structured client errors for invalid JSON bodies', async () => {
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null
    });
    cleanups.push(() => daemon.close());
    const runtime = await daemon.listen();

    const response = await fetch(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: '{'
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_json' }
    });
  });

  it('streams app-server events as server-sent events', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-events-project-'));
    await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');

    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });

    const response = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/events?debrute-token=test-token`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    await response.body?.cancel();
  });

  it('does not stream project events from one session to another project session', async () => {
    const alphaRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-sse-alpha-'));
    const betaRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-sse-beta-'));
    await writeFile(join(alphaRoot, 'brief.md'), '# Alpha', 'utf8');
    await writeFile(join(betaRoot, 'brief.md'), '# Beta', 'utf8');

    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null
    });
    cleanups.push(() => daemon.close(), () => rm(alphaRoot, { recursive: true, force: true }), () => rm(betaRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const alpha = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot: alphaRoot })
    });
    const beta = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot: betaRoot })
    });

    const alphaEvents = await fetch(`${runtime.daemonUrl}/api/projects/${alpha.projectId}/events?clientId=alpha-client&debrute-token=test-token`);
    const betaEvents = await fetch(`${runtime.daemonUrl}/api/projects/${beta.projectId}/events?clientId=beta-client&debrute-token=test-token`);
    await requestJson(`${runtime.daemonUrl}/api/projects/${beta.projectId}/files/text/brief.md`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ baseRevision: beta.projectRevision, content: '# Beta Updated' })
    });

    await expect(readNextSseMessage<{ type: string }>(betaEvents)).resolves.toMatchObject({
      type: 'project.changed'
    });
    await expect(readNextSseMessage(alphaEvents)).rejects.toThrow('Timed out waiting for SSE event.');
  });

  it('does not expose Canvas settings HTTP routes', async () => {
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null
    });
    cleanups.push(() => daemon.close());
    const runtime = await daemon.listen();

    const [aggregateResponse, getResponse, putResponse] = await Promise.all([
      fetch(`${runtime.daemonUrl}/api/settings`, {
        headers: { 'connection': 'close', 'x-debrute-daemon-token': 'test-token' }
      }),
      fetch(`${runtime.daemonUrl}/api/settings/canvas`, {
        headers: { 'connection': 'close', 'x-debrute-daemon-token': 'test-token' }
      }),
      fetch(`${runtime.daemonUrl}/api/settings/canvas`, {
        method: 'PUT',
        headers: {
          'connection': 'close',
          'content-type': 'application/json',
          'x-debrute-daemon-token': 'test-token'
        },
        body: JSON.stringify({})
      })
    ]);
    const aggregate = await aggregateResponse.json() as Record<string, unknown>;
    await getResponse.text();
    await putResponse.text();

    expect(aggregateResponse.status).toBe(200);
    expect(aggregate).not.toHaveProperty('canvas');
    expect(getResponse.status).toBe(404);
    expect(putResponse.status).toBe(404);
  }, 30_000);

  it('releases a project session after the last event stream closes and idle TTL elapses', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-idle-release-project-'));
    await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');

    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null,
      projectIdleTtlMs: SHORT_PROJECT_IDLE_TTL_MS
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });

    const events = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/events?clientId=client-a&debrute-token=test-token`);
    expect(events.status).toBe(200);
    await expect(apiFetch(`${runtime.daemonUrl}/api/projects`).then((response) => response.json())).resolves.toMatchObject({
      projects: [{ projectId: opened.projectId, clients: { liveCount: 1 } }]
    });

    await events.body?.cancel();
    await delay(AFTER_SHORT_PROJECT_IDLE_TTL_MS);

    const released = await apiFetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}`);
    expect(released.status).toBe(404);
    await expect(released.json()).resolves.toMatchObject({
      error: { code: 'project_not_open' }
    });
    await expect(apiFetch(`${runtime.daemonUrl}/api/projects`).then((response) => response.json())).resolves.toEqual({
      projects: []
    });
  });

  it('keeps a project session live while another event stream remains open', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-idle-held-project-'));
    await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');

    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null,
      projectIdleTtlMs: SHORT_PROJECT_IDLE_TTL_MS
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });

    const first = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/events?clientId=client-a&debrute-token=test-token`);
    const second = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/events?clientId=client-b&debrute-token=test-token`);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    await first.body?.cancel();
    await delay(AFTER_SHORT_PROJECT_IDLE_TTL_MS);

    await expect(requestJson(`${runtime.daemonUrl}/api/projects/${opened.projectId}`))
      .resolves.toMatchObject({ projectId: opened.projectId });
    await expect(apiFetch(`${runtime.daemonUrl}/api/projects`).then((response) => response.json())).resolves.toMatchObject({
      projects: [{ projectId: opened.projectId, clients: { liveCount: 1 } }]
    });

    await second.body?.cancel();
  });

  it('cancels pending idle cleanup while a project request is in flight', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-idle-request-project-'));
    await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');

    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null,
      projectIdleTtlMs: 80
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });
    const events = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/events?clientId=client-a&debrute-token=test-token`);
    expect(events.status).toBe(200);

    await events.body?.cancel();
    await delay(40);
    await expect(requestJson(`${runtime.daemonUrl}/api/projects/${opened.projectId}`))
      .resolves.toMatchObject({ projectId: opened.projectId });
    await delay(50);
    await expect(requestJson(`${runtime.daemonUrl}/api/projects/${opened.projectId}`))
      .resolves.toMatchObject({ projectId: opened.projectId });

    await delay(100);
    const released = await apiFetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}`);
    expect(released.status).toBe(404);
  });

  it('aborts queued canvas preview work when the client closes the request', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-preview-abort-'));
    const aborts: string[] = [];
    let resolveEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      resolveEntered = resolve;
    });
    const appServer = {
      openProject: async (root: string) => projectSnapshotFixture(root),
      currentSnapshot: () => undefined,
      onEvent: () => () => undefined,
      close: () => undefined,
      resolveCanvasImagePreview: async (input: { abortSignal?: AbortSignal }) => {
        input.abortSignal?.addEventListener('abort', () => aborts.push('aborted'), { once: true });
        resolveEntered?.();
        await delay(40);
        throw new Error('preview should have been aborted before completion');
      }
    } as unknown as DebruteAppServer;
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null,
      createAppServer: () => appServer
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });
    const abortController = new AbortController();
    const request = fetch(
      `${runtime.daemonUrl}/api/projects/${opened.projectId}/canvas-image-preview?path=flow%2Fa.png&v=1&w=256`,
      {
        headers: { 'x-debrute-daemon-token': 'test-token' },
        signal: abortController.signal
      }
    ).catch((error) => error);

    await entered;
    abortController.abort();
    await request;
    await delay(20);

    expect(aborts).toEqual(['aborted']);
  });

  it('does not abort normal slow canvas preview requests before the response finishes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-preview-normal-'));
    const previewPath = join(projectRoot, 'preview.png');
    await writeFile(previewPath, 'preview', 'utf8');
    const aborts: string[] = [];
    const appServer = {
      openProject: async (root: string) => projectSnapshotFixture(root),
      currentSnapshot: () => undefined,
      onEvent: () => () => undefined,
      close: () => undefined,
      resolveCanvasImagePreview: async (input: { abortSignal?: AbortSignal }) => {
        input.abortSignal?.addEventListener('abort', () => aborts.push('aborted'), { once: true });
        await delay(40);
        return { absolutePath: previewPath };
      }
    } as unknown as DebruteAppServer;
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null,
      createAppServer: () => appServer
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });

    const response = await apiFetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/canvas-image-preview?path=flow%2Fa.png&v=1&w=256`);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('preview');
    expect(aborts).toEqual([]);
  });

  it('keeps a project session live while an Electron project window is registered', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-electron-window-project-'));
    await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');

    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null,
      projectIdleTtlMs: SHORT_PROJECT_IDLE_TTL_MS
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });

    const releaseWindow = daemon.registerElectronProjectWindow(opened.projectId, 42);
    expect(releaseWindow).toBeDefined();
    await delay(AFTER_SHORT_PROJECT_IDLE_TTL_MS);

    await expect(requestJson(`${runtime.daemonUrl}/api/projects/${opened.projectId}`))
      .resolves.toMatchObject({ projectId: opened.projectId });

    releaseWindow!();
    await delay(AFTER_SHORT_PROJECT_IDLE_TTL_MS);

    const released = await apiFetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}`);
    expect(released.status).toBe(404);
  });

  it('streams canvas changed events with browser file URLs', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-canvas-event-project-'));
    await mkdir(join(projectRoot, 'image-production/generated'), { recursive: true });
    await sharp({
      create: {
        width: 16,
        height: 12,
        channels: 4,
        background: '#336699ff'
      }
    }).png().toFile(join(projectRoot, 'image-production/generated/cover.png'));

    let appServer: DebruteAppServer | undefined;
    const daemon = createDebruteDaemonHttpServer({
      createAppServer: () => {
        appServer = new DebruteAppServer();
        return appServer;
      },
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });
    await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource(['image-production/generated/*.png']));
    if (!appServer) {
      throw new Error('Daemon did not create a project app server.');
    }
    await appServer.publishCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });
    const refreshed = await requestJson<{
      projectRevision: number;
      snapshot: {
        projections: Array<{ nodes: Array<{ projectRelativePath: string; availability: { state: string; fileUrl?: string } }> }>;
      };
    }>(`${runtime.daemonUrl}/api/projects/${opened.projectId}/refresh`, {
      method: 'POST',
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    const node = refreshed.snapshot.projections[0]!.nodes.find((item) => item.projectRelativePath === 'image-production/generated/cover.png')!;
    expect(node.availability.fileUrl).toContain(`/api/projects/${opened.projectId}/files/raw/image-production/generated/cover.png`);
    if (!node.availability.fileUrl) {
      throw new Error('Canvas node did not include a browser file URL.');
    }
    const rawFileResponse = await fetch(node.availability.fileUrl);
    expect(rawFileResponse.status).toBe(200);
    expect(rawFileResponse.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(rawFileResponse.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await rawFileResponse.arrayBuffer()).length).toBeGreaterThan(0);

    const response = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/events?debrute-token=test-token`);
    await requestJson(`${runtime.daemonUrl}/api/projects/${opened.projectId}/canvases/canvas-1/node-layers`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({
        baseRevision: refreshed.projectRevision,
        nodeLayers: [{ projectRelativePath: node.projectRelativePath, locked: true }]
      })
    });

    const event = await readNextSseMessage<{
      type: string;
      projection: { nodes: Array<{ projectRelativePath: string; availability: { state: string; fileUrl?: string } }> };
    }>(response);
    const eventNode = event.projection.nodes.find((item) => item.projectRelativePath === node.projectRelativePath)!;

    expect(event.type).toBe('canvas.changed');
    expect(eventNode.availability.fileUrl).toBe(node.availability.fileUrl);
  });

  it('adds project tree paths to Canvas Maps through the HTTP Canvas route', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-canvas-map-route-project-'));
    await mkdir(join(projectRoot, 'prompts'), { recursive: true });
    await writeFile(join(projectRoot, 'prompts/cover.md'), '# Cover\n', 'utf8');
    await writeFile(join(projectRoot, 'prompts/alt.md'), '# Alt\n', 'utf8');
    await writeFile(join(projectRoot, 'prompts/conflict.md'), '# Conflict\n', 'utf8');

    let appServer: DebruteAppServer | undefined;
    const daemon = createDebruteDaemonHttpServer({
      createAppServer: () => {
        appServer = new DebruteAppServer();
        return appServer;
      },
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });
    await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource(['prompts/cover.md']));
    if (!appServer) {
      throw new Error('Daemon did not create a project app server.');
    }
    await appServer.publishCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });

    const result = await requestJson<{
      projectRevision: number;
      snapshot: { canvases: Array<{ id: string; nodeElements: Array<{ projectRelativePath: string }> }> };
      projection: { nodes: Array<{ projectRelativePath: string }> };
      centerProjectRelativePath: string;
    }>(`${runtime.daemonUrl}/api/projects/${opened.projectId}/canvases/canvas-1/canvas-map/project-paths`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({
        baseRevision: opened.projectRevision,
        projectRelativePath: 'prompts/alt.md'
      })
    });

    expect(result.centerProjectRelativePath).toBe('prompts/alt.md');
    expect(result.snapshot.canvases[0]?.nodeElements.map((node) => node.projectRelativePath)).toEqual(expect.arrayContaining([
      'prompts',
      'prompts/cover.md',
      'prompts/alt.md'
    ]));
    expect(result.projection.nodes.map((node) => node.projectRelativePath)).toContain('prompts/alt.md');
    await expect(readFile(join(projectRoot, '.debrute/canvas-maps/canvas-1.yaml'), 'utf8')).resolves.toBe(canvasMapSource([
      'prompts/cover.md',
      'prompts/alt.md'
    ]));

    await writeFile(join(projectRoot, '.debrute/canvas-maps/canvas-1.yaml'), canvasMapSource([
      'prompts/cover.md',
      'external/edit.md'
    ]), 'utf8');
    const conflict = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/canvases/canvas-1/canvas-map/project-paths`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({
        baseRevision: result.projectRevision,
        projectRelativePath: 'prompts/conflict.md'
      })
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: 'canvas_map_conflict' }
    });
  });

  it('manages canvases through project-scoped HTTP routes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-canvas-management-project-'));
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string; projectRevision: number }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });

    const created = await requestJson<{ projectRevision: number; activeCanvasId: string; snapshot: { canvasRegistry: { status: string; canvasOrder: string[] } } }>(
      `${runtime.daemonUrl}/api/projects/${opened.projectId}/canvases`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
        body: JSON.stringify({ baseRevision: opened.projectRevision })
      }
    );
    expect(created.activeCanvasId).toBe('canvas-2');
    expect(created.snapshot.canvasRegistry).toEqual({ status: 'ready', canvasOrder: ['canvas-1', 'canvas-2'] });

    const renamed = await requestJson<{ projectRevision: number; activeCanvasId: string; snapshot: { canvasRegistry: { status: string; canvasOrder: string[] } } }>(
      `${runtime.daemonUrl}/api/projects/${opened.projectId}/canvases/canvas-2`,
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-debrute-daemon-token': 'test-token'
        },
        body: JSON.stringify({ baseRevision: created.projectRevision, operation: 'rename', nextCanvasId: 'storyboard' })
      }
    );
    expect(renamed.activeCanvasId).toBe('storyboard');
    expect(renamed.snapshot.canvasRegistry).toEqual({ status: 'ready', canvasOrder: ['canvas-1', 'storyboard'] });

    const reordered = await requestJson<{ projectRevision: number; snapshot: { canvasRegistry: { status: string; canvasOrder: string[] } } }>(
      `${runtime.daemonUrl}/api/projects/${opened.projectId}/canvases/index`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-debrute-daemon-token': 'test-token'
        },
        body: JSON.stringify({ baseRevision: renamed.projectRevision, canvasOrder: ['storyboard', 'canvas-1'] })
      }
    );
    expect(reordered.snapshot.canvasRegistry).toEqual({ status: 'ready', canvasOrder: ['storyboard', 'canvas-1'] });

    const deleted = await requestJson<{ projectRevision: number; activeCanvasId: string; snapshot: { canvasRegistry: { status: string; canvasOrder: string[] } } }>(
      `${runtime.daemonUrl}/api/projects/${opened.projectId}/canvases/storyboard`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
        body: JSON.stringify({ baseRevision: reordered.projectRevision })
      }
    );
    expect(deleted.activeCanvasId).toBe('canvas-1');
    expect(deleted.snapshot.canvasRegistry).toEqual({ status: 'ready', canvasOrder: ['canvas-1'] });

    await rm(join(projectRoot, '.debrute/canvases/index.json'));
    const repaired = await requestJson<{ activeCanvasId: string; snapshot: { canvasRegistry: { status: string; canvasOrder: string[] } } }>(
      `${runtime.daemonUrl}/api/projects/${opened.projectId}/canvases/index/repair`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
        body: JSON.stringify({ baseRevision: deleted.projectRevision })
      }
    );
    expect(repaired.activeCanvasId).toBe('canvas-1');
    expect(repaired.snapshot.canvasRegistry).toEqual({ status: 'ready', canvasOrder: ['canvas-1'] });
    await expect(readFile(join(projectRoot, '.debrute/canvases/index.json'), 'utf8')).resolves.toContain('"canvas-1"');
  });

  it('rejects unsupported methods on file and preview resource routes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-method-project-'));
    await mkdir(join(projectRoot, 'generated'), { recursive: true });
    await writeFile(join(projectRoot, 'generated/cover.png'), 'asset-bytes', 'utf8');

    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });

    for (const [method, path] of [
      ['POST', `/api/projects/${opened.projectId}/files/raw/generated/cover.png`],
      ['POST', `/api/projects/${opened.projectId}/canvas-image-preview?path=generated%2Fcover.png&v=rev&w=512`],
      ['GET', `/api/projects/${opened.projectId}/generated-assets/lookup?path=generated%2Fcover.png`]
    ] as const) {
      const response = await fetch(`${runtime.daemonUrl}${path}`, {
        method,
        headers: { 'x-debrute-daemon-token': 'test-token' }
      });
      expect(response.status, `${method} ${path}`).toBe(405);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'method_not_allowed' }
      });
    }
  });
});

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, init);
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  return response.json() as Promise<T>;
}

async function apiFetch(url: string, init: RequestInit = {}, token = 'test-token'): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('x-debrute-daemon-token')) {
    headers.set('x-debrute-daemon-token', token);
  }
  return fetch(url, {
    ...init,
    headers
  });
}

async function writeCanvasMap(projectRoot: string, canvasId: string, content: string): Promise<void> {
  await mkdir(join(projectRoot, '.debrute/canvas-maps'), { recursive: true });
  await writeFile(join(projectRoot, `.debrute/canvas-maps/${canvasId}.yaml`), content, 'utf8');
}

function canvasMapSource(paths: string[]): string {
  return [
    'paths:',
    ...paths.map((path) => `  - ${path}`),
    ''
  ].join('\n');
}

async function readNextSseMessage<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('SSE response did not include a body.');
  }
  let content = '';
  try {
    while (true) {
      const chunk = await readWithTimeout(reader);
      if (chunk.done) {
        break;
      }
      content += new TextDecoder().decode(chunk.value);
      const dataLine = content.split('\n').find((line) => line.startsWith('data: '));
      if (dataLine) {
        return JSON.parse(dataLine.slice('data: '.length)) as T;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  throw new Error('SSE response did not include an event payload.');
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for SSE event.')), 1000);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function projectSnapshotFixture(projectRoot: string) {
  return {
    metadata: {
      schemaVersion: 1,
      project: {
        id: 'project',
        name: 'Project',
        createdAt: '2026-05-26T00:00:00.000Z',
        updatedAt: '2026-05-26T00:00:00.000Z'
      }
    },
    projectRoot,
    files: [],
    canvases: [],
    projections: [],
    diagnostics: [],
    canvasRegistry: { status: 'ready', canvasOrder: [] },
    health: {
      projectName: 'Project',
      canvasCount: 0,
      diagnosticCounts: { errors: 0, warnings: 0, infos: 0 },
      runtimeDataLocation: '/runtime',
      checkedAt: '2026-05-26T00:00:00.000Z'
    }
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
