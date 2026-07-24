import type { PhotoshopBridgeIdentityStore } from '@debrute/photoshop-bridge-plugin-core';

const IDENTITY_KEY = 'debrute.photoshop.bridge.identity.v1';

interface UxpSecureStorage {
  getItem(key: string): Promise<Uint8Array | undefined>;
  setItem(key: string, value: Uint8Array): Promise<void>;
}

export function createUxpPhotoshopBridgeIdentityStore(
  secureStorage: UxpSecureStorage = require('uxp').storage.secureStorage
): PhotoshopBridgeIdentityStore {
  return {
    async read() {
      const value = await secureStorage.getItem(IDENTITY_KEY);
      return value ? new TextDecoder().decode(value) : undefined;
    },
    async write(value) {
      await secureStorage.setItem(IDENTITY_KEY, new TextEncoder().encode(value));
    }
  };
}
