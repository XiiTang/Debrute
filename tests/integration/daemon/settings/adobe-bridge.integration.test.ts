import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DebruteGlobalRuntimeServer, GlobalConfigStore } from '@debrute/app-server';
import {
  DEFAULT_ADOBE_BRIDGE_DISCOVERY_PORT,
  createAdobeBridgeDiscoveryServer
} from '@debrute/daemon';
import {
  importAdobeBridgePngTransfer,
  isSupportedAdobeBridgeProjectImageFile,
  nextAdobeBridgeTransferFileName,
  sanitizeAdobeBridgePngBasename
} from '@debrute/project-core';
import { pruneAdobeBridgeTransferContents } from '../../../../apps/daemon/src/adobe-bridge/AdobeBridgeHttpRoutes.js';
import { DaemonTestHarness, type TestProject } from '../../../helpers/daemonTestHarness.js';

describe('daemon Adobe Bridge routes and settings', { tags: ['settings'] }, () => {
  it('loads Adobe Bridge state and saves settings through the global settings route', async () => {
    await using harness = await DaemonTestHarness.create();

    const initial = await harness.fetchOkJson<any>('/api/adobe-bridge');
    expect(initial.settings.enabled).toBe(true);

    const saved = await harness.fetchOkJson<any>('/api/settings/global', {
      method: 'PATCH',
      body: JSON.stringify({ adobeBridge: { enabled: false } })
    });
    expect(saved.adobeBridge).toEqual({ enabled: false });
  });

  it('uses the daemon JSON parser for global settings request bodies', async () => {
    await using harness = await DaemonTestHarness.create();

    const invalid = await fetch(`${harness.daemonUrl}/api/settings/global`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': harness.token },
      body: '{'
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      error: { code: 'invalid_json' }
    });

    const oversized = await fetch(`${harness.daemonUrl}/api/settings/global`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': harness.token },
      body: JSON.stringify({ adobeBridge: { enabled: true }, padding: 'x'.repeat(2 * 1024 * 1024) })
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      error: { code: 'request_body_too_large' }
    });
  });

  it('prunes stale Adobe Bridge transfer content entries', () => {
    const transferContents = new Map([
      ['active', {
        transferId: 'active',
        projectId: 'project-1',
        adobeClientId: 'ps-1',
        projectRelativePath: 'assets/active.png',
        token: 'active-token',
        expiresAt: 2000
      }],
      ['terminal', {
        transferId: 'terminal',
        projectId: 'project-1',
        adobeClientId: 'ps-1',
        projectRelativePath: 'assets/terminal.png',
        token: 'terminal-token',
        expiresAt: 2000
      }],
      ['expired', {
        transferId: 'expired',
        projectId: 'project-1',
        adobeClientId: 'ps-1',
        projectRelativePath: 'assets/expired.png',
        token: 'expired-token',
        expiresAt: 900
      }]
    ]);

    pruneAdobeBridgeTransferContents({
      transferContents,
      state: {
        transfers: [
          {
            transferId: 'active',
            direction: 'debrute-to-photoshop',
            projectId: 'project-1',
            adobeClientId: 'ps-1',
            projectRelativePath: 'assets/active.png',
            status: 'running',
            createdAt: '2026-06-18T00:00:00.000Z',
            updatedAt: '2026-06-18T00:00:00.000Z'
          },
          {
            transferId: 'terminal',
            direction: 'debrute-to-photoshop',
            projectId: 'project-1',
            adobeClientId: 'ps-1',
            projectRelativePath: 'assets/terminal.png',
            status: 'succeeded',
            createdAt: '2026-06-18T00:00:00.000Z',
            updatedAt: '2026-06-18T00:00:01.000Z'
          }
        ]
      },
      nowMs: 1000
    });

    expect([...transferContents.keys()]).toEqual(['active']);
  });

  it('allows Photoshop UXP preflight headers on tokenless plugin routes', async () => {
    await using harness = await DaemonTestHarness.create();

    const response = await fetch(`${harness.daemonUrl}/api/adobe-bridge/plugin/projects/project-1/uploads`, {
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

  it('allows Photoshop CEP preflight headers on tokenless plugin routes', async () => {
    await using harness = await DaemonTestHarness.create();

    for (const origin of ['null', 'file://']) {
      const response = await fetch(`${harness.daemonUrl}/api/adobe-bridge/plugin/projects/project-1/link`, {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'x-debrute-adobe-client-id'
        }
      });

      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe(origin);
      expect(commaSeparatedHeaderValues(response.headers.get('access-control-allow-headers')))
        .toContain('x-debrute-adobe-client-id');
    }
  });

  it('requires an explicit project link for Photoshop uploads', async () => {
    await using harness = await DaemonTestHarness.create();
    const project = await createOpenProject(harness, { 'assets/existing.png': 'existing' });

    const rejected = await fetch(`${harness.daemonUrl}/api/adobe-bridge/plugin/projects/${project.projectId}/uploads`, {
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
    await using harness = await DaemonTestHarness.create();
    const project = await createOpenProject(harness, { 'assets/.keep': '' });
    const socket = await connectBridgeClient(harness, 'ps-1');
    try {
      await linkProject(harness, project, 'ps-1');

      const rejected = await fetch(`${harness.daemonUrl}/api/adobe-bridge/plugin/projects/${project.projectId}/uploads`, {
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
      const state = await harness.fetchOkJson<any>('/api/adobe-bridge');
      expect(state.transfers).toMatchObject([{
        transferId: 'transfer-invalid',
        status: 'failed',
        errorCode: 'invalid_transfer_payload'
      }]);
    } finally {
      await closeSocket(socket);
    }
  });

  it('decodes Photoshop upload header metadata before writing project files', async () => {
    await using harness = await DaemonTestHarness.create();
    const project = await createOpenProject(harness, { '资产/参考/.keep': '' });
    const socket = await connectBridgeClient(harness, 'ps-1');
    try {
      await linkProject(harness, project, 'ps-1');

      const uploaded = await harness.fetchOkJson<any>(
        `/api/adobe-bridge/plugin/projects/${project.projectId}/uploads`,
        {
          method: 'POST',
          headers: {
            'content-type': 'image/png',
            'x-debrute-adobe-client-id': 'ps-1',
            'x-debrute-transfer-id': 'transfer-encoded',
            'x-debrute-target-directory': encodeURIComponent('资产/参考'),
            'x-debrute-suggested-name': encodeURIComponent('图层\n标题')
          },
          body: new Uint8Array([137, 80, 78, 71])
        }
      );

      expect(uploaded).toMatchObject({
        transferId: 'transfer-encoded',
        projectId: project.projectId,
        projectRelativePath: '资产/参考/图层 标题.png',
        kind: 'file'
      });
      await expect(readFile(join(project.rootPath, '资产/参考/图层 标题.png')))
        .resolves.toEqual(Buffer.from([137, 80, 78, 71]));
    } finally {
      await closeSocket(socket);
    }
  });

  it('lets Photoshop connect and disconnect its own project links without the daemon token', async () => {
    await using harness = await DaemonTestHarness.create();
    const project = await createOpenProject(harness, { 'assets/.keep': '' });
    const socket = await connectBridgeClient(harness, 'ps-1', { hostVersion: '27.0.0' });
    try {
      const linked = await requestPluginJson<any>(
        harness,
        `/api/adobe-bridge/plugin/projects/${project.projectId}/link`,
        'ps-1',
        { method: 'POST' }
      );
      expect(linked.links).toMatchObject([{
        projectId: project.projectId,
        adobeClientId: 'ps-1',
        status: 'active'
      }]);
      expect(linked.projects).toEqual([
        expect.objectContaining({
          projectId: project.projectId,
          directories: [expect.objectContaining({ projectRelativePath: 'assets' })]
        })
      ]);

      const unlinked = await requestPluginJson<any>(
        harness,
        `/api/adobe-bridge/plugin/projects/${project.projectId}/link`,
        'ps-1',
        { method: 'DELETE' }
      );
      expect(unlinked.links).toEqual([]);
      expect(unlinked.projects).toEqual([
        expect.objectContaining({
          projectId: project.projectId,
          directories: []
        })
      ]);
    } finally {
      await closeSocket(socket);
    }
  });

  it('pushes refreshed project directories to linked Photoshop clients', async () => {
    await using harness = await DaemonTestHarness.create();
    const project = await createOpenProject(harness, { 'assets/.keep': '' });
    const socket = await connectBridgeClient(harness, 'ps-1');
    try {
      const linkedState = onceBridgeStateMatching(socket, (state) => (
        state.links.some((link: any) => (
          link.projectId === project.projectId
          && link.adobeClientId === 'ps-1'
          && link.status === 'active'
        ))
      ));
      await linkProject(harness, project, 'ps-1');
      await linkedState;

      await mkdir(join(project.rootPath, 'exports'));
      const refreshedState = onceBridgeStateMatching(socket, (state) => (
        state.projects.some((candidate: any) => (
          candidate.projectId === project.projectId
          && candidate.directories.some((directory: any) => directory.projectRelativePath === 'exports')
        ))
      ));
      await harness.fetchOkJson(`/api/projects/${project.projectId}/refresh`, { method: 'POST' });

      expect((await refreshedState).projects.find((candidate: any) => candidate.projectId === project.projectId)?.directories)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ projectRelativePath: 'exports' })
        ]));
    } finally {
      await closeSocket(socket);
    }
  });

  it('rejects transfer content URLs after Adobe Bridge is disabled', async () => {
    await using harness = await DaemonTestHarness.create();
    const project = await createOpenProject(harness, { 'assets/existing.png': 'existing' });
    const socket = await connectBridgeClient(harness, 'ps-1', { hostVersion: '27.0.0' });
    try {
      await linkProject(harness, project, 'ps-1');
      const importRequestMessage = onceMessageOfType(socket, 'transfer.import.request');
      await harness.fetchOkJson(`/api/projects/${project.projectId}/adobe-bridge/send-to-photoshop`, {
        method: 'POST',
        body: JSON.stringify({ adobeClientId: 'ps-1', projectRelativePath: 'assets/existing.png' })
      });
      const importRequest = JSON.parse(await importRequestMessage);

      await harness.fetchOkJson('/api/settings/global', {
        method: 'PATCH',
        body: JSON.stringify({ adobeBridge: { enabled: false } })
      });
      const rejected = await fetch(importRequest.downloadUrl);

      expect(rejected.status).toBe(503);
      await expect(rejected.json()).resolves.toMatchObject({
        error: { code: 'adobe_bridge_disabled' }
      });
    } finally {
      await closeSocket(socket);
    }
  });

  it('accepts tokenless Photoshop hello messages on the plugin bridge socket', async () => {
    await using harness = await DaemonTestHarness.create();
    const socket = new WebSocket(bridgeSocketUrl(harness));
    try {
      await onceOpen(socket);
      const firstState = onceMessage(socket);
      socket.send(JSON.stringify({
        type: 'hello',
        adobeClientId: 'ps-cep',
        hostApp: 'photoshop',
        hostVersion: '26.0.0',
        clientRuntime: 'cep',
        documentCount: 0,
        activeDocumentTitle: null
      }));

      expect(JSON.parse(await firstState)).toMatchObject({
        type: 'bridge.state',
        state: {
          adobeClients: [{
            adobeClientId: 'ps-cep',
            clientRuntime: 'cep',
            displayName: 'Photoshop 26.0.0 · No document open'
          }]
        }
      });
    } finally {
      await closeSocket(socket);
    }
  });

  it('does not send unlinked project directory trees to Photoshop plugin sockets', async () => {
    await using harness = await DaemonTestHarness.create();
    const project = await createOpenProject(harness, {
      'assets/.keep': '',
      '.debrute/canvases/.keep': ''
    });
    const socket = new WebSocket(bridgeSocketUrl(harness));
    try {
      await onceOpen(socket);
      const firstState = onceMessage(socket);
      socket.send(JSON.stringify({
        type: 'hello',
        adobeClientId: 'ps-unlinked',
        hostApp: 'photoshop',
        hostVersion: '2026',
        documentCount: 1,
        activeDocumentTitle: 'poster.psd'
      }));

      expect(JSON.parse(await firstState)).toMatchObject({
        type: 'bridge.state',
        state: {
          links: [],
          projects: [expect.objectContaining({
            projectId: project.projectId,
            directories: []
          })]
        }
      });
    } finally {
      await closeSocket(socket);
    }
  });

  it('returns a bridge error when Photoshop connects while Adobe Bridge is disabled', async () => {
    await using harness = await DaemonTestHarness.create();
    const response = await harness.fetchJson('/api/settings/global', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adobeBridge: { enabled: false } })
    });
    expect(response.status).toBe(200);

    const socket = new WebSocket(bridgeSocketUrl(harness));
    try {
      await onceOpen(socket);
      const errorMessage = onceMessage(socket);
      socket.send(JSON.stringify({
        type: 'hello',
        adobeClientId: 'ps-disabled',
        hostApp: 'photoshop',
        hostVersion: '2026',
        documentCount: 1,
        activeDocumentTitle: 'poster.psd'
      }));

      expect(JSON.parse(await errorMessage)).toMatchObject({
        type: 'bridge.error',
        code: 'adobe_bridge_disabled'
      });
    } finally {
      await closeSocket(socket);
    }
  });

  it('rejects import results from Photoshop clients that do not own the transfer', async () => {
    await using harness = await DaemonTestHarness.create();
    const project = await createOpenProject(harness, { 'assets/cover.png': 'png' });
    const targetSocket = await connectBridgeClient(harness, 'ps-target');
    const otherSocket = await connectBridgeClient(harness, 'ps-other', { activeDocumentTitle: 'other.psd' });
    try {
      await linkProject(harness, project, 'ps-target');

      const importRequestMessage = onceMessageOfType(targetSocket, 'transfer.import.request');
      const sendResult = await harness.fetchOkJson<any>(
        `/api/projects/${project.projectId}/adobe-bridge/send-to-photoshop`,
        {
          method: 'POST',
          body: JSON.stringify({ adobeClientId: 'ps-target', projectRelativePath: 'assets/cover.png' })
        }
      );
      await importRequestMessage;

      const rogueErrorMessage = onceMessageOfType(otherSocket, 'bridge.error');
      otherSocket.send(JSON.stringify({
        type: 'transfer.import.result',
        transferId: sendResult.transfer.transferId,
        ok: true
      }));
      await expect(rogueErrorMessage).resolves.toContain('project_not_linked');

      await expect(readTransfer(harness, sendResult.transfer.transferId)).resolves.toMatchObject({
        adobeClientId: 'ps-target',
        status: 'running'
      });

      const succeededState = onceBridgeStateMatching(targetSocket, (state) => (
        state.transfers.some((transfer: any) => (
          transfer.transferId === sendResult.transfer.transferId && transfer.status === 'succeeded'
        ))
      ));
      targetSocket.send(JSON.stringify({
        type: 'transfer.import.result',
        transferId: sendResult.transfer.transferId,
        ok: true
      }));
      await succeededState;

      await expect(readTransfer(harness, sendResult.transfer.transferId)).resolves.toMatchObject({
        adobeClientId: 'ps-target',
        status: 'succeeded'
      });
    } finally {
      await closeSocket(otherSocket);
      await closeSocket(targetSocket);
    }
  });

  it('serves current bridge connection info on loopback', async () => {
    await using harness = await DaemonTestHarness.create();
    const response = await fetch(`http://127.0.0.1:${harness.discoveryPort}/adobe-bridge/discovery`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      product: 'debrute',
      bridgeVersion: 1,
      enabled: true,
      wsUrl: `${harness.daemonUrl.replace(/^http:/, 'ws:')}/api/adobe-bridge/plugin/ws`
    });
  });

  it('reports unavailable instead of blocking daemon startup when the port is occupied', async () => {
    const occupied = createServer((_request, response) => {
      response.writeHead(200);
      response.end('occupied');
    });
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject);
      occupied.listen(0, '127.0.0.1', resolve);
    });
    const address = occupied.address();
    if (!address || typeof address === 'string') {
      throw new Error('Test server did not bind a TCP port.');
    }
    const discovery = createAdobeBridgeDiscoveryServer({
      host: '127.0.0.1',
      port: address.port,
      snapshot: () => ({
        product: 'debrute',
        bridgeVersion: 1,
        enabled: true,
        daemonUrl: 'http://127.0.0.1:41001',
        apiBaseUrl: 'http://127.0.0.1:41001/api/adobe-bridge',
        wsUrl: 'ws://127.0.0.1:41001/api/adobe-bridge/plugin/ws'
      })
    });
    try {
      await expect(discovery.listen()).resolves.toMatchObject({ status: 'unavailable' });
    } finally {
      await discovery.close();
      await closeNodeServer(occupied);
    }
  });

  it('documents the fixed product discovery port', () => {
    expect(DEFAULT_ADOBE_BRIDGE_DISCOVERY_PORT).toBe(32124);
  });

  it('supports only Debrute-to-Photoshop image source formats', () => {
    expect(isSupportedAdobeBridgeProjectImageFile('assets/cover.png')).toBe(true);
    expect(isSupportedAdobeBridgeProjectImageFile('assets/photo.jpeg')).toBe(true);
    expect(isSupportedAdobeBridgeProjectImageFile('assets/photo.jpg')).toBe(true);
    expect(isSupportedAdobeBridgeProjectImageFile('assets/ref.webp')).toBe(true);
    expect(isSupportedAdobeBridgeProjectImageFile('assets/edit.psd')).toBe(true);
    expect(isSupportedAdobeBridgeProjectImageFile('assets/brief.md')).toBe(false);
    expect(isSupportedAdobeBridgeProjectImageFile('.debrute/cache/cover.png')).toBe(false);
    expect(isSupportedAdobeBridgeProjectImageFile('.DeBrute/cache/cover.png')).toBe(false);
    expect(isSupportedAdobeBridgeProjectImageFile('.GIT/objects/cover.png')).toBe(false);
  });

  it('sanitizes Photoshop layer names without copy suffixes', () => {
    expect(sanitizeAdobeBridgePngBasename('Hero / Title?.psd')).toBe('Hero Title');
    expect(sanitizeAdobeBridgePngBasename('   ...   ')).toBe('Photoshop Layer');
    expect(nextAdobeBridgeTransferFileName(new Set(['Hero.png']), 'Hero')).toBe('Hero 2.png');
    expect(nextAdobeBridgeTransferFileName(new Set(['Hero.png', 'Hero 2.png']), 'Hero')).toBe('Hero 3.png');
  });

  it('writes PNG transfers into a visible target directory using numeric conflicts', async () => {
    await using harness = await DaemonTestHarness.create();
    const project = await harness.createProject({ 'assets/Hero.png': 'existing' });

    const result = await importAdobeBridgePngTransfer(project.rootPath, {
      targetDirectoryProjectRelativePath: 'assets',
      suggestedName: 'Hero',
      content: new Uint8Array([137, 80, 78, 71]),
      byteLength: 4,
      mimeType: 'image/png'
    });

    expect(result).toEqual({
      projectRelativePath: 'assets/Hero 2.png',
      kind: 'file'
    });
    await expect(readFile(join(project.rootPath, 'assets/Hero 2.png')))
      .resolves.toEqual(Buffer.from([137, 80, 78, 71]));
  });

  it('rejects internal target directories', async () => {
    await using harness = await DaemonTestHarness.create();
    const project = await harness.createProject({ '.debrute/.keep': '' });

    await expect(importAdobeBridgePngTransfer(project.rootPath, {
      targetDirectoryProjectRelativePath: '.debrute',
      suggestedName: 'Layer',
      content: new Uint8Array([1]),
      byteLength: 1,
      mimeType: 'image/png'
    })).rejects.toThrow('not visible');
    await expect(importAdobeBridgePngTransfer(project.rootPath, {
      targetDirectoryProjectRelativePath: '.DeBrute',
      suggestedName: 'Layer',
      content: new Uint8Array([1]),
      byteLength: 1,
      mimeType: 'image/png'
    })).rejects.toThrow('not visible');
  });

  it('defaults enabled, persists disabled, and emits a settings event', async () => {
    await using harness = await DaemonTestHarness.create();
    const home = join(harness.homePath, 'runtime-settings');
    const globalConfigStore = new GlobalConfigStore({ debruteHome: home });
    const runtime = new DebruteGlobalRuntimeServer({ globalConfigStore, integrationEnvPath: '' });
    const events: string[] = [];
    runtime.onEvent((event) => events.push(event.type));
    try {
      await expect(runtime.adobeBridgeGetPersistedSettings()).resolves.toEqual({ enabled: true });

      await expect(runtime.globalSettingsSave({ adobeBridge: { enabled: false } })).resolves.toMatchObject({
        adobeBridge: {
          enabled: false
        }
      });

      expect(events).toContain('globalSettings.changed');
      const config = JSON.parse(await readFile(join(home, 'config/global_settings.json'), 'utf8')) as {
        adobeBridge: { enabled: boolean };
      };
      expect(config.adobeBridge).toEqual({ enabled: false });
    } finally {
      runtime.close();
    }
  });
});

async function createOpenProject(
  harness: DaemonTestHarness,
  files: Record<string, string | Uint8Array> = {}
): Promise<TestProject & { projectId: string }> {
  const project = await harness.createProject(files);
  await harness.openProject(project);
  if (!project.projectId) {
    throw new Error('Daemon test project did not receive a project ID.');
  }
  return project as TestProject & { projectId: string };
}

async function connectBridgeClient(
  harness: DaemonTestHarness,
  adobeClientId: string,
  overrides: { hostVersion?: string; activeDocumentTitle?: string } = {}
): Promise<WebSocket> {
  const socket = new WebSocket(bridgeSocketUrl(harness));
  await onceOpen(socket);
  const firstState = onceMessage(socket);
  socket.send(JSON.stringify({
    type: 'hello',
    adobeClientId,
    hostApp: 'photoshop',
    hostVersion: overrides.hostVersion ?? '2026',
    documentCount: 1,
    activeDocumentTitle: overrides.activeDocumentTitle ?? 'poster.psd'
  }));
  await firstState;
  return socket;
}

async function linkProject(harness: DaemonTestHarness, project: TestProject & { projectId: string }, adobeClientId: string) {
  return harness.fetchOkJson(`/api/projects/${encodeURIComponent(project.projectId)}/adobe-bridge/links`, {
    method: 'POST',
    body: JSON.stringify({ adobeClientId })
  });
}

async function requestPluginJson<T>(
  harness: DaemonTestHarness,
  path: string,
  adobeClientId: string,
  init: RequestInit
): Promise<T> {
  const response = await fetch(`${harness.daemonUrl}${path}`, {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)), 'x-debrute-adobe-client-id': adobeClientId }
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

function bridgeSocketUrl(harness: DaemonTestHarness): string {
  return `${harness.daemonUrl.replace(/^http:/, 'ws:')}/api/adobe-bridge/plugin/ws`;
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

function onceBridgeStateMatching(socket: WebSocket, predicate: (state: any) => boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(String(event.data));
        if (parsed.type === 'bridge.state' && predicate(parsed.state)) {
          socket.removeEventListener('message', onMessage);
          socket.removeEventListener('error', onError);
          resolve(parsed.state);
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
  return new Promise((resolve, reject) => {
    socket.addEventListener('close', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket failed while closing.')), { once: true });
    socket.close(1000, 'test done');
  });
}

async function readTransfer(harness: DaemonTestHarness, transferId: string): Promise<any> {
  const state = await harness.fetchOkJson<any>('/api/adobe-bridge');
  return state.transfers.find((transfer: any) => transfer.transferId === transferId);
}

function closeNodeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
