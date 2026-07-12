import { describe, expect, it } from 'vitest';
import { checkWorkbenchRuntimeHealth } from './health.js';
import type { WorkbenchRuntimeState } from './state.js';

describe('@debrute/workbench-runtime health', { tags: ['runtime'] }, () => {
  it('does not send runtime tokens during the health probe', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    await checkWorkbenchRuntimeHealth(runtimeState(), {
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(
          String(url).includes('/api/runtime')
            ? JSON.stringify({ daemonUrl: 'http://127.0.0.1:17321', webBaseUrl: 'http://127.0.0.1:17322' })
            : 'ok',
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
    });

    expect(requests[0]?.url).toBe('http://127.0.0.1:17321/api/runtime');
    expect(requests[0]?.init?.method).toBe('GET');
    expect(JSON.stringify(requests[0]?.init ?? {})).not.toContain('secret');
  });

  it('requires daemon runtime metadata and web URL to match recorded state', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    await expect(checkWorkbenchRuntimeHealth(runtimeState(), {
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(
          String(url).includes('/api/runtime')
            ? JSON.stringify({ daemonUrl: 'http://127.0.0.1:17321', webBaseUrl: 'http://127.0.0.1:17322' })
            : 'ok',
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
    })).resolves.toBe('healthy');
    expect(requests[0]?.url).toBe('http://127.0.0.1:17321/api/runtime');
    expect(requests[0]?.init?.method).toBe('GET');
    expect(JSON.stringify(requests[0]?.init ?? {})).not.toContain('secret');

    await expect(checkWorkbenchRuntimeHealth(runtimeState(), {
      fetch: async (url) => new Response(
        String(url).includes('/api/runtime')
          ? JSON.stringify({ daemonUrl: 'http://127.0.0.1:17321', webBaseUrl: 'http://127.0.0.1:18000' })
          : 'ok',
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })).resolves.toBe('daemon-mismatch');

    await expect(checkWorkbenchRuntimeHealth(runtimeState({ webUrl: 'http://127.0.0.1:17321' }), {
      fetch: async (url) => new Response(
        String(url).includes('/api/runtime')
          ? JSON.stringify({ daemonUrl: 'http://127.0.0.1:17321' })
          : 'ok',
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })).resolves.toBe('daemon-mismatch');

    await expect(checkWorkbenchRuntimeHealth(runtimeState(), {
      fetch: async (url) => new Response(
        String(url).includes('/api/runtime') ? 'forbidden' : 'ok',
        { status: String(url).includes('/api/runtime') ? 403 : 200 }
      )
    })).resolves.toBe('daemon-mismatch');
  });
});

function runtimeState(overrides: Partial<WorkbenchRuntimeState> = {}): WorkbenchRuntimeState {
  return {
    runtimeKind: 'source-dev',
    processControl: 'managed',
    owner: { kind: 'cli', ownerId: 'owner-1', pid: 100 },
    daemonUrl: 'http://127.0.0.1:17321',
    webUrl: 'http://127.0.0.1:17322',
    token: 'secret',
    daemonPid: 10,
    webPid: 11,
    daemonLogPath: '/home/user/.debrute/runtime/workbench-daemon.log',
    webLogPath: '/home/user/.debrute/runtime/workbench-web.log',
    startedAt: '2026-06-13T00:00:00.000Z',
    updatedAt: '2026-06-13T00:00:00.000Z',
    ...overrides
  };
}
