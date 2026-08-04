import type React from 'react';
import type { DebruteProductPlatform } from '@debrute/app-protocol';
import type {
  ProjectedCanvasNode
} from '@debrute/canvas-core';
import type {
  CanvasEditorRuntime,
  CanvasRuntimePointerInteraction,
  CanvasRuntimePointerModifiers,
  CanvasRuntimeSnapshot
} from './runtime/CanvasEditorRuntime';
import {
  canvasFeedbackLocalToolsetForMediaKind,
  type CanvasFeedbackNodeBarTarget,
  type CanvasFeedbackSelectionBarTarget,
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
import type { CanvasSceneSnapshot } from './CanvasScenePresentation';
import type { CanvasCamera } from './runtime/canvasCamera';
import type { CanvasPreviewResourceInteractionState } from './CanvasPreviewResourceScheduler';
import type { CanvasCullingCounts } from './CanvasCullingController.js';
import type { CanvasRenderLifecycle } from './CanvasRenderLifecycle.js';

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

export function pointerEventModifiers(
  event: Pick<React.PointerEvent<Element>, 'shiftKey' | 'metaKey' | 'ctrlKey'>,
  platform: DebruteProductPlatform
): CanvasRuntimePointerModifiers {
  return {
    shiftKey: event.shiftKey,
    metaKey: platform === 'darwin' && event.metaKey,
    ctrlKey: platform !== 'darwin' && event.ctrlKey
  };
}

export function isCanvasPrimaryPointerEvent(
  event: Pick<React.PointerEvent<Element>, 'button' | 'ctrlKey'>,
  platform: DebruteProductPlatform
): boolean {
  return event.button === 0 && !(platform === 'darwin' && event.ctrlKey);
}

export interface CanvasPerfRuntimeSession {
  sessionId: CanvasPerfSessionId;
  lastFrameTimestamp: number;
  reactCommitCount: number;
  counterTotals: CanvasPerfCounterTotals;
  pointerInteractionActivated?: boolean | undefined;
}

export interface CanvasPerfDebugSnapshotContext {
  canvasId: string;
  runtime: Pick<CanvasEditorRuntime, 'getSnapshot'>;
  resourceZoom: number;
  renderSnapshot: CanvasSceneSnapshot;
  renderLifecycle: Pick<CanvasRenderLifecycle, 'getCullingCounts'>;
  surfaceElement: HTMLElement | null;
}

const STAGE_WRITE_COUNTERS = [
  'stage-camera-write',
  'stage-node-layout-write',
  'stage-node-visibility-write',
  'stage-edge-visibility-write',
  'stage-edge-geometry-write'
] as const satisfies readonly CanvasPerfCounterName[];

const RASTER_PREVIEW_WORK_COUNTERS = [
  'raster-preview-requested',
  'raster-preview-pending-mounted',
  'raster-preview-decoded',
  'raster-preview-published',
  'raster-preview-failed',
  'raster-preview-retried'
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

export function syncCanvasPerfPointerInteractionSessionState(input: {
  perfMonitor: CanvasPerfMonitor | undefined;
  sessionRef: { current: CanvasPerfRuntimeSession | undefined };
  reactCommitCountRef: { current: number };
  pointerInteraction: CanvasRuntimePointerInteraction | undefined;
  snapshot: Pick<CanvasRuntimeSnapshot, 'cameraState' | 'camera'>;
  finalState?: Partial<CanvasPerfFinalState> | undefined;
}): void {
  const perfMonitor = input.perfMonitor;
  if (!perfMonitor) {
    return;
  }
  const timestamp = canvasPerfTimestamp();
  if (input.pointerInteraction) {
    if (!input.sessionRef.current) {
      const sessionId = perfMonitor.startSession({
        type: input.pointerInteraction.kind === 'selection-marquee'
          ? 'pointer-selection'
          : input.pointerInteraction.kind === 'move-node'
            ? 'pointer-move-node'
            : 'pointer-resize-node',
        timestamp,
        source: 'CanvasSurface',
        detail: canvasPerfPointerInteractionSessionDetail(input.pointerInteraction)
      });
      input.sessionRef.current = {
        sessionId,
        lastFrameTimestamp: timestamp,
        reactCommitCount: input.reactCommitCountRef.current,
        counterTotals: perfMonitor.getCounterTotals(),
        pointerInteractionActivated: input.pointerInteraction.phase === 'active'
      };
    } else if (input.pointerInteraction.phase === 'active') {
      input.sessionRef.current.pointerInteractionActivated = true;
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
      },
      detail: { activated: session.pointerInteractionActivated === true }
    });
    input.sessionRef.current = undefined;
  }
}

export function recordCanvasPerfFrame(input: {
  perfMonitor: CanvasPerfMonitor | undefined;
  sessionRef: { current: CanvasPerfRuntimeSession | undefined };
  cameraState: CanvasRuntimeSnapshot['cameraState'];
  renderSnapshot: CanvasSceneSnapshot;
  cullingCounts: CanvasCullingCounts;
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
    visibleNodeCount: input.cullingCounts.displayVisibleNodeCount,
    culledNodeCount: input.cullingCounts.culledNodeCount,
    reactCommitCount,
    renderSnapshotBuildCount: counterDelta(counterTotals, session.counterTotals, 'render-snapshot-build'),
    renderSnapshotReuseCount: counterDelta(counterTotals, session.counterTotals, 'render-snapshot-reuse'),
    stageWriteCount: counterDeltaSum(counterTotals, session.counterTotals, STAGE_WRITE_COUNTERS),
    rasterPreviewWorkCount: counterDeltaSum(counterTotals, session.counterTotals, RASTER_PREVIEW_WORK_COUNTERS)
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

function canvasPerfPointerInteractionSessionDetail(state: CanvasRuntimePointerInteraction): Record<string, unknown> {
  if (state.kind === 'selection-marquee') {
    return {
      pointerId: state.pointerId,
      phase: state.phase
    };
  }
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
  renderSnapshot: CanvasSceneSnapshot;
  cullingCounts: CanvasCullingCounts;
}): CanvasPerfFinalState {
  return {
    mountedNodeCount: input.renderSnapshot.nodesByPath.size,
    visibleNodeCount: input.cullingCounts.displayVisibleNodeCount,
    culledNodeCount: input.cullingCounts.culledNodeCount,
    zoomLevel: input.snapshot.camera.z,
    cameraState: input.snapshot.cameraState
  };
}

export function canvasPerfDebugSnapshot(input: CanvasPerfDebugSnapshotContext): DebruteCanvasPerfCanvasSnapshot {
  const snapshot = input.runtime.getSnapshot();
  const mountedNodeCount = input.renderSnapshot.nodesByPath.size;
  const cullingCounts = input.renderLifecycle.getCullingCounts();
  return {
    canvasId: input.canvasId,
    camera: { ...snapshot.camera },
    cameraState: snapshot.cameraState,
    mountedNodeCount,
    visibleNodeCount: cullingCounts.displayVisibleNodeCount,
    culledNodeCount: cullingCounts.culledNodeCount,
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
  for (const image of surfaceElement?.querySelectorAll<HTMLImageElement>(
    '[data-canvas-raster-preview-kind="image"]'
  ) ?? []) {
    const layer = image.getAttribute('data-canvas-raster-preview-layer');
    if (layer === 'visible') {
      counts.visible += 1;
    } else if (layer === 'pending') {
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

export function canvasPreviewResourceInteractionState(
  snapshot: Pick<CanvasRuntimeSnapshot, 'cameraState' | 'pointerInteraction'>
): CanvasPreviewResourceInteractionState {
  return {
    cameraState: snapshot.cameraState,
    pointerInteractionActive: snapshot.pointerInteraction !== undefined
  };
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
  canStartVideoMomentFeedback?: boolean | undefined;
  startVideoMomentFeedback?: ((mode: 'comment' | 'pin' | 'rect') => void) | undefined;
  seekToMoment?: ((seconds: number) => void) | undefined;
}): CanvasFeedbackNodeBarTarget {
  return {
    kind: 'node',
    projectRelativePath: input.node.projectRelativePath,
    anchorRect: nodeRectForFloatingBar(input.node),
    surfaceRect: input.surfaceRect,
    camera: input.camera,
    localToolset: canvasFeedbackLocalToolsetForMediaKind(input.node.mediaKind),
    canStartVideoMomentFeedback: input.canStartVideoMomentFeedback ?? false,
    startVideoMomentFeedback: input.startVideoMomentFeedback,
    seekToMoment: input.seekToMoment
  };
}

export function canvasFeedbackBarTargetForSelection(input: {
  projectRelativePaths: readonly string[];
  nodes: readonly ProjectedCanvasNode[];
  surfaceRect: FloatingBarRect;
  camera: CanvasCamera;
}): CanvasFeedbackSelectionBarTarget | undefined {
  if (input.projectRelativePaths.length < 2) {
    return undefined;
  }
  const nodesByPath = new Map(input.nodes.map((node) => [node.projectRelativePath, node]));
  const selectedNodes = input.projectRelativePaths.map((path) => nodesByPath.get(path));
  if (selectedNodes.some((node) => !node)) {
    return undefined;
  }
  const first = selectedNodes[0]!;
  let left = first.x;
  let top = first.y;
  let right = first.x + first.width;
  let bottom = first.y + first.height;
  for (const node of selectedNodes.slice(1)) {
    left = Math.min(left, node!.x);
    top = Math.min(top, node!.y);
    right = Math.max(right, node!.x + node!.width);
    bottom = Math.max(bottom, node!.y + node!.height);
  }
  return {
    kind: 'selection',
    projectRelativePaths: [...input.projectRelativePaths],
    anchorRect: {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top
    },
    surfaceRect: input.surfaceRect,
    camera: input.camera
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

export function canvasActiveVideoPaths(input: {
  nodes: readonly ProjectedCanvasNode[];
  contentActiveProjectRelativePaths: readonly string[];
  playingVideoPaths: ReadonlySet<string>;
  requestedVideoPlayerPath: string | undefined;
}): ReadonlySet<string> {
  const videoPaths = new Set(input.nodes.filter(isProjectedVideoNode).map((node) => node.projectRelativePath));
  const active = new Set<string>();
  for (const projectRelativePath of input.contentActiveProjectRelativePaths) {
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
