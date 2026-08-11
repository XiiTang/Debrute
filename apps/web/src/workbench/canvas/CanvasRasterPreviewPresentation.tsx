import React, {
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react';
import {
  canvasPreviewVariantKey,
  canvasRasterPreviewWidth,
  type CanvasPreviewContinuityKey,
  type CanvasPreviewTargetIdentity,
  type CanvasPreviewVariantKey
} from '@debrute/canvas-core';
import type {
  CanvasPreviewResourceKind,
  CanvasPreviewResourceScheduler
} from './CanvasPreviewResourceScheduler';
import {
  CANVAS_PERF_INTERACTION_SESSION_TYPES,
  type CanvasPerfCounterName,
  type CanvasPerfMonitor
} from './CanvasPerfMonitor';
import type { CanvasResourceZoomSource } from './CanvasResourceZoom';

export interface CanvasRasterPreviewEnvironment {
  resourceZoomSource: CanvasResourceZoomSource;
  devicePixelRatio: number;
  previewResourceScheduler: CanvasPreviewResourceScheduler;
  perfMonitor?: Pick<CanvasPerfMonitor, 'recordCounter'> | undefined;
}

export interface CanvasRasterPreviewVariantTarget {
  mediaKind: CanvasPreviewResourceKind;
  bindingId: string;
  projectRelativePath: string;
  targetIdentity: CanvasPreviewTargetIdentity;
  sourceWidth: number;
  srcForWidth(width: number): string;
}

export interface CanvasRasterPreviewRequest {
  continuityKey?: CanvasPreviewContinuityKey | undefined;
  variantTarget?: CanvasRasterPreviewVariantTarget | undefined;
}

export interface CanvasRasterPreviewFailure {
  stage: 'source' | 'load' | 'decode' | 'visible';
  error: unknown;
  retry?: (() => void) | undefined;
}

export interface CanvasRasterPreviewPresentation {
  layers: React.ReactElement;
  status: 'empty' | 'loading' | 'visible' | 'failed';
  hasVisible: boolean;
  visibleSourceKey?: CanvasPreviewVariantKey | undefined;
  committedSourceKey?: CanvasPreviewVariantKey | undefined;
  failure?: CanvasRasterPreviewFailure | undefined;
  retry(): void;
}

export function sameCanvasRasterPreviewRequest(
  left: CanvasRasterPreviewRequest,
  right: CanvasRasterPreviewRequest
): boolean {
  const leftTarget = left.variantTarget;
  const rightTarget = right.variantTarget;
  return left.continuityKey === right.continuityKey
    && leftTarget?.mediaKind === rightTarget?.mediaKind
    && leftTarget?.bindingId === rightTarget?.bindingId
    && leftTarget?.projectRelativePath === rightTarget?.projectRelativePath
    && leftTarget?.targetIdentity === rightTarget?.targetIdentity
    && leftTarget?.sourceWidth === rightTarget?.sourceWidth;
}

interface CanvasRasterPreviewLayerSource {
  mediaKind: CanvasPreviewResourceKind;
  continuityKey: CanvasPreviewContinuityKey;
  sourceKey: CanvasPreviewVariantKey;
  loadKey: string;
  src: string;
  previewWidth: number;
}

interface CanvasRasterPreviewState {
  visible?: CanvasRasterPreviewLayerSource | undefined;
  pending?: CanvasRasterPreviewLayerSource | undefined;
  failure?: (CanvasRasterPreviewFailure & {
    continuityKey: CanvasPreviewContinuityKey;
    loadKey?: string | undefined;
  }) | undefined;
}

const CanvasRasterPreviewEnvironmentContext = React.createContext<CanvasRasterPreviewEnvironment | undefined>(undefined);

export function CanvasRasterPreviewEnvironmentProvider({
  value,
  children
}: {
  value: CanvasRasterPreviewEnvironment;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <CanvasRasterPreviewEnvironmentContext.Provider value={value}>
      {children}
    </CanvasRasterPreviewEnvironmentContext.Provider>
  );
}

export function useCanvasRasterPreviewEnvironment(): CanvasRasterPreviewEnvironment {
  const value = useContext(CanvasRasterPreviewEnvironmentContext);
  if (!value) {
    throw new Error('CanvasRasterPreviewEnvironmentProvider is required.');
  }
  return value;
}

export function useCanvasRasterPreviewPresentation(input: {
  request: CanvasRasterPreviewRequest;
  nodeDisplayWidth: number;
  fit: 'fill' | 'contain';
  hidden?: boolean | undefined;
  trackDomCommit?: boolean | undefined;
  sourceFailure?: CanvasRasterPreviewFailure | undefined;
  onPointerDown?: React.PointerEventHandler<HTMLImageElement> | undefined;
}): CanvasRasterPreviewPresentation {
  const environment = useCanvasRasterPreviewEnvironment();
  const resourceZoom = useSyncExternalStore(
    environment.resourceZoomSource.subscribe,
    environment.resourceZoomSource.getSnapshot,
    environment.resourceZoomSource.getSnapshot
  );
  const [state, setState] = useState<CanvasRasterPreviewState>({});
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [committedSourceKey, setCommittedSourceKey] = useState<CanvasPreviewVariantKey>();
  const desired = useMemo(() => canvasRasterPreviewDesiredSource({
    request: input.request,
    nodeDisplayWidth: input.nodeDisplayWidth,
    resourceZoom,
    devicePixelRatio: environment.devicePixelRatio,
    retryAttempt
  }), [
    environment.devicePixelRatio,
    input.nodeDisplayWidth,
    input.request,
    resourceZoom,
    retryAttempt
  ]);
  const continuityKey = input.request.continuityKey;
  const visible = state.visible?.continuityKey === continuityKey ? state.visible : undefined;
  const pending = state.pending?.continuityKey === continuityKey ? state.pending : undefined;
  const stateFailure = state.failure;
  const localFailure = stateFailure
    && stateFailure.continuityKey === continuityKey
    && (stateFailure.loadKey === undefined || stateFailure.loadKey === desired?.loadKey)
    ? stateFailure
    : undefined;
  const latestRef = useRef({ continuityKey, desired, state });
  latestRef.current = { continuityKey, desired, state };
  const lastRequestedLoadKeyRef = useRef<string | undefined>(undefined);
  const recordCounter = useCallback((
    name: CanvasPerfCounterName,
    source: CanvasRasterPreviewLayerSource | undefined,
    detail?: Record<string, unknown>
  ) => {
    environment.perfMonitor?.recordCounter({
      sessionTypes: CANVAS_PERF_INTERACTION_SESSION_TYPES,
      timestamp: performance.now(),
      source: 'CanvasRasterPreviewPresentation',
      name,
      detail: {
        mediaKind: source?.mediaKind ?? input.request.variantTarget?.mediaKind,
        projectRelativePath: input.request.variantTarget?.projectRelativePath,
        previewWidth: source?.previewWidth,
        ...detail
      }
    });
  }, [environment.perfMonitor, input.request.variantTarget]);

  useEffect(() => {
    if (!desired) {
      lastRequestedLoadKeyRef.current = undefined;
      return;
    }
    if (lastRequestedLoadKeyRef.current !== desired.loadKey) {
      lastRequestedLoadKeyRef.current = desired.loadKey;
      recordCounter('raster-preview-requested', desired);
    }
  }, [desired, recordCounter]);

  useEffect(() => {
    setState((current) => {
      const nextVisible = current.visible?.continuityKey === continuityKey ? current.visible : undefined;
      const nextPending = current.pending?.continuityKey === continuityKey ? current.pending : undefined;
      const nextFailure = current.failure?.continuityKey === continuityKey ? current.failure : undefined;
      if (nextVisible === current.visible
        && nextPending === current.pending
        && nextFailure === current.failure) {
        return current;
      }
      return { visible: nextVisible, pending: nextPending, failure: nextFailure };
    });
  }, [continuityKey]);

  useEffect(() => {
    if (!desired) {
      return;
    }
    if (visible?.sourceKey === desired.sourceKey) {
      if (pending || localFailure) {
        setState((current) => ({ ...current, pending: undefined, failure: undefined }));
      }
      return;
    }
    if (pending?.loadKey === desired.loadKey) {
      return;
    }

    const mount = () => {
      const latest = latestRef.current;
      if (latest.continuityKey !== desired.continuityKey
        || latest.desired?.loadKey !== desired.loadKey) {
        return;
      }
      startTransition(() => {
        setState((current) => ({
          visible: current.visible?.continuityKey === desired.continuityKey
            ? current.visible
            : undefined,
          pending: desired,
          failure: undefined
        }));
      });
      recordCounter('raster-preview-pending-mounted', desired);
    };

    if (localFailure) {
      return;
    }
    environment.previewResourceScheduler.enqueue({
      kind: input.request.variantTarget?.mediaKind ?? 'image',
      nodeId: input.request.variantTarget?.projectRelativePath ?? '',
      sourceKey: desired.loadKey,
      targetWidth: desired.previewWidth,
      isCurrent: () => latestRef.current.desired?.loadKey === desired.loadKey,
      run: mount
    });
  }, [
    desired,
    environment.previewResourceScheduler,
    input.request.variantTarget?.mediaKind,
    input.request.variantTarget?.projectRelativePath,
    localFailure,
    pending,
    recordCounter,
    visible
  ]);

  const failLayer = useCallback((
    source: CanvasRasterPreviewLayerSource,
    stage: CanvasRasterPreviewFailure['stage'],
    error: unknown
  ) => {
    const latest = latestRef.current;
    if (latest.continuityKey !== source.continuityKey) {
      return;
    }
    const current = latest.state;
    if (current.pending?.loadKey !== source.loadKey
      && current.visible?.loadKey !== source.loadKey) {
      return;
    }
    recordCounter('raster-preview-failed', source, { stage });
    setState((current) => {
      const isPending = current.pending?.loadKey === source.loadKey;
      const isVisible = current.visible?.loadKey === source.loadKey;
      if (!isPending && !isVisible) {
        return current;
      }
      return {
        visible: isVisible ? undefined : current.visible,
        pending: isPending ? undefined : current.pending,
        failure: {
          continuityKey: source.continuityKey,
          loadKey: source.loadKey,
          stage,
          error
        }
      };
    });
  }, [recordCounter]);

  const promotePending = useCallback((source: CanvasRasterPreviewLayerSource) => {
    recordCounter('raster-preview-decoded', source);
    const promote = () => {
      const latest = latestRef.current;
      if (latest.continuityKey !== source.continuityKey
        || latest.desired?.loadKey !== source.loadKey) {
        return;
      }
      startTransition(() => {
        setState((current) => {
          if (current.pending?.loadKey !== source.loadKey) {
            return current;
          }
          return { visible: current.pending, pending: undefined, failure: undefined };
        });
      });
      recordCounter('raster-preview-published', source);
    };

    const latestVisible = latestRef.current.state.visible?.continuityKey === source.continuityKey
      ? latestRef.current.state.visible
      : undefined;
    if (!latestVisible) {
      promote();
      return;
    }
    environment.previewResourceScheduler.enqueuePublication({
      kind: input.request.variantTarget?.mediaKind ?? 'image',
      nodeId: input.request.variantTarget?.projectRelativePath ?? '',
      sourceKey: source.loadKey,
      targetWidth: source.previewWidth,
      isCurrent: () => latestRef.current.desired?.loadKey === source.loadKey,
      run: promote
    });
  }, [
    environment.previewResourceScheduler,
    input.request.variantTarget?.mediaKind,
    input.request.variantTarget?.projectRelativePath,
    recordCounter
  ]);

  useLayoutEffect(() => {
    if (!input.trackDomCommit || !visible) {
      setCommittedSourceKey(undefined);
      return;
    }
    if (committedSourceKey !== visible.sourceKey) {
      setCommittedSourceKey(visible.sourceKey);
    }
  }, [committedSourceKey, input.trackDomCommit, visible]);

  const retry = useCallback(() => {
    input.sourceFailure?.retry?.();
    recordCounter('raster-preview-retried', desired);
    setState((current) => ({ ...current, pending: undefined, failure: undefined }));
    setRetryAttempt((current) => current + 1);
  }, [desired, input.sourceFailure, recordCounter]);

  const failure = localFailure ?? input.sourceFailure;
  const status = visible
    ? 'visible'
    : failure
      ? 'failed'
      : pending || desired
        ? 'loading'
        : 'empty';

  return {
    layers: (
      <div
        className="canvas-raster-preview-layers"
        data-canvas-raster-preview-hidden={input.hidden ? 'true' : 'false'}
        aria-hidden={input.hidden}
      >
        {visible ? (
          <CanvasRasterPreviewImageLayer
            key={visible.loadKey}
            layer="visible"
            source={visible}
            fit={input.fit}
            onDecoded={promotePending}
            onFailure={failLayer}
            onPointerDown={input.onPointerDown}
          />
        ) : null}
        {pending ? (
          <CanvasRasterPreviewImageLayer
            key={pending.loadKey}
            layer="pending"
            source={pending}
            fit={input.fit}
            onDecoded={promotePending}
            onFailure={failLayer}
            onPointerDown={input.onPointerDown}
          />
        ) : null}
      </div>
    ),
    status,
    hasVisible: visible !== undefined,
    visibleSourceKey: visible?.sourceKey,
    committedSourceKey: committedSourceKey === visible?.sourceKey ? committedSourceKey : undefined,
    failure,
    retry
  };
}

function CanvasRasterPreviewImageLayer({
  layer,
  source,
  fit,
  onDecoded,
  onFailure,
  onPointerDown
}: {
  layer: 'visible' | 'pending';
  source: CanvasRasterPreviewLayerSource;
  fit: 'fill' | 'contain';
  onDecoded(source: CanvasRasterPreviewLayerSource): void;
  onFailure(
    source: CanvasRasterPreviewLayerSource,
    stage: CanvasRasterPreviewFailure['stage'],
    error: unknown
  ): void;
  onPointerDown?: React.PointerEventHandler<HTMLImageElement> | undefined;
}): React.ReactElement {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const decodePhaseRef = useRef<'idle' | 'decoding' | 'settled'>('idle');

  const decodePending = useCallback((image: HTMLImageElement) => {
    if (layer !== 'pending' || decodePhaseRef.current !== 'idle') {
      return;
    }
    decodePhaseRef.current = 'decoding';
    void image.decode().then(() => {
      if (decodePhaseRef.current !== 'decoding') {
        return;
      }
      decodePhaseRef.current = 'settled';
      if (!image.isConnected) {
        return;
      }
      onDecoded(source);
    }, (error: unknown) => {
      if (decodePhaseRef.current !== 'decoding') {
        return;
      }
      decodePhaseRef.current = 'settled';
      if (!image.isConnected) {
        return;
      }
      onFailure(source, 'decode', error);
    });
  }, [layer, onDecoded, onFailure, source]);

  useLayoutEffect(() => {
    if (layer !== 'pending') {
      return undefined;
    }
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth > 0) {
      decodePending(image);
    }
    return undefined;
  }, [decodePending, layer]);

  return (
    <img
      ref={imageRef}
      className="canvas-raster-preview-image"
      src={source.src}
      alt=""
      draggable={false}
      decoding="async"
      style={{ objectFit: fit }}
      data-canvas-raster-preview-layer={layer}
      data-canvas-raster-preview-kind={source.mediaKind}
      data-canvas-raster-preview-source-key={source.sourceKey}
      data-preview-width={source.previewWidth}
      onLoad={layer === 'pending'
        ? (event) => decodePending(event.currentTarget)
        : undefined}
      onError={(event) => onFailure(
        source,
        layer === 'pending' ? 'load' : 'visible',
        event.nativeEvent
      )}
      onPointerDown={layer === 'visible' ? onPointerDown : undefined}
    />
  );
}

function canvasRasterPreviewDesiredSource(input: {
  request: CanvasRasterPreviewRequest;
  nodeDisplayWidth: number;
  resourceZoom: number;
  devicePixelRatio: number;
  retryAttempt: number;
}): CanvasRasterPreviewLayerSource | undefined {
  const continuityKey = input.request.continuityKey;
  const target = input.request.variantTarget;
  if (!continuityKey || !target) {
    return undefined;
  }
  const previewWidth = canvasRasterPreviewWidth({
    nodeDisplayWidth: input.nodeDisplayWidth,
    sourceWidth: target.sourceWidth,
    resourceZoom: input.resourceZoom,
    devicePixelRatio: input.devicePixelRatio
  });
  const sourceKey = canvasPreviewVariantKey({
    mediaKind: target.mediaKind,
    bindingId: target.bindingId,
    projectRelativePath: target.projectRelativePath,
    targetIdentity: target.targetIdentity,
    width: previewWidth
  });
  return {
    mediaKind: target.mediaKind,
    continuityKey,
    sourceKey,
    loadKey: `${sourceKey}\u001f${input.retryAttempt}`,
    src: target.srcForWidth(previewWidth),
    previewWidth
  };
}
