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
import type { CanvasFeedbackBarTarget, FloatingBarRect } from '../shell/floatingBars';
import { cameraForCanvasContent } from './CanvasCameraBounds';
import { CANVAS_IMAGE_PREVIEW_RESOURCE_SETTLE_MS, shouldUpdateCanvasImageResourceZoom } from './canvasImagePreviews';
import { createCanvasImageResourceController, type CanvasImageResourceController } from './CanvasImageResourceController';
import { CanvasImageResourceProvider } from './CanvasImageResourceContext';
import { CanvasNodeShell } from './CanvasNodeShell';
import { createCanvasRenderModel, type CanvasRenderModelSnapshot } from './CanvasRenderModel';
import { nodeRect } from './canvasVirtualization';
import type {
  CanvasEditorRuntime,
  CanvasRuntimeDragState,
  CanvasRuntimePointerModifiers,
  CanvasRuntimeSnapshot
} from './runtime/CanvasEditorRuntime';
import { createCanvasLayerRuntime, type CanvasLayerRuntime } from './runtime/CanvasLayerRuntime';
import { rectsIntersect, type CanvasRect } from './runtime/canvasGeometry';
import type { CanvasSelection } from './runtime/canvasSelection';
import { isCanvasItemSelected, toggleCanvasSelectionItem } from './runtime/canvasSelection';
import { useCanvasRuntimeSnapshot } from './runtime/useCanvasRuntimeSnapshot';

interface CanvasSurfaceProps {
  canvas: CanvasDocument;
  projection: CanvasProjection;
  runtime: CanvasEditorRuntime;
  actions: WorkbenchActions;
  textFileBuffers: Record<string, TextFileBuffer>;
  canvasFeedback: CanvasFeedbackDocument | undefined;
  canvasSettings: CanvasSettingsView;
  imageResourceController?: CanvasImageResourceController | undefined;
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
  imageResourceController,
  onFeedbackBarTargetChange,
  onOpenContextMenu
}: CanvasSurfaceProps): React.ReactElement {
  const [imageResourceControllerState, setImageResourceControllerState] = useState<{
    canvasId: string;
    controller: CanvasImageResourceController;
  }>();

  useEffect(() => {
    if (imageResourceController) {
      setImageResourceControllerState(undefined);
      return;
    }
    const controller = createCanvasImageResourceController();
    setImageResourceControllerState({
      canvasId: canvas.id,
      controller
    });
    return () => {
      controller.dispose();
    };
  }, [canvas.id, imageResourceController]);

  const activeImageResourceController = imageResourceController
    ?? (imageResourceControllerState?.canvasId === canvas.id ? imageResourceControllerState.controller : undefined);

  if (!activeImageResourceController) {
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
      imageResourceController={activeImageResourceController}
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
  imageResourceController,
  onFeedbackBarTargetChange,
  onOpenContextMenu
}: CanvasSurfaceProps & {
  imageResourceController: CanvasImageResourceController;
}): React.ReactElement {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const runtimeSnapshot = useCanvasRuntimeSnapshot(runtime);
  const selection = runtimeSnapshot.selection;
  const camera = runtimeSnapshot.camera;
  const surfaceSize = runtimeSnapshot.surfaceSize;
  const imageResourceZoom = runtimeSnapshot.imageResourceZoom;
  const dragState = runtimeSnapshot.dragState;
  const selectionRef = useRef<CanvasSelection | undefined>(selection);
  const surfaceSizeRef = useRef(surfaceSize);
  const renderSnapshotRef = useRef<CanvasRenderModelSnapshot | undefined>(undefined);
  const activeNodePathsRef = useRef<string[]>(activeNodeProjectRelativePaths(dragState));
  const activeNodePathKeyRef = useRef(activeNodePathsRef.current.join('\u001f'));
  const imageResourceZoomTimerRef = useRef<number | undefined>(undefined);
  const fittedCanvasIdRef = useRef<string | undefined>(undefined);
  const [hoveredNodePath, setHoveredNodePath] = useState<string>();

  const projectedNodes = projection.nodes;
  const devicePixelRatio = devicePixelRatioValue();
  const layerRuntime = useMemo(() => createCanvasLayerRuntime(), [runtime]);
  const renderModel = useMemo(() => createCanvasRenderModel(projection), [projection]);
  const initialRenderSnapshot = useMemo(() => renderModel.update({
    camera: runtime.getSnapshot().camera,
    cameraState: runtime.getSnapshot().cameraState,
    surfaceSize: runtime.getSnapshot().surfaceSize,
    selection: runtime.getSnapshot().selection,
    activeNodePaths: activeNodePathsRef.current
  }), [renderModel, runtime]);
  const [renderSnapshot, setRenderSnapshot] = useState(initialRenderSnapshot);

  selectionRef.current = selection;
  surfaceSizeRef.current = surfaceSize;

  const commitRenderSnapshot = useCallback((input: {
    camera: CanvasRuntimeSnapshot['camera'];
    cameraState: CanvasRuntimeSnapshot['cameraState'];
    surfaceSize: CanvasRuntimeSnapshot['surfaceSize'];
    selection: CanvasRuntimeSnapshot['selection'];
    activeNodePaths: readonly string[];
  }) => {
    const next = renderModel.update(input);
    if (next === renderSnapshotRef.current) {
      return;
    }
    renderSnapshotRef.current = next;
    setRenderSnapshot(next);
  }, [renderModel]);

  const syncImageResourceViewport = useCallback((cameraState = runtime.getSnapshot().cameraState) => {
    syncCanvasImageResourceViewport({
      controller: imageResourceController,
      runtime,
      nodesByPath: renderSnapshotRef.current?.nodesByPath ?? renderSnapshot.nodesByPath,
      imageResourceZoom,
      devicePixelRatio,
      imagePreviewsEnabled: canvasSettings.imagePreviewsEnabled,
      cameraState
    });
  }, [
    canvasSettings.imagePreviewsEnabled,
    devicePixelRatio,
    imageResourceController,
    imageResourceZoom,
    renderSnapshot.nodesByPath,
    runtime
  ]);
  const imageResourceViewportScheduler = useMemo(() => createCanvasImageResourceViewportSyncScheduler({
    sync: syncImageResourceViewport
  }), [syncImageResourceViewport]);

  useEffect(() => {
    renderSnapshotRef.current = initialRenderSnapshot;
    setRenderSnapshot(initialRenderSnapshot);
  }, [initialRenderSnapshot]);

  useEffect(() => () => {
    layerRuntime.dispose();
  }, [layerRuntime]);

  useEffect(() => () => {
    imageResourceViewportScheduler.dispose();
  }, [imageResourceViewportScheduler]);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    const stage = stageRef.current;
    if (!surface || !stage) {
      return;
    }
    const unbindSurface = runtime.bindSurface({ surface });
    const unbindStage = layerRuntime.bindStage(stage);
    layerRuntime.setCamera(runtime.getSnapshot().camera);
    return () => {
      unbindStage();
      unbindSurface();
    };
  }, [layerRuntime, runtime]);

  useLayoutEffect(() => {
    syncCanvasLayerNodeVisibility({
      layerRuntime,
      visibleRect: runtime.coordinates.visibleCanvasRect(),
      nodesByPath: renderSnapshot.nodesByPath
    });
  }, [layerRuntime, renderSnapshot.nodesByPath, runtime]);

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
    layerRuntime.setCamera(liveCamera);
    syncCanvasLayerNodeVisibility({
      layerRuntime,
      visibleRect: runtime.coordinates.visibleCanvasRect(),
      nodesByPath: renderSnapshotRef.current?.nodesByPath ?? renderSnapshot.nodesByPath
    });
    const snapshot = runtime.getSnapshot();
    commitRenderSnapshot({
      camera: liveCamera,
      cameraState: snapshot.cameraState,
      surfaceSize: surfaceSizeRef.current,
      selection: selectionRef.current,
      activeNodePaths: activeNodePathsRef.current
    });
    imageResourceViewportScheduler.request(snapshot.cameraState);
  }), [commitRenderSnapshot, imageResourceViewportScheduler, layerRuntime, renderSnapshot.nodesByPath, runtime]);

  useEffect(() => {
    return runtime.subscribeCameraState((cameraState) => {
      if (cameraState !== 'idle') {
        imageResourceViewportScheduler.request(cameraState);
        return;
      }
      imageResourceViewportScheduler.flush(cameraState);
      const snapshot = runtime.getSnapshot();
      commitRenderSnapshot({
        camera: snapshot.camera,
        cameraState,
        surfaceSize: surfaceSizeRef.current,
        selection: selectionRef.current,
        activeNodePaths: activeNodePathsRef.current
      });
    });
  }, [commitRenderSnapshot, imageResourceViewportScheduler, runtime]);

  useEffect(() => {
    layerRuntime.applyDragPreview(runtime.getSnapshot().dragState);
    return runtime.subscribeDragState((nextDragState) => {
      layerRuntime.applyDragPreview(nextDragState);
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
  }, [commitRenderSnapshot, layerRuntime, runtime]);

  useEffect(() => {
    if (imageResourceZoomTimerRef.current !== undefined) {
      window.clearTimeout(imageResourceZoomTimerRef.current);
      imageResourceZoomTimerRef.current = undefined;
    }
    runtime.setImageResourceZoom(camera.z);
  }, [canvas.id, runtime]);

  useEffect(() => () => {
    if (imageResourceZoomTimerRef.current !== undefined) {
      window.clearTimeout(imageResourceZoomTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!canvasSettings.imagePreviewsEnabled) {
      if (imageResourceZoom !== camera.z) {
        runtime.setImageResourceZoom(camera.z);
      }
      return;
    }
    if (!shouldUpdateCanvasImageResourceZoom({
      imagePreviewsEnabled: canvasSettings.imagePreviewsEnabled,
      nextZoom: camera.z,
      currentResourceZoom: imageResourceZoom,
      hasPendingTimer: imageResourceZoomTimerRef.current !== undefined
    })) {
      return;
    }
    if (imageResourceZoomTimerRef.current !== undefined) {
      window.clearTimeout(imageResourceZoomTimerRef.current);
    }
    imageResourceZoomTimerRef.current = window.setTimeout(() => {
      imageResourceZoomTimerRef.current = undefined;
      runtime.setImageResourceZoom(runtime.getSnapshot().camera.z);
    }, CANVAS_IMAGE_PREVIEW_RESOURCE_SETTLE_MS);
  }, [camera.z, canvasSettings.imagePreviewsEnabled, imageResourceZoom, runtime]);

  useEffect(() => {
    imageResourceController.setNodes(renderSnapshot.nodesByPath);
  }, [imageResourceController, renderSnapshot.nodesByPath]);

  useEffect(() => {
    imageResourceViewportScheduler.flush();
  }, [imageResourceViewportScheduler]);

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

  const emitFeedbackBarTarget = useCallback(() => {
    if (!onFeedbackBarTargetChange || !canvasFeedback || !hoveredNodePath) {
      onFeedbackBarTargetChange?.(undefined);
      return;
    }

    const node = projectedNodes.find((item) => item.projectRelativePath === hoveredNodePath);
    const surfaceRect = surfaceRef.current?.getBoundingClientRect();
    if (!node || node.nodeKind !== 'file' || node.visible === false || !surfaceRect) {
      onFeedbackBarTargetChange(undefined);
      return;
    }

    onFeedbackBarTargetChange({
      projectRelativePath: node.projectRelativePath,
      nodeRect: {
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height
      },
      surfaceRect: domRectToFloatingBarRect(surfaceRect),
      camera: runtime.getSnapshot().camera,
      entry: canvasFeedback.entries[node.projectRelativePath]
    });
  }, [canvasFeedback, hoveredNodePath, onFeedbackBarTargetChange, projectedNodes, runtime]);

  useEffect(() => {
    emitFeedbackBarTarget();
  }, [emitFeedbackBarTarget, surfaceSize]);

  useEffect(() => {
    if (!hoveredNodePath || !onFeedbackBarTargetChange) {
      return;
    }
    return runtime.subscribeCamera(() => {
      emitFeedbackBarTarget();
    });
  }, [emitFeedbackBarTarget, hoveredNodePath, onFeedbackBarTargetChange, runtime]);

  useEffect(() => () => {
    onFeedbackBarTargetChange?.(undefined);
  }, [onFeedbackBarTargetChange]);

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
        <CanvasImageResourceProvider controller={imageResourceController}>
          {renderedNodes.map((node) => (
            <CanvasNodeShell
              key={node.projectRelativePath}
              node={node}
              selected={isCanvasItemSelected(selection, { kind: 'node', projectRelativePath: node.projectRelativePath })}
              hovered={hoveredNodePath === node.projectRelativePath}
              layerRuntime={layerRuntime}
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
        </CanvasImageResourceProvider>
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

export function syncCanvasImageResourceViewport(input: {
  controller: Pick<CanvasImageResourceController, 'setViewport'>;
  runtime: Pick<CanvasEditorRuntime, 'coordinates' | 'getSnapshot'>;
  nodesByPath: ReadonlyMap<string, ProjectedCanvasNode>;
  imageResourceZoom: number;
  devicePixelRatio: number;
  imagePreviewsEnabled: boolean;
  cameraState?: CanvasRuntimeSnapshot['cameraState'];
}): void {
  const visibleRect = input.runtime.coordinates.visibleCanvasRect();
  const mountedNodePaths = new Set(input.nodesByPath.keys());
  const culledNodePaths = new Set(
    [...input.nodesByPath.values()]
      .filter((node) => !rectsIntersect(visibleRect, nodeRect(node)))
      .map((node) => node.projectRelativePath)
  );
  input.controller.setViewport({
    visibleRect,
    mountedNodePaths,
    culledNodePaths,
    imageResourceZoom: input.imageResourceZoom,
    devicePixelRatio: input.devicePixelRatio,
    imagePreviewsEnabled: input.imagePreviewsEnabled,
    cameraState: input.cameraState ?? input.runtime.getSnapshot().cameraState
  });
}

export function syncCanvasLayerNodeVisibility(input: {
  layerRuntime: Pick<CanvasLayerRuntime, 'setNodeVisible'>;
  visibleRect: CanvasRect;
  nodesByPath: ReadonlyMap<string, ProjectedCanvasNode>;
}): void {
  for (const node of input.nodesByPath.values()) {
    input.layerRuntime.setNodeVisible(
      node.projectRelativePath,
      node.visible !== false && rectsIntersect(input.visibleRect, nodeRect(node))
    );
  }
}

export function createCanvasImageResourceViewportSyncScheduler(input: {
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

function domRectToFloatingBarRect(rect: DOMRect): FloatingBarRect {
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height
  };
}

function devicePixelRatioValue(): number {
  const value = globalThis.window?.devicePixelRatio;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
}
