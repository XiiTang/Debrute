import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import { canvasImageSource, type CanvasLoadedImage } from './canvasImagePreviews';
import { nodeRect } from './canvasVirtualization';
import type { CanvasCameraState } from './runtime/canvasCamera';
import type { CanvasRect } from './runtime/canvasGeometry';
import { expandCanvasRect, rectCenter, rectsIntersect } from './runtime/canvasGeometry';

export const CANVAS_IMAGE_NEAR_OVERSCAN_SCREEN_PX = 512;
export const CANVAS_IMAGE_LOAD_CONCURRENCY = 3;

export type CanvasImageLoadingIntent =
  | 'display-critical'
  | 'downshift-visible'
  | 'evict-oversized'
  | 'prefetch-near'
  | 'upgrade-idle'
  | 'deferred'
  | 'not-previewable'
  | 'unavailable';

export type CanvasPendingImage = CanvasLoadedImage;

export interface CanvasImageLoadError {
  message: string;
  loadKey: string;
}

export type CanvasImageNodeRenderState =
  | { kind: 'not-eligible' }
  | { kind: 'placeholder'; retry?: () => void }
  | {
      kind: 'image';
      visible?: CanvasLoadedImage;
      next?: CanvasPendingImage;
      error?: CanvasImageLoadError;
      retry: () => void;
    };

export interface CanvasImageLoadingPlanInput {
  nodes: ProjectedCanvasNode[];
  visibleRect: CanvasRect;
  imageResourceZoom: number;
  retentionResourceZoom?: number | undefined;
  devicePixelRatio: number;
  existingImages: ReadonlyMap<string, CanvasLoadedImage>;
  retryKeys: ReadonlyMap<string, number>;
  culledNodePaths?: ReadonlySet<string> | undefined;
}

export interface CanvasImageLoadingPlanItem {
  projectRelativePath: string;
  src: string;
  loadKey: string;
  previewWidth: number;
  intent: CanvasImageLoadingIntent;
  distanceToVisibleCenter: number;
  eligible: boolean;
}

export interface ActiveCanvasImageLoad {
  item: CanvasImageLoadingPlanItem;
}

export function createCanvasImageLoadingPlan(input: CanvasImageLoadingPlanInput): Map<string, CanvasImageLoadingPlanItem> {
  assertPositiveFinite(input.imageResourceZoom, 'Canvas image resource zoom must be a positive finite number.');
  if (input.retentionResourceZoom !== undefined) {
    assertPositiveFinite(input.retentionResourceZoom, 'Canvas image retention resource zoom must be a positive finite number.');
  }
  assertPositiveFinite(input.devicePixelRatio, 'Canvas image devicePixelRatio must be a positive finite number.');

  const result = new Map<string, CanvasImageLoadingPlanItem>();
  const nearOverscanRect = expandCanvasRect(
    input.visibleRect,
    CANVAS_IMAGE_NEAR_OVERSCAN_SCREEN_PX / input.imageResourceZoom
  );
  const visibleCenter = rectCenter(input.visibleRect);

  for (const node of input.nodes) {
    if (node.nodeKind !== 'file' || node.mediaKind !== 'image') {
      continue;
    }

    if (node.visible === false || node.availability.state !== 'available') {
      result.set(node.projectRelativePath, ineligibleItem(node, 'unavailable'));
      continue;
    }

    const upgradeSource = canvasImageSource({
      node,
      cameraZoom: input.imageResourceZoom,
      devicePixelRatio: input.devicePixelRatio
    });
    if (!upgradeSource) {
      result.set(node.projectRelativePath, ineligibleItem(node, 'not-previewable'));
      continue;
    }

    const retentionSource = canvasImageSource({
      node,
      cameraZoom: input.retentionResourceZoom ?? input.imageResourceZoom,
      devicePixelRatio: input.devicePixelRatio
    });
    if (!retentionSource) {
      result.set(node.projectRelativePath, ineligibleItem(node, 'not-previewable'));
      continue;
    }
    const retryKey = input.retryKeys.get(node.projectRelativePath) ?? 0;
    const loaded = input.existingImages.get(node.projectRelativePath);
    const bounds = nodeRect(node);
    const inVisible = rectsIntersect(input.visibleRect, bounds);
    const inNearOverscan = !inVisible && rectsIntersect(nearOverscanRect, bounds);
    const isCulled = input.culledNodePaths?.has(node.projectRelativePath) === true;
    const oversized = loaded !== undefined && loaded.previewWidth > retentionSource.previewWidth;
    const intent = intentForNode({
      inVisible,
      inNearOverscan,
      isCulled,
      hasLoadedImage: loaded !== undefined,
      upgradeNeeded: loaded !== undefined && loaded.loadKey !== `${upgradeSource.src}:${retryKey}`,
      oversized
    });
    const selectedSource = intent === 'downshift-visible' || intent === 'evict-oversized'
      ? retentionSource
      : upgradeSource;
    const loadKey = `${selectedSource.src}:${retryKey}`;

    result.set(node.projectRelativePath, {
      projectRelativePath: node.projectRelativePath,
      src: selectedSource.src,
      loadKey,
      previewWidth: selectedSource.previewWidth,
      intent,
      distanceToVisibleCenter: pointDistance(visibleCenter, rectCenter(bounds)),
      eligible: true
    });
  }

  return result;
}

export function selectCanvasImageLoadingCandidates(input: {
  plan: ReadonlyMap<string, CanvasImageLoadingPlanItem>;
  cameraState: CanvasCameraState;
  activeLoadKeys: ReadonlySet<string>;
  movingPrefetchLimit?: number | undefined;
}): CanvasImageLoadingPlanItem[] {
  const candidates = [...input.plan.values()]
    .filter((item) => item.eligible)
    .filter((item) => !input.activeLoadKeys.has(item.loadKey))
    .filter((item) => item.intent !== 'deferred')
    .filter((item) => item.intent !== 'evict-oversized')
    .sort((left, right) => (
      intentSortOrder(left.intent) - intentSortOrder(right.intent)
      || left.distanceToVisibleCenter - right.distanceToVisibleCenter
      || left.projectRelativePath.localeCompare(right.projectRelativePath)
    ));
  if (input.cameraState !== 'moving') {
    return candidates;
  }
  const movingPrefetchLimit = Math.max(0, input.movingPrefetchLimit ?? 1);
  let prefetchCount = 0;
  return candidates.filter((item) => {
    if (item.intent === 'display-critical' || item.intent === 'downshift-visible') {
      return true;
    }
    if (item.intent !== 'prefetch-near') {
      return false;
    }
    if (prefetchCount >= movingPrefetchLimit) {
      return false;
    }
    prefetchCount += 1;
    return true;
  });
}

export function isCanvasImageLoadResultCurrent(
  active: ActiveCanvasImageLoad,
  currentPlan: ReadonlyMap<string, CanvasImageLoadingPlanItem>
): boolean {
  const current = currentPlan.get(active.item.projectRelativePath);
  return current?.loadKey === active.item.loadKey;
}

function intentForNode(input: {
  inVisible: boolean;
  inNearOverscan: boolean;
  isCulled: boolean;
  hasLoadedImage: boolean;
  upgradeNeeded: boolean;
  oversized: boolean;
}): CanvasImageLoadingIntent {
  if (input.inVisible && !input.hasLoadedImage) {
    return 'display-critical';
  }
  if (input.inVisible && input.oversized) {
    return 'downshift-visible';
  }
  if (!input.inVisible && input.oversized) {
    return 'evict-oversized';
  }
  if (input.inNearOverscan && !input.hasLoadedImage) {
    return 'prefetch-near';
  }
  if ((input.inVisible || input.inNearOverscan) && input.upgradeNeeded) {
    return 'upgrade-idle';
  }
  if (input.isCulled) {
    return 'deferred';
  }
  return 'deferred';
}

function intentSortOrder(intent: CanvasImageLoadingIntent): number {
  switch (intent) {
    case 'display-critical':
      return 0;
    case 'downshift-visible':
      return 1;
    case 'evict-oversized':
      return 2;
    case 'upgrade-idle':
      return 3;
    case 'prefetch-near':
      return 4;
    case 'deferred':
      return 5;
    case 'not-previewable':
    case 'unavailable':
      return 6;
  }
  const exhaustive: never = intent;
  return exhaustive;
}

function ineligibleItem(
  node: ProjectedCanvasNode,
  intent: Extract<CanvasImageLoadingIntent, 'not-previewable' | 'unavailable'>
): CanvasImageLoadingPlanItem {
  return {
    projectRelativePath: node.projectRelativePath,
    src: '',
    loadKey: '',
    previewWidth: 0,
    intent,
    distanceToVisibleCenter: Number.POSITIVE_INFINITY,
    eligible: false
  };
}

function pointDistance(left: { x: number; y: number }, right: { x: number; y: number }): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function assertPositiveFinite(value: number, message: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(message);
  }
}
