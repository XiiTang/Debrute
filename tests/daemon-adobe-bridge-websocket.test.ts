import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GlobalConfigStore } from '@debrute/app-server';
import { createDebruteDaemonHttpServer } from '@debrute/daemon';

describe('daemon Adobe Bridge WebSocket routes', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it('accepts tokenless Photoshop hello messages on the plugin bridge socket', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-bridge-ws-home-'));
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null,
      adobeBridgeDiscoveryPort: 0,
      appServerOptions: { globalConfigStore: new GlobalConfigStore({ debruteHome: home }), integrationEnvPath: '' }
    });
    cleanups.push(() => daemon.close(), () => rm(home, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const socket = new WebSocket(`${runtime.daemonUrl.replace(/^http:/, 'ws:')}/api/adobe-bridge/plugin/ws`);
    cleanups.push(() => closeSocket(socket));

    await onceOpen(socket);
    socket.send(JSON.stringify({
      type: 'hello',
      adobeClientId: 'ps-cep',
      hostApp: 'photoshop',
      hostVersion: '26.0.0',
      clientRuntime: 'cep',
      documentCount: 0,
      activeDocumentTitle: null
    }));

    const message = JSON.parse(await onceMessage(socket));
    expect(message).toMatchObject({
      type: 'bridge.state',
      state: {
        adobeClients: [{
          adobeClientId: 'ps-cep',
          clientRuntime: 'cep',
          displayName: 'Photoshop 26.0.0 · No document open'
        }]
      }
    });
  });

  it('does not send unlinked project directory trees to Photoshop plugin sockets', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-bridge-ws-scope-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-bridge-ws-scope-project-'));
    await mkdir(join(projectRoot, 'assets'), { recursive: true });
    await mkdir(join(projectRoot, '.debrute/canvases'), { recursive: true });
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null,
      adobeBridgeDiscoveryPort: 0,
      appServerOptions: { globalConfigStore: new GlobalConfigStore({ debruteHome: home }), integrationEnvPath: '' }
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
      adobeClientId: 'ps-unlinked',
      hostApp: 'photoshop',
      hostVersion: '2026',
      documentCount: 1,
      activeDocumentTitle: 'poster.psd'
    }));

    const message = JSON.parse(await onceMessage(socket));
    expect(message).toMatchObject({
      type: 'bridge.state',
      state: {
        links: [],
        projects: [expect.objectContaining({
          projectId: opened.projectId,
          directories: []
        })]
      }
    });
  });

  it('returns a bridge error when Photoshop connects while Adobe Bridge is disabled', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-bridge-ws-disabled-home-'));
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null,
      adobeBridgeDiscoveryPort: 0,
      appServerOptions: { globalConfigStore: new GlobalConfigStore({ debruteHome: home }), integrationEnvPath: '' }
    });
    cleanups.push(() => daemon.close(), () => rm(home, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const response = await fetch(`${runtime.daemonUrl}/api/settings/global`, {
      method: 'PATCH',
      headers: {
        'x-debrute-daemon-token': 'test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ adobeBridge: { enabled: false } })
    });
    expect(response.status).toBe(200);

    const socket = new WebSocket(`${runtime.daemonUrl.replace(/^http:/, 'ws:')}/api/adobe-bridge/plugin/ws`);
    cleanups.push(() => closeSocket(socket));

    await onceOpen(socket);
    socket.send(JSON.stringify({
      type: 'hello',
      adobeClientId: 'ps-disabled',
      hostApp: 'photoshop',
      hostVersion: '2026',
      documentCount: 1,
      activeDocumentTitle: 'poster.psd'
    }));

    const message = JSON.parse(await onceMessage(socket));
    expect(message).toMatchObject({
      type: 'bridge.error',
      code: 'adobe_bridge_disabled'
    });
  });

  it('rejects import results from Photoshop clients that do not own the transfer', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-bridge-ws-transfer-owner-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-bridge-ws-transfer-owner-project-'));
    await mkdir(join(projectRoot, 'assets'), { recursive: true });
    await writeFile(join(projectRoot, 'assets/cover.png'), 'png', 'utf8');
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null,
      adobeBridgeDiscoveryPort: 0,
      appServerOptions: { globalConfigStore: new GlobalConfigStore({ debruteHome: home }), integrationEnvPath: '' }
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }), () => rm(home, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot })
    });
    const bridgeSocketUrl = `${runtime.daemonUrl.replace(/^http:/, 'ws:')}/api/adobe-bridge/plugin/ws`;
    const targetSocket = new WebSocket(bridgeSocketUrl);
    const otherSocket = new WebSocket(bridgeSocketUrl);
    cleanups.push(() => closeSocket(targetSocket), () => closeSocket(otherSocket));

    await Promise.all([onceOpen(targetSocket), onceOpen(otherSocket)]);
    targetSocket.send(JSON.stringify({
      type: 'hello',
      adobeClientId: 'ps-target',
      hostApp: 'photoshop',
      hostVersion: '2026',
      documentCount: 1,
      activeDocumentTitle: 'poster.psd'
    }));
    otherSocket.send(JSON.stringify({
      type: 'hello',
      adobeClientId: 'ps-other',
      hostApp: 'photoshop',
      hostVersion: '2026',
      documentCount: 1,
      activeDocumentTitle: 'other.psd'
    }));
    await Promise.all([onceMessage(targetSocket), onceMessage(otherSocket)]);
    await requestJson(`${runtime.daemonUrl}/api/projects/${encodeURIComponent(opened.projectId)}/adobe-bridge/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ adobeClientId: 'ps-target' })
    });

    const importRequestMessage = onceMessageOfType(targetSocket, 'transfer.import.request');
    const sendResult = await requestJson<any>(`${runtime.daemonUrl}/api/projects/${encodeURIComponent(opened.projectId)}/adobe-bridge/send-to-photoshop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ adobeClientId: 'ps-target', projectRelativePath: 'assets/cover.png' })
    });
    await importRequestMessage;

    const rogueErrorMessage = onceMessageOfType(otherSocket, 'bridge.error');
    otherSocket.send(JSON.stringify({
      type: 'transfer.import.result',
      transferId: sendResult.transfer.transferId,
      ok: true
    }));
    await expect(rogueErrorMessage).resolves.toContain('project_not_linked');

    await expect(readTransfer(runtime.daemonUrl, sendResult.transfer.transferId)).resolves.toMatchObject({
      adobeClientId: 'ps-target',
      status: 'running'
    });

    targetSocket.send(JSON.stringify({
      type: 'transfer.import.result',
      transferId: sendResult.transfer.transferId,
      ok: true
    }));

    await expect(waitForTransferStatus(runtime.daemonUrl, sendResult.transfer.transferId, 'succeeded')).resolves.toMatchObject({
      adobeClientId: 'ps-target',
      status: 'succeeded'
    });
  });
});

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

function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    socket.addEventListener('close', () => resolve(), { once: true });
    socket.close(1000, 'test done');
  });
}

async function requestJson<T = any>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

async function readTransfer(daemonUrl: string, transferId: string): Promise<any> {
  const state = await requestJson(`${daemonUrl}/api/adobe-bridge`, {
    headers: { 'x-debrute-daemon-token': 'test-token' }
  });
  return state.transfers.find((transfer: any) => transfer.transferId === transferId);
}

async function waitForTransferStatus(
  daemonUrl: string,
  transferId: string,
  status: string
): Promise<any> {
  const deadline = Date.now() + 1000;
  let transfer: any;
  do {
    transfer = await readTransfer(daemonUrl, transferId);
    if (transfer?.status === status) {
      return transfer;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for Adobe Bridge transfer ${transferId} to become ${status}; last status was ${transfer?.status}.`);
}
