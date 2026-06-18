import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ADOBE_BRIDGE_DISCOVERY_PORT,
  createAdobeBridgeDiscoveryServer
} from '../apps/daemon/src/adobe-bridge/AdobeBridgeDiscoveryServer';

describe('Adobe Bridge discovery server', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it('serves current bridge connection info on loopback', async () => {
    const discovery = createAdobeBridgeDiscoveryServer({
      host: '127.0.0.1',
      port: 0,
      snapshot: () => ({
        product: 'debrute',
        bridgeVersion: 1,
        enabled: true,
        daemonUrl: 'http://127.0.0.1:41001',
        apiBaseUrl: 'http://127.0.0.1:41001/api/adobe-bridge',
        wsUrl: 'ws://127.0.0.1:41001/api/adobe-bridge/plugin/ws'
      })
    });
    cleanups.push(() => discovery.close());

    const status = await discovery.listen();
    expect(status.status).toBe('available');
    if (status.status !== 'available') {
      throw new Error('discovery did not bind in test');
    }
    const body = await fetch(`http://127.0.0.1:${status.port}/adobe-bridge/discovery`).then((response) => response.json());

    expect(body).toMatchObject({
      product: 'debrute',
      bridgeVersion: 1,
      enabled: true,
      wsUrl: 'ws://127.0.0.1:41001/api/adobe-bridge/plugin/ws'
    });
  });

  it('reports unavailable instead of blocking daemon startup when the port is occupied', async () => {
    const occupied = createServer((_request, response) => {
      response.writeHead(200);
      response.end('occupied');
    });
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
    const address = occupied.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not bind a TCP port');
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

    await expect(discovery.listen()).resolves.toMatchObject({ status: 'unavailable' });
    await discovery.close();
  });

  it('documents the fixed product discovery port', () => {
    expect(DEFAULT_ADOBE_BRIDGE_DISCOVERY_PORT).toBe(32124);
  });
});
