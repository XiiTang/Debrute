import { describe, expect, it, vi } from 'vitest';
import {
  RuntimeConnection,
  type PhotoshopSocket,
  type RuntimeConnectionState
} from './RuntimeConnection.js';
import { PHOTOSHOP_WEBSOCKET_SUBPROTOCOL } from '@debrute/app-protocol';

const placementMimeTypes = () => [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/vnd.adobe.photoshop',
  'image/avif'
] as const;

describe('RuntimeConnection', () => {
  it('continues probing when the UXP WebSocket constructor rejects a port', () => {
    const socket = new FakeSocket(
      'ws://127.0.0.1:32126/photoshop/session',
      PHOTOSHOP_WEBSOCKET_SUBPROTOCOL
    );
    const createSocket = vi.fn((url: string) => {
      if (url.endsWith(':32124/photoshop/session') || url.endsWith(':32125/photoshop/session')) {
        throw new Error('Permission denied');
      }
      return socket;
    });
    const connection = new RuntimeConnection({
      hostVersion: () => '27.9.0',
      placementMimeTypes: () => [...placementMimeTypes()],
      documents: () => [],
      createSocket,
      schedule: vi.fn(() => 1),
      cancelSchedule: vi.fn(),
      onState: vi.fn(),
      onMessage: vi.fn()
    });

    expect(() => connection.start()).not.toThrow();
    expect(createSocket).toHaveBeenCalledTimes(3);
    expect(createSocket).toHaveBeenLastCalledWith(
      'ws://127.0.0.1:32126/photoshop/session',
      PHOTOSHOP_WEBSOCKET_SUBPROTOCOL
    );
  });

  it('starts a fresh discovery round after stopping during an active probe', () => {
    const sockets: FakeSocket[] = [];
    const connection = new RuntimeConnection({
      hostVersion: () => '27.9.0',
      placementMimeTypes: () => [...placementMimeTypes()],
      documents: () => [],
      createSocket: (url, protocol) => {
        const socket = new FakeSocket(url, protocol);
        sockets.push(socket);
        return socket;
      },
      schedule: vi.fn(() => 1),
      cancelSchedule: vi.fn(),
      onState: vi.fn(),
      onMessage: vi.fn()
    });

    connection.start();
    connection.stop();
    connection.start();

    expect(sockets).toHaveLength(2);
    expect(sockets[0]?.closed).toBe(true);
    expect(sockets[1]?.url).toBe('ws://127.0.0.1:32124/photoshop/session');
  });

  it('probes the closed pool, starts one session, and retries only after loss', () => {
    const sockets: FakeSocket[] = [];
    const scheduled: Array<{ delay: number; callback: () => void }> = [];
    const states: RuntimeConnectionState[] = [];
    const cancelSchedule = vi.fn();
    const connection = new RuntimeConnection({
      hostVersion: () => '27.9.0',
      placementMimeTypes: () => [...placementMimeTypes()],
      documents: () => [{ documentId: 4, title: 'Poster.psd' }],
      createSocket: (url, protocol) => {
        const socket = new FakeSocket(url, protocol);
        sockets.push(socket);
        return socket;
      },
      schedule: (callback, delay) => {
        scheduled.push({ callback, delay });
        return scheduled.length;
      },
      cancelSchedule,
      onState: (state) => states.push(state),
      onMessage: vi.fn()
    });

    connection.start();
    expect(scheduled[0]?.delay).toBe(5_000);
    expect(sockets[0]?.url).toBe('ws://127.0.0.1:32124/photoshop/session');
    sockets[0]?.fail();
    expect(sockets[1]?.url).toBe('ws://127.0.0.1:32125/photoshop/session');

    sockets[1]?.open();
    expect(sockets[1]?.sent).toEqual([]);
    const deferredSessionStart = scheduled.find((entry) => entry.delay === 0);
    expect(deferredSessionStart).toBeDefined();
    deferredSessionStart?.callback();
    expect(JSON.parse(sockets[1]?.sent[0] ?? '{}')).toEqual({
      type: 'photoshop.session.start',
      hostVersion: '27.9.0',
      placementMimeTypes: [
        'image/png',
        'image/jpeg',
        'image/webp',
        'image/vnd.adobe.photoshop',
        'image/avif'
      ],
      documents: [{ documentId: 4, title: 'Poster.psd' }]
    });
    sockets[1]?.message({
      type: 'photoshop.session.ready',
      runtimeInstanceId: 'runtime-1',
      pluginSessionId: 'session-1',
      bearer: 'bearer-1'
    });

    expect(states.at(-1)).toMatchObject({ status: 'ready', pluginSessionId: 'session-1' });
    expect(cancelSchedule).toHaveBeenCalled();

    sockets[1]?.closeFromPeer();
    expect(states.at(-1)).toEqual({ status: 'disconnected' });
    const retry = scheduled.at(-1);
    expect(retry?.delay).toBe(5_000);
    retry?.callback();
    expect(sockets[2]?.url).toBe('ws://127.0.0.1:32124/photoshop/session');
  });

  it('advances past a candidate that never completes its WebSocket handshake', () => {
    const sockets: FakeSocket[] = [];
    const scheduled: Array<{ delay: number; callback: () => void }> = [];
    const cancelled = new Set<unknown>();
    const states: RuntimeConnectionState[] = [];
    const connection = new RuntimeConnection({
      hostVersion: () => '27.9.0',
      placementMimeTypes: () => [...placementMimeTypes()],
      documents: () => [],
      createSocket: (url, protocol) => {
        const socket = new FakeSocket(url, protocol);
        sockets.push(socket);
        return socket;
      },
      schedule: (callback, delay) => {
        const handle = { callback, delay };
        scheduled.push(handle);
        return handle;
      },
      cancelSchedule: (handle) => { cancelled.add(handle); },
      onState: (state) => states.push(state),
      onMessage: vi.fn()
    });

    connection.start();
    expect(sockets[0]?.url).toBe('ws://127.0.0.1:32124/photoshop/session');
    const firstCandidateDeadline = scheduled.find((entry) => entry.delay === 500);
    expect(firstCandidateDeadline).toBeDefined();

    firstCandidateDeadline?.callback();
    expect(sockets[0]?.closed).toBe(true);
    expect(sockets[1]?.url).toBe('ws://127.0.0.1:32125/photoshop/session');

    sockets[1]?.open();
    scheduled.find((entry) => entry.delay === 0)?.callback();
    sockets[1]?.message({
      type: 'photoshop.session.ready',
      runtimeInstanceId: 'runtime-1',
      pluginSessionId: 'session-1',
      bearer: 'bearer-1'
    });

    expect(states.at(-1)).toMatchObject({ status: 'ready', pluginSessionId: 'session-1' });
    expect(cancelled.has(firstCandidateDeadline)).toBe(true);
    firstCandidateDeadline?.callback();
    expect(sockets).toHaveLength(2);
    expect(states.at(-1)).toMatchObject({ status: 'ready', pluginSessionId: 'session-1' });
  });

  it('finishes the ordered fixed-port pool before one non-overlapping five-second retry', () => {
    const sockets: FakeSocket[] = [];
    const scheduled: Array<{ delay: number; callback: () => void }> = [];
    const states: RuntimeConnectionState[] = [];
    const connection = new RuntimeConnection({
      hostVersion: () => '27.9.0',
      placementMimeTypes: () => [...placementMimeTypes()],
      documents: () => [],
      createSocket: (url, protocol) => {
        const socket = new FakeSocket(url, protocol);
        sockets.push(socket);
        return socket;
      },
      schedule: (callback, delay) => {
        scheduled.push({ callback, delay });
        return scheduled.length;
      },
      cancelSchedule: vi.fn(),
      onState: (state) => states.push(state),
      onMessage: vi.fn()
    });

    connection.start();
    for (let index = 0; index < 8; index += 1) {
      expect(sockets[index]?.url).toBe(
        `ws://127.0.0.1:${32124 + index}/photoshop/session`
      );
      sockets[index]?.fail();
    }

    expect(sockets).toHaveLength(8);
    expect(states.at(-1)).toEqual({ status: 'disconnected' });
    const retry = scheduled.at(-1);
    expect(retry?.delay).toBe(5_000);
    expect(sockets).toHaveLength(8);
    retry?.callback();
    expect(sockets).toHaveLength(9);
    expect(sockets[8]?.url).toBe('ws://127.0.0.1:32124/photoshop/session');
  });

  it('keeps the byte deadline active until the response body is consumed', async () => {
    const socket = new FakeSocket('ws://127.0.0.1:32124/photoshop/session', PHOTOSHOP_WEBSOCKET_SUBPROTOCOL);
    const scheduled: Array<{ delay: number; callback: () => void }> = [];
    const cancelled = new Set<unknown>();
    let resolveBody!: (bytes: ArrayBuffer) => void;
    const body = new Promise<ArrayBuffer>((resolve) => { resolveBody = resolve; });
    const connection = new RuntimeConnection({
      hostVersion: () => '27.9.0',
      placementMimeTypes: () => [...placementMimeTypes()],
      documents: () => [],
      createSocket: () => socket,
      request: async () => ({
        ok: true,
        arrayBuffer: () => body
      }) as Response,
      schedule: (callback, delay) => {
        const handle = { callback, delay };
        scheduled.push(handle);
        return handle;
      },
      cancelSchedule: (handle) => { cancelled.add(handle); },
      onState: vi.fn(),
      onMessage: vi.fn()
    });
    connection.start();
    socket.open();
    socket.message({
      type: 'photoshop.session.ready',
      runtimeInstanceId: 'runtime-1',
      pluginSessionId: 'session-1',
      bearer: 'bearer-1'
    });

    const download = connection.requireSession().downloadCommandContent('command-1', 3);
    await Promise.resolve();
    await Promise.resolve();
    const byteDeadline = scheduled.find((entry) => entry.delay === 5 * 60_000);
    expect(byteDeadline).toBeDefined();
    expect(cancelled.has(byteDeadline)).toBe(false);

    resolveBody(new Uint8Array([1, 2, 3]).buffer);
    await expect(download).resolves.toEqual(new Uint8Array([1, 2, 3]).buffer);
    expect(cancelled.has(byteDeadline)).toBe(true);
  });

  it('aborts and rejects HTTP work when its socket session is lost', async () => {
    const socket = new FakeSocket('ws://127.0.0.1:32124/photoshop/session', PHOTOSHOP_WEBSOCKET_SUBPROTOCOL);
    let requestSignal: AbortSignal | null | undefined;
    let resolveBody!: (bytes: ArrayBuffer) => void;
    const body = new Promise<ArrayBuffer>((resolve) => { resolveBody = resolve; });
    const connection = new RuntimeConnection({
      hostVersion: () => '27.9.0',
      placementMimeTypes: () => [...placementMimeTypes()],
      documents: () => [],
      createSocket: () => socket,
      request: async (_url, init) => {
        requestSignal = init?.signal;
        return { ok: true, arrayBuffer: () => body } as Response;
      },
      schedule: vi.fn(() => 1),
      cancelSchedule: vi.fn(),
      onState: vi.fn(),
      onMessage: vi.fn()
    });
    connection.start();
    socket.open();
    socket.message({
      type: 'photoshop.session.ready',
      runtimeInstanceId: 'runtime-1',
      pluginSessionId: 'session-1',
      bearer: 'bearer-1'
    });

    const download = connection.requireSession().downloadCommandContent('command-1', 3);
    await Promise.resolve();
    socket.closeFromPeer();
    expect(requestSignal?.aborted).toBe(true);
    resolveBody(new Uint8Array([1, 2, 3]).buffer);

    await expect(download).rejects.toThrow('Photoshop Runtime session was lost.');
  });

  it('uploads an ArrayBuffer so Photoshop UXP emits one exact image/png header', async () => {
    const socket = new FakeSocket('ws://127.0.0.1:32124/photoshop/session', PHOTOSHOP_WEBSOCKET_SUBPROTOCOL);
    const request = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ fileName: 'Hero.png' })
    }) as Response);
    const connection = new RuntimeConnection({
      hostVersion: () => '27.9.0',
      placementMimeTypes: () => [...placementMimeTypes()],
      documents: () => [],
      createSocket: () => socket,
      request,
      schedule: vi.fn(() => 1),
      cancelSchedule: vi.fn(),
      onState: vi.fn(),
      onMessage: vi.fn()
    });
    connection.start();
    socket.open();
    socket.message({
      type: 'photoshop.session.ready',
      runtimeInstanceId: 'runtime-1',
      pluginSessionId: 'session-1',
      bearer: 'bearer-1'
    });

    const session = connection.requireSession();
    await expect(session.uploadExportItem(
      'command-1',
      'item-1',
      new Uint8Array([0, 1, 2, 3]).subarray(1, 3)
    )).resolves.toEqual({ fileName: 'Hero.png' });

    const init = request.mock.calls[0]?.[1];
    expect(init?.body).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(init?.body as ArrayBuffer)]).toEqual([1, 2]);
    expect(new Headers(init?.headers).get('Content-Type')).toBe('image/png');
    expect(request.mock.calls[0]?.[0]).toBe(
      'http://127.0.0.1:32124/photoshop/exports/command-1/items/item-1'
    );
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer bearer-1');
  });

  it('never rebinds an admitted operation to a replacement socket session', async () => {
    const first = new FakeSocket(
      'ws://127.0.0.1:32124/photoshop/session',
      PHOTOSHOP_WEBSOCKET_SUBPROTOCOL
    );
    const second = new FakeSocket(
      'ws://127.0.0.1:32124/photoshop/session',
      PHOTOSHOP_WEBSOCKET_SUBPROTOCOL
    );
    const sockets = [first, second];
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    const connection = new RuntimeConnection({
      hostVersion: () => '27.9.0',
      placementMimeTypes: () => [...placementMimeTypes()],
      documents: () => [],
      createSocket: () => sockets.shift() ?? second,
      request: async (url, init) => {
        requests.push({
          url,
          authorization: new Headers(init?.headers).get('Authorization')
        });
        return new Response(JSON.stringify({ fileName: 'Hero.png' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      },
      schedule: (callback, delay) => {
        scheduled.push({ callback, delay });
        return scheduled.length;
      },
      cancelSchedule: vi.fn(),
      onState: vi.fn(),
      onMessage: vi.fn()
    });
    connection.start();
    first.open();
    scheduled.find((entry) => entry.delay === 0)?.callback();
    first.message({
      type: 'photoshop.session.ready',
      runtimeInstanceId: 'runtime-1',
      pluginSessionId: 'session-1',
      bearer: 'bearer-1'
    });
    const admitted = connection.requireSession();

    first.closeFromPeer();
    scheduled.at(-1)?.callback();
    second.open();
    scheduled.filter((entry) => entry.delay === 0).at(-1)?.callback();
    second.message({
      type: 'photoshop.session.ready',
      runtimeInstanceId: 'runtime-1',
      pluginSessionId: 'session-2',
      bearer: 'bearer-2'
    });

    expect(admitted.isLive()).toBe(false);
    expect(() => admitted.send({
      type: 'photoshop.documents.snapshot',
      documents: []
    })).toThrow('Photoshop Runtime session was lost.');
    await expect(admitted.uploadExportItem(
      'command-1',
      'item-1',
      new Uint8Array([1])
    )).rejects.toThrow('Photoshop Runtime session was lost.');
    expect(requests).toEqual([]);
    expect(second.sent.map((value) => JSON.parse(value))).not.toContainEqual(expect.objectContaining({
      commandId: 'command-1'
    }));
  });

  it('revokes an admitted session when its socket rejects a control send', () => {
    const { connection, socket } = readyConnection(async () => new Response(null, { status: 204 }));
    const session = connection.requireSession();
    vi.spyOn(socket, 'send').mockImplementationOnce(() => {
      throw new Error('socket is no longer writable');
    });

    expect(() => session.send({
      type: 'photoshop.documents.snapshot',
      documents: []
    })).toThrow('Photoshop Runtime session was lost.');

    expect(session.isLive()).toBe(false);
    expect(socket.closed).toBe(true);
    expect(() => connection.requireSession()).toThrow('Photoshop Runtime session is not ready.');
  });

  it('keeps a validated upload acknowledgement committed when the socket closes afterward', async () => {
    let closeAfterResponse!: () => void;
    const { connection, socket } = readyConnection(async () => {
      const response = new Response(JSON.stringify({ fileName: 'Hero.png' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
      closeAfterResponse = () => socket.closeFromPeer();
      return response;
    });
    const session = connection.requireSession();
    const upload = session.uploadExportItem('command-1', 'item-1', new Uint8Array([1]));
    await Promise.resolve();
    closeAfterResponse();

    await expect(upload).resolves.toEqual({ fileName: 'Hero.png' });
    expect(session.isLive()).toBe(false);
  });

  it('surfaces the closed Runtime error code and message for failed transfers', async () => {
    const { connection } = readyConnection(async () => new Response(JSON.stringify({
      error: {
        code: 'photoshop_export_failed',
        message: 'Project staging sync failed.'
      }
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    }));

    await expect(connection.requireSession().uploadExportItem(
      'command-1',
      'item-1',
      new Uint8Array([1])
    )).rejects.toThrow(
      'Photoshop transfer failed with HTTP 400 (photoshop_export_failed): Project staging sync failed.'
    );
  });

  it('keeps a complete closed rejection explicit when the socket closes afterward', async () => {
    let closeAfterResponse!: () => void;
    const { connection, socket } = readyConnection(async () => {
      const response = new Response(JSON.stringify({
        error: {
          code: 'photoshop_export_failed',
          message: 'Project staging sync failed.'
        }
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
      closeAfterResponse = () => socket.closeFromPeer();
      return response;
    });

    const upload = connection.requireSession().uploadExportItem(
      'command-1',
      'item-1',
      new Uint8Array([1])
    );
    await Promise.resolve();
    closeAfterResponse();

    await expect(upload).rejects.toThrow(
      'Photoshop transfer failed with HTTP 400 (photoshop_export_failed): Project staging sync failed.'
    );
  });

  it('treats a non-JSON upload response as an unknown commit outcome', async () => {
    const { connection } = readyConnection(async () => new Response('gateway unavailable', {
      status: 502,
      headers: { 'Content-Type': 'text/plain' }
    }));

    await expect(connection.requireSession().uploadExportItem(
      'command-1',
      'item-1',
      new Uint8Array([1])
    )).rejects.toThrow(
      'Photoshop export item may have been saved, but Runtime confirmation was lost.'
    );
  });

  it('treats an upload response outside the closed envelope as an unknown commit outcome', async () => {
    const { connection } = readyConnection(async () => new Response(JSON.stringify({
      message: 'Project revision changed.'
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' }
    }));

    await expect(connection.requireSession().uploadExportItem(
      'command-1',
      'item-1',
      new Uint8Array([1])
    )).rejects.toThrow(
      'Photoshop export item may have been saved, but Runtime confirmation was lost.'
    );
  });

  it('treats an unknown upload error code as an unknown commit outcome', async () => {
    const { connection } = readyConnection(async () => new Response(JSON.stringify({
      error: {
        code: 'unknown_runtime_error',
        message: 'Unknown error.'
      }
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    }));

    await expect(connection.requireSession().uploadExportItem(
      'command-1',
      'item-1',
      new Uint8Array([1])
    )).rejects.toThrow(
      'Photoshop export item may have been saved, but Runtime confirmation was lost.'
    );
  });
});

function readyConnection(request: (url: string, init?: RequestInit) => Promise<Response>): {
  connection: RuntimeConnection;
  socket: FakeSocket;
} {
  const socket = new FakeSocket(
    'ws://127.0.0.1:32124/photoshop/session',
    PHOTOSHOP_WEBSOCKET_SUBPROTOCOL
  );
  const connection = new RuntimeConnection({
    hostVersion: () => '27.9.0',
    placementMimeTypes: () => [...placementMimeTypes()],
    documents: () => [],
    createSocket: () => socket,
    request,
    schedule: vi.fn(() => 1),
    cancelSchedule: vi.fn(),
    onState: vi.fn(),
    onMessage: vi.fn()
  });
  connection.start();
  socket.open();
  socket.message({
    type: 'photoshop.session.ready',
    runtimeInstanceId: 'runtime-1',
    pluginSessionId: 'session-1',
    bearer: 'bearer-1'
  });
  return { connection, socket };
}

class FakeSocket implements PhotoshopSocket {
  readonly sent: string[] = [];
  closed = false;
  protocol = '';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string, readonly requestedProtocol: string) {}

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.protocol = this.requestedProtocol;
    this.onopen?.();
  }

  fail(): void {
    this.onerror?.();
  }

  message(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }

  closeFromPeer(): void {
    this.onclose?.();
  }
}
