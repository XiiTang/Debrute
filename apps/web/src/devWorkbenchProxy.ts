import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import {
  WORKBENCH_SESSION_ROUTE_PREFIX,
  createWorkbenchSessionId,
  normalizeWorkbenchLaunchNextPath,
  readWorkbenchSessionCookie,
  serializeWorkbenchSessionCookie,
  verifyWorkbenchLaunchNonce
} from '@debrute/workbench-runtime';

export type WorkbenchDevProxyMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void
) => void;

export interface WorkbenchDevProxyOptions {
  daemonUrl: string;
  token: string;
}

export function createWorkbenchDevProxyMiddleware(options: WorkbenchDevProxyOptions): WorkbenchDevProxyMiddleware {
  const sessions = new Set<string>();
  const usedLaunchNonces = new Set<string>();

  return (request, response, next) => {
    const url = requestUrl(request);
    if (url.pathname.startsWith(WORKBENCH_SESSION_ROUTE_PREFIX)) {
      if ((request.method ?? 'GET') !== 'GET') {
        writeMethodNotAllowed(response);
        return;
      }
      handleLaunchRequest({ response, url, token: options.token, sessions, usedLaunchNonces });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      void proxyApiRequest({ request, response, url, daemonUrl: options.daemonUrl, token: options.token, sessions });
      return;
    }
    next();
  };
}

function handleLaunchRequest(input: {
  response: ServerResponse;
  url: URL;
  token: string;
  sessions: Set<string>;
  usedLaunchNonces: Set<string>;
}): void {
  const nonce = decodeURIComponent(input.url.pathname.slice(WORKBENCH_SESSION_ROUTE_PREFIX.length));
  const verification = verifyWorkbenchLaunchNonce({ nonce, token: input.token });
  if (!verification.ok || input.usedLaunchNonces.has(verification.nonceId)) {
    writeForbidden(input.response);
    return;
  }
  const next = normalizeWorkbenchLaunchNextPath(input.url.searchParams.get('next') ?? '/');
  if (!next) {
    writeInvalidNext(input.response);
    return;
  }
  input.usedLaunchNonces.add(verification.nonceId);
  const sessionId = createWorkbenchSessionId();
  input.sessions.add(sessionId);
  input.response.writeHead(303, {
    location: next,
    'set-cookie': serializeWorkbenchSessionCookie(sessionId, { secure: input.url.protocol === 'https:' })
  });
  input.response.end();
}

async function proxyApiRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  daemonUrl: string;
  token: string;
  sessions: Set<string>;
}): Promise<void> {
  const sessionId = readWorkbenchSessionCookie(input.request.headers.cookie);
  if (!sessionId || !input.sessions.has(sessionId)) {
    writeForbidden(input.response);
    return;
  }

  const target = new URL(`${input.url.pathname}${input.url.search}`, input.daemonUrl);
  const proxyRequestInit = {
    method: input.request.method,
    headers: proxyHeaders(input.request.headers, input.token),
    body: hasRequestBody(input.request.method) ? input.request : undefined,
    duplex: 'half'
  } as unknown as RequestInit & { duplex: 'half' };
  let daemonResponse: Response;
  try {
    daemonResponse = await fetch(target, proxyRequestInit);
  } catch {
    writeBadGateway(input.response);
    return;
  }

  input.response.writeHead(daemonResponse.status, responseHeaders(daemonResponse.headers));
  if (!daemonResponse.body) {
    input.response.end();
    return;
  }
  Readable.fromWeb(daemonResponse.body as unknown as NodeReadableStream<Uint8Array>).pipe(input.response);
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
}

function proxyHeaders(headers: IncomingHttpHeaders, token: string): Headers {
  const forwarded = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (name === 'host' || name === 'cookie' || name === 'content-length' || value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        forwarded.append(name, item);
      }
    } else {
      forwarded.set(name, value);
    }
  }
  forwarded.set('x-debrute-daemon-token', token);
  return forwarded;
}

function responseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function hasRequestBody(method: string | undefined): boolean {
  return method !== undefined && method !== 'GET' && method !== 'HEAD';
}

function writeForbidden(response: ServerResponse): void {
  response.writeHead(403, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    error: {
      code: 'forbidden',
      message: 'Debrute Workbench web session is required.'
    }
  }));
}

function writeMethodNotAllowed(response: ServerResponse): void {
  response.writeHead(405, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    error: {
      code: 'method_not_allowed',
      message: 'Unsupported Debrute Workbench session launch method.'
    }
  }));
}

function writeInvalidNext(response: ServerResponse): void {
  response.writeHead(400, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    error: {
      code: 'invalid_input',
      message: 'Debrute Workbench launch next path must be a normalized same-origin path.'
    }
  }));
}

function writeBadGateway(response: ServerResponse): void {
  if (response.headersSent || response.writableEnded) {
    response.destroy();
    return;
  }
  response.writeHead(502, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    error: {
      code: 'bad_gateway',
      message: 'Debrute daemon proxy request failed.'
    }
  }));
}
