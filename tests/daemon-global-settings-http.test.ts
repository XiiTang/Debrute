import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GlobalConfigStore } from '@debrute/app-server';
import { createDebruteDaemonHttpServer } from '@debrute/daemon';

const invalidLocaleMessage = 'Workbench locale must be "en" or "zh-CN".';
const invalidThemeMessage = 'Workbench theme preference must be "system", "dark", or "light".';
const invalidDefaultFrontendMessage = 'Global settings defaultFrontend must be "electron", "browser", or "runtime-only".';

describe('daemon runtime-owned global settings final contract', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it('loads and patches runtime-owned global settings through the tokened route', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-daemon-global-settings-home-'));
    const daemon = createDaemon(home);
    cleanups.push(() => daemon.close(), () => rm(home, { recursive: true, force: true }));
    const runtime = await daemon.listen();

    const initial = await requestJson(`${runtime.daemonUrl}/api/settings/global`, {
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    expect(initial).toMatchObject({
      workbench: {
        locale: 'en',
        themePreference: 'system',
        defaultFrontend: 'electron'
      },
      chrome: { recentProjectRoots: [] },
      models: {
        image: { models: expect.any(Array) },
        video: { models: expect.any(Array) },
        audio: { models: expect.any(Array) }
      },
      integrations: {
        integrations: expect.any(Array),
        backends: expect.any(Array)
      },
      adobeBridge: {
        enabled: true
      }
    });

    const saved = await requestJson(`${runtime.daemonUrl}/api/settings/global`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({
        workbench: { locale: 'zh-CN', themePreference: 'light', defaultFrontend: 'browser' }
      })
    });

    expect(saved).toMatchObject({
      workbench: { locale: 'zh-CN', themePreference: 'light', defaultFrontend: 'browser' },
      chrome: { recentProjectRoots: [] }
    });
    await expect(readFile(join(home, 'config', 'global_settings.json'), 'utf8')).resolves.toContain('"defaultFrontend": "browser"');
    expect(JSON.stringify(saved)).not.toContain('ApiKeys');
  });

  it('maps invalid runtime-owned global settings patches to invalid_input', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-daemon-global-settings-invalid-home-'));
    const daemon = createDaemon(home);
    cleanups.push(() => daemon.close(), () => rm(home, { recursive: true, force: true }));
    const runtime = await daemon.listen();

    await expectPatchError(runtime.daemonUrl, { workbench: { locale: 'fr' } }, invalidLocaleMessage);
    await expectPatchError(runtime.daemonUrl, { workbench: { themePreference: 'solarized' } }, invalidThemeMessage);
    await expectPatchError(runtime.daemonUrl, { workbench: { defaultFrontend: 'native' } }, invalidDefaultFrontendMessage);
    await expectPatchError(runtime.daemonUrl, { models: { image: null } }, 'Global settings models.image must be an object.');
    await expectPatchError(runtime.daemonUrl, { adobeBridge: { enabled: 'yes' } }, 'Adobe Bridge config must contain enabled.');
    await expectPatchError(runtime.daemonUrl, {
      models: {
        image: {
          modelId: 'gpt-image-2',
          setting: {
            baseUrlOverride: 123,
            requestModelIdOverride: null
          }
        }
      }
    }, 'Image model baseUrlOverride must be a string or null.');
    await expectPatchError(runtime.daemonUrl, {
      models: {
        image: {
          modelId: 'missing-image-model',
          setting: {
            baseUrlOverride: null,
            requestModelIdOverride: null
          }
        }
      }
    }, 'Unknown image model: missing-image-model');
  });

  it('forwards global settings changes to the global Workbench event stream without opening a project', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-daemon-global-settings-event-home-'));
    const daemon = createDaemon(home);
    cleanups.push(() => daemon.close(), () => rm(home, { recursive: true, force: true }));
    const runtime = await daemon.listen();

    const stream = await openWorkbenchEventStream(`${runtime.daemonUrl}/api/workbench/events?clientId=test-client`, {
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    cleanups.push(() => stream.close());
    const eventPromise = stream.next();
    await requestJson(`${runtime.daemonUrl}/api/settings/global`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ workbench: { locale: 'zh-CN', themePreference: 'dark', defaultFrontend: 'browser' } })
    });

    await expect(eventPromise).resolves.toMatchObject({
      type: 'globalSettings.changed',
      settings: {
        workbench: {
          locale: 'zh-CN',
          themePreference: 'dark',
          defaultFrontend: 'browser'
        }
      }
    });
  });

  it('returns a server error for malformed current settings', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-daemon-malformed-global-settings-'));
    const daemon = createDaemon(home);
    cleanups.push(() => daemon.close(), () => rm(home, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    await mkdir(join(home, 'config'), { recursive: true });
    await writeFile(join(home, 'config', 'global_settings.json'), '{', 'utf8');

    const response = await fetch(`${runtime.daemonUrl}/api/settings/global`, {
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });

    expect(response.status).toBe(500);
  });

  it('returns a server error for a broken current config path', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-daemon-broken-global-settings-path-'));
    const daemon = createDaemon(home);
    cleanups.push(() => daemon.close(), () => rm(home, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    await symlink(join(home, 'missing-config-target'), join(home, 'config'));

    const response = await fetch(`${runtime.daemonUrl}/api/settings/global`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ workbench: { locale: 'zh-CN' } })
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'internal_error' }
    });
  });

  it('returns complete integrations when the first global settings request is a patch', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-daemon-global-settings-first-patch-home-'));
    const daemon = createDaemon(home);
    cleanups.push(() => daemon.close(), () => rm(home, { recursive: true, force: true }));
    const runtime = await daemon.listen();

    const saved = await requestJson(`${runtime.daemonUrl}/api/settings/global`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ workbench: { locale: 'zh-CN' } })
    });

    expect(saved).toMatchObject({
      integrations: {
        integrations: expect.arrayContaining([expect.objectContaining({ integrationId: 'ffmpeg' })]),
        backends: expect.any(Array)
      }
    });
    expect(saved.integrations.integrations.length).toBeGreaterThan(0);
    expect(saved.integrations.backends.length).toBeGreaterThan(0);
  });

  it('applies adobeBridge global settings patches to the live plugin WebSocket state', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-daemon-global-settings-bridge-live-home-'));
    const daemon = createDaemon(home);
    cleanups.push(() => daemon.close(), () => rm(home, { recursive: true, force: true }));
    const runtime = await daemon.listen();

    await requestJson(`${runtime.daemonUrl}/api/settings/global`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ adobeBridge: { enabled: false } })
    });

    const socket = new WebSocket(`${runtime.daemonUrl.replace(/^http:/, 'ws:')}/api/adobe-bridge/plugin/ws`);
    cleanups.push(() => closeSocket(socket));
    await onceOpen(socket);
    socket.send(JSON.stringify({
      type: 'hello',
      adobeClientId: 'photoshop-disabled-client',
      hostApp: 'photoshop',
      hostVersion: '27.0',
      documentCount: 1,
      activeDocumentTitle: 'Artwork.psd'
    }));

    await expect(onceMessage(socket)).resolves.toContain('adobe_bridge_disabled');
  });

  it('forwards each Adobe Bridge settings change once to the global Workbench event stream', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-daemon-global-settings-bridge-event-home-'));
    const daemon = createDaemon(home);
    cleanups.push(() => daemon.close(), () => rm(home, { recursive: true, force: true }));
    const runtime = await daemon.listen();

    const stream = await openWorkbenchEventStream(`${runtime.daemonUrl}/api/workbench/events?clientId=test-client`, {
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    cleanups.push(() => stream.close());
    const eventPromise = stream.next((event) => isRecord(event) && event.type === 'adobeBridge.state.changed');
    await requestJson(`${runtime.daemonUrl}/api/settings/global`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ adobeBridge: { enabled: false } })
    });

    await expect(eventPromise).resolves.toMatchObject({
      type: 'adobeBridge.state.changed',
      state: {
        settings: {
          enabled: false,
          discoveryStatus: 'disabled'
        }
      }
    });
    await requestJson(`${runtime.daemonUrl}/api/settings/global`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ workbench: { locale: 'zh-CN' } })
    });
    await expect(stream.next()).resolves.toMatchObject({
      type: 'globalSettings.changed',
      settings: { workbench: { locale: 'zh-CN' } }
    });
  });

  it('does not emit Adobe live state events for a read-only state request', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-daemon-global-settings-bridge-read-home-'));
    const daemon = createDaemon(home);
    cleanups.push(() => daemon.close(), () => rm(home, { recursive: true, force: true }));
    const runtime = await daemon.listen();

    const stream = await openWorkbenchEventStream(`${runtime.daemonUrl}/api/workbench/events`, {
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    cleanups.push(() => stream.close());

    await requestJson(`${runtime.daemonUrl}/api/adobe-bridge`, {
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });

    await expect(stream.next(undefined, 100)).rejects.toThrow('Timed out waiting for Workbench event.');
  });

  it('projects Workbench client connections into Adobe live project state', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-daemon-adobe-client-count-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-adobe-client-count-project-'));
    const daemon = createDaemon(home);
    cleanups.push(
      () => daemon.close(),
      () => rm(home, { recursive: true, force: true }),
      () => rm(projectRoot, { recursive: true, force: true })
    );
    const runtime = await daemon.listen();
    const root = await openWorkbenchEventStream(`${runtime.daemonUrl}/api/workbench/events`, {
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    cleanups.push(() => root.close());
    const opened = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot })
    });

    const connectedEvent = root.next((event) => hasAdobeProjectClientCount(event, opened.projectId, 1));
    const project = await openWorkbenchEventStream(
      `${runtime.daemonUrl}/api/projects/${opened.projectId}/events`,
      { headers: { 'x-debrute-daemon-token': 'test-token' } }
    );
    let projectClosed = false;
    try {
      await connectedEvent;

      const disconnectedEvent = root.next((event) => hasAdobeProjectClientCount(event, opened.projectId, 0));
      await project.close();
      projectClosed = true;
      await disconnectedEvent;
    } finally {
      if (!projectClosed) {
        await project.close();
      }
    }
  });

  it('routes Adobe live state only through the root Workbench stream', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-daemon-adobe-routing-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-adobe-routing-project-'));
    const daemon = createDaemon(home);
    cleanups.push(
      () => daemon.close(),
      () => rm(home, { recursive: true, force: true }),
      () => rm(projectRoot, { recursive: true, force: true })
    );
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string; projectRevision: number }>(
      `${runtime.daemonUrl}/api/projects/open`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
        body: JSON.stringify({ projectRoot })
      }
    );
    const root = await openWorkbenchEventStream(`${runtime.daemonUrl}/api/workbench/events`, {
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    const project = await openWorkbenchEventStream(
      `${runtime.daemonUrl}/api/projects/${opened.projectId}/events`,
      { headers: { 'x-debrute-daemon-token': 'test-token' } }
    );
    cleanups.push(() => root.close(), () => project.close());

    const liveEvent = root.next((event) => (
      isRecord(event)
      && event.type === 'adobeBridge.state.changed'
      && isRecord(event.state)
      && isRecord(event.state.settings)
      && event.state.settings.enabled === false
    ));
    await requestJson(`${runtime.daemonUrl}/api/settings/global`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ adobeBridge: { enabled: false } })
    });
    await expect(liveEvent).resolves.toMatchObject({
      type: 'adobeBridge.state.changed',
      state: { settings: { enabled: false, discoveryStatus: 'disabled' } }
    });

    await requestJson(`${runtime.daemonUrl}/api/projects/${opened.projectId}/files/text/brief.md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ baseRevision: opened.projectRevision, content: '# Brief' })
    });
    await expect(project.next()).resolves.toMatchObject({ type: 'project.changed' });
  });

});

function createDaemon(home: string) {
  return createDebruteDaemonHttpServer({
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    webBaseUrl: null,
    adobeBridgeDiscoveryPort: 0,
    appServerOptions: {
      globalConfigStore: new GlobalConfigStore({ debruteHome: home }),
      integrationEnvPath: ''
    }
  });
}

async function expectPatchError(daemonUrl: string, body: unknown, message: string): Promise<void> {
  const response = await fetch(`${daemonUrl}/api/settings/global`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
    body: JSON.stringify(body)
  });

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({
    error: {
      code: 'invalid_input',
      message
    }
  });
}

async function requestJson<T = any>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

async function openWorkbenchEventStream(url: string, init: RequestInit = {}): Promise<{
  next(predicate?: (event: unknown) => boolean, timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}> {
  const controller = new AbortController();
  const response = await fetch(url, { ...init, signal: controller.signal });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to open event stream: ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    next: async (predicate = () => true, timeoutMs = 1000): Promise<unknown> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        let parsed = parseFirstEvent(buffer);
        while (parsed) {
          buffer = buffer.slice(parsed.endIndex);
          if (predicate(parsed.event)) {
            return parsed.event;
          }
          parsed = parseFirstEvent(buffer);
        }
        const read = await readWithTimeout(reader, deadline - Date.now());
        if (read.value) {
          buffer += decoder.decode(read.value, { stream: true });
        }
      }
      throw new Error('Timed out waiting for Workbench event.');
    },
    close: async (): Promise<void> => {
      controller.abort();
      try {
        await reader.cancel();
      } catch {
        // The abort above is the intended close signal.
      }
      reader.releaseLock();
    }
  };
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return Promise.race([
    reader.read(),
    new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
      setTimeout(() => reject(new Error('Timed out waiting for Workbench event.')), Math.max(timeoutMs, 0));
    })
  ]);
}

function parseFirstEvent(buffer: string): { event: unknown; endIndex: number } | undefined {
  const endIndex = buffer.indexOf('\n\n');
  if (endIndex < 0) {
    return undefined;
  }
  for (const chunk of [buffer.slice(0, endIndex)]) {
    const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));
    if (dataLine) {
      return { event: JSON.parse(dataLine.slice('data: '.length)), endIndex: endIndex + 2 };
    }
  }
  return { event: undefined, endIndex: endIndex + 2 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasAdobeProjectClientCount(event: unknown, projectId: string, count: number): boolean {
  if (
    !isRecord(event)
    || event.type !== 'adobeBridge.state.changed'
    || !isRecord(event.state)
    || !Array.isArray(event.state.projects)
  ) {
    return false;
  }
  return event.state.projects.some((project) => (
    isRecord(project)
    && project.projectId === projectId
    && project.connectedWorkbenchClientCount === count
  ));
}

function onceOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket failed to open.')), { once: true });
  });
}

function onceMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for WebSocket message.'));
    }, 1000);
    socket.addEventListener('message', (event) => {
      clearTimeout(timeout);
      resolve(String(event.data));
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('WebSocket message failed.'));
    }, { once: true });
  });
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }
  await new Promise<void>((resolve) => {
    socket.addEventListener('close', () => resolve(), { once: true });
    socket.close();
  });
}
