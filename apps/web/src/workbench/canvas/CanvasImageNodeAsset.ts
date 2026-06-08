import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import { canvasImageSource, type CanvasLoadedImage } from './canvasImagePreviews';
import type { CanvasCameraState } from './runtime/canvasCamera';

export type CanvasPendingImage = CanvasLoadedImage;

export interface CanvasImageNodeAssetError {
  message: string;
  loadKey: string;
}

export type CanvasImageNodeRenderState =
  | { kind: 'not-eligible' }
  | { kind: 'placeholder'; retry: () => void }
  | {
      kind: 'image';
      visible?: CanvasLoadedImage | undefined;
      next?: CanvasPendingImage | undefined;
      error?: CanvasImageNodeAssetError | undefined;
      retry: () => void;
    };

export interface CanvasImageNodeAssetState {
  sourceRevisionKey: string | undefined;
  retryKey: number;
  loaded: CanvasLoadedImage | undefined;
  next: CanvasPendingImage | undefined;
  error: CanvasImageNodeAssetError | undefined;
}

export type CanvasImageNodeResolvedSource =
  | {
      kind: 'source';
      image: CanvasLoadedImage;
      sourceRevisionKey: string;
    }
  | {
      kind: 'not-eligible';
      reason: 'unavailable' | 'not-previewable';
      sourceRevisionKey: string | undefined;
    };

export type CanvasImageNodeAssetEvent =
  | {
      type: 'source-resolved';
      source: CanvasImageNodeResolvedSource;
      cameraState: CanvasCameraState;
      culled: boolean;
      prefetch?: boolean | undefined;
    }
  | { type: 'next-loaded'; loadKey: string }
  | { type: 'next-failed'; loadKey: string; message: string }
  | { type: 'retry' };

export function initialCanvasImageNodeAssetState(): CanvasImageNodeAssetState {
  return {
    sourceRevisionKey: undefined,
    retryKey: 0,
    loaded: undefined,
    next: undefined,
    error: undefined
  };
}

export function resolveCanvasImageNodeSource(input: {
  node: ProjectedCanvasNode;
  imageResourceZoom: number;
  devicePixelRatio: number;
  retryKey: number;
}): CanvasImageNodeResolvedSource {
  const sourceRevisionKey = sourceRevisionKeyForNode(input.node);
  if (input.node.availability.state !== 'available') {
    return { kind: 'not-eligible', reason: 'unavailable', sourceRevisionKey };
  }
  const availableSourceRevisionKey = `${input.node.projectRelativePath}\u001f${input.node.availability.revision}`;
  const source = canvasImageSource({
    node: input.node,
    cameraZoom: input.imageResourceZoom,
    devicePixelRatio: input.devicePixelRatio
  });
  if (!source) {
    return { kind: 'not-eligible', reason: 'not-previewable', sourceRevisionKey };
  }
  return {
    kind: 'source',
    sourceRevisionKey: availableSourceRevisionKey,
    image: {
      ...source,
      loadKey: `${source.src}:${input.retryKey}`
    }
  };
}

export function canvasImageNodeAssetReducer(
  state: CanvasImageNodeAssetState,
  event: CanvasImageNodeAssetEvent
): CanvasImageNodeAssetState {
  switch (event.type) {
    case 'retry':
      return {
        ...state,
        retryKey: state.retryKey + 1,
        next: undefined,
        error: undefined
      };
    case 'source-resolved':
      return reduceResolvedSource(state, event);
    case 'next-loaded':
      if (!state.next || state.next.loadKey !== event.loadKey) {
        return state;
      }
      return {
        ...state,
        loaded: state.next,
        next: undefined,
        error: undefined
      };
    case 'next-failed':
      if (!state.next || state.next.loadKey !== event.loadKey) {
        return state;
      }
      return {
        ...state,
        next: undefined,
        error: {
          loadKey: event.loadKey,
          message: event.message
        }
      };
  }
}

export function deriveCanvasImageNodeRenderState(input: {
  state: CanvasImageNodeAssetState;
  retry: () => void;
  notEligible?: boolean | undefined;
}): CanvasImageNodeRenderState {
  if (input.notEligible) {
    return { kind: 'not-eligible' };
  }
  if (!input.state.loaded && !input.state.next && !input.state.error) {
    return { kind: 'placeholder', retry: input.retry };
  }
  return {
    kind: 'image',
    ...(input.state.loaded ? { visible: input.state.loaded } : {}),
    ...(input.state.next ? { next: input.state.next } : {}),
    ...(input.state.error ? { error: input.state.error } : {}),
    retry: input.retry
  };
}

function reduceResolvedSource(
  state: CanvasImageNodeAssetState,
  event: Extract<CanvasImageNodeAssetEvent, { type: 'source-resolved' }>
): CanvasImageNodeAssetState {
  if (event.source.kind === 'not-eligible') {
    return {
      sourceRevisionKey: event.source.sourceRevisionKey,
      retryKey: state.retryKey,
      loaded: event.source.sourceRevisionKey === state.sourceRevisionKey ? state.loaded : undefined,
      next: undefined,
      error: undefined
    };
  }

  const revisionChanged = event.source.sourceRevisionKey !== state.sourceRevisionKey;
  const base: CanvasImageNodeAssetState = revisionChanged
    ? {
        sourceRevisionKey: event.source.sourceRevisionKey,
        retryKey: state.retryKey,
        loaded: undefined,
        next: undefined,
        error: undefined
      }
    : state;

  if (base.loaded?.loadKey === event.source.image.loadKey) {
    return {
      ...base,
      next: undefined,
      error: undefined
    };
  }

  const shouldSkipCulledWork = event.culled
    && !event.prefetch
    && (event.cameraState !== 'idle' || base.loaded !== undefined);
  if (shouldSkipCulledWork || (event.cameraState === 'moving' && base.loaded)) {
    return {
      ...base,
      next: undefined
    };
  }

  if (base.next?.loadKey === event.source.image.loadKey) {
    return base;
  }

  return {
    ...base,
    next: event.source.image,
    error: undefined
  };
}

function sourceRevisionKeyForNode(node: ProjectedCanvasNode): string | undefined {
  if (node.availability.state !== 'available') {
    return undefined;
  }
  return `${node.projectRelativePath}\u001f${node.availability.revision}`;
}
