import { describe, expect, it } from 'vitest';

import { createWorkbenchDevProxy, rewriteRuntimeRedirect } from './devWorkbenchProxy.js';

describe('source-dev Workbench proxy', () => {
  it('proxies only the Runtime API, SSE, and WebSocket prefix', () => {
    const proxy = createWorkbenchDevProxy('http://127.0.0.1:43123');

    expect(Object.keys(proxy)).toEqual(['/api']);
    expect(proxy['/api']).toMatchObject({
      target: 'http://127.0.0.1:43123',
      changeOrigin: true,
      ws: true
    });
  });

  it('rewrites only exact Runtime-origin redirects back to the Vite authority', () => {
    const request = { headers: { host: '127.0.0.1:5174' } } as never;

    expect(rewriteRuntimeRedirect(
      'http://127.0.0.1:43123/projects/project-1',
      'http://127.0.0.1:43123',
      request
    )).toBe('http://127.0.0.1:5174/projects/project-1');
    expect(rewriteRuntimeRedirect(
      'https://example.com/',
      'http://127.0.0.1:43123',
      request
    )).toBe('https://example.com/');
  });

  it('rejects hostname, non-loopback, TLS, and portless targets', () => {
    for (const origin of [
      'http://localhost:43123',
      'http://0.0.0.0:43123',
      'https://127.0.0.1:43123',
      'http://127.0.0.1'
    ]) {
      expect(() => createWorkbenchDevProxy(origin)).toThrow(
        'DEBRUTE_RUNTIME_ORIGIN must be an HTTP numeric-loopback origin.'
      );
    }
  });
});
