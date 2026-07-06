import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DebruteAppServer, GlobalConfigStore } from '@debrute/app-server';
import { createDebruteDaemonHttpServer } from '@debrute/daemon';
import type {
  AppServerEvent,
  RunIntegrationOperationResult,
  WorkbenchProjectOpenResult,
  WorkbenchProjectPickerOpenResult,
  WorkbenchTitleBarState
} from '@debrute/app-protocol';
import { projectFileRevision } from '@debrute/project-core';
import sharp from 'sharp';

const SHORT_PROJECT_IDLE_TTL_MS = 200;
const AFTER_SHORT_PROJECT_IDLE_TTL_MS = 260;

describe('daemon HTTP runtime', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.shift()?.();
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

  it('serves browser session credentials only through the bootstrap route', async () => {
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: 'http://127.0.0.1:17322'
    });
    cleanups.push(() => daemon.close());
    const runtime = await daemon.listen();

    const credential = await fetch(`${runtime.daemonUrl}/api/browser-session`, {
      headers: { origin: 'http://127.0.0.1:17322' }
    });
    expect(credential.status).toBe(200);
    expect(credential.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:17322');
    await expect(credential.json()).resolves.toEqual({
      token: 'test-token',
      runtime: {
        daemonUrl: runtime.daemonUrl,
        webBaseUrl: runtime.webBaseUrl,
        platform: process.platform
      }
    });

    const tokenlessLoopback = await fetch(`${runtime.daemonUrl}/api/browser-session`);
    expect(tokenlessLoopback.status).toBe(403);
    await expect(tokenlessLoopback.json()).resolves.toMatchObject({
      error: { code: 'forbidden' }
    });

    const workbenchClaimed = await fetch(`${runtime.daemonUrl}/api/browser-session`, {
      headers: { 'x-debrute-web-origin': 'http://127.0.0.1:17322' }
    });
    expect(workbenchClaimed.status).toBe(200);
    await expect(workbenchClaimed.json()).resolves.toMatchObject({
      token: 'test-token'
    });

    const rejectedDaemonOrigin = await fetch(`${runtime.daemonUrl}/api/browser-session`, {
      headers: {
        origin: runtime.daemonUrl,
        'x-debrute-web-origin': 'http://127.0.0.1:17322'
      }
    });
    expect(rejectedDaemonOrigin.status).toBe(403);

    const rejectedOrigin = await fetch(`${runtime.daemonUrl}/api/browser-session`, {
      headers: { origin: 'http://example.com' }
    });
    expect(rejectedOrigin.status).toBe(403);

    const rejectedMethod = await fetch(`${runtime.daemonUrl}/api/browser-session`, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:17322' }
    });
    expect(rejectedMethod.status).toBe(405);
    await expect(rejectedMethod.json()).resolves.toMatchObject({
      error: { code: 'method_not_allowed' }
    });
  });

  it('protects the project picker open route with token and method checks', async () => {
    const nativeShell = nativeShellFixture(async () => undefined);
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      nativeShell
    });
    cleanups.push(() => daemon.close());
    const runtime = await daemon.listen();

    const tokenless = await fetch(`${runtime.daemonUrl}/api/projects/open-picker`, {
      method: 'POST'
    });
    expect(tokenless.status).toBe(403);
    expect(nativeShell.chooseDirectory).not.toHaveBeenCalled();

    const wrongMethod = await fetch(`${runtime.daemonUrl}/api/projects/open-picker`, {
      headers: { 'x-debrute-daemon-token': runtime.token }
    });
    expect(wrongMethod.status).toBe(405);
    await expect(wrongMethod.json()).resolves.toMatchObject({
      error: { code: 'method_not_allowed' }
    });
  });

  it('returns a quiet cancel result when the native picker is canceled', async () => {
    const nativeShell = nativeShellFixture(async () => undefined);
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      nativeShell
    });
    cleanups.push(() => daemon.close());
    const runtime = await daemon.listen();

    const result = await requestJson<WorkbenchProjectPickerOpenResult>(`${runtime.daemonUrl}/api/projects/open-picker`, {
      method: 'POST',
      headers: { 'x-debrute-daemon-token': runtime.token }
    });

    expect(result).toEqual({ opened: false });
  });

  it('opens picker-selected directories without exposing projectRoot in the response', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-picker-open-'));
    await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');
    const nativeShell = nativeShellFixture(async () => projectRoot);
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      nativeShell
    });
    cleanups.push(
      () => daemon.close(),
      () => rm(projectRoot, { recursive: true, force: true })
    );
    const runtime = await daemon.listen();

    const result = await requestJson<WorkbenchProjectPickerOpenResult>(`${runtime.daemonUrl}/api/projects/open-picker`, {
      method: 'POST',
      headers: { 'x-debrute-daemon-token': runtime.token }
    });

    expect(result).toMatchObject({
      opened: true,
      projectRevision: 1,
      snapshot: {
        files: expect.arrayContaining([{ projectRelativePath: 'brief.md', kind: 'file' }])
      }
    });
    expect(result.opened && result.projectId).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain(projectRoot);
    expect(JSON.stringify(result)).not.toContain('projectRoot');
    expect(daemon.projectRootForProjectId(result.opened ? result.projectId : '')).toBe(await realpath(projectRoot));
  });

  it('rejects picker-selected paths that are not directories', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-picker-file-'));
    const filePath = join(projectRoot, 'brief.md');
    await writeFile(filePath, '# Brief', 'utf8');
    const nativeShell = nativeShellFixture(async () => filePath);
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      nativeShell
    });
    cleanups.push(
      () => daemon.close(),
      () => rm(projectRoot, { recursive: true, force: true })
    );
    const runtime = await daemon.listen();

    const response = await fetch(`${runtime.daemonUrl}/api/projects/open-picker`, {
      method: 'POST',
      headers: { 'x-debrute-daemon-token': runtime.token }
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'invalid_input',
        message: 'projectRoot must resolve to a directory.'
      }
    });
  });

  it('rejects explicit project opens with non-absolute paths', async () => {
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token'
    });
    cleanups.push(() => daemon.close());
    const runtime = await daemon.listen();

    const response = await fetch(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': runtime.token
      },
      body: JSON.stringify({ projectRoot: 'relative/project' })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'invalid_input',
        message: 'projectRoot must be an absolute local path.'
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

  it('redacts sensitive fields and credential query parameters from daemon HTTP errors', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-error-redaction-'));
    const listeners = new Set<(event: AppServerEvent) => void>();
    let currentSnapshot = projectSnapshotFixture(projectRoot);
    const appServer = {
      openProject: async (root: string) => {
        currentSnapshot = projectSnapshotFixture(root);
        return currentSnapshot;
      },
      getSnapshot: () => currentSnapshot,
      currentSnapshot: () => currentSnapshot,
      drainSessionOperations: async () => undefined,
      refreshProject: async () => {
        const error = new Error('Upstream rejected https://api.example.test/v1/models?api_key=sk-http-secret') as Error & {
          code: string;
          fields: Record<string, unknown>;
        };
        error.code = 'provider_failed';
        error.fields = {
          apiKey: 'sk-http-secret',
          url: 'https://api.example.test/v1/models?token=sk-http-secret&model=gpt',
          nested: {
            authorization: 'Bearer sk-http-secret',
            message: 'provider echoed a credential'
          }
        };
        throw error;
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
    const opened = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot })
    });

    const response = await apiFetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/refresh`, {
      method: 'POST',
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(JSON.stringify(body)).not.toContain('sk-http-secret');
    expect(body).toMatchObject({
      error: {
        code: 'provider_failed',
        message: 'Upstream rejected https://api.example.test/v1/models?api_key=%5Bredacted%5D',
        details: {
          apiKey: '[redacted]',
          url: 'https://api.example.test/v1/models?token=%5Bredacted%5D&model=gpt',
          nested: {
            authorization: '[redacted]',
            message: 'provider echoed a credential'
          }
        }
      }
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

  it('serves supported project image formats with registry content types', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-image-content-types-'));
    await mkdir(join(projectRoot, 'assets'), { recursive: true });
    await writeFile(join(projectRoot, 'assets/photo.jpe'), 'jpeg-bytes', 'utf8');
    await writeFile(join(projectRoot, 'assets/photo.jfif'), 'jpeg-bytes', 'utf8');
    await writeFile(join(projectRoot, 'assets/render.avif'), 'avif-bytes', 'utf8');
    await writeFile(join(projectRoot, 'assets/scan.tif'), 'tiff-bytes', 'utf8');
    await writeFile(join(projectRoot, 'assets/scan.tiff'), 'tiff-bytes', 'utf8');
    await writeFile(join(projectRoot, 'assets/icon.svgz'), 'svgz-bytes', 'utf8');
    await writeFile(join(projectRoot, 'assets/animated.gif'), 'gif-bytes', 'utf8');

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

    for (const [path, contentType] of [
      ['assets/photo.jpe', 'image/jpeg'],
      ['assets/photo.jfif', 'image/jpeg'],
      ['assets/render.avif', 'image/avif'],
      ['assets/scan.tif', 'image/tiff'],
      ['assets/scan.tiff', 'image/tiff'],
      ['assets/icon.svgz', 'image/svg+xml']
    ] as const) {
      const fileStat = await stat(join(projectRoot, path));
      const revision = projectFileRevision(fileStat.size, fileStat.mtimeMs);
      const response = await apiFetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/files/raw/${path}?v=${revision}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(contentType);
      await response.arrayBuffer();
    }

    const gifStat = await stat(join(projectRoot, 'assets/animated.gif'));
    const gifRevision = projectFileRevision(gifStat.size, gifStat.mtimeMs);
    const gif = await apiFetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/files/raw/assets/animated.gif?v=${gifRevision}`);
    expect(gif.status).toBe(200);
    expect(gif.headers.get('content-type')).toBe('application/octet-stream');
    await gif.arrayBuffer();
  });

  it('serves supported audio video and VTT project files with media content types', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-media-content-types-'));
    await mkdir(join(projectRoot, 'assets'), { recursive: true });
    for (const [path, body] of [
      ['assets/clip.mp4', 'mp4-bytes'],
      ['assets/clip.webm', 'webm-bytes'],
      ['assets/clip.mov', 'mov-bytes'],
      ['assets/clip.m4v', 'm4v-bytes'],
      ['assets/theme.mp3', 'mp3-bytes'],
      ['assets/theme.wav', 'wav-bytes'],
      ['assets/theme.ogg', 'ogg-bytes'],
      ['assets/theme.m4a', 'm4a-bytes'],
      ['assets/theme.aac', 'aac-bytes'],
      ['assets/theme.flac', 'flac-bytes'],
      ['assets/theme.weba', 'weba-bytes'],
      ['assets/clip.en.vtt', 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n']
    ] as const) {
      await writeFile(join(projectRoot, path), body, 'utf8');
    }

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

    for (const [path, contentType] of [
      ['assets/clip.mp4', 'video/mp4'],
      ['assets/clip.webm', 'video/webm'],
      ['assets/clip.mov', 'video/quicktime'],
      ['assets/clip.m4v', 'video/x-m4v'],
      ['assets/theme.mp3', 'audio/mpeg'],
      ['assets/theme.wav', 'audio/wav'],
      ['assets/theme.ogg', 'audio/ogg'],
      ['assets/theme.m4a', 'audio/mp4'],
      ['assets/theme.aac', 'audio/mp4'],
      ['assets/theme.flac', 'audio/flac'],
      ['assets/theme.weba', 'audio/webm'],
      ['assets/clip.en.vtt', 'text/vtt; charset=utf-8']
    ] as const) {
      const fileStat = await stat(join(projectRoot, path));
      const revision = projectFileRevision(fileStat.size, fileStat.mtimeMs);
      const response = await apiFetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/files/raw/${path}?v=${revision}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(contentType);
      await response.arrayBuffer();
    }
  });

  it('serves raw project files with byte range responses', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-raw-range-'));
    await mkdir(join(projectRoot, 'generated'), { recursive: true });
    await writeFile(join(projectRoot, 'generated/clip.mp4'), '0123456789', 'utf8');

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
    const fileStat = await stat(join(projectRoot, 'generated/clip.mp4'));
    const revision = projectFileRevision(fileStat.size, fileStat.mtimeMs);
    const baseUrl = `${runtime.daemonUrl}/api/projects/${opened.projectId}/files/raw/generated/clip.mp4?v=${revision}`;

    const first = await apiFetch(baseUrl, { headers: { range: 'bytes=2-5' } });
    expect(first.status).toBe(206);
    expect(first.headers.get('accept-ranges')).toBe('bytes');
    expect(first.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(first.headers.get('content-length')).toBe('4');
    expect(await first.text()).toBe('2345');

    const openEnded = await apiFetch(baseUrl, { headers: { range: 'bytes=7-' } });
    expect(openEnded.status).toBe(206);
    expect(openEnded.headers.get('content-range')).toBe('bytes 7-9/10');
    expect(await openEnded.text()).toBe('789');

    const suffix = await apiFetch(baseUrl, { headers: { range: 'bytes=-3' } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get('content-range')).toBe('bytes 7-9/10');
    expect(await suffix.text()).toBe('789');

    const invalid = await apiFetch(baseUrl, { headers: { range: 'bytes=20-30' } });
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get('content-range')).toBe('bytes */10');
  });

  it('protects native project path operations with daemon token and validates project paths', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-native-path-'));
    await mkdir(join(projectRoot, 'briefs'), { recursive: true });
    await writeFile(join(projectRoot, 'briefs/outline.md'), '# Outline', 'utf8');
    const nativeShell = nativeShellFixture(async () => undefined);

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
      modelRunId: 'model-run-1',
      projectRelativePath: 'generated/cover.png',
      artifactRole: 'primary-image',
      artifactIndex: 0,
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

    await expect(readNextNonBridgeSseMessage<{ type: string }>(betaEvents)).resolves.toMatchObject({
      type: 'project.changed'
    });
    await expect(readNextNonBridgeSseMessage(alphaEvents)).rejects.toThrow('Timed out waiting for SSE event.');
  });

  it('does not expose Canvas settings HTTP routes', async () => {
    const debruteHome = await mkdtemp(join(tmpdir(), 'debrute-daemon-no-canvas-settings-home-'));
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null,
      appServerOptions: {
        globalConfigStore: new GlobalConfigStore({ debruteHome })
      }
    });
    cleanups.push(() => daemon.close());
    cleanups.push(() => rm(debruteHome, { recursive: true, force: true }));
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
    expect(aggregate).toHaveProperty('audioModels');
    expect(getResponse.status).toBe(404);
    expect(putResponse.status).toBe(404);
  }, 30_000);

  it('runs integration operations through the global integrations HTTP route', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'debrute-daemon-integrations-operation-bin-'));
    const magickPath = join(binDir, 'magick');
    await writeFakePackageManager(binDir, 'brew', [
      'if [ "$1" = "info" ]; then',
      '  printf \'{"formulae":[{"name":"imagemagick","versions":{"stable":"7.1.2-23"},"installed":[]}],"casks":[]}\\n\'',
      'fi',
      'if [ "$1" = "install" ]; then',
      `  printf '%s\\n' '#!/bin/sh' 'printf "Version: ImageMagick 7.1.2-23\\n"' > ${JSON.stringify(magickPath)}`,
      `  chmod +x ${JSON.stringify(magickPath)}`,
      'fi'
    ].join('\n'));
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null,
      appServerOptions: {
        integrationEnvPath: binDir,
        integrationPlatform: 'darwin'
      }
    });
    cleanups.push(() => daemon.close(), () => rm(binDir, { recursive: true, force: true }));
    const runtime = await daemon.listen();

    const result = await requestJson<RunIntegrationOperationResult>(
      `${runtime.daemonUrl}/api/integrations/imagemagick/install`,
      {
        method: 'POST',
        headers: { 'x-debrute-daemon-token': 'test-token' }
      }
    );

    expect(result).toMatchObject({
      ok: true,
      integrationId: 'imagemagick',
      operation: 'install'
    });
    expect(result.settings.runningOperation).toBeUndefined();
    expect(result.settings.integrations.find((integration) => integration.integrationId === 'imagemagick')?.status).toBe('ready');

    const invalidId = await fetch(`${runtime.daemonUrl}/api/integrations/unknown/install`, {
      method: 'POST',
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    expect(invalidId.status).toBe(404);

    const invalidOperation = await fetch(`${runtime.daemonUrl}/api/integrations/imagemagick/preview`, {
      method: 'POST',
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    expect(invalidOperation.status).toBe(404);
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

  it('keeps a project session live through the Electron window HTTP lease API', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-electron-window-http-project-'));
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

    await expect(requestJson(`${runtime.daemonUrl}/api/projects/${opened.projectId}/electron-windows/42`, {
      method: 'PUT'
    })).resolves.toEqual({ ok: true, projectRoot: await realpath(projectRoot) });
    await delay(AFTER_SHORT_PROJECT_IDLE_TTL_MS);

    await expect(requestJson(`${runtime.daemonUrl}/api/projects/${opened.projectId}`))
      .resolves.toMatchObject({ projectId: opened.projectId });

    await expect(apiFetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/electron-windows/42`, {
      method: 'DELETE'
    })).resolves.toMatchObject({ status: 204 });
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
    await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource([{ glob: 'image-production/generated/*.png' }]));
    if (!appServer) {
      throw new Error('Daemon did not create a project app server.');
    }
    await appServer.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });
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
    await requestJson(`${runtime.daemonUrl}/api/projects/${opened.projectId}/canvases/canvas-1/node-layouts`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({
        baseRevision: refreshed.projectRevision,
        nodeLayouts: [{ projectRelativePath: node.projectRelativePath, x: node.x + 10, y: node.y }]
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

  it('serves video text track companions with browser file URLs at the HTTP snapshot boundary', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-video-presentation-urls-project-'));
    const binDir = await mkdtemp(join(tmpdir(), 'debrute-daemon-video-presentation-urls-bin-'));
    await mkdir(join(projectRoot, 'media'), { recursive: true });
    await writeFile(join(projectRoot, 'media/clip.mp4'), 'video-bytes', 'utf8');
    await writeFile(join(projectRoot, 'media/clip.poster.webp'), 'poster-bytes', 'utf8');
    await writeFile(join(projectRoot, 'media/clip.en.vtt'), 'WEBVTT\n', 'utf8');
    await mkdir(join(projectRoot, '.debrute/canvases'), { recursive: true });
    await mkdir(join(projectRoot, '.debrute/canvas-maps'), { recursive: true });
    await writeFile(join(projectRoot, '.debrute/project.json'), JSON.stringify(projectMetadata('Video Presentation URLs'), null, 2), 'utf8');
    await writeFile(join(projectRoot, '.debrute/canvases/index.json'), JSON.stringify({ canvasOrder: ['canvas-1'] }, null, 2), 'utf8');
    await writeFile(join(projectRoot, '.debrute/canvases/canvas-1.json'), JSON.stringify({
      id: 'canvas-1',
      name: 'canvas-1',
      nodeElements: [{
        projectRelativePath: 'media/clip.mp4',
        nodeKind: 'file',
        mediaKind: 'video',
        x: 0,
        y: 0,
        width: 640,
        height: 360,
        z: 0
      }],
      annotations: [],
      preferences: { showDiagnostics: true }
    }, null, 2), 'utf8');
    await writeFile(join(projectRoot, '.debrute/canvas-maps/canvas-1.yaml'), canvasMapSource(['media/clip.mp4']), 'utf8');
    await writeFakeFfprobe(binDir, {
      streams: [{ codec_type: 'video', width: 640, height: 360, duration: '5' }],
      format: { duration: '5' }
    });

    const daemon = createDebruteDaemonHttpServer({
      appServerOptions: {
        integrationEnvPath: binDir
      },
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null
    });
    cleanups.push(
      () => daemon.close(),
      () => rm(projectRoot, { recursive: true, force: true }),
      () => rm(binDir, { recursive: true, force: true })
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

    const refreshed = await requestJson<{
      snapshot: {
        projections: Array<{
          nodes: Array<{
            projectRelativePath: string;
            availability: { state: string; fileUrl?: string };
            videoPresentation?: Record<string, unknown> & {
              textTracks: Array<{ projectRelativePath: string; fileUrl?: string }>;
            };
          }>;
        }>;
      };
    }>(`${runtime.daemonUrl}/api/projects/${opened.projectId}/refresh`, {
      method: 'POST',
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });

    const node = refreshed.snapshot.projections[0]!.nodes.find((item) => item.projectRelativePath === 'media/clip.mp4')!;
    expect(node.availability.fileUrl).toContain(`/api/projects/${opened.projectId}/files/raw/media/clip.mp4`);
    expect(node.videoPresentation).not.toHaveProperty('poster');
    expect(node.videoPresentation?.textTracks[0]?.fileUrl).toContain(`/api/projects/${opened.projectId}/files/raw/media/clip.en.vtt`);
  });

  it('resets manual Canvas layout through the HTTP Canvas route', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-canvas-reset-route-project-'));
    await mkdir(join(projectRoot, 'prompts'), { recursive: true });
    await mkdir(join(projectRoot, 'outputs/gpt'), { recursive: true });
    await writeFile(join(projectRoot, 'prompts/cover.md'), '# Cover\n', 'utf8');
    await writeFile(join(projectRoot, 'outputs/gpt/a.md'), '# A\n', 'utf8');

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
    await writeCanvasMap(projectRoot, 'canvas-1', canvasMapSource(['prompts/cover.md', { glob: 'outputs/**/*.md' }]));
    if (!appServer) {
      throw new Error('Daemon did not create a project app server.');
    }
    await appServer.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });
    const refreshed = await requestJson<{ projectRevision: number }>(`${runtime.daemonUrl}/api/projects/${opened.projectId}/refresh`, {
      method: 'POST',
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    const layout = await requestJson<{ projectRevision: number }>(`${runtime.daemonUrl}/api/projects/${opened.projectId}/canvases/canvas-1/node-layouts`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({
        baseRevision: refreshed.projectRevision,
        nodeLayouts: [
          { projectRelativePath: 'prompts/cover.md', x: 1000, y: 900 },
          { projectRelativePath: 'outputs/gpt/a.md', x: 1200, y: 950 }
        ]
      })
    });

    const partialReset = await requestJson<{
      projectRevision: number;
      resetCount: number;
      canvas: { nodeElements: Array<{ projectRelativePath: string; layoutMode?: string }> };
      projection: { nodes: Array<{ projectRelativePath: string }> };
    }>(`${runtime.daemonUrl}/api/projects/${opened.projectId}/canvases/canvas-1/reset-layout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({
        baseRevision: layout.projectRevision,
        pathRules: { globs: ['outputs/**/*.md'] }
      })
    });

    expect(partialReset.resetCount).toBe(1);
    expect(partialReset.canvas.nodeElements.find((node) => node.projectRelativePath === 'outputs/gpt/a.md')).not.toHaveProperty('layoutMode');
    expect(partialReset.canvas.nodeElements.find((node) => node.projectRelativePath === 'prompts/cover.md')).toHaveProperty('layoutMode', 'manual');

    const allReset = await requestJson<{
      resetCount: number;
      canvas: { nodeElements: Array<{ projectRelativePath: string; layoutMode?: string }> };
      projection: { nodes: Array<{ projectRelativePath: string }> };
    }>(`${runtime.daemonUrl}/api/projects/${opened.projectId}/canvases/canvas-1/reset-layout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({
        baseRevision: partialReset.projectRevision,
        all: true
      })
    });

    expect(allReset.resetCount).toBe(1);
    expect(allReset.canvas.nodeElements.find((node) => node.projectRelativePath === 'prompts/cover.md')).not.toHaveProperty('layoutMode');
    expect(allReset.projection.nodes.map((node) => node.projectRelativePath)).toContain('prompts/cover.md');
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
    await appServer.pushCanvasMapForProject(projectRoot, { canvasId: 'canvas-1' });

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
        body: JSON.stringify({ baseRevision: created.projectRevision, operation: 'rename', name: 'Storyboard' })
      }
    );
    expect(renamed.activeCanvasId).toBe('canvas-2');
    expect(renamed.snapshot.canvasRegistry).toEqual({ status: 'ready', canvasOrder: ['canvas-1', 'canvas-2'] });

    const reordered = await requestJson<{ projectRevision: number; snapshot: { canvasRegistry: { status: string; canvasOrder: string[] } } }>(
      `${runtime.daemonUrl}/api/projects/${opened.projectId}/canvases/index`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-debrute-daemon-token': 'test-token'
        },
        body: JSON.stringify({ baseRevision: renamed.projectRevision, canvasOrder: ['canvas-2', 'canvas-1'] })
      }
    );
    expect(reordered.snapshot.canvasRegistry).toEqual({ status: 'ready', canvasOrder: ['canvas-2', 'canvas-1'] });

    const deleted = await requestJson<{ projectRevision: number; activeCanvasId: string; snapshot: { canvasRegistry: { status: string; canvasOrder: string[] } } }>(
      `${runtime.daemonUrl}/api/projects/${opened.projectId}/canvases/canvas-2`,
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

  it('serves Workbench title-bar state from runtime chrome state', async () => {
    const debruteHome = await mkdtemp(join(tmpdir(), 'debrute-titlebar-state-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-titlebar-state-project-'));
    await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');
    const daemon = createDebruteDaemonHttpServer({
      appServerOptions: {
        globalConfigStore: new GlobalConfigStore({ debruteHome })
      },
      host: '127.0.0.1',
      port: 0,
      token: 'test-token'
    });
    cleanups.push(
      () => daemon.close(),
      () => rm(debruteHome, { recursive: true, force: true }),
      () => rm(projectRoot, { recursive: true, force: true })
    );
    const runtime = await daemon.listen();

    const opened = await requestJson<WorkbenchProjectOpenResult>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': runtime.token
      },
      body: JSON.stringify({ projectRoot })
    });

    const titleBar = await requestJson<WorkbenchTitleBarState>(
      `${runtime.daemonUrl}/api/workbench/title-bar?host=desktop&projectId=${opened.projectId}`,
      { headers: { 'x-debrute-daemon-token': runtime.token } }
    );

    expect(titleBar.title).toBe(opened.snapshot.metadata.project.name);
    expect(titleBar.recentProjectRoots).toEqual([await realpath(projectRoot)]);
    expect(titleBar.menus.map((menu) => menu.label)).toEqual(['File', 'Edit', 'View']);
  });

  it('rejects invalid Workbench title-bar host values', async () => {
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token'
    });
    cleanups.push(() => daemon.close());
    const runtime = await daemon.listen();

    const response = await fetch(`${runtime.daemonUrl}/api/workbench/title-bar?host=mobile`, {
      headers: { 'x-debrute-daemon-token': runtime.token }
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_input' }
    });
  });

  it('clears runtime recent projects through the Workbench chrome route', async () => {
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token'
    });
    cleanups.push(() => daemon.close());
    const runtime = await daemon.listen();

    const response = await fetch(`${runtime.daemonUrl}/api/workbench/recent-projects`, {
      method: 'DELETE',
      headers: { 'x-debrute-daemon-token': runtime.token }
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});

function nativeShellFixture(chooseDirectory: () => Promise<string | undefined>) {
  return {
    platform: process.platform,
    chooseDirectory: vi.fn(chooseDirectory),
    showItemInFolder: vi.fn(async () => undefined),
    openPath: vi.fn(async () => undefined),
    trashItem: vi.fn(async () => undefined)
  };
}

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

async function writeFakeFfprobe(binDir: string, output: unknown): Promise<void> {
  await mkdir(binDir, { recursive: true });
  const path = join(binDir, 'ffprobe');
  await writeFile(path, [
    '#!/bin/sh',
    `printf '%s\\n' ${JSON.stringify(JSON.stringify(output))}`,
    ''
  ].join('\n'), 'utf8');
  await chmod(path, 0o755);
}

async function writeFakePackageManager(dir: string, name: string, body: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, ['#!/bin/sh', body].join('\n'), 'utf8');
  await chmod(path, 0o755);
  return path;
}

function projectMetadata(name: string) {
  return {
    project: {
      id: `${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-id`,
      name,
      createdAt: '2026-06-30T00:00:00.000Z',
      updatedAt: '2026-06-30T00:00:00.000Z'
    }
  };
}

function canvasMapSource(paths: Array<string | { glob: string }>): string {
  return [
    'paths:',
    ...paths.map((path) => typeof path === 'string' ? `  - ${path}` : `  - glob: ${path.glob}`),
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

async function readNextNonBridgeSseMessage<T>(response: Response): Promise<T> {
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
      let eventEnd = content.indexOf('\n\n');
      while (eventEnd !== -1) {
        const eventBlock = content.slice(0, eventEnd);
        content = content.slice(eventEnd + 2);
        const dataLine = eventBlock.split('\n').find((line) => line.startsWith('data: '));
        if (dataLine) {
          const parsed = JSON.parse(dataLine.slice('data: '.length)) as { type?: string };
          if (parsed.type !== 'adobeBridge.state.changed') {
            return parsed as T;
          }
        }
        eventEnd = content.indexOf('\n\n');
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
