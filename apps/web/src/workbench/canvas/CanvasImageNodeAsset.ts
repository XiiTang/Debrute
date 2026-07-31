import { canvasRasterPreviewWidth, type ProjectedCanvasNode } from '@debrute/canvas-core';
import { canvasImageSource, type CanvasLoadedImage } from './canvasImagePreviews';
import type { CanvasCameraState } from './runtime/canvasCamera';

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
      next?: CanvasLoadedImage | undefined;
      error?: CanvasImageNodeAssetError | undefined;
      retry: () => void;
    };

export interface CanvasImageNodeAssetState {
  sourceRevisionKey: string | undefined;
  retryKey: number;
  loaded: CanvasLoadedImage | undefined;
  next: CanvasLoadedImage | undefined;
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

export type CanvasImageNodeSourceRequest =
  | {
      kind: 'source';
      projectRelativePath: string;
      fileUrl: string;
      revision: string;
      sourceWidth: number;
      previewWidth: number;
      sourceRevisionKey: string;
    }
  | {
      kind: 'not-eligible';
      projectRelativePath: string;
      reason: 'unavailable' | 'not-previewable';
      sourceRevisionKey: string | undefined;
    };

export interface CanvasImageNodeSourceInput {
  projectRelativePath: ProjectedCanvasNode['projectRelativePath'];
  nodeKind: ProjectedCanvasNode['nodeKind'];
  mediaKind: ProjectedCanvasNode['mediaKind'];
  displayWidth: ProjectedCanvasNode['width'];
  availability: ProjectedCanvasNode['availability'];
}

export function canvasImageNodeSourceInputForNode(
  node: Pick<ProjectedCanvasNode, 'projectRelativePath' | 'nodeKind' | 'mediaKind' | 'width' | 'availability'>
): CanvasImageNodeSourceInput {
  return {
    projectRelativePath: node.projectRelativePath,
    nodeKind: node.nodeKind,
    mediaKind: node.mediaKind,
    displayWidth: node.width,
    availability: node.availability
  };
}

export type CanvasImageNodeAssetEvent =
  | {
      type: 'source-resolved';
      source: CanvasImageNodeResolvedSource;
      cameraState: CanvasCameraState;
      culled: boolean;
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

export function canvasImageNodeSourceRequest(input: {
  source: CanvasImageNodeSourceInput;
  resourceZoom: number;
  devicePixelRatio: number;
}): CanvasImageNodeSourceRequest {
  const sourceRevisionKey = sourceRevisionKeyForInput(input.source);
  if (input.source.availability.state !== 'available') {
    return {
      kind: 'not-eligible',
      projectRelativePath: input.source.projectRelativePath,
      reason: 'unavailable',
      sourceRevisionKey
    };
  }
  if (input.source.nodeKind !== 'file'
    || input.source.mediaKind !== 'image'
    || input.source.availability.canvasImagePreviewable !== true) {
    return {
      kind: 'not-eligible',
      projectRelativePath: input.source.projectRelativePath,
      reason: 'not-previewable',
      sourceRevisionKey
    };
  }
  const sourceWidth = input.source.availability.canvasImagePreviewSourceWidth;
  if (typeof sourceWidth !== 'number' || !Number.isFinite(sourceWidth) || sourceWidth <= 0) {
    throw new Error('Canvas previewable image nodes must include a positive finite source width.');
  }
  return {
    kind: 'source',
    projectRelativePath: input.source.projectRelativePath,
    fileUrl: input.source.availability.fileUrl,
    revision: input.source.availability.revision,
    sourceWidth,
    previewWidth: canvasRasterPreviewWidth({
      nodeDisplayWidth: input.source.displayWidth,
      sourceWidth,
      resourceZoom: input.resourceZoom,
      devicePixelRatio: input.devicePixelRatio
    }),
    sourceRevisionKey: `${input.source.projectRelativePath}\u001f${input.source.availability.revision}`
  };
}

export function resolveCanvasImageNodeSource(input: {
  request: CanvasImageNodeSourceRequest;
  retryKey: number;
}): CanvasImageNodeResolvedSource {
  if (input.request.kind === 'not-eligible') {
    return {
      kind: 'not-eligible',
      reason: input.request.reason,
      sourceRevisionKey: input.request.sourceRevisionKey
    };
  }
  const source = canvasImageSource({
    projectRelativePath: input.request.projectRelativePath,
    fileUrl: input.request.fileUrl,
    revision: input.request.revision,
    previewWidth: input.request.previewWidth
  });
  return {
    kind: 'source',
    sourceRevisionKey: input.request.sourceRevisionKey,
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

export function shouldPublishCanvasImageNodeSourceImmediately(input: {
  source: CanvasImageNodeResolvedSource;
  didResolveUrl: boolean;
  revisionChanged: boolean;
  retryRequested: boolean;
  hasLoadedImage: boolean;
  culled: boolean;
  becameVisibleAfterCull: boolean;
  dragActive: boolean;
  loadedLoadKey: string | undefined;
}): boolean {
  const sourceLoadKey = input.source.kind === 'source'
    ? input.source.image.loadKey
    : undefined;
  if (input.source.kind === 'not-eligible'
    || input.revisionChanged
    || input.retryRequested
    || input.loadedLoadKey === sourceLoadKey) {
    return true;
  }
  if (input.culled || input.becameVisibleAfterCull || input.dragActive) {
    return false;
  }
  return !input.didResolveUrl || !input.hasLoadedImage;
}

function reduceResolvedSource(
  state: CanvasImageNodeAssetState,
  event: Extract<CanvasImageNodeAssetEvent, { type: 'source-resolved' }>
): CanvasImageNodeAssetState {
  if (event.source.kind === 'not-eligible') {
    if (event.source.sourceRevisionKey === state.sourceRevisionKey
      && state.next === undefined
      && state.error === undefined) {
      return state;
    }
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
    if (!base.next && !base.error) {
      return base;
    }
    return {
      ...base,
      next: undefined,
      error: undefined
    };
  }

  if (event.culled || (event.cameraState === 'moving' && base.loaded)) {
    if (!base.next) {
      return base;
    }
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

function sourceRevisionKeyForInput(input: CanvasImageNodeSourceInput): string | undefined {
  if (input.availability.state !== 'available') {
    return undefined;
  }
  return `${input.projectRelativePath}\u001f${input.availability.revision}`;
}
