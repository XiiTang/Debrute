import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    socket.emit('message', {
      type: 'sync',
      protocolVersion: 1,
      topologyRevision: 1,
      sessions: [session()],
      checkpoints: [{
        version: 1,
        terminalId: 'terminal-1',
        outputSequence: 4,
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
        ansiBase64: btoa('ready\r\n')
      }]
    });
    expect(events).toContainEqual({
      type: 'replay',
      terminalId: 'terminal-1',
      chunks: [{ sequence: 4, data: 'ready\r\n' }],
      lastSequence: 4
    });

    const written = client.writeInput('terminal-1', 'pwd\r');
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      type: 'input', terminalId: 'terminal-1', sequence: 1, data: 'pwd\r'
    });
    socket.emit('message', { type: 'input-ack', terminalId: 'terminal-1', sequence: 1 });
    await expect(written).resolves.toEqual({ ok: true });
  });

  it('rejects pending input on loss and does not reconnect', async () => {
    const client = createTerminalHubClient();
    client.bindProject('project-1', 'connection-1');
    const socket = FakeWebSocket.instances[0]!;
    socket.emit('open');
    const onError = vi.fn();
    client.subscribe('terminal-1', vi.fn(), onError);
    const pending = client.writeInput('terminal-1', 'x');
    socket.emit('close');
    await expect(pending).rejects.toThrow('not replayed');
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Terminal connection was lost.'
    }));
    expect(FakeWebSocket.instances).toHaveLength(1);
    client.dispose();
  });
});

function session() {
  return {
    id: 'terminal-1', title: 'Terminal', cwdProjectRelativePath: '', cols: 80, rows: 24,
    status: 'running' as const, exitCode: null, signal: null, createdAt: 'now', updatedAt: 'now'
  };
}
