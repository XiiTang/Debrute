import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import { canvasImageSourceUrl, type CanvasLoadedImage } from './canvasImagePreviews';
import { nodeRect } from './canvasVirtualization';
import type { CanvasCameraState } from './runtime/canvasCamera';
import type { CanvasRect } from './runtime/canvasGeometry';
import { expandCanvasRect, rectCenter, rectsIntersect } from './runtime/canvasGeometry';

export const CANVAS_IMAGE_NEAR_OVERSCAN_SCREEN_PX = 512;
export const CANVAS_IMAGE_LOAD_CONCURRENCY = 3;

export type CanvasImageLoadPriority = 0 | 1 | 2 | 3 | 4;

export type CanvasImageLoadingPlanReason =
  | 'viewport-empty'
  | 'viewport-upgrade'
  | 'overscan-empty'
  | 'overscan-upgrade'
  | 'deferred'
  | 'not-previewable'
  | 'unavailable';

export interface CanvasPendingImage {
  src: string;
  loadKey: string;
}

export interface CanvasImageLoadError {
  message: string;
  loadKey: string;
}

export type CanvasImageNodeRenderState =
  | { kind: 'not-eligible' }
  | { kind: 'placeholder'; retry?: () => void }
  | {
      kind: 'image';
      loaded?: CanvasLoadedImage;
      pending?: CanvasPendingImage;
      error?: CanvasImageLoadError;
      retry: () => void;
    };

export interface CanvasImageLoadingPlanInput {
  nodes: ProjectedCanvasNode[];
  visibleRect: CanvasRect;
  imageResourceZoom: number;
  devicePixelRatio: number;
  imagePreviewsEnabled: boolean;
  existingImages: ReadonlyMap<string, CanvasLoadedImage>;
  retryKeys: ReadonlyMap<string, number>;
}

export interface CanvasImageLoadingPlanItem {
  projectRelativePath: string;
  src: string;
  loadKey: string;
  priority: CanvasImageLoadPriority;
  distanceToVisibleCenter: number;
  eligible: boolean;
  reason: CanvasImageLoadingPlanReason;
}

export interface ActiveCanvasImageLoad {
  item: CanvasImageLoadingPlanItem;
}

export function createCanvasImageLoadingPlan(input: CanvasImageLoadingPlanInput): Map<string, CanvasImageLoadingPlanItem> {
  assertPositiveFinite(input.imageResourceZoom, 'Canvas image resource zoom must be a positive finite number.');
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

    const src = canvasImageSourceUrl({
      node,
      cameraZoom: input.imageResourceZoom,
      devicePixelRatio: input.devicePixelRatio,
      imagePreviewsEnabled: input.imagePreviewsEnabled
    });
    if (!src) {
      result.set(node.projectRelativePath, ineligibleItem(node, 'not-previewable'));
      continue;
    }

    const retryKey = input.retryKeys.get(node.projectRelativePath) ?? 0;
    const loadKey = `${src}:${retryKey}`;
    const loaded = input.existingImages.get(node.projectRelativePath);
    const bounds = nodeRect(node);
    const inVisible = rectsIntersect(input.visibleRect, bounds);
    const inNearOverscan = !inVisible && rectsIntersect(nearOverscanRect, bounds);
    const priority = priorityForNode({
      inVisible,
      inNearOverscan: input.imagePreviewsEnabled && inNearOverscan,
      hasLoadedImage: loaded !== undefined,
      upgradeNeeded: loaded !== undefined && loaded.loadKey !== loadKey
    });

    result.set(node.projectRelativePath, {
      projectRelativePath: node.projectRelativePath,
      src,
      loadKey,
      priority: priority.priority,
      distanceToVisibleCenter: pointDistance(visibleCenter, rectCenter(bounds)),
      eligible: true,
      reason: priority.reason
    });
  }

  return result;
}

export function selectCanvasImageLoadingCandidates(input: {
  plan: ReadonlyMap<string, CanvasImageLoadingPlanItem>;
  cameraState: CanvasCameraState;
  activeLoadKeys: ReadonlySet<string>;
}): CanvasImageLoadingPlanItem[] {
  return [...input.plan.values()]
    .filter((item) => item.eligible)
    .filter((item) => !input.activeLoadKeys.has(item.loadKey))
    .filter((item) => input.cameraState === 'moving' ? item.priority === 0 : item.priority <= 3)
    .sort((left, right) => (
      left.priority - right.priority
      || left.distanceToVisibleCenter - right.distanceToVisibleCenter
      || left.projectRelativePath.localeCompare(right.projectRelativePath)
    ));
}

export function isCanvasImageLoadResultCurrent(
  active: ActiveCanvasImageLoad,
  currentPlan: ReadonlyMap<string, CanvasImageLoadingPlanItem>
): boolean {
  const current = currentPlan.get(active.item.projectRelativePath);
  return current?.loadKey === active.item.loadKey;
}

function priorityForNode(input: {
  inVisible: boolean;
  inNearOverscan: boolean;
  hasLoadedImage: boolean;
  upgradeNeeded: boolean;
}): { priority: CanvasImageLoadPriority; reason: CanvasImageLoadingPlanReason } {
  if (input.inVisible && !input.hasLoadedImage) {
    return { priority: 0, reason: 'viewport-empty' };
  }
  if (input.inVisible && input.upgradeNeeded) {
    return { priority: 1, reason: 'viewport-upgrade' };
  }
  if (input.inNearOverscan && !input.hasLoadedImage) {
    return { priority: 2, reason: 'overscan-empty' };
  }
  if (input.inNearOverscan && input.upgradeNeeded) {
    return { priority: 3, reason: 'overscan-upgrade' };
  }
  return { priority: 4, reason: 'deferred' };
}

function ineligibleItem(
  node: ProjectedCanvasNode,
  reason: Extract<CanvasImageLoadingPlanReason, 'not-previewable' | 'unavailable'>
): CanvasImageLoadingPlanItem {
  return {
    projectRelativePath: node.projectRelativePath,
    src: '',
    loadKey: '',
    priority: 4,
    distanceToVisibleCenter: Number.POSITIVE_INFINITY,
    eligible: false,
    reason
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
