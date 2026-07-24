import { describe, expect, it, vi } from 'vitest';
import {
  createSignedPhotoshopHello,
  loadOrCreatePhotoshopBridgeIdentity,
  setPhotoshopBridgeIdentityPaired,
  type PhotoshopBridgeIdentityStore
} from './bridgeIdentity.js';

describe('Photoshop Bridge persisted proof identity', () => {
  it('persists one P-256 identity and signs the exact Runtime challenge transcript', async () => {
    let stored: string | undefined;
    const store: PhotoshopBridgeIdentityStore = {
      read: vi.fn(async () => stored),
      write: vi.fn(async (value) => { stored = value; })
    };
    const first = await loadOrCreatePhotoshopBridgeIdentity({ store });
    const second = await loadOrCreatePhotoshopBridgeIdentity({ store });
    expect(second).toEqual(first);
    expect(store.write).toHaveBeenCalledTimes(1);
    expect(first.paired).toBe(false);

    const paired = await setPhotoshopBridgeIdentityPaired({ identity: first, store, paired: true });
    expect(paired.paired).toBe(true);
    await expect(loadOrCreatePhotoshopBridgeIdentity({ store })).resolves.toEqual(paired);

    const challengeBytes = crypto.getRandomValues(new Uint8Array(32));
    const challenge = base64UrlEncode(challengeBytes.buffer as ArrayBuffer);
    const hello = await createSignedPhotoshopHello({
      identity: first,
      challenge: {
        type: 'bridge.challenge',
        bridgeVersion: 1,
        productVersion: '1.0.0',
        runtimeInstanceId: 'runtime-1',
        challenge
      },
      pairingCode: '123 456',
      hostVersion: '2026',
      clientRuntime: 'uxp',
      documentCount: 1,
      activeDocumentTitle: 'poster.psd'
    });

    expect(hello).toMatchObject({
      type: 'hello',
      pluginInstanceId: first.pluginInstanceId,
      publicKey: first.publicKey,
      pairingCode: '123 456'
    });
    const publicKey = await crypto.subtle.importKey(
      'raw',
      base64UrlDecode(first.publicKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    const transcript = joinBytes(
      new TextEncoder().encode('debrute-bridge-v1\0'),
      new TextEncoder().encode(first.pluginInstanceId),
      new Uint8Array([0]),
      challengeBytes
    );
    await expect(crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      base64UrlDecode(hello.signature),
      transcript.buffer as ArrayBuffer
    )).resolves.toBe(true);
  });

  it('does not resend the public key when proving an existing pairing', async () => {
    const store = memoryStore();
    const identity = await loadOrCreatePhotoshopBridgeIdentity({ store });
    const hello = await createSignedPhotoshopHello({
      identity,
      challenge: {
        type: 'bridge.challenge',
        bridgeVersion: 1,
        productVersion: '1.0.0',
        runtimeInstanceId: 'runtime-1',
        challenge: base64UrlEncode(new Uint8Array(32).buffer as ArrayBuffer)
      },
      hostVersion: '2026',
      clientRuntime: 'cep',
      documentCount: 0,
      activeDocumentTitle: null
    });
    expect(hello.publicKey).toBeNull();
    expect(hello.pairingCode).toBeNull();
  });
});

function memoryStore(): PhotoshopBridgeIdentityStore {
  let value: string | undefined;
  return {
    read: async () => value,
    write: async (next) => { value = next; }
  };
}

function joinBytes(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function base64UrlEncode(value: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): ArrayBuffer {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer as ArrayBuffer;
}
