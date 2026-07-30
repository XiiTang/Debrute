import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalSessionView } from '@debrute/app-protocol';
import { createTerminalHubClient } from './terminalHubClient';

class FakeWebSocket extends EventTarget {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    this.readyState = 3;
  }

  emit(type: string, data?: unknown): void {
    this.dispatchEvent(Object.assign(new Event(type), data === undefined ? {} : { data: JSON.stringify(data) }));
  }
}

describe('multiplexed Terminal hub client', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:41001' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('publishes the ordered Terminal collection and observes only explicit listeners after sync', () => {
    const client = createTerminalHubClient();
    client.bindProject('project-1', 'connection-1');
    const socket = FakeWebSocket.instances[0]!;
    socket.readyState = 0;
    const snapshots: TerminalSessionView[][] = [];
    client.subscribeSessions((sessions) => snapshots.push(sessions), vi.fn());
    client.subscribe('terminal-1', vi.fn(), vi.fn());

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit('open');
    expect(frameTypes(socket)).toEqual(['bind']);

    socket.emit('message', {
      type: 'sync',
      protocolVersion: 1,
      topologyRevision: 4,
      sessions: [session()]
    });

    expect(snapshots).toEqual([[session()]]);
    expect(frameTypes(socket)).toEqual(['bind', 'observe']);
  });

  it('closes the hub when an ordered topology revision is skipped', () => {
    const { client, socket } = bindOpenClient();
    const onError = vi.fn();
    client.subscribeSessions(vi.fn(), onError);
    synchronize(socket, [session()], 4);

    socket.emit('message', {
      type: 'topology',
      topologyRevision: 6,
      sessions: []
    });

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Terminal topology revision is not contiguous: expected 5, received 6.'
    }));
    expect(socket.readyState).toBe(3);
  });

  it('projects topology removals and closes the removed Terminal subscription', async () => {
    const { client, socket } = bindOpenClient();
    const snapshots: TerminalSessionView[][] = [];
    const events: unknown[] = [];
    client.subscribeSessions((sessions) => snapshots.push(sessions), vi.fn());
    synchronize(socket);
    client.subscribe('terminal-1', (event) => events.push(event), vi.fn());
    acceptObservation(socket);

    socket.emit('message', {
      type: 'topology',
      topologyRevision: 2,
      sessions: []
    });

    expect(snapshots.at(-1)).toEqual([]);
    expect(events).toContainEqual({ type: 'closed', terminalId: 'terminal-1' });
    await expect(client.writeInput('terminal-1', 'pwd\r')).rejects.toThrow(
      'Terminal session was closed: terminal-1'
    );
    await expect(client.resize('terminal-1', 100, 30)).rejects.toThrow(
      'Terminal session was closed: terminal-1'
    );
  });

  it('does not let a collection snapshot overwrite newer observed session metadata', () => {
    const { client, socket } = bindOpenClient();
    const snapshots: TerminalSessionView[][] = [];
    client.subscribeSessions((sessions) => snapshots.push(sessions), vi.fn());
    synchronize(socket);
    client.subscribe('terminal-1', vi.fn(), vi.fn());
    acceptObservation(socket);
    const exited = { ...session(), status: 'exited' as const, exitCode: 0, updatedAt: 'later' };
    socket.emit('message', { type: 'status', session: exited });

    socket.emit('message', {
      type: 'topology',
      topologyRevision: 2,
      sessions: [session(), session('terminal-2')]
    });

    expect(snapshots.at(-1)).toEqual([exited, session('terminal-2')]);
  });

  it('rejects controls without an explicit Terminal observation', async () => {
    const { client, socket } = bindOpenClient();
    synchronize(socket);

    await expect(client.writeInput('terminal-1', 'pwd\r')).rejects.toThrow(
      'Terminal is not observed: terminal-1'
    );
    await expect(client.resize('terminal-1', 100, 30)).rejects.toThrow(
      'Terminal is not observed: terminal-1'
    );
    expect(frameTypes(socket)).toEqual(['bind']);
  });

  it('binds one Project socket, renders checkpoints, and acknowledges ordered input', async () => {
    const client = createTerminalHubClient();
    client.bindProject('project-1', 'connection-1');
    const socket = FakeWebSocket.instances[0]!;
    socket.emit('open');
    expect(socket.url).toBe('ws://127.0.0.1:41001/api/projects/project-1/terminals/ws');
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      type: 'bind',
      protocolVersion: 1,
      connectionCredential: 'connection-1'
    });

    const events: unknown[] = [];
    client.subscribe('terminal-1', (event) => events.push(event), vi.fn());
    synchronize(socket);
    socket.emit('message', {
      type: 'observed',
      session: session(),
      checkpoint: { ...checkpoint('terminal-1'), outputSequence: 4, ansiBase64: btoa('ready\r\n') }
    });
    expect(events).toContainEqual({
      type: 'replay',
      terminalId: 'terminal-1',
      chunks: [{ sequence: 4, data: 'ready\r\n' }],
      lastSequence: 4
    });

    const written = client.writeInput('terminal-1', 'pwd\r');
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      type: 'input', requestId: 1, terminalId: 'terminal-1', sequence: 1, data: 'pwd\r'
    });
    socket.emit('message', { type: 'input-ack', requestId: 1, terminalId: 'terminal-1', sequence: 1 });
    await expect(written).resolves.toEqual({ ok: true });
  });

  it('continues input sequence across observation replacement on one attachment', async () => {
    const { client, socket } = bindOpenClient();
    synchronize(socket);

    const firstSubscription = client.subscribe('terminal-1', vi.fn(), vi.fn());
    acceptObservation(socket);
    const firstInput = client.writeInput('terminal-1', 'one');
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      type: 'input', requestId: 1, terminalId: 'terminal-1', sequence: 1, data: 'one'
    });
    socket.emit('message', { type: 'input-ack', requestId: 1, terminalId: 'terminal-1', sequence: 1 });
    await expect(firstInput).resolves.toEqual({ ok: true });

    firstSubscription.close();
    client.subscribe('terminal-1', vi.fn(), vi.fn());
    acceptObservation(socket);

    const secondInput = client.writeInput('terminal-1', 'two');
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      type: 'input', requestId: 2, terminalId: 'terminal-1', sequence: 2, data: 'two'
    });
    socket.emit('message', { type: 'input-ack', requestId: 2, terminalId: 'terminal-1', sequence: 2 });
    await expect(secondInput).resolves.toEqual({ ok: true });
  });

  it('rejects unsent controls when the last subscription closes without consuming input sequence', async () => {
    const client = createTerminalHubClient();
    client.bindProject('project-1', 'connection-1');
    const socket = FakeWebSocket.instances[0]!;
    socket.readyState = 0;

    const subscription = client.subscribe('terminal-1', vi.fn(), vi.fn());
    const canceledInput = client.writeInput('terminal-1', 'canceled');
    const canceledResize = client.resize('terminal-1', 100, 30);
    subscription.close();

    await expect(canceledInput).rejects.toThrow('observation ended before input was sent');
    await expect(canceledResize).rejects.toThrow('observation ended before resize was sent');

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit('open');
    const nextSubscription = client.subscribe('terminal-1', vi.fn(), vi.fn());
    synchronize(socket);
    acceptObservation(socket);
    const nextInput = client.writeInput('terminal-1', 'first-sent');
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      type: 'input', requestId: 1, terminalId: 'terminal-1', sequence: 1, data: 'first-sent'
    });
    socket.emit('message', { type: 'input-ack', requestId: 1, terminalId: 'terminal-1', sequence: 1 });
    await expect(nextInput).resolves.toEqual({ ok: true });
    nextSubscription.close();
  });

  it('waits for Terminal observation before sending the initial resize', async () => {
    const { client, socket } = bindOpenClient();
    synchronize(socket);

    client.subscribe('terminal-1', vi.fn(), vi.fn());
    expect(frameTypes(socket)).toEqual(['bind', 'observe']);
    const resized = client.resize('terminal-1', 100, 30);
    expect(frameTypes(socket)).toEqual(['bind', 'observe']);

    acceptObservation(socket);
    expect(frameTypes(socket)).toEqual(['bind', 'observe', 'resize']);

    acceptResize(socket, 1, 'terminal-1', 100, 30);
    await expect(resized).resolves.toEqual({
      session: { ...session(), cols: 100, rows: 30 }
    });
  });

  it('observes subscriptions registered while the Project socket is connecting', async () => {
    const client = createTerminalHubClient();
    client.bindProject('project-1', 'connection-1');
    const socket = FakeWebSocket.instances[0]!;
    socket.readyState = 0;

    client.subscribe('terminal-1', vi.fn(), vi.fn());
    const resized = client.resize('terminal-1', 100, 30);
    expect(socket.sent).toEqual([]);

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit('open');
    expect(socket.sent.map((value) => JSON.parse(value).type)).toEqual(['bind']);

    synchronize(socket);
    expect(socket.sent.map((value) => JSON.parse(value).type)).toEqual(['bind', 'observe']);
    acceptObservation(socket);
    expect(socket.sent.map((value) => JSON.parse(value).type)).toEqual([
      'bind', 'observe', 'resize'
    ]);

    acceptResize(socket, 1, 'terminal-1', 100, 30);
    await expect(resized).resolves.toEqual({
      session: { ...session(), cols: 100, rows: 30 }
    });
  });

  it('waits for Terminal observation before sending input', async () => {
    const { client, socket } = bindOpenClient();
    synchronize(socket);

    client.subscribe('terminal-1', vi.fn(), vi.fn());
    const written = client.writeInput('terminal-1', 'pwd\r');
    expect(frameTypes(socket)).toEqual(['bind', 'observe']);

    acceptObservation(socket);
    expect(frameTypes(socket)).toEqual(['bind', 'observe', 'input']);

    socket.emit('message', { type: 'input-ack', requestId: 1, terminalId: 'terminal-1', sequence: 1 });
    await expect(written).resolves.toEqual({ ok: true });
  });

  it('rejects current and later controls after Terminal observation fails', async () => {
    const { client, socket } = bindOpenClient();
    synchronize(socket);

    client.subscribe('terminal-1', vi.fn(), vi.fn());
    const rejections: string[] = [];
    void client.writeInput('terminal-1', 'pwd\r').catch((error: Error) => {
      rejections.push(error.message);
    });
    void client.resize('terminal-1', 100, 30).catch((error: Error) => {
      rejections.push(error.message);
    });

    socket.emit('message', {
      type: 'error',
      requestId: null,
      terminalId: 'terminal-1',
      code: 'terminal_not_found',
      message: 'Terminal not found: terminal-1'
    });
    await Promise.resolve();

    void client.writeInput('terminal-1', 'echo retry\r').catch((error: Error) => {
      rejections.push(error.message);
    });
    void client.resize('terminal-1', 120, 40).catch((error: Error) => {
      rejections.push(error.message);
    });
    await Promise.resolve();

    expect(rejections).toEqual([
      'Terminal not found: terminal-1',
      'Terminal not found: terminal-1',
      'Terminal not found: terminal-1',
      'Terminal not found: terminal-1'
    ]);
  });

  it('does not resend an in-flight resize when a Terminal is re-observed', async () => {
    const { client, socket } = bindOpenClient();
    synchronize(socket);

    const subscription = client.subscribe('terminal-1', vi.fn(), vi.fn());
    acceptObservation(socket);
    const resized = client.resize('terminal-1', 100, 30);
    subscription.close();
    client.subscribe('terminal-1', vi.fn(), vi.fn());
    acceptObservation(socket);
    expect(frameTypes(socket)).toEqual([
      'bind', 'observe', 'resize', 'unobserve', 'observe'
    ]);

    acceptResize(socket, 1, 'terminal-1', 100, 30);
    await expect(resized).resolves.toEqual({
      session: { ...session(), cols: 100, rows: 30 }
    });
  });

  it('correlates a control error without disturbing another Terminal', async () => {
    const { client, socket } = bindOpenClient();
    synchronize(socket, [session('terminal-1'), session('terminal-2')]);
    client.subscribe('terminal-1', vi.fn(), vi.fn());
    client.subscribe('terminal-2', vi.fn(), vi.fn());
    acceptObservation(socket, 'terminal-1');
    acceptObservation(socket, 'terminal-2');

    const written = client.writeInput('terminal-1', 'pwd\r');
    const secondWritten = client.writeInput('terminal-1', 'echo ready\r');
    const resized = client.resize('terminal-2', 100, 30);
    const [inputFrame, secondInputFrame, resizeFrame] = socket.sent
      .slice(-3)
      .map((value) => JSON.parse(value));
    expect(new Set([inputFrame.requestId, secondInputFrame.requestId, resizeFrame.requestId]).size).toBe(3);

    const inputFailure = vi.fn();
    const secondInputSettled = vi.fn();
    const resizeSettled = vi.fn();
    void written.catch((error: Error) => inputFailure(error.message));
    void secondWritten.then(secondInputSettled, secondInputSettled);
    void resized.then(resizeSettled, resizeSettled);

    socket.emit('message', {
      type: 'error',
      terminalId: 'terminal-1',
      requestId: inputFrame.requestId,
      code: 'terminal_not_found',
      message: 'Fixture input failed.'
    });
    await Promise.resolve();
    expect(inputFailure).toHaveBeenCalledWith('Fixture input failed.');
    expect(secondInputSettled).not.toHaveBeenCalled();
    expect(resizeSettled).not.toHaveBeenCalled();

    socket.emit('message', {
      type: 'input-ack',
      requestId: secondInputFrame.requestId,
      terminalId: 'terminal-1',
      sequence: 2
    });
    await expect(secondWritten).resolves.toEqual({ ok: true });
    socket.emit('message', {
      type: 'resized',
      requestId: resizeFrame.requestId,
      session: { ...session('terminal-2'), cols: 100, rows: 30 }
    });
    await expect(resized).resolves.toEqual({
      session: { ...session('terminal-2'), cols: 100, rows: 30 }
    });
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    client.dispose();
  });

  it('ignores control responses from a replaced Project socket', async () => {
    const { client, socket: replaced } = bindOpenClient();
    synchronize(replaced);
    client.subscribe('terminal-1', vi.fn(), vi.fn());
    acceptObservation(replaced);
    const replacedInput = client.writeInput('terminal-1', 'old');

    client.bindProject('project-2', 'connection-2');
    await expect(replacedInput).rejects.toThrow('binding was replaced');
    const current = FakeWebSocket.instances[1]!;
    current.emit('open');
    synchronize(current);
    acceptObservation(current);
    const currentInput = client.writeInput('terminal-1', 'new');
    const currentSettled = vi.fn();
    void currentInput.then(currentSettled, currentSettled);

    replaced.emit('message', {
      type: 'input-ack', requestId: 1, terminalId: 'terminal-1', sequence: 1
    });
    await Promise.resolve();
    expect(currentSettled).not.toHaveBeenCalled();

    current.emit('message', {
      type: 'input-ack', requestId: 1, terminalId: 'terminal-1', sequence: 1
    });
    await expect(currentInput).resolves.toEqual({ ok: true });
    client.dispose();
  });

  it('rejects pending input on loss and does not reconnect', async () => {
    const { client, socket } = bindOpenClient();
    const onError = vi.fn();
    client.subscribe('terminal-1', vi.fn(), onError);
    const pendingInput = client.writeInput('terminal-1', 'x');
    const inFlightResize = client.resize('terminal-1', 100, 30);
    const queuedResize = client.resize('terminal-1', 120, 40);
    socket.emit('close');
    await expect(pendingInput).rejects.toThrow('not replayed');
    await expect(inFlightResize).rejects.toThrow('not replayed');
    await expect(queuedResize).rejects.toThrow('not replayed');
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Terminal connection was lost.'
    }));
    expect(FakeWebSocket.instances).toHaveLength(1);
    client.dispose();
  });

  it('serializes rapid resizes and coalesces the latest pending dimensions', async () => {
    const { client, socket } = bindOpenClient();
    synchronize(socket);
    client.subscribe('terminal-1', vi.fn(), vi.fn());
    acceptObservation(socket);

    const first = client.resize('terminal-1', 100, 30);
    const second = client.resize('terminal-1', 110, 35);
    const third = client.resize('terminal-1', 120, 40);

    acceptResize(socket, 1, 'terminal-1', 100, 30);
    await expect(first).resolves.toEqual({ session: { ...session(), cols: 100, rows: 30 } });
    acceptResize(socket, 2, 'terminal-1', 120, 40);
    await expect(second).resolves.toEqual({ session: { ...session(), cols: 120, rows: 40 } });
    await expect(third).resolves.toEqual({ session: { ...session(), cols: 120, rows: 40 } });

    expect(socket.sent.slice(2).map((value) => JSON.parse(value))).toEqual([
      { type: 'resize', requestId: 1, terminalId: 'terminal-1', cols: 100, rows: 30 },
      { type: 'resize', requestId: 2, terminalId: 'terminal-1', cols: 120, rows: 40 }
    ]);
    client.dispose();
  });
});

function bindOpenClient() {
  const client = createTerminalHubClient();
  client.bindProject('project-1', 'connection-1');
  const socket = FakeWebSocket.instances[0]!;
  socket.emit('open');
  return { client, socket };
}

function synchronize(
  socket: FakeWebSocket,
  sessions: TerminalSessionView[] = [session()],
  topologyRevision = 1
): void {
  socket.emit('message', {
    type: 'sync',
    protocolVersion: 1,
    topologyRevision,
    sessions
  });
}

function acceptObservation(socket: FakeWebSocket, terminalId = 'terminal-1'): void {
  socket.emit('message', {
    type: 'observed',
    session: session(terminalId),
    checkpoint: checkpoint(terminalId)
  });
}

function acceptResize(
  socket: FakeWebSocket,
  requestId: number,
  terminalId: string,
  cols: number,
  rows: number
): void {
  socket.emit('message', {
    type: 'resized',
    requestId,
    session: { ...session(terminalId), cols, rows }
  });
}

function frameTypes(socket: FakeWebSocket): string[] {
  return socket.sent.map((value) => JSON.parse(value).type as string);
}

function session(id = 'terminal-1') {
  return {
    id, title: 'Terminal', cwdProjectRelativePath: '', cols: 80, rows: 24,
    status: 'running' as const, exitCode: null, signal: null, createdAt: 'now', updatedAt: 'now'
  };
}

function checkpoint(terminalId: string) {
  return {
    terminalId,
    outputSequence: 0,
    cols: 80,
    rows: 24,
    scrollbackRows: 0,
    cursorRow: 0,
    cursorCol: 0,
    cursorHidden: false,
    alternateScreen: false,
    applicationCursor: false,
    applicationKeypad: false,
    bracketedPaste: false,
    title: 'Terminal',
    ansiBase64: ''
  };
}
