import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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
  type CanvasFeedbackBarTarget
} from '../shell/floatingBars';
import { cameraForCanvasContent } from './CanvasCameraBounds';
import { CanvasImageNodeAssetProvider, type CanvasImageNodeAssetContextValue } from './CanvasImageNodeAssetContext';
import { createCanvasVideoHotkeyController } from './CanvasVideoHotkeyController';
import type { CanvasVideoPlayerHandle } from './CanvasVideoPlayerAdapter';
import type { CanvasMediaFeedbackDraftRegion, CanvasMediaFeedbackMode } from './CanvasMediaFeedbackLayer';
import { CanvasNodeShell } from './CanvasNodeShell';
import { createCanvasPreviewResourceScheduler } from './CanvasPreviewResourceScheduler';
import {
  initialCanvasResourceZoomState,
  nextCanvasResourceZoomState
} from './CanvasResourceZoom';
import { CanvasTextPreviewProvider, useCanvasTextPreviewRuntime } from './CanvasTextPreviewRuntime';
import { CanvasVideoPreviewProvider, useCanvasVideoPreviewRuntime } from './CanvasVideoPreviewRuntime';
import type { CanvasVideoPreviewSource } from './canvasVideoPreviews';
import type { CanvasFeedbackCanvasBinding } from './CanvasFeedbackInteraction';
import { createCanvasPerfBrowserAdapter } from './CanvasPerfBrowserAdapter';
import { createCanvasPerfDebugBridge } from './CanvasPerfDebugBridge';
import {
  createCanvasPerfMonitor,
  type CanvasPerfMonitor
} from './CanvasPerfMonitor';
import { createCanvasRenderLifecycle } from './CanvasRenderLifecycle.js';
import { createCanvasVisibilityController } from './CanvasVisibilityController';
import type {
  CanvasEditorRuntime,
  CanvasRuntimeSnapshot
} from './runtime/CanvasEditorRuntime';
import { createCanvasStageRuntime, type CanvasStageRuntime } from './runtime/CanvasStageRuntime';
import type { CanvasSelection } from './runtime/canvasSelection';
import { isCanvasItemSelected, selectedNodeProjectRelativePaths, toggleCanvasSelectionItem } from './runtime/canvasSelection';
import {
  useCanvasSelection,
  useCanvasSurfaceSize
} from './runtime/useCanvasRuntimeSnapshot';
import {
  canvasNodesWithLayoutOverrides
} from './canvasManualLayoutDraft';
import {
  canvasActiveVideoPaths,
  canvasFeedbackBarTargetForProjectedNode,
  canvasMapProjectTreeDropInput,
  canvasPerfDebugSnapshot,
  canvasPerfFinalState,
  devicePixelRatioValue,
  domRectToFloatingBarRect,
  isCanvasMapProjectTreeDragOver,
  isProjectedVideoNode,
  pointerEventModifiers,
  recordCanvasPerfFrame,
  selectedSingleVideoPath,
  syncCanvasPerfDragSessionState,
  syncCanvasPerfSessionState,
  syncCanvasPreviewResourceSchedulerForInteraction,
  type CanvasPerfDebugSnapshotContext,
  type CanvasPerfRuntimeSession
} from './canvasSurfaceSupport';

const EMPTY_FEEDBACK_ITEM_IDS: ReadonlySet<string> = new Set();

interface CanvasSurfaceProps {
  canvas: CanvasDocument;
  projection: CanvasProjection;
  runtime: CanvasEditorRuntime;
  actions: WorkbenchActions;
  textFileBuffers: Record<string, TextFileBuffer>;
  canvasFeedback: CanvasFeedbackDocument | undefined;
  feedbackInteraction?: CanvasFeedbackCanvasBinding | undefined;
  minimapOpen?: boolean | undefined;
  onCurrentNodesChange?: ((canvasId: string, nodes: ProjectedCanvasNode[] | undefined) => void) | undefined;
  onOpenContextMenu?: ((target: WorkbenchContextMenuTarget, position: WorkbenchContextMenuPosition) => void) | undefined;
  interactionBlocked?: boolean | undefined;
  textPreviewStyleDependencyKey: string;
}

export function CanvasSurface({
  canvas,
  projection,
  runtime,
  actions,
  textFileBuffers,
  canvasFeedback,
  feedbackInteraction,
  minimapOpen,
  onCurrentNodesChange,
  onOpenContextMenu,
  interactionBlocked = false,
  textPreviewStyleDependencyKey
}: CanvasSurfaceProps): React.ReactElement {
  const perfMonitorRef = useRef<CanvasPerfMonitor | undefined>(undefined);
  const perfBrowserAdapter = useMemo(() => (
    __DEBRUTE_CANVAS_PERF__
      ? createCanvasPerfBrowserAdapter({
        onLongAnimationFrame: (entry) => {
          perfMonitorRef.current?.recordLongAnimationFrame(entry);
        }
      })
      : undefined
  ), []);
  const perfMonitor = useMemo(() => (
    __DEBRUTE_CANVAS_PERF__
      ? createCanvasPerfMonitor({
        onEvent: (event) => perfBrowserAdapter?.recordEvent(event)
      })
      : undefined
  ), [perfBrowserAdapter]);
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
      feedbackInteraction={feedbackInteraction}
      perfMonitor={perfMonitor}
      minimapOpen={minimapOpen}
      onCurrentNodesChange={onCurrentNodesChange}
      onOpenContextMenu={onOpenContextMenu}
      interactionBlocked={interactionBlocked}
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
  feedbackInteraction,
  perfMonitor,
  minimapOpen,
  onCurrentNodesChange,
  onOpenContextMenu,
  interactionBlocked = false,
  textPreviewStyleDependencyKey
}: CanvasSurfaceProps & {
  perfMonitor: CanvasPerfMonitor | undefined;
}): React.ReactElement {
  const localFeedbackMode = feedbackInteraction?.localMode;
  const feedbackComposition = feedbackInteraction?.composition;
  const localSpatialFeedbackItems = feedbackInteraction?.localSpatialItems ?? [];
  const suppressedSpatialItemIds = feedbackInteraction?.suppressedSpatialItemIds ?? EMPTY_FEEDBACK_ITEM_IDS;
  const onLocalFeedbackDraft = feedbackInteraction?.handleDraft;
  const onFeedbackBarTargetChange = feedbackInteraction?.handleTargetChange;
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
  const fittedCanvasIdRef = useRef<string | undefined>(undefined);
  const canvasPerfSessionRef = useRef<CanvasPerfRuntimeSession | undefined>(undefined);
  const canvasPerfDragSessionRef = useRef<CanvasPerfRuntimeSession | undefined>(undefined);
  const reactCommitCountRef = useRef(0);
  const [hoveredNodePath, setHoveredNodePath] = useState<string>();
  const [playingVideoPaths, setPlayingVideoPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [requestedVideoPlayerPath, setRequestedVideoPlayerPath] = useState<string>();
  const [videoTargetRevision, setVideoTargetRevision] = useState(0);
  const localFeedbackRegionsByPath = useMemo(() => {
    const byPath = new Map<string, CanvasMediaFeedbackDraftRegion[]>();
    for (const item of localSpatialFeedbackItems) {
      if (!item.geometry) {
        continue;
      }
      const regions = byPath.get(item.projectRelativePath) ?? [];
      regions.push({
        itemId: item.itemId,
        geometry: item.geometry,
        ...(item.momentTimeSeconds === undefined ? {} : { momentTimeSeconds: item.momentTimeSeconds })
      });
      byPath.set(item.projectRelativePath, regions);
    }
    return byPath;
  }, [localSpatialFeedbackItems]);
  const canvasFeedbackEntries = useMemo(() => {
    const entries = canvasFeedback?.entries;
    if (!entries || suppressedSpatialItemIds.size === 0) {
      return entries;
    }
    let filtered: CanvasFeedbackDocument['entries'] | undefined;
    for (const [path, entry] of Object.entries(entries)) {
      const items = entry.items.filter((item) => !suppressedSpatialItemIds.has(item.id));
      if (items.length === entry.items.length) {
        continue;
      }
      filtered ??= { ...entries };
      filtered[path] = { ...entry, items };
    }
    return filtered ?? entries;
  }, [canvasFeedback, suppressedSpatialItemIds]);
  const activeFeedbackMomentTimeSecondsByPath = useMemo(() => {
    const byPath = new Map<string, number>();
    if (feedbackComposition?.scope === 'moment' && feedbackComposition.momentTimeSeconds !== undefined) {
      byPath.set(feedbackComposition.projectRelativePath, feedbackComposition.momentTimeSeconds);
    }
    const activeItemId = feedbackInteraction?.focusedCapsuleId;
    if (!activeItemId) {
      return byPath;
    }
    const local = localSpatialFeedbackItems.find((item) => item.itemId === activeItemId);
    if (local?.scope === 'moment' && local.momentTimeSeconds !== undefined) {
      byPath.set(local.projectRelativePath, local.momentTimeSeconds);
      return byPath;
    }
    for (const [path, entry] of Object.entries(canvasFeedback?.entries ?? {})) {
      const item = entry.items.find((candidate) => candidate.id === activeItemId);
      if (item?.scope === 'moment') {
        byPath.set(path, item.moment.currentTimeSeconds);
        break;
      }
    }
    return byPath;
  }, [canvasFeedback, feedbackComposition, feedbackInteraction?.focusedCapsuleId, localSpatialFeedbackItems]);

  const projectedNodes = projection.nodes;
  const projectedNodesRef = useRef(projectedNodes);
  projectedNodesRef.current = projectedNodes;
  const videoHotkeyController = useMemo(() => createCanvasVideoHotkeyController({
    requestTargetMount: setRequestedVideoPlayerPath
  }), []);
  const videoTargetsRef = useRef(new Map<string, CanvasVideoPlayerHandle>());
  const pendingFeedbackSeekRef = useRef(new Map<string, number>());
  const videoPlaybackUpdateVersionsRef = useRef(new Map<string, number>());
  const registerVideoTarget = useCallback((projectRelativePath: string, target: CanvasVideoPlayerHandle | undefined) => {
    videoHotkeyController.register(projectRelativePath, target);
    if (target) {
      videoTargetsRef.current.set(projectRelativePath, target);
      const pendingFeedbackSeek = pendingFeedbackSeekRef.current.get(projectRelativePath);
      if (pendingFeedbackSeek !== undefined) {
        pendingFeedbackSeekRef.current.delete(projectRelativePath);
        target.pauseAt(pendingFeedbackSeek);
      }
    } else {
      videoTargetsRef.current.delete(projectRelativePath);
    }
    setVideoTargetRevision((current) => current + 1);
  }, [videoHotkeyController]);
  const devicePixelRatio = devicePixelRatioValue();
  const instrumentationMonitor = perfMonitor;
  const stageRuntime = useMemo(() => createCanvasStageRuntime({ perfMonitor: instrumentationMonitor }), [instrumentationMonitor]);
  const previewResourceScheduler = useMemo(() => createCanvasPreviewResourceScheduler({ perfMonitor: instrumentationMonitor }), [instrumentationMonitor]);
  const visibilityController = useMemo(() => createCanvasVisibilityController({ stageRuntime }), [stageRuntime]);
  const renderLifecycle = useMemo(() => createCanvasRenderLifecycle({
    projection,
    runtime,
    stageRuntime,
    visibilityController,
    perfMonitor: instrumentationMonitor
  }), [instrumentationMonitor, runtime, stageRuntime, visibilityController]);
  const renderSnapshot = useSyncExternalStore(
    renderLifecycle.subscribe,
    renderLifecycle.getSnapshot,
    renderLifecycle.getSnapshot
  );
  const currentLayoutOverrides = useCallback(() => (
    runtime.manualLayout.getPresentation().layoutOverrides
  ), [runtime]);
  const canvasPerfDebugContextRef = useRef<CanvasPerfDebugSnapshotContext | undefined>(undefined);
  const imageNodeAssetContext = useMemo<CanvasImageNodeAssetContextValue>(() => ({
    resourceZoom,
    devicePixelRatio,
    cameraState,
    dragActive: dragState !== undefined,
    perfMonitor: instrumentationMonitor,
    previewResourceScheduler
  }), [cameraState, devicePixelRatio, dragState, instrumentationMonitor, previewResourceScheduler, resourceZoom]);

  selectionRef.current = selection;
  canvasPerfDebugContextRef.current = {
    canvasId: canvas.id,
    runtime,
    resourceZoom,
    renderSnapshot,
    surfaceElement: surfaceRef.current
  };

  useEffect(() => {
    if (perfMonitor) {
      reactCommitCountRef.current += 1;
    }
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (interactionBlocked) {
        return;
      }
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
  }, [interactionBlocked, projectedNodes, videoHotkeyController]);

  const perfDebugBridge = useMemo(() => (
    __DEBRUTE_CANVAS_PERF__ && perfMonitor
      ? createCanvasPerfDebugBridge({
        perfMonitor,
        getCanvasSnapshot: () => {
          const context = canvasPerfDebugContextRef.current;
          if (!context) {
            throw new Error('Canvas perf debug snapshot context is unavailable.');
          }
          return canvasPerfDebugSnapshot(context);
        }
      })
      : undefined
  ), [perfMonitor]);

  useEffect(() => {
    perfDebugBridge?.register();
    return () => {
      perfDebugBridge?.unregister();
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

  const syncResourceZoomForSnapshot = useCallback((input: {
    cameraState: CanvasRuntimeSnapshot['cameraState'];
    cameraZoom: number;
  }) => {
    setResourceZoomState((current) => nextCanvasResourceZoomState(current, input));
  }, []);

  useLayoutEffect(() => {
    renderLifecycle.acceptProjection(projection);
  }, [projection, renderLifecycle]);

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

  useEffect(() => () => {
    stageRuntime.dispose();
  }, [stageRuntime]);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    const stage = stageRef.current;
    if (!surface || !stage) {
      return;
    }
    const unbindStage = stageRuntime.bindStage(stage);
    if (interactionBlocked) {
      const dragState = runtime.getSnapshot().dragState;
      if (dragState) {
        runtime.input.cancelPointer(dragState.pointerId);
      }
      return unbindStage;
    }
    const unbindSurface = runtime.bindSurface({ surface });
    return () => {
      unbindStage();
      unbindSurface();
    };
  }, [interactionBlocked, stageRuntime, runtime]);

  useLayoutEffect(() => {
    previewResourceScheduler.notifyVisibilityChanged();
  }, [previewResourceScheduler, renderSnapshot]);

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
    recordCanvasPerfFrame({
      perfMonitor,
      sessionRef: canvasPerfSessionRef,
      cameraState: snapshot.cameraState,
      renderSnapshot: renderLifecycle.getSnapshot(),
      reactCommitCountRef
    });
  }), [
    perfMonitor,
    renderLifecycle,
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
        perfMonitor,
        sessionRef: canvasPerfSessionRef,
        reactCommitCountRef,
        snapshot: {
          cameraState,
          camera: snapshot.camera
        },
        minimapOpen: minimapOpen === true
      });
    });
  }, [
    minimapOpen,
    perfMonitor,
    previewResourceScheduler,
    runtime,
    syncResourceZoomForSnapshot
  ]);

  useEffect(() => {
    const initialSnapshot = runtime.getSnapshot();
    syncCanvasPerfDragSessionState({
      perfMonitor,
      sessionRef: canvasPerfDragSessionRef,
      reactCommitCountRef,
      dragState: initialSnapshot.dragState,
      snapshot: initialSnapshot,
      finalState: canvasPerfFinalState({
        snapshot: initialSnapshot,
        renderSnapshot: renderLifecycle.getSnapshot()
      })
    });
    if (initialSnapshot.dragState) {
      recordCanvasPerfFrame({
        perfMonitor,
        sessionRef: canvasPerfDragSessionRef,
        cameraState: initialSnapshot.cameraState,
        renderSnapshot: renderLifecycle.getSnapshot(),
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
      syncCanvasPerfDragSessionState({
        perfMonitor,
        sessionRef: canvasPerfDragSessionRef,
        reactCommitCountRef,
        dragState: nextDragState,
        snapshot,
        finalState: canvasPerfFinalState({
          snapshot,
          renderSnapshot: renderLifecycle.getSnapshot()
        })
      });
      if (nextDragState) {
        recordCanvasPerfFrame({
          perfMonitor,
          sessionRef: canvasPerfDragSessionRef,
          cameraState: snapshot.cameraState,
          renderSnapshot: renderLifecycle.getSnapshot(),
          reactCommitCountRef
        });
      }
    });
  }, [
    perfMonitor,
    previewResourceScheduler,
    renderLifecycle,
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
      projectRelativePath: node.projectRelativePath,
      start: pointerCanvasPoint(event),
      selection: nextSelection
    });
  }, [pointerCanvasPoint, runtime]);

  const beginNodeResize = useCallback((node: ProjectedCanvasNode, handle: ResizeHandle, event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    runtime.input.beginNodeResize({
      pointerId: event.pointerId,
      handle,
      start: pointerCanvasPoint(event),
      projectRelativePath: node.projectRelativePath,
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
    await runtime.input.finishPointer({
      pointerId: event.pointerId,
      point: pointerCanvasPoint(event),
      modifiers: pointerEventModifiers(event)
    });
  }, [pointerCanvasPoint, runtime]);

  const handlePointerUpEvent = useCallback((event: React.PointerEvent<Element>) => {
    void handlePointerUp(event).catch(() => undefined);
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
  const selectedNodePathsForVideo = useMemo(
    () => selectedNodeProjectRelativePaths(selection),
    [selection]
  );
  const activeInlineTextPath = useMemo(() => {
    if (selection?.kind !== 'node') {
      return undefined;
    }
    return projectedNodes.find((node) => (
      node.projectRelativePath === selection.projectRelativePath
      && node.mediaKind === 'text'
    ))?.projectRelativePath;
  }, [projectedNodes, selection]);
  const activeVideoPaths = useMemo(() => canvasActiveVideoPaths({
    nodes: projectedNodes,
    selectedProjectRelativePaths: selectedNodePathsForVideo,
    playingVideoPaths,
    requestedVideoPlayerPath
  }), [
    playingVideoPaths,
    projectedNodes,
    requestedVideoPlayerPath,
    selectedNodePathsForVideo
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
    const node = projectedNodesRef.current.find((candidate) => (
      candidate.projectRelativePath === projectRelativePath
    ));
    if (node?.mediaKind !== 'video') {
      return;
    }
    const updateKey = `${canvas.id}\u0000${projectRelativePath}`;
    const version = (videoPlaybackUpdateVersionsRef.current.get(updateKey) ?? 0) + 1;
    videoPlaybackUpdateVersionsRef.current.set(updateKey, version);
    void actions.updateCanvasVideoPlaybackState(canvas.id, {
      updates: [{ projectRelativePath, currentTimeSeconds }]
    }).then(() => {
      if (videoPlaybackUpdateVersionsRef.current.get(updateKey) === version) {
        videoPlaybackUpdateVersionsRef.current.delete(updateKey);
      }
    }, () => {
      if (videoPlaybackUpdateVersionsRef.current.get(updateKey) !== version) {
        return;
      }
      videoPlaybackUpdateVersionsRef.current.delete(updateKey);
      const durableNode = projectedNodesRef.current.find((candidate) => (
        candidate.projectRelativePath === projectRelativePath
      ));
      if (durableNode?.mediaKind !== 'video') {
        return;
      }
      videoTargetsRef.current
        .get(projectRelativePath)
        ?.restorePersistedTime(durableNode.videoPlayback?.currentTimeSeconds ?? 0);
    });
  }, [actions, canvas.id]);
  const handleUpdateTextViewport = useCallback((projectRelativePath: string, viewport: CanvasTextViewportState) => {
    const node = projectedNodesRef.current.find((candidate) => (
      candidate.projectRelativePath === projectRelativePath
    ));
    if (node?.mediaKind !== 'text') {
      return;
    }
    void actions.updateCanvasTextViewportState(canvas.id, {
      updates: [{ projectRelativePath, ...viewport }]
    }).catch(() => undefined);
  }, [actions, canvas.id]);

  useEffect(() => {
    const videoPaths = new Set(projectedNodes.filter(isProjectedVideoNode).map((node) => node.projectRelativePath));
    for (const path of pendingFeedbackSeekRef.current.keys()) {
      if (!videoPaths.has(path)) {
        pendingFeedbackSeekRef.current.delete(path);
      }
    }
    setPlayingVideoPaths((current) => {
      const next = new Set([...current].filter((path) => videoPaths.has(path)));
      return next.size === current.size ? current : next;
    });
    if (requestedVideoPlayerPath && !videoPaths.has(requestedVideoPlayerPath)) {
      setRequestedVideoPlayerPath(undefined);
    }
  }, [projectedNodes, requestedVideoPlayerPath]);

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
      seekToMoment: input.node.mediaKind === 'video'
        ? ((seconds) => {
            const mountedTarget = videoTargetsRef.current.get(input.node.projectRelativePath);
            if (mountedTarget) {
              mountedTarget.pauseAt(seconds);
              return;
            }
            pendingFeedbackSeekRef.current.set(input.node.projectRelativePath, seconds);
            setRequestedVideoPlayerPath(input.node.projectRelativePath);
          })
        : undefined
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
      ? feedbackComposition?.momentTimeSeconds
      : undefined;
    if (scope === 'moment' && momentTimeSeconds === undefined) {
      return;
    }
    if (localFeedbackMode !== 'pin' && localFeedbackMode !== 'rect') {
      return;
    }
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
    feedbackComposition?.momentTimeSeconds,
    localFeedbackMode,
    onLocalFeedbackDraft,
    projectedNodes,
    runtime
  ]);

  const handleFeedbackItemActivate = useCallback((projectRelativePath: string, itemId: string) => {
    if (!feedbackInteraction) {
      return;
    }
    const node = projectedNodes.find((item) => item.projectRelativePath === projectRelativePath);
    const surfaceRect = surfaceRef.current?.getBoundingClientRect();
    if (!node || !surfaceRect) {
      return;
    }
    const camera = runtime.getSnapshot().camera;
    const nextTarget = feedbackBarTargetForNode({ node, surfaceRect, camera });
    if (!nextTarget) {
      return;
    }
    feedbackInteraction.activateCapsule(nextTarget, itemId);
  }, [feedbackBarTargetForNode, feedbackInteraction, projectedNodes, runtime]);

  const emitFeedbackBarTarget = useCallback(() => {
    if (!onFeedbackBarTargetChange || !canvasFeedback || !hoveredNodePath) {
      onFeedbackBarTargetChange?.(undefined);
      return;
    }

    const node = projectedNodes.find((item) => item.projectRelativePath === hoveredNodePath);
    const surfaceRect = surfaceRef.current?.getBoundingClientRect();
    if (!node || !surfaceRect) {
      onFeedbackBarTargetChange(undefined);
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
      return;
    }
    onFeedbackBarTargetChange(feedbackBarTarget);
  }, [
    canvasFeedback,
    feedbackBarTargetForNode,
    hoveredNodePath,
    onFeedbackBarTargetChange,
    projectedNodes,
    runtime
  ]);

  useEffect(() => {
    emitFeedbackBarTarget();
  }, [emitFeedbackBarTarget, surfaceSize]);

  useEffect(() => {
    const currentTargetPath = feedbackInteraction?.currentTargetProjectRelativePath;
    if (!currentTargetPath) {
      return;
    }
    const targetStillExists = projectedNodes.some((node) => (
      node.nodeKind === 'file' && node.projectRelativePath === currentTargetPath
    ));
    if (!targetStillExists) {
      feedbackInteraction.invalidateTarget(currentTargetPath);
    }
  }, [feedbackInteraction, projectedNodes]);

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
            activeInlineTextPath={activeInlineTextPath}
            textFileBuffers={textFileBuffers}
            actions={actions}
            cameraState={cameraState}
            dragState={dragState}
            resourceZoom={resourceZoom}
            devicePixelRatio={devicePixelRatio}
            culledNodePaths={renderSnapshot.culledNodePaths}
            styleDependencyKey={textPreviewStyleDependencyKey}
            perfMonitor={instrumentationMonitor}
            previewResourceScheduler={previewResourceScheduler}
          >
            <CanvasImageNodeAssetProvider value={imageNodeAssetContext}>
              {renderedNodes.map((node) => (
                <CanvasSurfaceNodeShell
                  key={node.projectRelativePath}
                  node={node}
                  selected={isCanvasItemSelected(selection, { kind: 'node', projectRelativePath: node.projectRelativePath })}
                  textEditorActive={selection?.kind === 'node'
                    && selection.projectRelativePath === node.projectRelativePath
                    && node.mediaKind === 'text'}
                  hovered={hoveredNodePath === node.projectRelativePath}
                  culled={renderSnapshot.culledNodePaths.has(node.projectRelativePath)}
                  zIndex={renderSnapshot.nodeRenderOrder.get(node.projectRelativePath)?.zIndex ?? node.z}
                  stageRuntime={stageRuntime}
                  actions={actions}
                  textBuffer={textFileBuffers[node.projectRelativePath]}
                  forceVideoPlayerMounted={requestedVideoPlayerPath === node.projectRelativePath}
                  feedbackEntry={canvasFeedbackEntries?.[node.projectRelativePath]}
                  activeFeedbackItemId={feedbackInteraction?.focusedCapsuleId}
                  localFeedbackMode={
                    (node.mediaKind === 'image' || node.mediaKind === 'video') && feedbackComposition?.projectRelativePath === node.projectRelativePath
                      ? localFeedbackMode
                      : node.mediaKind === 'image'
                        ? localFeedbackMode
                        : undefined
                  }
                  localFeedbackRegions={localFeedbackRegionsByPath.get(node.projectRelativePath)}
                  activeFeedbackMomentTimeSeconds={
                    node.mediaKind === 'video'
                      ? activeFeedbackMomentTimeSecondsByPath.get(node.projectRelativePath)
                      : undefined
                  }
                  onLocalFeedbackDraft={handleLocalFeedbackDraft}
                  onFeedbackItemActivate={handleFeedbackItemActivate}
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
  textEditorActive,
  hovered,
  culled,
  zIndex,
  stageRuntime,
  actions,
  textBuffer,
  forceVideoPlayerMounted,
  feedbackEntry,
  activeFeedbackItemId,
  localFeedbackMode,
  localFeedbackRegions,
  activeFeedbackMomentTimeSeconds,
  onLocalFeedbackDraft,
  onFeedbackItemActivate,
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
  textEditorActive: boolean;
  hovered: boolean;
  culled: boolean;
  zIndex: number;
  stageRuntime: CanvasStageRuntime;
  actions: WorkbenchActions;
  textBuffer: TextFileBuffer | undefined;
  forceVideoPlayerMounted: boolean;
  feedbackEntry?: CanvasFeedbackEntry | undefined;
  activeFeedbackItemId?: string | undefined;
  localFeedbackMode?: CanvasMediaFeedbackMode | undefined;
  localFeedbackRegions?: readonly CanvasMediaFeedbackDraftRegion[] | undefined;
  activeFeedbackMomentTimeSeconds?: number | undefined;
  onLocalFeedbackDraft?: ((input: {
    projectRelativePath: string;
    geometry: CanvasFeedbackGeometry;
  }) => void) | undefined;
  onFeedbackItemActivate?: ((projectRelativePath: string, itemId: string) => void) | undefined;
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
  const textPreviewPresentation = node.mediaKind === 'text'
    ? textPreviewRuntime.presentationForNode({ node })
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
      textEditorActive={textEditorActive}
      hovered={hovered}
      culled={culled}
      zIndex={zIndex}
      stageRuntime={stageRuntime}
      actions={actions}
      textBuffer={textBuffer}
      textPreview={textPreviewPresentation?.visible}
      pendingTextPreview={textPreviewPresentation?.pending}
      textPreviewCommittedSourceKey={textPreviewPresentation?.visibleCommittedSourceKey}
      textPreviewError={textPreviewError}
      videoPreview={videoPreview}
      videoPreviewError={videoPreviewError}
      forceVideoPlayerMounted={forceVideoPlayerMounted}
      feedbackEntry={feedbackEntry}
      activeFeedbackItemId={activeFeedbackItemId}
      localFeedbackMode={localFeedbackMode}
      localFeedbackRegions={localFeedbackRegions}
      activeFeedbackMomentTimeSeconds={activeFeedbackMomentTimeSeconds}
      onLocalFeedbackDraft={onLocalFeedbackDraft}
      onFeedbackItemActivate={onFeedbackItemActivate}
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
