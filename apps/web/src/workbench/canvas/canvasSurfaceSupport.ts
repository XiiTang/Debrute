import type React from 'react';
import type {
  CanvasFeedbackEntry,
  ProjectedCanvasNode
} from '@debrute/canvas-core';
import type {
  CanvasEditorRuntime,
  CanvasRuntimeDragState,
  CanvasRuntimePointerModifiers,
  CanvasRuntimeSnapshot
} from './runtime/CanvasEditorRuntime';
import {
  canvasFeedbackLocalToolsetForMediaKind,
  type CanvasFeedbackBarTarget,
  type FloatingBarRect
} from '../shell/floatingBars';
import { hasInternalProjectTreeDrag, readInternalProjectTreeDragEntries } from '../project-explorer/ProjectTree';
import type { DebruteCanvasPerfCanvasSnapshot } from './CanvasPerfDebugBridge';
import {
  CANVAS_PERF_INTERACTION_SESSION_TYPES,
  type CanvasPerfCounterName,
  type CanvasPerfCounterTotals,
  type CanvasPerfFinalState,
  type CanvasPerfMonitor,
  type CanvasPerfSessionId
} from './CanvasPerfMonitor';
import type { CanvasPreviewResourceScheduler } from './CanvasPreviewResourceScheduler';
import type { CanvasRenderCoordinatorSnapshot } from './CanvasRenderCoordinator';
import type { CanvasSelection } from './runtime/canvasSelection';
import type { CanvasCamera } from './runtime/canvasCamera';

export function canvasMapProjectTreeDropEntry(
  dataTransfer: Pick<DataTransfer, 'getData'>
): ReturnType<typeof readInternalProjectTreeDragEntries>[number] | undefined {
  const entries = readInternalProjectTreeDragEntries(dataTransfer);
  return entries.length === 1 ? entries[0] : undefined;
}

export function canvasMapProjectTreeDropInput(
  canvasId: string,
  dataTransfer: Pick<DataTransfer, 'getData'>
): { canvasId: string; projectRelativePath: string } | undefined {
  const entry = canvasMapProjectTreeDropEntry(dataTransfer);
  return entry
    ? {
        canvasId,
        projectRelativePath: entry.projectRelativePath
      }
    : undefined;
}

export function isCanvasMapProjectTreeDragOver(dataTransfer: Pick<DataTransfer, 'types'>): boolean {
  return hasInternalProjectTreeDrag(dataTransfer);
}

export function pointerEventModifiers(event: Pick<React.PointerEvent<Element>, 'shiftKey'>): CanvasRuntimePointerModifiers {
  return {
    shiftKey: event.shiftKey
  };
}

export interface CanvasPerfRuntimeSession {
  sessionId: CanvasPerfSessionId;
  lastFrameTimestamp: number;
  reactCommitCount: number;
  counterTotals: CanvasPerfCounterTotals;
}

export interface CanvasPerfDebugSnapshotContext {
  canvasId: string;
  runtime: Pick<CanvasEditorRuntime, 'getSnapshot'>;
  resourceZoom: number;
  renderSnapshot: CanvasRenderCoordinatorSnapshot;
  surfaceElement: HTMLElement | null;
}

const STAGE_WRITE_COUNTERS = [
  'stage-camera-write',
  'stage-node-layout-write',
  'stage-node-visibility-write'
] as const satisfies readonly CanvasPerfCounterName[];

const IMAGE_NODE_WORK_COUNTERS = [
  'image-node-url-resolve',
  'image-node-next-load-start',
  'image-node-next-load-resolve',
  'image-node-next-load-reject',
  'image-node-handoff-promote',
  'image-node-upgrade-skip-culled',
  'image-node-upgrade-skip-moving',
  'image-node-source-reset',
  'image-node-retry'
] as const satisfies readonly CanvasPerfCounterName[];

export function syncCanvasPerfSessionState(input: {
  perfMonitor: CanvasPerfMonitor | undefined;
  sessionRef: { current: CanvasPerfRuntimeSession | undefined };
  reactCommitCountRef: { current: number };
  snapshot: Pick<CanvasRuntimeSnapshot, 'cameraState' | 'camera'>;
  minimapOpen: boolean;
}): void {
  const perfMonitor = input.perfMonitor;
  if (!perfMonitor) {
    return;
  }
  const timestamp = canvasPerfTimestamp();
  if (input.snapshot.cameraState === 'moving') {
    if (!input.sessionRef.current) {
      const sessionId = perfMonitor.startSession({
        type: input.minimapOpen ? 'camera-minimap' : 'camera-pan',
        timestamp,
        source: 'CanvasSurface',
        detail: {
          minimapOpen: input.minimapOpen,
          zoomLevel: input.snapshot.camera.z
        }
      });
      input.sessionRef.current = {
        sessionId,
        lastFrameTimestamp: timestamp,
        reactCommitCount: input.reactCommitCountRef.current,
        counterTotals: perfMonitor.getCounterTotals()
      };
    }
    return;
  }
  const session = input.sessionRef.current;
  if (session) {
    perfMonitor.endSession({
      sessionId: session.sessionId,
      timestamp,
      source: 'CanvasSurface',
      finalState: {
        zoomLevel: input.snapshot.camera.z,
        cameraState: input.snapshot.cameraState
      }
    });
    input.sessionRef.current = undefined;
  }
}

export function syncCanvasPerfDragSessionState(input: {
  perfMonitor: CanvasPerfMonitor | undefined;
  sessionRef: { current: CanvasPerfRuntimeSession | undefined };
  reactCommitCountRef: { current: number };
  dragState: CanvasRuntimeDragState | undefined;
  snapshot: Pick<CanvasRuntimeSnapshot, 'cameraState' | 'camera'>;
  finalState?: Partial<CanvasPerfFinalState> | undefined;
}): void {
  const perfMonitor = input.perfMonitor;
  if (!perfMonitor) {
    return;
  }
  const timestamp = canvasPerfTimestamp();
  if (input.dragState) {
    if (!input.sessionRef.current) {
      const sessionId = perfMonitor.startSession({
        type: input.dragState.kind === 'move-node' ? 'drag-move-node' : 'drag-resize-node',
        timestamp,
        source: 'CanvasSurface',
        detail: canvasPerfDragSessionDetail(input.dragState)
      });
      input.sessionRef.current = {
        sessionId,
        lastFrameTimestamp: timestamp,
        reactCommitCount: input.reactCommitCountRef.current,
        counterTotals: perfMonitor.getCounterTotals()
      };
    }
    return;
  }
  const session = input.sessionRef.current;
  if (session) {
    perfMonitor.endSession({
      sessionId: session.sessionId,
      timestamp,
      source: 'CanvasSurface',
      finalState: {
        zoomLevel: input.snapshot.camera.z,
        cameraState: input.snapshot.cameraState,
        ...input.finalState
      }
    });
    input.sessionRef.current = undefined;
  }
}

export function recordCanvasPerfFrame(input: {
  perfMonitor: CanvasPerfMonitor | undefined;
  sessionRef: { current: CanvasPerfRuntimeSession | undefined };
  cameraState: CanvasRuntimeSnapshot['cameraState'];
  renderSnapshot: CanvasRenderCoordinatorSnapshot;
  reactCommitCountRef: { current: number };
}): void {
  const perfMonitor = input.perfMonitor;
  if (!perfMonitor || !input.sessionRef.current) {
    return;
  }
  const timestamp = canvasPerfTimestamp();
  const session = input.sessionRef.current;
  const elapsedMs = Math.max(0, timestamp - session.lastFrameTimestamp);
  const reactCommitCount = Math.max(0, input.reactCommitCountRef.current - session.reactCommitCount);
  session.lastFrameTimestamp = timestamp;
  session.reactCommitCount = input.reactCommitCountRef.current;
  if (reactCommitCount > 0) {
    perfMonitor.recordCounter({
      timestamp,
      source: 'CanvasSurface',
      sessionTypes: CANVAS_PERF_INTERACTION_SESSION_TYPES,
      name: 'react-commit',
      value: reactCommitCount
    });
  }
  const counterTotals = perfMonitor.getCounterTotals();
  perfMonitor.recordFrame({
    timestamp,
    source: 'CanvasSurface',
    elapsedMs,
    cameraState: input.cameraState,
    mountedNodeCount: input.renderSnapshot.nodesByPath.size,
    visibleNodeCount: Math.max(0, input.renderSnapshot.nodesByPath.size - input.renderSnapshot.culledNodePaths.size),
    culledNodeCount: input.renderSnapshot.culledNodePaths.size,
    reactCommitCount,
    renderSnapshotBuildCount: counterDelta(counterTotals, session.counterTotals, 'render-snapshot-build'),
    renderSnapshotReuseCount: counterDelta(counterTotals, session.counterTotals, 'render-snapshot-reuse'),
    stageWriteCount: counterDeltaSum(counterTotals, session.counterTotals, STAGE_WRITE_COUNTERS),
    imageNodeWorkCount: counterDeltaSum(counterTotals, session.counterTotals, IMAGE_NODE_WORK_COUNTERS)
  });
  session.counterTotals = counterTotals;
}

function counterDelta(
  current: CanvasPerfCounterTotals,
  previous: CanvasPerfCounterTotals,
  name: CanvasPerfCounterName
): number {
  return Math.max(0, (current[name] ?? 0) - (previous[name] ?? 0));
}

function counterDeltaSum(
  current: CanvasPerfCounterTotals,
  previous: CanvasPerfCounterTotals,
  names: readonly CanvasPerfCounterName[]
): number {
  return names.reduce((total, name) => total + counterDelta(current, previous, name), 0);
}

function canvasPerfDragSessionDetail(state: CanvasRuntimeDragState): Record<string, unknown> {
  if (state.kind === 'move-node') {
    return {
      pointerId: state.pointerId,
      nodeCount: state.origins.length
    };
  }
  return {
    pointerId: state.pointerId,
    projectRelativePath: state.node.projectRelativePath,
    handle: state.handle
  };
}

export function canvasPerfFinalState(input: {
  snapshot: Pick<CanvasRuntimeSnapshot, 'cameraState' | 'camera'>;
  renderSnapshot: CanvasRenderCoordinatorSnapshot;
}): CanvasPerfFinalState {
  return {
    mountedNodeCount: input.renderSnapshot.nodesByPath.size,
    visibleNodeCount: Math.max(0, input.renderSnapshot.nodesByPath.size - input.renderSnapshot.culledNodePaths.size),
    culledNodeCount: input.renderSnapshot.culledNodePaths.size,
    zoomLevel: input.snapshot.camera.z,
    cameraState: input.snapshot.cameraState
  };
}

export function canvasPerfDebugSnapshot(input: CanvasPerfDebugSnapshotContext): DebruteCanvasPerfCanvasSnapshot {
  const snapshot = input.runtime.getSnapshot();
  const mountedNodeCount = input.renderSnapshot.nodesByPath.size;
  const culledNodeCount = input.renderSnapshot.culledNodePaths.size;
  return {
    canvasId: input.canvasId,
    camera: { ...snapshot.camera },
    cameraState: snapshot.cameraState,
    mountedNodeCount,
    visibleNodeCount: Math.max(0, mountedNodeCount - culledNodeCount),
    culledNodeCount,
    resourceZoom: input.resourceZoom,
    imageLayers: canvasImageLayerDebugCounts(input.surfaceElement)
  };
}

function canvasImageLayerDebugCounts(surfaceElement: HTMLElement | null): DebruteCanvasPerfCanvasSnapshot['imageLayers'] {
  const counts = {
    visible: 0,
    next: 0,
    previewSources: 0,
    rawSources: 0
  };
  for (const image of surfaceElement?.querySelectorAll<HTMLImageElement>('[data-canvas-image-layer]') ?? []) {
    const layer = image.getAttribute('data-canvas-image-layer');
    if (layer === 'visible') {
      counts.visible += 1;
    } else if (layer === 'next') {
      counts.next += 1;
    }
    const src = image.getAttribute('src') ?? '';
    if (src.includes('/canvas-image-preview')) {
      counts.previewSources += 1;
    } else if (src.includes('/files/raw/')) {
      counts.rawSources += 1;
    }
  }
  return counts;
}

function canvasPerfTimestamp(): number {
  return performance.now();
}

export function syncCanvasPreviewResourceSchedulerForInteraction(input: {
  scheduler: Pick<CanvasPreviewResourceScheduler, 'setInteractionState'>;
  cameraState: CanvasRuntimeSnapshot['cameraState'];
  dragState: CanvasRuntimeSnapshot['dragState'];
}): void {
  input.scheduler.setInteractionState({
    cameraState: input.cameraState,
    dragActive: input.dragState !== undefined
  });
}

export function domRectToFloatingBarRect(rect: DOMRect): FloatingBarRect {
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height
  };
}

export function canvasFeedbackBarTargetForProjectedNode(input: {
  node: ProjectedCanvasNode;
  surfaceRect: FloatingBarRect;
  camera: CanvasCamera;
  entry: CanvasFeedbackEntry | undefined;
  canStartVideoMomentFeedback?: boolean | undefined;
  startVideoMomentFeedback?: ((mode: 'comment' | 'pin' | 'rect') => void) | undefined;
  seekToMoment?: ((seconds: number) => void) | undefined;
}): CanvasFeedbackBarTarget | undefined {
  if (input.node.nodeKind !== 'file') {
    return undefined;
  }
  return {
    projectRelativePath: input.node.projectRelativePath,
    nodeRect: nodeRectForFloatingBar(input.node),
    surfaceRect: input.surfaceRect,
    camera: input.camera,
    entry: input.entry,
    localToolset: canvasFeedbackLocalToolsetForMediaKind(input.node.mediaKind),
    canStartVideoMomentFeedback: input.canStartVideoMomentFeedback ?? false,
    startVideoMomentFeedback: input.startVideoMomentFeedback,
    seekToMoment: input.seekToMoment
  };
}

export function nodeRectForFloatingBar(node: ProjectedCanvasNode): FloatingBarRect {
  return {
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height
  };
}

export function devicePixelRatioValue(): number {
  return window.devicePixelRatio;
}

export function selectedSingleVideoPath(selection: CanvasSelection | undefined, nodes: readonly ProjectedCanvasNode[]): string | undefined {
  if (!selection || selection.kind !== 'node') {
    return undefined;
  }
  const node = nodes.find((item) => item.projectRelativePath === selection.projectRelativePath);
  return node && isProjectedVideoNode(node) ? node.projectRelativePath : undefined;
}

export function canvasActiveVideoPaths(input: {
  nodes: readonly ProjectedCanvasNode[];
  selectedProjectRelativePaths: readonly string[];
  playingVideoPaths: ReadonlySet<string>;
  requestedVideoPlayerPath: string | undefined;
}): ReadonlySet<string> {
  const videoPaths = new Set(input.nodes.filter(isProjectedVideoNode).map((node) => node.projectRelativePath));
  const active = new Set<string>();
  for (const projectRelativePath of input.selectedProjectRelativePaths) {
    if (videoPaths.has(projectRelativePath)) {
      active.add(projectRelativePath);
    }
  }
  for (const projectRelativePath of input.playingVideoPaths) {
    if (videoPaths.has(projectRelativePath)) {
      active.add(projectRelativePath);
    }
  }
  if (input.requestedVideoPlayerPath && videoPaths.has(input.requestedVideoPlayerPath)) {
    active.add(input.requestedVideoPlayerPath);
  }
  return active;
}

export function isProjectedVideoNode(node: ProjectedCanvasNode): boolean {
  return node.nodeKind === 'file' && node.mediaKind === 'video';
}
