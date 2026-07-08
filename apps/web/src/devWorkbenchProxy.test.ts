import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkbenchLaunchNonce, createWorkbenchLaunchUrl } from '@debrute/workbench-runtime';
import { createWorkbenchDevProxyMiddleware } from './devWorkbenchProxy.js';

describe('source-dev Workbench proxy', () => {
  const closeables: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (closeables.length > 0) {
      await closeables.shift()?.();
    }
  });

  it('sets a Workbench web session from a valid launch URL and proxies API requests with a server-side daemon token', async () => {
    const daemonRequests: Array<{ url: string; token: string | undefined }> = [];
    const daemon = await listen((request, response) => {
      daemonRequests.push({
        url: request.url ?? '',
        token: request.headers['x-debrute-daemon-token'] as string | undefined
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
    closeables.push(daemon.close);

    const middleware = createWorkbenchDevProxyMiddleware({
      daemonUrl: daemon.origin,
      token: 'daemon-secret'
    });
    const web = await listen((request, response) => {
      middleware(request, response, () => {
        response.writeHead(404);
        response.end();
      });
    });
    closeables.push(web.close);

    const launchUrl = createWorkbenchLaunchUrl({
      webUrl: web.origin,
      token: 'daemon-secret',
      next: '/projects/project-1'
    });
    const launch = await fetch(launchUrl, { redirect: 'manual' });
    const cookie = launch.headers.get('set-cookie');

    expect(launch.status).toBe(303);
    expect(launch.headers.get('location')).toBe('/projects/project-1');
    expect(cookie).toContain('debrute_web_session=');
    expect(cookie).toContain('HttpOnly');

    const proxied = await fetch(`${web.origin}/api/runtime/product`, {
      headers: { cookie: cookie! }
    });

    expect(proxied.status).toBe(200);
    await expect(proxied.json()).resolves.toEqual({ ok: true });
    expect(daemonRequests).toEqual([{
      url: '/api/runtime/product',
      token: 'daemon-secret'
    }]);
  });

  it('rejects API requests without a valid Workbench web session before reaching the daemon', async () => {
    let daemonRequestCount = 0;
    const daemon = await listen((_request, response) => {
      daemonRequestCount += 1;
      response.writeHead(200);
      response.end();
    });
    closeables.push(daemon.close);

    const middleware = createWorkbenchDevProxyMiddleware({
      daemonUrl: daemon.origin,
      token: 'daemon-secret'
    });
    const web = await listen((request, response) => {
      middleware(request, response, () => {
        response.writeHead(404);
        response.end();
      });
    });
    closeables.push(web.close);

    const rejected = await fetch(`${web.origin}/api/projects/open`, { method: 'POST' });

    expect(rejected.status).toBe(403);
    expect(daemonRequestCount).toBe(0);
  });

  it('rejects malformed Workbench web session cookies before reaching the daemon', async () => {
    let daemonRequestCount = 0;
    const daemon = await listen((_request, response) => {
      daemonRequestCount += 1;
      response.writeHead(200);
      response.end();
    });
    closeables.push(daemon.close);

    const middleware = createWorkbenchDevProxyMiddleware({
      daemonUrl: daemon.origin,
      token: 'daemon-secret'
    });
    const web = await listen((request, response) => {
      middleware(request, response, () => {
        response.writeHead(404);
        response.end();
      });
    });
    closeables.push(web.close);

    const rejected = await fetchWithTimeout(`${web.origin}/api/projects/open`, {
      method: 'POST',
      headers: { cookie: 'debrute_web_session=%' }
    });

    expect(rejected.status).toBe(403);
    expect(daemonRequestCount).toBe(0);
  });

  it('returns a controlled gateway error when the daemon cannot be reached', async () => {
    const closedDaemon = await listen((_request, response) => {
      response.writeHead(200);
      response.end();
    });
    const daemonUrl = closedDaemon.origin;
    await closedDaemon.close();

    const middleware = createWorkbenchDevProxyMiddleware({
      daemonUrl,
      token: 'daemon-secret'
    });
    const web = await listen((request, response) => {
      middleware(request, response, () => {
        response.writeHead(404);
        response.end();
      });
    });
    closeables.push(web.close);

    const launchUrl = createWorkbenchLaunchUrl({
      webUrl: web.origin,
      token: 'daemon-secret',
      next: '/'
    });
    const launch = await fetch(launchUrl, { redirect: 'manual' });
    const rejected = await fetchWithTimeout(`${web.origin}/api/runtime/product`, {
      headers: { cookie: launch.headers.get('set-cookie')! }
    });

    expect(rejected.status).toBe(502);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: 'bad_gateway' }
    });
  });

  it('rejects invalid launch next paths without creating a session', async () => {
    const daemon = await listen((_request, response) => {
      response.writeHead(200);
      response.end();
    });
    closeables.push(daemon.close);

    const middleware = createWorkbenchDevProxyMiddleware({
      daemonUrl: daemon.origin,
      token: 'daemon-secret'
    });
    const web = await listen((request, response) => {
      middleware(request, response, () => {
        response.writeHead(404);
        response.end();
      });
    });
    closeables.push(web.close);
    const nonce = createWorkbenchLaunchNonce({ token: 'daemon-secret' });

    const rejected = await fetch(`${web.origin}/__debrute/session/${encodeURIComponent(nonce)}?next=//example.com`, {
      redirect: 'manual'
    });

    expect(rejected.status).toBe(400);
    expect(rejected.headers.get('set-cookie')).toBeNull();
  });

  it('rejects reused launch nonces', async () => {
    const daemon = await listen((_request, response) => {
      response.writeHead(200);
      response.end();
    });
    closeables.push(daemon.close);

    const middleware = createWorkbenchDevProxyMiddleware({
      daemonUrl: daemon.origin,
      token: 'daemon-secret'
    });
    const web = await listen((request, response) => {
      middleware(request, response, () => {
        response.writeHead(404);
        response.end();
      });
    });
    closeables.push(web.close);
    const launchUrl = createWorkbenchLaunchUrl({
      webUrl: web.origin,
      token: 'daemon-secret',
      next: '/'
    });

    const accepted = await fetch(launchUrl, { redirect: 'manual' });
    const rejected = await fetch(launchUrl, { redirect: 'manual' });

    expect(accepted.status).toBe(303);
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get('set-cookie')).toBeNull();
  });
});

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{
  origin: string;
  close(): Promise<void>;
}> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not bind to a TCP address.');
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    })
  };
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}
