import { describe, expect, it, vi } from 'vitest';
import { discoverDebruteBridge } from './discoveryClient';

describe('discoverDebruteBridge', () => {
  it('reads the fixed discovery endpoint', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      product: 'debrute',
      bridgeVersion: 1,
      enabled: true,
      daemonUrl: 'http://127.0.0.1:41001',
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
});
