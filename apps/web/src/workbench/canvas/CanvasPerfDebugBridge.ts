import type {
  CanvasPerfCounterTotals,
  CanvasPerfFinalState,
  CanvasPerfMonitor,
  CanvasPerfSessionSummary,
  CanvasPerfTrace,
  CanvasPerfTraceEvent
} from './CanvasPerfMonitor';

export interface DebruteCanvasPerfCanvasSnapshot {
  canvasId: string;
  camera: { x: number; y: number; z: number };
  cameraState: 'idle' | 'moving';
  mountedNodeCount: number;
  visibleNodeCount: number;
  culledNodeCount: number;
  activeImageLoadCount: number;
  pendingImageCount: number;
  decodedImageCount: number;
  imageResourceZoom: number;
  visiblePreviewWidths: Record<string, number>;
  nextPreviewWidths: Record<string, number>;
  imageWorkIntentCounts: Record<string, number>;
  imageCancellationReasons: Record<string, number>;
  imageEvictionReasons: Record<string, number>;
  imageLayers: {
    visible: number;
    next: number;
    previewSources: number;
    rawSources: number;
  };
}

export interface DebruteCanvasPerfCapture {
  version: 1;
  label?: string | undefined;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  trace: CanvasPerfTrace;
  counterTotals: CanvasPerfCounterTotals;
  canvas: DebruteCanvasPerfCanvasSnapshot | undefined;
  error?: { message: string } | undefined;
}

export interface DebruteCanvasPerfCaptureState {
  enabled: boolean;
  capturing: boolean;
  label?: string | undefined;
  startedAt?: number | undefined;
  lastExportedAt?: number | undefined;
}

export interface DebruteCanvasPerfDebugApi {
  startCapture(input?: { label?: string | undefined }): DebruteCanvasPerfCaptureState;
  stopCapture(): DebruteCanvasPerfCapture;
  exportCapture(): DebruteCanvasPerfCapture;
  reset(): DebruteCanvasPerfCaptureState;
  getState(): DebruteCanvasPerfCaptureState;
}

export interface DebruteCanvasPerfDebugGlobal {
  __debruteCanvasPerf?: DebruteCanvasPerfDebugApi | undefined;
}

interface DebruteCanvasPerfDebugApiWithOwner extends DebruteCanvasPerfDebugApi {
  __owner: symbol;
}

export interface CanvasPerfDebugBridge {
  api: DebruteCanvasPerfDebugApi;
  register(): void;
  unregister(): void;
}

export function createCanvasPerfDebugBridge(input: {
  enabled: boolean;
  globalObject?: DebruteCanvasPerfDebugGlobal | undefined;
  perfMonitor: Pick<CanvasPerfMonitor, 'getTrace' | 'getCounterTotals' | 'reset'>;
  getCanvasSnapshot: () => DebruteCanvasPerfCanvasSnapshot;
  now?: (() => number) | undefined;
}): CanvasPerfDebugBridge {
  const owner = Symbol('debrute-canvas-perf-debug-bridge');
  const globalObject = input.globalObject ?? (globalThis as DebruteCanvasPerfDebugGlobal);
  const now = input.now ?? canvasPerfDebugTimestamp;
  let capturing = false;
  let label: string | undefined;
  let startedAt: number | undefined;
  let lastExportedAt: number | undefined;
  let lastExport: DebruteCanvasPerfCapture | undefined;

  const currentState = (): DebruteCanvasPerfCaptureState => ({
    enabled: input.enabled,
    capturing,
    ...(label !== undefined ? { label } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(lastExportedAt !== undefined ? { lastExportedAt } : {})
  });

  const buildCapture = (): DebruteCanvasPerfCapture => {
    const endedAt = now();
    const captureStartedAt = startedAt ?? endedAt;
    return captureWithSnapshot({
      startedAt: captureStartedAt,
      endedAt,
      trace: input.perfMonitor.getTrace(),
      counterTotals: input.perfMonitor.getCounterTotals()
    });
  };

  const buildEmptyCapture = (): DebruteCanvasPerfCapture => {
    const endedAt = now();
    return captureWithSnapshot({
      startedAt: endedAt,
      endedAt,
      trace: { enabled: input.enabled, events: [], sessions: [] },
      counterTotals: {}
    });
  };

  const captureWithSnapshot = (captureInput: {
    startedAt: number;
    endedAt: number;
    trace: CanvasPerfTrace;
    counterTotals: CanvasPerfCounterTotals;
  }): DebruteCanvasPerfCapture => {
    let canvas: DebruteCanvasPerfCanvasSnapshot | undefined;
    let error: { message: string } | undefined;
    try {
      canvas = input.getCanvasSnapshot();
    } catch (snapshotError) {
      error = { message: errorMessage(snapshotError) };
    }
    const capture: DebruteCanvasPerfCapture = {
      version: 1,
      ...(label !== undefined ? { label } : {}),
      startedAt: captureInput.startedAt,
      endedAt: captureInput.endedAt,
      durationMs: Math.max(0, captureInput.endedAt - captureInput.startedAt),
      trace: cloneTrace(captureInput.trace),
      counterTotals: { ...captureInput.counterTotals },
      canvas: canvas ? cloneCanvasSnapshot(canvas) : undefined,
      ...(error ? { error } : {})
    };
    lastExport = cloneCapture(capture);
    lastExportedAt = captureInput.endedAt;
    return cloneCapture(capture);
  };

  const api: DebruteCanvasPerfDebugApiWithOwner = {
    __owner: owner,
    startCapture(startInput) {
      input.perfMonitor.reset();
      capturing = true;
      label = startInput?.label;
      startedAt = now();
      lastExportedAt = undefined;
      lastExport = undefined;
      return currentState();
    },
    stopCapture() {
      if (!capturing && lastExport) {
        return cloneCapture(lastExport);
      }
      if (!capturing && startedAt === undefined) {
        return buildEmptyCapture();
      }
      capturing = false;
      return buildCapture();
    },
    exportCapture() {
      return buildCapture();
    },
    reset() {
      input.perfMonitor.reset();
      capturing = false;
      label = undefined;
      startedAt = undefined;
      lastExportedAt = undefined;
      lastExport = undefined;
      return currentState();
    },
    getState() {
      return currentState();
    }
  };

  return {
    api,
    register() {
      if (!input.enabled) {
        return;
      }
      globalObject.__debruteCanvasPerf = api;
    },
    unregister() {
      const current = globalObject.__debruteCanvasPerf as DebruteCanvasPerfDebugApiWithOwner | undefined;
      if (current?.__owner === owner) {
        delete globalObject.__debruteCanvasPerf;
      }
    }
  };
}

function cloneCapture(capture: DebruteCanvasPerfCapture): DebruteCanvasPerfCapture {
  return {
    version: 1,
    ...(capture.label !== undefined ? { label: capture.label } : {}),
    startedAt: capture.startedAt,
    endedAt: capture.endedAt,
    durationMs: capture.durationMs,
    trace: cloneTrace(capture.trace),
    counterTotals: { ...capture.counterTotals },
    canvas: capture.canvas ? cloneCanvasSnapshot(capture.canvas) : undefined,
    ...(capture.error ? { error: { ...capture.error } } : {})
  };
}

function cloneCanvasSnapshot(snapshot: DebruteCanvasPerfCanvasSnapshot): DebruteCanvasPerfCanvasSnapshot {
  return {
    canvasId: snapshot.canvasId,
    camera: { ...snapshot.camera },
    cameraState: snapshot.cameraState,
    mountedNodeCount: snapshot.mountedNodeCount,
    visibleNodeCount: snapshot.visibleNodeCount,
    culledNodeCount: snapshot.culledNodeCount,
    activeImageLoadCount: snapshot.activeImageLoadCount,
    pendingImageCount: snapshot.pendingImageCount,
    decodedImageCount: snapshot.decodedImageCount,
    imageResourceZoom: snapshot.imageResourceZoom,
    visiblePreviewWidths: { ...snapshot.visiblePreviewWidths },
    nextPreviewWidths: { ...snapshot.nextPreviewWidths },
    imageWorkIntentCounts: { ...snapshot.imageWorkIntentCounts },
    imageCancellationReasons: { ...snapshot.imageCancellationReasons },
    imageEvictionReasons: { ...snapshot.imageEvictionReasons },
    imageLayers: { ...snapshot.imageLayers }
  };
}

function cloneTrace(trace: CanvasPerfTrace): CanvasPerfTrace {
  return {
    enabled: trace.enabled,
    events: trace.events.map(cloneEvent),
    sessions: trace.sessions.map(cloneSessionSummary)
  };
}

function cloneSessionSummary(summary: CanvasPerfSessionSummary): CanvasPerfSessionSummary {
  return {
    ...summary,
    counters: { ...summary.counters },
    ...(summary.longAnimationFrames ? {
      longAnimationFrames: summary.longAnimationFrames.map((entry) => ({
        ...entry,
        scripts: entry.scripts.map((script) => ({ ...script }))
      }))
    } : {}),
    ...(summary.detail ? { detail: cloneRecord(summary.detail) } : {})
  };
}

function cloneEvent(event: CanvasPerfTraceEvent): CanvasPerfTraceEvent {
  if (event.kind === 'counter') {
    return {
      ...event,
      ...(event.sessionTypes ? { sessionTypes: [...event.sessionTypes] } : {}),
      ...(event.detail ? { detail: cloneRecord(event.detail) } : {})
    };
  }
  if (event.kind === 'mark') {
    return {
      ...event,
      ...(event.detail ? { detail: cloneRecord(event.detail) } : {})
    };
  }
  if (event.kind === 'session-start') {
    return {
      ...event,
      ...(event.detail ? { detail: cloneRecord(event.detail) } : {})
    };
  }
  if (event.kind === 'session-end') {
    return {
      ...event,
      summary: cloneSessionSummary(event.summary),
      ...(event.finalState ? { finalState: cloneFinalState(event.finalState) } : {}),
      ...(event.detail ? { detail: cloneRecord(event.detail) } : {})
    };
  }
  if (event.kind === 'long-animation-frame') {
    return {
      ...event,
      entry: {
        ...event.entry,
        scripts: event.entry.scripts.map((script) => ({ ...script }))
      }
    };
  }
  return { ...event };
}

function cloneFinalState(finalState: Partial<CanvasPerfFinalState>): Partial<CanvasPerfFinalState> {
  return { ...finalState };
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    clone[key] = cloneJsonValue(value);
  }
  return clone;
}

function cloneJsonValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(cloneJsonValue);
  }
  if (value && typeof value === 'object') {
    return cloneRecord(value as Record<string, unknown>);
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canvasPerfDebugTimestamp(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}
