import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GlobalConfigStore } from '@debrute/app-server';
import { createDebruteDaemonHttpServer } from '@debrute/daemon';

describe('daemon Adobe Bridge HTTP routes', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it('loads and saves Adobe Bridge settings through tokened Workbench routes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-bridge-settings-home-'));
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null,
      adobeBridgeDiscoveryPort: 0,
      appServerOptions: { globalConfigStore: new GlobalConfigStore({ debruteHome: home }) }
    });
    cleanups.push(() => daemon.close(), () => rm(home, { recursive: true, force: true }));
    const runtime = await daemon.listen();

    const initial = await requestJson(`${runtime.daemonUrl}/api/adobe-bridge`, {
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    expect(initial.settings.enabled).toBe(true);

    const saved = await requestJson(`${runtime.daemonUrl}/api/adobe-bridge/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ enabled: false })
    });
    expect(saved.settings).toMatchObject({ enabled: false, discoveryStatus: 'disabled' });
  });

  it('allows Photoshop UXP preflight headers on tokenless plugin routes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-bridge-cors-home-'));
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null,
      adobeBridgeDiscoveryPort: 0,
      appServerOptions: { globalConfigStore: new GlobalConfigStore({ debruteHome: home }) }
    });
    cleanups.push(() => daemon.close(), () => rm(home, { recursive: true, force: true }));
    const runtime = await daemon.listen();

    const response = await fetch(`${runtime.daemonUrl}/api/adobe-bridge/plugin/projects/project-1/uploads`, {
      method: 'OPTIONS',
      headers: {
        origin: 'uxp://com.debrute.photoshop.bridge',
        'access-control-request-method': 'POST',
        'access-control-request-headers': [
          'content-type',
          'x-debrute-adobe-client-id',
          'x-debrute-transfer-id',
          'x-debrute-target-directory',
          'x-debrute-suggested-name'
        ].join(',')
      }
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('uxp://com.debrute.photoshop.bridge');
    expect(commaSeparatedHeaderValues(response.headers.get('access-control-allow-headers'))).toEqual(expect.arrayContaining([
      'content-type',
      'x-debrute-adobe-client-id',
      'x-debrute-transfer-id',
      'x-debrute-target-directory',
      'x-debrute-suggested-name'
    ]));
  });

  it('requires an explicit project link for Photoshop uploads', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-bridge-upload-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-bridge-upload-'));
    await mkdir(join(projectRoot, 'assets'), { recursive: true });
    await writeFile(join(projectRoot, 'assets/existing.png'), 'existing', 'utf8');

    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null,
      adobeBridgeDiscoveryPort: 0,
      appServerOptions: { globalConfigStore: new GlobalConfigStore({ debruteHome: home }) }
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }), () => rm(home, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot })
    });

    const rejected = await fetch(`${runtime.daemonUrl}/api/adobe-bridge/plugin/projects/${opened.projectId}/uploads`, {
      method: 'POST',
      headers: {
        'content-type': 'image/png',
        'x-debrute-adobe-client-id': 'ps-1',
        'x-debrute-transfer-id': 'transfer-1',
        'x-debrute-target-directory': 'assets',
        'x-debrute-suggested-name': 'Layer'
      },
      body: new Uint8Array([137, 80, 78, 71])
    });

    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: 'project_not_linked' }
    });
  });

  it('maps invalid Photoshop uploads to stable bridge error codes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-bridge-invalid-upload-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-bridge-invalid-upload-'));
    await mkdir(join(projectRoot, 'assets'), { recursive: true });

    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null,
      adobeBridgeDiscoveryPort: 0,
      appServerOptions: { globalConfigStore: new GlobalConfigStore({ debruteHome: home }) }
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }), () => rm(home, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot })
    });
    const socket = new WebSocket(`${runtime.daemonUrl.replace(/^http:/, 'ws:')}/api/adobe-bridge/plugin/ws`);
    cleanups.push(() => closeSocket(socket));
    await onceOpen(socket);
    socket.send(JSON.stringify({
      type: 'hello',
      adobeClientId: 'ps-1',
      hostApp: 'photoshop',
      hostVersion: '2026',
      documentCount: 1,
      activeDocumentTitle: 'poster.psd'
    }));
    await onceMessage(socket);
    await requestJson(`${runtime.daemonUrl}/api/projects/${encodeURIComponent(opened.projectId)}/adobe-bridge/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ adobeClientId: 'ps-1' })
    });

    const rejected = await fetch(`${runtime.daemonUrl}/api/adobe-bridge/plugin/projects/${opened.projectId}/uploads`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        'x-debrute-adobe-client-id': 'ps-1',
        'x-debrute-transfer-id': 'transfer-invalid',
        'x-debrute-target-directory': 'assets',
        'x-debrute-suggested-name': 'Layer'
      },
      body: 'not a png'
    });

    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: 'invalid_transfer_payload' }
    });
    const state = await requestJson(`${runtime.daemonUrl}/api/adobe-bridge`, {
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    expect(state.transfers).toMatchObject([{
      transferId: 'transfer-invalid',
      status: 'failed',
      errorCode: 'invalid_transfer_payload'
    }]);
  });

  it('decodes Photoshop upload header metadata before writing project files', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-bridge-encoded-upload-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-bridge-encoded-upload-'));
    await mkdir(join(projectRoot, '资产/参考'), { recursive: true });

    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null,
      adobeBridgeDiscoveryPort: 0,
      appServerOptions: { globalConfigStore: new GlobalConfigStore({ debruteHome: home }) }
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }), () => rm(home, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot })
    });
    const socket = new WebSocket(`${runtime.daemonUrl.replace(/^http:/, 'ws:')}/api/adobe-bridge/plugin/ws`);
    cleanups.push(() => closeSocket(socket));
    await onceOpen(socket);
    socket.send(JSON.stringify({
      type: 'hello',
      adobeClientId: 'ps-1',
      hostApp: 'photoshop',
      hostVersion: '2026',
      documentCount: 1,
      activeDocumentTitle: 'poster.psd'
    }));
    await onceMessage(socket);
    await requestJson(`${runtime.daemonUrl}/api/projects/${encodeURIComponent(opened.projectId)}/adobe-bridge/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ adobeClientId: 'ps-1' })
    });

    const uploaded = await requestJson(`${runtime.daemonUrl}/api/adobe-bridge/plugin/projects/${opened.projectId}/uploads`, {
      method: 'POST',
      headers: {
        'content-type': 'image/png',
        'x-debrute-adobe-client-id': 'ps-1',
        'x-debrute-transfer-id': 'transfer-encoded',
        'x-debrute-target-directory': encodeURIComponent('资产/参考'),
        'x-debrute-suggested-name': encodeURIComponent('图层\n标题')
      },
      body: new Uint8Array([137, 80, 78, 71])
    });

    expect(uploaded).toMatchObject({
      transferId: 'transfer-encoded',
      projectId: opened.projectId,
      projectRelativePath: '资产/参考/图层 标题.png',
      kind: 'file'
    });
    await expect(readFile(join(projectRoot, '资产/参考/图层 标题.png'))).resolves.toEqual(Buffer.from([137, 80, 78, 71]));
  });

  it('lets Photoshop connect and disconnect its own project links without the daemon token', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-bridge-plugin-link-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-bridge-plugin-link-'));
    await mkdir(join(projectRoot, 'assets'), { recursive: true });

    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null,
      adobeBridgeDiscoveryPort: 0,
      appServerOptions: { globalConfigStore: new GlobalConfigStore({ debruteHome: home }) }
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }), () => rm(home, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot })
    });
    const socket = new WebSocket(`${runtime.daemonUrl.replace(/^http:/, 'ws:')}/api/adobe-bridge/plugin/ws`);
    cleanups.push(() => closeSocket(socket));
    await onceOpen(socket);
    socket.send(JSON.stringify({
      type: 'hello',
      adobeClientId: 'ps-1',
      hostApp: 'photoshop',
      hostVersion: '27.0.0',
      documentCount: 1,
      activeDocumentTitle: 'poster.psd'
    }));
    await onceMessage(socket);

    const linked = await requestJson(`${runtime.daemonUrl}/api/adobe-bridge/plugin/projects/${opened.projectId}/link`, {
      method: 'POST',
      headers: { 'x-debrute-adobe-client-id': 'ps-1' }
    });
    expect(linked.links).toMatchObject([{ projectId: opened.projectId, adobeClientId: 'ps-1', status: 'active' }]);
    expect(linked.projects).toEqual([
      expect.objectContaining({
        projectId: opened.projectId,
        directories: [expect.objectContaining({ projectRelativePath: 'assets' })]
      })
    ]);

    const unlinked = await requestJson(`${runtime.daemonUrl}/api/adobe-bridge/plugin/projects/${opened.projectId}/link`, {
      method: 'DELETE',
      headers: { 'x-debrute-adobe-client-id': 'ps-1' }
    });
    expect(unlinked.links).toEqual([]);
    expect(unlinked.projects).toEqual([
      expect.objectContaining({
        projectId: opened.projectId,
        directories: []
      })
    ]);
  });

  it('pushes refreshed project directories to linked Photoshop clients', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-bridge-refresh-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-bridge-refresh-'));
    await mkdir(join(projectRoot, 'assets'), { recursive: true });

    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null,
      adobeBridgeDiscoveryPort: 0,
      appServerOptions: { globalConfigStore: new GlobalConfigStore({ debruteHome: home }) }
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }), () => rm(home, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot })
    });
    const socket = new WebSocket(`${runtime.daemonUrl.replace(/^http:/, 'ws:')}/api/adobe-bridge/plugin/ws`);
    cleanups.push(() => closeSocket(socket));
    await onceOpen(socket);
    socket.send(JSON.stringify({
      type: 'hello',
      adobeClientId: 'ps-1',
      hostApp: 'photoshop',
      hostVersion: '2026',
      documentCount: 1,
      activeDocumentTitle: 'poster.psd'
    }));
    await onceMessage(socket);

    const linkedState = onceBridgeStateMatching(socket, (state) => (
      state.links.some((link) => link.projectId === opened.projectId && link.adobeClientId === 'ps-1' && link.status === 'active')
    ));
    await requestJson(`${runtime.daemonUrl}/api/projects/${encodeURIComponent(opened.projectId)}/adobe-bridge/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ adobeClientId: 'ps-1' })
    });
    await linkedState;

    await mkdir(join(projectRoot, 'exports'), { recursive: true });
    const refreshedState = onceBridgeStateMatching(socket, (state) => (
      state.projects.some((project) => (
        project.projectId === opened.projectId
        && project.directories.some((directory) => directory.projectRelativePath === 'exports')
      ))
    ));
    await requestJson(`${runtime.daemonUrl}/api/projects/${encodeURIComponent(opened.projectId)}/refresh`, {
      method: 'POST',
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });

    expect((await refreshedState).projects.find((project) => project.projectId === opened.projectId)?.directories).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectRelativePath: 'exports' })
    ]));
  });

  it('rejects transfer content URLs after Adobe Bridge is disabled', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-bridge-content-disable-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-bridge-content-disable-'));
    await mkdir(join(projectRoot, 'assets'), { recursive: true });
    await writeFile(join(projectRoot, 'assets/existing.png'), 'existing', 'utf8');

    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null,
      adobeBridgeDiscoveryPort: 0,
      appServerOptions: { globalConfigStore: new GlobalConfigStore({ debruteHome: home }) }
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }), () => rm(home, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot })
    });
    const socket = new WebSocket(`${runtime.daemonUrl.replace(/^http:/, 'ws:')}/api/adobe-bridge/plugin/ws`);
    cleanups.push(() => closeSocket(socket));
    await onceOpen(socket);
    socket.send(JSON.stringify({
      type: 'hello',
      adobeClientId: 'ps-1',
      hostApp: 'photoshop',
      hostVersion: '27.0.0',
      documentCount: 1,
      activeDocumentTitle: 'poster.psd'
    }));
    await onceMessage(socket);
    await requestJson(`${runtime.daemonUrl}/api/projects/${encodeURIComponent(opened.projectId)}/adobe-bridge/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ adobeClientId: 'ps-1' })
    });
    const importRequestMessage = onceMessageOfType(socket, 'transfer.import.request');
    await requestJson(`${runtime.daemonUrl}/api/projects/${encodeURIComponent(opened.projectId)}/adobe-bridge/send-to-photoshop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ adobeClientId: 'ps-1', projectRelativePath: 'assets/existing.png' })
    });
    const importRequest = JSON.parse(await importRequestMessage);

    await requestJson(`${runtime.daemonUrl}/api/adobe-bridge/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ enabled: false })
    });
    const rejected = await fetch(importRequest.downloadUrl);

    expect(rejected.status).toBe(503);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: 'adobe_bridge_disabled' }
    });
  });
});

async function requestJson<T = any>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

function onceOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket failed to open.')), { once: true });
  });
}

function onceMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('message', (event) => resolve(String(event.data)), { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket message failed.')), { once: true });
  });
}

function onceMessageOfType(socket: WebSocket, type: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      const data = String(event.data);
      try {
        if (JSON.parse(data).type === type) {
          socket.removeEventListener('message', onMessage);
          socket.removeEventListener('error', onError);
          resolve(data);
        }
      } catch (error) {
        socket.removeEventListener('message', onMessage);
        socket.removeEventListener('error', onError);
        reject(error);
      }
    };
    const onError = () => {
      socket.removeEventListener('message', onMessage);
      reject(new Error('WebSocket message failed.'));
    };
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError, { once: true });
  });
}

function onceBridgeStateMatching(
  socket: WebSocket,
  predicate: (state: any) => boolean
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
      reject(new Error('Timed out waiting for matching Adobe Bridge state.'));
    }, 1000);
    const onMessage = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(String(event.data));
        if (parsed.type === 'bridge.state' && predicate(parsed.state)) {
          clearTimeout(timeout);
          socket.removeEventListener('message', onMessage);
          socket.removeEventListener('error', onError);
          resolve(parsed.state);
        }
      } catch (error) {
        clearTimeout(timeout);
        socket.removeEventListener('message', onMessage);
        socket.removeEventListener('error', onError);
        reject(error);
      }
    };
    const onError = () => {
      clearTimeout(timeout);
      socket.removeEventListener('message', onMessage);
      reject(new Error('WebSocket message failed.'));
    };
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError, { once: true });
  });
}

function commaSeparatedHeaderValues(value: string | null): string[] {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    socket.addEventListener('close', () => resolve(), { once: true });
    socket.close(1000, 'test done');
  });
}
