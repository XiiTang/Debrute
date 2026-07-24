import type { IncomingMessage } from 'node:http';
import type { ProxyOptions } from 'vite';

export function createWorkbenchDevProxy(runtimeOrigin: string): Record<string, ProxyOptions> {
  const target = requireNumericLoopbackOrigin(runtimeOrigin);
  return {
    '/api': proxyOptions(target)
  };
}

export function rewriteRuntimeRedirect(
  location: string,
  runtimeOrigin: string,
  request: IncomingMessage
): string {
  if (!location.startsWith(runtimeOrigin)) {
    return location;
  }
  const host = request.headers.host;
  if (!host) {
    return location;
  }
  return `http://${host}${location.slice(runtimeOrigin.length)}`;
}

function proxyOptions(runtimeOrigin: string): ProxyOptions {
  return {
    target: runtimeOrigin,
    changeOrigin: true,
    ws: true,
    configure(proxy) {
      const rewriteOrigin = (proxyRequest: { setHeader(name: string, value: string): void }) => {
        proxyRequest.setHeader('origin', runtimeOrigin);
      };
      proxy.on('proxyReq', (proxyRequest, request) => {
        if (request.headers.origin) {
          rewriteOrigin(proxyRequest);
        }
      });
      proxy.on('proxyReqWs', (proxyRequest, request) => {
        if (request.headers.origin) {
          rewriteOrigin(proxyRequest);
        }
      });
      proxy.on('proxyRes', (proxyResponse, request) => {
        const location = proxyResponse.headers.location;
        if (location) {
          proxyResponse.headers.location = rewriteRuntimeRedirect(location, runtimeOrigin, request);
        }
      });
    }
  };
}

function requireNumericLoopbackOrigin(value: string): string {
  const origin = new URL(value);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port) {
    throw new Error('DEBRUTE_RUNTIME_ORIGIN must be an HTTP numeric-loopback origin.');
  }
  return origin.origin;
}
