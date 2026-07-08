import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const WORKBENCH_SESSION_COOKIE = 'debrute_web_session';
export const WORKBENCH_SESSION_ROUTE_PREFIX = '/__debrute/session/';
export const WORKBENCH_LAUNCH_NONCE_TTL_MS = 60_000;

interface LaunchNoncePayload {
  id: string;
  exp: number;
}

export interface CreateWorkbenchLaunchNonceOptions {
  token: string;
  id?: string;
  now?: number;
  ttlMs?: number;
}

export interface VerifyWorkbenchLaunchNonceOptions {
  nonce: string;
  token: string;
  now?: number;
}

export interface CreateWorkbenchLaunchUrlOptions {
  webUrl: string;
  token: string;
  next?: string;
  now?: number;
}

export function createWorkbenchSessionId(): string {
  return randomUUID();
}

export function createWorkbenchLaunchNonce(options: CreateWorkbenchLaunchNonceOptions): string {
  assertSecretToken(options.token);
  const now = options.now ?? Date.now();
  const payload: LaunchNoncePayload = {
    id: options.id ?? randomUUID(),
    exp: now + (options.ttlMs ?? WORKBENCH_LAUNCH_NONCE_TTL_MS)
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encodedPayload}.${signLaunchPayload(encodedPayload, options.token)}`;
}

export function verifyWorkbenchLaunchNonce(options: VerifyWorkbenchLaunchNonceOptions): { ok: true; nonceId: string } | { ok: false } {
  assertSecretToken(options.token);
  const [encodedPayload, signature, extra] = options.nonce.split('.');
  if (!encodedPayload || !signature || extra !== undefined) {
    return { ok: false };
  }
  if (!timingSafeStringEquals(signature, signLaunchPayload(encodedPayload, options.token))) {
    return { ok: false };
  }
  const payload = parseLaunchNoncePayload(encodedPayload);
  if (!payload) {
    return { ok: false };
  }
  if (payload.exp < (options.now ?? Date.now())) {
    return { ok: false };
  }
  return { ok: true, nonceId: payload.id };
}

export function createWorkbenchLaunchUrl(options: CreateWorkbenchLaunchUrlOptions): string {
  const url = new URL(options.webUrl);
  url.pathname = `${WORKBENCH_SESSION_ROUTE_PREFIX}${encodeURIComponent(createWorkbenchLaunchNonce({
    token: options.token,
    ...(options.now === undefined ? {} : { now: options.now })
  }))}`;
  url.search = '';
  url.hash = '';
  url.searchParams.set('next', requireWorkbenchLaunchNextPath(options.next ?? '/'));
  return url.toString();
}

export function serializeWorkbenchSessionCookie(sessionId: string, options: { secure?: boolean } = {}): string {
  assertCookieValue(sessionId);
  const parts = [
    `${WORKBENCH_SESSION_COOKIE}=${sessionId}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/'
  ];
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function readWorkbenchSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName === WORKBENCH_SESSION_COOKIE) {
      const value = rawValue.join('=');
      if (!value) {
        return undefined;
      }
      try {
        return decodeURIComponent(value);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function timingSafeStringEquals(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer);
}

function signLaunchPayload(encodedPayload: string, token: string): string {
  return createHmac('sha256', token).update(encodedPayload).digest('base64url');
}

function parseLaunchNoncePayload(encodedPayload: string): LaunchNoncePayload | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as unknown;
    if (
      typeof parsed === 'object'
      && parsed !== null
      && !Array.isArray(parsed)
      && typeof (parsed as { id?: unknown }).id === 'string'
      && typeof (parsed as { exp?: unknown }).exp === 'number'
    ) {
      return parsed as LaunchNoncePayload;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function normalizeWorkbenchLaunchNextPath(next: string): string | undefined {
  if (!next.startsWith('/') || next.startsWith('//')) {
    return undefined;
  }
  const parsed = new URL(next, 'http://debrute.local');
  const normalized = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  return normalized === next ? next : undefined;
}

function requireWorkbenchLaunchNextPath(next: string): string {
  const normalized = normalizeWorkbenchLaunchNextPath(next);
  if (!normalized) {
    throw new Error(`Debrute Workbench launch next path must be a normalized same-origin path: ${next}`);
  }
  return normalized;
}

function assertSecretToken(token: string): void {
  if (!token) {
    throw new Error('Debrute Workbench launch token must be non-empty.');
  }
}

function assertCookieValue(value: string): void {
  if (!/^[A-Za-z0-9._~-]+$/.test(value)) {
    throw new Error('Debrute Workbench session cookie value contains unsupported characters.');
  }
}
