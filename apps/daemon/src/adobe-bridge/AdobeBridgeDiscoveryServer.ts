import { createServer, type Server } from 'node:http';

export const DEFAULT_ADOBE_BRIDGE_DISCOVERY_PORT = 32124;

export interface AdobeBridgeDiscoveryPayload {
  product: 'debrute';
  bridgeVersion: 1;
  enabled: boolean;
  daemonUrl: string;
  apiBaseUrl: string;
  wsUrl: string;
}

export type AdobeBridgeDiscoveryListenStatus =
  | { status: 'available'; host: string; port: number }
  | { status: 'unavailable'; host: string; port: number; message: string };

export interface AdobeBridgeDiscoveryServer {
  listen(): Promise<AdobeBridgeDiscoveryListenStatus>;
  close(): Promise<void>;
  status(): AdobeBridgeDiscoveryListenStatus | undefined;
}

export interface AdobeBridgeDiscoveryServerOptions {
  host?: string;
  port?: number;
  snapshot: () => AdobeBridgeDiscoveryPayload;
}

export function createAdobeBridgeDiscoveryServer(options: AdobeBridgeDiscoveryServerOptions): AdobeBridgeDiscoveryServer {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? DEFAULT_ADOBE_BRIDGE_DISCOVERY_PORT;
  let server: Server | undefined;
  let currentStatus: AdobeBridgeDiscoveryListenStatus | undefined;

  async function listen(): Promise<AdobeBridgeDiscoveryListenStatus> {
    if (currentStatus) {
      return currentStatus;
    }

    const nextServer = createServer((request, response) => {
      if (!isLoopbackRequest(request)) {
        writeJson(response, 403, { error: { code: 'forbidden', message: 'Adobe Bridge discovery is loopback only.' } });
        return;
      }
      if ((request.method ?? 'GET') !== 'GET' || request.url?.split('?')[0] !== '/adobe-bridge/discovery') {
        writeJson(response, 404, { error: { code: 'not_found', message: 'Unknown Adobe Bridge discovery route.' } });
        return;
      }
      writeJson(response, 200, options.snapshot());
    });

    const status = await new Promise<AdobeBridgeDiscoveryListenStatus>((resolve) => {
      nextServer.once('error', (error) => {
        resolve({
          status: 'unavailable',
          host,
          port,
          message: error instanceof Error ? error.message : String(error)
        });
      });
      nextServer.listen(port, host, () => {
        const address = nextServer.address();
        const boundPort = address && typeof address !== 'string' ? address.port : port;
        resolve({ status: 'available', host, port: boundPort });
      });
    });

    if (status.status === 'available') {
      server = nextServer;
      currentStatus = status;
      return status;
    }

    nextServer.close();
    currentStatus = status;
    return status;
  }

  async function close(): Promise<void> {
    currentStatus = undefined;
    if (!server) {
      return;
    }
    const closing = server;
    server = undefined;
    await new Promise<void>((resolve, reject) => {
      closing.close((error) => error ? reject(error) : resolve());
    });
  }

  return {
    listen,
    close,
    status: () => currentStatus
  };
}

function writeJson(response: { writeHead(status: number, headers?: Record<string, string>): void; end(body?: string): void }, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function isLoopbackRequest(request: { socket: { remoteAddress: string | undefined } }): boolean {
  const address = request.socket.remoteAddress;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
