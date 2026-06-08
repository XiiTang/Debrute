export type CanvasPerfSessionType =
  | 'camera-pan'
  | 'camera-minimap'
  | 'drag-move-node'
  | 'drag-resize-node'
  | 'image-load';

export type CanvasPerfEventSource =
  | 'CanvasSurface'
  | 'CanvasStageRuntime'
  | 'CanvasRenderCoordinator'
  | 'CanvasImageAssetRuntime'
  | 'CanvasImageAssetViewportScheduler'
  | 'CanvasRenderSnapshotScheduler'
  | 'CanvasPerfBrowserAdapter';

export type CanvasPerfCounterName =
  | 'react-commit'
  | 'stage-camera-write'
  | 'stage-camera-noop'
  | 'stage-node-layout-write'
  | 'stage-node-layout-noop'
  | 'stage-node-visibility-write'
  | 'stage-node-visibility-noop'
  | 'stage-drag-preview-write'
  | 'render-snapshot-build'
  | 'render-snapshot-reuse'
  | 'render-virtual-refresh'
  | 'render-moving-queued'
  | 'render-idle-flush'
  | 'image-viewport-sync'
  | 'image-viewport-noop'
  | 'image-moving-queued'
  | 'image-idle-flush'
  | 'image-plan-rebuild'
  | 'image-plan-reuse'
  | 'image-pump'
  | 'image-load-start'
  | 'image-load-resolve'
  | 'image-load-reject'
  | 'image-load-stale-result'
  | 'image-budget-block'
  | 'image-next-cancel'
  | 'image-visible-evict'
  | 'image-downshift-start'
  | 'image-downshift-resolve'
  | 'image-retention-budget-evict'
  | 'image-node-publish';

export type CanvasPerfSessionId = `${CanvasPerfSessionType}:${number}`;

export const CANVAS_PERF_INTERACTION_SESSION_TYPES = [
  'camera-pan',
  'camera-minimap',
  'drag-move-node',
  'drag-resize-node'
] as const satisfies readonly CanvasPerfSessionType[];

export interface CanvasPerfLongAnimationFrameScript {
  sourceURL: string;
  invoker: string;
  duration: number;
}

export interface CanvasPerfLongAnimationFrame {
  startTime: number;
  duration: number;
  blockingDuration: number;
  scripts: CanvasPerfLongAnimationFrameScript[];
}

export interface CanvasPerfFinalState {
  mountedNodeCount: number;
  visibleNodeCount: number;
  culledNodeCount: number;
  activeImageLoadCount: number;
  pendingImageCount: number;
  decodedImageCount: number;
  zoomLevel: number;
  cameraState: 'idle' | 'moving';
}

export interface CanvasPerfFrameInput {
  timestamp: number;
  source: CanvasPerfEventSource;
  elapsedMs: number;
  cameraState: 'idle' | 'moving';
  mountedNodeCount: number;
  visibleNodeCount: number;
  culledNodeCount: number;
  activeImageLoadCount: number;
  pendingImageCount: number;
  decodedImageCount: number;
  reactCommitCount: number;
  renderSnapshotBuildCount: number;
  renderSnapshotReuseCount: number;
  stageWriteCount: number;
  imageRuntimeWorkCount: number;
}

export interface CanvasPerfSessionStartInput {
  type: CanvasPerfSessionType;
  timestamp: number;
  source: CanvasPerfEventSource;
  detail?: Record<string, unknown> | undefined;
}

export interface CanvasPerfSessionEndInput {
  sessionId: CanvasPerfSessionId;
  timestamp: number;
  source: CanvasPerfEventSource;
  finalState?: Partial<CanvasPerfFinalState> | undefined;
  detail?: Record<string, unknown> | undefined;
}

export interface CanvasPerfCounterInput {
  sessionId?: CanvasPerfSessionId | undefined;
  sessionTypes?: readonly CanvasPerfSessionType[] | undefined;
  timestamp: number;
  source: CanvasPerfEventSource;
  name: CanvasPerfCounterName;
  value?: number | undefined;
  detail?: Record<string, unknown> | undefined;
}

export interface CanvasPerfMarkInput {
  sessionId?: CanvasPerfSessionId | undefined;
  timestamp: number;
  source: CanvasPerfEventSource;
  name: string;
  detail?: Record<string, unknown> | undefined;
}

export interface CanvasPerfLongAnimationFrameInput {
  sessionId?: CanvasPerfSessionId | undefined;
  timestamp: number;
  source: CanvasPerfEventSource;
  entry: CanvasPerfLongAnimationFrame;
}

export type CanvasPerfTraceEvent =
  | ({ kind: 'session-start'; sessionId: CanvasPerfSessionId } & CanvasPerfSessionStartInput)
  | ({ kind: 'session-end'; summary: CanvasPerfSessionSummary } & CanvasPerfSessionEndInput)
  | ({ kind: 'frame' } & CanvasPerfFrameInput)
  | ({ kind: 'counter'; value: number } & CanvasPerfCounterInput)
  | ({ kind: 'mark' } & CanvasPerfMarkInput)
  | ({ kind: 'long-animation-frame' } & CanvasPerfLongAnimationFrameInput);

export interface CanvasPerfTrace {
  enabled: boolean;
  events: CanvasPerfTraceEvent[];
  sessions: CanvasPerfSessionSummary[];
}

export type CanvasPerfCounterTotals = Partial<Record<CanvasPerfCounterName, number>>;

export interface CanvasPerfSessionSummary extends Partial<CanvasPerfFinalState> {
  sessionId: CanvasPerfSessionId;
  type: CanvasPerfSessionType;
  durationMs: number;
  frameCount: number;
  p50FrameMs: number;
  p95FrameMs: number;
  p99FrameMs: number;
  minFrameMs: number;
  maxFrameMs: number;
  counters: Partial<Record<CanvasPerfCounterName, number>>;
  longAnimationFrames?: CanvasPerfLongAnimationFrame[] | undefined;
  detail?: Record<string, unknown> | undefined;
}

export interface CanvasPerfMonitor {
  startSession(input: CanvasPerfSessionStartInput): CanvasPerfSessionId | undefined;
  endSession(input: CanvasPerfSessionEndInput): CanvasPerfSessionSummary | undefined;
  recordFrame(input: CanvasPerfFrameInput): void;
  recordCounter(input: CanvasPerfCounterInput): void;
  recordMark(input: CanvasPerfMarkInput): void;
  recordLongAnimationFrame(input: CanvasPerfLongAnimationFrameInput): void;
  getTrace(): CanvasPerfTrace;
  getLastSession(): CanvasPerfSessionSummary | undefined;
  getCounterTotals(): CanvasPerfCounterTotals;
  reset(): void;
}

interface ActiveCanvasPerfSession {
  sessionId: CanvasPerfSessionId;
  type: CanvasPerfSessionType;
  startedAt: number;
  detail?: Record<string, unknown> | undefined;
  frames: CanvasPerfFrameInput[];
  counters: Partial<Record<CanvasPerfCounterName, number>>;
  longAnimationFrames: CanvasPerfLongAnimationFrame[];
}

export function createCanvasPerfMonitor(input: {
  enabled: boolean;
  onEvent?: ((event: CanvasPerfTraceEvent) => void) | undefined;
}): CanvasPerfMonitor {
  let nextSessionNumber = 1;
  let activeSessions = new Map<CanvasPerfSessionId, ActiveCanvasPerfSession>();
  let events: CanvasPerfTraceEvent[] = [];
  let sessions: CanvasPerfSessionSummary[] = [];
  let lastSession: CanvasPerfSessionSummary | undefined;
  let counterTotals: CanvasPerfCounterTotals = {};

  const emit = (event: CanvasPerfTraceEvent) => {
    events.push(event);
    input.onEvent?.(event);
  };

  const activeTargets = (
    sessionId: CanvasPerfSessionId | undefined,
    sessionTypes: readonly CanvasPerfSessionType[] | undefined
  ): ActiveCanvasPerfSession[] => {
    const targets = new Map<CanvasPerfSessionId, ActiveCanvasPerfSession>();
    if (sessionId) {
      const active = activeSessions.get(sessionId);
      if (active) {
        targets.set(active.sessionId, active);
      }
    }
    if (sessionTypes) {
      const typeSet = new Set(sessionTypes);
      for (const active of activeSessions.values()) {
        if (typeSet.has(active.type)) {
          targets.set(active.sessionId, active);
        }
      }
    }
    if (!sessionId && !sessionTypes) {
      return [...activeSessions.values()];
    }
    return [...targets.values()];
  };

  return {
    startSession(start) {
      if (!input.enabled) {
        return undefined;
      }
      const sessionId = `${start.type}:${nextSessionNumber++}` as CanvasPerfSessionId;
      activeSessions.set(sessionId, {
        sessionId,
        type: start.type,
        startedAt: start.timestamp,
        detail: start.detail,
        frames: [],
        counters: {},
        longAnimationFrames: []
      });
      emit({ kind: 'session-start', sessionId, ...start });
      return sessionId;
    },
    endSession(end) {
      if (!input.enabled) {
        return undefined;
      }
      const active = activeSessions.get(end.sessionId);
      if (!active) {
        return undefined;
      }
      activeSessions.delete(end.sessionId);
      lastSession = summarizeSession(active, end);
      sessions.push(lastSession);
      emit({ kind: 'session-end', ...end, summary: lastSession });
      return lastSession;
    },
    recordFrame(frame) {
      if (!input.enabled) {
        return;
      }
      for (const active of activeSessions.values()) {
        active.frames.push(frame);
      }
      emit({ kind: 'frame', ...frame });
    },
    recordCounter(counter) {
      if (!input.enabled) {
        return;
      }
      const value = counter.value ?? 1;
      incrementCounter(counterTotals, counter.name, value);
      for (const active of activeTargets(counter.sessionId, counter.sessionTypes)) {
        incrementCounter(active.counters, counter.name, value);
      }
      emit({ kind: 'counter', ...counter, value });
    },
    recordMark(mark) {
      if (!input.enabled) {
        return;
      }
      emit({ kind: 'mark', ...mark });
    },
    recordLongAnimationFrame(entry) {
      if (!input.enabled) {
        return;
      }
      let attached = false;
      for (const active of activeTargets(entry.sessionId, undefined)) {
        active.longAnimationFrames.push(entry.entry);
        attached = true;
      }
      if (!attached && entry.sessionId) {
        attachLongAnimationFrameToCompletedSession(sessions, lastSession, entry.sessionId, entry.entry, (next) => {
          lastSession = next;
        });
      }
      emit({ kind: 'long-animation-frame', ...entry });
    },
    getTrace() {
      if (!input.enabled) {
        return { enabled: false, events: [], sessions: [] };
      }
      return {
        enabled: true,
        events: [...events],
        sessions: [...sessions]
      };
    },
    getLastSession() {
      return lastSession;
    },
    getCounterTotals() {
      return { ...counterTotals };
    },
    reset() {
      activeSessions = new Map();
      events = [];
      sessions = [];
      lastSession = undefined;
      nextSessionNumber = 1;
      counterTotals = {};
    }
  };
}

function summarizeSession(active: ActiveCanvasPerfSession, end: CanvasPerfSessionEndInput): CanvasPerfSessionSummary {
  const frameTimes = active.frames.map((frame) => frame.elapsedMs).sort((left, right) => left - right);
  const lastFrame = active.frames[active.frames.length - 1];
  const finalState: Partial<CanvasPerfFinalState> = {
    ...(lastFrame ? {
      mountedNodeCount: lastFrame.mountedNodeCount,
      visibleNodeCount: lastFrame.visibleNodeCount,
      culledNodeCount: lastFrame.culledNodeCount,
      activeImageLoadCount: lastFrame.activeImageLoadCount,
      pendingImageCount: lastFrame.pendingImageCount,
      decodedImageCount: lastFrame.decodedImageCount,
      cameraState: lastFrame.cameraState
    } : {}),
    ...end.finalState
  };
  return {
    sessionId: active.sessionId,
    type: active.type,
    durationMs: Math.max(0, end.timestamp - active.startedAt),
    frameCount: active.frames.length,
    p50FrameMs: percentile(frameTimes, 0.5),
    p95FrameMs: percentile(frameTimes, 0.95),
    p99FrameMs: percentile(frameTimes, 0.99),
    minFrameMs: frameTimes[0] ?? 0,
    maxFrameMs: frameTimes[frameTimes.length - 1] ?? 0,
    ...finalState,
    counters: { ...active.counters },
    ...(active.longAnimationFrames.length > 0 ? { longAnimationFrames: [...active.longAnimationFrames] } : {}),
    ...(end.detail ?? active.detail ? { detail: { ...(active.detail ?? {}), ...(end.detail ?? {}) } } : {})
  };
}

function attachLongAnimationFrameToCompletedSession(
  sessions: CanvasPerfSessionSummary[],
  lastSession: CanvasPerfSessionSummary | undefined,
  sessionId: CanvasPerfSessionId,
  entry: CanvasPerfLongAnimationFrame,
  updateLastSession: (session: CanvasPerfSessionSummary) => void
): void {
  const index = sessions.findIndex((session) => session.sessionId === sessionId);
  if (index < 0) {
    return;
  }
  const current = sessions[index]!;
  const next = {
    ...current,
    longAnimationFrames: [...(current.longAnimationFrames ?? []), entry]
  };
  sessions[index] = next;
  if (lastSession?.sessionId === sessionId) {
    updateLastSession(next);
  }
}

function incrementCounter(
  counters: Partial<Record<CanvasPerfCounterName, number>>,
  name: CanvasPerfCounterName,
  value: number
): void {
  counters[name] = (counters[name] ?? 0) + value;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1));
  return values[index]!;
}
