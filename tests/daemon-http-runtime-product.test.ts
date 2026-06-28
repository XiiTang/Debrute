import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDebruteDaemonHttpServer } from '../apps/daemon/src/http/createDebruteDaemonHttpServer';

describe('daemon runtime product HTTP routes', () => {
  const closeFns: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (closeFns.length > 0) {
      await closeFns.shift()?.();
    }
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
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      productServices: {
        managedCli: {
          ensureCurrent: vi.fn(),
          diagnostic: vi.fn(() => productState.cli)
        },
        productUpdate
      }
    });
    closeFns.push(() => daemon.close());
    const runtime = await daemon.listen();

    await expect(fetch(`${runtime.daemonUrl}/api/runtime/product`)).resolves.toMatchObject({ status: 403 });

    const stateResponse = await fetch(`${runtime.daemonUrl}/api/runtime/product`, {
      headers: { 'x-debrute-daemon-token': runtime.token }
    });
    expect(stateResponse.status).toBe(200);
    await expect(stateResponse.json()).resolves.toEqual(productState);

    const checkResponse = await fetch(`${runtime.daemonUrl}/api/runtime/product/update/check`, {
      method: 'POST',
      headers: { 'x-debrute-daemon-token': runtime.token }
    });
    expect(checkResponse.status).toBe(200);
    await expect(checkResponse.json()).resolves.toMatchObject({
      update: { type: 'checking' }
    });
    expect(productUpdate.check).toHaveBeenCalledTimes(1);

    const applyResponse = await fetch(`${runtime.daemonUrl}/api/runtime/product/update/apply`, {
      method: 'POST',
      headers: { 'x-debrute-daemon-token': runtime.token }
    });
    expect(applyResponse.status).toBe(200);
    await expect(applyResponse.json()).resolves.toEqual({ state: productState });
    expect(productUpdate.apply).toHaveBeenCalledTimes(1);
  });
});
