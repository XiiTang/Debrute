import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CanvasDocument, CanvasFeedbackDocument, CanvasFeedbackEntry, CanvasFeedbackGeometry, CanvasProjection, ProjectedCanvasNode } from '@debrute/canvas-core';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import type { WorkbenchContextMenuPosition, WorkbenchContextMenuTarget } from '../shell/contextMenu';
import {
  isAdditiveCanvasSelectionModifier,
  type CanvasPoint,
  type ResizeHandle
} from '../services/canvasInteraction';
import {
  canvasFeedbackBarSizeForTarget,
  canvasFeedbackEntryHasCommentRow,
  canvasNodeToViewportRect,
  placeCanvasFeedbackBar,
  type CanvasFeedbackBarTarget,
  type CanvasLocalFeedbackDraft,
  type FloatingBarRect
} from '../shell/floatingBars';
import { cameraForCanvasContent } from './CanvasCameraBounds';
import { CANVAS_IMAGE_PREVIEW_RESOURCE_SETTLE_MS } from './canvasImagePreviews';
import { CanvasImageNodeAssetProvider, type CanvasImageNodeAssetContextValue } from './CanvasImageNodeAssetContext';
import type { CanvasImageFeedbackMode } from './CanvasImageFeedbackLayer';
import { CanvasNodeShell } from './CanvasNodeShell';
import type { CanvasOverlayRuntime } from './CanvasOverlayRuntime';
import { createCanvasPerfBrowserAdapter } from './CanvasPerfBrowserAdapter';
import { createCanvasPerfDebugBridge, type DebruteCanvasPerfCanvasSnapshot } from './CanvasPerfDebugBridge';
import {
  CANVAS_PERF_INTERACTION_SESSION_TYPES,
  createCanvasPerfMonitor,
  type CanvasPerfCounterName,
  type CanvasPerfCounterTotals,
  type CanvasPerfFinalState,
  type CanvasPerfMonitor,
  type CanvasPerfSessionId
} from './CanvasPerfMonitor';
import { createCanvasRenderCoordinator, type CanvasRenderCoordinatorSnapshot, type CanvasRenderCoordinatorUpdateInput } from './CanvasRenderCoordinator';
import { createCanvasVisibilityController } from './CanvasVisibilityController';
import type {
  CanvasEditorRuntime,
  CanvasRuntimeDragState,
  CanvasRuntimePointerModifiers,
  CanvasRuntimeSnapshot
} from './runtime/CanvasEditorRuntime';
import { createCanvasStageRuntime, type CanvasStageRuntime } from './runtime/CanvasStageRuntime';
import type { CanvasSelection } from './runtime/canvasSelection';
import { isCanvasItemSelected, selectedNodeProjectRelativePaths, toggleCanvasSelectionItem } from './runtime/canvasSelection';
import {
  useCanvasImageResourceZoom,
  useCanvasSelection,
  useCanvasSurfaceSize
} from './runtime/useCanvasRuntimeSnapshot';
import type { CanvasCamera } from './runtime/canvasCamera';
import {
  canvasLayoutOverridesForCanvas,
  canvasLocalLayoutDraftFromDragState,
  canvasLocalLayoutDraftMatchesProjection,
  canvasNodesWithLayoutOverrides,
  type CanvasLocalLayoutDraft
} from './canvasLocalLayoutDraft';
import { hasInternalProjectTreeDrag, readInternalProjectTreeDragEntries } from '../project-explorer/ProjectTree';
import type { CanvasImageFeedbackDraftRegion } from './CanvasImageFeedbackLayer';

interface CanvasSurfaceProps {
  canvas: CanvasDocument;
  projection: CanvasProjection;
  runtime: CanvasEditorRuntime;
  actions: WorkbenchActions;
  textFileBuffers: Record<string, TextFileBuffer>;
  canvasFeedback: CanvasFeedbackDocument | undefined;
  localFeedbackMode?: CanvasImageFeedbackMode | undefined;
  pendingFeedbackRegion?: { projectRelativePath: string } & CanvasImageFeedbackDraftRegion | undefined;
  onLocalFeedbackDraft?: ((input: CanvasLocalFeedbackDraft) => void) | undefined;
  overlayRuntime: CanvasOverlayRuntime;
  minimapOpen?: boolean | undefined;
  feedbackPlacementContext: {
    viewportRect: FloatingBarRect;
    reservedRects: readonly FloatingBarRect[];
  };
  onCurrentNodesChange?: ((canvasId: string, nodes: ProjectedCanvasNode[] | undefined) => void) | undefined;
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
  localFeedbackMode,
  pendingFeedbackRegion,
  onLocalFeedbackDraft,
  overlayRuntime,
  minimapOpen,
  feedbackPlacementContext,
  onCurrentNodesChange,
  onFeedbackBarTargetChange,
  onOpenContextMenu
}: CanvasSurfaceProps): React.ReactElement {
  const perfMonitorEnabled = canvasPerfMonitorEnabled();
  const perfMonitorRef = useRef<CanvasPerfMonitor | undefined>(undefined);
  const perfBrowserAdapter = useMemo(() => (
    perfMonitorEnabled
      ? createCanvasPerfBrowserAdapter({
        onLongAnimationFrame: (entry) => {
          perfMonitorRef.current?.recordLongAnimationFrame(entry);
        }
      })
      : undefined
  ), [perfMonitorEnabled]);
  const perfMonitor = useMemo(() => createCanvasPerfMonitor({
    enabled: perfMonitorEnabled,
    onEvent: (event) => perfBrowserAdapter?.recordEvent(event)
  }), [perfBrowserAdapter, perfMonitorEnabled]);
  perfMonitorRef.current = perfMonitor;

  useEffect(() => () => {
    perfBrowserAdapter?.dispose();
  }, [perfBrowserAdapter]);

  return (
    <CanvasSurfaceRuntime
      canvas={canvas}
      projection={projection}
      runtime={runtime}
      actions={actions}
      textFileBuffers={textFileBuffers}
      canvasFeedback={canvasFeedback}
      localFeedbackMode={localFeedbackMode}
      pendingFeedbackRegion={pendingFeedbackRegion}
      onLocalFeedbackDraft={onLocalFeedbackDraft}
      perfMonitor={perfMonitor}
      overlayRuntime={overlayRuntime}
      minimapOpen={minimapOpen}
      feedbackPlacementContext={feedbackPlacementContext}
      onCurrentNodesChange={onCurrentNodesChange}
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
  localFeedbackMode,
  pendingFeedbackRegion,
  onLocalFeedbackDraft,
  perfMonitor,
  overlayRuntime,
  minimapOpen,
  feedbackPlacementContext,
  onCurrentNodesChange,
  onFeedbackBarTargetChange,
  onOpenContextMenu
}: CanvasSurfaceProps & {
  perfMonitor: CanvasPerfMonitor;
}): React.ReactElement {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const selection = useCanvasSelection(runtime);
  const surfaceSize = useCanvasSurfaceSize(runtime);
  const imageResourceZoom = useCanvasImageResourceZoom(runtime);
  const initialRuntimeSnapshot = runtime.getSnapshot();
  const initialDragState = initialRuntimeSnapshot.dragState;
  const [cameraState, setCameraState] = useState(initialRuntimeSnapshot.cameraState);
  const selectionRef = useRef<CanvasSelection | undefined>(selection);
  const surfaceSizeRef = useRef(surfaceSize);
  const renderSnapshotRef = useRef<CanvasRenderCoordinatorSnapshot | undefined>(undefined);
  const activeLayoutDraftRef = useRef<CanvasLocalLayoutDraft | undefined>(canvasSurfaceLayoutDraftFromDragState({
    canvasId: canvas.id,
    dragState: initialDragState,
    point: initialDragState?.current ?? initialDragState?.start
  }));
  const pendingLayoutDraftRef = useRef<CanvasLocalLayoutDraft | undefined>(undefined);
  const activeNodePathsRef = useRef<string[]>(activeNodeProjectRelativePaths(initialDragState));
  const activeNodePathKeyRef = useRef(activeNodePathsRef.current.join('\u001f'));
  const imageResourceZoomTimerRef = useRef<number | undefined>(undefined);
  const lastCameraMovementAtRef = useRef<number | undefined>(undefined);
  const fittedCanvasIdRef = useRef<string | undefined>(undefined);
  const canvasPerfSessionRef = useRef<CanvasPerfRuntimeSession | undefined>(undefined);
  const canvasPerfDragSessionRef = useRef<CanvasPerfRuntimeSession | undefined>(undefined);
  const reactCommitCountRef = useRef(0);
  const [hoveredNodePath, setHoveredNodePath] = useState<string>();
  const [activeInlineTextEditorPath, setActiveInlineTextEditorPath] = useState<string>();
  const inlineTextEditorFocusRequestIdRef = useRef(0);
  const [inlineTextEditorFocusRequest, setInlineTextEditorFocusRequest] = useState<{
    projectRelativePath: string;
    requestId: number;
    clientX: number;
    clientY: number;
  }>();
  const [inlineTextPreviewScrollTopByPath, setInlineTextPreviewScrollTopByPath] = useState<Record<string, number>>({});

  const projectedNodes = projection.nodes;
  const devicePixelRatio = devicePixelRatioValue();
  const perfMonitorEnabled = canvasPerfMonitorEnabled();
  const stageRuntime = useMemo(() => createCanvasStageRuntime({ perfMonitor }), [perfMonitor]);
  const visibilityController = useMemo(() => createCanvasVisibilityController({ stageRuntime }), [stageRuntime]);
  const renderCoordinator = useMemo(() => createCanvasRenderCoordinator({ projection, perfMonitor }), [perfMonitor]);
  const currentLayoutOverrides = useCallback(() => canvasLayoutOverridesForCanvas({
    canvasId: canvas.id,
    active: activeLayoutDraftRef.current,
    pending: pendingLayoutDraftRef.current
  }), [canvas.id]);
  const initialRenderSnapshot = useMemo(() => renderCoordinator.update({
    camera: runtime.getSnapshot().camera,
    cameraState: runtime.getSnapshot().cameraState,
    surfaceSize: runtime.getSnapshot().surfaceSize,
    selection: runtime.getSnapshot().selection,
    activeNodePaths: activeNodePathsRef.current,
    layoutOverrides: currentLayoutOverrides()
  }), [currentLayoutOverrides, renderCoordinator, runtime]);
  const [renderSnapshot, setRenderSnapshot] = useState(initialRenderSnapshot);
  const canvasPerfDebugContextRef = useRef<CanvasPerfDebugSnapshotContext | undefined>(undefined);
  const imageNodeAssetContext = useMemo<CanvasImageNodeAssetContextValue>(() => ({
    imageResourceZoom,
    devicePixelRatio,
    cameraState,
    perfMonitor
  }), [cameraState, devicePixelRatio, imageResourceZoom, perfMonitor]);

  selectionRef.current = selection;
  surfaceSizeRef.current = surfaceSize;
  canvasPerfDebugContextRef.current = {
    canvasId: canvas.id,
    runtime,
    renderSnapshot: renderSnapshotRef.current ?? renderSnapshot,
    surfaceElement: surfaceRef.current
  };

  useEffect(() => {
    reactCommitCountRef.current += 1;
  });

  const perfDebugBridge = useMemo(() => createCanvasPerfDebugBridge({
    enabled: perfMonitorEnabled,
    perfMonitor,
    getCanvasSnapshot: () => {
      const context = canvasPerfDebugContextRef.current;
      if (!context) {
        throw new Error('Canvas perf debug snapshot context is unavailable.');
      }
      return canvasPerfDebugSnapshot(context);
    }
  }), [perfMonitor, perfMonitorEnabled]);

  useEffect(() => {
    perfDebugBridge.register();
    return () => {
      perfDebugBridge.unregister();
    };
  }, [perfDebugBridge]);

  const commitRenderSnapshot = useCallback((input: {
    camera: CanvasRuntimeSnapshot['camera'];
    cameraState: CanvasRuntimeSnapshot['cameraState'];
    surfaceSize: CanvasRuntimeSnapshot['surfaceSize'];
    selection: CanvasRuntimeSnapshot['selection'];
    activeNodePaths: readonly string[];
  }) => {
    const next = renderCoordinator.update({
      ...input,
      layoutOverrides: currentLayoutOverrides()
    });
    if (next === renderSnapshotRef.current) {
      return;
    }
    renderSnapshotRef.current = next;
    visibilityController.sync({
      nodesByPath: next.nodesByPath,
      culledNodePaths: next.culledNodePaths,
      selectedNodePaths: new Set(selectedNodeProjectRelativePaths(input.selection)),
      activeNodePaths: new Set(input.activeNodePaths)
    });
    setRenderSnapshot(next);
  }, [currentLayoutOverrides, renderCoordinator, visibilityController]);
  const renderSnapshotScheduler = useMemo(() => createCanvasRenderSnapshotScheduler({
    perfMonitor,
    commit: commitRenderSnapshot
  }), [commitRenderSnapshot, perfMonitor]);

  const syncVisibility = useCallback((input?: {
    renderSnapshot?: CanvasRenderCoordinatorSnapshot;
    selection?: CanvasSelection | undefined;
    activeNodePaths?: readonly string[] | undefined;
  }) => {
    const snapshot = input?.renderSnapshot ?? renderSnapshotRef.current ?? renderSnapshot;
    visibilityController.sync({
      nodesByPath: snapshot.nodesByPath,
      culledNodePaths: snapshot.culledNodePaths,
      selectedNodePaths: new Set(selectedNodeProjectRelativePaths(input?.selection ?? selectionRef.current)),
      activeNodePaths: new Set(input?.activeNodePaths ?? activeNodePathsRef.current)
    });
  }, [renderSnapshot, visibilityController]);

  const syncImageResourceZoomForSnapshot = useCallback((snapshot: CanvasRuntimeSnapshot) => {
    syncCanvasImageResourceZoomForCameraState({
      cameraState: snapshot.cameraState,
      currentImageResourceZoom: snapshot.imageResourceZoom,
      liveCameraZoom: snapshot.camera.z,
      timerRef: imageResourceZoomTimerRef,
      lastCameraMovementAtRef,
      now: () => window.performance?.now?.() ?? Date.now(),
      setImageResourceZoom: (zoom) => runtime.setImageResourceZoom(zoom),
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (handle) => window.clearTimeout(handle)
    });
  }, [runtime]);

  useEffect(() => {
    if (activeLayoutDraftRef.current && activeLayoutDraftRef.current.canvasId !== canvas.id) {
      activeLayoutDraftRef.current = undefined;
    }
    if (pendingLayoutDraftRef.current && pendingLayoutDraftRef.current.canvasId !== canvas.id) {
      pendingLayoutDraftRef.current = undefined;
    }
    if (canvasSurfaceShouldClearPendingLayoutDraft({
      pending: pendingLayoutDraftRef.current,
      projection
    })) {
      pendingLayoutDraftRef.current = undefined;
    }
    renderCoordinator.setProjection(projection);
    const snapshot = runtime.getSnapshot();
    commitRenderSnapshot({
      camera: snapshot.camera,
      cameraState: snapshot.cameraState,
      surfaceSize: snapshot.surfaceSize,
      selection: snapshot.selection,
      activeNodePaths: activeNodePathsRef.current
    });
  }, [canvas.id, commitRenderSnapshot, projection, renderCoordinator, runtime]);

  useEffect(() => {
    if (!onCurrentNodesChange) {
      return;
    }
    return () => {
      onCurrentNodesChange(canvas.id, undefined);
    };
  }, [canvas.id, onCurrentNodesChange]);

  useEffect(() => {
    onCurrentNodesChange?.(canvas.id, canvasNodesWithLayoutOverrides({
      nodes: projection.nodes,
      layoutOverrides: currentLayoutOverrides()
    }));
  }, [canvas.id, currentLayoutOverrides, onCurrentNodesChange, projection.nodes, renderSnapshot]);

  useEffect(() => {
    renderSnapshotRef.current = initialRenderSnapshot;
    setRenderSnapshot(initialRenderSnapshot);
  }, [initialRenderSnapshot]);

  useEffect(() => () => {
    stageRuntime.dispose();
  }, [stageRuntime]);

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
    syncVisibility({
      renderSnapshot
    });
  }, [renderSnapshot, syncVisibility]);

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
      surfaceSize: surfaceSizeRef.current,
      selection: selectionRef.current,
      activeNodePaths: activeNodePathsRef.current,
      renderSnapshotScheduler
    });
    recordCanvasPerfFrame({
      enabled: perfMonitorEnabled,
      perfMonitor,
      sessionRef: canvasPerfSessionRef,
      cameraState: runtime.getSnapshot().cameraState,
      renderSnapshot: renderSnapshotRef.current ?? renderSnapshot,
      reactCommitCountRef
    });
  }), [
    perfMonitor,
    perfMonitorEnabled,
    stageRuntime,
    renderSnapshot,
    renderSnapshotScheduler,
    runtime
  ]);

  useEffect(() => {
    return runtime.subscribeCameraState((cameraState) => {
      setCameraState(cameraState);
      const snapshot = runtime.getSnapshot();
      syncCanvasPerfSessionState({
        enabled: perfMonitorEnabled,
        perfMonitor,
        sessionRef: canvasPerfSessionRef,
        reactCommitCountRef,
        snapshot: {
          cameraState,
          camera: snapshot.camera
        },
        minimapOpen: minimapOpen === true
      });
      if (cameraState !== 'idle') {
        return;
      }
      renderSnapshotScheduler.flush({
        camera: snapshot.camera,
        cameraState,
        surfaceSize: surfaceSizeRef.current,
        selection: selectionRef.current,
        activeNodePaths: activeNodePathsRef.current
      });
    });
  }, [
    minimapOpen,
    perfMonitor,
    perfMonitorEnabled,
    renderSnapshotScheduler,
    runtime
  ]);

  useEffect(() => {
    const initialSnapshot = runtime.getSnapshot();
    syncCanvasPerfDragSessionState({
      enabled: perfMonitorEnabled,
      perfMonitor,
      sessionRef: canvasPerfDragSessionRef,
      reactCommitCountRef,
      dragState: initialSnapshot.dragState,
      snapshot: initialSnapshot,
      finalState: canvasPerfFinalState({
        snapshot: initialSnapshot,
        renderSnapshot: renderSnapshotRef.current ?? renderSnapshot
      })
    });
    if (initialSnapshot.dragState) {
      recordCanvasPerfFrame({
        enabled: perfMonitorEnabled,
        perfMonitor,
        sessionRef: canvasPerfDragSessionRef,
        cameraState: initialSnapshot.cameraState,
        renderSnapshot: renderSnapshotRef.current ?? renderSnapshot,
        reactCommitCountRef
      });
    }
    return runtime.subscribeDragState((nextDragState) => {
      const snapshot = runtime.getSnapshot();
      activeLayoutDraftRef.current = canvasSurfaceLayoutDraftFromDragState({
        canvasId: canvas.id,
        dragState: nextDragState,
        point: nextDragState?.current ?? nextDragState?.start
      });
      syncCanvasPerfDragSessionState({
        enabled: perfMonitorEnabled,
        perfMonitor,
        sessionRef: canvasPerfDragSessionRef,
        reactCommitCountRef,
        dragState: nextDragState,
        snapshot,
        finalState: canvasPerfFinalState({
          snapshot,
          renderSnapshot: renderSnapshotRef.current ?? renderSnapshot
        })
      });
      if (nextDragState) {
        recordCanvasPerfFrame({
          enabled: perfMonitorEnabled,
          perfMonitor,
          sessionRef: canvasPerfDragSessionRef,
          cameraState: snapshot.cameraState,
          renderSnapshot: renderSnapshotRef.current ?? renderSnapshot,
          reactCommitCountRef
        });
      }
      const nextActivePaths = activeNodeProjectRelativePaths(nextDragState);
      const nextKey = nextActivePaths.join('\u001f');
      if (nextKey !== activeNodePathKeyRef.current) {
        activeNodePathKeyRef.current = nextKey;
        activeNodePathsRef.current = nextActivePaths;
        syncVisibility({
          renderSnapshot: renderSnapshotRef.current ?? renderSnapshot
        });
      }
      commitRenderSnapshot({
        camera: snapshot.camera,
        cameraState: snapshot.cameraState,
        surfaceSize: surfaceSizeRef.current,
        selection: selectionRef.current,
        activeNodePaths: nextActivePaths
      });
    });
  }, [
    commitRenderSnapshot,
    canvas.id,
    perfMonitor,
    perfMonitorEnabled,
    renderSnapshot,
    syncVisibility,
    runtime
  ]);

  useEffect(() => {
    if (imageResourceZoomTimerRef.current !== undefined) {
      window.clearTimeout(imageResourceZoomTimerRef.current);
      imageResourceZoomTimerRef.current = undefined;
    }
    lastCameraMovementAtRef.current = undefined;
    runtime.setImageResourceZoom(runtime.getSnapshot().camera.z);
  }, [canvas.id, runtime]);

  useEffect(() => {
    setActiveInlineTextEditorPath(undefined);
    setInlineTextEditorFocusRequest(undefined);
    setInlineTextPreviewScrollTopByPath({});
  }, [canvas.id]);

  useEffect(() => () => {
    if (imageResourceZoomTimerRef.current !== undefined) {
      window.clearTimeout(imageResourceZoomTimerRef.current);
    }
  }, []);

  useEffect(() => {
    return runtime.subscribeCameraState((cameraState) => {
      const snapshot = runtime.getSnapshot();
      syncImageResourceZoomForSnapshot({
        ...snapshot,
        cameraState
      });
    });
  }, [runtime, syncImageResourceZoomForSnapshot]);

  const pointerCanvasPoint = useCallback((event: Pick<React.PointerEvent<Element> | React.DragEvent<Element>, 'clientX' | 'clientY'>): CanvasPoint => (
    runtime.coordinates.screenToCanvas({ x: event.clientX, y: event.clientY })
  ), [runtime]);

  const deactivateInlineTextEditor = useCallback((projectRelativePath?: string) => {
    setActiveInlineTextEditorPath((current) => {
      if (projectRelativePath !== undefined && current !== projectRelativePath) {
        return current;
      }
      return undefined;
    });
    setInlineTextEditorFocusRequest((current) => {
      if (projectRelativePath !== undefined && current?.projectRelativePath !== projectRelativePath) {
        return current;
      }
      return undefined;
    });
  }, []);

  const beginNodeMove = useCallback((node: ProjectedCanvasNode, event: React.PointerEvent<Element>) => {
    deactivateInlineTextEditor();
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
  }, [deactivateInlineTextEditor, pointerCanvasPoint, projectedNodes, runtime]);

  const beginNodeResize = useCallback((node: ProjectedCanvasNode, handle: ResizeHandle, event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    deactivateInlineTextEditor();
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
  }, [deactivateInlineTextEditor, pointerCanvasPoint, runtime]);

  const handlePointerMove = useCallback((event: React.PointerEvent<Element>) => {
    runtime.input.updatePointer({
      pointerId: event.pointerId,
      point: pointerCanvasPoint(event),
      modifiers: pointerEventModifiers(event)
    });
  }, [pointerCanvasPoint, runtime]);

  const handlePointerUp = useCallback(async (event: React.PointerEvent<Element>) => {
    const point = pointerCanvasPoint(event);
    const currentDragState = runtime.getSnapshot().dragState;
    const pendingDraft = currentDragState?.pointerId === event.pointerId
      ? canvasSurfaceLayoutDraftFromDragState({
          canvasId: canvas.id,
          dragState: currentDragState,
          point
        })
      : undefined;
    if (pendingDraft) {
      pendingLayoutDraftRef.current = pendingDraft;
    }
    const activeDragState = runtime.input.finishPointer({
      pointerId: event.pointerId,
      point,
      modifiers: pointerEventModifiers(event)
    });
    if (!activeDragState) {
      if (pendingDraft) {
        pendingLayoutDraftRef.current = undefined;
      }
      return;
    }
    const nodeLayouts = pendingDraft?.nodeLayouts ?? [];
    if (nodeLayouts.length === 0) {
      return;
    }
    try {
      await actions.updateCanvasNodeLayouts(canvas.id, { nodeLayouts });
    } catch (error) {
      if (pendingLayoutDraftRef.current === pendingDraft) {
        pendingLayoutDraftRef.current = undefined;
      }
      const snapshot = runtime.getSnapshot();
      commitRenderSnapshot({
        camera: snapshot.camera,
        cameraState: snapshot.cameraState,
        surfaceSize: surfaceSizeRef.current,
        selection: selectionRef.current,
        activeNodePaths: activeNodePathsRef.current
      });
      throw error;
    }
  }, [actions, canvas.id, commitRenderSnapshot, pointerCanvasPoint, runtime]);

  const handlePointerUpEvent = useCallback((event: React.PointerEvent<Element>) => {
    void handlePointerUp(event);
  }, [handlePointerUp]);

  const activateInlineTextEditor = useCallback((projectRelativePath: string, request: { clientX: number; clientY: number }) => {
    const requestId = inlineTextEditorFocusRequestIdRef.current + 1;
    inlineTextEditorFocusRequestIdRef.current = requestId;
    setActiveInlineTextEditorPath(projectRelativePath);
    setInlineTextEditorFocusRequest({ projectRelativePath, requestId, ...request });
  }, []);

  const selectNode = useCallback((node: ProjectedCanvasNode, inlineTextFocusRequest?: { clientX: number; clientY: number } | undefined) => {
    runtime.setSelection({ kind: 'node', projectRelativePath: node.projectRelativePath });
    const nextInlineTextEditorPath = canvasSurfaceNextInlineTextEditorPathForNodeSelection({
      node,
      inlineTextFocusRequest
    });
    if (nextInlineTextEditorPath && inlineTextFocusRequest) {
      activateInlineTextEditor(node.projectRelativePath, inlineTextFocusRequest);
    } else {
      deactivateInlineTextEditor();
    }
  }, [activateInlineTextEditor, deactivateInlineTextEditor, runtime]);

  const updateInlineTextPreviewScrollTop = useCallback((projectRelativePath: string, scrollTop: number) => {
    setInlineTextPreviewScrollTopByPath((current) => (
      current[projectRelativePath] === scrollTop
        ? current
        : { ...current, [projectRelativePath]: scrollTop }
    ));
  }, []);

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
      reservedRects: [...feedbackPlacementContext.reservedRects],
      barSize: canvasFeedbackBarSizeForTarget({
        supportsImageLocalFeedback: input.node.mediaKind === 'image',
        hasCommentRow: canvasFeedbackEntryHasCommentRow(canvasFeedback?.entries[input.node.projectRelativePath])
      })
    });
    if (placement) {
      overlayRuntime.setFeedbackBarPlacement(placement);
    } else {
      overlayRuntime.clearFeedbackBarPlacement();
    }
  }, [canvasFeedback, feedbackPlacementContext.reservedRects, feedbackPlacementContext.viewportRect, overlayRuntime]);

  const handleLocalFeedbackDraft = useCallback((draft: {
    projectRelativePath: string;
    geometry: CanvasFeedbackGeometry;
  }) => {
    if (!onLocalFeedbackDraft) {
      return;
    }
    const node = projectedNodes.find((item) => item.projectRelativePath === draft.projectRelativePath);
    const surfaceRect = surfaceRef.current?.getBoundingClientRect();
    if (!node || !surfaceRect) {
      return;
    }
    const camera = runtime.getSnapshot().camera;
    const feedbackBarTarget = canvasFeedbackBarTargetForProjectedNode({
      node,
      surfaceRect: domRectToFloatingBarRect(surfaceRect),
      camera,
      entry: canvasFeedback?.entries[node.projectRelativePath]
    });
    if (!feedbackBarTarget) {
      return;
    }
    syncFeedbackBarPlacement({ node, surfaceRect, camera });
    onLocalFeedbackDraft({ ...draft, feedbackBarTarget });
  }, [
    canvasFeedback,
    onLocalFeedbackDraft,
    projectedNodes,
    runtime,
    syncFeedbackBarPlacement
  ]);

  const emitFeedbackBarTarget = useCallback(() => {
    const hasFeedbackTargetHandler = Boolean(onFeedbackBarTargetChange);
    if (!onFeedbackBarTargetChange || !canvasFeedback || !hoveredNodePath) {
      onFeedbackBarTargetChange?.(undefined);
      if (shouldClearFeedbackBarPlacementForFeedbackTarget({
        hasFeedbackTargetHandler,
        hasCanvasFeedback: Boolean(canvasFeedback),
        hoveredNodePath,
        hasRenderableFeedbackTarget: false
      })) {
        overlayRuntime.clearFeedbackBarPlacement();
      }
      return;
    }

    const node = projectedNodes.find((item) => item.projectRelativePath === hoveredNodePath);
    const surfaceRect = surfaceRef.current?.getBoundingClientRect();
    if (!node || !surfaceRect) {
      onFeedbackBarTargetChange(undefined);
      if (shouldClearFeedbackBarPlacementForFeedbackTarget({
        hasFeedbackTargetHandler,
        hasCanvasFeedback: true,
        hoveredNodePath,
        hasRenderableFeedbackTarget: false
      })) {
        overlayRuntime.clearFeedbackBarPlacement();
      }
      return;
    }

    const camera = runtime.getSnapshot().camera;
    const feedbackBarTarget = canvasFeedbackBarTargetForProjectedNode({
      node,
      surfaceRect: domRectToFloatingBarRect(surfaceRect),
      camera,
      entry: canvasFeedback.entries[node.projectRelativePath]
    });
    if (!feedbackBarTarget) {
      onFeedbackBarTargetChange(undefined);
      if (shouldClearFeedbackBarPlacementForFeedbackTarget({
        hasFeedbackTargetHandler,
        hasCanvasFeedback: true,
        hoveredNodePath,
        hasRenderableFeedbackTarget: false
      })) {
        overlayRuntime.clearFeedbackBarPlacement();
      }
      return;
    }
    syncFeedbackBarPlacement({ node, surfaceRect, camera });
    onFeedbackBarTargetChange(feedbackBarTarget);
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
      if (!node || node.nodeKind !== 'file' || !surfaceRect) {
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
          deactivateInlineTextEditor();
          runtime.setSelection(undefined);
        }
      }}
      onDragOver={(event) => {
        if (!isCanvasMapProjectTreeDragOver(event.dataTransfer)) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(event) => {
        const input = canvasMapProjectTreeDropInput(canvas.id, event.dataTransfer);
        if (!input) {
          return;
        }
        event.preventDefault();
        void actions.addProjectPathToCanvasMap(input);
      }}
    >
      <div
        ref={stageRef}
        className="canvas-world-stage"
      >
        {renderSnapshot.edges.map((edge) => (
          <svg
            key={edge.id}
            className="canvas-edge-layer"
            aria-hidden="true"
            viewBox={edge.svgViewBox}
            style={{
              left: edge.svgBounds.x,
              top: edge.svgBounds.y,
              width: edge.svgBounds.width,
              height: edge.svgBounds.height
            }}
          >
            <path
              data-canvas-edge-id={edge.id}
              className="canvas-edge"
              d={edge.path}
            />
          </svg>
        ))}
        <CanvasImageNodeAssetProvider value={imageNodeAssetContext}>
          {renderedNodes.map((node) => {
            const selected = isCanvasItemSelected(selection, { kind: 'node', projectRelativePath: node.projectRelativePath });
            const inlineTextEditorActive = activeInlineTextEditorPath === node.projectRelativePath
              || (node.mediaKind === 'text' && selected);
            return (
              <CanvasNodeShell
                key={node.projectRelativePath}
                node={node}
                selected={selected}
                hovered={hoveredNodePath === node.projectRelativePath}
                culled={renderSnapshot.culledNodePaths.has(node.projectRelativePath)}
                zIndex={renderSnapshot.nodeLayers.get(node.projectRelativePath)?.zIndex ?? node.z}
                stageRuntime={stageRuntime}
                actions={actions}
                textBuffer={textFileBuffers[node.projectRelativePath]}
                inlineTextEditorActive={inlineTextEditorActive}
                inlineTextEditorFocusRequest={
                  inlineTextEditorFocusRequest?.projectRelativePath === node.projectRelativePath
                    ? {
                        requestId: inlineTextEditorFocusRequest.requestId,
                        clientX: inlineTextEditorFocusRequest.clientX,
                        clientY: inlineTextEditorFocusRequest.clientY
                      }
                    : undefined
                }
                inlineTextPreviewScrollTop={inlineTextPreviewScrollTopByPath[node.projectRelativePath] ?? 0}
                feedbackEntry={canvasFeedback?.entries[node.projectRelativePath]}
                localFeedbackMode={node.mediaKind === 'image' ? localFeedbackMode : undefined}
                pendingFeedbackRegion={
                  node.mediaKind === 'image' && pendingFeedbackRegion?.projectRelativePath === node.projectRelativePath
                    ? { label: pendingFeedbackRegion.label, geometry: pendingFeedbackRegion.geometry }
                    : undefined
                }
                onLocalFeedbackDraft={handleLocalFeedbackDraft}
                onDeactivateInlineTextEditor={deactivateInlineTextEditor}
                onInlineTextEditorScrollTopChange={updateInlineTextPreviewScrollTop}
                onPointerDown={beginNodeMove}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUpEvent}
                onPointerEnter={handleNodePointerEnter}
                onPointerLeave={handleNodePointerLeave}
                onSelectNode={selectNode}
                onContextMenu={handleNodeContextMenu}
                onResizePointerDown={beginNodeResize}
              />
            );
          })}
        </CanvasImageNodeAssetProvider>
      </div>
      {projectedNodes.length === 0 ? (
        <div className="canvas-empty-state" data-testid="canvas-empty-state">
          <strong>No Canvas Map nodes</strong>
        </div>
      ) : null}
    </div>
  );
}

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

export function canvasSurfaceNextInlineTextEditorPathForNodeSelection(input: {
  currentPath?: string | undefined;
  node: Pick<ProjectedCanvasNode, 'projectRelativePath' | 'mediaKind'>;
  inlineTextFocusRequest?: { clientX: number; clientY: number } | undefined;
}): string | undefined {
  return input.node.mediaKind === 'text' && input.inlineTextFocusRequest
    ? input.node.projectRelativePath
    : undefined;
}

export function isCanvasMapProjectTreeDragOver(dataTransfer: Pick<DataTransfer, 'types'>): boolean {
  return hasInternalProjectTreeDrag(dataTransfer);
}

export function shouldClearFeedbackBarPlacementForFeedbackTarget(input: {
  hasFeedbackTargetHandler: boolean;
  hasCanvasFeedback: boolean;
  hoveredNodePath: string | undefined;
  hasRenderableFeedbackTarget: boolean;
}): boolean {
  if (!input.hasFeedbackTargetHandler || !input.hasCanvasFeedback) {
    return true;
  }
  if (!input.hoveredNodePath) {
    return false;
  }
  return !input.hasRenderableFeedbackTarget;
}

export function canvasSurfaceLayoutDraftFromDragState(input: {
  canvasId: string;
  dragState: CanvasRuntimeDragState | undefined;
  point: CanvasPoint | undefined;
}): CanvasLocalLayoutDraft | undefined {
  if (!input.point || !input.dragState) {
    return undefined;
  }
  const draft = canvasLocalLayoutDraftFromDragState({
    canvasId: input.canvasId,
    dragState: input.dragState,
    point: input.point
  });
  return draft.nodeLayouts.length > 0 ? draft : undefined;
}

export function canvasSurfaceShouldClearPendingLayoutDraft(input: {
  pending: CanvasLocalLayoutDraft | undefined;
  projection: CanvasProjection;
}): boolean {
  if (!input.pending) {
    return false;
  }
  if (input.pending.canvasId !== input.projection.canvasId) {
    return true;
  }
  if (canvasLocalLayoutDraftMatchesProjection(input.pending, input.projection)) {
    return true;
  }
  const nodePaths = new Set(input.projection.nodes.map((node) => node.projectRelativePath));
  return input.pending.nodeLayouts.some((layout) => !nodePaths.has(layout.projectRelativePath));
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

export interface CanvasPerfRuntimeSession {
  sessionId: CanvasPerfSessionId;
  lastFrameTimestamp: number;
  reactCommitCount: number;
  counterTotals: CanvasPerfCounterTotals;
}

interface CanvasPerfDebugSnapshotContext {
  canvasId: string;
  runtime: Pick<CanvasEditorRuntime, 'getSnapshot'>;
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
  enabled: boolean;
  perfMonitor: CanvasPerfMonitor;
  sessionRef: { current: CanvasPerfRuntimeSession | undefined };
  reactCommitCountRef: { current: number };
  snapshot: Pick<CanvasRuntimeSnapshot, 'cameraState' | 'camera'>;
  minimapOpen: boolean;
}): void {
  if (!input.enabled) {
    return;
  }
  const timestamp = canvasPerfTimestamp();
  if (input.snapshot.cameraState === 'moving') {
    if (!input.sessionRef.current) {
      const sessionId = input.perfMonitor.startSession({
        type: input.minimapOpen ? 'camera-minimap' : 'camera-pan',
        timestamp,
        source: 'CanvasSurface',
        detail: {
          minimapOpen: input.minimapOpen,
          zoomLevel: input.snapshot.camera.z
        }
      });
      if (sessionId) {
        input.sessionRef.current = {
          sessionId,
          lastFrameTimestamp: timestamp,
          reactCommitCount: input.reactCommitCountRef.current,
          counterTotals: input.perfMonitor.getCounterTotals()
        };
      }
    }
    return;
  }
  const session = input.sessionRef.current;
  if (session) {
    input.perfMonitor.endSession({
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
  enabled: boolean;
  perfMonitor: CanvasPerfMonitor;
  sessionRef: { current: CanvasPerfRuntimeSession | undefined };
  reactCommitCountRef: { current: number };
  dragState: CanvasRuntimeDragState | undefined;
  snapshot: Pick<CanvasRuntimeSnapshot, 'cameraState' | 'camera'>;
  finalState?: Partial<CanvasPerfFinalState> | undefined;
}): void {
  if (!input.enabled) {
    return;
  }
  const timestamp = canvasPerfTimestamp();
  if (input.dragState) {
    if (!input.sessionRef.current) {
      const sessionId = input.perfMonitor.startSession({
        type: input.dragState.kind === 'move-node' ? 'drag-move-node' : 'drag-resize-node',
        timestamp,
        source: 'CanvasSurface',
        detail: canvasPerfDragSessionDetail(input.dragState)
      });
      if (sessionId) {
        input.sessionRef.current = {
          sessionId,
          lastFrameTimestamp: timestamp,
          reactCommitCount: input.reactCommitCountRef.current,
          counterTotals: input.perfMonitor.getCounterTotals()
        };
      }
    }
    return;
  }
  const session = input.sessionRef.current;
  if (session) {
    input.perfMonitor.endSession({
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
  enabled: boolean;
  perfMonitor: CanvasPerfMonitor;
  sessionRef: { current: CanvasPerfRuntimeSession | undefined };
  cameraState: CanvasRuntimeSnapshot['cameraState'];
  renderSnapshot: CanvasRenderCoordinatorSnapshot;
  reactCommitCountRef: { current: number };
}): void {
  if (!input.enabled || !input.sessionRef.current) {
    return;
  }
  const timestamp = canvasPerfTimestamp();
  const session = input.sessionRef.current;
  const elapsedMs = Math.max(0, timestamp - session.lastFrameTimestamp);
  const reactCommitCount = Math.max(0, input.reactCommitCountRef.current - session.reactCommitCount);
  session.lastFrameTimestamp = timestamp;
  session.reactCommitCount = input.reactCommitCountRef.current;
  if (reactCommitCount > 0) {
    input.perfMonitor.recordCounter({
      timestamp,
      source: 'CanvasSurface',
      sessionTypes: CANVAS_PERF_INTERACTION_SESSION_TYPES,
      name: 'react-commit',
      value: reactCommitCount
    });
  }
  const counterTotals = input.perfMonitor.getCounterTotals();
  input.perfMonitor.recordFrame({
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

function canvasPerfFinalState(input: {
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

function canvasPerfDebugSnapshot(input: CanvasPerfDebugSnapshotContext): DebruteCanvasPerfCanvasSnapshot {
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
    imageResourceZoom: snapshot.imageResourceZoom,
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

export function syncCanvasMovingCameraFrame(input: {
  liveCamera: CanvasRuntimeSnapshot['camera'];
  stageRuntime: Pick<CanvasStageRuntime, 'setCamera'>;
  surfaceSize: CanvasRuntimeSnapshot['surfaceSize'];
  selection: CanvasRuntimeSnapshot['selection'];
  activeNodePaths: readonly string[];
  renderSnapshotScheduler: Pick<ReturnType<typeof createCanvasRenderSnapshotScheduler<CanvasRenderCoordinatorUpdateInput>>, 'requestMoving'>;
}): void {
  input.stageRuntime.setCamera(input.liveCamera);
  input.renderSnapshotScheduler.requestMoving({
    camera: input.liveCamera,
    cameraState: 'moving',
    surfaceSize: input.surfaceSize,
    selection: input.selection,
    activeNodePaths: input.activeNodePaths
  });
}

export function syncCanvasImageResourceZoomForCameraState(input: {
  cameraState: CanvasRuntimeSnapshot['cameraState'];
  currentImageResourceZoom: number;
  liveCameraZoom: number;
  timerRef: { current: number | undefined };
  lastCameraMovementAtRef?: { current: number | undefined } | undefined;
  now?: (() => number) | undefined;
  setImageResourceZoom: (zoom: number) => void;
  setTimeout: (callback: () => void, delay: number) => number;
  clearTimeout: (handle: number) => void;
  settleMs?: number | undefined;
}): void {
  const now = input.now ?? canvasPerfTimestamp;
  const settleMs = input.settleMs ?? CANVAS_IMAGE_PREVIEW_RESOURCE_SETTLE_MS;
  const clearPendingTimer = () => {
    if (input.timerRef.current === undefined) {
      return;
    }
    input.clearTimeout(input.timerRef.current);
    input.timerRef.current = undefined;
  };

  if (input.cameraState !== 'idle') {
    if (input.lastCameraMovementAtRef) {
      input.lastCameraMovementAtRef.current = now();
    }
    clearPendingTimer();
    return;
  }

  if (input.currentImageResourceZoom === input.liveCameraZoom) {
    clearPendingTimer();
    if (input.lastCameraMovementAtRef) {
      input.lastCameraMovementAtRef.current = undefined;
    }
    return;
  }

  clearPendingTimer();
  const elapsedSinceMovement = input.lastCameraMovementAtRef?.current === undefined
    ? settleMs
    : Math.max(0, now() - input.lastCameraMovementAtRef.current);
  const delay = Math.max(0, settleMs - elapsedSinceMovement);
  input.timerRef.current = input.setTimeout(() => {
    input.timerRef.current = undefined;
    if (input.lastCameraMovementAtRef) {
      input.lastCameraMovementAtRef.current = undefined;
    }
    input.setImageResourceZoom(input.liveCameraZoom);
  }, delay);
}

export function createCanvasRenderSnapshotScheduler<T>(input: {
  commit: (next: T) => void;
  perfMonitor?: Pick<CanvasPerfMonitor, 'recordCounter'> | undefined;
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
      input.perfMonitor?.recordCounter({
        sessionTypes: CANVAS_PERF_INTERACTION_SESSION_TYPES,
        timestamp: canvasPerfTimestamp(),
        source: 'CanvasRenderSnapshotScheduler',
        name: 'render-moving-queued',
        value: 1
      });
      if (!requestFrame) {
        pendingInput = undefined;
        input.commit(next);
        return;
      }
      const generation = frameGeneration;
      pendingFrame = requestFrame(() => run(generation));
    },
    flush(next) {
      input.perfMonitor?.recordCounter({
        sessionTypes: CANVAS_PERF_INTERACTION_SESSION_TYPES,
        timestamp: canvasPerfTimestamp(),
        source: 'CanvasRenderSnapshotScheduler',
        name: 'render-idle-flush',
        value: 1
      });
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

export function canvasFeedbackBarTargetForProjectedNode(input: {
  node: ProjectedCanvasNode;
  surfaceRect: FloatingBarRect;
  camera: CanvasCamera;
  entry: CanvasFeedbackEntry | undefined;
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
    supportsImageLocalFeedback: input.node.mediaKind === 'image'
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
