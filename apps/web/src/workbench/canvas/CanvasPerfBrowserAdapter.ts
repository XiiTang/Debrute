import type { CanvasPerfLongAnimationFrameInput, CanvasPerfSessionId, CanvasPerfTraceEvent } from './CanvasPerfMonitor';

interface CanvasPerfPerformanceApi {
  mark(name: string, options?: PerformanceMarkOptions): void;
  measure(name: string, startMark: string, endMark: string): void;
}

interface CanvasPerfLongAnimationFrameObserver {
  observe(options: { type: 'long-animation-frame'; buffered: boolean }): void;
  disconnect(): void;
}

type CanvasPerfLongAnimationFrameObserverCallback = (list: { getEntries(): readonly unknown[] }) => void;

interface CanvasPerfLongAnimationFrameObserverConstructor {
  new(callback: CanvasPerfLongAnimationFrameObserverCallback): CanvasPerfLongAnimationFrameObserver;
  supportedEntryTypes?: readonly string[] | undefined;
}

interface CanvasPerfObservedSession {
  sessionId: CanvasPerfSessionId;
  startedAt: number;
}

export interface CanvasPerfBrowserAdapter {
  recordEvent(event: CanvasPerfTraceEvent): void;
  dispose(): void;
}

export function createCanvasPerfBrowserAdapter(input: {
  performanceApi?: CanvasPerfPerformanceApi | undefined;
  performanceObserverFactory?: ((callback: CanvasPerfLongAnimationFrameObserverCallback) => CanvasPerfLongAnimationFrameObserver) | undefined;
  supportedEntryTypes?: readonly string[] | undefined;
  highVolumeMarks?: boolean | undefined;
  onLongAnimationFrame?: ((input: CanvasPerfLongAnimationFrameInput) => void) | undefined;
} = {}): CanvasPerfBrowserAdapter {
  const performanceApi = input.performanceApi ?? performance;
  const observerConstructor = canvasPerfObserverConstructor();
  const observerFactory = input.performanceObserverFactory
    ?? (observerConstructor ? (callback: CanvasPerfLongAnimationFrameObserverCallback) => new observerConstructor(callback) : undefined);
  const supportedEntryTypes = input.supportedEntryTypes ?? observerConstructor?.supportedEntryTypes ?? [];
  let observer: CanvasPerfLongAnimationFrameObserver | undefined;
  const observedSessions = new Map<CanvasPerfSessionId, CanvasPerfObservedSession>();

  const disconnectObserver = () => {
    if (!observer) {
      return;
    }
    try {
      observer.disconnect();
    } catch {
      // Browser performance APIs must never break Canvas interaction.
    }
    observer = undefined;
  };

  const ensureObserver = () => {
    if (
      observer
      || !input.onLongAnimationFrame
      || !observerFactory
      || !supportedEntryTypes.includes('long-animation-frame')
    ) {
      return;
    }
    try {
      observer = observerFactory((list) => {
        if (observedSessions.size === 0) {
          return;
        }
        for (const entry of list.getEntries()) {
          const longAnimationFrame = canvasPerfLongAnimationFrame(entry);
          if (longAnimationFrame) {
            const sessionIds = canvasPerfSessionIdsForLongAnimationFrame(longAnimationFrame, observedSessions);
            for (const sessionId of sessionIds) {
              input.onLongAnimationFrame?.({
                sessionId,
                timestamp: canvasPerfBrowserTimestamp(),
                source: 'CanvasPerfBrowserAdapter',
                entry: longAnimationFrame
              });
            }
          }
        }
      });
      observer.observe({ type: 'long-animation-frame', buffered: false });
    } catch {
      disconnectObserver();
    }
  };

  return {
    recordEvent(event) {
      if (event.kind === 'session-start') {
        observedSessions.set(event.sessionId, {
          sessionId: event.sessionId,
          startedAt: event.timestamp
        });
        ensureObserver();
        if (performanceApi) {
          safeMark(performanceApi, sessionMarkName(event.type, event.sessionId, 'start'), {
            source: event.source
          });
        }
        return;
      }
      if (event.kind === 'session-end') {
        observedSessions.delete(event.sessionId);
        if (performanceApi) {
          const start = sessionMarkName(event.summary.type, event.sessionId, 'start');
          const end = sessionMarkName(event.summary.type, event.sessionId, 'end');
          safeMark(performanceApi, end, {
            durationMs: event.summary.durationMs,
            frameCount: event.summary.frameCount,
            mountedNodeCount: event.summary.mountedNodeCount,
            visibleNodeCount: event.summary.visibleNodeCount,
            culledNodeCount: event.summary.culledNodeCount
          });
          try {
            performanceApi.measure(measureName(event.summary.type, event.sessionId), start, end);
          } catch {
            // Browser performance APIs must never break Canvas interaction.
          }
        }
        if (observedSessions.size === 0) {
          disconnectObserver();
        }
        return;
      }
      if (performanceApi && input.highVolumeMarks && event.kind === 'mark') {
        safeMark(performanceApi, event.name, event.detail);
      }
    },
    dispose() {
      observedSessions.clear();
      disconnectObserver();
    }
  };
}

function sessionMarkName(sessionType: string, sessionId: string, edge: 'start' | 'end'): string {
  return `debrute:canvas:${sessionType}:${sessionId}:${edge}`;
}

function measureName(sessionType: string, sessionId: string): string {
  return `debrute:canvas:${sessionType}:${sessionId}`;
}

function safeMark(api: CanvasPerfPerformanceApi, name: string, detail?: Record<string, unknown>): void {
  try {
    api.mark(name, detail ? { detail } : undefined);
  } catch {
    // Browser performance APIs must never break Canvas interaction.
  }
}

function canvasPerfObserverConstructor(): CanvasPerfLongAnimationFrameObserverConstructor | undefined {
  return (globalThis as typeof globalThis & {
    PerformanceObserver?: CanvasPerfLongAnimationFrameObserverConstructor | undefined;
  }).PerformanceObserver;
}

function canvasPerfLongAnimationFrame(entry: unknown): CanvasPerfLongAnimationFrameInput['entry'] | undefined {
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }
  const record = entry as Record<string, unknown>;
  return {
    startTime: numberField(record.startTime),
    duration: numberField(record.duration),
    blockingDuration: numberField(record.blockingDuration),
    scripts: Array.isArray(record.scripts)
      ? record.scripts.flatMap((script) => canvasPerfLongAnimationFrameScript(script) ?? [])
      : []
  };
}

function canvasPerfLongAnimationFrameScript(script: unknown): CanvasPerfLongAnimationFrameInput['entry']['scripts'][number] | undefined {
  if (!script || typeof script !== 'object') {
    return undefined;
  }
  const record = script as Record<string, unknown>;
  return {
    sourceURL: stringField(record.sourceURL),
    invoker: stringField(record.invoker),
    duration: numberField(record.duration)
  };
}

function canvasPerfSessionIdsForLongAnimationFrame(
  entry: CanvasPerfLongAnimationFrameInput['entry'],
  sessions: ReadonlyMap<CanvasPerfSessionId, CanvasPerfObservedSession>
): CanvasPerfSessionId[] {
  const entryEnd = entry.startTime + entry.duration;
  return [...sessions.values()]
    .filter((session) => {
      return entryEnd >= session.startedAt;
    })
    .map((session) => session.sessionId);
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function canvasPerfBrowserTimestamp(): number {
  return performance.now();
}
