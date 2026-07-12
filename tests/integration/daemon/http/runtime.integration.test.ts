import { describe, expect, it, vi } from 'vitest';
import { DebruteAppServer } from '@debrute/app-server';
import { createDebruteDaemonHttpServer } from '@debrute/daemon';
import type { AppServerEvent } from '@debrute/app-protocol';
import {
  createDaemonProjectSnapshotFixture,
  DaemonTestHarness
} from '../../../helpers/daemonTestHarness.js';

describe('daemon HTTP runtime', { tags: ['runtime'] }, () => {
  it('serves runtime metadata and protects mutating routes with the daemon token', async () => {
    await using harness = await DaemonTestHarness.create();
    const runtime = harness.runtime;
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
    const rejectedTokenedRuntimeProbe = await harness.fetchJson('/api/runtime', {
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

  it('rejects non-loopback daemon bind hosts before listening', async () => {
    const daemon = createDebruteDaemonHttpServer({
      host: '0.0.0.0',
      port: 0,
      token: 'test-token',
      webBaseUrl: null
    });
    try {
      await expect(daemon.listen()).rejects.toThrow('Debrute daemon host must be loopback');
      expect(daemon.runtime()).toBeUndefined();
    }
    finally {
      await daemon.close();
    }
  });

  it('allows only daemon and web origins on API requests', async () => {
    await using harness = await DaemonTestHarness.create({
      webBaseUrl: 'http://127.0.0.1:17322'
    });
    const runtime = harness.runtime;
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
    const listeners = new Set<(event: AppServerEvent) => void>();
    let currentSnapshot: ReturnType<typeof createDaemonProjectSnapshotFixture>;
    const appServer = {
      openProject: async (root: string) => {
        currentSnapshot = createDaemonProjectSnapshotFixture(root);
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
    await using harness = await DaemonTestHarness.create({
      createAppServer: () => appServer
    });
    const { rootPath: projectRoot } = await harness.createProject();
    currentSnapshot = createDaemonProjectSnapshotFixture(projectRoot);
    const opened = await harness.fetchOkJson<{
      projectId: string;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot })
    });
    const response = await harness.fetchJson<Record<string, unknown>>(`/api/projects/${opened.projectId}/refresh`, {
      method: 'POST',
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    const body = response.body;
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

  it('returns structured client errors for invalid JSON bodies', async () => {
    await using harness = await DaemonTestHarness.create();
    const response = await harness.fetchJson<{
      error: {
        code: string;
      };
    }>('/api/projects/open', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: '{'
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: 'invalid_json' }
    });
  });

  it('returns runtime-owned product state and protects product update actions with the daemon token', async () => {
    const productState = {
      productVersion: '0.2.0',
      platform: process.platform,
      cli: {
        status: 'ready' as const,
        version: '0.2.0',
        path: '/Users/me/.debrute/bin/debrute',
        skillsVersion: '0.2.0',
        skillsRoot: '/Users/me/.agents/skills'
      },
      update: {
        type: 'idle' as const,
        currentVersion: '0.2.0',
        updateAvailable: false
      }
    };
    const productUpdate = {
      state: vi.fn(async () => productState),
      check: vi.fn(async () => ({
        ...productState,
        update: { type: 'checking' as const, currentVersion: '0.2.0' }
      })),
      apply: vi.fn(async () => ({ state: productState }))
    };
    await using harness = await DaemonTestHarness.create({
      productServices: {
        managedCli: {
          ensureCurrent: vi.fn(),
          diagnostic: vi.fn(() => productState.cli)
        },
        productUpdate
      }
    });
    const runtime = harness.runtime;
    await expect(fetch(`${runtime.daemonUrl}/api/runtime/product`)).resolves.toMatchObject({ status: 403 });
    const stateResponse = await harness.fetchJson<typeof productState>('/api/runtime/product');
    expect(stateResponse.status).toBe(200);
    expect(stateResponse.body).toEqual(productState);
    const checkResponse = await harness.fetchJson<typeof productState>('/api/runtime/product/update/check', { method: 'POST' });
    expect(checkResponse.status).toBe(200);
    expect(checkResponse.body).toMatchObject({
      update: { type: 'checking' }
    });
    expect(productUpdate.check).toHaveBeenCalledTimes(1);
    const applyResponse = await harness.fetchJson<{
      state: typeof productState;
    }>('/api/runtime/product/update/apply', { method: 'POST' });
    expect(applyResponse.status).toBe(200);
    expect(applyResponse.body).toEqual({ state: productState });
    expect(productUpdate.apply).toHaveBeenCalledTimes(1);
  });
});
