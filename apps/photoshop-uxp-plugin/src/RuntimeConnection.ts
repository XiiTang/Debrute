import {
  PHOTOSHOP_MAX_FILE_BYTES,
  PHOTOSHOP_PORTS,
  PHOTOSHOP_WEBSOCKET_SUBPROTOCOL,
  decodePhotoshopHttpErrorEnvelope,
  parseRuntimeMessage,
  serializePluginMessage,
  type PhotoshopDocumentSnapshot,
  type PhotoshopMimeType,
  type PluginMessage,
  type RuntimeMessage
} from '@debrute/app-protocol';

const CONNECTION_ROUND_TIMEOUT_MS = 5_000;
const CONNECTION_CANDIDATE_TIMEOUT_MS = 500;
const DISCONNECTED_RETRY_MS = 5_000;
const BYTE_TIMEOUT_MS = 5 * 60_000;

export type RuntimeConnectionState =
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | {
      status: 'ready';
      runtimeInstanceId: string;
      pluginSessionId: string;
    };

export interface PhotoshopSocket {
  protocol: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(value: string): void;
  close(): void;
}

interface RuntimeConnectionOptions {
  hostVersion(): string;
  placementMimeTypes(): PhotoshopMimeType[];
  documents(): PhotoshopDocumentSnapshot[];
  createSocket?(url: string, protocol: string): PhotoshopSocket;
  request?(url: string, init?: RequestInit): Promise<Response>;
  schedule?(callback: () => void, delay: number): unknown;
  cancelSchedule?(handle: unknown): void;
  onState(state: RuntimeConnectionState): void;
  onMessage(
    session: RuntimeSessionLease,
    message: Exclude<RuntimeMessage, { type: 'photoshop.session.ready' }>
  ): void;
}

export interface RuntimeSessionLease {
  readonly pluginSessionId: string;
  isLive(): boolean;
  send(message: PluginMessage): void;
  downloadCommandContent(commandId: string, expectedBytes: number): Promise<ArrayBuffer>;
  uploadExportItem(
    commandId: string,
    itemId: string,
    bytes: Uint8Array
  ): Promise<{ fileName: string }>;
}

export class RuntimeTransferRejectedError extends Error {}

export class RuntimeSessionLostError extends Error {
  constructor() {
    super('Photoshop Runtime session was lost.');
    this.name = 'RuntimeSessionLostError';
  }
}

export class RuntimeUploadOutcomeUnknownError extends Error {
  constructor(cause?: unknown) {
    super('Photoshop export item may have been saved, but Runtime confirmation was lost.', {
      cause
    });
    this.name = 'RuntimeUploadOutcomeUnknownError';
  }
}

export class RuntimeConnection {
  private readonly createSocket: (url: string, protocol: string) => PhotoshopSocket;
  private readonly request: (url: string, init?: RequestInit) => Promise<Response>;
  private readonly schedule: (callback: () => void, delay: number) => unknown;
  private readonly cancelSchedule: (handle: unknown) => void;
  private state: RuntimeConnectionState = { status: 'disconnected' };
  private stopped = true;
  private roundActive = false;
  private candidateIndex = 0;
  private candidate: PhotoshopSocket | undefined;
  private activeSocket: PhotoshopSocket | undefined;
  private roundDeadline: unknown;
  private candidateDeadline: unknown;
  private retrySchedule: unknown;
  private activeSession: RuntimeSessionLeaseImpl | undefined;
  private immediateReconnect = false;

  constructor(private readonly options: RuntimeConnectionOptions) {
    this.createSocket = options.createSocket ?? createBrowserSocket;
    this.request = options.request ?? ((url, init) => fetch(url, init));
    this.schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
    this.cancelSchedule = options.cancelSchedule ?? ((handle) => clearTimeout(handle as number));
  }

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.startRound();
  }

  stop(): void {
    this.stopped = true;
    this.roundActive = false;
    this.clearRoundDeadline();
    this.clearCandidateDeadline();
    this.clearRetrySchedule();
    const candidate = this.candidate;
    const active = this.activeSocket;
    this.candidate = undefined;
    this.activeSocket = undefined;
    candidate?.close();
    if (active !== candidate) {
      active?.close();
    }
    this.revokeActiveSession();
    this.publish({ status: 'disconnected' });
  }

  requireSession(): RuntimeSessionLease {
    if (!this.activeSession?.isLive() || this.state.status !== 'ready') {
      throw new Error('Photoshop Runtime session is not ready.');
    }
    return this.activeSession;
  }

  private startRound(): void {
    if (this.stopped || this.roundActive || this.activeSocket) {
      return;
    }
    this.roundActive = true;
    this.candidateIndex = 0;
    this.publish({ status: 'connecting' });
    this.roundDeadline = this.schedule(() => this.finishRound(), CONNECTION_ROUND_TIMEOUT_MS);
    this.probeNext();
  }

  private probeNext(): void {
    if (!this.roundActive || this.stopped) {
      return;
    }
    const port = PHOTOSHOP_PORTS[this.candidateIndex];
    if (port === undefined) {
      this.finishRound();
      return;
    }
    this.candidateIndex += 1;
    let socket: PhotoshopSocket;
    try {
      socket = this.createSocket(
        `ws://127.0.0.1:${port}/photoshop/session`,
        PHOTOSHOP_WEBSOCKET_SUBPROTOCOL
      );
    } catch {
      this.probeNext();
      return;
    }
    this.candidate = socket;
    let settled = false;
    const rejectCandidate = () => {
      if (settled || this.candidate !== socket || !this.roundActive) {
        return;
      }
      settled = true;
      this.clearCandidateDeadline();
      this.candidate = undefined;
      socket.close();
      this.probeNext();
    };
    this.candidateDeadline = this.schedule(
      rejectCandidate,
      CONNECTION_CANDIDATE_TIMEOUT_MS
    );
    socket.onopen = () => {
      // Photoshop UXP emits `open` one task before its WebSocket permits `send`.
      // Deferring the session start also remains valid in browser implementations.
      this.schedule(() => {
        if (settled || this.candidate !== socket || !this.roundActive) return;
        if (socket.protocol !== PHOTOSHOP_WEBSOCKET_SUBPROTOCOL) {
          rejectCandidate();
          return;
        }
        try {
          socket.send(serializePluginMessage({
            type: 'photoshop.session.start',
            hostVersion: this.options.hostVersion(),
            placementMimeTypes: this.options.placementMimeTypes(),
            documents: this.options.documents()
          }));
        } catch {
          rejectCandidate();
        }
      }, 0);
    };
    socket.onerror = rejectCandidate;
    socket.onclose = rejectCandidate;
    socket.onmessage = (event) => {
      if (settled || this.candidate !== socket || typeof event.data !== 'string') {
        rejectCandidate();
        return;
      }
      let message: RuntimeMessage;
      try {
        message = parseRuntimeMessage(event.data);
      } catch {
        rejectCandidate();
        return;
      }
      if (message.type !== 'photoshop.session.ready') {
        rejectCandidate();
        return;
      }
      settled = true;
      this.clearCandidateDeadline();
      this.acceptSession(socket, port, message);
    };
  }

  private acceptSession(
    socket: PhotoshopSocket,
    port: number,
    message: Extract<RuntimeMessage, { type: 'photoshop.session.ready' }>
  ): void {
    this.clearRoundDeadline();
    this.clearCandidateDeadline();
    this.roundActive = false;
    this.candidate = undefined;
    this.activeSocket = socket;
    const session = new RuntimeSessionLeaseImpl({
      pluginSessionId: message.pluginSessionId,
      socket,
      httpOrigin: `http://127.0.0.1:${port}`,
      bearer: message.bearer,
      request: this.request,
      schedule: this.schedule,
      cancelSchedule: this.cancelSchedule,
      retire: () => {
        socket.close();
        this.handleSessionLoss(socket);
      }
    });
    this.activeSession = session;
    this.publish({
      status: 'ready',
      runtimeInstanceId: message.runtimeInstanceId,
      pluginSessionId: message.pluginSessionId
    });
    socket.onerror = () => this.handleSessionLoss(socket);
    socket.onclose = () => this.handleSessionLoss(socket);
    socket.onmessage = (event) => this.handleSessionMessage(socket, event.data);
  }

  private handleSessionMessage(socket: PhotoshopSocket, data: unknown): void {
    if (this.activeSocket !== socket || typeof data !== 'string') {
      this.closeInvalidSession(socket);
      return;
    }
    let message: RuntimeMessage;
    try {
      message = parseRuntimeMessage(data);
    } catch {
      this.closeInvalidSession(socket);
      return;
    }
    if (message.type === 'photoshop.session.ready') {
      this.closeInvalidSession(socket);
      return;
    }
    const session = this.activeSession;
    if (!session?.isLive()) {
      this.closeInvalidSession(socket);
      return;
    }
    this.options.onMessage(session, message);
    if (message.type === 'runtime.replacing') {
      this.immediateReconnect = true;
      socket.close();
    }
  }

  private closeInvalidSession(socket: PhotoshopSocket): void {
    if (this.activeSocket === socket) {
      this.immediateReconnect = false;
    }
    socket.close();
    this.handleSessionLoss(socket);
  }

  private handleSessionLoss(socket: PhotoshopSocket): void {
    if (this.activeSocket !== socket) {
      return;
    }
    this.activeSocket = undefined;
    this.revokeActiveSession();
    this.publish({ status: 'disconnected' });
    const immediate = this.immediateReconnect;
    this.immediateReconnect = false;
    if (immediate) {
      this.startRound();
    } else {
      this.scheduleRetry();
    }
  }

  private finishRound(): void {
    if (!this.roundActive) {
      return;
    }
    this.clearRoundDeadline();
    this.clearCandidateDeadline();
    this.roundActive = false;
    const candidate = this.candidate;
    this.candidate = undefined;
    candidate?.close();
    this.publish({ status: 'disconnected' });
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retrySchedule !== undefined || this.activeSocket) {
      return;
    }
    this.retrySchedule = this.schedule(() => {
      this.retrySchedule = undefined;
      this.startRound();
    }, DISCONNECTED_RETRY_MS);
  }

  private clearRoundDeadline(): void {
    if (this.roundDeadline === undefined) {
      return;
    }
    this.cancelSchedule(this.roundDeadline);
    this.roundDeadline = undefined;
  }

  private clearCandidateDeadline(): void {
    if (this.candidateDeadline === undefined) {
      return;
    }
    this.cancelSchedule(this.candidateDeadline);
    this.candidateDeadline = undefined;
  }

  private clearRetrySchedule(): void {
    if (this.retrySchedule === undefined) {
      return;
    }
    this.cancelSchedule(this.retrySchedule);
    this.retrySchedule = undefined;
  }

  private revokeActiveSession(): void {
    this.activeSession?.revoke();
    this.activeSession = undefined;
  }

  private publish(state: RuntimeConnectionState): void {
    this.state = state;
    this.options.onState(state);
  }

}

class RuntimeSessionLeaseImpl implements RuntimeSessionLease {
  readonly pluginSessionId: string;
  private readonly socket: PhotoshopSocket;
  private readonly httpOrigin: string;
  private readonly bearer: string;
  private readonly request: (url: string, init?: RequestInit) => Promise<Response>;
  private readonly schedule: (callback: () => void, delay: number) => unknown;
  private readonly cancelSchedule: (handle: unknown) => void;
  private readonly retireSession: () => void;
  private live = true;
  private readonly activeRequests = new Set<AbortController>();

  constructor(input: {
    pluginSessionId: string;
    socket: PhotoshopSocket;
    httpOrigin: string;
    bearer: string;
    request: (url: string, init?: RequestInit) => Promise<Response>;
    schedule: (callback: () => void, delay: number) => unknown;
    cancelSchedule: (handle: unknown) => void;
    retire: () => void;
  }) {
    this.pluginSessionId = input.pluginSessionId;
    this.socket = input.socket;
    this.httpOrigin = input.httpOrigin;
    this.bearer = input.bearer;
    this.request = input.request;
    this.schedule = input.schedule;
    this.cancelSchedule = input.cancelSchedule;
    this.retireSession = input.retire;
  }

  isLive(): boolean {
    return this.live;
  }

  send(message: PluginMessage): void {
    this.requireLive();
    const serialized = serializePluginMessage(message);
    try {
      this.socket.send(serialized);
    } catch {
      if (this.live) this.retireSession();
      throw new RuntimeSessionLostError();
    }
  }

  async downloadCommandContent(commandId: string, expectedBytes: number): Promise<ArrayBuffer> {
    const bytes = await this.authorizedRequest(
      `/photoshop/commands/${encodeURIComponent(commandId)}/content`,
      { method: 'GET' },
      async (response) => {
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength !== expectedBytes || bytes.byteLength > PHOTOSHOP_MAX_FILE_BYTES) {
          throw new Error('Photoshop command content length is invalid.');
        }
        return bytes;
      }
    );
    this.requireLive();
    return bytes;
  }

  async uploadExportItem(
    commandId: string,
    itemId: string,
    bytes: Uint8Array
  ): Promise<{ fileName: string }> {
    if (bytes.byteLength > PHOTOSHOP_MAX_FILE_BYTES) {
      throw new Error('Photoshop export item exceeds the file limit.');
    }
    try {
      return await this.authorizedRequest(
        `/photoshop/exports/${encodeURIComponent(commandId)}/items/${encodeURIComponent(itemId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'image/png' },
          body: bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength
          ) as ArrayBuffer
        },
        async (response) => {
          const value = await response.json() as unknown;
          if (!isUploadResult(value)) {
            throw new Error('Photoshop export response is invalid.');
          }
          return value;
        }
      );
    } catch (error) {
      if (error instanceof RuntimeTransferRejectedError
        || error instanceof RuntimeSessionLostError) {
        throw error;
      }
      const unknown = error instanceof RuntimeUploadOutcomeUnknownError
        ? error
        : new RuntimeUploadOutcomeUnknownError(error);
      if (this.live) {
        this.retireSession();
      }
      throw unknown;
    }
  }

  revoke(): void {
    if (!this.live) return;
    this.live = false;
    for (const controller of this.activeRequests) {
      controller.abort();
    }
    this.activeRequests.clear();
  }

  private requireLive(): void {
    if (!this.live) throw new RuntimeSessionLostError();
  }

  private async authorizedRequest<T>(
    path: string,
    init: RequestInit,
    consume: (response: Response) => Promise<T>
  ): Promise<T> {
    this.requireLive();
    const controller = new AbortController();
    this.activeRequests.add(controller);
    const deadline = this.schedule(() => controller.abort(), BYTE_TIMEOUT_MS);
    let dispatched = false;
    try {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${this.bearer}`);
      const pending = this.request(`${this.httpOrigin}${path}`, {
        ...init,
        headers,
        signal: controller.signal
      });
      dispatched = true;
      const response = await pending;
      if (!response.ok) {
        throw await failedTransferError(response);
      }
      return await consume(response);
    } catch (error) {
      if (error instanceof RuntimeTransferRejectedError) throw error;
      if (!dispatched) throw new RuntimeSessionLostError();
      if (!this.live && init.method !== 'POST') throw new RuntimeSessionLostError();
      if (init.method === 'POST') throw new RuntimeUploadOutcomeUnknownError(error);
      throw error;
    } finally {
      this.activeRequests.delete(controller);
      this.cancelSchedule(deadline);
    }
  }
}

function createBrowserSocket(url: string, protocol: string): PhotoshopSocket {
  return new WebSocket(url, protocol) as unknown as PhotoshopSocket;
}

function isUploadResult(value: unknown): value is { fileName: string } {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && typeof (value as { fileName?: unknown }).fileName === 'string';
}

async function failedTransferError(response: Response): Promise<Error> {
  let value: unknown;
  try {
    value = await response.json() as unknown;
  } catch {
    return new Error(`Photoshop Runtime returned invalid JSON for HTTP ${response.status}.`);
  }
  const envelope = decodePhotoshopHttpErrorEnvelope(value);
  if (envelope === undefined) {
    return new Error(
      `Photoshop Runtime returned an invalid error response for HTTP ${response.status}.`
    );
  }
  return new RuntimeTransferRejectedError(
    `Photoshop transfer failed with HTTP ${response.status} (${envelope.error.code}): ${envelope.error.message}`
  );
}
