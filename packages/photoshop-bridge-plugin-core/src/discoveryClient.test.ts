import { describe, expect, it, vi } from 'vitest';
import { discoverDebruteBridge } from './discoveryClient';

describe('discoverDebruteBridge', () => {
  it('reads the fixed discovery endpoint', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      product: 'debrute',
      productVersion: '1.0.0',
      bridgeVersion: 1,
      runtimeInstanceId: 'runtime-1',
      enabled: true,
      workbenchOrigin: 'http://127.0.0.1:41001',
      apiBaseUrl: 'http://127.0.0.1:41001/api/adobe-bridge',
      wsUrl: 'ws://127.0.0.1:41001/api/adobe-bridge/plugin/ws'
    }), { status: 200 }));

    await expect(discoverDebruteBridge({
      fetch: fetchImpl,
      discoveryUrl: 'http://127.0.0.1:32124/adobe-bridge/discovery'
    })).resolves.toMatchObject({
      status: 'connected',
      wsUrl: 'ws://127.0.0.1:41001/api/adobe-bridge/plugin/ws'
    });
  });

  it('rejects discovery that redirects plugin authority away from the same loopback Runtime', async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      product: 'debrute',
      productVersion: '1.0.0',
      bridgeVersion: 1,
      runtimeInstanceId: 'runtime-1',
      enabled: true,
      workbenchOrigin: 'http://127.0.0.1:41001',
      apiBaseUrl: 'https://example.com/api/adobe-bridge',
      wsUrl: 'ws://127.0.0.1:41001/api/adobe-bridge/plugin/ws'
    }));

    await expect(discoverDebruteBridge({ fetch: fetchImpl })).resolves.toEqual({
      status: 'unavailable',
      message: 'Discovery response is not Debrute Adobe Bridge.'
    });
  });
});
