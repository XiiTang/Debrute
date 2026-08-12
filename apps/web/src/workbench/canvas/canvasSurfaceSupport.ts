import type React from 'react';
import type { DebruteProductPlatform } from '@debrute/app-protocol';
import type { ProjectedCanvasNode } from './CanvasScene';
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
import type { DebruteCanvasPerfCanvasSnapshot } from './CanvasPerfDebugBridge';
import {
  type CanvasPerfFinalState,
  type CanvasPerfMonitor,
  type CanvasPerfSessionId,
  type CanvasPerfSessionType
} from './CanvasPerfMonitor';
import type { CanvasSceneSnapshot } from './CanvasScenePresentation';
import type { CanvasCamera, CanvasCameraChangeOrigin } from './runtime/canvasCamera';
import type { CanvasPreviewResourceInteractionState } from './CanvasPreviewResourceScheduler';
import type { CanvasCullingCounts } from './CanvasCullingController';
import type { CanvasRenderLifecycle } from './CanvasRenderLifecycle';

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
  sessionType: CanvasPerfSessionType;
  pointerInteractionActivated?: boolean | undefined;
}

export interface CanvasPerfDebugSnapshotContext {
  runtime: Pick<CanvasEditorRuntime, 'getSnapshot'>;
  getResourceZoom(): number;
  renderSnapshot: CanvasSceneSnapshot;
  renderLifecycle: Pick<CanvasRenderLifecycle, 'getCullingCounts'>;
  surfaceElement: HTMLElement | null;
}

export function attachCanvasCameraPerformanceBeforeRender(input: {
  runtime: Pick<CanvasEditorRuntime, 'subscribeCamera'>;
  renderLifecycle: Pick<CanvasRenderLifecycle, 'attach'>;
  onCameraBeforeRender(camera: CanvasCamera, origin: CanvasCameraChangeOrigin): void;
}): () => void {
  const unsubscribeCamera = input.runtime.subscribeCamera(input.onCameraBeforeRender);
  let detachRenderLifecycle: () => void;
  try {
    detachRenderLifecycle = input.renderLifecycle.attach();
  } catch (error) {
    unsubscribeCamera();
    throw error;
  }
  return () => {
    detachRenderLifecycle();
    unsubscribeCamera();
  };
}

export function syncCanvasPerfSessionState(input: {
  perfMonitor: CanvasPerfMonitor | undefined;
  sessionRef: { current: CanvasPerfRuntimeSession | undefined };
  snapshot: Pick<CanvasRuntimeSnapshot, 'cameraState' | 'camera'>;
  origin: CanvasCameraChangeOrigin;
  getFinalState?: (() => Partial<CanvasPerfFinalState>) | undefined;
}): void {
  const perfMonitor = input.perfMonitor;
  if (!perfMonitor) {
    return;
  }
  const sessionType = input.snapshot.cameraState === 'moving'
    ? canvasPerfCameraSessionType(input.origin)
    : undefined;
  const session = input.sessionRef.current;
  if (session?.sessionType === sessionType || (!session && !sessionType)) {
    return;
  }
  const timestamp = canvasPerfTimestamp();
  if (session) {
    perfMonitor.endSession({
      sessionId: session.sessionId,
      timestamp,
      source: 'CanvasSurface',
      finalState: {
        zoomLevel: input.snapshot.camera.z,
        cameraState: input.snapshot.cameraState,
        ...input.getFinalState?.()
      }
    });
    input.sessionRef.current = undefined;
  }
  if (sessionType) {
    const sessionId = perfMonitor.startSession({
      type: sessionType,
      timestamp,
      source: 'CanvasSurface',
      detail: { zoomLevel: input.snapshot.camera.z }
    });
    input.sessionRef.current = { sessionId, sessionType };
  }
}

export function syncCanvasPerfPointerInteractionSessionState(input: {
  perfMonitor: CanvasPerfMonitor | undefined;
  sessionRef: { current: CanvasPerfRuntimeSession | undefined };
  pointerInteraction: CanvasRuntimePointerInteraction | undefined;
  snapshot: Pick<CanvasRuntimeSnapshot, 'cameraState' | 'camera'>;
  getFinalState?: (() => Partial<CanvasPerfFinalState>) | undefined;
}): void {
  const perfMonitor = input.perfMonitor;
  if (!perfMonitor) {
    return;
  }
  const timestamp = canvasPerfTimestamp();
  if (input.pointerInteraction) {
    if (!input.sessionRef.current) {
      const sessionType = input.pointerInteraction.kind === 'selection-marquee'
          ? 'pointer-selection'
          : input.pointerInteraction.kind === 'move-node'
            ? 'pointer-move-node'
            : 'pointer-resize-node';
      const sessionId = perfMonitor.startSession({
        type: sessionType,
        timestamp,
        source: 'CanvasSurface',
        detail: canvasPerfPointerInteractionSessionDetail(input.pointerInteraction)
      });
      input.sessionRef.current = {
        sessionId,
        sessionType,
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
        ...input.getFinalState?.()
      },
      detail: { activated: session.pointerInteractionActivated === true }
    });
    input.sessionRef.current = undefined;
  }
}

function canvasPerfCameraSessionType(
  origin: CanvasCameraChangeOrigin
): Extract<CanvasPerfSessionType, 'camera-pan' | 'camera-zoom' | 'camera-minimap'> | undefined {
  switch (origin) {
    case 'pan':
      return 'camera-pan';
    case 'zoom':
      return 'camera-zoom';
    case 'minimap':
      return 'camera-minimap';
    case 'programmatic':
      return undefined;
  }
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
    camera: { ...snapshot.camera },
    cameraState: snapshot.cameraState,
    mountedNodeCount,
    visibleNodeCount: cullingCounts.displayVisibleNodeCount,
    culledNodeCount: cullingCounts.culledNodeCount,
    resourceZoom: input.getResourceZoom(),
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
