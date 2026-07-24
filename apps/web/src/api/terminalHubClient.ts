import type {
  TerminalCheckpoint,
  TerminalEvent,
  TerminalEventSubscription,
  TerminalServerFrame,
  TerminalSessionResult,
  TerminalSessionView
} from '@debrute/app-protocol';

const TERMINAL_PROTOCOL_VERSION = 1;

export interface TerminalHubClient {
  bindProject(projectId: string, connectionCredential: string): void;
  unbindProject(): void;
  writeInput(terminalId: string, data: string): Promise<{ ok: true }>;
  resize(terminalId: string, cols: number, rows: number): Promise<TerminalSessionResult>;
  subscribe(
    terminalId: string,
    listener: (event: TerminalEvent) => void,
    onError?: (error: Error) => void
  ): TerminalEventSubscription;
  dispose(): void;
}

export function createTerminalHubClient(input: {
  WebSocket?: typeof WebSocket;
  origin?: string;
} = {}): TerminalHubClient {
  const WebSocketImpl = input.WebSocket ?? WebSocket;
  const origin = input.origin ?? globalThis.location?.origin ?? 'http://debrute.local';
  let binding: { projectId: string; connectionCredential: string } | undefined;
  let socket: WebSocket | undefined;
  let disposed = false;
  const listeners = new Map<string, Set<(event: TerminalEvent) => void>>();
  const errorListeners = new Map<string, Set<(error: Error) => void>>();
  const sessions = new Map<string, TerminalSessionView>();
  const checkpoints = new Map<string, TerminalCheckpoint>();
  const inputSequences = new Map<string, number>();
  const inputAcks = new Map<string, { resolve(value: { ok: true }): void; reject(error: Error): void }>();
  const resizeAcks = new Map<string, { resolve(value: TerminalSessionResult): void; reject(error: Error): void }>();

  const notify = (terminalId: string, event: TerminalEvent) => {
    for (const listener of listeners.get(terminalId) ?? []) {
      listener(event);
    }
  };
  const failTerminal = (terminalId: string, error: Error) => {
    for (const listener of errorListeners.get(terminalId) ?? []) {
      listener(error);
    }
  };
  const rejectPending = (message: string) => {
    const error = new Error(message);
    for (const pending of inputAcks.values()) {
      pending.reject(error);
    }
    for (const pending of resizeAcks.values()) {
      pending.reject(error);
    }
    inputAcks.clear();
    resizeAcks.clear();
  };
  const connect = () => {
    if (disposed || !binding || socket) {
      return;
    }
    const url = new URL(`/api/projects/${encodeURIComponent(binding.projectId)}/terminals/ws`, origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const next = new WebSocketImpl(url.toString());
    socket = next;
    next.addEventListener('open', () => {
      if (!binding || socket !== next) {
        next.close();
        return;
      }
      next.send(JSON.stringify({
        type: 'bind',
        protocolVersion: TERMINAL_PROTOCOL_VERSION,
        connectionCredential: binding.connectionCredential
      }));
    });
    next.addEventListener('message', (event) => {
      try {
        handleFrame(JSON.parse(String(event.data)) as TerminalServerFrame);
      } catch (error) {
        rejectPending(error instanceof Error ? error.message : String(error));
        next.close();
      }
    });
    next.addEventListener('close', () => {
      if (socket !== next) {
        return;
      }
      socket = undefined;
      rejectPending('Terminal connection was lost; pending input was not replayed.');
      for (const terminalId of listeners.keys()) {
        failTerminal(terminalId, new Error('Terminal connection was lost.'));
      }
    });
    next.addEventListener('error', () => {
      for (const terminalId of listeners.keys()) {
        failTerminal(terminalId, new Error('Terminal connection failed.'));
      }
    });
  };
  const send = (frame: object) => {
    if (!socket || socket.readyState !== WebSocketImpl.OPEN) {
      throw new Error('Terminal connection is not ready.');
    }
    socket.send(JSON.stringify(frame));
  };
  const emitCheckpoint = (checkpoint: TerminalCheckpoint) => {
    checkpoints.set(checkpoint.terminalId, checkpoint);
    notify(checkpoint.terminalId, {
      type: 'replay',
      terminalId: checkpoint.terminalId,
      chunks: [{ sequence: checkpoint.outputSequence, data: decodeBase64Text(checkpoint.ansiBase64) }],
      lastSequence: checkpoint.outputSequence
    });
  };
  const handleFrame = (frame: TerminalServerFrame) => {
    if (frame.type === 'sync') {
      if (frame.protocolVersion !== TERMINAL_PROTOCOL_VERSION) {
        throw new Error(`Unsupported Terminal protocol ${frame.protocolVersion}.`);
      }
      sessions.clear();
      frame.sessions.forEach((session) => sessions.set(session.id, session));
      frame.checkpoints.forEach(emitCheckpoint);
      return;
    }
    if (frame.type === 'observed') {
      emitCheckpoint(frame.checkpoint);
      return;
    }
    if (frame.type === 'topology') {
      sessions.clear();
      frame.sessions.forEach((session) => sessions.set(session.id, session));
      return;
    }
    if (frame.type === 'input-ack') {
      const key = `${frame.terminalId}:${frame.sequence}`;
      inputAcks.get(key)?.resolve({ ok: true });
      inputAcks.delete(key);
      return;
    }
    if (frame.type === 'resized') {
      const current = sessions.get(frame.terminalId);
      const pending = resizeAcks.get(frame.terminalId);
      if (pending && current) {
        const session = { ...current, cols: frame.cols, rows: frame.rows };
        sessions.set(frame.terminalId, session);
        pending.resolve({ session });
      } else if (pending) {
        pending.reject(new Error(`Terminal session is unavailable: ${frame.terminalId}`));
      }
      resizeAcks.delete(frame.terminalId);
      return;
    }
    if (frame.type === 'output') {
      notify(frame.terminalId, {
        type: 'data',
        terminalId: frame.terminalId,
        sequence: frame.sequence,
        data: decodeBase64Text(frame.dataBase64)
      });
      return;
    }
    if (frame.type === 'status') {
      sessions.set(frame.session.id, frame.session);
      notify(frame.session.id, { type: 'status', terminalId: frame.session.id, session: frame.session });
      return;
    }
    if (frame.type === 'exit') {
      notify(frame.terminalId, { ...frame, type: 'exit' });
      return;
    }
    const error = new Error(frame.message);
    if (frame.terminalId) {
      notify(frame.terminalId, { type: 'error', terminalId: frame.terminalId, code: frame.code, message: frame.message });
      failTerminal(frame.terminalId, error);
    }
  };

  return {
    bindProject(projectId, connectionCredential) {
      binding = { projectId, connectionCredential };
      socket?.close();
      socket = undefined;
      sessions.clear();
      checkpoints.clear();
      inputSequences.clear();
      connect();
    },
    unbindProject() {
      binding = undefined;
      socket?.close();
      socket = undefined;
      rejectPending('Terminal Project binding was released.');
      sessions.clear();
      checkpoints.clear();
      inputSequences.clear();
    },
    writeInput(terminalId, data) {
      const sequence = (inputSequences.get(terminalId) ?? 0) + 1;
      inputSequences.set(terminalId, sequence);
      return new Promise((resolve, reject) => {
        const key = `${terminalId}:${sequence}`;
        inputAcks.set(key, { resolve, reject });
        try {
          send({ type: 'input', terminalId, sequence, data });
        } catch (error) {
          inputAcks.delete(key);
          reject(error);
        }
      });
    },
    resize(terminalId, cols, rows) {
      return new Promise((resolve, reject) => {
        resizeAcks.get(terminalId)?.reject(new Error('Terminal resize was superseded.'));
        resizeAcks.set(terminalId, { resolve, reject });
        try {
          send({ type: 'resize', terminalId, cols, rows });
        } catch (error) {
          resizeAcks.delete(terminalId);
          reject(error);
        }
      });
    },
    subscribe(terminalId, listener, onError) {
      const terminalListeners = listeners.get(terminalId) ?? new Set();
      const wasEmpty = terminalListeners.size === 0;
      terminalListeners.add(listener);
      listeners.set(terminalId, terminalListeners);
      if (onError) {
        const current = errorListeners.get(terminalId) ?? new Set();
        current.add(onError);
        errorListeners.set(terminalId, current);
      }
      const checkpoint = checkpoints.get(terminalId);
      if (checkpoint) {
        emitCheckpoint(checkpoint);
      } else if (wasEmpty && socket?.readyState === WebSocketImpl.OPEN) {
        send({ type: 'observe', terminalId });
      }
      return {
        close() {
          listeners.get(terminalId)?.delete(listener);
          if (onError) {
            errorListeners.get(terminalId)?.delete(onError);
          }
          if (listeners.get(terminalId)?.size === 0) {
            listeners.delete(terminalId);
            errorListeners.delete(terminalId);
            if (socket?.readyState === WebSocketImpl.OPEN) {
              send({ type: 'unobserve', terminalId });
            }
          }
        }
      };
    },
    dispose() {
      disposed = true;
      binding = undefined;
      socket?.close();
      socket = undefined;
      rejectPending('Terminal client was disposed.');
      listeners.clear();
      errorListeners.clear();
      inputSequences.clear();
    }
  };
}

function decodeBase64Text(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
