import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CanvasSettingsView } from '@axis/app-protocol';
import type { CanvasDocument, CanvasFeedbackDocument, CanvasProjection, CanvasSelection, ProjectedCanvasNode } from '@axis/canvas-core';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import type { WorkbenchContextMenuPosition, WorkbenchContextMenuTarget } from '../shell/contextMenu';
import {
  buildResizeGeometry,
  canvasSurfacePointToCanvasPoint,
  canvasUpdateFromMovedSelection,
  canvasViewportCenterPoint,
  getCanvasResizePreserveAspect,
  getCanvasWheelIntent,
  getWheelZoomScale,
  isAdditiveCanvasSelectionModifier,
  isCanvasItemSelected,
  shouldCanvasHandleGlobalWheelTarget
} from '../services/canvasInteraction';
import type { CanvasPoint, CanvasRect, ResizeHandle } from '../services/canvasInteraction';
import type { CanvasFeedbackBarTarget, FloatingBarRect } from '../shell/floatingBars';
import { CanvasNodeElementView } from './CanvasNodeElementView';
import { CANVAS_IMAGE_PREVIEW_RESOURCE_SETTLE_MS, shouldUpdateCanvasImageResourceZoom } from './canvasImagePreviews';
import type { CanvasNavigationState } from './canvasMinimap';
import {
  createCanvasVirtualizationIndex,
  type CanvasVirtualizationIndex,
  type VirtualizedCanvasRenderState
} from './canvasVirtualization';

interface CanvasSurfaceProps {
  canvas: CanvasDocument;
  projection: CanvasProjection;
  actions: WorkbenchActions;
  selection: CanvasSelection | undefined;
  textFileBuffers: Record<string, TextFileBuffer>;
  textEditorWindows: Record<string, unknown>;
  canvasFeedback: CanvasFeedbackDocument | undefined;
  canvasSettings: CanvasSettingsView;
  onFeedbackBarTargetChange?: ((target: CanvasFeedbackBarTarget | undefined) => void) | undefined;
  onNavigationStateChange?: ((state: CanvasNavigationState | undefined) => void) | undefined;
  onOpenContextMenu?: ((target: WorkbenchContextMenuTarget, position: WorkbenchContextMenuPosition) => void) | undefined;
}

type DragState =
  | {
      kind: 'move-node';
      pointerId: number;
      projectRelativePath: string;
      start: CanvasPoint;
      current?: CanvasPoint;
      origin: ProjectedCanvasNode;
    }
  | {
      kind: 'resize-node';
      pointerId: number;
      handle: ResizeHandle;
      start: CanvasPoint;
      current?: CanvasPoint;
      node: ProjectedCanvasNode;
      origin: CanvasRect;
    };

export function CanvasSurface({
  canvas,
  projection,
  actions,
  selection,
  textFileBuffers,
  canvasFeedback,
  canvasSettings,
  onFeedbackBarTargetChange,
  onNavigationStateChange,
  onOpenContextMenu
}: CanvasSurfaceProps): React.ReactElement {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState(canvas.viewport);
  const [surfaceSize, setSurfaceSize] = useState<{ width: number; height: number }>();
  const [virtualViewport, setVirtualViewport] = useState(canvas.viewport);
  const [imageResourceZoom, setImageResourceZoom] = useState(canvas.viewport.zoom);
  const visualViewportRef = useRef(canvas.viewport);
  const imageResourceZoomRef = useRef(canvas.viewport.zoom);
  const virtualSignatureRef = useRef('');
  const pendingVisualViewportRef = useRef<CanvasDocument['viewport'] | undefined>(undefined);
  const requestViewportChangeRef = useRef<(nextViewport: CanvasDocument['viewport']) => void>(() => undefined);
  const viewportAnimationFrameRef = useRef<number | undefined>(undefined);
  const viewportPersistTimerRef = useRef<number | undefined>(undefined);
  const imageResourceZoomTimerRef = useRef<number | undefined>(undefined);
  const wheelHandlerRef = useRef<((event: WheelEvent) => void) | undefined>(undefined);
  const virtualizationIndexRef = useRef<CanvasVirtualizationIndex | undefined>(undefined);
  const canvasIdRef = useRef(canvas.id);
  const selectionRef = useRef(selection);
  const surfaceSizeRef = useRef(surfaceSize);
  const dragStateRef = useRef<DragState | undefined>(undefined);
  const [hoveredNodePath, setHoveredNodePath] = useState<string>();
  const [dragState, setDragState] = useState<DragState>();

  const projectedNodes = projection.nodes;
  const devicePixelRatio = devicePixelRatioValue();
  selectionRef.current = selection;
  surfaceSizeRef.current = surfaceSize;
  dragStateRef.current = dragState;

  useEffect(() => {
    const canvasChanged = canvasIdRef.current !== canvas.id;
    canvasIdRef.current = canvas.id;
    visualViewportRef.current = canvas.viewport;
    setViewport(canvas.viewport);
    if (canvasChanged) {
      imageResourceZoomRef.current = canvas.viewport.zoom;
      setImageResourceZoom(canvas.viewport.zoom);
      setVirtualViewport(canvas.viewport);
    }
  }, [canvas.id, canvas.viewport]);

  useLayoutEffect(() => {
    applyCanvasViewportTransform(stageRef.current, viewport);
  }, [viewport]);

  useEffect(() => {
    const element = surfaceRef.current;
    if (!element || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      const nextSize = {
        width: entry.contentRect.width,
        height: entry.contentRect.height
      };
      setSurfaceSize((current) => current?.width === nextSize.width && current.height === nextSize.height ? current : nextSize);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => () => {
    if (viewportAnimationFrameRef.current !== undefined) {
      window.cancelAnimationFrame(viewportAnimationFrameRef.current);
    }
    if (viewportPersistTimerRef.current !== undefined) {
      window.clearTimeout(viewportPersistTimerRef.current);
    }
    if (imageResourceZoomTimerRef.current !== undefined) {
      window.clearTimeout(imageResourceZoomTimerRef.current);
    }
  }, []);

  const previewNode = (node: ProjectedCanvasNode, state: DragState | undefined): ProjectedCanvasNode => {
    if (!state) {
      return node;
    }
    if (state.kind === 'move-node' && state.projectRelativePath === node.projectRelativePath) {
      return {
        ...node,
        x: state.origin.x + dragStateDelta(state).dx,
        y: state.origin.y + dragStateDelta(state).dy
      };
    }
    if (state.kind === 'resize-node' && state.node.projectRelativePath === node.projectRelativePath) {
      const delta = dragStateDelta(state);
      const next = buildResizeGeometry(
        state.handle,
        state.origin,
        { x: delta.dx, y: delta.dy },
        getCanvasResizePreserveAspect(state.handle, { shiftKey: false }, node.mediaKind)
      );
      return { ...node, ...next };
    }
    return node;
  };

  const previewNodes = (nodes: ProjectedCanvasNode[], state: DragState | undefined): ProjectedCanvasNode[] => (
    nodes.map((node) => previewNode(node, state))
  );

  const activeNodeProjectRelativePaths = (state: DragState | undefined): string[] => {
    if (!state) {
      return [];
    }
    return [state.kind === 'move-node' ? state.projectRelativePath : state.node.projectRelativePath];
  };

  const buildRenderState = (
    nextViewport: CanvasDocument['viewport'],
    input: {
      index: CanvasVirtualizationIndex;
      selection: CanvasSelection | undefined;
      surfaceSize: { width: number; height: number } | undefined;
      dragState: DragState | undefined;
      imageResourceZoom: number;
    }
  ): VirtualizedCanvasRenderState => input.index.render({
    viewport: nextViewport,
    surfaceSize: input.surfaceSize,
    selection: input.selection,
    activeNodeProjectRelativePaths: activeNodeProjectRelativePaths(input.dragState),
    imagePreviewsEnabled: canvasSettings.imagePreviewsEnabled,
    devicePixelRatio,
    imageResourceZoom: input.imageResourceZoom
  });

  const beginNodeMove = (node: ProjectedCanvasNode, event: React.PointerEvent<Element>) => {
    if (node.locked) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = pointerCanvasPoint(event);
    const nextDragState: DragState = {
      kind: 'move-node',
      pointerId: event.pointerId,
      projectRelativePath: node.projectRelativePath,
      start,
      origin: node
    };
    dragStateRef.current = nextDragState;
    setDragState(nextDragState);
    actions.selectCanvasEntity(
      isAdditiveCanvasSelectionModifier(event)
        ? toggleSelection(selectionRef.current, { kind: 'node', projectRelativePath: node.projectRelativePath })
        : { kind: 'node', projectRelativePath: node.projectRelativePath }
    );
  };

  const beginNodeResize = (node: ProjectedCanvasNode, handle: ResizeHandle, event: React.PointerEvent<HTMLButtonElement>) => {
    if (node.locked) {
      return;
    }
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const nextDragState: DragState = {
      kind: 'resize-node',
      pointerId: event.pointerId,
      handle,
      start: pointerCanvasPoint(event),
      node,
      origin: {
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height
      }
    };
    dragStateRef.current = nextDragState;
    setDragState(nextDragState);
    actions.selectCanvasEntity({ kind: 'node', projectRelativePath: node.projectRelativePath });
  };

  const handlePointerMove = (event: React.PointerEvent<Element>) => {
    const activeDragState = dragStateRef.current;
    if (!activeDragState || activeDragState.pointerId !== event.pointerId) {
      return;
    }
    const point = pointerCanvasPoint(event);
    const nextDragState = { ...activeDragState, current: point };
    dragStateRef.current = nextDragState;
    setDragState(nextDragState);
  };

  const handlePointerUp = async (event: React.PointerEvent<Element>) => {
    const activeDragState = dragStateRef.current;
    if (!activeDragState || activeDragState.pointerId !== event.pointerId) {
      return;
    }
    const point = pointerCanvasPoint(event);
    if (activeDragState.kind === 'move-node') {
      const update = canvasUpdateFromMovedSelection({ kind: 'node', projectRelativePath: activeDragState.projectRelativePath }, {
        dx: point.x - activeDragState.start.x,
        dy: point.y - activeDragState.start.y
      }, {
        nodes: projectedNodes.map((node) => ({
          projectRelativePath: node.projectRelativePath,
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height,
          locked: node.locked
        }))
      });
      if (update.nodeLayouts.length > 0) {
        await actions.updateCanvasNodeLayouts(canvas.id, update);
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
        getCanvasResizePreserveAspect(activeDragState.handle, event, activeDragState.node.mediaKind)
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
    dragStateRef.current = undefined;
    setDragState(undefined);
  };

  const syncRenderViewport = (nextViewport: CanvasDocument['viewport']) => {
    setViewport(nextViewport);
    syncVirtualViewport(nextViewport);
  };

  const syncVirtualViewport = (nextViewport: CanvasDocument['viewport'], nextImageResourceZoom = imageResourceZoomRef.current) => {
    const index = virtualizationIndexRef.current;
    if (!index) {
      return;
    }
    const nextState = buildRenderState(nextViewport, {
      index,
      selection: selectionRef.current,
      surfaceSize: surfaceSizeRef.current,
      dragState: dragStateRef.current,
      imageResourceZoom: nextImageResourceZoom
    });
    if (nextState.signature !== virtualSignatureRef.current) {
      virtualSignatureRef.current = nextState.signature;
      setVirtualViewport(nextViewport);
    }
  };

  const setSettledImageResourceZoom = (nextZoom: number) => {
    imageResourceZoomRef.current = nextZoom;
    setImageResourceZoom((current) => current === nextZoom ? current : nextZoom);
    setVirtualViewport(visualViewportRef.current);
  };

  const scheduleImageResourceZoom = (nextZoom: number) => {
    if (!canvasSettings.imagePreviewsEnabled) {
      setSettledImageResourceZoom(nextZoom);
      return;
    }
    if (imageResourceZoomTimerRef.current !== undefined) {
      window.clearTimeout(imageResourceZoomTimerRef.current);
    }
    imageResourceZoomTimerRef.current = window.setTimeout(() => {
      imageResourceZoomTimerRef.current = undefined;
      setSettledImageResourceZoom(visualViewportRef.current.zoom);
    }, CANVAS_IMAGE_PREVIEW_RESOURCE_SETTLE_MS);
  };

  const applyVisualViewport = (nextViewport: CanvasDocument['viewport'], options: { syncRender?: boolean } = {}) => {
    visualViewportRef.current = nextViewport;
    pendingVisualViewportRef.current = nextViewport;
    if (viewportAnimationFrameRef.current === undefined) {
      viewportAnimationFrameRef.current = window.requestAnimationFrame(() => {
        viewportAnimationFrameRef.current = undefined;
        const pendingViewport = pendingVisualViewportRef.current;
        pendingVisualViewportRef.current = undefined;
        if (pendingViewport) {
          applyCanvasViewportTransform(stageRef.current, pendingViewport);
          syncVirtualViewport(pendingViewport);
        }
      });
    }
    if (options.syncRender) {
      syncRenderViewport(nextViewport);
    }
  };

  useEffect(() => {
    if (canvasSettings.imagePreviewsEnabled) {
      setSettledImageResourceZoom(visualViewportRef.current.zoom);
    }
    if (imageResourceZoomTimerRef.current !== undefined) {
      window.clearTimeout(imageResourceZoomTimerRef.current);
      imageResourceZoomTimerRef.current = undefined;
    }
  }, [canvasSettings.imagePreviewsEnabled]);

  useEffect(() => {
    syncVirtualViewport(visualViewportRef.current);
  }, [canvasSettings.imagePreviewsEnabled, devicePixelRatio, projection, selection, surfaceSize, dragState, imageResourceZoom]);

  const emitNavigationState = useCallback((nextViewport = visualViewportRef.current) => {
    if (!onNavigationStateChange) {
      return;
    }
    const measuredSurfaceSize = surfaceSizeRef.current;
    if (!measuredSurfaceSize) {
      onNavigationStateChange(undefined);
      return;
    }
    onNavigationStateChange({
      canvasId: canvas.id,
      surfaceSize: measuredSurfaceSize,
      viewport: nextViewport,
      requestViewportChange: (viewport) => requestViewportChangeRef.current(viewport)
    });
  }, [canvas.id, onNavigationStateChange]);

  const scheduleViewportPersist = (nextViewport: CanvasDocument['viewport']) => {
    if (viewportPersistTimerRef.current !== undefined) {
      window.clearTimeout(viewportPersistTimerRef.current);
    }
    viewportPersistTimerRef.current = window.setTimeout(() => {
      viewportPersistTimerRef.current = undefined;
      const latestViewport = visualViewportRef.current;
      syncRenderViewport(latestViewport);
      void actions.updateCanvasViewport(canvas.id, latestViewport);
    }, 120);
    applyVisualViewport(nextViewport);
    emitNavigationState(nextViewport);
    if (shouldUpdateCanvasImageResourceZoom({
      imagePreviewsEnabled: canvasSettings.imagePreviewsEnabled,
      nextZoom: nextViewport.zoom,
      currentResourceZoom: imageResourceZoomRef.current,
      hasPendingTimer: imageResourceZoomTimerRef.current !== undefined
    })) {
      scheduleImageResourceZoom(nextViewport.zoom);
    }
  };
  requestViewportChangeRef.current = scheduleViewportPersist;

  const handleWheel = (event: WheelEvent) => {
    event.preventDefault();
    const intent = getCanvasWheelIntent(event);
    const currentViewport = visualViewportRef.current;
    if (intent.kind === 'pan') {
      scheduleViewportPersist({
        ...currentViewport,
        x: currentViewport.x + intent.deltaX,
        y: currentViewport.y + intent.deltaY
      });
      return;
    }
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    const anchor = canvasSurfacePointToCanvasPoint({
      viewport: currentViewport,
      surfaceRect: rect,
      point: { x: event.clientX, y: event.clientY }
    });
    const zoom = getWheelZoomScale(currentViewport.zoom, intent.deltaY);
    scheduleViewportPersist({
      x: event.clientX - rect.left - anchor.x * zoom,
      y: event.clientY - rect.top - anchor.y * zoom,
      zoom
    });
  };
  wheelHandlerRef.current = handleWheel;

  useEffect(() => {
    const handleWindowWheel = (event: WheelEvent) => {
      if (!shouldCanvasHandleGlobalWheelTarget(event.target, surfaceRef.current)) {
        return;
      }
      wheelHandlerRef.current?.(event);
    };
    window.addEventListener('wheel', handleWindowWheel, { capture: true, passive: false });
    return () => {
      window.removeEventListener('wheel', handleWindowWheel, { capture: true });
    };
  }, []);

  const pointerCanvasPoint = (event: Pick<React.PointerEvent<Element> | React.DragEvent<Element> | React.WheelEvent<Element>, 'clientX' | 'clientY'>): CanvasPoint => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) {
      return canvasViewportCenterPoint({
        viewport: visualViewportRef.current,
        surfaceRect: { width: 1, height: 1 }
      });
    }
    return canvasSurfacePointToCanvasPoint({
      viewport: visualViewportRef.current,
      surfaceRect: rect,
      point: { x: event.clientX, y: event.clientY }
    });
  };

  const indexedNodes = useMemo(() => previewNodes(projection.nodes, dragState), [projection.nodes, dragState]);
  const virtualizationIndex = useMemo(() => createCanvasVirtualizationIndex({
    nodes: indexedNodes,
    edges: projection.edges
  }), [indexedNodes, projection.edges]);
  virtualizationIndexRef.current = virtualizationIndex;
  const renderState = useMemo(() => buildRenderState(virtualViewport, {
    index: virtualizationIndex,
    selection,
    surfaceSize,
    dragState,
    imageResourceZoom
  }), [canvasSettings.imagePreviewsEnabled, devicePixelRatio, imageResourceZoom, virtualizationIndex, selection, surfaceSize, dragState, virtualViewport]);
  const displayedNodes = renderState.nodes;

  useEffect(() => {
    virtualSignatureRef.current = renderState.signature;
  }, [renderState.signature]);

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
      viewport: visualViewportRef.current,
      entry: canvasFeedback.entries[node.projectRelativePath]
    });
  }, [canvasFeedback, hoveredNodePath, onFeedbackBarTargetChange, projectedNodes]);

  useEffect(() => {
    emitFeedbackBarTarget();
  }, [emitFeedbackBarTarget, surfaceSize, viewport]);

  useEffect(() => () => {
    onFeedbackBarTargetChange?.(undefined);
  }, [onFeedbackBarTargetChange]);

  useEffect(() => {
    emitNavigationState();
  }, [emitNavigationState, surfaceSize, viewport]);

  useEffect(() => () => {
    onNavigationStateChange?.(undefined);
  }, [onNavigationStateChange]);

  return (
    <div
      ref={surfaceRef}
      className="canvas-surface"
      data-testid="canvas-surface"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          actions.selectCanvasEntity(undefined);
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
          viewBox={renderState.svgViewBox}
          style={{
            left: renderState.svgBounds.x,
            top: renderState.svgBounds.y,
            width: renderState.svgBounds.width,
            height: renderState.svgBounds.height
          }}
        >
          {renderState.edges.map((edge) => (
            <path
              key={edge.id}
              data-canvas-edge-id={edge.id}
              className="canvas-edge"
              d={edge.path}
            />
          ))}
        </svg>
        {displayedNodes.map((node) => {
          return (
            <CanvasNodeElementView
              key={node.projectRelativePath}
              node={node}
              selected={isCanvasItemSelected(selection, { kind: 'node', projectRelativePath: node.projectRelativePath })}
              hovered={hoveredNodePath === node.projectRelativePath}
              viewportZoom={imageResourceZoom}
              imagePreviewsEnabled={canvasSettings.imagePreviewsEnabled}
              devicePixelRatio={devicePixelRatio}
              actions={actions}
              textBuffer={textFileBuffers[node.projectRelativePath]}
              onPointerDown={(event) => beginNodeMove(node, event)}
              onPointerMove={handlePointerMove}
              onPointerUp={(event) => void handlePointerUp(event)}
              onPointerEnter={() => setHoveredNodePath(node.projectRelativePath)}
              onPointerLeave={() => setHoveredNodePath((current) => current === node.projectRelativePath ? undefined : current)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                actions.selectCanvasEntity({ kind: 'node', projectRelativePath: node.projectRelativePath });
                onOpenContextMenu?.({
                  source: 'canvas',
                  kind: node.nodeKind,
                  projectRelativePath: node.projectRelativePath
                }, {
                  x: event.clientX,
                  y: event.clientY
                });
              }}
              onResizePointerDown={(handle, event) => beginNodeResize(node, handle, event)}
            />
          );
        })}
      </div>
      {projectedNodes.length === 0 ? (
        <div className="canvas-empty-state" data-testid="canvas-empty-state">
          <strong>No Flowmap nodes</strong>
        </div>
      ) : null}
    </div>
  );
}

function dragStateDelta(state: DragState): { dx: number; dy: number } {
  const current = state.current ?? state.start;
  return {
    dx: current.x - state.start.x,
    dy: current.y - state.start.y
  };
}

function applyCanvasViewportTransform(element: HTMLElement | null, viewport: CanvasDocument['viewport']): void {
  if (!element) {
    return;
  }
  element.style.setProperty('--canvas-zoom', String(viewport.zoom));
  element.style.setProperty('--canvas-chrome-scale', String(canvasChromeScale(viewport.zoom)));
  element.style.transform = canvasViewportTransform(viewport);
}

function canvasViewportTransform(viewport: CanvasDocument['viewport']): string {
  return `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`;
}

function domRectToFloatingBarRect(rect: DOMRect): FloatingBarRect {
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height
  };
}

function canvasChromeScale(zoom: number): number {
  return 1 / zoom;
}

function devicePixelRatioValue(): number {
  const value = globalThis.window?.devicePixelRatio;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
}

function toggleSelection(selection: CanvasSelection | undefined, item: { kind: 'node'; projectRelativePath: string }): CanvasSelection | undefined {
  if (!selection) {
    return item;
  }
  const items = selection.kind === 'multi' ? selection.items : [selection];
  const exists = items.some((selected) => selected.kind === 'node' && selected.projectRelativePath === item.projectRelativePath);
  const next = exists
    ? items.filter((selected) => !(selected.kind === 'node' && selected.projectRelativePath === item.projectRelativePath))
    : [...items, item];
  if (next.length === 0) {
    return undefined;
  }
  return next.length === 1 ? next[0] : { kind: 'multi', items: next };
}
