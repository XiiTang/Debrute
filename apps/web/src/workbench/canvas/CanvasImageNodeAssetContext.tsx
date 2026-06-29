import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import { CANVAS_PERF_INTERACTION_SESSION_TYPES, type CanvasPerfCounterName, type CanvasPerfMonitor } from './CanvasPerfMonitor';
import type { CanvasPreviewResourceScheduler } from './CanvasPreviewResourceScheduler';
import {
  canvasImageNodeAssetReducer,
  deriveCanvasImageNodeRenderState,
  initialCanvasImageNodeAssetState,
  resolveCanvasImageNodeSource,
  shouldPublishCanvasImageNodeSourceImmediately,
  type CanvasImageNodeRenderState,
  type CanvasImageNodeResolvedSource
} from './CanvasImageNodeAsset';
import type { CanvasCameraState } from './runtime/canvasCamera';

export interface CanvasImageNodeAssetContextValue {
  resourceZoom: number;
  devicePixelRatio: number;
  cameraState: CanvasCameraState;
  dragActive: boolean;
  perfMonitor?: Pick<CanvasPerfMonitor, 'recordCounter'> | undefined;
  previewResourceScheduler: CanvasPreviewResourceScheduler;
}

export type CanvasImageNodeAssetHookState = CanvasImageNodeRenderState & {
  resolveNext: (loadKey: string) => void;
  rejectNext: (loadKey: string) => void;
};

const CanvasImageNodeAssetContext = createContext<CanvasImageNodeAssetContextValue | undefined>(undefined);

export function CanvasImageNodeAssetProvider({
  value,
  children
}: {
  value: CanvasImageNodeAssetContextValue;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <CanvasImageNodeAssetContext.Provider value={value}>
      {children}
    </CanvasImageNodeAssetContext.Provider>
  );
}

export function useCanvasImageNodeAsset(input: {
  node: ProjectedCanvasNode;
  culled: boolean;
}): CanvasImageNodeAssetHookState {
  const context = useCanvasImageNodeAssetContext();
  const [state, dispatch] = useReducer(canvasImageNodeAssetReducer, undefined, initialCanvasImageNodeAssetState);
  const didResolveUrlRef = useRef(false);
  const retryRequestedRef = useRef(false);
  const previousRevisionKeyRef = useRef<string | undefined>(undefined);
  const previousCulledRef = useRef(input.culled);
  const latestScheduleKeyRef = useRef<string | undefined>(undefined);
  const latestCulledRef = useRef(input.culled);
  latestCulledRef.current = input.culled;
  const source = useMemo(() => resolveCanvasImageNodeSource({
    node: input.node,
    resourceZoom: context.resourceZoom,
    devicePixelRatio: context.devicePixelRatio,
    retryKey: state.retryKey
  }), [
    context.devicePixelRatio,
    context.resourceZoom,
    input.node,
    state.retryKey
  ]);
  const scheduleKey = source.kind === 'source'
    ? `${source.sourceRevisionKey}\u001f${source.image.loadKey}`
    : `${source.kind}\u001f${source.sourceRevisionKey ?? ''}`;
  latestScheduleKeyRef.current = scheduleKey;

  useEffect(() => {
    const revisionChanged = previousRevisionKeyRef.current !== source.sourceRevisionKey;
    previousRevisionKeyRef.current = source.sourceRevisionKey;
    const becameVisibleAfterCull = previousCulledRef.current && !input.culled;
    previousCulledRef.current = input.culled;
    const retryRequested = retryRequestedRef.current;
    const shouldRunImmediately = shouldPublishCanvasImageNodeSourceImmediately({
      source,
      didResolveUrl: didResolveUrlRef.current,
      revisionChanged,
      retryRequested,
      hasLoadedImage: Boolean(state.loaded),
      culled: input.culled,
      becameVisibleAfterCull,
      dragActive: context.dragActive,
      loadedLoadKey: state.loaded?.loadKey
    });
    retryRequestedRef.current = false;

    const publishSource = () => {
      if (source.kind === 'source') {
        didResolveUrlRef.current = true;
      }
      recordSourceCounter({
        context,
        node: input.node,
        source,
        loadedLoadKey: state.loaded?.loadKey,
        culled: input.culled,
        cameraState: context.cameraState,
        revisionChanged
      });
      dispatch({
        type: 'source-resolved',
        source,
        cameraState: context.cameraState,
        culled: input.culled
      });
    };

    if (shouldRunImmediately) {
      publishSource();
      return undefined;
    }

    if (source.kind !== 'source') {
      return undefined;
    }

    if (input.culled) {
      context.previewResourceScheduler.cancel('image', input.node.projectRelativePath);
      return undefined;
    }

    context.previewResourceScheduler.enqueue({
      kind: 'image',
      nodeId: input.node.projectRelativePath,
      sourceKey: scheduleKey,
      targetWidth: source.image.previewWidth,
      isCurrent: () => latestScheduleKeyRef.current === scheduleKey,
      isCulled: () => latestCulledRef.current,
      run: publishSource
    });
    return undefined;
  }, [
    context,
    input.culled,
    input.node,
    source,
    scheduleKey,
    state.loaded
  ]);

  useEffect(() => () => {
    context.previewResourceScheduler.cancel('image', input.node.projectRelativePath);
  }, [context.previewResourceScheduler, input.node.projectRelativePath]);

  useEffect(() => {
    if (context.cameraState !== 'idle' || context.dragActive) {
      dispatch({ type: 'interaction-started' });
    }
  }, [context.cameraState, context.dragActive]);

  const retry = useCallback(() => {
    retryRequestedRef.current = true;
    recordImageNodeCounter(context, 'image-node-retry', {
      projectRelativePath: input.node.projectRelativePath
    });
    dispatch({ type: 'retry' });
  }, [context, input.node.projectRelativePath]);

  const resolveNext = useCallback((loadKey: string) => {
    recordImageNodeCounter(context, 'image-node-next-load-resolve', {
      projectRelativePath: input.node.projectRelativePath,
      loadKey
    });
    recordImageNodeCounter(context, 'image-node-handoff-promote', {
      projectRelativePath: input.node.projectRelativePath,
      loadKey
    });
    dispatch({ type: 'next-loaded', loadKey });
  }, [context, input.node.projectRelativePath]);

  const rejectNext = useCallback((loadKey: string) => {
    recordImageNodeCounter(context, 'image-node-next-load-reject', {
      projectRelativePath: input.node.projectRelativePath,
      loadKey
    });
    dispatch({
      type: 'next-failed',
      loadKey,
      message: `Unable to load ${input.node.projectRelativePath}.`
    });
  }, [context, input.node.projectRelativePath]);

  return {
    ...deriveCanvasImageNodeRenderState({
      state,
      retry,
      notEligible: source.kind === 'not-eligible'
    }),
    resolveNext,
    rejectNext
  };
}

export function useCanvasImageNodeAssetContext(): CanvasImageNodeAssetContextValue {
  const context = useContext(CanvasImageNodeAssetContext);
  if (!context) {
    throw new Error('CanvasImageNodeAssetProvider is required.');
  }
  return context;
}

function recordSourceCounter(input: {
  context: CanvasImageNodeAssetContextValue;
  node: ProjectedCanvasNode;
  source: CanvasImageNodeResolvedSource;
  loadedLoadKey: string | undefined;
  culled: boolean;
  cameraState: CanvasCameraState;
  revisionChanged: boolean;
}): void {
  if (input.source.kind === 'not-eligible') {
    recordImageNodeCounter(input.context, 'image-node-url-unavailable', {
      projectRelativePath: input.node.projectRelativePath,
      reason: input.source.reason
    });
    return;
  }
  if (input.revisionChanged) {
    recordImageNodeCounter(input.context, 'image-node-source-reset', {
      projectRelativePath: input.node.projectRelativePath,
      sourceRevisionKey: input.source.sourceRevisionKey
    });
  }
  if (input.loadedLoadKey === input.source.image.loadKey) {
    recordImageNodeCounter(input.context, 'image-node-url-unchanged', {
      projectRelativePath: input.node.projectRelativePath,
      loadKey: input.source.image.loadKey
    });
    return;
  }
  const shouldSkipCulledWork = input.culled
    && (input.cameraState !== 'idle' || input.loadedLoadKey !== undefined);
  if (shouldSkipCulledWork) {
    recordImageNodeCounter(input.context, 'image-node-upgrade-skip-culled', {
      projectRelativePath: input.node.projectRelativePath,
      loadKey: input.source.image.loadKey
    });
    return;
  }
  if (input.cameraState === 'moving' && input.loadedLoadKey !== undefined) {
    recordImageNodeCounter(input.context, 'image-node-upgrade-skip-moving', {
      projectRelativePath: input.node.projectRelativePath,
      loadKey: input.source.image.loadKey
    });
    return;
  }
  recordImageNodeCounter(input.context, 'image-node-url-resolve', {
    projectRelativePath: input.node.projectRelativePath,
    loadKey: input.source.image.loadKey,
    previewWidth: input.source.image.previewWidth
  });
  recordImageNodeCounter(input.context, 'image-node-next-load-start', {
    projectRelativePath: input.node.projectRelativePath,
    loadKey: input.source.image.loadKey,
    previewWidth: input.source.image.previewWidth
  });
}

function recordImageNodeCounter(
  context: CanvasImageNodeAssetContextValue,
  name: CanvasPerfCounterName,
  detail: Record<string, unknown>
): void {
  context.perfMonitor?.recordCounter({
    sessionTypes: CANVAS_PERF_INTERACTION_SESSION_TYPES,
    timestamp: globalThis.performance?.now?.() ?? Date.now(),
    source: 'CanvasImageNodeAsset',
    name,
    detail
  });
}
