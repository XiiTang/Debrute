import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDebruteDaemonHttpServer } from '@debrute/daemon';

describe('daemon Canvas text preview routes', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it('requires project-scoped text preview source uploads to use POST', async () => {
    const response = await requestOpenProjectRoute({
      method: 'GET',
      path: '/canvas-text-previews/source'
    });

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'method_not_allowed' }
    });
  });

  it('requires project-scoped text preview source availability reads to use POST', async () => {
    const response = await requestOpenProjectRoute({
      method: 'GET',
      path: '/canvas-text-previews/sources'
    });

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'method_not_allowed' }
    });
  });

  async function requestOpenProjectRoute(input: { method: string; path: string }): Promise<Response> {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-text-preview-route-'));
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
      body: JSON.stringify({ projectRoot })
    });
    return fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}${input.path}`, {
      method: input.method,
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
  }
});

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type') && init.body !== undefined) {
    headers.set('content-type', 'application/json');
  }
  if (!headers.has('x-debrute-daemon-token')) {
    headers.set('x-debrute-daemon-token', 'test-token');
  }
  const response = await fetch(url, {
    ...init,
    headers
  });
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  return response.json() as Promise<T>;
}
