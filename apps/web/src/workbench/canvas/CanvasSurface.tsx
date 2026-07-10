import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  CanvasDocument,
  CanvasFeedbackDocument,
  CanvasFeedbackEntry,
  CanvasFeedbackGeometry,
  CanvasProjection,
  CanvasTextViewportState,
  ProjectedCanvasNode
} from '@debrute/canvas-core';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import type { WorkbenchContextMenuPosition, WorkbenchContextMenuTarget } from '../shell/contextMenu';
import {
  isAdditiveCanvasSelectionModifier,
  type CanvasPoint,
  type ResizeHandle
} from '../services/canvasInteraction';
import {
  canvasFeedbackBarSizeForTarget,
  canvasFeedbackEntryHasItemRow,
  canvasFeedbackLocalToolsetForMediaKind,
  canvasNodeToViewportRect,
  placeCanvasFeedbackBar,
  type CanvasFeedbackBarTarget,
  type CanvasLocalFeedbackDraft,
  type FloatingBarRect
} from '../shell/floatingBars';
import { cameraForCanvasContent } from './CanvasCameraBounds';
import { CanvasImageNodeAssetProvider, type CanvasImageNodeAssetContextValue } from './CanvasImageNodeAssetContext';
import { createCanvasVideoHotkeyController } from './CanvasVideoHotkeyController';
import type { CanvasVideoPlayerHandle } from './CanvasVideoPlayerAdapter';
import type { CanvasMediaFeedbackMode } from './CanvasMediaFeedbackLayer';
import { CanvasNodeShell } from './CanvasNodeShell';
import {
  createCanvasPreviewResourceScheduler,
  type CanvasPreviewResourceScheduler
} from './CanvasPreviewResourceScheduler';
import {
  initialCanvasResourceZoomState,
  nextCanvasResourceZoomState
} from './CanvasResourceZoom';
import { CanvasTextPreviewProvider, useCanvasTextPreviewRuntime } from './CanvasTextPreviewRuntime';
import { CanvasVideoPreviewProvider, useCanvasVideoPreviewRuntime } from './CanvasVideoPreviewRuntime';
import type { CanvasVideoPreviewSource } from './canvasVideoPreviews';
import type { CanvasOverlayRuntime } from './CanvasOverlayRuntime';
import type { PendingCanvasFeedbackItem } from './canvasFeedbackDraft';
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

interface CanvasSurfaceProps {
  canvas: CanvasDocument;
  projection: CanvasProjection;
  runtime: CanvasEditorRuntime;
  actions: WorkbenchActions;
  textFileBuffers: Record<string, TextFileBuffer>;
  canvasFeedback: CanvasFeedbackDocument | undefined;
  localFeedbackMode?: CanvasMediaFeedbackMode | undefined;
  pendingFeedbackItem?: PendingCanvasFeedbackItem | undefined;
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
  textPreviewStyleDependencyKey: string;
}

export function CanvasSurface({
  canvas,
  projection,
  runtime,
  actions,
  textFileBuffers,
  canvasFeedback,
  localFeedbackMode,
  pendingFeedbackItem,
  onLocalFeedbackDraft,
  overlayRuntime,
  minimapOpen,
  feedbackPlacementContext,
  onCurrentNodesChange,
  onFeedbackBarTargetChange,
  onOpenContextMenu,
  textPreviewStyleDependencyKey
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
      pendingFeedbackItem={pendingFeedbackItem}
      onLocalFeedbackDraft={onLocalFeedbackDraft}
      perfMonitor={perfMonitor}
      overlayRuntime={overlayRuntime}
      minimapOpen={minimapOpen}
      feedbackPlacementContext={feedbackPlacementContext}
      onCurrentNodesChange={onCurrentNodesChange}
      onFeedbackBarTargetChange={onFeedbackBarTargetChange}
      onOpenContextMenu={onOpenContextMenu}
      textPreviewStyleDependencyKey={textPreviewStyleDependencyKey}
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
  pendingFeedbackItem,
  onLocalFeedbackDraft,
  perfMonitor,
  overlayRuntime,
  minimapOpen,
  feedbackPlacementContext,
  onCurrentNodesChange,
  onFeedbackBarTargetChange,
  onOpenContextMenu,
  textPreviewStyleDependencyKey
}: CanvasSurfaceProps & {
  perfMonitor: CanvasPerfMonitor;
}): React.ReactElement {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const selection = useCanvasSelection(runtime);
  const surfaceSize = useCanvasSurfaceSize(runtime);
  const initialRuntimeSnapshot = runtime.getSnapshot();
  const initialDragState = initialRuntimeSnapshot.dragState;
  const [cameraState, setCameraState] = useState(initialRuntimeSnapshot.cameraState);
  const [dragState, setDragState] = useState(initialDragState);
  const [resourceZoomState, setResourceZoomState] = useState(() => (
    initialCanvasResourceZoomState(initialRuntimeSnapshot.camera.z)
  ));
  const resourceZoom = resourceZoomState.resourceZoom;
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
  const fittedCanvasIdRef = useRef<string | undefined>(undefined);
  const canvasPerfSessionRef = useRef<CanvasPerfRuntimeSession | undefined>(undefined);
  const canvasPerfDragSessionRef = useRef<CanvasPerfRuntimeSession | undefined>(undefined);
  const reactCommitCountRef = useRef(0);
  const [hoveredNodePath, setHoveredNodePath] = useState<string>();
  const [playingVideoPaths, setPlayingVideoPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [requestedVideoPlayerPath, setRequestedVideoPlayerPath] = useState<string>();
  const [videoTargetRevision, setVideoTargetRevision] = useState(0);

  const projectedNodes = projection.nodes;
  const videoHotkeyController = useMemo(() => createCanvasVideoHotkeyController({
    requestTargetMount: setRequestedVideoPlayerPath
  }), []);
  const videoTargetsRef = useRef(new Map<string, CanvasVideoPlayerHandle>());
  const registerVideoTarget = useCallback((projectRelativePath: string, target: CanvasVideoPlayerHandle | undefined) => {
    videoHotkeyController.register(projectRelativePath, target);
    if (target) {
      videoTargetsRef.current.set(projectRelativePath, target);
    } else {
      videoTargetsRef.current.delete(projectRelativePath);
    }
    setVideoTargetRevision((current) => current + 1);
  }, [videoHotkeyController]);
  const devicePixelRatio = devicePixelRatioValue();
  const perfMonitorEnabled = canvasPerfMonitorEnabled();
  const stageRuntime = useMemo(() => createCanvasStageRuntime({ perfMonitor }), [perfMonitor]);
  const previewResourceScheduler = useMemo(() => createCanvasPreviewResourceScheduler({ perfMonitor }), [perfMonitor]);
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
    resourceZoom,
    devicePixelRatio,
    cameraState,
    dragActive: dragState !== undefined,
    perfMonitor,
    previewResourceScheduler
  }), [cameraState, devicePixelRatio, dragState, perfMonitor, previewResourceScheduler, resourceZoom]);

  selectionRef.current = selection;
  surfaceSizeRef.current = surfaceSize;
  canvasPerfDebugContextRef.current = {
    canvasId: canvas.id,
    runtime,
    resourceZoom,
    renderSnapshot: renderSnapshotRef.current ?? renderSnapshot,
    surfaceElement: surfaceRef.current
  };

  useEffect(() => {
    reactCommitCountRef.current += 1;
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const selectedVideoPath = selectedSingleVideoPath(selectionRef.current, projectedNodes);
      videoHotkeyController.handleKeyDown({
        key: event.key,
        shiftKey: event.shiftKey,
        preventDefault: () => event.preventDefault(),
        selectedVideoPath,
        activeElement: document.activeElement
      });
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [projectedNodes, videoHotkeyController]);

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

  useEffect(() => () => previewResourceScheduler.dispose(), [previewResourceScheduler]);

  useEffect(() => {
    syncCanvasPreviewResourceSchedulerForInteraction({
      scheduler: previewResourceScheduler,
      cameraState,
      dragState
    });
  }, [cameraState, dragState, previewResourceScheduler]);

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

  const syncResourceZoomForSnapshot = useCallback((input: {
    cameraState: CanvasRuntimeSnapshot['cameraState'];
    cameraZoom: number;
  }) => {
    setResourceZoomState((current) => nextCanvasResourceZoomState(current, input));
  }, []);

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
    const snapshot = runtime.getSnapshot();
    syncCanvasPreviewResourceSchedulerForInteraction({
      scheduler: previewResourceScheduler,
      cameraState: snapshot.cameraState,
      dragState: snapshot.dragState
    });
    syncResourceZoomForSnapshot({
      cameraState: snapshot.cameraState,
      cameraZoom: liveCamera.z
    });
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
      cameraState: snapshot.cameraState,
      renderSnapshot: renderSnapshotRef.current ?? renderSnapshot,
      reactCommitCountRef
    });
  }), [
    perfMonitor,
    perfMonitorEnabled,
    stageRuntime,
    renderSnapshot,
    renderSnapshotScheduler,
    runtime,
    previewResourceScheduler,
    syncResourceZoomForSnapshot
  ]);

  useEffect(() => {
    return runtime.subscribeCameraState((cameraState) => {
      const snapshot = runtime.getSnapshot();
      syncCanvasPreviewResourceSchedulerForInteraction({
        scheduler: previewResourceScheduler,
        cameraState,
        dragState: snapshot.dragState
      });
      setCameraState(cameraState);
      syncResourceZoomForSnapshot({
        cameraState,
        cameraZoom: snapshot.camera.z
      });
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
    previewResourceScheduler,
    renderSnapshotScheduler,
    runtime,
    syncResourceZoomForSnapshot
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
      syncCanvasPreviewResourceSchedulerForInteraction({
        scheduler: previewResourceScheduler,
        cameraState: snapshot.cameraState,
        dragState: nextDragState
      });
      setDragState(nextDragState);
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
    previewResourceScheduler,
    renderSnapshot,
    syncVisibility,
    runtime
  ]);

  useEffect(() => {
    setResourceZoomState(initialCanvasResourceZoomState(runtime.getSnapshot().camera.z));
  }, [canvas.id, runtime]);

  const pointerCanvasPoint = useCallback((event: Pick<React.PointerEvent<Element> | React.DragEvent<Element>, 'clientX' | 'clientY'>): CanvasPoint => (
    runtime.coordinates.screenToCanvas({ x: event.clientX, y: event.clientY })
  ), [runtime]);

  const beginNodeMove = useCallback((node: ProjectedCanvasNode, event: React.PointerEvent<Element>) => {
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
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const resizeNode = {
      projectRelativePath: node.projectRelativePath,
      nodeKind: node.nodeKind,
      ...(node.mediaKind === undefined ? {} : { mediaKind: node.mediaKind })
    };
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
  const selectedProjectRelativePathsForTextPreview = useMemo(
    () => selectedNodeProjectRelativePaths(selection),
    [selection]
  );
  const activeVideoPaths = useMemo(() => canvasActiveVideoPaths({
    nodes: projectedNodes,
    selectedProjectRelativePaths: selectedProjectRelativePathsForTextPreview,
    playingVideoPaths,
    requestedVideoPlayerPath
  }), [
    playingVideoPaths,
    projectedNodes,
    requestedVideoPlayerPath,
    selectedProjectRelativePathsForTextPreview
  ]);
  const handleVideoPlayerMounted = useCallback((projectRelativePath: string) => {
    setRequestedVideoPlayerPath((current) => current === projectRelativePath ? undefined : current);
  }, []);
  const handleVideoPlayingChange = useCallback((projectRelativePath: string, playing: boolean) => {
    setPlayingVideoPaths((current) => {
      const hasPath = current.has(projectRelativePath);
      if (playing === hasPath) {
        return current;
      }
      const next = new Set(current);
      if (playing) {
        next.add(projectRelativePath);
      } else {
        next.delete(projectRelativePath);
      }
      return next;
    });
  }, []);
  const handleUpdateVideoPlaybackTime = useCallback((projectRelativePath: string, currentTimeSeconds: number) => {
    void actions.updateCanvasVideoPlaybackState(canvas.id, {
      updates: [{ projectRelativePath, currentTimeSeconds }]
    });
  }, [actions, canvas.id]);
  const handleUpdateTextViewport = useCallback((projectRelativePath: string, viewport: CanvasTextViewportState) => {
    void actions.updateCanvasTextViewportState(canvas.id, {
      updates: [{ projectRelativePath, ...viewport }]
    });
  }, [actions, canvas.id]);

  useEffect(() => {
    const videoPaths = new Set(projectedNodes.filter(isProjectedVideoNode).map((node) => node.projectRelativePath));
    setPlayingVideoPaths((current) => {
      const next = new Set([...current].filter((path) => videoPaths.has(path)));
      return next.size === current.size ? current : next;
    });
    if (requestedVideoPlayerPath && !videoPaths.has(requestedVideoPlayerPath)) {
      setRequestedVideoPlayerPath(undefined);
    }
  }, [projectedNodes, requestedVideoPlayerPath]);

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
        localToolset: canvasFeedbackLocalToolsetForMediaKind(input.node.mediaKind),
        hasItemRow: canvasFeedbackEntryHasItemRow(canvasFeedback?.entries[input.node.projectRelativePath])
      })
    });
    if (placement) {
      overlayRuntime.setFeedbackBarPlacement(placement);
    } else {
      overlayRuntime.clearFeedbackBarPlacement();
    }
  }, [canvasFeedback, feedbackPlacementContext.reservedRects, feedbackPlacementContext.viewportRect, overlayRuntime]);

  const feedbackBarTargetForNode = useCallback((input: {
    node: ProjectedCanvasNode;
    surfaceRect: DOMRect;
    camera: CanvasRuntimeSnapshot['camera'];
  }): CanvasFeedbackBarTarget | undefined => {
    let feedbackBarTarget: CanvasFeedbackBarTarget | undefined;
    const videoTarget = input.node.mediaKind === 'video'
      ? videoTargetsRef.current.get(input.node.projectRelativePath)
      : undefined;
    const currentTimeSeconds = videoTarget?.readCurrentTimeSeconds();
    const startVideoMomentFeedback = videoTarget && currentTimeSeconds !== undefined
      ? ((mode: 'comment' | 'pin' | 'rect') => {
          const lockedTimeSeconds = videoTarget.readCurrentTimeSeconds();
          if (lockedTimeSeconds === undefined || !feedbackBarTarget || !onLocalFeedbackDraft) {
            return;
          }
          videoTarget.pauseAt(lockedTimeSeconds);
          onLocalFeedbackDraft({
            projectRelativePath: input.node.projectRelativePath,
            kind: mode === 'rect' ? 'region' : mode,
            scope: 'moment',
            momentTimeSeconds: lockedTimeSeconds,
            feedbackBarTarget
          });
        })
      : undefined;
    feedbackBarTarget = canvasFeedbackBarTargetForProjectedNode({
      node: input.node,
      surfaceRect: domRectToFloatingBarRect(input.surfaceRect),
      camera: input.camera,
      entry: canvasFeedback?.entries[input.node.projectRelativePath],
      canStartVideoMomentFeedback: Boolean(startVideoMomentFeedback),
      startVideoMomentFeedback,
      seekToMoment: videoTarget ? ((seconds) => videoTarget.pauseAt(seconds)) : undefined
    });
    return feedbackBarTarget;
  }, [canvasFeedback, onLocalFeedbackDraft, videoTargetRevision]);

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
    const feedbackBarTarget = feedbackBarTargetForNode({
      node,
      surfaceRect,
      camera
    });
    if (!feedbackBarTarget) {
      return;
    }
    const scope = node.mediaKind === 'video' ? 'moment' : 'file';
    const momentTimeSeconds = scope === 'moment'
      ? pendingFeedbackItem?.momentTimeSeconds
      : undefined;
    if (scope === 'moment' && momentTimeSeconds === undefined) {
      return;
    }
    if (localFeedbackMode !== 'pin' && localFeedbackMode !== 'rect') {
      return;
    }
    syncFeedbackBarPlacement({ node, surfaceRect, camera });
    onLocalFeedbackDraft({
      projectRelativePath: draft.projectRelativePath,
      kind: localFeedbackMode === 'pin' ? 'pin' : 'region',
      scope,
      geometry: draft.geometry,
      momentTimeSeconds,
      feedbackBarTarget
    });
  }, [
    feedbackBarTargetForNode,
    localFeedbackMode,
    onLocalFeedbackDraft,
    pendingFeedbackItem?.momentTimeSeconds,
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
    const feedbackBarTarget = feedbackBarTargetForNode({
      node,
      surfaceRect,
      camera
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
    feedbackBarTargetForNode,
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
        <CanvasVideoPreviewProvider
          canvasId={canvas.id}
          nodes={projectedNodes}
          activeVideoPaths={activeVideoPaths}
          actions={actions}
          cameraState={cameraState}
          dragState={dragState}
          resourceZoom={resourceZoom}
          devicePixelRatio={devicePixelRatio}
          culledNodePaths={renderSnapshot.culledNodePaths}
          previewResourceScheduler={previewResourceScheduler}
        >
          <CanvasTextPreviewProvider
            canvasId={canvas.id}
            nodes={projectedNodes}
            selectedProjectRelativePaths={selectedProjectRelativePathsForTextPreview}
            textFileBuffers={textFileBuffers}
            actions={actions}
            cameraState={cameraState}
            dragState={dragState}
            resourceZoom={resourceZoom}
            devicePixelRatio={devicePixelRatio}
            culledNodePaths={renderSnapshot.culledNodePaths}
            previewResourceScheduler={previewResourceScheduler}
            styleDependencyKey={textPreviewStyleDependencyKey}
            perfMonitor={perfMonitor}
          >
            <CanvasImageNodeAssetProvider value={imageNodeAssetContext}>
              {renderedNodes.map((node) => (
                <CanvasSurfaceNodeShell
                  key={node.projectRelativePath}
                  node={node}
                  selected={isCanvasItemSelected(selection, { kind: 'node', projectRelativePath: node.projectRelativePath })}
                  hovered={hoveredNodePath === node.projectRelativePath}
                  culled={renderSnapshot.culledNodePaths.has(node.projectRelativePath)}
                  zIndex={renderSnapshot.nodeRenderOrder.get(node.projectRelativePath)?.zIndex ?? node.z}
                  stageRuntime={stageRuntime}
                  actions={actions}
                  textBuffer={textFileBuffers[node.projectRelativePath]}
                  forceVideoPlayerMounted={requestedVideoPlayerPath === node.projectRelativePath}
                  previewInteractionActive={cameraState !== 'idle' || dragState !== undefined}
                  feedbackEntry={canvasFeedback?.entries[node.projectRelativePath]}
                  localFeedbackMode={
                    (node.mediaKind === 'image' || node.mediaKind === 'video') && pendingFeedbackItem?.projectRelativePath === node.projectRelativePath
                      ? localFeedbackMode
                      : node.mediaKind === 'image'
                        ? localFeedbackMode
                        : undefined
                  }
                  pendingFeedbackRegion={
                    (node.mediaKind === 'image' || node.mediaKind === 'video') && pendingFeedbackItem?.projectRelativePath === node.projectRelativePath && pendingFeedbackItem.geometry && typeof pendingFeedbackItem.label === 'number'
                      ? { label: pendingFeedbackItem.label, geometry: pendingFeedbackItem.geometry }
                      : undefined
                  }
                  activeFeedbackMomentTimeSeconds={
                    node.mediaKind === 'video' && pendingFeedbackItem?.projectRelativePath === node.projectRelativePath
                      ? pendingFeedbackItem.momentTimeSeconds
                      : undefined
                  }
                  onLocalFeedbackDraft={handleLocalFeedbackDraft}
                  onPointerDown={beginNodeMove}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUpEvent}
                  onPointerEnter={handleNodePointerEnter}
                  onPointerLeave={handleNodePointerLeave}
                  onSelectNode={selectNode}
                  onContextMenu={handleNodeContextMenu}
                  onResizePointerDown={beginNodeResize}
                  onVideoPlayerMounted={handleVideoPlayerMounted}
                  onVideoPlayingChange={handleVideoPlayingChange}
                  onRegisterVideoTarget={registerVideoTarget}
                  onUpdateVideoPlaybackTime={handleUpdateVideoPlaybackTime}
                  onUpdateTextViewport={handleUpdateTextViewport}
                />
              ))}
            </CanvasImageNodeAssetProvider>
          </CanvasTextPreviewProvider>
        </CanvasVideoPreviewProvider>
      </div>
      {projectedNodes.length === 0 ? (
        <div className="canvas-empty-state" data-testid="canvas-empty-state">
          <strong>No Canvas Map nodes</strong>
        </div>
      ) : null}
    </div>
  );
}

function CanvasSurfaceNodeShell({
  node,
  selected,
  hovered,
  culled,
  zIndex,
  stageRuntime,
  actions,
  textBuffer,
  forceVideoPlayerMounted,
  previewInteractionActive,
  feedbackEntry,
  localFeedbackMode,
  pendingFeedbackRegion,
  activeFeedbackMomentTimeSeconds,
  onLocalFeedbackDraft,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerEnter,
  onPointerLeave,
  onSelectNode,
  onContextMenu,
  onResizePointerDown,
  onVideoPlayerMounted,
  onVideoPlayingChange,
  onRegisterVideoTarget,
  onUpdateVideoPlaybackTime,
  onUpdateTextViewport
}: {
  node: ProjectedCanvasNode;
  selected: boolean;
  hovered: boolean;
  culled: boolean;
  zIndex: number;
  stageRuntime: CanvasStageRuntime;
  actions: WorkbenchActions;
  textBuffer: TextFileBuffer | undefined;
  forceVideoPlayerMounted: boolean;
  previewInteractionActive: boolean;
  feedbackEntry?: CanvasFeedbackEntry | undefined;
  localFeedbackMode?: CanvasMediaFeedbackMode | undefined;
  pendingFeedbackRegion?: {
    label: number;
    geometry: CanvasFeedbackGeometry;
  } | undefined;
  activeFeedbackMomentTimeSeconds?: number | undefined;
  onLocalFeedbackDraft?: ((input: {
    projectRelativePath: string;
    geometry: CanvasFeedbackGeometry;
  }) => void) | undefined;
  onPointerDown: (node: ProjectedCanvasNode, event: React.PointerEvent<Element>) => void;
  onPointerMove: (event: React.PointerEvent<Element>) => void;
  onPointerUp: (event: React.PointerEvent<Element>) => void;
  onPointerEnter: (node: ProjectedCanvasNode, event: React.PointerEvent<Element>) => void;
  onPointerLeave: (node: ProjectedCanvasNode, event: React.PointerEvent<Element>) => void;
  onContextMenu: (node: ProjectedCanvasNode, event: React.MouseEvent<Element>) => void;
  onSelectNode: (node: ProjectedCanvasNode) => void;
  onResizePointerDown: (node: ProjectedCanvasNode, handle: ResizeHandle, event: React.PointerEvent<HTMLButtonElement>) => void;
  onVideoPlayerMounted: (projectRelativePath: string) => void;
  onVideoPlayingChange: (projectRelativePath: string, playing: boolean) => void;
  onRegisterVideoTarget: (projectRelativePath: string, target: CanvasVideoPlayerHandle | undefined) => void;
  onUpdateVideoPlaybackTime: (projectRelativePath: string, currentTimeSeconds: number) => void | Promise<void>;
  onUpdateTextViewport: (projectRelativePath: string, viewport: CanvasTextViewportState) => void | Promise<void>;
}): React.ReactElement {
  const textPreviewRuntime = useCanvasTextPreviewRuntime();
  const videoPreviewRuntime = useCanvasVideoPreviewRuntime();
  const textPreview = node.mediaKind === 'text'
    ? textPreviewRuntime.previewForNode({ node })
    : undefined;
  const textPreviewError = node.mediaKind === 'text'
    ? textPreviewRuntime.previewErrorForNode({ node })
    : undefined;
  const videoPreview = node.mediaKind === 'video'
    ? videoPreviewRuntime.previewForNode({ node })
    : undefined;
  const videoPreviewError = node.mediaKind === 'video'
    ? videoPreviewRuntime.previewErrorForNode({ node })
    : undefined;
  const reportPreviewError = videoPreviewRuntime.reportPreviewError;
  const reportVideoPreviewError = useCallback((
    projectRelativePath: string,
    preview: CanvasVideoPreviewSource,
    message: string
  ) => {
    reportPreviewError({
      projectRelativePath,
      preview,
      message
    });
  }, [reportPreviewError]);
  return (
    <CanvasNodeShell
      node={node}
      selected={selected}
      hovered={hovered}
      culled={culled}
      zIndex={zIndex}
      stageRuntime={stageRuntime}
      actions={actions}
      textBuffer={textBuffer}
      textPreview={textPreview}
      textPreviewError={textPreviewError}
      videoPreview={videoPreview}
      videoPreviewError={videoPreviewError}
      forceVideoPlayerMounted={forceVideoPlayerMounted}
      previewInteractionActive={previewInteractionActive}
      feedbackEntry={feedbackEntry}
      localFeedbackMode={localFeedbackMode}
      pendingFeedbackRegion={pendingFeedbackRegion}
      activeFeedbackMomentTimeSeconds={activeFeedbackMomentTimeSeconds}
      onLocalFeedbackDraft={onLocalFeedbackDraft}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onSelectNode={onSelectNode}
      onContextMenu={onContextMenu}
      onResizePointerDown={onResizePointerDown}
      onVideoPlayerMounted={onVideoPlayerMounted}
      onVideoPlayingChange={onVideoPlayingChange}
      onRegisterVideoTarget={onRegisterVideoTarget}
      onUpdateVideoPlaybackTime={onUpdateVideoPlaybackTime}
      onUpdateTextViewport={onUpdateTextViewport}
      onVideoPreviewError={reportVideoPreviewError}
    />
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

function selectedSingleVideoPath(selection: CanvasSelection | undefined, nodes: readonly ProjectedCanvasNode[]): string | undefined {
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

function isProjectedVideoNode(node: ProjectedCanvasNode): boolean {
  return node.nodeKind === 'file' && node.mediaKind === 'video';
}
