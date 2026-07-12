import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { DebruteAppServer, type OpenProjectOptions } from '@debrute/app-server';
import type { DebruteGlobalSettingsView, WorkbenchProjectOpenResult } from '@debrute/app-protocol';
import { DaemonTestHarness, readDaemonSseEvent } from '../../../helpers/daemonTestHarness.js';
import { waitForCondition } from '../../../helpers/testPaths.js';

const PROJECT_IDLE_TTL_MS = 1_000;

describe('daemon project session HTTP routes', () => {
  it('initializes a missing .debrute before exposing the opened session', async () => {
    await using harness = await DaemonTestHarness.create();
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-atomic-first-open-'));
    onTestFinished(() => rm(projectRoot, { recursive: true, force: true }));
    await expect(access(join(projectRoot, '.debrute'))).rejects.toMatchObject({ code: 'ENOENT' });

    const opened = await harness.fetchOkJson<WorkbenchProjectOpenResult>('/api/projects/open', {
      method: 'POST',
      body: JSON.stringify({ projectRoot })
    });

    expect(opened.snapshot.metadata.project.name).toBe(basename(projectRoot));
    expect(opened.snapshot.canvasRegistry).toEqual({
      status: 'ready',
      canvasOrder: ['canvas-1']
    });
    expect(opened.snapshot.canvases.map((canvas) => canvas.id)).toEqual(['canvas-1']);
    await Promise.all([
      access(join(projectRoot, '.debrute/project.json')),
      access(join(projectRoot, '.debrute/canvases/index.json')),
      access(join(projectRoot, '.debrute/canvases/canvas-1.json')),
      access(join(projectRoot, '.debrute/canvas-maps/canvas-1.yaml'))
    ]);
    await expect(harness.fetchOkJson('/api/projects')).resolves.toMatchObject({
      projects: [{
        projectId: opened.projectId,
        projectRevision: 1,
        snapshot: {
          metadata: opened.snapshot.metadata,
          canvasRegistry: opened.snapshot.canvasRegistry
        }
      }]
    });
    const settings = await harness.fetchOkJson<DebruteGlobalSettingsView>('/api/settings/global');
    expect(settings.chrome.recentProjectRoots).toEqual([await realpath(projectRoot)]);
  });

  it('exposes neither a session nor a recent project when initialization fails', async () => {
    await using harness = await DaemonTestHarness.create();
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-atomic-failed-open-'));
    onTestFinished(() => rm(projectRoot, { recursive: true, force: true }));
    await writeFile(join(projectRoot, '.debrute'), 'not a directory', 'utf8');

    const failed = await harness.fetchJson<{ error: { code: string } }>('/api/projects/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectRoot })
    });

    expect(failed.status).toBe(500);
    await expect(harness.fetchOkJson('/api/projects')).resolves.toEqual({ projects: [] });
    const settings = await harness.fetchOkJson<DebruteGlobalSettingsView>('/api/settings/global');
    expect(settings.chrome.recentProjectRoots).toEqual([]);
  });

  it('waits for an in-flight project open to cancel and clean up before shutdown', async () => {
    let markOpenStarted!: () => void;
    const openStarted = new Promise<void>((resolve) => {
      markOpenStarted = resolve;
    });
    let appServerClosed = false;
    class BlockingOpenAppServer extends DebruteAppServer {
      override async openProject(projectRoot: string, options: OpenProjectOptions = {}) {
        markOpenStarted();
        const signal = options.signal;
        if (!signal) {
          throw new Error('daemon project open requires a registry lifetime signal');
        }
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        signal.throwIfAborted();
        return super.openProject(projectRoot, options);
      }

      override close(): void {
        appServerClosed = true;
        super.close();
      }
    }
    await using harness = await DaemonTestHarness.create({
      createAppServer: (globalConfigStore) => new BlockingOpenAppServer({ globalConfigStore })
    });
    const { rootPath: projectRoot } = await harness.createProject();
    const opening = harness.fetchJson('/api/projects/open', {
      method: 'POST',
      body: JSON.stringify({ projectRoot })
    });
    await openStarted;

    await expect(harness.closeDaemon()).resolves.toBeUndefined();
    await expect(opening).rejects.toThrow();
    expect(appServerClosed).toBe(true);
  });

  it('emits project-scoped SSE events with project revisions', async () => {
    await using harness = await DaemonTestHarness.create();
    const runtime = harness.runtime;
    const { rootPath: projectRoot } = await harness.createProject();
    await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');
    const opened = await harness.fetchOkJson<{
      projectId: string;
      projectRevision: number;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot })
    });
    const events = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/events?clientId=client-a`, {
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    expect(events.status).toBe(200);
    await harness.fetchOkJson(`/api/projects/${opened.projectId}/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({
        baseRevision: opened.projectRevision,
        kind: 'file',
        parentProjectRelativePath: '',
        name: 'evented.md'
      })
    });
    await expect(readDaemonSseEvent<{
      projectId: string;
      projectRevision: number;
      type: string;
    }>(events))
      .resolves.toMatchObject({
      type: 'project.changed',
      projectId: opened.projectId,
      projectRevision: 2
    });
  });

  it('opens two live projects at the same time and isolates project routes', async () => {
    await using harness = await DaemonTestHarness.create({
      projectIdleTtlMs: 1000
    });
    const { rootPath: alphaRoot } = await harness.createProject();
    const { rootPath: betaRoot } = await harness.createProject();
    await writeFile(join(alphaRoot, 'brief.md'), '# Alpha', 'utf8');
    await writeFile(join(betaRoot, 'brief.md'), '# Beta', 'utf8');
    const alpha = await harness.fetchOkJson<{
      projectId: string;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot: alphaRoot })
    });
    const beta = await harness.fetchOkJson<{
      projectId: string;
      projectRevision: number;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot: betaRoot })
    });
    expect(alpha.projectId).not.toBe(beta.projectId);
    await expect(harness.fetchOkJson(`/api/projects/${alpha.projectId}/files/text/brief.md`))
      .resolves.toMatchObject({ content: '# Alpha' });
    await expect(harness.fetchOkJson(`/api/projects/${beta.projectId}/files/text/brief.md`))
      .resolves.toMatchObject({ content: '# Beta' });
  });

  it('reuses the live project id for the same canonical root', async () => {
    await using harness = await DaemonTestHarness.create({
      projectIdleTtlMs: 1000
    });
    const { rootPath: projectRoot } = await harness.createProject();
    await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');
    const first = await harness.fetchOkJson<{
      projectId: string;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot })
    });
    const second = await harness.fetchOkJson<{
      projectId: string;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot: join(projectRoot, '.') })
    });
    expect(second.projectId).toBe(first.projectId);
  });

  it('does not expose projects opened outside HTTP project-open routes', async () => {
    await using harness = await DaemonTestHarness.create();
    const runtime = harness.runtime;
    const { rootPath: projectRoot } = await harness.createProject();
    await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');
    const privateAppServer = new DebruteAppServer();
    onTestFinished(() => privateAppServer.close());
    await privateAppServer.openProject(projectRoot);
    await expect(fetch(`${runtime.daemonUrl}/api/runtime`).then((response) => response.json())).resolves.toEqual({
      daemonUrl: runtime.daemonUrl,
      webBaseUrl: runtime.webBaseUrl,
      platform: process.platform
    });
    await expect(harness.fetchOkJson('/api/projects')).resolves.toEqual({
      projects: []
    });
  });

  it('streams app-server events as server-sent events', async () => {
    await using harness = await DaemonTestHarness.create();
    const runtime = harness.runtime;
    const { rootPath: projectRoot } = await harness.createProject();
    await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');
    const opened = await harness.fetchOkJson<{
      projectId: string;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });
    const response = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/events`, {
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    await response.body?.cancel();
  });

  it('does not stream project events from one session to another project session', async () => {
    await using harness = await DaemonTestHarness.create();
    const runtime = harness.runtime;
    const { rootPath: alphaRoot } = await harness.createProject();
    const { rootPath: betaRoot } = await harness.createProject();
    await writeFile(join(alphaRoot, 'brief.md'), '# Alpha', 'utf8');
    await writeFile(join(betaRoot, 'brief.md'), '# Beta', 'utf8');
    const alpha = await harness.fetchOkJson<{
      projectId: string;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot: alphaRoot })
    });
    const beta = await harness.fetchOkJson<{
      projectId: string;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot: betaRoot })
    });
    const alphaEvents = await fetch(`${runtime.daemonUrl}/api/projects/${alpha.projectId}/events?clientId=alpha-client`, {
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    const betaEvents = await fetch(`${runtime.daemonUrl}/api/projects/${beta.projectId}/events?clientId=beta-client`, {
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    const betaTextFile = await harness.fetchOkJson<{ revision: string }>(
      `/api/projects/${beta.projectId}/files/text/brief.md`
    );
    await harness.fetchOkJson(`/api/projects/${beta.projectId}/files/text/brief.md`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({
        baseRevision: beta.projectRevision,
        content: '# Beta Updated',
        expectedRevision: betaTextFile.revision
      })
    });
    await expect(readDaemonSseEvent<{
      type: string;
    }>(betaEvents)).resolves.toMatchObject({
      type: 'project.fileChanged'
    });
    await expect(readDaemonSseEvent(alphaEvents)).rejects.toThrow('Timed out waiting for SSE event.');
  });

  it('releases a project session after the last event stream closes and idle TTL elapses', async () => {
    await using harness = await DaemonTestHarness.create({
      projectIdleTtlMs: PROJECT_IDLE_TTL_MS
    });
    const runtime = harness.runtime;
    const { rootPath: projectRoot } = await harness.createProject();
    await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');
    const opened = await harness.fetchOkJson<{
      projectId: string;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });
    const events = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/events?clientId=client-a`, {
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    expect(events.status).toBe(200);
    await expect(harness.fetchOkJson('/api/projects')).resolves.toMatchObject({
      projects: [{ projectId: opened.projectId, clients: { liveCount: 1 } }]
    });
    await events.body?.cancel();
    await waitForProjectRelease(harness, opened.projectId);
    const released = await harness.fetchJson<{
      error: {
        code: string;
      };
    }>(`/api/projects/${opened.projectId}`);
    expect(released.status).toBe(404);
    expect(released.body).toMatchObject({
      error: { code: 'project_not_open' }
    });
    await expect(harness.fetchOkJson('/api/projects')).resolves.toEqual({
      projects: []
    });
  });

  it('keeps a project session live while another event stream remains open', async () => {
    await using harness = await DaemonTestHarness.create({
      projectIdleTtlMs: PROJECT_IDLE_TTL_MS
    });
    const runtime = harness.runtime;
    const { rootPath: projectRoot } = await harness.createProject();
    await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');
    const opened = await harness.fetchOkJson<{
      projectId: string;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });
    const first = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/events?clientId=client-a`, {
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    const second = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/events?clientId=client-b`, {
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await first.body?.cancel();
    await expect(harness.fetchOkJson(`/api/projects/${opened.projectId}`))
      .resolves.toMatchObject({ projectId: opened.projectId });
    await expect(harness.fetchOkJson('/api/projects')).resolves.toMatchObject({
      projects: [{ projectId: opened.projectId, clients: { liveCount: 1 } }]
    });
    await second.body?.cancel();
    await waitForProjectRelease(harness, opened.projectId);
  });

  it('keeps a project session live while a project HTTP request is in flight', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => vi.useRealTimers());
    let markRefreshStarted!: () => void;
    let releaseRefresh!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    class BlockingRefreshAppServer extends DebruteAppServer {
      override async refreshProject() {
        markRefreshStarted();
        await refreshGate;
        return super.refreshProject();
      }
    }
    await using harness = await DaemonTestHarness.create({
      projectIdleTtlMs: PROJECT_IDLE_TTL_MS,
      createAppServer: (globalConfigStore) => new BlockingRefreshAppServer({ globalConfigStore })
    });
    const { rootPath: projectRoot } = await harness.createProject();
    const opened = await harness.fetchOkJson<{ projectId: string }>(`/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });

    const refreshing = harness.fetchOkJson(`/api/projects/${opened.projectId}/refresh`, { method: 'POST' });
    await refreshStarted;
    await vi.advanceTimersByTimeAsync(PROJECT_IDLE_TTL_MS);
    await expect(harness.fetchOkJson('/api/projects')).resolves.toMatchObject({
      projects: [{ projectId: opened.projectId }]
    });

    releaseRefresh();
    await refreshing;
    await vi.advanceTimersByTimeAsync(PROJECT_IDLE_TTL_MS);
    await expect(harness.fetchOkJson('/api/projects')).resolves.toEqual({ projects: [] });
  });

  it('keeps a project session live through the Electron window HTTP lease API', async () => {
    await using harness = await DaemonTestHarness.create({
      projectIdleTtlMs: PROJECT_IDLE_TTL_MS
    });
    const { rootPath: projectRoot } = await harness.createProject();
    await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');
    const opened = await harness.fetchOkJson<{
      projectId: string;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });
    await expect(harness.fetchOkJson(`/api/projects/${opened.projectId}/electron-windows/42`, {
      method: 'PUT'
    })).resolves.toEqual({ ok: true, projectRoot: await realpath(projectRoot) });
    await expect(harness.fetchOkJson(`/api/projects/${opened.projectId}`))
      .resolves.toMatchObject({ projectId: opened.projectId });
    await expect(harness.fetchBytes(`/api/projects/${opened.projectId}/electron-windows/42`, {
      method: 'DELETE'
    })).resolves.toMatchObject({ status: 204 });
    await waitForProjectRelease(harness, opened.projectId);
    const released = await harness.fetchJson(`/api/projects/${opened.projectId}`);
    expect(released.status).toBe(404);
  });
});

async function waitForProjectRelease(harness: DaemonTestHarness, projectId: string): Promise<void> {
  await waitForCondition(`project session ${projectId} to close`, async () => {
    const projects = await harness.fetchOkJson<{ projects: Array<{ projectId: string }> }>('/api/projects');
    return !projects.projects.some((project) => project.projectId === projectId);
  });
}
