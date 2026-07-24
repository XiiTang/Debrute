import type {
  AdobeBridgeClientRuntime,
  PhotoshopBridgeChallengeMessage,
  PhotoshopBridgeHelloMessage
} from '@debrute/app-protocol';

const TRANSCRIPT_PREFIX = new TextEncoder().encode('debrute-bridge-v1\0');

export interface PhotoshopBridgeIdentityStore {
  read(): Promise<string | undefined>;
  write(value: string): Promise<void>;
}

export interface PhotoshopBridgeIdentity {
  pluginInstanceId: string;
  publicKey: string;
  privateKey: string;
  paired: boolean;
}

export async function loadOrCreatePhotoshopBridgeIdentity(input: {
  store: PhotoshopBridgeIdentityStore;
  crypto?: Crypto;
}): Promise<PhotoshopBridgeIdentity> {
  const stored = await input.store.read();
  if (stored) {
    return parseIdentity(stored);
  }
  const cryptoImpl = input.crypto ?? crypto;
  const pair = await cryptoImpl.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const identity: PhotoshopBridgeIdentity = {
    pluginInstanceId: cryptoImpl.randomUUID(),
    publicKey: base64UrlEncode(await cryptoImpl.subtle.exportKey('raw', pair.publicKey)),
    privateKey: base64UrlEncode(await cryptoImpl.subtle.exportKey('pkcs8', pair.privateKey)),
    paired: false
  };
  await input.store.write(JSON.stringify(identity));
  return identity;
}

export async function setPhotoshopBridgeIdentityPaired(input: {
  identity: PhotoshopBridgeIdentity;
  store: PhotoshopBridgeIdentityStore;
  paired: boolean;
}): Promise<PhotoshopBridgeIdentity> {
  if (input.identity.paired === input.paired) return input.identity;
  const identity = { ...input.identity, paired: input.paired };
  await input.store.write(JSON.stringify(identity));
  return identity;
}

export async function createSignedPhotoshopHello(input: {
  identity: PhotoshopBridgeIdentity;
  challenge: PhotoshopBridgeChallengeMessage;
  hostVersion: string;
  clientRuntime: AdobeBridgeClientRuntime;
  documentCount: number;
  activeDocumentTitle: string | null;
  pairingCode?: string | undefined;
  crypto?: Crypto;
}): Promise<PhotoshopBridgeHelloMessage> {
  const cryptoImpl = input.crypto ?? crypto;
  const privateKey = await cryptoImpl.subtle.importKey(
    'pkcs8',
    base64UrlDecode(input.identity.privateKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const transcript = joinBytes(
    TRANSCRIPT_PREFIX,
    new TextEncoder().encode(input.identity.pluginInstanceId),
    new Uint8Array([0]),
    new Uint8Array(base64UrlDecode(input.challenge.challenge))
  );
  const signature = await cryptoImpl.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    transcript.buffer as ArrayBuffer
  );
  const pairingCode = input.pairingCode?.trim() || undefined;
  return {
    type: 'hello',
    pluginInstanceId: input.identity.pluginInstanceId,
    hostApp: 'photoshop',
    hostVersion: input.hostVersion,
    clientRuntime: input.clientRuntime,
    documentCount: input.documentCount,
    activeDocumentTitle: input.activeDocumentTitle,
    signature: base64UrlEncode(signature),
    publicKey: pairingCode ? input.identity.publicKey : null,
    pairingCode: pairingCode ?? null
  };
}

function parseIdentity(raw: string): PhotoshopBridgeIdentity {
  const value = JSON.parse(raw) as Partial<PhotoshopBridgeIdentity>;
  if (
    typeof value.pluginInstanceId !== 'string'
    || typeof value.publicKey !== 'string'
    || typeof value.privateKey !== 'string'
    || typeof value.paired !== 'boolean'
  ) {
    throw new Error('Stored Photoshop Bridge identity is invalid.');
  }
  return value as PhotoshopBridgeIdentity;
}

function joinBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function base64UrlEncode(value: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(value)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): ArrayBuffer {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer as ArrayBuffer;
}
