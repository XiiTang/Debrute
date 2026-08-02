import React, { createContext, startTransition, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { CANVAS_PERF_INTERACTION_SESSION_TYPES, type CanvasPerfCounterName, type CanvasPerfMonitor } from './CanvasPerfMonitor';
import type { CanvasPreviewResourceScheduler } from './CanvasPreviewResourceScheduler';
import {
  canvasImageNodeSourceRequest,
  canvasImageNodeAssetReducer,
  deriveCanvasImageNodeRenderState,
  initialCanvasImageNodeAssetState,
  resolveCanvasImageNodeSource,
  shouldPublishCanvasImageNodeSourceImmediately,
  type CanvasImageNodeSourceInput,
  type CanvasImageNodeRenderState,
  type CanvasImageNodeResolvedSource
} from './CanvasImageNodeAsset';
import type { CanvasCameraState } from './runtime/canvasCamera';

export interface CanvasImageNodeAssetContextValue {
  resourceZoom: number;
  devicePixelRatio: number;
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
  source: CanvasImageNodeSourceInput;
}): CanvasImageNodeAssetHookState {
  const context = useCanvasImageNodeAssetContext();
  const { perfMonitor, previewResourceScheduler } = context;
  const [state, setState] = useState(initialCanvasImageNodeAssetState);
  const dispatch = useCallback((event: Parameters<typeof canvasImageNodeAssetReducer>[1]) => {
    setState((current) => canvasImageNodeAssetReducer(current, event));
  }, []);
  const retryRequestedRef = useRef(false);
  const previousRevisionKeyRef = useRef<string | undefined>(undefined);
  const latestScheduleKeyRef = useRef<string | undefined>(undefined);
  const latestLoadedRef = useRef(state.loaded);
  const latestNextLoadKeyRef = useRef<string | undefined>(state.next?.loadKey);
  const latestPerfMonitorRef = useRef(perfMonitor);
  const decodedNextLoadKeysRef = useRef(new Set<string>());
  latestLoadedRef.current = state.loaded;
  latestNextLoadKeyRef.current = state.next?.loadKey;
  latestPerfMonitorRef.current = perfMonitor;
  const sourceRequest = useMemo(() => canvasImageNodeSourceRequest({
    source: input.source,
    resourceZoom: context.resourceZoom,
    devicePixelRatio: context.devicePixelRatio
  }), [
    context.devicePixelRatio,
    context.resourceZoom,
    input.source.availability,
    input.source.displayWidth,
    input.source.mediaKind,
    input.source.nodeKind,
    input.source.projectRelativePath
  ]);
  const projectRelativePath = sourceRequest.projectRelativePath;
  const sourceRequestReason = sourceRequest.kind === 'not-eligible'
    ? sourceRequest.reason
    : undefined;
  const sourceRequestFileUrl = sourceRequest.kind === 'source'
    ? sourceRequest.fileUrl
    : undefined;
  const sourceRequestRevision = sourceRequest.kind === 'source'
    ? sourceRequest.revision
    : undefined;
  const sourceRequestSourceWidth = sourceRequest.kind === 'source'
    ? sourceRequest.sourceWidth
    : undefined;
  const sourceRequestPreviewWidth = sourceRequest.kind === 'source'
    ? sourceRequest.previewWidth
    : undefined;
  const source = useMemo(() => resolveCanvasImageNodeSource({
    request: sourceRequest,
    retryKey: state.retryKey
  }), [
    projectRelativePath,
    sourceRequest.kind,
    sourceRequest.sourceRevisionKey,
    sourceRequestFileUrl,
    sourceRequestPreviewWidth,
    sourceRequestReason,
    sourceRequestRevision,
    sourceRequestSourceWidth,
    state.retryKey
  ]);
  const scheduleKey = source.kind === 'source'
    ? `${source.sourceRevisionKey}\u001f${source.image.loadKey}`
    : `${source.kind}\u001f${source.sourceRevisionKey ?? ''}`;
  latestScheduleKeyRef.current = scheduleKey;
  useEffect(() => {
    const previousRevisionKey = previousRevisionKeyRef.current;
    const revisionChanged = previousRevisionKey !== undefined
      && previousRevisionKey !== source.sourceRevisionKey;
    previousRevisionKeyRef.current = source.sourceRevisionKey;
    const retryRequested = retryRequestedRef.current;
    const loaded = latestLoadedRef.current;
    const shouldRunImmediately = shouldPublishCanvasImageNodeSourceImmediately({
      source,
      revisionChanged,
      retryRequested,
      loadedLoadKey: loaded?.loadKey
    });
    retryRequestedRef.current = false;

    const publishSource = () => {
      const currentInteraction = previewResourceScheduler.getInteractionState();
      const currentLoaded = latestLoadedRef.current;
      recordSourceCounter({
        perfMonitor: latestPerfMonitorRef.current,
        projectRelativePath,
        source,
        loadedLoadKey: currentLoaded?.loadKey,
        cameraState: currentInteraction.cameraState,
        revisionChanged
      });
      dispatch({
        type: 'source-resolved',
        source,
        cameraState: currentInteraction.cameraState
      });
    };

    const enqueueSource = () => {
      if (source.kind !== 'source') {
        return;
      }
      previewResourceScheduler.enqueue({
        kind: 'image',
        nodeId: projectRelativePath,
        sourceKey: scheduleKey,
        targetWidth: source.image.previewWidth,
        isCurrent: () => latestScheduleKeyRef.current === scheduleKey,
        run: publishSource
      });
    };

    if (shouldRunImmediately) {
      publishSource();
      return undefined;
    }

    enqueueSource();
    return undefined;
  }, [
    previewResourceScheduler,
    projectRelativePath,
    source,
    scheduleKey
  ]);

  useEffect(() => () => {
    previewResourceScheduler.cancel('image', projectRelativePath);
  }, [previewResourceScheduler, projectRelativePath]);

  const retry = useCallback(() => {
    retryRequestedRef.current = true;
    recordImageNodeCounter(perfMonitor, 'image-node-retry', {
      projectRelativePath
    });
    dispatch({ type: 'retry' });
  }, [perfMonitor, projectRelativePath]);

  const enqueueDecodedHandoff = useCallback((next: { loadKey: string; previewWidth: number }) => {
    const { loadKey } = next;
    previewResourceScheduler.enqueuePublication({
      kind: 'image',
      nodeId: projectRelativePath,
      sourceKey: loadKey,
      targetWidth: next.previewWidth,
      isCurrent: () => latestNextLoadKeyRef.current === loadKey,
      run: () => {
        if (latestNextLoadKeyRef.current !== loadKey) {
          return;
        }
        recordImageNodeCounter(perfMonitor, 'image-node-handoff-promote', {
          projectRelativePath,
          loadKey
        });
        startTransition(() => {
          setState((current) => {
            if (latestNextLoadKeyRef.current !== loadKey) {
              return current;
            }
            return canvasImageNodeAssetReducer(current, { type: 'next-loaded', loadKey });
          });
        });
      }
    });
  }, [perfMonitor, previewResourceScheduler, projectRelativePath]);

  const resolveNext = useCallback((loadKey: string) => {
    const next = state.next;
    if (!next || next.loadKey !== loadKey) {
      return;
    }
    recordImageNodeCounter(perfMonitor, 'image-node-next-load-resolve', {
      projectRelativePath,
      loadKey
    });
    decodedNextLoadKeysRef.current.add(loadKey);
    enqueueDecodedHandoff(next);
  }, [enqueueDecodedHandoff, perfMonitor, projectRelativePath, state.next]);

  useEffect(() => {
    const next = state.next;
    for (const decodedLoadKey of decodedNextLoadKeysRef.current) {
      if (decodedLoadKey !== next?.loadKey) {
        decodedNextLoadKeysRef.current.delete(decodedLoadKey);
      }
    }
    if (next && decodedNextLoadKeysRef.current.has(next.loadKey)) {
      enqueueDecodedHandoff(next);
    }
  }, [enqueueDecodedHandoff, state.next]);

  const rejectNext = useCallback((loadKey: string) => {
    if (latestNextLoadKeyRef.current !== loadKey) {
      return;
    }
    recordImageNodeCounter(perfMonitor, 'image-node-next-load-reject', {
      projectRelativePath,
      loadKey
    });
    dispatch({
      type: 'next-failed',
      loadKey,
      message: `Unable to load ${projectRelativePath}.`
    });
  }, [perfMonitor, projectRelativePath]);

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
  perfMonitor: CanvasImageNodeAssetContextValue['perfMonitor'];
  projectRelativePath: string;
  source: CanvasImageNodeResolvedSource;
  loadedLoadKey: string | undefined;
  cameraState: CanvasCameraState;
  revisionChanged: boolean;
}): void {
  if (input.source.kind === 'not-eligible') {
    recordImageNodeCounter(input.perfMonitor, 'image-node-url-unavailable', {
      projectRelativePath: input.projectRelativePath,
      reason: input.source.reason
    });
    return;
  }
  if (input.revisionChanged) {
    recordImageNodeCounter(input.perfMonitor, 'image-node-source-reset', {
      projectRelativePath: input.projectRelativePath,
      sourceRevisionKey: input.source.sourceRevisionKey
    });
  }
  if (input.loadedLoadKey === input.source.image.loadKey) {
    recordImageNodeCounter(input.perfMonitor, 'image-node-url-unchanged', {
      projectRelativePath: input.projectRelativePath,
      loadKey: input.source.image.loadKey
    });
    return;
  }
  if (input.cameraState === 'moving' && input.loadedLoadKey !== undefined) {
    recordImageNodeCounter(input.perfMonitor, 'image-node-upgrade-skip-moving', {
      projectRelativePath: input.projectRelativePath,
      loadKey: input.source.image.loadKey
    });
    return;
  }
  recordImageNodeCounter(input.perfMonitor, 'image-node-url-resolve', {
    projectRelativePath: input.projectRelativePath,
    loadKey: input.source.image.loadKey,
    previewWidth: input.source.image.previewWidth
  });
  recordImageNodeCounter(input.perfMonitor, 'image-node-next-load-start', {
    projectRelativePath: input.projectRelativePath,
    loadKey: input.source.image.loadKey,
    previewWidth: input.source.image.previewWidth
  });
}

function recordImageNodeCounter(
  perfMonitor: CanvasImageNodeAssetContextValue['perfMonitor'],
  name: CanvasPerfCounterName,
  detail: Record<string, unknown>
): void {
  perfMonitor?.recordCounter({
    sessionTypes: CANVAS_PERF_INTERACTION_SESSION_TYPES,
    timestamp: performance.now(),
    source: 'CanvasImageNodeAsset',
    name,
    detail
  });
}
