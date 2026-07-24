import { describe, expect, it, vi } from 'vitest';
import { createUxpPhotoshopBridgeIdentityStore } from './identityStore';

describe('UXP Photoshop Bridge identity store', () => {
  it('uses UXP secureStorage rather than browser storage', async () => {
    const getItem = vi.fn(async () => new TextEncoder().encode('{"identity":true}'));
    const setItem = vi.fn(async (_key: string, _value: Uint8Array) => undefined);
    const store = createUxpPhotoshopBridgeIdentityStore({ getItem, setItem });
    await expect(store.read()).resolves.toBe('{"identity":true}');
    await store.write('{"privateKey":"secret"}');

    expect(getItem).toHaveBeenCalledWith('debrute.photoshop.bridge.identity.v1');
    expect(new TextDecoder().decode(setItem.mock.calls[0]?.[1])).toBe('{"privateKey":"secret"}');
  });
});
