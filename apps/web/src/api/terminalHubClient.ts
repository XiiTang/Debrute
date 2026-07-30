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
  subscribeSessions(
    listener: (sessions: TerminalSessionView[]) => void,
    onError: (error: Error) => void
  ): TerminalEventSubscription;
  writeInput(terminalId: string, data: string): Promise<{ ok: true }>;
  resize(terminalId: string, cols: number, rows: number): Promise<TerminalSessionResult>;
  subscribe(
    terminalId: string,
    listener: (event: TerminalEvent) => void,
    onError: (error: Error) => void
  ): TerminalEventSubscription;
  dispose(): void;
}

interface PendingTerminalResize {
  cols: number;
  rows: number;
  requestId?: number;
  waiters: Array<{
    resolve(value: TerminalSessionResult): void;
    reject(error: Error): void;
  }>;
}

interface TerminalResizeState {
  inFlight: PendingTerminalResize;
  queued?: PendingTerminalResize;
}

interface PendingTerminalInput {
  terminalId: string;
  data: string;
  sequence?: number;
  resolve(value: { ok: true }): void;
  reject(error: Error): void;
}

type TerminalObservationState =
  | { status: 'pending' }
  | { status: 'ready' }
  | { status: 'failed'; error: Error };

interface TerminalSessionSubscription {
  listener(sessions: TerminalSessionView[]): void;
  onError(error: Error): void;
}

interface TerminalObservationSubscription {
  listener(event: TerminalEvent): void;
  onError(error: Error): void;
}

export function createTerminalHubClient(): TerminalHubClient {
  let binding: { projectId: string; connectionCredential: string } | undefined;
  let socket: WebSocket | undefined;
  let disposed = false;
  const terminalSubscriptions = new Map<string, Set<TerminalObservationSubscription>>();
  const sessionSubscriptions = new Set<TerminalSessionSubscription>();
  const sessions = new Map<string, TerminalSessionView>();
  const checkpoints = new Map<string, TerminalCheckpoint>();
  const observationStates = new Map<string, TerminalObservationState>();
  const inputSequences = new Map<string, number>();
  const unsentInputs = new Set<PendingTerminalInput>();
  const inputAcks = new Map<number, PendingTerminalInput>();
  const resizeStates = new Map<string, TerminalResizeState>();
  let topologyRevision: number | undefined;
  let nextRequestId = 0;

  const notify = (terminalId: string, event: TerminalEvent) => {
    for (const subscription of terminalSubscriptions.get(terminalId) ?? []) {
      subscription.listener(event);
    }
  };
  const failTerminal = (terminalId: string, error: Error) => {
    for (const subscription of terminalSubscriptions.get(terminalId) ?? []) {
      subscription.onError(error);
    }
  };
  const publishSessions = () => {
    const snapshot = [...sessions.values()];
    for (const subscription of sessionSubscriptions) {
      subscription.listener(snapshot);
    }
  };
  const failSessions = (error: Error) => {
    for (const subscription of sessionSubscriptions) {
      subscription.onError(error);
    }
  };
  const rejectTerminalPending = (terminalId: string, error: Error) => {
    for (const pending of unsentInputs) {
      if (pending.terminalId === terminalId) {
        unsentInputs.delete(pending);
        pending.reject(error);
      }
    }
    for (const [requestId, pending] of inputAcks) {
      if (pending.terminalId === terminalId) {
        inputAcks.delete(requestId);
        pending.reject(error);
      }
    }
    const resize = resizeStates.get(terminalId);
    resizeStates.delete(terminalId);
    resize?.inFlight.waiters.forEach((waiter) => waiter.reject(error));
    resize?.queued?.waiters.forEach((waiter) => waiter.reject(error));
  };
  const rejectPending = (message: string) => {
    const error = new Error(message);
    for (const pending of unsentInputs) {
      pending.reject(error);
    }
    for (const pending of inputAcks.values()) {
      pending.reject(error);
    }
    for (const state of resizeStates.values()) {
      state.inFlight.waiters.forEach((waiter) => waiter.reject(error));
      state.queued?.waiters.forEach((waiter) => waiter.reject(error));
    }
    unsentInputs.clear();
    inputAcks.clear();
    resizeStates.clear();
  };
  const resetProjectState = () => {
    sessions.clear();
    checkpoints.clear();
    observationStates.clear();
    inputSequences.clear();
    topologyRevision = undefined;
  };
  const rejectUnsentTerminalPending = (terminalId: string) => {
    for (const pending of unsentInputs) {
      if (pending.terminalId === terminalId) {
        unsentInputs.delete(pending);
        pending.reject(new Error(`Terminal observation ended before input was sent: ${terminalId}`));
      }
    }
    const resize = resizeStates.get(terminalId);
    if (!resize) {
      return;
    }
    if (resize.inFlight.requestId === undefined) {
      resizeStates.delete(terminalId);
      const error = new Error(`Terminal observation ended before resize was sent: ${terminalId}`);
      resize.inFlight.waiters.forEach((waiter) => waiter.reject(error));
      resize.queued?.waiters.forEach((waiter) => waiter.reject(error));
      return;
    }
    if (resize.queued) {
      const error = new Error(`Terminal observation ended before resize was sent: ${terminalId}`);
      resize.queued.waiters.forEach((waiter) => waiter.reject(error));
      delete resize.queued;
    }
  };
  const connect = () => {
    if (disposed || !binding || socket) {
      return;
    }
    const url = new URL(`/api/projects/${encodeURIComponent(binding.projectId)}/terminals/ws`, location.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const next = new WebSocket(url.toString());
    socket = next;
    let sessionFailureReported = false;
    const reportSessionFailure = (error: Error) => {
      if (!sessionFailureReported) {
        sessionFailureReported = true;
        failSessions(error);
      }
    };
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
      if (socket !== next) {
        return;
      }
      try {
        handleFrame(JSON.parse(String(event.data)) as TerminalServerFrame);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        rejectPending(failure.message);
        reportSessionFailure(failure);
        next.close();
      }
    });
    next.addEventListener('close', () => {
      if (socket !== next) {
        return;
      }
      socket = undefined;
      const connectionError = new Error('Terminal connection was lost.');
      topologyRevision = undefined;
      for (const terminalId of terminalSubscriptions.keys()) {
        observationStates.set(terminalId, { status: 'failed', error: connectionError });
      }
      rejectPending('Terminal connection was lost; pending input was not replayed.');
      inputSequences.clear();
      reportSessionFailure(connectionError);
      for (const terminalId of terminalSubscriptions.keys()) {
        failTerminal(terminalId, connectionError);
      }
    });
    next.addEventListener('error', () => {
      if (socket !== next) {
        return;
      }
      for (const terminalId of terminalSubscriptions.keys()) {
        failTerminal(terminalId, new Error('Terminal connection failed.'));
      }
      reportSessionFailure(new Error('Terminal connection failed.'));
    });
  };
  const send = (frame: object) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Terminal connection is not ready.');
    }
    socket.send(JSON.stringify(frame));
  };
  const sendResize = (terminalId: string, pending: PendingTerminalResize) => {
    if (observationStates.get(terminalId)?.status !== 'ready' || pending.requestId !== undefined) {
      return;
    }
    const requestId = ++nextRequestId;
    try {
      send({ type: 'resize', requestId, terminalId, cols: pending.cols, rows: pending.rows });
      pending.requestId = requestId;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      const state = resizeStates.get(terminalId);
      resizeStates.delete(terminalId);
      state?.inFlight.waiters.forEach((waiter) => waiter.reject(failure));
      state?.queued?.waiters.forEach((waiter) => waiter.reject(failure));
    }
  };
  const sendInput = (pending: PendingTerminalInput) => {
    if (observationStates.get(pending.terminalId)?.status !== 'ready' || pending.sequence !== undefined) {
      return;
    }
    const sequence = (inputSequences.get(pending.terminalId) ?? 0) + 1;
    const requestId = ++nextRequestId;
    try {
      send({
        type: 'input',
        requestId,
        terminalId: pending.terminalId,
        sequence,
        data: pending.data
      });
      pending.sequence = sequence;
      inputSequences.set(pending.terminalId, sequence);
      unsentInputs.delete(pending);
      inputAcks.set(requestId, pending);
    } catch (error) {
      unsentInputs.delete(pending);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const replayCheckpoint = (checkpoint: TerminalCheckpoint) => {
    notify(checkpoint.terminalId, {
      type: 'replay',
      terminalId: checkpoint.terminalId,
      chunks: [{ sequence: checkpoint.outputSequence, data: decodeBase64Text(checkpoint.ansiBase64) }],
      lastSequence: checkpoint.outputSequence
    });
  };
  const acceptTopology = (
    revision: number,
    nextSessions: TerminalSessionView[],
    replaceExistingSessions: boolean
  ) => {
    const removedTerminalIds = new Set(sessions.keys());
    const previousSessions = new Map(sessions);
    sessions.clear();
    for (const session of nextSessions) {
      sessions.set(
        session.id,
        replaceExistingSessions ? session : previousSessions.get(session.id) ?? session
      );
      removedTerminalIds.delete(session.id);
    }
    topologyRevision = revision;
    publishSessions();
    for (const terminalId of removedTerminalIds) {
      const error = new Error(`Terminal session was closed: ${terminalId}`);
      rejectTerminalPending(terminalId, error);
      checkpoints.delete(terminalId);
      observationStates.set(terminalId, { status: 'failed', error });
      inputSequences.delete(terminalId);
      notify(terminalId, { type: 'closed', terminalId });
    }
  };
  const acceptObservation = (session: TerminalSessionView, checkpoint: TerminalCheckpoint) => {
    if (sessions.has(session.id)) {
      sessions.set(session.id, session);
      publishSessions();
    }
    const becameReady = observationStates.get(checkpoint.terminalId)?.status !== 'ready';
    observationStates.set(checkpoint.terminalId, { status: 'ready' });
    checkpoints.set(checkpoint.terminalId, checkpoint);
    if (becameReady) {
      const resize = resizeStates.get(checkpoint.terminalId);
      if (resize) {
        sendResize(checkpoint.terminalId, resize.inFlight);
      }
      for (const pending of unsentInputs) {
        if (pending.terminalId === checkpoint.terminalId) {
          sendInput(pending);
        }
      }
    }
    replayCheckpoint(checkpoint);
  };
  const handleFrame = (frame: TerminalServerFrame) => {
    if (frame.type === 'sync') {
      if (frame.protocolVersion !== TERMINAL_PROTOCOL_VERSION) {
        throw new Error(`Unsupported Terminal protocol ${frame.protocolVersion}.`);
      }
      if (topologyRevision !== undefined) {
        throw new Error('Terminal topology was synchronized more than once.');
      }
      acceptTopology(frame.topologyRevision, frame.sessions, true);
      for (const terminalId of terminalSubscriptions.keys()) {
        observationStates.set(terminalId, { status: 'pending' });
        send({ type: 'observe', terminalId });
      }
      return;
    }
    if (frame.type === 'observed') {
      acceptObservation(frame.session, frame.checkpoint);
      return;
    }
    if (frame.type === 'topology') {
      if (topologyRevision === undefined) {
        throw new Error('Terminal topology arrived before its initial synchronization.');
      }
      const expectedRevision = topologyRevision + 1;
      if (frame.topologyRevision !== expectedRevision) {
        throw new Error(
          `Terminal topology revision is not contiguous: expected ${expectedRevision}, received ${frame.topologyRevision}.`
        );
      }
      acceptTopology(frame.topologyRevision, frame.sessions, false);
      return;
    }
    if (frame.type === 'input-ack') {
      const pending = inputAcks.get(frame.requestId);
      if (pending?.terminalId === frame.terminalId && pending.sequence === frame.sequence) {
        inputAcks.delete(frame.requestId);
        pending.resolve({ ok: true });
      }
      return;
    }
    if (frame.type === 'resized') {
      const terminalId = frame.session.id;
      const state = resizeStates.get(terminalId);
      if (!state || state.inFlight.requestId !== frame.requestId) {
        return;
      }
      if (sessions.has(terminalId)) {
        sessions.set(terminalId, frame.session);
        publishSessions();
      }
      state.inFlight.waiters.forEach((waiter) => waiter.resolve({ session: frame.session }));
      if (state.queued) {
        state.inFlight = state.queued;
        delete state.queued;
        sendResize(terminalId, state.inFlight);
      } else {
        resizeStates.delete(terminalId);
      }
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
      if (sessions.has(frame.session.id)) {
        sessions.set(frame.session.id, frame.session);
        publishSessions();
      }
      notify(frame.session.id, { type: 'status', terminalId: frame.session.id, session: frame.session });
      return;
    }
    if (frame.type === 'exit') {
      rejectTerminalPending(
        frame.terminalId,
        new Error(`Terminal exited before its pending control was acknowledged: ${frame.terminalId}`)
      );
      checkpoints.delete(frame.terminalId);
      observationStates.delete(frame.terminalId);
      inputSequences.delete(frame.terminalId);
      notify(frame.terminalId, { ...frame, type: 'exit' });
      return;
    }
    const error = new Error(frame.message);
    if (frame.requestId !== null) {
      const input = inputAcks.get(frame.requestId);
      if (input && input.terminalId === frame.terminalId) {
        inputAcks.delete(frame.requestId);
        input.reject(error);
      } else if (frame.terminalId) {
        const state = resizeStates.get(frame.terminalId);
        if (state?.inFlight.requestId === frame.requestId) {
          state.inFlight.waiters.forEach((waiter) => waiter.reject(error));
          if (state.queued) {
            state.inFlight = state.queued;
            delete state.queued;
            sendResize(frame.terminalId, state.inFlight);
          } else {
            resizeStates.delete(frame.terminalId);
          }
        }
      }
    }
    if (frame.terminalId) {
      const observationFailed = frame.requestId === null && (
        observationStates.get(frame.terminalId)?.status === 'pending'
        || frame.code === 'terminal_not_observed'
        || frame.code === 'terminal_not_found'
      );
      if (observationFailed) {
        if (frame.code === 'terminal_not_found') {
          rejectTerminalPending(frame.terminalId, error);
          inputSequences.delete(frame.terminalId);
        } else {
          rejectUnsentTerminalPending(frame.terminalId);
        }
        observationStates.set(frame.terminalId, { status: 'failed', error });
        checkpoints.delete(frame.terminalId);
      }
      notify(frame.terminalId, { type: 'error', terminalId: frame.terminalId, code: frame.code, message: frame.message });
      failTerminal(frame.terminalId, error);
    }
  };

  return {
    bindProject(projectId, connectionCredential) {
      rejectPending('Terminal Project binding was replaced.');
      binding = { projectId, connectionCredential };
      socket?.close();
      socket = undefined;
      resetProjectState();
      nextRequestId = 0;
      connect();
    },
    unbindProject() {
      binding = undefined;
      socket?.close();
      socket = undefined;
      rejectPending('Terminal Project binding was released.');
      resetProjectState();
      nextRequestId = 0;
    },
    subscribeSessions(listener, onError) {
      const subscription = { listener, onError };
      sessionSubscriptions.add(subscription);
      if (topologyRevision !== undefined) {
        listener([...sessions.values()]);
      }
      return {
        close() {
          sessionSubscriptions.delete(subscription);
        }
      };
    },
    writeInput(terminalId, data) {
      if (!terminalSubscriptions.has(terminalId)) {
        return Promise.reject(new Error(`Terminal is not observed: ${terminalId}`));
      }
      const observation = observationStates.get(terminalId);
      if (observation?.status === 'failed') {
        return Promise.reject(observation.error);
      }
      return new Promise((resolve, reject) => {
        const pending = { terminalId, data, resolve, reject };
        unsentInputs.add(pending);
        sendInput(pending);
      });
    },
    resize(terminalId, cols, rows) {
      if (!terminalSubscriptions.has(terminalId)) {
        return Promise.reject(new Error(`Terminal is not observed: ${terminalId}`));
      }
      const observation = observationStates.get(terminalId);
      if (observation?.status === 'failed') {
        return Promise.reject(observation.error);
      }
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        const state = resizeStates.get(terminalId);
        if (!state) {
          const pending = { cols, rows, waiters: [waiter] };
          resizeStates.set(terminalId, { inFlight: pending });
          sendResize(terminalId, pending);
          return;
        }
        if (!state.queued && state.inFlight.cols === cols && state.inFlight.rows === rows) {
          state.inFlight.waiters.push(waiter);
          return;
        }
        if (state.queued) {
          state.queued.cols = cols;
          state.queued.rows = rows;
          state.queued.waiters.push(waiter);
        } else {
          state.queued = { cols, rows, waiters: [waiter] };
        }
      });
    },
    subscribe(terminalId, listener, onError) {
      const subscriptions = terminalSubscriptions.get(terminalId) ?? new Set();
      const wasEmpty = subscriptions.size === 0;
      const subscription = { listener, onError };
      subscriptions.add(subscription);
      terminalSubscriptions.set(terminalId, subscriptions);
      const checkpoint = checkpoints.get(terminalId);
      if (checkpoint) {
        replayCheckpoint(checkpoint);
      } else if (
        wasEmpty
        && topologyRevision !== undefined
        && socket?.readyState === WebSocket.OPEN
      ) {
        observationStates.set(terminalId, { status: 'pending' });
        send({ type: 'observe', terminalId });
      } else if (wasEmpty) {
        observationStates.set(terminalId, { status: 'pending' });
      }
      return {
        close() {
          terminalSubscriptions.get(terminalId)?.delete(subscription);
          if (terminalSubscriptions.get(terminalId)?.size === 0) {
            terminalSubscriptions.delete(terminalId);
            checkpoints.delete(terminalId);
            observationStates.delete(terminalId);
            rejectUnsentTerminalPending(terminalId);
            if (socket?.readyState === WebSocket.OPEN) {
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
      terminalSubscriptions.clear();
      resetProjectState();
      sessionSubscriptions.clear();
    }
  };
}

function decodeBase64Text(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
