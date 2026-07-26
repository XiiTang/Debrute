import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CONTROL_PROTOCOL,
  CONTROL_PROTOCOL_VERSION,
  type ClientMessage,
  type ControlEvent,
  type ServerMessage
} from '@debrute/app-protocol';
import { describe, expect, it } from 'vitest';

import {
  RuntimeControlError,
  connectRuntimeControl
} from './index.js';
import { resolveRuntimeControlSocketPath } from './runtimeControlClient.js';

const PRODUCT_VERSION = '0.0.4';

describe('Runtime Control client', () => {
  it('resolves the exact per-user native endpoint on macOS and Windows', () => {
    expect(resolveRuntimeControlSocketPath({
      platform: 'darwin',
      temporaryDirectory: '/private/tmp'
    })).toBe('/private/tmp/debrute/control.sock');
    expect(resolveRuntimeControlSocketPath({
      platform: 'win32',
      windowsUserSid: 'S-1-5-21-10-20-30-1001'
    })).toBe('\\\\.\\pipe\\debrute-control-S-1-5-21-10-20-30-1001');
    expect(() => resolveRuntimeControlSocketPath({
      platform: 'win32',
      windowsUserSid: 'not-a-sid'
    })).toThrowError(/invalid current-user SID/);
  });

  it('uses protocol v2 and sends one activation request after a ready handshake', async () => {
    let requestCount = 0;
    await withControlServer((socket) => {
      readFrames(socket, (message) => {
        if (message.type === 'handshake') {
          expect(message).toEqual({
            type: 'handshake',
            protocol: CONTROL_PROTOCOL,
            protocol_version: CONTROL_PROTOCOL_VERSION,
            product_version: PRODUCT_VERSION,
            role: 'launcher'
          });
          acceptHandshake(socket, 'ready');
          return;
        }
        requestCount += 1;
        expect(message.request).toEqual({
          command: 'activate',
          intent: { kind: 'open_browser' }
        });
        respond(socket, message.request_id, {
          result: 'activation',
          outcome: 'opened'
        });
      });
    }, async (socketPath) => {
      const client = await connectClient(socketPath, 'launcher');
      await expect(client.activate({ kind: 'open_browser' })).resolves.toEqual({
        result: 'activation',
        outcome: 'opened'
      });
      expect(requestCount).toBe(1);
      client.close();
    });
  });

  it('polls inspection while starting before sending a ready-only request', async () => {
    let inspectCount = 0;
    await withControlServer((socket) => {
      readFrames(socket, (message) => {
        if (message.type === 'handshake') {
          acceptHandshake(socket, 'starting');
          return;
        }
        if (message.request.command === 'inspect') {
          inspectCount += 1;
          respond(socket, message.request_id, {
            result: 'inspection',
            instance_id: 'runtime-instance',
            status: inspectCount === 1 ? 'starting' : 'ready',
            executable_identity: null
          });
          return;
        }
        expect(message.request).toEqual({ command: 'create_cli_authorization' });
        respond(socket, message.request_id, {
          result: 'cli_authorization',
          origin: 'http://127.0.0.1:41000',
          authorization: 'connection-secret'
        });
      });
    }, async (socketPath) => {
      const client = await connectClient(socketPath, 'cli');
      await expect(client.createCliAuthorization()).resolves.toEqual({
        result: 'cli_authorization',
        origin: 'http://127.0.0.1:41000',
        authorization: 'connection-secret'
      });
      expect(inspectCount).toBe(2);
      client.close();
    });
  });

  it('uses one absolute Ready deadline and never sends the gated request after it expires', async () => {
    const requests: ClientMessage[] = [];
    await withControlServer((socket) => {
      readFrames(socket, (message) => {
        if (message.type === 'handshake') {
          acceptHandshake(socket, 'starting');
          return;
        }
        requests.push(message);
        if (requests.length === 1) {
          respond(socket, message.request_id, {
            result: 'inspection',
            instance_id: 'runtime-instance',
            status: 'starting',
            executable_identity: null
          });
        }
      });
    }, async (socketPath) => {
      const client = await connectRuntimeControl({
        socketPath,
        role: 'launcher',
        productVersion: PRODUCT_VERSION,
        readyDeadlineMs: Date.now() + 80
      });

      await expect(client.activate({ kind: 'open_browser' })).rejects.toMatchObject({
        code: 'runtime_ready_timeout'
      });
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((message) => (
        message.type === 'request' && message.request.command === 'inspect'
      ))).toBe(true);
    });
  });

  it('rejects a Ready handshake delivered after the absolute deadline', async () => {
    await withControlServer((socket) => {
      readFrames(socket, (message) => {
        if (message.type !== 'handshake') {
          return;
        }
        acceptHandshake(socket, 'ready');
        const blockedUntil = Date.now() + 100;
        while (Date.now() < blockedUntil) {
          // Hold the event loop so the already-buffered handshake and deadline
          // become observable in the same turn.
        }
      });
    }, async (socketPath) => {
      await expect(connectRuntimeControl({
        socketPath,
        role: 'launcher',
        productVersion: PRODUCT_VERSION,
        readyDeadlineMs: Date.now() + 50
      })).rejects.toMatchObject({ code: 'runtime_ready_timeout' });
    });
  });

  it('retires the startup deadline after Ready is observed', async () => {
    await withControlServer((socket) => {
      readFrames(socket, (message) => {
        if (message.type === 'handshake') {
          acceptHandshake(socket, 'ready');
          return;
        }
        respond(socket, message.request_id, {
          result: 'cli_authorization',
          origin: 'http://127.0.0.1:41000',
          authorization: 'connection-secret'
        });
      });
    }, async (socketPath) => {
      const client = await connectRuntimeControl({
        socketPath,
        role: 'cli',
        productVersion: PRODUCT_VERSION,
        readyDeadlineMs: Date.now() + 100
      });
      await new Promise((resolve) => setTimeout(resolve, 120));
      await expect(client.createCliAuthorization()).resolves.toMatchObject({
        result: 'cli_authorization'
      });
      client.close();
    });
  });

  it('forwards typed rejection responses', async () => {
    await withControlServer((socket) => {
      readFrames(socket, (message) => {
        if (message.type === 'handshake') {
          acceptHandshake(socket, 'ready');
          return;
        }
        respond(socket, message.request_id, { result: 'rejected', code: 'role_denied' });
      });
    }, async (socketPath) => {
      const client = await connectClient(socketPath, 'launcher');
      await expect(client.createCliAuthorization()).resolves.toEqual({
        result: 'rejected',
        code: 'role_denied'
      });
      client.close();
    });
  });

  it('creates a one-use Desktop launch ticket and registers a dev origin', async () => {
    const requests: ClientMessage[] = [];
    await withControlServer((socket) => {
      readFrames(socket, (message) => {
        if (message.type === 'handshake') {
          acceptHandshake(socket, 'ready');
          return;
        }
        requests.push(message);
        if (message.request.command === 'create_desktop_launch_ticket') {
          respond(socket, message.request_id, {
            result: 'desktop_launch_ticket',
            ticket: 'one-use-ticket',
            url: 'http://127.0.0.1:41000/'
          });
        } else {
          respond(socket, message.request_id, {
            result: 'dev_workbench_origin_registered',
            runtime_origin: 'http://127.0.0.1:41000'
          });
        }
      });
    }, async (socketPath) => {
      const client = await connectClient(socketPath, 'launcher');
      await expect(client.createDesktopLaunchTicket('window-1')).resolves.toEqual({
        result: 'desktop_launch_ticket',
        ticket: 'one-use-ticket',
        url: 'http://127.0.0.1:41000/'
      });
      await expect(client.registerDevWorkbenchOrigin('http://127.0.0.1:5173')).resolves.toEqual({
        result: 'dev_workbench_origin_registered',
        runtime_origin: 'http://127.0.0.1:41000'
      });
      expect(requests.map((message) => message.type === 'request' ? message.request : null)).toEqual([
        { command: 'create_desktop_launch_ticket', window_key: 'window-1' },
        { command: 'register_dev_workbench_origin', origin: 'http://127.0.0.1:5173' }
      ]);
      client.close();
    });
  });

  it('delivers Desktop and product events without an acknowledgement protocol', async () => {
    const events: ControlEvent[] = [];
    await withControlServer((socket) => {
      readFrames(socket, (message) => {
        if (message.type === 'handshake') {
          acceptHandshake(socket, 'ready');
          return;
        }
        writeFrame(socket, {
          type: 'event',
          event: {
            event: 'desktop_window_open_requested',
            window_key: 'window-1',
            route: { kind: 'project', project_id: 'project-1' }
          }
        });
        writeFrame(socket, {
          type: 'event',
          event: { event: 'desktop_window_focus_requested', window_key: 'window-1' }
        });
        writeFrame(socket, { type: 'event', event: { event: 'product_replacing' } });
        respond(socket, message.request_id, {
          result: 'inspection',
          instance_id: 'runtime-instance',
          status: 'ready',
          executable_identity: 'runtime-binary'
        });
      });
    }, async (socketPath) => {
      const client = await connectClient(socketPath, 'launcher');
      client.onEvent((event) => events.push(event));
      await client.inspect();
      expect(client.status).toBe('replacing');
      expect(events).toEqual([
        {
          event: 'desktop_window_open_requested',
          window_key: 'window-1',
          route: { kind: 'project', project_id: 'project-1' }
        },
        { event: 'desktop_window_focus_requested', window_key: 'window-1' },
        { event: 'product_replacing' }
      ]);
      client.close();
    });
  });

  it('surfaces runtime_lost without reconnecting', async () => {
    let connectionCount = 0;
    await withControlServer((socket) => {
      connectionCount += 1;
      readFrames(socket, (message) => {
        if (message.type === 'handshake') {
          acceptHandshake(socket, 'ready');
          queueMicrotask(() => socket.destroy());
        }
      });
    }, async (socketPath) => {
      const client = await connectClient(socketPath, 'launcher');
      const lost = deferred<RuntimeControlError>();
      client.onRuntimeLost((error) => lost.resolve(error));
      await expect(lost.promise).resolves.toMatchObject({ code: 'runtime_lost' });
      await expect(client.inspect()).rejects.toMatchObject({ code: 'runtime_lost' });
      expect(connectionCount).toBe(1);
    });
  });

  it('rejects an incompatible or explicitly rejected handshake', async () => {
    await withControlServer((socket) => {
      readFrames(socket, (message) => {
        if (message.type === 'handshake') {
          writeFrame(socket, { type: 'handshake_rejected', reason: 'role_not_supported' });
        }
      });
    }, async (socketPath) => {
      await expect(connectClient(socketPath, 'launcher')).rejects.toMatchObject({
        code: 'handshake_rejected'
      });
    });
  });

  it('rejects invalid UTF-8 even when replacement decoding would form valid JSON', async () => {
    await withControlServer((socket) => {
      readFrames(socket, (message) => {
        if (message.type !== 'handshake') {
          return;
        }
        const prefix = Buffer.from('{"type":"handshake_accepted","instance_id":"');
        const suffix = Buffer.from(
          `","protocol_version":${CONTROL_PROTOCOL_VERSION},"product_version":"${PRODUCT_VERSION}","status":"ready"}`
        );
        writePayload(socket, Buffer.concat([prefix, Buffer.from([0xff]), suffix]));
      });
    }, async (socketPath) => {
      await expect(connectClient(socketPath, 'launcher')).rejects.toMatchObject({
        code: 'protocol_error'
      });
    });
  });
});

function connectClient(socketPath: string, role: 'launcher' | 'cli') {
  return connectRuntimeControl({
    socketPath,
    role,
    productVersion: PRODUCT_VERSION,
    readyDeadlineMs: Date.now() + 500
  });
}

function acceptHandshake(socket: Socket, status: 'starting' | 'ready'): void {
  writeFrame(socket, {
    type: 'handshake_accepted',
    instance_id: 'runtime-instance',
    protocol_version: CONTROL_PROTOCOL_VERSION,
    product_version: PRODUCT_VERSION,
    status
  });
}

function respond(
  socket: Socket,
  requestId: string,
  response: Extract<ServerMessage, { type: 'response' }>['response']
): void {
  writeFrame(socket, { type: 'response', request_id: requestId, response });
}

async function withControlServer(
  onConnection: (socket: Socket) => void,
  run: (socketPath: string) => Promise<void>
): Promise<void> {
  const identifier = `dbrt-ts-${process.pid}-${randomUUID().slice(0, 8)}`;
  const directory = process.platform === 'win32' ? undefined : join(tmpdir(), identifier);
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\${identifier}`
    : join(directory!, 'control.sock');
  if (directory) {
    await mkdir(directory, { recursive: true });
  }
  const server = createServer(onConnection);
  await listen(server, socketPath);
  try {
    await run(socketPath);
  } finally {
    await closeServer(server);
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function readFrames(socket: Socket, onMessage: (message: ClientMessage) => void): void {
  let buffered = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32BE(0);
      if (buffered.length < length + 4) {
        return;
      }
      const payload = buffered.subarray(4, length + 4);
      buffered = buffered.subarray(length + 4);
      onMessage(JSON.parse(payload.toString('utf8')) as ClientMessage);
    }
  });
}

function writeFrame(socket: Socket, message: ServerMessage): void {
  writePayload(socket, Buffer.from(JSON.stringify(message), 'utf8'));
}

function writePayload(socket: Socket, payload: Buffer): void {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length);
  socket.write(Buffer.concat([header, payload]));
}

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
