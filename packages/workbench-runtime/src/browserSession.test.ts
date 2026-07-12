import { describe, expect, it } from 'vitest';
import {
  WORKBENCH_LAUNCH_NONCE_TTL_MS,
  WORKBENCH_SESSION_COOKIE,
  WORKBENCH_SESSION_ROUTE_PREFIX,
  createWorkbenchLaunchNonce,
  createWorkbenchLaunchUrl,
  createWorkbenchSessionId,
  normalizeWorkbenchLaunchNextPath,
  readWorkbenchSessionCookie,
  serializeWorkbenchSessionCookie,
  timingSafeStringEquals,
  verifyWorkbenchLaunchNonce
} from './browserSession.js';

describe('workbench browser sessions', { tags: ['runtime'] }, () => {
  it('creates launch URLs with signed nonces and no daemon token query', () => {
    const launchUrl = createWorkbenchLaunchUrl({
      webUrl: 'http://127.0.0.1:17322',
      token: 'daemon-secret',
      next: '/projects/project-1'
    });

    const parsed = new URL(launchUrl);
    expect(parsed.origin).toBe('http://127.0.0.1:17322');
    expect(parsed.pathname.startsWith(WORKBENCH_SESSION_ROUTE_PREFIX)).toBe(true);
    expect(parsed.searchParams.get('next')).toBe('/projects/project-1');
    expect([...parsed.searchParams.keys()]).toEqual(['next']);

    const nonce = decodeURIComponent(parsed.pathname.slice(WORKBENCH_SESSION_ROUTE_PREFIX.length));
    expect(verifyWorkbenchLaunchNonce({
      nonce,
      token: 'daemon-secret',
      now: Date.now()
    })).toMatchObject({ ok: true });
  });

  it('rejects tampered and expired launch nonces', () => {
    const now = 1_000_000;
    const nonce = createWorkbenchLaunchNonce({
      token: 'daemon-secret',
      id: 'nonce-id',
      now
    });

    expect(verifyWorkbenchLaunchNonce({
      nonce,
      token: 'daemon-secret',
      now: now + WORKBENCH_LAUNCH_NONCE_TTL_MS - 1
    })).toEqual({ ok: true, nonceId: 'nonce-id' });
    expect(verifyWorkbenchLaunchNonce({
      nonce,
      token: 'wrong-secret',
      now
    })).toEqual({ ok: false });
    expect(verifyWorkbenchLaunchNonce({
      nonce,
      token: 'daemon-secret',
      now: now + WORKBENCH_LAUNCH_NONCE_TTL_MS + 1
    })).toEqual({ ok: false });
    expect(verifyWorkbenchLaunchNonce({
      nonce: `${nonce}x`,
      token: 'daemon-secret',
      now
    })).toEqual({ ok: false });
  });

  it('serializes and reads strict HttpOnly session cookies', () => {
    const sessionId = createWorkbenchSessionId();
    const cookie = serializeWorkbenchSessionCookie(sessionId);

    expect(cookie).toContain(`${WORKBENCH_SESSION_COOKIE}=${sessionId}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Secure');
    expect(readWorkbenchSessionCookie(`theme=dark; ${cookie}`)).toBe(sessionId);
    expect(readWorkbenchSessionCookie(undefined)).toBeUndefined();
  });

  it('treats malformed session cookie values as absent', () => {
    expect(readWorkbenchSessionCookie(`${WORKBENCH_SESSION_COOKIE}=%`)).toBeUndefined();
  });

  it('adds Secure only when the caller asks for HTTPS cookies', () => {
    expect(serializeWorkbenchSessionCookie('session-id', { secure: true })).toContain('Secure');
  });

  it('normalizes launch next paths for all Workbench session endpoints', () => {
    expect(normalizeWorkbenchLaunchNextPath('/')).toBe('/');
    expect(normalizeWorkbenchLaunchNextPath('/projects/project-1?panel=files#top')).toBe('/projects/project-1?panel=files#top');
    expect(normalizeWorkbenchLaunchNextPath('projects/project-1')).toBeUndefined();
    expect(normalizeWorkbenchLaunchNextPath('//example.com/projects/project-1')).toBeUndefined();
    expect(normalizeWorkbenchLaunchNextPath('/projects/%2e%2e/settings')).toBeUndefined();
  });

  it('compares strings without leaking through normal equality short-circuits', () => {
    expect(timingSafeStringEquals('abc', 'abc')).toBe(true);
    expect(timingSafeStringEquals('abc', 'abd')).toBe(false);
    expect(timingSafeStringEquals('abc', 'abcd')).toBe(false);
  });
});
