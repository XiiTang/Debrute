import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { DebruteProductPlatform } from '@debrute/app-protocol';
import type {
  CanvasFeedbackDocument,
  CanvasFeedbackEntry,
  CanvasFeedbackGeometry,
  CanvasState,
  CanvasTextViewportState
} from '@debrute/app-protocol';
import type { CanvasProjection, ProjectedCanvasNode } from './CanvasScene.js';
import type { TextFileBuffer } from '../../types';
import type { WorkbenchContextMenuPosition, WorkbenchContextMenuTarget } from '../shell/contextMenu';
import type { CanvasPoint, ResizeHandle } from '../services/canvasInteraction.js';
import { projectPathCommandEntryForCanvasNode } from '../services/projectPathCommandTarget.js';
import {
  type CanvasFeedbackNodeBarTarget
} from '../shell/floatingBars';
import { cameraForCanvasContent } from './CanvasCameraBounds';
import {
  CanvasRasterPreviewEnvironmentProvider,
  type CanvasRasterPreviewEnvironment
} from './CanvasRasterPreviewPresentation';
import { createCanvasVideoHotkeyController } from './CanvasVideoHotkeyController';
import type { CanvasVideoPlayerHandle } from './CanvasVideoPlayerAdapter';
import type { CanvasMediaFeedbackDraftRegion, CanvasMediaFeedbackMode } from './CanvasMediaFeedbackLayer';
import {
  resolveCanvasDomInteractionTarget,
  type CanvasDomInteractionTarget,
  type CanvasPreviewActivationRequest
} from './CanvasDomInteractionAdapter.js';
import { CanvasMovingCameraHitTestBlocker } from './CanvasMovingCameraHitTestBlocker.js';
import { CanvasNodeShell } from './CanvasNodeShell';
import { createCanvasPreviewResourceScheduler } from './CanvasPreviewResourceScheduler';
import {
  initialCanvasResourceZoom,
  nextCanvasResourceZoom
} from './CanvasResourceZoom.js';
import {
  CanvasTextPreviewProvider,
  useCanvasTextPreviewNode,
  type CanvasTextPreviewNodeSnapshot
} from './CanvasTextPreviewRuntime.js';
import {
  CanvasVideoPreviewProvider,
  useCanvasVideoPreviewNode,
  type CanvasVideoPreviewNodeSnapshot
} from './CanvasVideoPreviewRuntime.js';
import type { CanvasFeedbackCanvasBinding } from './CanvasFeedbackInteraction';
import type { CanvasSceneActions } from './CanvasSceneActions.js';
import { createCanvasPerfBrowserAdapter } from './CanvasPerfBrowserAdapter';
import { createCanvasPerfDebugBridge } from './CanvasPerfDebugBridge';
import {
  createCanvasPerfMonitor,
  type CanvasPerfMonitor
} from './CanvasPerfMonitor';
import { createCanvasRenderLifecycle } from './CanvasRenderLifecycle.js';
import type { CanvasEdgeRoutingGroup } from './CanvasEdgeRoutingGroup.js';
import type {
  CanvasEditorRuntime,
  CanvasRuntimePointerInteraction,
  CanvasRuntimeSnapshot
} from './runtime/CanvasEditorRuntime';
import { createCanvasInteractionRuntime } from './runtime/CanvasInteractionRuntime.js';
import { createCanvasStageRuntime, type CanvasStageRuntime } from './runtime/CanvasStageRuntime';
import {
  canvasNodeSelection,
  isCanvasNodeSelected,
  selectedNodeProjectRelativePaths
} from './runtime/canvasSelection.js';
import {
  useCanvasContentInteraction,
  useCanvasPointerInteraction,
  useCanvasSurfaceSize
} from './runtime/useCanvasRuntimeSnapshot.js';
import {
  canvasActiveVideoPaths,
  canvasFeedbackBarTargetForProjectedNode,
  canvasFeedbackBarTargetForSelection,
  canvasPerfDebugSnapshot,
  canvasPerfFinalState,
  devicePixelRatioValue,
  domRectToFloatingBarRect,
  isCanvasPrimaryPointerEvent,
  isProjectedVideoNode,
  pointerEventModifiers,
  recordCanvasPerfFrame,
  syncCanvasPerfPointerInteractionSessionState,
  syncCanvasPerfSessionState,
  canvasPreviewResourceInteractionState,
  type CanvasPerfDebugSnapshotContext,
  type CanvasPerfRuntimeSession
} from './canvasSurfaceSupport';

const EMPTY_FEEDBACK_ITEM_IDS: ReadonlySet<string> = new Set();
const EMPTY_CANVAS_STATE: CanvasState = {
  expandedDirectories: [],
  nodeStates: {},
  occlusionOrder: []
};

interface CanvasPreviewActivationCandidate {
  pointerId: number;
  projectRelativePath: string;
  mediaKind: 'text' | 'video' | 'audio';
}

interface CanvasSurfaceProps {
  canvasState?: CanvasState | undefined;
  projection: CanvasProjection;
  runtime: CanvasEditorRuntime;
  actions: CanvasSceneActions;
  textFileBuffers: Record<string, TextFileBuffer>;
  canvasFeedback: CanvasFeedbackDocument | undefined;
  feedbackInteraction?: CanvasFeedbackCanvasBinding | undefined;
  minimapOpen?: boolean | undefined;
  productPlatform: DebruteProductPlatform;
  cutPaths?: readonly string[] | undefined;
  onOpenContextMenu?: ((target: WorkbenchContextMenuTarget, position: WorkbenchContextMenuPosition) => void) | undefined;
  interactionBlocked?: boolean | undefined;
  textPreviewStyleDependencyKey: string;
}

export function CanvasSurface({
  canvasState = EMPTY_CANVAS_STATE,
  projection,
  runtime,
  actions,
  textFileBuffers,
  canvasFeedback,
  feedbackInteraction,
  minimapOpen,
  productPlatform,
  cutPaths = [],
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
      canvasState={canvasState}
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
      onOpenContextMenu={onOpenContextMenu}
      interactionBlocked={interactionBlocked}
      textPreviewStyleDependencyKey={textPreviewStyleDependencyKey}
    />
  );
}

function CanvasSurfaceRuntime({
  canvasState = EMPTY_CANVAS_STATE,
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
  const contentInteractionPath = useCanvasContentInteraction(runtime);
  const surfaceSize = useCanvasSurfaceSize(runtime);
  const initialRuntimeSnapshot = runtime.getSnapshot();
  const [resourceZoom, setResourceZoom] = useState(() => (
    initialCanvasResourceZoom(initialRuntimeSnapshot.camera.z)
  ));
  const resourceZoomRef = useRef(resourceZoom);
  resourceZoomRef.current = resourceZoom;
  const fittedCanvasRef = useRef(false);
  const canvasPerfSessionRef = useRef<CanvasPerfRuntimeSession | undefined>(undefined);
  const canvasPerfPointerInteractionSessionRef = useRef<CanvasPerfRuntimeSession | undefined>(undefined);
  const reactCommitCountRef = useRef(0);
  const feedbackHoverSuspendedRef = useRef(false);
  const previewActivationCandidateRef = useRef<CanvasPreviewActivationCandidate | undefined>(undefined);
  const nextPreviewActivationRequestIdRef = useRef(0);
  const [previewActivationRequest, setPreviewActivationRequest] = useState<CanvasPreviewActivationRequest>();
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
  const interactionRuntime = useMemo(() => createCanvasInteractionRuntime(), []);
  useEffect(() => {
    let lastSubmittedSelection = '';
    let pointerInteraction: CanvasRuntimePointerInteraction | undefined;
    const submitSelection = () => {
      if (runtime.getSnapshot().pointerInteraction) {
        return;
      }
      const paths = selectedNodeProjectRelativePaths(runtime.getSnapshot().selection);
      if (paths.length === 0) {
        lastSubmittedSelection = '';
        return;
      }
      const key = paths.join('\u001f');
      if (key === lastSubmittedSelection) {
        return;
      }
      lastSubmittedSelection = key;
      void actions.raiseCanvasSelection({
        projectRelativePaths: paths
      }).catch(() => {
        lastSubmittedSelection = '';
      });
    };
    const unsubscribeSelection = runtime.subscribeSelection(submitSelection);
    const unsubscribePointer = runtime.subscribePointerInteraction((interaction) => {
      if (interaction) {
        pointerInteraction = interaction;
        return;
      }
      const completed = pointerInteraction;
      pointerInteraction = undefined;
      if (
        (completed?.kind === 'move-node' || completed?.kind === 'resize-node')
        && completed.phase === 'active'
      ) {
        const paths = selectedNodeProjectRelativePaths(runtime.getSnapshot().selection);
        lastSubmittedSelection = paths.join('\u001f');
        return;
      }
      if (
        completed?.kind === 'move-node'
        && completed.phase === 'pending'
        && isCanvasNodeSelected(completed.initialSelection, completed.pressedProjectRelativePath)
      ) {
        lastSubmittedSelection = '';
      } else if (completed?.kind === 'selection-marquee') {
        lastSubmittedSelection = '';
      }
      submitSelection();
    });
    return () => {
      unsubscribeSelection();
      unsubscribePointer();
    };
  }, [actions, runtime]);
  const renderLifecycle = useMemo(() => createCanvasRenderLifecycle({
    runtime,
    stageRuntime,
    perfMonitor: instrumentationMonitor
  }), [instrumentationMonitor, runtime, stageRuntime]);
  useLayoutEffect(() => renderLifecycle.attach(), [renderLifecycle]);
  const previewResourceScheduler = useMemo(() => createCanvasPreviewResourceScheduler({
    perfMonitor: instrumentationMonitor,
    distanceSquaredForNode: renderLifecycle.previewDistanceSquaredForNode
  }), [instrumentationMonitor, renderLifecycle]);
  const renderSnapshot = useSyncExternalStore(
    runtime.scene.subscribeRenderSnapshot,
    runtime.scene.getRenderSnapshot,
    runtime.scene.getRenderSnapshot
  );
  const canvasPerfDebugContextRef = useRef<CanvasPerfDebugSnapshotContext | undefined>(undefined);
  const rasterPreviewEnvironment = useMemo<CanvasRasterPreviewEnvironment>(() => ({
    resourceZoom,
    devicePixelRatio,
    previewResourceScheduler,
    perfMonitor: instrumentationMonitor
  }), [devicePixelRatio, instrumentationMonitor, previewResourceScheduler, resourceZoom]);

  canvasPerfDebugContextRef.current = {
    runtime,
    resourceZoom,
    renderSnapshot,
    renderLifecycle,
    surfaceElement: surfaceRef.current
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (interactionBlocked) {
        return;
      }
      const contentInteractionPath = runtime.getSnapshot().contentInteractionProjectRelativePath;
      const contentInteractionNode = contentInteractionPath
        ? projectedNodes.find((node) => node.projectRelativePath === contentInteractionPath)
        : undefined;
      const contentActiveVideoPath = contentInteractionNode?.mediaKind === 'video'
        ? contentInteractionNode.projectRelativePath
        : undefined;
      const activeElement = document.activeElement;
      const focusedCanvasNodePath = activeElement
        ?.closest('[data-canvas-node-path]')
        ?.getAttribute('data-canvas-node-path');
      if (!contentActiveVideoPath || focusedCanvasNodePath !== contentActiveVideoPath) {
        return;
      }
      videoHotkeyController.handleKeyDown({
        key: event.key,
        shiftKey: event.shiftKey,
        preventDefault: () => event.preventDefault(),
        contentActiveVideoPath,
        activeElement
      });
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [interactionBlocked, projectedNodes, runtime, videoHotkeyController]);

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

  useLayoutEffect(() => {
    previewResourceScheduler.setInteractionState(
      canvasPreviewResourceInteractionState(runtime.getSnapshot())
    );
  }, [previewResourceScheduler, runtime]);

  const syncResourceZoomForSnapshot = useCallback((input: {
    cameraState: CanvasRuntimeSnapshot['cameraState'];
    cameraZoom: number;
  }) => {
    const nextResourceZoom = nextCanvasResourceZoom(resourceZoomRef.current, input);
    if (nextResourceZoom === resourceZoomRef.current) {
      return;
    }
    resourceZoomRef.current = nextResourceZoom;
    setResourceZoom(nextResourceZoom);
  }, []);

  useLayoutEffect(() => {
    runtime.acceptProjection(projection);
  }, [projection, runtime]);

  useEffect(() => () => {
    stageRuntime.dispose();
    interactionRuntime.dispose();
  }, [interactionRuntime, stageRuntime]);

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
        runtime.input.cancelPointerInteraction(pointerInteraction.pointerId);
      }
      return unbindStage;
    }
    const unbindSurface = runtime.bindSurface({ surface });
    return () => {
      unbindStage();
      unbindSurface();
    };
  }, [interactionBlocked, stageRuntime, runtime]);

  useEffect(() => {
    if (
      fittedCanvasRef.current
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
      fittedCanvasRef.current = true;
      runtime.camera.setCamera(camera);
    }
  }, [projectedNodes, runtime, surfaceSize]);

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
      renderSnapshot: runtime.scene.getRenderSnapshot(),
      cullingCounts: renderLifecycle.getCullingCounts(),
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
    interactionRuntime.setPointerInteractionActive(initialSnapshot.pointerInteraction?.phase === 'active');
    syncCanvasPerfPointerInteractionSessionState({
      perfMonitor,
      sessionRef: canvasPerfPointerInteractionSessionRef,
      reactCommitCountRef,
      pointerInteraction: initialSnapshot.pointerInteraction,
      snapshot: initialSnapshot,
      finalState: canvasPerfFinalState({
          snapshot: initialSnapshot,
          renderSnapshot: runtime.scene.getRenderSnapshot(),
          cullingCounts: renderLifecycle.getCullingCounts()
      })
    });
    if (initialSnapshot.pointerInteraction) {
      recordCanvasPerfFrame({
        perfMonitor,
        sessionRef: canvasPerfPointerInteractionSessionRef,
        cameraState: initialSnapshot.cameraState,
        renderSnapshot: runtime.scene.getRenderSnapshot(),
        cullingCounts: renderLifecycle.getCullingCounts(),
        reactCommitCountRef
      });
    }
    return runtime.subscribePointerInteraction((nextPointerInteraction) => {
      interactionRuntime.setPointerInteractionActive(nextPointerInteraction?.phase === 'active');
      const snapshot = runtime.getSnapshot();
      previewResourceScheduler.setInteractionState(canvasPreviewResourceInteractionState({
        cameraState: snapshot.cameraState,
        pointerInteraction: nextPointerInteraction
      }));
      syncCanvasPerfPointerInteractionSessionState({
        perfMonitor,
        sessionRef: canvasPerfPointerInteractionSessionRef,
        reactCommitCountRef,
        pointerInteraction: nextPointerInteraction,
        snapshot,
        finalState: canvasPerfFinalState({
          snapshot,
          renderSnapshot: runtime.scene.getRenderSnapshot(),
          cullingCounts: renderLifecycle.getCullingCounts()
        })
      });
      if (nextPointerInteraction) {
        recordCanvasPerfFrame({
          perfMonitor,
          sessionRef: canvasPerfPointerInteractionSessionRef,
          cameraState: snapshot.cameraState,
          renderSnapshot: runtime.scene.getRenderSnapshot(),
          cullingCounts: renderLifecycle.getCullingCounts(),
          reactCommitCountRef
        });
      }
    });
  }, [
    perfMonitor,
    previewResourceScheduler,
    renderLifecycle,
    interactionRuntime,
    runtime
  ]);

  useEffect(() => {
    const nextResourceZoom = initialCanvasResourceZoom(runtime.getSnapshot().camera.z);
    resourceZoomRef.current = nextResourceZoom;
    setResourceZoom(nextResourceZoom);
  }, [runtime]);

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

  const resolvePointerTarget = useCallback((event: Pick<React.PointerEvent<Element>, 'target'>): CanvasDomInteractionTarget => {
    const surface = surfaceRef.current;
    return surface
      ? resolveCanvasDomInteractionTarget(surface, event.target)
      : { kind: 'outside' };
  }, []);

  const resolvePointerReleaseTarget = useCallback((event: React.PointerEvent<Element>): CanvasDomInteractionTarget => {
    const surface = surfaceRef.current;
    if (!surface) {
      return { kind: 'outside' };
    }
    const pointTarget = document.elementFromPoint(event.clientX, event.clientY);
    return resolveCanvasDomInteractionTarget(
      surface,
      pointTarget && surface.contains(pointTarget) ? pointTarget : event.target
    );
  }, []);

  const handleSurfacePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const target = resolvePointerTarget(event);
    interactionRuntime.updatePointer({
      screenPoint: pointerScreenPoint(event),
      target
    });
    if (!isCanvasPrimaryPointerEvent(event, productPlatform) || interactionBlocked) {
      return;
    }
    if (target.kind === 'blank') {
      beginSelectionMarquee(event);
      return;
    }
    if (target.kind !== 'node') {
      return;
    }
    if (target.zone === 'move') {
      const node = projectedNodesRef.current.find((candidate) => (
        candidate.projectRelativePath === target.projectRelativePath
      ));
      if (node) {
        beginNodeMove(node, event);
      }
      return;
    }
    if (
      target.zone === 'activate'
      && (target.mediaKind === 'text' || target.mediaKind === 'video' || target.mediaKind === 'audio')
    ) {
      event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      previewActivationCandidateRef.current = {
        pointerId: event.pointerId,
        projectRelativePath: target.projectRelativePath,
        mediaKind: target.mediaKind
      };
    }
  }, [
    beginNodeMove,
    beginSelectionMarquee,
    interactionBlocked,
    interactionRuntime,
    pointerScreenPoint,
    productPlatform,
    resolvePointerTarget
  ]);

  const handlePointerMove = useCallback((event: React.PointerEvent<Element>) => {
    runtime.input.updatePointerInteraction({
      pointerId: event.pointerId,
      screenPoint: pointerScreenPoint(event),
      modifiers: pointerEventModifiers(event, productPlatform)
    });
    const pointerInteraction = runtime.getSnapshot().pointerInteraction;
    interactionRuntime.updatePointer({
      screenPoint: pointerScreenPoint(event),
      ...(pointerInteraction?.pointerId === event.pointerId && pointerInteraction.phase === 'pending'
        ? {}
        : { target: resolvePointerTarget(event) })
    });
  }, [interactionRuntime, pointerScreenPoint, productPlatform, resolvePointerTarget, runtime]);

  const handlePointerOver = useCallback((event: React.PointerEvent<Element>) => {
    interactionRuntime.updatePointer({
      screenPoint: pointerScreenPoint(event),
      target: resolvePointerTarget(event)
    });
  }, [interactionRuntime, pointerScreenPoint, resolvePointerTarget]);

  const handlePointerUp = useCallback(async (event: React.PointerEvent<Element>) => {
    const currentActivationCandidate = previewActivationCandidateRef.current;
    const activationCandidate = currentActivationCandidate?.pointerId === event.pointerId
      ? currentActivationCandidate
      : undefined;
    if (activationCandidate) {
      previewActivationCandidateRef.current = undefined;
    }
    const pointerInteraction = runtime.getSnapshot().pointerInteraction;
    const interactionWasActive = pointerInteraction?.phase === 'active';
    const pendingReleaseTarget = interactionWasActive
      ? undefined
      : resolvePointerReleaseTarget(event);
    const finishedInteraction = await runtime.input.finishPointerInteraction({
      pointerId: event.pointerId,
      screenPoint: pointerScreenPoint(event),
      modifiers: pointerEventModifiers(event, productPlatform)
    });
    const releaseTarget = finishedInteraction?.phase === 'active'
      ? undefined
      : pendingReleaseTarget;
    const directoryTogglePath = finishedInteraction?.kind === 'move-node'
      && finishedInteraction.phase === 'pending'
      && !event.altKey
      && !event.ctrlKey
      && !event.metaKey
      && !event.shiftKey
      && releaseTarget?.kind === 'node'
      && releaseTarget.projectRelativePath.length > 0
      && releaseTarget.projectRelativePath === finishedInteraction.pressedProjectRelativePath
      && projectedNodesRef.current.some((node) => (
        node.projectRelativePath === releaseTarget.projectRelativePath
        && node.nodeKind === 'directory'
      ))
      ? finishedInteraction.pressedProjectRelativePath
      : undefined;
    if (directoryTogglePath !== undefined) {
      void actions.setCanvasDirectoryExpanded({
        projectRelativePath: directoryTogglePath,
        expanded: !canvasState.expandedDirectories.includes(directoryTogglePath)
      });
    }
    if (
      activationCandidate?.pointerId === event.pointerId
      && releaseTarget?.kind === 'node'
      && releaseTarget.zone === 'activate'
      && releaseTarget.projectRelativePath === activationCandidate.projectRelativePath
      && releaseTarget.mediaKind === activationCandidate.mediaKind
    ) {
      nextPreviewActivationRequestIdRef.current += 1;
      runtime.setSelection(canvasNodeSelection([activationCandidate.projectRelativePath]));
      runtime.setContentInteraction(activationCandidate.projectRelativePath);
      if (activationCandidate.mediaKind !== 'audio') {
        setPreviewActivationRequest({
          requestId: nextPreviewActivationRequestIdRef.current,
          projectRelativePath: activationCandidate.projectRelativePath,
          mediaKind: activationCandidate.mediaKind,
          clientX: event.clientX,
          clientY: event.clientY
        });
      }
    }
    if (releaseTarget) {
      interactionRuntime.updatePointer({
        screenPoint: pointerScreenPoint(event),
        target: releaseTarget
      });
    }
    const surface = surfaceRef.current;
    if (surface) {
      try {
        surface.releasePointerCapture(event.pointerId);
      } catch {
        // Pointer capture may already have ended in the browser.
      }
    }
  }, [actions, canvasState.expandedDirectories, interactionRuntime, pointerScreenPoint, productPlatform, resolvePointerReleaseTarget, runtime]);

  const handlePointerUpEvent = useCallback((event: React.PointerEvent<Element>) => {
    void handlePointerUp(event).catch(() => undefined);
  }, [handlePointerUp]);

  const cancelPointerEvent = useCallback((event: React.PointerEvent<Element>) => {
    if (previewActivationCandidateRef.current?.pointerId === event.pointerId) {
      previewActivationCandidateRef.current = undefined;
    }
    runtime.input.cancelPointerInteraction(event.pointerId);
  }, [runtime]);

  const handlePointerLeave = useCallback(() => {
    interactionRuntime.leaveSurface();
  }, [interactionRuntime]);

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

  const handleSurfaceContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = resolveCanvasDomInteractionTarget(event.currentTarget, event.target);
    if (target.kind === 'blank') {
      event.preventDefault();
      runtime.setSelection(undefined);
      return;
    }
    if (
      target.kind !== 'node'
      || target.zone === 'action'
      || target.zone === 'interaction-island'
      || target.zone === 'feedback'
    ) {
      return;
    }
    const node = projectedNodesRef.current.find((candidate) => (
      candidate.projectRelativePath === target.projectRelativePath
    ));
    if (node) {
      handleNodeContextMenu(node, event);
    }
  }, [handleNodeContextMenu, runtime]);

  const renderedNodes = useMemo(
    () => [...renderSnapshot.nodesByPath.values()],
    [renderSnapshot]
  );
  const activeContentInteractionNode = useMemo(() => {
    if (!contentInteractionPath) {
      return undefined;
    }
    const selectedNode = projectedNodes.find((node) => node.projectRelativePath === contentInteractionPath);
    return selectedNode
      && (selectedNode.mediaKind === 'text'
        || selectedNode.mediaKind === 'video'
        || selectedNode.mediaKind === 'audio')
      ? selectedNode
      : undefined;
  }, [contentInteractionPath, projectedNodes]);
  const activeInlineTextPath = activeContentInteractionNode?.mediaKind === 'text'
    ? activeContentInteractionNode.projectRelativePath
    : undefined;
  const contentActiveVideoPaths = useMemo(
    () => activeContentInteractionNode?.mediaKind === 'video'
      ? [activeContentInteractionNode.projectRelativePath]
      : [],
    [activeContentInteractionNode]
  );
  useEffect(() => {
    if (!previewActivationRequest) {
      return;
    }
    if (
      contentInteractionPath === previewActivationRequest.projectRelativePath
    ) {
      return;
    }
    setPreviewActivationRequest(undefined);
  }, [contentInteractionPath, previewActivationRequest]);
  const activeVideoPaths = useMemo(() => canvasActiveVideoPaths({
    nodes: projectedNodes,
    contentActiveProjectRelativePaths: contentActiveVideoPaths,
    playingVideoPaths,
    requestedVideoPlayerPath
  }), [
    playingVideoPaths,
    projectedNodes,
    requestedVideoPlayerPath,
    contentActiveVideoPaths
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
  const handleUpdateVideoPlaybackTime = useCallback((projectRelativePath: string, currentTimeMs: number) => {
    const node = projectedNodesRef.current.find((candidate) => (
      candidate.projectRelativePath === projectRelativePath
    ));
    if (node?.mediaKind !== 'video') {
      return;
    }
    const updateKey = projectRelativePath;
    const version = (videoPlaybackUpdateVersionsRef.current.get(updateKey) ?? 0) + 1;
    videoPlaybackUpdateVersionsRef.current.set(updateKey, version);
    void actions.updateCanvasVideoPlaybackState({
      updates: [{ projectRelativePath, currentTimeMs }]
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
        ?.restorePersistedTime(durableNode.videoPlayback?.currentTimeMs ?? 0);
    });
  }, [actions]);
  const handleUpdateTextViewport = useCallback((projectRelativePath: string, viewport: CanvasTextViewportState) => {
    const node = projectedNodesRef.current.find((candidate) => (
      candidate.projectRelativePath === projectRelativePath
    ));
    if (node?.mediaKind !== 'text') {
      return;
    }
    void actions.updateCanvasTextViewportState({
      updates: [{ projectRelativePath, ...viewport }]
    }).catch(() => undefined);
  }, [actions]);

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
    const currentSelection = runtime.getSnapshot().selection;
    if (currentSelection?.kind === 'nodes' && currentSelection.projectRelativePaths.length > 1) {
      onFeedbackBarTargetChange(canvasFeedbackBarTargetForSelection({
        projectRelativePaths: currentSelection.projectRelativePaths,
        nodes: renderedNodes,
        surfaceRect: domRectToFloatingBarRect(surfaceRect),
        camera
      }));
      return;
    }
    const interactionSnapshot = interactionRuntime.getSnapshot();
    if (interactionSnapshot.gated) {
      onFeedbackBarTargetChange(undefined);
      return;
    }
    const hoveredNodePath = interactionSnapshot.hoveredNodePath;
    if (hoveredNodePath === undefined) {
      onFeedbackBarTargetChange(undefined);
      return;
    }
    const node = renderSnapshot.nodesByPath.get(hoveredNodePath);
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
    interactionRuntime,
    onFeedbackBarTargetChange,
    renderSnapshot,
    renderedNodes,
    runtime
  ]);

  useEffect(() => {
    emitFeedbackBarTarget();
  }, [emitFeedbackBarTarget, surfaceSize]);

  useLayoutEffect(() => {
    let pendingFrame: number | undefined;
    const publishSelectionTarget = () => {
      if (pendingFrame !== undefined) {
        return;
      }
      pendingFrame = window.requestAnimationFrame(() => {
        pendingFrame = undefined;
        emitFeedbackBarTarget();
      });
    };
    const unsubscribe = runtime.subscribeSelection(publishSelectionTarget);
    return () => {
      unsubscribe();
      if (pendingFrame !== undefined) {
        window.cancelAnimationFrame(pendingFrame);
      }
    };
  }, [emitFeedbackBarTarget, runtime]);

  useLayoutEffect(() => {
    const applyInteractionSnapshot = (snapshot: ReturnType<typeof interactionRuntime.getSnapshot>) => {
      if (snapshot.pointerInteractionActive) {
        stageRuntime.setHoveredNode(undefined);
        emitFeedbackBarTarget();
        return;
      }
      if (snapshot.cameraMoving) {
        stageRuntime.setHoveredNode(undefined);
        if (!feedbackHoverSuspendedRef.current) {
          feedbackHoverSuspendedRef.current = true;
          feedbackInteraction?.suspendHoverTarget();
        }
        return;
      }
      if (snapshot.reconcilePending) {
        return;
      }
      stageRuntime.setHoveredNode(snapshot.hoveredNodePath);
      feedbackHoverSuspendedRef.current = false;
      emitFeedbackBarTarget();
    };
    applyInteractionSnapshot(interactionRuntime.getSnapshot());
    return interactionRuntime.subscribe(applyInteractionSnapshot);
  }, [emitFeedbackBarTarget, feedbackInteraction, interactionRuntime, stageRuntime]);

  const reconcileCanvasInteraction = useCallback(() => {
    const surface = surfaceRef.current;
    const point = interactionRuntime.takeReconcilePoint();
    if (!surface || !point) {
      return;
    }
    interactionRuntime.reconcile(resolveCanvasDomInteractionTarget(
      surface,
      document.elementFromPoint(point.x, point.y)
    ));
  }, [interactionRuntime]);

  useEffect(() => {
    let reconcileFrame: number | undefined;
    const unsubscribe = runtime.subscribePointerInteraction((nextPointerInteraction) => {
      if (nextPointerInteraction || runtime.getSnapshot().cameraState !== 'idle') {
        return;
      }
      if (reconcileFrame !== undefined) {
        window.cancelAnimationFrame(reconcileFrame);
      }
      reconcileFrame = window.requestAnimationFrame(() => {
        reconcileFrame = undefined;
        reconcileCanvasInteraction();
      });
    });
    return () => {
      unsubscribe();
      if (reconcileFrame !== undefined) {
        window.cancelAnimationFrame(reconcileFrame);
      }
    };
  }, [reconcileCanvasInteraction, runtime]);

  useEffect(() => {
    if (!feedbackInteraction) {
      return;
    }
    const currentTargetPath = feedbackInteraction.getCurrentTargetProjectRelativePath();
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

  useLayoutEffect(() => {
    const writeCursor = (interaction: CanvasRuntimeSnapshot['pointerInteraction']): void => {
      surfaceRef.current?.setAttribute(
        'data-canvas-cursor',
        interaction?.kind === 'move-node' && interaction.phase === 'active'
          ? 'grabbing'
          : 'default'
      );
    };
    writeCursor(runtime.getSnapshot().pointerInteraction);
    return runtime.subscribePointerInteraction(writeCursor);
  }, [runtime]);

  const surface = (
    <div
      ref={surfaceRef}
      className="canvas-surface"
      data-testid="canvas-surface"
      data-canvas-cursor="default"
      tabIndex={0}
      onPointerDown={handleSurfacePointerDown}
      onPointerMove={handlePointerMove}
      onPointerOver={handlePointerOver}
      onPointerLeave={handlePointerLeave}
      onPointerUp={handlePointerUpEvent}
      onPointerCancel={cancelPointerEvent}
      onLostPointerCapture={cancelPointerEvent}
      onContextMenu={handleSurfaceContextMenu}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          runtime.setSelection(undefined);
        }
      }}
    >
      <div
        ref={stageRef}
        className="canvas-world-stage"
      >
        <CanvasSurfaceEdgeLayer
          groups={renderSnapshot.edgeGroups}
          stageRuntime={stageRuntime}
        />
        <CanvasRasterPreviewEnvironmentProvider value={rasterPreviewEnvironment}>
          <CanvasVideoPreviewProvider
            nodes={projectedNodes}
            activeVideoPaths={activeVideoPaths}
            actions={actions}
            previewOrder={renderLifecycle}
            previewResourceScheduler={previewResourceScheduler}
          >
            <CanvasTextPreviewProvider
              nodes={projectedNodes}
              activeInlineTextPath={activeInlineTextPath}
              textFileBuffers={textFileBuffers}
              actions={actions}
              previewOrder={renderLifecycle}
              styleDependencyKey={textPreviewStyleDependencyKey}
              perfMonitor={instrumentationMonitor}
              previewResourceScheduler={previewResourceScheduler}
            >
              {renderedNodes.map((node) => (
                <CanvasSurfaceNodeShell
                  key={node.projectRelativePath}
                  node={node}
                  cut={cutPathSet.has(node.projectRelativePath)}
                  contentInteractionActive={activeContentInteractionNode?.projectRelativePath === node.projectRelativePath}
                  zIndex={node.z}
                  stageRuntime={stageRuntime}
                  actions={actions}
                  textBuffer={textFileBuffers[node.projectRelativePath]}
                  forceVideoPlayerMounted={requestedVideoPlayerPath === node.projectRelativePath}
                  previewActivationRequest={previewActivationRequest?.projectRelativePath === node.projectRelativePath
                    ? previewActivationRequest
                    : undefined}
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
                  onResizePointerDown={beginNodeResize}
                  onVideoPlayerMounted={handleVideoPlayerMounted}
                  onVideoPlayingChange={handleVideoPlayingChange}
                  onRegisterVideoTarget={registerVideoTarget}
                  onUpdateVideoPlaybackTime={handleUpdateVideoPlaybackTime}
                  onUpdateTextViewport={handleUpdateTextViewport}
                />
              ))}
            </CanvasTextPreviewProvider>
          </CanvasVideoPreviewProvider>
        </CanvasRasterPreviewEnvironmentProvider>
      </div>
      <CanvasMovingCameraHitTestBlocker
        runtime={runtime}
        onCameraStateChange={interactionRuntime.setCameraState}
        onCameraIdle={reconcileCanvasInteraction}
      />
      <CanvasSelectionMarqueeOverlay
        runtime={runtime}
        surfaceElement={surfaceRef.current}
      />
    </div>
  );
  return instrumentationMonitor ? (
    <React.Profiler
      id="canvas-surface"
      onRender={() => {
        reactCommitCountRef.current += 1;
      }}
    >
      {surface}
    </React.Profiler>
  ) : surface;
}

function CanvasSurfaceEdgeLayer({
  groups,
  stageRuntime
}: {
  groups: readonly CanvasEdgeRoutingGroup[];
  stageRuntime: CanvasStageRuntime;
}): React.ReactElement {
  return (
    <svg
      className="canvas-edge-layer"
      aria-hidden="true"
    >
      {groups.map((group) => (
        <CanvasSurfaceEdgeGroupPath
          key={group.id}
          group={group}
          stageRuntime={stageRuntime}
        />
      ))}
    </svg>
  );
}

function CanvasSurfaceEdgeGroupPath({
  group,
  stageRuntime
}: {
  group: CanvasEdgeRoutingGroup;
  stageRuntime: CanvasStageRuntime;
}): React.ReactElement {
  const elementRef = useRef<SVGPathElement | null>(null);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) {
      return;
    }
    return stageRuntime.registerEdgeGroup(group.id, element);
  }, [group.id, stageRuntime]);

  useLayoutEffect(() => {
    stageRuntime.setEdgeGroupGeometry(group.id, group.path);
  }, [group.id, group.path, stageRuntime]);

  return (
    <path
      ref={elementRef}
      data-canvas-edge-source={group.sourceProjectRelativePath}
      data-canvas-edge-ids={group.edgeIds.join(' ')}
      className="canvas-edge"
      d={group.path}
    />
  );
}

interface CanvasSurfaceNodeShellProps {
  node: ProjectedCanvasNode;
  cut: boolean;
  contentInteractionActive: boolean;
  zIndex: number;
  stageRuntime: CanvasStageRuntime;
  actions: CanvasSceneActions;
  textBuffer: TextFileBuffer | undefined;
  forceVideoPlayerMounted: boolean;
  previewActivationRequest?: CanvasPreviewActivationRequest | undefined;
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
  onResizePointerDown: (node: ProjectedCanvasNode, handle: ResizeHandle, event: React.PointerEvent<HTMLButtonElement>) => void;
  onVideoPlayerMounted: (projectRelativePath: string) => void;
  onVideoPlayingChange: (projectRelativePath: string, playing: boolean) => void;
  onRegisterVideoTarget: (projectRelativePath: string, target: CanvasVideoPlayerHandle | undefined) => void;
  onUpdateVideoPlaybackTime: (projectRelativePath: string, currentTimeMs: number) => void | Promise<void>;
  onUpdateTextViewport: (projectRelativePath: string, viewport: CanvasTextViewportState) => void | Promise<void>;
}

function CanvasSurfaceNodeShell(props: CanvasSurfaceNodeShellProps): React.ReactElement {
  const subscribe = useCallback((listener: () => void) => (
    props.stageRuntime.subscribeSingleSelectedNode(props.node.projectRelativePath, listener)
  ), [props.node.projectRelativePath, props.stageRuntime]);
  const getSnapshot = useCallback(() => (
    props.stageRuntime.isSingleSelectedNode(props.node.projectRelativePath)
  ), [props.node.projectRelativePath, props.stageRuntime]);
  const showResizeHandles = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const resolvedProps = { ...props, showResizeHandles };
  if (props.node.mediaKind === 'text') {
    return <CanvasTextSurfaceNodeShell {...resolvedProps} />;
  }
  if (props.node.mediaKind === 'video') {
    return <CanvasVideoSurfaceNodeShell {...resolvedProps} />;
  }
  return <CanvasSurfaceNodeShellBase {...resolvedProps} />;
}

type ResolvedCanvasSurfaceNodeShellProps = CanvasSurfaceNodeShellProps & {
  showResizeHandles: boolean;
};

function CanvasTextSurfaceNodeShell(props: ResolvedCanvasSurfaceNodeShellProps): React.ReactElement {
  const { request, previewError } = useCanvasTextPreviewNode(props.node);
  return (
    <CanvasSurfaceNodeShellBase
      {...props}
      textPreviewRequest={request}
      textPreviewError={previewError}
    />
  );
}

function CanvasVideoSurfaceNodeShell(props: ResolvedCanvasSurfaceNodeShellProps): React.ReactElement {
  const { request, previewError } = useCanvasVideoPreviewNode(props.node);
  return (
    <CanvasSurfaceNodeShellBase
      {...props}
      videoPreviewRequest={request}
      videoPreviewError={previewError}
    />
  );
}

function CanvasSurfaceNodeShellBase({
  node,
  cut,
  showResizeHandles,
  contentInteractionActive,
  zIndex,
  stageRuntime,
  actions,
  textBuffer,
  forceVideoPlayerMounted,
  previewActivationRequest,
  feedbackEntry,
  activeFeedbackItemId,
  localFeedbackMode,
  localFeedbackRegions,
  activeFeedbackMomentTimeSeconds,
  onLocalFeedbackDraft,
  onFeedbackItemActivate,
  onResizePointerDown,
  onVideoPlayerMounted,
  onVideoPlayingChange,
  onRegisterVideoTarget,
  onUpdateVideoPlaybackTime,
  onUpdateTextViewport,
  textPreviewRequest,
  textPreviewError,
  videoPreviewRequest,
  videoPreviewError,
}: ResolvedCanvasSurfaceNodeShellProps & {
  textPreviewRequest?: CanvasTextPreviewNodeSnapshot['request'] | undefined;
  textPreviewError?: string | undefined;
  videoPreviewRequest?: CanvasVideoPreviewNodeSnapshot['request'] | undefined;
  videoPreviewError?: string | undefined;
}): React.ReactElement {
  return (
    <CanvasNodeShell
      node={node}
      cut={cut}
      showResizeHandles={showResizeHandles}
      contentInteractionActive={contentInteractionActive}
      zIndex={zIndex}
      stageRuntime={stageRuntime}
      actions={actions}
      textBuffer={textBuffer}
      textPreviewRequest={textPreviewRequest}
      textPreviewError={textPreviewError}
      videoPreviewRequest={videoPreviewRequest}
      videoPreviewError={videoPreviewError}
      forceVideoPlayerMounted={forceVideoPlayerMounted}
      previewActivationRequest={previewActivationRequest}
      feedbackEntry={feedbackEntry}
      activeFeedbackItemId={activeFeedbackItemId}
      localFeedbackMode={localFeedbackMode}
      localFeedbackRegions={localFeedbackRegions}
      activeFeedbackMomentTimeSeconds={activeFeedbackMomentTimeSeconds}
      onLocalFeedbackDraft={onLocalFeedbackDraft}
      onFeedbackItemActivate={onFeedbackItemActivate}
      onResizePointerDown={onResizePointerDown}
      onVideoPlayerMounted={onVideoPlayerMounted}
      onVideoPlayingChange={onVideoPlayingChange}
      onRegisterVideoTarget={onRegisterVideoTarget}
      onUpdateVideoPlaybackTime={onUpdateVideoPlaybackTime}
      onUpdateTextViewport={onUpdateTextViewport}
    />
  );
}

function CanvasSelectionMarqueeOverlay({
  runtime,
  surfaceElement
}: {
  runtime: CanvasEditorRuntime;
  surfaceElement: HTMLElement | null;
}): React.ReactElement | null {
  const interaction = useCanvasPointerInteraction(runtime);
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

function canvasTopEdgeInset(surface: HTMLElement): number {
  const titleBar = document.querySelector<HTMLElement>('[data-testid="workbench-titlebar"]');
  if (!titleBar) {
    return 0;
  }
  const surfaceRect = surface.getBoundingClientRect();
  return Math.max(0, titleBar.getBoundingClientRect().bottom - surfaceRect.top);
}
