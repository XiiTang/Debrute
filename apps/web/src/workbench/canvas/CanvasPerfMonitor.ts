export type CanvasPerfSessionType =
  | 'camera-pan'
  | 'camera-zoom'
  | 'camera-minimap'
  | 'pointer-selection'
  | 'pointer-move-node'
  | 'pointer-resize-node';

export type CanvasPerfEventSource =
  | 'CanvasSurface'
  | 'CanvasStageRuntime'
  | 'CanvasRasterPreviewPresentation'
  | 'CanvasTextPreviewRuntime'
  | 'CanvasPreviewResourceScheduler'
  | 'CanvasRenderLifecycle'
  | 'CanvasPerfBrowserAdapter';

export type CanvasPerfCounterName =
  | 'react-commit'
  | 'stage-camera-write'
  | 'stage-camera-noop'
  | 'stage-node-layout-write'
  | 'stage-node-layout-noop'
  | 'stage-node-visibility-write'
  | 'stage-node-visibility-noop'
  | 'stage-edge-visibility-write'
  | 'stage-edge-visibility-noop'
  | 'stage-edge-geometry-write'
  | 'stage-edge-geometry-noop'
  | 'render-snapshot-build'
  | 'render-snapshot-reuse'
  | 'viewport-cull-queued'
  | 'viewport-idle-publish'
  | 'raster-preview-requested'
  | 'raster-preview-pending-mounted'
  | 'raster-preview-decoded'
  | 'raster-preview-published'
  | 'raster-preview-failed'
  | 'raster-preview-retried'
  | 'text-preview-source-check-requested'
  | 'text-preview-source-check-paused'
  | 'text-preview-source-availability-resolved'
  | 'text-preview-work-epoch-started'
  | 'text-preview-work-epoch-completed'
  | 'text-preview-registry-state'
  | 'text-preview-target-identity-computed'
  | 'text-preview-content-read-started'
  | 'text-preview-content-read-completed'
  | 'text-preview-font-coverage-collected'
  | 'text-preview-font-subset-completed'
  | 'text-preview-capture-ready'
  | 'text-preview-dom-snapshot-completed'
  | 'text-preview-raster-completed'
  | 'text-preview-source-upload-started'
  | 'text-preview-source-upload-completed'
  | 'text-preview-failed'
  | 'preview-resource-queued'
  | 'preview-resource-coalesced'
  | 'preview-resource-started'
  | 'preview-resource-skip-stale'
  | 'preview-publication-queued'
  | 'preview-publication-coalesced'
  | 'preview-publication-committed'
  | 'preview-resource-paused-moving';

export type CanvasPerfSessionId = `${CanvasPerfSessionType}:${number}`;

export const CANVAS_PERF_INTERACTION_SESSION_TYPES = [
  'camera-pan',
  'camera-zoom',
  'camera-minimap',
  'pointer-selection',
  'pointer-move-node',
  'pointer-resize-node'
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
  zoomLevel: number;
  cameraState: 'idle' | 'moving';
}

export interface CanvasPerfFrameIntervalInput {
  timestamp: number;
  source: CanvasPerfEventSource;
  frameIntervalMs: number;
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
  | ({ kind: 'frame-interval' } & CanvasPerfFrameIntervalInput)
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
  frameIntervalCount: number;
  p50FrameIntervalMs: number;
  p95FrameIntervalMs: number;
  p99FrameIntervalMs: number;
  minFrameIntervalMs: number;
  maxFrameIntervalMs: number;
  counters: Partial<Record<CanvasPerfCounterName, number>>;
  longAnimationFrames?: CanvasPerfLongAnimationFrame[] | undefined;
  detail?: Record<string, unknown> | undefined;
}

export interface CanvasPerfMonitor {
  startSession(input: CanvasPerfSessionStartInput): CanvasPerfSessionId;
  endSession(input: CanvasPerfSessionEndInput): CanvasPerfSessionSummary | undefined;
  recordFrameInterval(input: CanvasPerfFrameIntervalInput): void;
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
  frameIntervals: CanvasPerfFrameIntervalInput[];
  counters: Partial<Record<CanvasPerfCounterName, number>>;
  longAnimationFrames: CanvasPerfLongAnimationFrame[];
}

export function createCanvasPerfMonitor(input: {
  onEvent?: ((event: CanvasPerfTraceEvent) => void) | undefined;
} = {}): CanvasPerfMonitor {
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
      const sessionId = `${start.type}:${nextSessionNumber++}` as CanvasPerfSessionId;
      activeSessions.set(sessionId, {
        sessionId,
        type: start.type,
        startedAt: start.timestamp,
        detail: start.detail,
        frameIntervals: [],
        counters: {},
        longAnimationFrames: []
      });
      emit({ kind: 'session-start', sessionId, ...start });
      return sessionId;
    },
    endSession(end) {
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
    recordFrameInterval(frameInterval) {
      for (const active of activeSessions.values()) {
        active.frameIntervals.push(frameInterval);
      }
      emit({ kind: 'frame-interval', ...frameInterval });
    },
    recordCounter(counter) {
      const value = counter.value ?? 1;
      incrementCounter(counterTotals, counter.name, value);
      for (const active of activeTargets(counter.sessionId, counter.sessionTypes)) {
        incrementCounter(active.counters, counter.name, value);
      }
      emit({ kind: 'counter', ...counter, value });
    },
    recordMark(mark) {
      emit({ kind: 'mark', ...mark });
    },
    recordLongAnimationFrame(entry) {
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
  const frameIntervals = active.frameIntervals
    .map((frameInterval) => frameInterval.frameIntervalMs)
    .sort((left, right) => left - right);
  return {
    sessionId: active.sessionId,
    type: active.type,
    durationMs: Math.max(0, end.timestamp - active.startedAt),
    frameIntervalCount: active.frameIntervals.length,
    p50FrameIntervalMs: percentile(frameIntervals, 0.5),
    p95FrameIntervalMs: percentile(frameIntervals, 0.95),
    p99FrameIntervalMs: percentile(frameIntervals, 0.99),
    minFrameIntervalMs: frameIntervals[0] ?? 0,
    maxFrameIntervalMs: frameIntervals[frameIntervals.length - 1] ?? 0,
    ...end.finalState,
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
