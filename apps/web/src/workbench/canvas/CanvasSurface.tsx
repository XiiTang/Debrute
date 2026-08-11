import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CanvasFeedbackVideoResource, DebruteProductPlatform } from '@debrute/app-protocol';
import type {
  CanvasFeedbackDocument,
  CanvasFeedbackEntry,
  CanvasFeedbackGeometry,
  CanvasTextViewportState
} from '@debrute/app-protocol';
import type { CanvasProjection, ProjectedCanvasNode } from './CanvasScene';
import type { TextFileBuffer } from '../../types';
import type { WorkbenchContextMenuPosition, WorkbenchContextMenuTarget } from '../shell/contextMenu';
import {
  isAdditiveCanvasSelectionModifier,
  type CanvasPoint,
  type ResizeHandle
} from '../services/canvasInteraction';
import { projectPathCommandEntryForCanvasNode } from '../services/projectPathCommandTarget';
import {
  type CanvasFeedbackNodeBarTarget
} from '../shell/floatingBars';
import { cameraForCanvasContent } from './CanvasCameraBounds';
import {
  CanvasRasterPreviewEnvironmentProvider,
  type CanvasRasterPreviewEnvironment
} from './CanvasRasterPreviewPresentation';
import type { CanvasVideoPlayerHandle } from './CanvasVideoPlayerAdapter';
import type { CanvasMediaFeedbackDraftRegion, CanvasMediaFeedbackMode } from './CanvasMediaFeedbackLayer';
import {
  resolveCanvasDomInteractionTarget,
  type CanvasDomInteractionTarget,
  type CanvasContentHandoffRequest
} from './CanvasDomInteractionAdapter';
import {
  CANVAS_POINTER_ACTIVATION_DISTANCE,
  decideCanvasInteraction,
  type CanvasInteractionStateCommand
} from './CanvasInteractionPolicy';
import { CanvasMovingCameraHitTestBlocker } from './CanvasMovingCameraHitTestBlocker';
import { CanvasNodeShell } from './CanvasNodeShell';
import { createCanvasPreviewResourceScheduler } from './CanvasPreviewResourceScheduler';
import {
  createCanvasResourceZoomSettlement,
  type CanvasResourceZoomSettlement
} from './CanvasResourceZoom';
import {
  CanvasTextPreviewProvider,
  useCanvasTextPreviewNode,
  type CanvasTextPreviewNodeSnapshot
} from './CanvasTextPreviewRuntime';
import {
  CanvasVideoPreviewProvider,
  useCanvasVideoPreviewNode,
  type CanvasVideoMetadataUpdate,
  type CanvasVideoPreviewNodeSnapshot
} from './CanvasVideoPreviewRuntime';
import type { CanvasFeedbackCanvasBinding } from './CanvasFeedbackInteraction';
import type { CanvasSceneActions } from './CanvasSceneActions';
import {
  createCanvasSourceResolutionRuntime,
  type CanvasSourceResolutionRuntime
} from './CanvasSourceResolutionRuntime';
import { createCanvasPerfBrowserAdapter } from './CanvasPerfBrowserAdapter';
import { createCanvasPerfDebugBridge } from './CanvasPerfDebugBridge';
import {
  CANVAS_PERF_INTERACTION_SESSION_TYPES,
  createCanvasPerfMonitor,
  type CanvasPerfMonitor
} from './CanvasPerfMonitor';
import { createCanvasRenderLifecycle } from './CanvasRenderLifecycle';
import type { CanvasEdgeRoutingGroup } from './CanvasEdgeRoutingGroup';
import type {
  CanvasEditorRuntime,
  CanvasRuntimePointerInteraction,
  CanvasRuntimeSnapshot
} from './runtime/CanvasEditorRuntime';
import { createCanvasInteractionRuntime } from './runtime/CanvasInteractionRuntime';
import { createCanvasStageRuntime, type CanvasStageRuntime } from './runtime/CanvasStageRuntime';
import {
  canvasNodeSelection,
  isCanvasNodeSelected,
  selectedNodeProjectRelativePaths
} from './runtime/canvasSelection';
import {
  useCanvasContentInteraction,
  useCanvasSurfaceSize
} from './runtime/useCanvasRuntimeSnapshot';
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
  syncCanvasPerfPointerInteractionSessionState,
  syncCanvasPerfSessionState,
  canvasPreviewResourceInteractionState,
  type CanvasPerfDebugSnapshotContext,
  type CanvasPerfRuntimeSession
} from './canvasSurfaceSupport';

const EMPTY_FEEDBACK_ITEM_IDS: ReadonlySet<string> = new Set();

interface CanvasCompletedClickCandidate {
  pointerId: number;
  startScreen: CanvasPoint;
  target: Extract<CanvasDomInteractionTarget, { kind: 'node' }>;
}

interface CanvasSurfaceProps {
  expandedDirectories: readonly string[];
  projection: CanvasProjection;
  feedbackVideoResources?: readonly CanvasFeedbackVideoResource[] | undefined;
  runtime: CanvasEditorRuntime;
  actions: CanvasSceneActions;
  textFileBuffers: Record<string, TextFileBuffer>;
  canvasFeedback: CanvasFeedbackDocument | undefined;
  onVideoMetadata?: ((update: CanvasVideoMetadataUpdate) => void) | undefined;
  feedbackInteraction?: CanvasFeedbackCanvasBinding | undefined;
  minimapOpen?: boolean | undefined;
  productPlatform: DebruteProductPlatform;
  cutPaths?: readonly string[] | undefined;
  onOpenContextMenu?: ((target: WorkbenchContextMenuTarget, position: WorkbenchContextMenuPosition) => void) | undefined;
  interactionBlocked?: boolean | undefined;
  textPreviewStyleDependencyKey: string;
}

export function CanvasSurface({
  expandedDirectories,
  projection,
  feedbackVideoResources,
  runtime,
  actions,
  textFileBuffers,
  canvasFeedback,
  onVideoMetadata,
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
        },
        onFrameInterval: (frameInterval) => {
          perfMonitorRef.current?.recordFrameInterval(frameInterval);
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
      expandedDirectories={expandedDirectories}
      projection={projection}
      feedbackVideoResources={feedbackVideoResources}
      runtime={runtime}
      actions={actions}
      textFileBuffers={textFileBuffers}
      canvasFeedback={canvasFeedback}
      onVideoMetadata={onVideoMetadata}
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
  expandedDirectories,
  projection,
  feedbackVideoResources,
  runtime,
  actions,
  textFileBuffers,
  canvasFeedback,
  onVideoMetadata,
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
  const dismissFeedbackBarTarget = feedbackInteraction?.dismissTarget;
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const cutPathSet = useMemo(() => new Set(cutPaths), [cutPaths]);
  const contentInteractionPath = useCanvasContentInteraction(runtime);
  const surfaceSize = useCanvasSurfaceSize(runtime);
  const resourceZoomSettlement = useMemo<CanvasResourceZoomSettlement>(() => (
    createCanvasResourceZoomSettlement({
      initialZoom: runtime.getSnapshot().camera.z,
      getCameraSnapshot: runtime.getSnapshot
    })
  ), [runtime]);
  useLayoutEffect(
    () => resourceZoomSettlement.attach(),
    [resourceZoomSettlement]
  );
  const fittedCanvasRef = useRef(false);
  const canvasPerfSessionRef = useRef<CanvasPerfRuntimeSession | undefined>(undefined);
  const canvasPerfPointerInteractionSessionRef = useRef<CanvasPerfRuntimeSession | undefined>(undefined);
  const feedbackHoverSuspendedRef = useRef(false);
  const completedClickCandidateRef = useRef<CanvasCompletedClickCandidate | undefined>(undefined);
  const nextContentHandoffRequestIdRef = useRef(0);
  const [contentHandoffRequest, setContentHandoffRequest] = useState<CanvasContentHandoffRequest>();
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
  const videoTargetsRef = useRef(new Map<string, CanvasVideoPlayerHandle>());
  const pendingFeedbackSeekRef = useRef(new Map<string, number>());
  const videoPlaybackUpdateVersionsRef = useRef(new Map<string, number>());
  const registerVideoTarget = useCallback((projectRelativePath: string, target: CanvasVideoPlayerHandle | undefined) => {
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
  }, []);
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
  const sourceResolutionRuntime = useMemo(() => createCanvasSourceResolutionRuntime({
    runtime,
    resolveCanvasSources: actions.resolveCanvasSources,
    distanceSquaredForNode: renderLifecycle.previewDistanceSquaredForNode
  }), [actions.resolveCanvasSources, renderLifecycle, runtime]);
  useLayoutEffect(() => sourceResolutionRuntime.attach(), [sourceResolutionRuntime]);
  useLayoutEffect(() => {
    sourceResolutionRuntime.acceptProjection(projection, feedbackVideoResources);
  }, [feedbackVideoResources, projection, sourceResolutionRuntime]);
  const currentProjectedNode = useCallback((projectRelativePath: string) => {
    const accepted = runtime.scene.getAcceptedNode(projectRelativePath);
    return accepted
      ? sourceResolutionRuntime.getNodeSnapshot(accepted)
      : sourceResolutionRuntime.getNode(projectRelativePath)
        ?? projectedNodesRef.current.find((node) => node.projectRelativePath === projectRelativePath);
  }, [runtime, sourceResolutionRuntime]);
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
    resourceZoomSource: resourceZoomSettlement,
    devicePixelRatio,
    previewResourceScheduler,
    perfMonitor: instrumentationMonitor
  }), [devicePixelRatio, instrumentationMonitor, previewResourceScheduler, resourceZoomSettlement]);

  canvasPerfDebugContextRef.current = {
    runtime,
    getResourceZoom: resourceZoomSettlement.getSnapshot,
    renderSnapshot,
    renderLifecycle,
    surfaceElement: surfaceRef.current
  };

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
    resourceZoomSettlement.observeCamera(liveCamera.z);
  }), [
    runtime,
    previewResourceScheduler,
    resourceZoomSettlement
  ]);

  useEffect(() => {
    return runtime.subscribeCameraState((cameraState) => {
      const snapshot = runtime.getSnapshot();
      previewResourceScheduler.setInteractionState(canvasPreviewResourceInteractionState({
        cameraState,
        pointerInteraction: snapshot.pointerInteraction
      }));
      syncCanvasPerfSessionState({
        perfMonitor,
        sessionRef: canvasPerfSessionRef,
        snapshot: {
          cameraState,
          camera: snapshot.camera
        },
        minimapOpen: minimapOpen === true,
        getFinalState: () => canvasPerfFinalState({
          snapshot,
          renderSnapshot: runtime.scene.getRenderSnapshot(),
          cullingCounts: renderLifecycle.getCullingCounts()
        })
      });
    });
  }, [
    minimapOpen,
    perfMonitor,
    previewResourceScheduler,
    renderLifecycle,
    runtime
  ]);

  useEffect(() => {
    const initialSnapshot = runtime.getSnapshot();
    if (
      (initialSnapshot.pointerInteraction?.kind === 'move-node'
        || initialSnapshot.pointerInteraction?.kind === 'resize-node')
      && initialSnapshot.pointerInteraction.phase === 'active'
    ) {
      dismissFeedbackBarTarget?.();
    }
    interactionRuntime.setPointerInteractionActive(initialSnapshot.pointerInteraction?.phase === 'active');
    syncCanvasPerfPointerInteractionSessionState({
      perfMonitor,
      sessionRef: canvasPerfPointerInteractionSessionRef,
      pointerInteraction: initialSnapshot.pointerInteraction,
      snapshot: initialSnapshot,
      getFinalState: () => canvasPerfFinalState({
          snapshot: initialSnapshot,
          renderSnapshot: runtime.scene.getRenderSnapshot(),
          cullingCounts: renderLifecycle.getCullingCounts()
      })
    });
    return runtime.subscribePointerInteraction((nextPointerInteraction) => {
      const pointerInteractionWasActive = interactionRuntime.getSnapshot().pointerInteractionActive;
      if (
        !pointerInteractionWasActive
        && (nextPointerInteraction?.kind === 'move-node'
          || nextPointerInteraction?.kind === 'resize-node')
        && nextPointerInteraction.phase === 'active'
      ) {
        dismissFeedbackBarTarget?.();
      }
      interactionRuntime.setPointerInteractionActive(nextPointerInteraction?.phase === 'active');
      const snapshot = runtime.getSnapshot();
      previewResourceScheduler.setInteractionState(canvasPreviewResourceInteractionState({
        cameraState: snapshot.cameraState,
        pointerInteraction: nextPointerInteraction
      }));
      syncCanvasPerfPointerInteractionSessionState({
        perfMonitor,
        sessionRef: canvasPerfPointerInteractionSessionRef,
        pointerInteraction: nextPointerInteraction,
        snapshot,
        getFinalState: () => canvasPerfFinalState({
          snapshot,
          renderSnapshot: runtime.scene.getRenderSnapshot(),
          cullingCounts: renderLifecycle.getCullingCounts()
        })
      });
    });
  }, [
    perfMonitor,
    previewResourceScheduler,
    renderLifecycle,
    dismissFeedbackBarTarget,
    interactionRuntime,
    runtime
  ]);

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

  const applyInteractionState = useCallback((command: CanvasInteractionStateCommand) => {
    switch (command.kind) {
      case 'preserve':
        return;
      case 'end-content-activation':
        runtime.endContentActivation();
        return;
      case 'set-selection-and-end-content-activation':
        runtime.setSelectionAndEndContentActivation(command.selection);
        return;
      case 'activate-content':
        runtime.activateContent(command.projectRelativePath);
        return;
    }
  }, [runtime]);

  const handleSurfaceClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (
      event.button !== 0
      || !isAdditiveCanvasSelectionModifier(pointerEventModifiers(event, productPlatform))
    ) {
      return;
    }
    const target = resolveCanvasDomInteractionTarget(event.currentTarget, event.target);
    if (
      target.kind !== 'node'
      || target.zone !== 'content'
      || runtime.getSnapshot().contentInteractionProjectRelativePath === target.projectRelativePath
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }, [productPlatform, runtime]);

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
    if (target.zone === 'manipulation') {
      const node = runtime.scene.getAcceptedNode(target.projectRelativePath);
      if (node) {
        beginNodeMove(node, event);
      }
      return;
    }
    if (target.zone === 'content' && target.directManipulation) {
      const decision = decideCanvasInteraction({
        event: 'content-direct-manipulation-start',
        target,
        selection: runtime.getSnapshot().selection,
        contentActivationProjectRelativePath: runtime.getSnapshot().contentInteractionProjectRelativePath,
        additive: false
      });
      applyInteractionState(decision.state);
      return;
    }
    if (
      target.zone === 'content'
      && runtime.getSnapshot().contentInteractionProjectRelativePath === target.projectRelativePath
    ) {
      return;
    }
    if (target.zone === 'content' || target.zone === 'content-island' || target.zone === 'action') {
      completedClickCandidateRef.current = {
        pointerId: event.pointerId,
        startScreen: pointerScreenPoint(event),
        target
      };
      if (target.zone === 'content' && !target.contentControl) {
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
      }
    }
  }, [
    applyInteractionState,
    beginNodeMove,
    beginSelectionMarquee,
    interactionBlocked,
    interactionRuntime,
    pointerScreenPoint,
    productPlatform,
    resolvePointerTarget,
    runtime
  ]);

  const handlePointerMove = useCallback((event: React.PointerEvent<Element>) => {
    const clickCandidate = completedClickCandidateRef.current;
    if (
      clickCandidate?.pointerId === event.pointerId
      && clickCandidate.target.zone === 'content'
      && !clickCandidate.target.contentControl
      && Math.hypot(
        event.clientX - clickCandidate.startScreen.x,
        event.clientY - clickCandidate.startScreen.y
      ) > CANVAS_POINTER_ACTIVATION_DISTANCE
    ) {
      completedClickCandidateRef.current = undefined;
    }
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
    const currentClickCandidate = completedClickCandidateRef.current;
    const clickCandidate = currentClickCandidate?.pointerId === event.pointerId
      ? currentClickCandidate
      : undefined;
    if (clickCandidate) {
      completedClickCandidateRef.current = undefined;
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
      && runtime.scene.getAcceptedNode(releaseTarget.projectRelativePath)?.nodeKind === 'directory'
      ? finishedInteraction.pressedProjectRelativePath
      : undefined;
    if (directoryTogglePath !== undefined) {
      void actions.setCanvasDirectoryExpanded({
        projectRelativePath: directoryTogglePath,
        expanded: !expandedDirectories.includes(directoryTogglePath)
      });
    }
    if (clickCandidate
      && releaseTarget?.kind === 'node'
      && releaseTarget.projectRelativePath === clickCandidate.target.projectRelativePath
      && releaseTarget.zone === clickCandidate.target.zone) {
      const snapshot = runtime.getSnapshot();
      const decision = decideCanvasInteraction({
        event: 'completed-click',
        target: releaseTarget,
        selection: snapshot.selection,
        contentActivationProjectRelativePath: snapshot.contentInteractionProjectRelativePath,
        additive: Boolean(event.shiftKey || event.metaKey || event.ctrlKey)
      });
      applyInteractionState(decision.state);
      if (decision.handoff !== 'none') {
        nextContentHandoffRequestIdRef.current += 1;
        setContentHandoffRequest(decision.handoff === 'text-caret' ? {
          kind: 'text-caret',
          requestId: nextContentHandoffRequestIdRef.current,
          projectRelativePath: releaseTarget.projectRelativePath,
          clientX: event.clientX,
          clientY: event.clientY
        } : {
          kind: 'video-toggle',
          requestId: nextContentHandoffRequestIdRef.current,
          projectRelativePath: releaseTarget.projectRelativePath
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
  }, [actions, applyInteractionState, expandedDirectories, interactionRuntime, pointerScreenPoint, productPlatform, resolvePointerReleaseTarget, runtime]);

  const handlePointerUpEvent = useCallback((event: React.PointerEvent<Element>) => {
    void handlePointerUp(event).catch(() => undefined);
  }, [handlePointerUp]);

  const cancelPointerEvent = useCallback((event: React.PointerEvent<Element>) => {
    if (completedClickCandidateRef.current?.pointerId === event.pointerId) {
      completedClickCandidateRef.current = undefined;
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
      const selectedNode = currentProjectedNode(path);
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
  }, [currentProjectedNode, onOpenContextMenu, runtime]);

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
      || target.zone === 'content-island'
      || target.zone === 'feedback'
    ) {
      return;
    }
    const node = currentProjectedNode(target.projectRelativePath);
    if (node) {
      handleNodeContextMenu(node, event);
    }
  }, [currentProjectedNode, handleNodeContextMenu, runtime]);

  const renderedNodes = useMemo(
    () => [...renderSnapshot.nodesByPath.values()],
    [renderSnapshot]
  );
  const activeContentInteractionNode = useMemo(() => {
    if (!contentInteractionPath) {
      return undefined;
    }
    const selectedNode = runtime.scene.getAcceptedNode(contentInteractionPath);
    return selectedNode
      && (selectedNode.mediaKind === 'text'
        || selectedNode.mediaKind === 'video'
        || selectedNode.mediaKind === 'audio')
      ? selectedNode
      : undefined;
  }, [contentInteractionPath, runtime]);
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
    if (!contentHandoffRequest) {
      return;
    }
    if (
      contentInteractionPath === contentHandoffRequest.projectRelativePath
    ) {
      return;
    }
    setContentHandoffRequest(undefined);
  }, [contentHandoffRequest, contentInteractionPath]);
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
  const handleContentError = useCallback((projectRelativePath: string) => {
    if (runtime.getSnapshot().contentInteractionProjectRelativePath === projectRelativePath) {
      runtime.endContentActivation();
    }
  }, [runtime]);
  const handleContentHandoffConsumed = useCallback((requestId: number) => {
    setContentHandoffRequest((current) => current?.requestId === requestId ? undefined : current);
  }, []);
  const handleUpdateVideoPlaybackTime = useCallback((projectRelativePath: string, currentTimeMs: number) => {
    const node = runtime.scene.getAcceptedNode(projectRelativePath);
    if (node?.mediaKind !== 'video') {
      return;
    }
    const updateKey = projectRelativePath;
    const version = (videoPlaybackUpdateVersionsRef.current.get(updateKey) ?? 0) + 1;
    videoPlaybackUpdateVersionsRef.current.set(updateKey, version);
    return actions.updateCanvasVideoPlaybackState({
      updates: [{ projectRelativePath, currentTimeMs }]
    }).then(() => {
      if (videoPlaybackUpdateVersionsRef.current.get(updateKey) === version) {
        videoPlaybackUpdateVersionsRef.current.delete(updateKey);
      }
    }, (error) => {
      if (videoPlaybackUpdateVersionsRef.current.get(updateKey) !== version) {
        return;
      }
      videoPlaybackUpdateVersionsRef.current.delete(updateKey);
      const durableNode = runtime.scene.getAcceptedNode(projectRelativePath);
      if (durableNode?.mediaKind !== 'video') {
        return;
      }
      videoTargetsRef.current
        .get(projectRelativePath)
        ?.restorePersistedTime(durableNode.videoPlayback?.currentTimeMs ?? 0);
      throw error;
    });
  }, [actions, runtime]);
  const handleUpdateTextViewport = useCallback((projectRelativePath: string, viewport: CanvasTextViewportState) => {
    const node = runtime.scene.getAcceptedNode(projectRelativePath);
    if (node?.mediaKind !== 'text') {
      return;
    }
    void actions.updateCanvasTextViewportState({
      updates: [{ projectRelativePath, ...viewport }]
    }).catch(() => undefined);
  }, [actions, runtime]);

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
    const node = runtime.scene.getPresentedNodes().get(draft.projectRelativePath);
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
    runtime
  ]);

  const handleFeedbackItemActivate = useCallback((projectRelativePath: string, itemId: string) => {
    if (!feedbackInteraction) {
      return;
    }
    const node = runtime.scene.getPresentedNodes().get(projectRelativePath);
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
  }, [feedbackBarTargetForNode, feedbackInteraction, runtime]);

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
    const interactionSnapshot = interactionRuntime.getSnapshot();
    if (interactionSnapshot.gated) {
      onFeedbackBarTargetChange(undefined);
      return;
    }
    const presentedNodes = runtime.scene.getPresentedNodes();
    const currentSelection = runtime.getSnapshot().selection;
    if (currentSelection?.kind === 'nodes' && currentSelection.projectRelativePaths.length > 1) {
      onFeedbackBarTargetChange(canvasFeedbackBarTargetForSelection({
        projectRelativePaths: currentSelection.projectRelativePaths,
        nodes: [...presentedNodes.values()],
        surfaceRect: domRectToFloatingBarRect(surfaceRect),
        camera
      }));
      return;
    }
    const hoveredNodePath = interactionSnapshot.hoveredNodePath;
    if (hoveredNodePath === undefined) {
      onFeedbackBarTargetChange(undefined);
      return;
    }
    const node = presentedNodes.get(hoveredNodePath);
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
      onClickCapture={handleSurfaceClickCapture}
      onPointerMove={handlePointerMove}
      onPointerOver={handlePointerOver}
      onPointerLeave={handlePointerLeave}
      onPointerUp={handlePointerUpEvent}
      onPointerCancel={cancelPointerEvent}
      onLostPointerCapture={cancelPointerEvent}
      onContextMenu={handleSurfaceContextMenu}
      data-canvas-surface="true"
    >
      <div
        ref={stageRef}
        className="canvas-world-stage"
      >
        {renderSnapshot.edgeGroups.length > 0 ? (
          <CanvasSurfaceEdgeLayer
            groups={renderSnapshot.edgeGroups}
            stageRuntime={stageRuntime}
          />
        ) : null}
        <CanvasRasterPreviewEnvironmentProvider value={rasterPreviewEnvironment}>
          <CanvasVideoPreviewProvider
            nodes={projectedNodes}
            feedbackVideoResources={feedbackVideoResources}
            sourceResolutionRuntime={sourceResolutionRuntime}
            activeVideoPaths={activeVideoPaths}
            feedbackEntries={canvasFeedback?.entries}
            actions={actions}
            previewOrder={renderLifecycle}
            previewResourceScheduler={previewResourceScheduler}
            onMetadata={onVideoMetadata}
          >
            <CanvasTextPreviewProvider
              nodes={projectedNodes}
              sourceResolutionRuntime={sourceResolutionRuntime}
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
                  runtime={runtime}
                  sourceResolutionRuntime={sourceResolutionRuntime}
                  cut={cutPathSet.has(node.projectRelativePath)}
                  contentInteractionActive={activeContentInteractionNode?.projectRelativePath === node.projectRelativePath}
                  zIndex={node.z}
                  stageRuntime={stageRuntime}
                  actions={actions}
                  textBuffer={textFileBuffers[node.projectRelativePath]}
                  forceVideoPlayerMounted={requestedVideoPlayerPath === node.projectRelativePath}
                  contentHandoffRequest={contentHandoffRequest?.projectRelativePath === node.projectRelativePath
                    ? contentHandoffRequest
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
                  onContentError={handleContentError}
                  onContentHandoffConsumed={handleContentHandoffConsumed}
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
      />
    </div>
  );
  return instrumentationMonitor ? (
    <React.Profiler
      id="canvas-surface"
      onRender={() => {
        if (canvasPerfSessionRef.current || canvasPerfPointerInteractionSessionRef.current) {
          perfMonitor.recordCounter({
            timestamp: performance.now(),
            source: 'CanvasSurface',
            sessionTypes: CANVAS_PERF_INTERACTION_SESSION_TYPES,
            name: 'react-commit'
          });
        }
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
  runtime: CanvasEditorRuntime;
  sourceResolutionRuntime: CanvasSourceResolutionRuntime;
  cut: boolean;
  contentInteractionActive: boolean;
  zIndex: number;
  stageRuntime: CanvasStageRuntime;
  actions: CanvasSceneActions;
  textBuffer: TextFileBuffer | undefined;
  forceVideoPlayerMounted: boolean;
  contentHandoffRequest?: CanvasContentHandoffRequest | undefined;
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
  onContentError: (projectRelativePath: string) => void;
  onContentHandoffConsumed: (requestId: number) => void;
  onRegisterVideoTarget: (projectRelativePath: string, target: CanvasVideoPlayerHandle | undefined) => void;
  onUpdateVideoPlaybackTime: (projectRelativePath: string, currentTimeMs: number) => void | Promise<void>;
  onUpdateTextViewport: (projectRelativePath: string, viewport: CanvasTextViewportState) => void | Promise<void>;
}

function CanvasSurfaceNodeShell(props: CanvasSurfaceNodeShellProps): React.ReactElement {
  const subscribeAcceptedNode = useCallback((listener: () => void) => (
    props.runtime.scene.subscribeAcceptedNode(props.node.projectRelativePath, listener)
  ), [props.node.projectRelativePath, props.runtime]);
  const getAcceptedNode = useCallback(() => (
    props.runtime.scene.getAcceptedNode(props.node.projectRelativePath) ?? props.node
  ), [props.node, props.runtime]);
  const acceptedNode = useSyncExternalStore(
    subscribeAcceptedNode,
    getAcceptedNode,
    getAcceptedNode
  );
  const subscribeSource = useCallback((listener: () => void) => (
    props.sourceResolutionRuntime.subscribeNode(acceptedNode, listener)
  ), [acceptedNode, props.sourceResolutionRuntime]);
  const getSourceSnapshot = useCallback(() => (
    props.sourceResolutionRuntime.getNodeSnapshot(acceptedNode)
  ), [acceptedNode, props.sourceResolutionRuntime]);
  const node = useSyncExternalStore(subscribeSource, getSourceSnapshot, getSourceSnapshot);
  const subscribe = useCallback((listener: () => void) => (
    props.stageRuntime.subscribeSingleSelectedNode(props.node.projectRelativePath, listener)
  ), [props.node.projectRelativePath, props.stageRuntime]);
  const getSnapshot = useCallback(() => (
    props.stageRuntime.isSingleSelectedNode(props.node.projectRelativePath)
  ), [props.node.projectRelativePath, props.stageRuntime]);
  const showResizeHandles = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const resolvedProps = { ...props, node, showResizeHandles };
  if (node.mediaKind === 'text') {
    return <CanvasTextSurfaceNodeShell {...resolvedProps} />;
  }
  if (node.mediaKind === 'video') {
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
  const { request, previewError, metadata } = useCanvasVideoPreviewNode(props.node);
  return (
    <CanvasSurfaceNodeShellBase
      {...props}
      node={metadata ? { ...props.node, videoMetadata: metadata } : props.node}
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
  contentHandoffRequest,
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
  onContentError,
  onContentHandoffConsumed,
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
      contentHandoffRequest={contentHandoffRequest}
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
      onContentError={onContentError}
      onContentHandoffConsumed={onContentHandoffConsumed}
      onRegisterVideoTarget={onRegisterVideoTarget}
      onUpdateVideoPlaybackTime={onUpdateVideoPlaybackTime}
      onUpdateTextViewport={onUpdateTextViewport}
    />
  );
}

function CanvasSelectionMarqueeOverlay({
  runtime
}: {
  runtime: CanvasEditorRuntime;
}): React.ReactElement {
  const elementRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    let lastTransform: string | undefined;
    let lastWidth: string | undefined;
    let lastHeight: string | undefined;

    const writeMarquee = () => {
      const element = elementRef.current;
      if (!element) {
        return;
      }
      const snapshot = runtime.getSnapshot();
      const interaction = snapshot.pointerInteraction;
      if (interaction?.kind !== 'selection-marquee'
        || interaction.phase !== 'active'
        || interaction.rect === undefined) {
        element.hidden = true;
        return;
      }
      const { camera } = snapshot;
      const transform = `translate3d(${camera.x + interaction.rect.x * camera.z}px, ${camera.y + interaction.rect.y * camera.z}px, 0px)`;
      const width = `${interaction.rect.width * camera.z}px`;
      const height = `${interaction.rect.height * camera.z}px`;
      element.hidden = false;
      if (lastTransform !== transform) {
        element.style.transform = transform;
        lastTransform = transform;
      }
      if (lastWidth !== width) {
        element.style.width = width;
        lastWidth = width;
      }
      if (lastHeight !== height) {
        element.style.height = height;
        lastHeight = height;
      }
    };

    writeMarquee();
    const unsubscribePointer = runtime.subscribePointerInteraction(writeMarquee);
    const unsubscribeCamera = runtime.subscribeCamera(writeMarquee);
    return () => {
      unsubscribePointer();
      unsubscribeCamera();
    };
  }, [runtime]);

  return (
    <div
      ref={elementRef}
      className="canvas-selection-marquee"
      data-testid="canvas-selection-marquee"
      hidden
      aria-hidden="true"
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
