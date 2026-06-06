export type CanvasPerfCameraSessionType = 'panning' | 'zooming' | 'gesture-zooming' | 'minimap';

export interface CanvasPerfFrameInput {
  elapsedMs: number;
  mountedNodeCount: number;
  visibleNodeCount: number;
  culledNodeCount: number;
  activeImageLoadCount: number;
  pendingImageCount: number;
  decodedImageCount: number;
  reactCommitCount: number;
}

export interface CanvasPerfCameraSessionStartInput {
  type: CanvasPerfCameraSessionType;
  timestamp: number;
  minimapOpen: boolean;
}

export interface CanvasPerfCameraSessionEndInput {
  timestamp: number;
}

export interface CanvasPerfCameraSessionSummary {
  type: CanvasPerfCameraSessionType;
  durationMs: number;
  frameCount: number;
  p50FrameMs: number;
  p95FrameMs: number;
  p99FrameMs: number;
  mountedNodeCount: number;
  visibleNodeCount: number;
  culledNodeCount: number;
  activeImageLoadCount: number;
  pendingImageCount: number;
  decodedImageCount: number;
  minimapOpen: boolean;
  reactCommitCount: number;
}

export interface CanvasPerfMonitor {
  startCameraSession(input: CanvasPerfCameraSessionStartInput): void;
  recordFrame(input: CanvasPerfFrameInput): void;
  endCameraSession(input: CanvasPerfCameraSessionEndInput): CanvasPerfCameraSessionSummary | undefined;
  getLastCameraSession(): CanvasPerfCameraSessionSummary | undefined;
}

interface ActiveCameraSession extends CanvasPerfCameraSessionStartInput {
  frames: CanvasPerfFrameInput[];
}

export function createCanvasPerfMonitor(input: { enabled: boolean }): CanvasPerfMonitor {
  let active: ActiveCameraSession | undefined;
  let last: CanvasPerfCameraSessionSummary | undefined;

  return {
    startCameraSession(start) {
      if (!input.enabled) {
        return;
      }
      active = { ...start, frames: [] };
    },
    recordFrame(frame) {
      if (!input.enabled || !active) {
        return;
      }
      active.frames.push(frame);
    },
    endCameraSession(end) {
      if (!input.enabled || !active) {
        return undefined;
      }
      last = summarizeCameraSession(active, end.timestamp);
      active = undefined;
      return last;
    },
    getLastCameraSession() {
      return last;
    }
  };
}

function summarizeCameraSession(session: ActiveCameraSession, endTimestamp: number): CanvasPerfCameraSessionSummary {
  const frames = session.frames;
  const lastFrame = frames[frames.length - 1] ?? {
    elapsedMs: 0,
    mountedNodeCount: 0,
    visibleNodeCount: 0,
    culledNodeCount: 0,
    activeImageLoadCount: 0,
    pendingImageCount: 0,
    decodedImageCount: 0,
    reactCommitCount: 0
  };
  const elapsed = frames.map((frame) => frame.elapsedMs).sort((left, right) => left - right);

  return {
    type: session.type,
    durationMs: Math.max(0, endTimestamp - session.timestamp),
    frameCount: frames.length,
    p50FrameMs: percentile(elapsed, 0.5),
    p95FrameMs: percentile(elapsed, 0.95),
    p99FrameMs: percentile(elapsed, 0.99),
    mountedNodeCount: lastFrame.mountedNodeCount,
    visibleNodeCount: lastFrame.visibleNodeCount,
    culledNodeCount: lastFrame.culledNodeCount,
    activeImageLoadCount: lastFrame.activeImageLoadCount,
    pendingImageCount: lastFrame.pendingImageCount,
    decodedImageCount: lastFrame.decodedImageCount,
    minimapOpen: session.minimapOpen,
    reactCommitCount: frames.reduce((total, frame) => total + frame.reactCommitCount, 0)
  };
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1));
  return values[index]!;
}
