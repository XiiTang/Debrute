import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CanvasSettingsView } from '@debrute/app-protocol';
import type { CanvasDocument, CanvasFeedbackDocument, CanvasProjection, ProjectedCanvasNode } from '@debrute/canvas-core';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import type { WorkbenchContextMenuPosition, WorkbenchContextMenuTarget } from '../shell/contextMenu';
import {
  buildResizeGeometry,
  isAdditiveCanvasSelectionModifier,
  type CanvasPoint,
  type ResizeHandle
} from '../services/canvasInteraction';
import {
  canvasNodeToViewportRect,
  placeCanvasFeedbackBar,
  type CanvasFeedbackBarTarget,
  type FloatingBarRect
} from '../shell/floatingBars';
import { cameraForCanvasContent } from './CanvasCameraBounds';
import { CANVAS_IMAGE_PREVIEW_RESOURCE_SETTLE_MS } from './canvasImagePreviews';
import { createCanvasImageAssetRuntime, type CanvasImageAssetRuntime } from './CanvasImageAssetRuntime';
import { CanvasImageAssetProvider } from './CanvasImageResourceContext';
import { CanvasNodeShell } from './CanvasNodeShell';
import type { CanvasOverlayRuntime } from './CanvasOverlayRuntime';
import { createCanvasPerfMonitor, type CanvasPerfMonitor } from './CanvasPerfMonitor';
import { createCanvasRenderCoordinator, type CanvasRenderCoordinatorSnapshot, type CanvasRenderCoordinatorUpdateInput } from './CanvasRenderCoordinator';
import { nodeRect } from './canvasVirtualization';
import type {
  CanvasEditorRuntime,
  CanvasRuntimeDragState,
  CanvasRuntimePointerModifiers,
  CanvasRuntimeSnapshot
} from './runtime/CanvasEditorRuntime';
import { createCanvasStageRuntime, type CanvasStageRuntime } from './runtime/CanvasStageRuntime';
import { rectsIntersect, type CanvasRect } from './runtime/canvasGeometry';
import type { CanvasSelection } from './runtime/canvasSelection';
import { isCanvasItemSelected, toggleCanvasSelectionItem } from './runtime/canvasSelection';
import {
  useCanvasDragState,
  useCanvasImageResourceZoom,
  useCanvasSelection,
  useCanvasSurfaceSize
} from './runtime/useCanvasRuntimeSnapshot';

interface CanvasSurfaceProps {
  canvas: CanvasDocument;
  projection: CanvasProjection;
  runtime: CanvasEditorRuntime;
  actions: WorkbenchActions;
  textFileBuffers: Record<string, TextFileBuffer>;
  canvasFeedback: CanvasFeedbackDocument | undefined;
  canvasSettings: CanvasSettingsView;
  imageAssetRuntime?: CanvasImageAssetRuntime | undefined;
  overlayRuntime: CanvasOverlayRuntime;
  minimapOpen?: boolean | undefined;
  feedbackPlacementContext: {
    viewportRect: FloatingBarRect;
    reservedRects: readonly FloatingBarRect[];
  };
  onFeedbackBarTargetChange?: ((target: CanvasFeedbackBarTarget | undefined) => void) | undefined;
  onOpenContextMenu?: ((target: WorkbenchContextMenuTarget, position: WorkbenchContextMenuPosition) => void) | undefined;
}

export function CanvasSurface({
  canvas,
  projection,
  runtime,
  actions,
  textFileBuffers,
  canvasFeedback,
  canvasSettings,
  imageAssetRuntime,
  overlayRuntime,
  minimapOpen,
  feedbackPlacementContext,
  onFeedbackBarTargetChange,
  onOpenContextMenu
}: CanvasSurfaceProps): React.ReactElement {
  const [imageAssetRuntimeState, setImageAssetRuntimeState] = useState<{
    canvasId: string;
    runtime: CanvasImageAssetRuntime;
  }>();

  useEffect(() => {
    if (imageAssetRuntime) {
      setImageAssetRuntimeState(undefined);
      return;
    }
    const runtime = createCanvasImageAssetRuntime();
    setImageAssetRuntimeState({
      canvasId: canvas.id,
      runtime
    });
    return () => {
      runtime.dispose();
    };
  }, [canvas.id, imageAssetRuntime]);

  const activeImageAssetRuntime = imageAssetRuntime
    ?? (imageAssetRuntimeState?.canvasId === canvas.id ? imageAssetRuntimeState.runtime : undefined);

  if (!activeImageAssetRuntime) {
    return (
      <div className="canvas-surface" data-testid="canvas-surface">
        <div className="canvas-world-stage" />
      </div>
    );
  }

  return (
    <CanvasSurfaceRuntime
      canvas={canvas}
      projection={projection}
      runtime={runtime}
      actions={actions}
      textFileBuffers={textFileBuffers}
      canvasFeedback={canvasFeedback}
      canvasSettings={canvasSettings}
      imageAssetRuntime={activeImageAssetRuntime}
      overlayRuntime={overlayRuntime}
      minimapOpen={minimapOpen}
      feedbackPlacementContext={feedbackPlacementContext}
      onFeedbackBarTargetChange={onFeedbackBarTargetChange}
      onOpenContextMenu={onOpenContextMenu}
    />
  );
}

function CanvasSurfaceRuntime({
  canvas,
  projection,
  runtime,
  actions,
  textFileBuffers,
  canvasFeedback,
  canvasSettings,
  imageAssetRuntime,
  overlayRuntime,
  minimapOpen,
  feedbackPlacementContext,
  onFeedbackBarTargetChange,
  onOpenContextMenu
}: CanvasSurfaceProps & {
  imageAssetRuntime: CanvasImageAssetRuntime;
}): React.ReactElement {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const selection = useCanvasSelection(runtime);
  const surfaceSize = useCanvasSurfaceSize(runtime);
  const imageResourceZoom = useCanvasImageResourceZoom(runtime);
  const dragState = useCanvasDragState(runtime);
  const selectionRef = useRef<CanvasSelection | undefined>(selection);
  const surfaceSizeRef = useRef(surfaceSize);
  const renderSnapshotRef = useRef<CanvasRenderCoordinatorSnapshot | undefined>(undefined);
  const activeNodePathsRef = useRef<string[]>(activeNodeProjectRelativePaths(dragState));
  const activeNodePathKeyRef = useRef(activeNodePathsRef.current.join('\u001f'));
  const imageResourceZoomTimerRef = useRef<number | undefined>(undefined);
  const fittedCanvasIdRef = useRef<string | undefined>(undefined);
  const canvasPerfSessionRef = useRef<CanvasPerfRuntimeSession | undefined>(undefined);
  const reactCommitCountRef = useRef(0);
  const [hoveredNodePath, setHoveredNodePath] = useState<string>();

  const projectedNodes = projection.nodes;
  const devicePixelRatio = devicePixelRatioValue();
  const perfMonitorEnabled = canvasPerfMonitorEnabled();
  const stageRuntime = useMemo(() => createCanvasStageRuntime(), [runtime]);
  const perfMonitor = useMemo(() => createCanvasPerfMonitor({ enabled: perfMonitorEnabled }), [perfMonitorEnabled]);
  const renderCoordinator = useMemo(() => createCanvasRenderCoordinator(projection), [projection]);
  const initialRenderSnapshot = useMemo(() => renderCoordinator.update({
    camera: runtime.getSnapshot().camera,
    cameraState: runtime.getSnapshot().cameraState,
    surfaceSize: runtime.getSnapshot().surfaceSize,
    selection: runtime.getSnapshot().selection,
    activeNodePaths: activeNodePathsRef.current
  }), [renderCoordinator, runtime]);
  const [renderSnapshot, setRenderSnapshot] = useState(initialRenderSnapshot);

  selectionRef.current = selection;
  surfaceSizeRef.current = surfaceSize;

  useEffect(() => {
    reactCommitCountRef.current += 1;
  });

  const commitRenderSnapshot = useCallback((input: {
    camera: CanvasRuntimeSnapshot['camera'];
    cameraState: CanvasRuntimeSnapshot['cameraState'];
    surfaceSize: CanvasRuntimeSnapshot['surfaceSize'];
    selection: CanvasRuntimeSnapshot['selection'];
    activeNodePaths: readonly string[];
  }) => {
    const next = renderCoordinator.update(input);
    if (next === renderSnapshotRef.current) {
      return;
    }
    renderSnapshotRef.current = next;
    setRenderSnapshot(next);
  }, [renderCoordinator]);
  const renderSnapshotScheduler = useMemo(() => createCanvasRenderSnapshotScheduler({
    commit: commitRenderSnapshot
  }), [commitRenderSnapshot]);

  const syncImageAssetViewport = useCallback((cameraState = runtime.getSnapshot().cameraState) => {
    syncCanvasImageAssetViewport({
      imageAssetRuntime,
      editorRuntime: runtime,
      nodesByPath: renderSnapshotRef.current?.nodesByPath ?? renderSnapshot.nodesByPath,
      imageResourceZoom,
      devicePixelRatio,
      imagePreviewsEnabled: canvasSettings.imagePreviewsEnabled,
      cameraState
    });
  }, [
    canvasSettings.imagePreviewsEnabled,
    devicePixelRatio,
    imageAssetRuntime,
    imageResourceZoom,
    renderSnapshot.nodesByPath,
    runtime
  ]);
  const imageAssetViewportScheduler = useMemo(() => createCanvasImageAssetViewportSyncScheduler({
    sync: syncImageAssetViewport
  }), [syncImageAssetViewport]);

  useEffect(() => {
    renderSnapshotRef.current = initialRenderSnapshot;
    setRenderSnapshot(initialRenderSnapshot);
  }, [initialRenderSnapshot]);

  useEffect(() => () => {
    stageRuntime.dispose();
  }, [stageRuntime]);

  useEffect(() => () => {
    imageAssetViewportScheduler.dispose();
  }, [imageAssetViewportScheduler]);

  useEffect(() => () => {
    renderSnapshotScheduler.dispose();
  }, [renderSnapshotScheduler]);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    const stage = stageRef.current;
    if (!surface || !stage) {
      return;
    }
    const unbindSurface = runtime.bindSurface({ surface });
    const unbindStage = stageRuntime.bindStage(stage);
    stageRuntime.setCamera(runtime.getSnapshot().camera);
    return () => {
      unbindStage();
      unbindSurface();
    };
  }, [stageRuntime, runtime]);

  useLayoutEffect(() => {
    syncCanvasStageNodeVisibility({
      stageRuntime,
      visibleRect: runtime.coordinates.visibleCanvasRect(),
      nodesByPath: renderSnapshot.nodesByPath
    });
  }, [stageRuntime, renderSnapshot.nodesByPath, runtime]);

  useEffect(() => {
    const snapshot = runtime.getSnapshot();
    commitRenderSnapshot({
      camera: snapshot.camera,
      cameraState: snapshot.cameraState,
      surfaceSize: snapshot.surfaceSize,
      selection: snapshot.selection,
      activeNodePaths: activeNodePathsRef.current
    });
  }, [commitRenderSnapshot, runtime, selection, surfaceSize]);

  useEffect(() => {
    if (
      fittedCanvasIdRef.current === canvas.id
      || !surfaceSize
      || surfaceSize.width <= 0
      || surfaceSize.height <= 0
    ) {
      return;
    }
    const camera = cameraForCanvasContent({
      nodes: projectedNodes,
      surfaceSize
    });
    if (camera) {
      fittedCanvasIdRef.current = canvas.id;
      runtime.camera.setCamera(camera);
    }
  }, [canvas.id, projectedNodes, runtime, surfaceSize]);

  useLayoutEffect(() => runtime.subscribeCamera((liveCamera) => {
    syncCanvasMovingCameraFrame({
      liveCamera,
      stageRuntime,
      runtime,
      nodesByPath: renderSnapshotRef.current?.nodesByPath ?? renderSnapshot.nodesByPath,
      surfaceSize: surfaceSizeRef.current,
      selection: selectionRef.current,
      activeNodePaths: activeNodePathsRef.current,
      renderSnapshotScheduler
    });
    recordCanvasPerfCameraFrame({
      enabled: perfMonitorEnabled,
      perfMonitor,
      sessionRef: canvasPerfSessionRef,
      renderSnapshot: renderSnapshotRef.current ?? renderSnapshot,
      imageAssetRuntime,
      reactCommitCountRef
    });
  }), [
    imageAssetRuntime,
    perfMonitor,
    perfMonitorEnabled,
    stageRuntime,
    renderSnapshot,
    renderSnapshot.nodesByPath,
    renderSnapshotScheduler,
    runtime
  ]);

  useEffect(() => {
    return runtime.subscribeCameraState((cameraState) => {
      syncCanvasPerfCameraSessionState({
        enabled: perfMonitorEnabled,
        perfMonitor,
        sessionRef: canvasPerfSessionRef,
        reactCommitCountRef,
        cameraState,
        minimapOpen: minimapOpen === true
      });
      if (cameraState !== 'idle') {
        return;
      }
      imageAssetViewportScheduler.flush(cameraState);
      const snapshot = runtime.getSnapshot();
      renderSnapshotScheduler.flush({
        camera: snapshot.camera,
        cameraState,
        surfaceSize: surfaceSizeRef.current,
        selection: selectionRef.current,
        activeNodePaths: activeNodePathsRef.current
      });
    });
  }, [
    imageAssetViewportScheduler,
    minimapOpen,
    perfMonitor,
    perfMonitorEnabled,
    renderSnapshotScheduler,
    runtime
  ]);

  useEffect(() => {
    stageRuntime.applyDragPreview(runtime.getSnapshot().dragState);
    return runtime.subscribeDragState((nextDragState) => {
      stageRuntime.applyDragPreview(nextDragState);
      const nextActivePaths = activeNodeProjectRelativePaths(nextDragState);
      const nextKey = nextActivePaths.join('\u001f');
      if (nextKey === activeNodePathKeyRef.current) {
        return;
      }
      activeNodePathKeyRef.current = nextKey;
      activeNodePathsRef.current = nextActivePaths;
      const snapshot = runtime.getSnapshot();
      commitRenderSnapshot({
        camera: snapshot.camera,
        cameraState: snapshot.cameraState,
        surfaceSize: surfaceSizeRef.current,
        selection: selectionRef.current,
        activeNodePaths: nextActivePaths
      });
    });
  }, [commitRenderSnapshot, stageRuntime, runtime]);

  useEffect(() => {
    if (imageResourceZoomTimerRef.current !== undefined) {
      window.clearTimeout(imageResourceZoomTimerRef.current);
      imageResourceZoomTimerRef.current = undefined;
    }
    runtime.setImageResourceZoom(runtime.getSnapshot().camera.z);
  }, [canvas.id, runtime]);

  useEffect(() => () => {
    if (imageResourceZoomTimerRef.current !== undefined) {
      window.clearTimeout(imageResourceZoomTimerRef.current);
    }
  }, []);

  useEffect(() => {
    return runtime.subscribeCameraState((cameraState) => {
      const snapshot = runtime.getSnapshot();
      syncCanvasImageResourceZoomForCameraState({
        cameraState,
        imagePreviewsEnabled: canvasSettings.imagePreviewsEnabled,
        currentImageResourceZoom: snapshot.imageResourceZoom,
        liveCameraZoom: snapshot.camera.z,
        timerRef: imageResourceZoomTimerRef,
        setImageResourceZoom: (zoom) => runtime.setImageResourceZoom(zoom),
        setTimeout: (callback, delay) => window.setTimeout(callback, delay),
        clearTimeout: (handle) => window.clearTimeout(handle)
      });
    });
  }, [canvasSettings.imagePreviewsEnabled, runtime]);

  useEffect(() => {
    imageAssetRuntime.setNodes(renderSnapshot.nodesByPath);
  }, [imageAssetRuntime, renderSnapshot.nodesByPath]);

  useEffect(() => {
    imageAssetViewportScheduler.flush();
  }, [imageAssetViewportScheduler]);

  const pointerCanvasPoint = useCallback((event: Pick<React.PointerEvent<Element> | React.DragEvent<Element>, 'clientX' | 'clientY'>): CanvasPoint => (
    runtime.coordinates.screenToCanvas({ x: event.clientX, y: event.clientY })
  ), [runtime]);

  const beginNodeMove = useCallback((node: ProjectedCanvasNode, event: React.PointerEvent<Element>) => {
    if (node.locked) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const item = { kind: 'node' as const, projectRelativePath: node.projectRelativePath };
    const currentSelection = selectionRef.current;
    const nextSelection = isAdditiveCanvasSelectionModifier(event)
      ? toggleCanvasSelectionItem(selectionRef.current, item)
      : isCanvasItemSelected(currentSelection, item)
        ? currentSelection
        : item;
    if (!nextSelection) {
      runtime.setSelection(undefined);
      return;
    }
    runtime.setSelection(nextSelection);
    runtime.input.beginNodeMove({
      pointerId: event.pointerId,
      node,
      start: pointerCanvasPoint(event),
      selection: nextSelection,
      nodes: projectedNodes
    });
  }, [pointerCanvasPoint, projectedNodes, runtime]);

  const beginNodeResize = useCallback((node: ProjectedCanvasNode, handle: ResizeHandle, event: React.PointerEvent<HTMLButtonElement>) => {
    if (node.locked) {
      return;
    }
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const resizeNode = node.mediaKind === undefined
      ? { projectRelativePath: node.projectRelativePath }
      : { projectRelativePath: node.projectRelativePath, mediaKind: node.mediaKind };
    runtime.input.beginNodeResize({
      pointerId: event.pointerId,
      handle,
      start: pointerCanvasPoint(event),
      node: resizeNode,
      origin: {
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height
      },
      modifiers: pointerEventModifiers(event)
    });
    runtime.setSelection({ kind: 'node', projectRelativePath: node.projectRelativePath });
  }, [pointerCanvasPoint, runtime]);

  const handlePointerMove = useCallback((event: React.PointerEvent<Element>) => {
    runtime.input.updatePointer({
      pointerId: event.pointerId,
      point: pointerCanvasPoint(event),
      modifiers: pointerEventModifiers(event)
    });
  }, [pointerCanvasPoint, runtime]);

  const handlePointerUp = useCallback(async (event: React.PointerEvent<Element>) => {
    const point = pointerCanvasPoint(event);
    const activeDragState = runtime.input.finishPointer({
      pointerId: event.pointerId,
      point,
      modifiers: pointerEventModifiers(event)
    });
    if (!activeDragState) {
      return;
    }
    if (activeDragState.kind === 'move-node') {
      const delta = {
        dx: point.x - activeDragState.start.x,
        dy: point.y - activeDragState.start.y
      };
      const nodeLayouts = activeDragState.origins.map((origin) => ({
        projectRelativePath: origin.projectRelativePath,
        x: origin.x + delta.dx,
        y: origin.y + delta.dy,
        width: origin.width,
        height: origin.height
      }));
      if (nodeLayouts.length > 0) {
        await actions.updateCanvasNodeLayouts(canvas.id, { nodeLayouts });
      }
    } else {
      const delta = {
        dx: point.x - activeDragState.start.x,
        dy: point.y - activeDragState.start.y
      };
      const next = buildResizeGeometry(
        activeDragState.handle,
        activeDragState.origin,
        { x: delta.dx, y: delta.dy },
        activeDragState.preserveAspect
      );
      await actions.updateCanvasNodeLayouts(canvas.id, {
        nodeLayouts: [{
          projectRelativePath: activeDragState.node.projectRelativePath,
          x: next.x,
          y: next.y,
          width: next.width,
          height: next.height
        }]
      });
    }
  }, [actions, canvas.id, pointerCanvasPoint, runtime]);

  const handlePointerUpEvent = useCallback((event: React.PointerEvent<Element>) => {
    void handlePointerUp(event);
  }, [handlePointerUp]);

  const selectNode = useCallback((node: ProjectedCanvasNode) => {
    runtime.setSelection({ kind: 'node', projectRelativePath: node.projectRelativePath });
  }, [runtime]);

  const handleNodePointerEnter = useCallback((node: ProjectedCanvasNode) => {
    setHoveredNodePath(node.projectRelativePath);
  }, []);

  const handleNodePointerLeave = useCallback((node: ProjectedCanvasNode) => {
    setHoveredNodePath((current) => current === node.projectRelativePath ? undefined : current);
  }, []);

  const handleNodeContextMenu = useCallback((node: ProjectedCanvasNode, event: React.MouseEvent<Element>) => {
    event.preventDefault();
    event.stopPropagation();
    runtime.setSelection({ kind: 'node', projectRelativePath: node.projectRelativePath });
    onOpenContextMenu?.({
      source: 'canvas',
      kind: node.nodeKind,
      projectRelativePath: node.projectRelativePath
    }, {
      x: event.clientX,
      y: event.clientY
    });
  }, [onOpenContextMenu, runtime]);

  const renderedNodes = [...renderSnapshot.nodesByPath.values()];

  const syncFeedbackBarPlacement = useCallback((input: {
    node: ProjectedCanvasNode;
    surfaceRect: DOMRect;
    camera: CanvasRuntimeSnapshot['camera'];
  }) => {
    const nodeViewportRect = canvasNodeToViewportRect({
      nodeRect: nodeRectForFloatingBar(input.node),
      surfaceRect: domRectToFloatingBarRect(input.surfaceRect),
      camera: input.camera
    });
    const placement = placeCanvasFeedbackBar({
      nodeViewportRect,
      viewportRect: feedbackPlacementContext.viewportRect,
      reservedRects: [...feedbackPlacementContext.reservedRects]
    });
    if (placement) {
      overlayRuntime.setFeedbackBarPlacement(placement);
    } else {
      overlayRuntime.clearFeedbackBarPlacement();
    }
  }, [feedbackPlacementContext.reservedRects, feedbackPlacementContext.viewportRect, overlayRuntime]);

  const emitFeedbackBarTarget = useCallback(() => {
    if (!onFeedbackBarTargetChange || !canvasFeedback || !hoveredNodePath) {
      onFeedbackBarTargetChange?.(undefined);
      overlayRuntime.clearFeedbackBarPlacement();
      return;
    }

    const node = projectedNodes.find((item) => item.projectRelativePath === hoveredNodePath);
    const surfaceRect = surfaceRef.current?.getBoundingClientRect();
    if (!node || node.nodeKind !== 'file' || node.visible === false || !surfaceRect) {
      onFeedbackBarTargetChange(undefined);
      overlayRuntime.clearFeedbackBarPlacement();
      return;
    }

    const camera = runtime.getSnapshot().camera;
    syncFeedbackBarPlacement({ node, surfaceRect, camera });
    onFeedbackBarTargetChange({
      projectRelativePath: node.projectRelativePath,
      nodeRect: nodeRectForFloatingBar(node),
      surfaceRect: domRectToFloatingBarRect(surfaceRect),
      camera,
      entry: canvasFeedback.entries[node.projectRelativePath]
    });
  }, [
    canvasFeedback,
    hoveredNodePath,
    onFeedbackBarTargetChange,
    overlayRuntime,
    projectedNodes,
    runtime,
    syncFeedbackBarPlacement
  ]);

  useEffect(() => {
    emitFeedbackBarTarget();
  }, [emitFeedbackBarTarget, surfaceSize]);

  useEffect(() => {
    if (!hoveredNodePath || !onFeedbackBarTargetChange) {
      return;
    }
    return runtime.subscribeCamera((camera) => {
      const node = projectedNodes.find((item) => item.projectRelativePath === hoveredNodePath);
      const surfaceRect = surfaceRef.current?.getBoundingClientRect();
      if (!node || node.nodeKind !== 'file' || node.visible === false || !surfaceRect) {
        overlayRuntime.clearFeedbackBarPlacement();
        return;
      }
      syncFeedbackBarPlacement({ node, surfaceRect, camera });
    });
  }, [
    hoveredNodePath,
    onFeedbackBarTargetChange,
    overlayRuntime,
    projectedNodes,
    runtime,
    syncFeedbackBarPlacement
  ]);

  useEffect(() => () => {
    onFeedbackBarTargetChange?.(undefined);
    overlayRuntime.clearFeedbackBarPlacement();
  }, [onFeedbackBarTargetChange, overlayRuntime]);

  return (
    <div
      ref={surfaceRef}
      className="canvas-surface"
      data-testid="canvas-surface"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          runtime.setSelection(undefined);
        }
      }}
    >
      <div
        ref={stageRef}
        className="canvas-world-stage"
      >
        <svg
          className="canvas-edge-layer"
          aria-hidden="true"
          viewBox={renderSnapshot.svgViewBox}
          style={{
            left: renderSnapshot.svgBounds.x,
            top: renderSnapshot.svgBounds.y,
            width: renderSnapshot.svgBounds.width,
            height: renderSnapshot.svgBounds.height
          }}
        >
          {renderSnapshot.edges.map((edge) => (
            <path
              key={edge.id}
              data-canvas-edge-id={edge.id}
              className="canvas-edge"
              d={edge.path}
            />
          ))}
        </svg>
        <CanvasImageAssetProvider runtime={imageAssetRuntime}>
          {renderedNodes.map((node) => (
            <CanvasNodeShell
              key={node.projectRelativePath}
              node={node}
              selected={isCanvasItemSelected(selection, { kind: 'node', projectRelativePath: node.projectRelativePath })}
              hovered={hoveredNodePath === node.projectRelativePath}
              zIndex={renderSnapshot.nodeLayers.get(node.projectRelativePath)?.zIndex ?? node.z}
              stageRuntime={stageRuntime}
              actions={actions}
              textBuffer={textFileBuffers[node.projectRelativePath]}
              onPointerDown={beginNodeMove}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUpEvent}
              onPointerEnter={handleNodePointerEnter}
              onPointerLeave={handleNodePointerLeave}
              onSelectNode={selectNode}
              onContextMenu={handleNodeContextMenu}
              onResizePointerDown={beginNodeResize}
            />
          ))}
        </CanvasImageAssetProvider>
      </div>
      {projectedNodes.length === 0 ? (
        <div className="canvas-empty-state" data-testid="canvas-empty-state">
          <strong>No Flowmap nodes</strong>
        </div>
      ) : null}
    </div>
  );
}

function activeNodeProjectRelativePaths(state: CanvasRuntimeDragState | undefined): string[] {
  if (!state) {
    return [];
  }
  return state.kind === 'move-node'
    ? state.origins.map((origin) => origin.projectRelativePath)
    : [state.node.projectRelativePath];
}

function pointerEventModifiers(event: Pick<React.PointerEvent<Element>, 'shiftKey'>): CanvasRuntimePointerModifiers {
  return {
    shiftKey: event.shiftKey
  };
}

interface CanvasPerfRuntimeSession {
  lastFrameTimestamp: number;
  reactCommitCount: number;
}

function syncCanvasPerfCameraSessionState(input: {
  enabled: boolean;
  perfMonitor: CanvasPerfMonitor;
  sessionRef: { current: CanvasPerfRuntimeSession | undefined };
  reactCommitCountRef: { current: number };
  cameraState: CanvasRuntimeSnapshot['cameraState'];
  minimapOpen: boolean;
}): void {
  if (!input.enabled) {
    return;
  }
  const timestamp = canvasPerfTimestamp();
  if (input.cameraState === 'moving') {
    if (!input.sessionRef.current) {
      input.sessionRef.current = {
        lastFrameTimestamp: timestamp,
        reactCommitCount: input.reactCommitCountRef.current
      };
      input.perfMonitor.startCameraSession({
        type: input.minimapOpen ? 'minimap' : 'panning',
        timestamp,
        minimapOpen: input.minimapOpen
      });
    }
    return;
  }
  if (input.sessionRef.current) {
    input.perfMonitor.endCameraSession({ timestamp });
    input.sessionRef.current = undefined;
  }
}

function recordCanvasPerfCameraFrame(input: {
  enabled: boolean;
  perfMonitor: CanvasPerfMonitor;
  sessionRef: { current: CanvasPerfRuntimeSession | undefined };
  renderSnapshot: CanvasRenderCoordinatorSnapshot;
  imageAssetRuntime: Pick<CanvasImageAssetRuntime, 'stats'>;
  reactCommitCountRef: { current: number };
}): void {
  if (!input.enabled || !input.sessionRef.current) {
    return;
  }
  const timestamp = canvasPerfTimestamp();
  const session = input.sessionRef.current;
  const elapsedMs = Math.max(0, timestamp - session.lastFrameTimestamp);
  const reactCommitCount = Math.max(0, input.reactCommitCountRef.current - session.reactCommitCount);
  const imageStats = input.imageAssetRuntime.stats();
  session.lastFrameTimestamp = timestamp;
  session.reactCommitCount = input.reactCommitCountRef.current;
  input.perfMonitor.recordFrame({
    elapsedMs,
    mountedNodeCount: input.renderSnapshot.nodesByPath.size,
    visibleNodeCount: Math.max(0, input.renderSnapshot.nodesByPath.size - input.renderSnapshot.culledNodePaths.size),
    culledNodeCount: input.renderSnapshot.culledNodePaths.size,
    activeImageLoadCount: imageStats.activeLoadCount,
    pendingImageCount: imageStats.pendingImageCount,
    decodedImageCount: imageStats.decodedImageCount,
    reactCommitCount
  });
}

function canvasPerfTimestamp(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function canvasPerfMonitorEnabled(): boolean {
  const env = (import.meta as ImportMeta & {
    env?: {
      DEV?: boolean;
      MODE?: string;
    };
  }).env;
  return env?.DEV === true || env?.MODE === 'test';
}

export function syncCanvasImageAssetViewport(input: {
  imageAssetRuntime: Pick<CanvasImageAssetRuntime, 'setViewport'>;
  editorRuntime: Pick<CanvasEditorRuntime, 'coordinates' | 'getSnapshot'>;
  nodesByPath: ReadonlyMap<string, ProjectedCanvasNode>;
  imageResourceZoom: number;
  devicePixelRatio: number;
  imagePreviewsEnabled: boolean;
  cameraState?: CanvasRuntimeSnapshot['cameraState'];
}): void {
  const visibleRect = input.editorRuntime.coordinates.visibleCanvasRect();
  const mountedNodePaths = new Set(input.nodesByPath.keys());
  const culledNodePaths = new Set(
    [...input.nodesByPath.values()]
      .filter((node) => !rectsIntersect(visibleRect, nodeRect(node)))
      .map((node) => node.projectRelativePath)
  );
  input.imageAssetRuntime.setViewport({
    visibleRect,
    mountedNodePaths,
    culledNodePaths,
    imageResourceZoom: input.imageResourceZoom,
    devicePixelRatio: input.devicePixelRatio,
    imagePreviewsEnabled: input.imagePreviewsEnabled,
    cameraState: input.cameraState ?? input.editorRuntime.getSnapshot().cameraState
  });
}

export function syncCanvasStageNodeVisibility(input: {
  stageRuntime: Pick<CanvasStageRuntime, 'setNodeVisible'>;
  visibleRect: CanvasRect;
  nodesByPath: ReadonlyMap<string, ProjectedCanvasNode>;
}): void {
  for (const node of input.nodesByPath.values()) {
    input.stageRuntime.setNodeVisible(
      node.projectRelativePath,
      node.visible !== false && rectsIntersect(input.visibleRect, nodeRect(node))
    );
  }
}

export function syncCanvasMovingCameraFrame(input: {
  liveCamera: CanvasRuntimeSnapshot['camera'];
  stageRuntime: Pick<CanvasStageRuntime, 'setCamera' | 'setNodeVisible'>;
  runtime: Pick<CanvasEditorRuntime, 'coordinates' | 'getSnapshot'>;
  nodesByPath: ReadonlyMap<string, ProjectedCanvasNode>;
  surfaceSize: CanvasRuntimeSnapshot['surfaceSize'];
  selection: CanvasRuntimeSnapshot['selection'];
  activeNodePaths: readonly string[];
  renderSnapshotScheduler: Pick<ReturnType<typeof createCanvasRenderSnapshotScheduler<CanvasRenderCoordinatorUpdateInput>>, 'requestMoving'>;
}): void {
  input.stageRuntime.setCamera(input.liveCamera);
  syncCanvasStageNodeVisibility({
    stageRuntime: input.stageRuntime,
    visibleRect: input.runtime.coordinates.visibleCanvasRect(),
    nodesByPath: input.nodesByPath
  });
  const snapshot = input.runtime.getSnapshot();
  input.renderSnapshotScheduler.requestMoving({
    camera: input.liveCamera,
    cameraState: snapshot.cameraState,
    surfaceSize: input.surfaceSize,
    selection: input.selection,
    activeNodePaths: input.activeNodePaths
  });
}

export function syncCanvasImageResourceZoomForCameraState(input: {
  cameraState: CanvasRuntimeSnapshot['cameraState'];
  imagePreviewsEnabled: boolean;
  currentImageResourceZoom: number;
  liveCameraZoom: number;
  timerRef: { current: number | undefined };
  setImageResourceZoom: (zoom: number) => void;
  setTimeout: (callback: () => void, delay: number) => number;
  clearTimeout: (handle: number) => void;
  settleMs?: number | undefined;
}): void {
  const clearPendingTimer = () => {
    if (input.timerRef.current === undefined) {
      return;
    }
    input.clearTimeout(input.timerRef.current);
    input.timerRef.current = undefined;
  };

  if (!input.imagePreviewsEnabled) {
    clearPendingTimer();
    if (input.currentImageResourceZoom !== input.liveCameraZoom) {
      input.setImageResourceZoom(input.liveCameraZoom);
    }
    return;
  }

  if (input.cameraState !== 'idle') {
    clearPendingTimer();
    return;
  }

  if (input.currentImageResourceZoom === input.liveCameraZoom) {
    clearPendingTimer();
    return;
  }

  clearPendingTimer();
  input.timerRef.current = input.setTimeout(() => {
    input.timerRef.current = undefined;
    input.setImageResourceZoom(input.liveCameraZoom);
  }, input.settleMs ?? CANVAS_IMAGE_PREVIEW_RESOURCE_SETTLE_MS);
}

export function createCanvasImageAssetViewportSyncScheduler(input: {
  sync: (cameraState?: CanvasRuntimeSnapshot['cameraState']) => void;
  requestFrame?: ((callback: FrameRequestCallback) => number) | undefined;
  cancelFrame?: ((handle: number) => void) | undefined;
}): {
  request(cameraState?: CanvasRuntimeSnapshot['cameraState']): void;
  flush(cameraState?: CanvasRuntimeSnapshot['cameraState']): void;
  dispose(): void;
} {
  const requestFrame = input.requestFrame ?? globalThis.window?.requestAnimationFrame?.bind(globalThis.window);
  const cancelFrame = input.cancelFrame ?? globalThis.window?.cancelAnimationFrame?.bind(globalThis.window);
  let pendingFrame: number | undefined;
  let pendingCameraState: CanvasRuntimeSnapshot['cameraState'] | undefined;
  let frameGeneration = 0;

  const run = (generation: number) => {
    if (generation !== frameGeneration || pendingFrame === undefined) {
      return;
    }
    pendingFrame = undefined;
    const cameraState = pendingCameraState;
    pendingCameraState = undefined;
    input.sync(cameraState);
  };

  return {
    request(cameraState) {
      pendingCameraState = cameraState;
      if (pendingFrame !== undefined) {
        return;
      }
      if (!requestFrame) {
        const currentCameraState = pendingCameraState;
        pendingCameraState = undefined;
        input.sync(currentCameraState);
        return;
      }
      const generation = frameGeneration;
      pendingFrame = requestFrame(() => run(generation));
    },
    flush(cameraState) {
      pendingCameraState = cameraState;
      if (pendingFrame !== undefined) {
        frameGeneration += 1;
        cancelFrame?.(pendingFrame);
        pendingFrame = undefined;
      }
      const currentCameraState = pendingCameraState;
      pendingCameraState = undefined;
      input.sync(currentCameraState);
    },
    dispose() {
      if (pendingFrame !== undefined) {
        frameGeneration += 1;
        cancelFrame?.(pendingFrame);
      }
      pendingFrame = undefined;
      pendingCameraState = undefined;
    }
  };
}

export function createCanvasRenderSnapshotScheduler<T>(input: {
  commit: (next: T) => void;
  requestFrame?: ((callback: FrameRequestCallback) => number) | undefined;
  cancelFrame?: ((handle: number) => void) | undefined;
}): {
  requestMoving(next: T): void;
  flush(next: T): void;
  dispose(): void;
} {
  const requestFrame = input.requestFrame ?? globalThis.window?.requestAnimationFrame?.bind(globalThis.window);
  const cancelFrame = input.cancelFrame ?? globalThis.window?.cancelAnimationFrame?.bind(globalThis.window);
  let pendingFrame: number | undefined;
  let pendingInput: T | undefined;
  let frameGeneration = 0;

  const run = (generation: number) => {
    if (generation !== frameGeneration || pendingFrame === undefined) {
      return;
    }
    pendingFrame = undefined;
    const next = pendingInput;
    pendingInput = undefined;
    if (next !== undefined) {
      input.commit(next);
    }
  };

  return {
    requestMoving(next) {
      pendingInput = next;
      if (pendingFrame !== undefined) {
        return;
      }
      if (!requestFrame) {
        pendingInput = undefined;
        input.commit(next);
        return;
      }
      const generation = frameGeneration;
      pendingFrame = requestFrame(() => run(generation));
    },
    flush(next) {
      pendingInput = undefined;
      if (pendingFrame !== undefined) {
        frameGeneration += 1;
        cancelFrame?.(pendingFrame);
        pendingFrame = undefined;
      }
      input.commit(next);
    },
    dispose() {
      if (pendingFrame !== undefined) {
        frameGeneration += 1;
        cancelFrame?.(pendingFrame);
      }
      pendingFrame = undefined;
      pendingInput = undefined;
    }
  };
}

function domRectToFloatingBarRect(rect: DOMRect): FloatingBarRect {
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height
  };
}

function nodeRectForFloatingBar(node: ProjectedCanvasNode): FloatingBarRect {
  return {
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height
  };
}

function devicePixelRatioValue(): number {
  const value = globalThis.window?.devicePixelRatio;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
}
