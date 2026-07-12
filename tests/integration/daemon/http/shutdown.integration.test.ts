import { access } from 'node:fs/promises';
import { Agent, request, type IncomingMessage } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { DebruteAppServer, type GlobalConfigStore } from '@debrute/app-server';
import { DaemonTestHarness } from '../../../helpers/daemonTestHarness.js';
import { assertPortCanRebind } from '../../../helpers/testPaths.js';

describe('daemon HTTP shutdown', () => {
  it('closes keep-alive, SSE, WebSocket, session, and listener resources deterministically', async () => {
    const harness = await DaemonTestHarness.create();
    const keepAliveAgent = new Agent({ keepAlive: true });
    let projectEvents: IncomingMessage | undefined;
    let adobeSocket: WebSocket | undefined;

    try {
      const project = await harness.createProject({ 'notes.txt': 'shutdown fixture' });
      await harness.openProject(project);
      if (!project.projectId) {
        throw new Error('Test project did not receive a daemon project id.');
      }
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => (
        new Response('{}', { headers: { 'content-type': 'application/json' } })
      ));
      try {
        await harness.fetchOkJson('/api/harness-contract', {
          method: 'POST',
          body: JSON.stringify({ ok: true })
        });
        const jsonRequest = fetchSpy.mock.calls.at(-1)?.[1];
        expect(new Headers(jsonRequest?.headers).get('content-type')).toBe('application/json');

        const form = new FormData();
        form.append('value', 'multipart');
        await harness.fetchOkJson('/api/harness-contract', { method: 'POST', body: form });
        const multipartRequest = fetchSpy.mock.calls.at(-1)?.[1];
        expect(new Headers(multipartRequest?.headers).get('content-type')).toBeNull();
      } finally {
        fetchSpy.mockRestore();
      }

      await requestToCompletion({
        url: `${harness.daemonUrl}/api/status`,
        token: harness.token,
        agent: keepAliveAgent
      });
      expect(Object.values(keepAliveAgent.freeSockets).flat()).toHaveLength(1);
      projectEvents = await openHttpResponse({
        url: `${harness.daemonUrl}/api/projects/${encodeURIComponent(project.projectId)}/events?clientId=shutdown-test`,
        token: harness.token
      });
      expect(projectEvents.statusCode).toBe(200);
      expect(projectEvents.headers['content-type']).toBe('text/event-stream');
      adobeSocket = new WebSocket(
        `${harness.daemonUrl.replace(/^http:/, 'ws:')}/api/adobe-bridge/plugin/ws`
      );
      await onceWebSocketOpen(adobeSocket);
      adobeSocket.send(JSON.stringify({
        type: 'hello',
        adobeClientId: 'shutdown-test-photoshop',
        hostApp: 'photoshop',
        hostVersion: '2026',
        documentCount: 0,
        activeDocumentTitle: null
      }));
      expect(JSON.parse(await onceWebSocketMessage(adobeSocket))).toMatchObject({
        type: 'bridge.state',
        state: {
          adobeClients: [{ adobeClientId: 'shutdown-test-photoshop' }]
        }
      });

      const closeStartedAt = performance.now();
      await expect(harness.closeDaemon()).resolves.toBeUndefined();
      expect(performance.now() - closeStartedAt).toBeLessThan(1_000);
      await expect(assertPortCanRebind(harness.daemonPort)).resolves.toBeUndefined();
      await expect(assertPortCanRebind(harness.discoveryPort)).resolves.toBeUndefined();
      await expect(harness.closeDaemon()).resolves.toBeUndefined();
    } finally {
      keepAliveAgent.destroy();
      projectEvents?.destroy();
      adobeSocket?.close();
      await harness[Symbol.asyncDispose]();
    }
  });

  it('releases every owned resource and preserves a project-session close failure', async () => {
    const closeFailure = new Error('injected project session close failure');
    let createdAppServers = 0;
    let secondSessionClosed = false;
    const harness = await DaemonTestHarness.create({
      createAppServer: (globalConfigStore) => {
        createdAppServers += 1;
        return createdAppServers === 1
          ? new CloseFailureAppServer(globalConfigStore, closeFailure)
          : new TrackingCloseAppServer(globalConfigStore, () => {
            secondSessionClosed = true;
          });
      }
    });
    const firstProject = await harness.createProject({ 'notes.txt': 'close failure fixture' });
    const secondProject = await harness.createProject({ 'notes.txt': 'later session fixture' });
    await harness.openProject(firstProject);
    await harness.openProject(secondProject);

    await expect(harness[Symbol.asyncDispose]()).rejects.toBe(closeFailure);
    expect(secondSessionClosed).toBe(true);
    const cleanupResults = await Promise.allSettled([
      assertPortCanRebind(harness.daemonPort),
      assertPortCanRebind(harness.discoveryPort),
      assertPathDoesNotExist(harness.homePath),
      assertPathDoesNotExist(firstProject.rootPath),
      assertPathDoesNotExist(secondProject.rootPath)
    ]);
    expect(cleanupResults).toEqual(Array.from({ length: 5 }, () => ({
      status: 'fulfilled',
      value: undefined
    })));
  });
});

class CloseFailureAppServer extends DebruteAppServer {
  constructor(globalConfigStore: GlobalConfigStore, private readonly closeFailure: Error) {
    super({ globalConfigStore, integrationEnvPath: '' });
  }

  override close(): void {
    super.close();
    throw this.closeFailure;
  }
}

class TrackingCloseAppServer extends DebruteAppServer {
  constructor(globalConfigStore: GlobalConfigStore, private readonly afterClose: () => void) {
    super({ globalConfigStore, integrationEnvPath: '' });
  }

  override close(): void {
    super.close();
    this.afterClose();
  }
}

function requestToCompletion(input: { url: string; token: string; agent: Agent }): Promise<void> {
  return new Promise((resolve, reject) => {
    const outgoing = request(input.url, {
      agent: input.agent,
      headers: { 'x-debrute-daemon-token': input.token }
    }, (response) => {
      response.once('error', reject);
      response.once('end', resolve);
      response.resume();
    });
    outgoing.once('error', reject);
    outgoing.end();
  });
}

function openHttpResponse(input: { url: string; token: string }): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const outgoing = request(input.url, {
      headers: { 'x-debrute-daemon-token': input.token }
    }, resolve);
    outgoing.once('error', reject);
    outgoing.end();
  });
}

function onceWebSocketOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('Adobe Bridge WebSocket failed to open.')), { once: true });
  });
}

function onceWebSocketMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('message', (event) => resolve(String(event.data)), { once: true });
    socket.addEventListener('error', () => reject(new Error('Adobe Bridge WebSocket failed before authentication.')), { once: true });
  });
}

async function assertPathDoesNotExist(path: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  throw new Error(`Expected owned test path to be removed: ${path}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
