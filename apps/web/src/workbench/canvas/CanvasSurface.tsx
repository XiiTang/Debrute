import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { DebruteProductPlatform } from '@debrute/app-protocol';
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
import type { CanvasPoint, ResizeHandle } from '../services/canvasInteraction.js';
import { projectPathCommandEntryForCanvasNode } from '../services/projectPathCommandTarget.js';
import {
  type CanvasFeedbackNodeBarTarget
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
import {
  canvasNodeSelection,
  isCanvasNodeSelected,
  selectedNodeProjectRelativePaths
} from './runtime/canvasSelection.js';
import {
  useCanvasPointerInteraction,
  useCanvasSelection,
  useCanvasSurfaceSize
} from './runtime/useCanvasRuntimeSnapshot.js';
import {
  canvasNodesWithLayoutOverrides
} from './canvasManualLayoutDraft';
import {
  canvasActiveVideoPaths,
  canvasFeedbackBarTargetForProjectedNode,
  canvasFeedbackBarTargetForSelection,
  canvasMapProjectTreeDropInput,
  canvasPerfDebugSnapshot,
  canvasPerfFinalState,
  devicePixelRatioValue,
  domRectToFloatingBarRect,
  isCanvasMapProjectTreeDragOver,
  isCanvasPrimaryPointerEvent,
  isProjectedVideoNode,
  pointerEventModifiers,
  recordCanvasPerfFrame,
  selectedSingleVideoPath,
  syncCanvasPerfPointerInteractionSessionState,
  syncCanvasPerfSessionState,
  canvasPreviewResourceInteractionState,
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
  productPlatform: DebruteProductPlatform;
  cutPaths?: readonly string[] | undefined;
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
  productPlatform,
  cutPaths = [],
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
      productPlatform={productPlatform}
      cutPaths={cutPaths}
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
  productPlatform,
  cutPaths = [],
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
  const cutPathSet = useMemo(() => new Set(cutPaths), [cutPaths]);
  const selection = useCanvasSelection(runtime);
  const pointerInteraction = useCanvasPointerInteraction(runtime);
  const surfaceSize = useCanvasSurfaceSize(runtime);
  const initialRuntimeSnapshot = runtime.getSnapshot();
  const [cameraState, setCameraState] = useState(initialRuntimeSnapshot.cameraState);
  const [pointerInteractionActive, setPointerInteractionActive] = useState(initialRuntimeSnapshot.pointerInteraction !== undefined);
  const interactionActive = cameraState !== 'idle' || pointerInteractionActive;
  const [resourceZoomState, setResourceZoomState] = useState(() => (
    initialCanvasResourceZoomState(initialRuntimeSnapshot.camera.z)
  ));
  const resourceZoom = resourceZoomState.resourceZoom;
  const selectionRef = useRef<CanvasSelection | undefined>(selection);
  const fittedCanvasIdRef = useRef<string | undefined>(undefined);
  const canvasPerfSessionRef = useRef<CanvasPerfRuntimeSession | undefined>(undefined);
  const canvasPerfPointerInteractionSessionRef = useRef<CanvasPerfRuntimeSession | undefined>(undefined);
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
    perfMonitor: instrumentationMonitor,
    previewResourceScheduler
  }), [devicePixelRatio, instrumentationMonitor, previewResourceScheduler, resourceZoom]);

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
      const activeElement = document.activeElement;
      const focusedCanvasNodePath = activeElement
        ?.closest('[data-canvas-node-path]')
        ?.getAttribute('data-canvas-node-path');
      if (!selectedVideoPath || focusedCanvasNodePath !== selectedVideoPath) {
        return;
      }
      videoHotkeyController.handleKeyDown({
        key: event.key,
        shiftKey: event.shiftKey,
        preventDefault: () => event.preventDefault(),
        selectedVideoPath,
        activeElement
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
    previewResourceScheduler.setInteractionState(canvasPreviewResourceInteractionState({
      cameraState,
      pointerInteraction: pointerInteractionActive ? runtime.getSnapshot().pointerInteraction : undefined
    }));
  }, [cameraState, pointerInteractionActive, previewResourceScheduler, runtime]);

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
      const pointerInteraction = runtime.getSnapshot().pointerInteraction;
      if (pointerInteraction) {
        runtime.input.cancelPointer(pointerInteraction.pointerId);
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
    previewResourceScheduler.setInteractionState(canvasPreviewResourceInteractionState(snapshot));
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
      previewResourceScheduler.setInteractionState(canvasPreviewResourceInteractionState({
        cameraState,
        pointerInteraction: snapshot.pointerInteraction
      }));
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
    syncCanvasPerfPointerInteractionSessionState({
      perfMonitor,
      sessionRef: canvasPerfPointerInteractionSessionRef,
      reactCommitCountRef,
      pointerInteraction: initialSnapshot.pointerInteraction,
      snapshot: initialSnapshot,
      finalState: canvasPerfFinalState({
        snapshot: initialSnapshot,
        renderSnapshot: renderLifecycle.getSnapshot()
      })
    });
    if (initialSnapshot.pointerInteraction) {
      recordCanvasPerfFrame({
        perfMonitor,
        sessionRef: canvasPerfPointerInteractionSessionRef,
        cameraState: initialSnapshot.cameraState,
        renderSnapshot: renderLifecycle.getSnapshot(),
        reactCommitCountRef
      });
    }
    return runtime.subscribePointerInteraction((nextPointerInteraction) => {
      const snapshot = runtime.getSnapshot();
      previewResourceScheduler.setInteractionState(canvasPreviewResourceInteractionState({
        cameraState: snapshot.cameraState,
        pointerInteraction: nextPointerInteraction
      }));
      setPointerInteractionActive(nextPointerInteraction !== undefined);
      syncCanvasPerfPointerInteractionSessionState({
        perfMonitor,
        sessionRef: canvasPerfPointerInteractionSessionRef,
        reactCommitCountRef,
        pointerInteraction: nextPointerInteraction,
        snapshot,
        finalState: canvasPerfFinalState({
          snapshot,
          renderSnapshot: renderLifecycle.getSnapshot()
        })
      });
      if (nextPointerInteraction) {
        recordCanvasPerfFrame({
          perfMonitor,
          sessionRef: canvasPerfPointerInteractionSessionRef,
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

  const pointerScreenPoint = useCallback((
    event: Pick<React.PointerEvent<Element> | React.DragEvent<Element>, 'clientX' | 'clientY'>
  ): CanvasPoint => ({ x: event.clientX, y: event.clientY }), []);

  const beginNodeMove = useCallback((node: ProjectedCanvasNode, event: React.PointerEvent<Element>) => {
    if (!isCanvasPrimaryPointerEvent(event, productPlatform) || interactionBlocked) {
      return;
    }
    surfaceRef.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    runtime.input.beginNodeMove({
      pointerId: event.pointerId,
      projectRelativePath: node.projectRelativePath,
      screenPoint: pointerScreenPoint(event),
      modifiers: pointerEventModifiers(event, productPlatform)
    });
  }, [interactionBlocked, pointerScreenPoint, productPlatform, runtime]);

  const beginNodeResize = useCallback((node: ProjectedCanvasNode, handle: ResizeHandle, event: React.PointerEvent<HTMLButtonElement>) => {
    if (!isCanvasPrimaryPointerEvent(event, productPlatform) || interactionBlocked) {
      return;
    }
    event.stopPropagation();
    surfaceRef.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    runtime.input.beginNodeResize({
      pointerId: event.pointerId,
      handle,
      screenPoint: pointerScreenPoint(event),
      projectRelativePath: node.projectRelativePath,
      modifiers: pointerEventModifiers(event, productPlatform)
    });
  }, [interactionBlocked, pointerScreenPoint, productPlatform, runtime]);

  const beginSelectionMarquee = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (
      !isCanvasPrimaryPointerEvent(event, productPlatform)
      || interactionBlocked
      || !isTrueCanvasBlankTarget(event.currentTarget, event.target)
    ) {
      return;
    }
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    runtime.input.beginSelectionMarquee({
      pointerId: event.pointerId,
      screenPoint: pointerScreenPoint(event),
      modifiers: pointerEventModifiers(event, productPlatform),
      topEdgeInset: canvasTopEdgeInset(event.currentTarget)
    });
  }, [interactionBlocked, pointerScreenPoint, productPlatform, runtime]);

  const handlePointerMove = useCallback((event: React.PointerEvent<Element>) => {
    runtime.input.updatePointer({
      pointerId: event.pointerId,
      screenPoint: pointerScreenPoint(event),
      modifiers: pointerEventModifiers(event, productPlatform)
    });
  }, [pointerScreenPoint, productPlatform, runtime]);

  const handlePointerUp = useCallback(async (event: React.PointerEvent<Element>) => {
    await runtime.input.finishPointer({
      pointerId: event.pointerId,
      screenPoint: pointerScreenPoint(event),
      modifiers: pointerEventModifiers(event, productPlatform)
    });
  }, [pointerScreenPoint, productPlatform, runtime]);

  const handlePointerUpEvent = useCallback((event: React.PointerEvent<Element>) => {
    void handlePointerUp(event).catch(() => undefined);
  }, [handlePointerUp]);

  const cancelPointerEvent = useCallback((event: React.PointerEvent<Element>) => {
    runtime.input.cancelPointer(event.pointerId);
  }, [runtime]);

  const selectNode = useCallback((node: ProjectedCanvasNode) => {
    runtime.setSelection(canvasNodeSelection([node.projectRelativePath]));
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
    const currentSelection = runtime.getSnapshot().selection;
    const preserveSelection = isCanvasNodeSelected(currentSelection, node.projectRelativePath);
    if (!preserveSelection) {
      runtime.setSelection(canvasNodeSelection([node.projectRelativePath]));
    }
    const selectedPaths = preserveSelection
      ? selectedNodeProjectRelativePaths(currentSelection)
      : [node.projectRelativePath];
    const selectedEntries = selectedPaths.flatMap((path) => {
      const selectedNode = projectedNodes.find((candidate) => candidate.projectRelativePath === path);
      return selectedNode ? [projectPathCommandEntryForCanvasNode(selectedNode)] : [];
    });
    onOpenContextMenu?.({
      source: 'canvas',
      invocationEntry: projectPathCommandEntryForCanvasNode(node),
      selectedEntries
    }, {
      x: event.clientX,
      y: event.clientY
    });
  }, [onOpenContextMenu, projectedNodes, runtime]);

  const renderedNodes = [...renderSnapshot.nodesByPath.values()];
  const selectedNodePathsForVideo = useMemo(
    () => selectedNodeProjectRelativePaths(selection),
    [selection]
  );
  const activeInlineTextPath = useMemo(() => {
    if (selection?.kind !== 'nodes' || selection.projectRelativePaths.length !== 1) {
      return undefined;
    }
    const selectedPath = selection.projectRelativePaths[0]!;
    return projectedNodes.find((node) => (
      node.projectRelativePath === selectedPath
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
  }): CanvasFeedbackNodeBarTarget => {
    let feedbackBarTarget: CanvasFeedbackNodeBarTarget | undefined;
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
  }, [onLocalFeedbackDraft, videoTargetRevision]);

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
    const scope = node.mediaKind === 'video' ? 'moment' : 'node';
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
    if (!onFeedbackBarTargetChange || !canvasFeedback) {
      onFeedbackBarTargetChange?.(undefined);
      return;
    }
    const surfaceRect = surfaceRef.current?.getBoundingClientRect();
    if (!surfaceRect) {
      onFeedbackBarTargetChange(undefined);
      return;
    }
    const camera = runtime.getSnapshot().camera;
    if (selection?.kind === 'nodes' && selection.projectRelativePaths.length > 1) {
      onFeedbackBarTargetChange(canvasFeedbackBarTargetForSelection({
        projectRelativePaths: selection.projectRelativePaths,
        nodes: renderedNodes,
        surfaceRect: domRectToFloatingBarRect(surfaceRect),
        camera
      }));
      return;
    }
    if (hoveredNodePath === undefined) {
      onFeedbackBarTargetChange(undefined);
      return;
    }
    const node = renderedNodes.find((item) => item.projectRelativePath === hoveredNodePath);
    if (!node) {
      onFeedbackBarTargetChange(undefined);
      return;
    }
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
    renderedNodes,
    runtime,
    selection
  ]);

  useEffect(() => {
    emitFeedbackBarTarget();
  }, [emitFeedbackBarTarget, surfaceSize]);

  useEffect(() => {
    if (!feedbackInteraction) {
      return;
    }
    const currentTargetPath = feedbackInteraction.currentTargetProjectRelativePath;
    if (currentTargetPath === undefined) {
      return;
    }
    const targetStillExists = projectedNodes.some((node) => node.projectRelativePath === currentTargetPath);
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
      tabIndex={0}
      onPointerDown={beginSelectionMarquee}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUpEvent}
      onPointerCancel={cancelPointerEvent}
      onLostPointerCapture={cancelPointerEvent}
      onContextMenu={(event) => {
        if (!isTrueCanvasBlankTarget(event.currentTarget, event.target)) {
          return;
        }
        event.preventDefault();
        runtime.setSelection(undefined);
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
          interactionActive={interactionActive}
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
            interactionActive={interactionActive}
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
                  selected={isCanvasNodeSelected(selection, node.projectRelativePath)}
                  cut={cutPathSet.has(node.projectRelativePath)}
                  showResizeHandles={selection?.kind === 'nodes'
                    && selection.projectRelativePaths.length === 1
                    && selection.projectRelativePaths[0] === node.projectRelativePath}
                  textEditorActive={selection?.kind === 'nodes'
                    && selection.projectRelativePaths.length === 1
                    && selection.projectRelativePaths[0] === node.projectRelativePath
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
      <CanvasSelectionMarqueeOverlay
        interaction={pointerInteraction}
        runtime={runtime}
        surfaceElement={surfaceRef.current}
      />
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
  cut,
  showResizeHandles,
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
  cut: boolean;
  showResizeHandles: boolean;
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
      cut={cut}
      showResizeHandles={showResizeHandles}
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

function CanvasSelectionMarqueeOverlay({
  interaction,
  runtime,
  surfaceElement
}: {
  interaction: CanvasRuntimeSnapshot['pointerInteraction'];
  runtime: CanvasEditorRuntime;
  surfaceElement: HTMLElement | null;
}): React.ReactElement | null {
  if (
    interaction?.kind !== 'selection-marquee'
    || interaction.phase !== 'active'
    || !interaction.rect
    || !surfaceElement
  ) {
    return null;
  }
  const screenRect = runtime.coordinates.canvasRectToScreen(interaction.rect);
  const surfaceRect = surfaceElement.getBoundingClientRect();
  return (
    <div
      className="canvas-selection-marquee"
      data-testid="canvas-selection-marquee"
      style={{
        left: screenRect.x - surfaceRect.left,
        top: screenRect.y - surfaceRect.top,
        width: screenRect.width,
        height: screenRect.height
      }}
    />
  );
}

function isTrueCanvasBlankTarget(surface: HTMLElement, target: EventTarget | null): boolean {
  if (!(target instanceof Element) || !surface.contains(target)) {
    return false;
  }
  return !target.closest([
    '[data-canvas-entity="node"]',
    'button',
    'input',
    'select',
    'textarea',
    '[contenteditable="true"]',
    '[data-canvas-interaction-owner]'
  ].join(','));
}

function canvasTopEdgeInset(surface: HTMLElement): number {
  const titleBar = document.querySelector<HTMLElement>('[data-testid="workbench-titlebar"]');
  if (!titleBar) {
    return 0;
  }
  const surfaceRect = surface.getBoundingClientRect();
  return Math.max(0, titleBar.getBoundingClientRect().bottom - surfaceRect.top);
}
