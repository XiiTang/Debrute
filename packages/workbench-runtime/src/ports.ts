import { createServer } from 'node:net';

export const DEFAULT_WORKBENCH_DAEMON_PORT = 17321;
export const DEFAULT_WORKBENCH_WEB_PORT = 17322;

export function isLoopbackHttpUrl(value: string): boolean {
  return normalizeLoopbackHttpUrl(value) !== undefined;
}

export function normalizeLoopbackHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'http:'
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) {
      return undefined;
    }
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]') {
      return undefined;
    }
    if (!url.port) {
      return undefined;
    }
    url.hostname = '127.0.0.1';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

export function portFromUrl(value: string): number | undefined {
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
  } catch {
    return undefined;
  }
}

export async function chooseLoopbackPort(preferred: number, reserved: Set<number> = new Set()): Promise<number> {
  if (!reserved.has(preferred) && await canBindLoopback(preferred)) {
    return preferred;
  }
  return bindEphemeralPort(reserved);
}

async function canBindLoopback(port: number): Promise<boolean> {
  return new Promise((resolveCanBind) => {
    const server = createServer();
    server.once('error', () => resolveCanBind(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolveCanBind(true));
    });
  });
}

async function bindEphemeralPort(reserved: Set<number>): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === 'string') {
          rejectPort(new Error('Unable to bind loopback port.'));
          return;
        }
        if (reserved.has(address.port)) {
          void bindEphemeralPort(reserved).then(resolvePort, rejectPort);
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}
