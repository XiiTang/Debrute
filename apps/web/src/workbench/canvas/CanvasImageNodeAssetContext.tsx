import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import { CANVAS_PERF_INTERACTION_SESSION_TYPES, type CanvasPerfCounterName, type CanvasPerfMonitor } from './CanvasPerfMonitor';
import {
  canvasImageNodeAssetReducer,
  deriveCanvasImageNodeRenderState,
  initialCanvasImageNodeAssetState,
  resolveCanvasImageNodeSource,
  shouldPublishCanvasImageNodeSourceImmediately,
  type CanvasImageNodeRenderState,
  type CanvasImageNodeResolvedSource
} from './CanvasImageNodeAsset';
import { CANVAS_IMAGE_PREVIEW_RESOURCE_SETTLE_MS } from './canvasImagePreviews';
import type { CanvasCameraState } from './runtime/canvasCamera';

export interface CanvasImageNodeAssetContextValue {
  imageResourceZoom: number;
  devicePixelRatio: number;
  cameraState: CanvasCameraState;
  perfMonitor?: Pick<CanvasPerfMonitor, 'recordCounter'> | undefined;
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
  const previousImageResourceZoomRef = useRef(context.imageResourceZoom);
  const source = useMemo(() => resolveCanvasImageNodeSource({
    node: input.node,
    imageResourceZoom: context.imageResourceZoom,
    devicePixelRatio: context.devicePixelRatio,
    retryKey: state.retryKey
  }), [
    context.devicePixelRatio,
    context.imageResourceZoom,
    input.node,
    state.retryKey
  ]);

  useEffect(() => {
    const revisionChanged = previousRevisionKeyRef.current !== source.sourceRevisionKey;
    previousRevisionKeyRef.current = source.sourceRevisionKey;
    const imageResourceZoomChanged = previousImageResourceZoomRef.current !== context.imageResourceZoom;
    previousImageResourceZoomRef.current = context.imageResourceZoom;
    const retryRequested = retryRequestedRef.current;
    const shouldRunImmediately = shouldPublishCanvasImageNodeSourceImmediately({
      source,
      didResolveUrl: didResolveUrlRef.current,
      revisionChanged,
      retryRequested,
      hasLoadedImage: Boolean(state.loaded),
      culled: input.culled,
      cameraState: context.cameraState,
      loadedLoadKey: state.loaded?.loadKey,
      imageResourceZoomChanged
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

    const handle = window.setTimeout(publishSource, CANVAS_IMAGE_PREVIEW_RESOURCE_SETTLE_MS);
    return () => {
      window.clearTimeout(handle);
    };
  }, [
    context,
    input.culled,
    input.node,
    source,
    state.loaded
  ]);

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
