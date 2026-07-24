import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { posix, win32 } from 'node:path';
import { TextDecoder } from 'node:util';

import {
  CONTROL_OUTBOUND_QUEUE_CAPACITY,
  CONTROL_PROTOCOL,
  CONTROL_PROTOCOL_VERSION,
  MAX_CONTROL_FRAME_BYTES,
  type ActivationIntent,
  type ClientMessage,
  type ClientRole,
  type ControlEvent,
  type ControlRequest,
  type ControlResponse,
  type RuntimeStatus,
  type ServerMessage
} from '@debrute/app-protocol';

export type RuntimeControlErrorCode =
  | 'client_closed'
  | 'handshake_rejected'
  | 'protocol_error'
  | 'runtime_lost'
  | 'runtime_ready_timeout'
  | 'runtime_transitioning'
  | 'runtime_unavailable';

export class RuntimeControlError extends Error {
  readonly code: RuntimeControlErrorCode;

  constructor(code: RuntimeControlErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RuntimeControlError';
    this.code = code;
  }
}

export interface ConnectRuntimeControlOptions {
  role: ClientRole;
  productVersion: string;
  readyDeadlineMs: number;
  socketPath?: string;
  platform?: NodeJS.Platform;
  temporaryDirectory?: string;
}

export interface RuntimeControlEndpointOptions {
  platform?: NodeJS.Platform;
  temporaryDirectory?: string;
  windowsUserSid?: string;
  windowsDirectory?: string;
}

export interface RuntimeControlClient {
  readonly instanceId: string;
  readonly status: RuntimeStatus;
  readonly role: ClientRole;
  waitUntilReady(): Promise<void>;
  inspect(): Promise<ControlResponse>;
  activate(intent: ActivationIntent): Promise<ControlResponse>;
  createCliAuthorization(): Promise<ControlResponse>;
  registerDevWorkbenchOrigin(origin: string): Promise<ControlResponse>;
  createDesktopLaunchTicket(windowKey: string): Promise<ControlResponse>;
  desktopWindowClosed(windowKey: string): Promise<ControlResponse>;
  quitProduct(): Promise<ControlResponse>;
  onEvent(listener: (event: ControlEvent) => void): () => void;
  onRuntimeLost(listener: (error: RuntimeControlError) => void): () => void;
  close(): void;
}

export async function connectRuntimeControl(
  options: ConnectRuntimeControlOptions
): Promise<RuntimeControlClient> {
  const socketPath = options.socketPath ?? resolveRuntimeControlSocketPath(options);
  const socket = createConnection(socketPath);
  const client = new NodeRuntimeControlClient(
    socket,
    options.role,
    options.productVersion,
    options.readyDeadlineMs
  );
  return await client.connect();
}

export function resolveRuntimeControlSocketPath(
  input: RuntimeControlEndpointOptions = {}
): string {
  const platform = input.platform ?? process.platform;
  if (platform === 'darwin') {
    return posix.join(input.temporaryDirectory ?? tmpdir(), 'debrute', 'control.sock');
  }
  if (platform === 'win32') {
    const sid = input.windowsUserSid ?? readWindowsUserSid(input.windowsDirectory);
    if (!/^S-\d+(?:-\d+)+$/.test(sid)) {
      throw new RuntimeControlError(
        'runtime_unavailable',
        'Windows returned an invalid current-user SID'
      );
    }
    return `\\\\.\\pipe\\debrute-control-${sid}`;
  }
  throw new RuntimeControlError(
    'runtime_unavailable',
    `Runtime Control endpoint is not implemented for ${platform}`
  );
}

function readWindowsUserSid(windowsDirectory?: string): string {
  const root = windowsDirectory ?? process.env.SystemRoot;
  if (!root) {
    throw new RuntimeControlError(
      'runtime_unavailable',
      'Windows system directory is unavailable'
    );
  }
  let output: string;
  try {
    output = execFileSync(
      win32.join(root, 'System32', 'whoami.exe'),
      ['/user', '/fo', 'csv', '/nh'],
      { encoding: 'utf8', windowsHide: true }
    );
  } catch (error) {
    throw new RuntimeControlError(
      'runtime_unavailable',
      'Windows current-user SID lookup failed',
      { cause: error }
    );
  }
  const sid = output.match(/S-\d+(?:-\d+)+/)?.[0];
  if (!sid) {
    throw new RuntimeControlError(
      'runtime_unavailable',
      'Windows current-user SID lookup returned no SID'
    );
  }
  return sid;
}

class NodeRuntimeControlClient implements RuntimeControlClient {
  readonly role: ClientRole;
  instanceId = '';
  status: RuntimeStatus = 'starting';

  private readonly socket: Socket;
  private readonly productVersion: string;
  private readonly eventListeners = new Set<(event: ControlEvent) => void>();
  private readonly runtimeLostListeners = new Set<(error: RuntimeControlError) => void>();
  private readonly pending = new Map<string, Deferred<ControlResponse>>();
  private readonly handshake = deferred<RuntimeControlClient>();
  private buffered = Buffer.alloc(0);
  private writeChain = Promise.resolve();
  private queuedWrites = 0;
  private connected = false;
  private handshakeAccepted = false;
  private explicitlyClosed = false;
  private terminalError: RuntimeControlError | undefined;
  private readyDeadlineTimer: NodeJS.Timeout | undefined;
  private readonly readyDeadlineMs: number;
  private readyObserved = false;

  constructor(
    socket: Socket,
    role: ClientRole,
    productVersion: string,
    readyDeadlineMs: number
  ) {
    this.socket = socket;
    this.role = role;
    this.productVersion = productVersion;
    this.readyDeadlineMs = readyDeadlineMs;
    const remaining = Math.max(0, readyDeadlineMs - Date.now());
    this.readyDeadlineTimer = setTimeout(() => {
      this.fail(runtimeReadyTimeout());
    }, remaining);
    this.socket.setTimeout(remaining);
  }

  async connect(): Promise<RuntimeControlClient> {
    this.socket.on('data', (chunk: Buffer) => this.receive(chunk));
    this.socket.once('connect', () => {
      this.connected = true;
      void this.enqueue({
        type: 'handshake',
        protocol: CONTROL_PROTOCOL,
        protocol_version: CONTROL_PROTOCOL_VERSION,
        product_version: this.productVersion,
        role: this.role
      }).catch((error: unknown) => this.fail(asRuntimeLost(error)));
    });
    this.socket.once('timeout', () => {
      this.fail(new RuntimeControlError(
        'runtime_ready_timeout',
        'Runtime did not become Ready before the absolute deadline'
      ));
    });
    this.socket.on('error', (error) => this.fail(asRuntimeLost(error, this.connected)));
    this.socket.once('close', () => {
      if (!this.explicitlyClosed) {
        this.fail(new RuntimeControlError('runtime_lost', 'Runtime Control connection was lost'));
      }
    });
    return await this.handshake.promise;
  }

  async waitUntilReady(): Promise<void> {
    this.throwIfTerminal();
    this.throwIfReadyDeadlineExpired();
    while (this.status === 'starting') {
      const response = await this.request({ command: 'inspect' }, false);
      this.throwIfReadyDeadlineExpired();
      if (response.result !== 'inspection') {
        throw new RuntimeControlError('protocol_error', 'Runtime returned an invalid inspection response');
      }
      this.status = response.status;
      if (this.status === 'starting') {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (this.status !== 'ready') {
      this.finishReadyWait();
      throw new RuntimeControlError(
        'runtime_transitioning',
        `Runtime is stopping: ${this.status}`
      );
    }
    this.readyObserved = true;
    this.finishReadyWait();
  }

  async inspect(): Promise<ControlResponse> {
    return await this.request({ command: 'inspect' }, false);
  }

  async activate(intent: ActivationIntent): Promise<ControlResponse> {
    return await this.request({ command: 'activate', intent }, true);
  }

  async createCliAuthorization(): Promise<ControlResponse> {
    return await this.request({ command: 'create_cli_authorization' }, true);
  }

  async registerDevWorkbenchOrigin(origin: string): Promise<ControlResponse> {
    return await this.request({ command: 'register_dev_workbench_origin', origin }, true);
  }

  async createDesktopLaunchTicket(windowKey: string): Promise<ControlResponse> {
    return await this.request({ command: 'create_desktop_launch_ticket', window_key: windowKey }, true);
  }

  async desktopWindowClosed(windowKey: string): Promise<ControlResponse> {
    return await this.request({ command: 'desktop_window_closed', window_key: windowKey }, false);
  }

  async quitProduct(): Promise<ControlResponse> {
    return await this.request({ command: 'quit_product' }, false);
  }

  onEvent(listener: (event: ControlEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onRuntimeLost(listener: (error: RuntimeControlError) => void): () => void {
    this.runtimeLostListeners.add(listener);
    return () => this.runtimeLostListeners.delete(listener);
  }

  close(): void {
    if (this.explicitlyClosed) {
      return;
    }
    this.explicitlyClosed = true;
    if (!this.terminalError) {
      const error = new RuntimeControlError('client_closed', 'Runtime Control client was closed');
      this.terminalError = error;
      this.rejectPending(error);
    }
    this.finishReadyWait();
    this.socket.destroy();
  }

  private async request(request: ControlRequest, requiresReady: boolean): Promise<ControlResponse> {
    this.throwIfTerminal();
    if (requiresReady) {
      await this.waitUntilReady();
      this.throwIfReadyDeadlineExpired();
    }
    const requestId = randomUUID();
    const response = deferred<ControlResponse>();
    void response.promise.catch(() => undefined);
    this.pending.set(requestId, response);
    try {
      await this.enqueue({ type: 'request', request_id: requestId, request });
    } catch (error) {
      this.pending.delete(requestId);
      throw error;
    }
    return await response.promise;
  }

  private enqueue(message: ClientMessage): Promise<void> {
    if (this.queuedWrites >= CONTROL_OUTBOUND_QUEUE_CAPACITY) {
      const error = new RuntimeControlError('runtime_lost', 'Runtime Control outbound queue is full');
      this.fail(error);
      return Promise.reject(error);
    }
    this.queuedWrites += 1;
    const write = this.writeChain.then(async () => {
      this.throwIfTerminal();
      const payload = Buffer.from(JSON.stringify(message), 'utf8');
      if (payload.length > MAX_CONTROL_FRAME_BYTES) {
        throw new RuntimeControlError('protocol_error', 'Runtime Control payload is too large');
      }
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(payload.length);
      await writeSocket(this.socket, Buffer.concat([header, payload]));
    }).catch((error: unknown) => {
      const terminalError = asRuntimeLost(error);
      this.fail(terminalError);
      throw terminalError;
    }).finally(() => {
      this.queuedWrites -= 1;
    });
    this.writeChain = write.catch(() => undefined);
    return write;
  }

  private receive(chunk: Buffer): void {
    if (this.terminalError) {
      return;
    }
    this.buffered = Buffer.concat([this.buffered, chunk]);
    while (this.buffered.length >= 4) {
      const length = this.buffered.readUInt32BE(0);
      if (length === 0 || length > MAX_CONTROL_FRAME_BYTES) {
        this.fail(new RuntimeControlError('protocol_error', 'Runtime sent an invalid frame length'));
        return;
      }
      if (this.buffered.length < length + 4) {
        return;
      }
      const payload = this.buffered.subarray(4, length + 4);
      this.buffered = this.buffered.subarray(length + 4);
      try {
        const json = new TextDecoder('utf-8', { fatal: true }).decode(payload);
        this.handleMessage(JSON.parse(json) as ServerMessage);
      } catch (error) {
        this.fail(new RuntimeControlError(
          'protocol_error',
          'Runtime sent invalid UTF-8 or JSON',
          { cause: error }
        ));
        return;
      }
      if (this.terminalError) {
        return;
      }
    }
  }

  private handleMessage(message: ServerMessage): void {
    if (!this.handshakeAccepted) {
      this.handleHandshake(message);
      return;
    }
    if (message.type === 'event') {
      if (message.event.event === 'product_exiting') {
        this.status = 'exiting';
      } else if (message.event.event === 'product_replacing') {
        this.status = 'replacing';
      }
      for (const listener of this.eventListeners) {
        listener(message.event);
      }
      return;
    }
    if (message.type === 'response') {
      const pending = this.pending.get(message.request_id);
      if (!pending) {
        this.fail(new RuntimeControlError('protocol_error', 'Runtime sent an unknown response id'));
        return;
      }
      this.pending.delete(message.request_id);
      pending.resolve(message.response);
      return;
    }
    this.fail(new RuntimeControlError('protocol_error', 'Runtime repeated the handshake'));
  }

  private handleHandshake(message: ServerMessage): void {
    if (Date.now() >= this.readyDeadlineMs) {
      this.fail(runtimeReadyTimeout());
      return;
    }
    if (message.type === 'handshake_rejected') {
      this.fail(new RuntimeControlError(
        'handshake_rejected',
        `Runtime rejected the Control handshake: ${message.reason}`
      ));
      return;
    }
    if (message.type !== 'handshake_accepted') {
      this.fail(new RuntimeControlError('protocol_error', 'Runtime sent a product message before handshake acceptance'));
      return;
    }
    if (
      message.protocol_version !== CONTROL_PROTOCOL_VERSION
      || message.product_version !== this.productVersion
    ) {
      this.fail(new RuntimeControlError('handshake_rejected', 'Runtime Control version is incompatible'));
      return;
    }
    this.handshakeAccepted = true;
    this.instanceId = message.instance_id;
    this.status = message.status;
    if (this.status === 'ready') {
      this.readyObserved = true;
      this.finishReadyWait();
    }
    this.handshake.resolve(this);
  }

  private fail(error: RuntimeControlError): void {
    if (this.terminalError) {
      return;
    }
    this.terminalError = error;
    this.finishReadyWait();
    this.handshake.reject(error);
    this.rejectPending(error);
    if (this.handshakeAccepted && error.code === 'runtime_lost') {
      for (const listener of this.runtimeLostListeners) {
        listener(error);
      }
    }
    this.socket.destroy();
  }

  private finishReadyWait(): void {
    if (this.readyDeadlineTimer) {
      clearTimeout(this.readyDeadlineTimer);
      this.readyDeadlineTimer = undefined;
    }
    this.socket.setTimeout(0);
  }

  private rejectPending(error: RuntimeControlError): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private throwIfTerminal(): void {
    if (this.terminalError) {
      throw this.terminalError;
    }
  }

  private throwIfReadyDeadlineExpired(): void {
    if (this.readyObserved || Date.now() < this.readyDeadlineMs) {
      return;
    }
    const error = runtimeReadyTimeout();
    this.fail(error);
    throw error;
  }
}

function runtimeReadyTimeout(): RuntimeControlError {
  return new RuntimeControlError(
    'runtime_ready_timeout',
    'Runtime did not become Ready before the absolute deadline'
  );
}

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: unknown): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function writeSocket(socket: Socket, frame: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(frame, (error) => error ? reject(error) : resolve());
  });
}

function asRuntimeLost(error: unknown, connected = true): RuntimeControlError {
  return new RuntimeControlError(
    connected ? 'runtime_lost' : 'runtime_unavailable',
    connected ? 'Runtime Control connection was lost' : 'Runtime Control endpoint is unavailable',
    { cause: error }
  );
}
