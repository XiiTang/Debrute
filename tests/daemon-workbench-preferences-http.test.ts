import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GlobalConfigStore } from '@debrute/app-server';
import { createDebruteDaemonHttpServer } from '@debrute/daemon';

const invalidLocaleMessage = 'Workbench locale must be "en" or "zh-CN".';

describe('daemon Workbench preferences HTTP routes', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it('loads and saves Workbench preferences through tokened settings routes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-daemon-workbench-preferences-home-'));
    const daemon = createDaemon(home);
    cleanups.push(() => daemon.close(), () => rm(home, { recursive: true, force: true }));
    const runtime = await daemon.listen();

    const initial = await requestJson(`${runtime.daemonUrl}/api/settings/workbench-preferences`, {
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    expect(initial).toEqual({ locale: 'en' });

    const saved = await requestJson(`${runtime.daemonUrl}/api/settings/workbench-preferences`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ locale: 'zh-CN' })
    });

    expect(saved).toEqual({ locale: 'zh-CN' });
    await expect(readFile(join(home, 'config', 'workbench_preferences.json'), 'utf8')).resolves.toBe('{\n  "locale": "zh-CN"\n}\n');
  });

  it('rejects unsupported locales through the daemon route', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-daemon-workbench-invalid-locale-home-'));
    const daemon = createDaemon(home);
    cleanups.push(() => daemon.close(), () => rm(home, { recursive: true, force: true }));
    const runtime = await daemon.listen();

    const response = await fetch(`${runtime.daemonUrl}/api/settings/workbench-preferences`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ locale: 'fr' })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'invalid_input',
        message: invalidLocaleMessage
      }
    });
  });

  it('forwards Workbench preference changes to project event streams', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-daemon-workbench-event-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-workbench-event-project-'));
    const daemon = createDaemon(home);
    cleanups.push(
      () => daemon.close(),
      () => rm(projectRoot, { recursive: true, force: true }),
      () => rm(home, { recursive: true, force: true })
    );
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot })
    });

    const eventPromise = onceWorkbenchEvent(`${runtime.daemonUrl}/api/projects/${encodeURIComponent(opened.projectId)}/events?clientId=test-client&debrute-token=test-token`);
    await requestJson(`${runtime.daemonUrl}/api/settings/workbench-preferences`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ locale: 'zh-CN' })
    });

    await expect(eventPromise).resolves.toEqual({
      type: 'workbench.preferences.changed',
      preferences: { locale: 'zh-CN' }
    });
  });
});

function createDaemon(home: string) {
  return createDebruteDaemonHttpServer({
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    webBaseUrl: null,
    adobeBridgeDiscoveryPort: 0,
    appServerOptions: { globalConfigStore: new GlobalConfigStore({ debruteHome: home }) }
  });
}

async function requestJson<T = any>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

async function onceWorkbenchEvent(url: string): Promise<unknown> {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to open event stream: ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const { value } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
      }
      const event = parseFirstEvent(buffer);
      if (event) {
        return event;
      }
    }
    throw new Error('Timed out waiting for Workbench event.');
  } finally {
    controller.abort();
    reader.releaseLock();
  }
}

function parseFirstEvent(buffer: string): unknown | undefined {
  for (const chunk of buffer.split('\n\n')) {
    const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));
    if (dataLine) {
      return JSON.parse(dataLine.slice('data: '.length));
    }
  }
  return undefined;
}
