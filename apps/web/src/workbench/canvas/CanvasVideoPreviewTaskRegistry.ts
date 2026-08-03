import {
  canvasPreviewTargetIdentity,
  canvasPreviewTargetKey,
  type CanvasPreviewCanonicalSourceIdentity,
  type CanvasPreviewTargetIdentity,
  type CanvasPreviewTargetKey
} from '@debrute/canvas-core';

export const CANVAS_VIDEO_PREVIEW_PROBE_MAX_TARGETS = 10;

export interface CanvasVideoPreviewTarget {
  readonly projectId: string;
  readonly canvasId: string;
  readonly projectRelativePath: string;
  readonly sourceRevision: string;
  readonly frameTimeMs: number;
}

export interface CanvasVideoPreviewFailure {
  readonly stage: 'probe' | 'ensure';
  readonly message: string;
}

type CanvasVideoPreviewTaskState =
  | { readonly state: 'needs-probe' }
  | { readonly state: 'probing' }
  | {
      readonly state: 'needs-source';
      readonly canonicalSourceIdentity: CanvasPreviewCanonicalSourceIdentity;
    }
  | {
      readonly state: 'ensuring';
      readonly canonicalSourceIdentity: CanvasPreviewCanonicalSourceIdentity;
    }
  | { readonly state: 'failed'; readonly failure: CanvasVideoPreviewFailure };

export type CanvasVideoPreviewTask = CanvasVideoPreviewTarget & CanvasVideoPreviewTaskState;

export type CanvasVideoPreviewTaskUpdate = CanvasVideoPreviewTaskState;

export function canvasVideoPreviewTargetIdentity(
  target: Pick<CanvasVideoPreviewTarget, 'sourceRevision' | 'frameTimeMs'>
): CanvasPreviewTargetIdentity {
  return canvasPreviewTargetIdentity([
    'video',
    target.sourceRevision,
    target.frameTimeMs
  ]);
}

export function canvasVideoPreviewTargetKey(target: CanvasVideoPreviewTarget): CanvasPreviewTargetKey {
  return canvasPreviewTargetKey({
    mediaKind: 'video',
    projectId: target.projectId,
    canvasId: target.canvasId,
    projectRelativePath: target.projectRelativePath,
    targetIdentity: canvasVideoPreviewTargetIdentity(target)
  });
}

export function reconcileCanvasVideoPreviewTasks(input: {
  readonly previous: ReadonlyMap<string, CanvasVideoPreviewTask>;
  readonly targets: readonly CanvasVideoPreviewTarget[];
  readonly readyTargetKeys: ReadonlySet<CanvasPreviewTargetKey>;
}): Map<string, CanvasVideoPreviewTask> {
  const next = new Map<string, CanvasVideoPreviewTask>();
  for (const target of input.targets) {
    const targetKey = canvasVideoPreviewTargetKey(target);
    if (input.readyTargetKeys.has(targetKey)) {
      continue;
    }
    const existing = input.previous.get(target.projectRelativePath);
    next.set(target.projectRelativePath, existing
      && canvasVideoPreviewTargetKey(existing) === targetKey
      ? existing
      : { ...target, state: 'needs-probe' });
  }
  return next;
}

export function canvasVideoPreviewProbeWindow(
  orderedTasks: readonly CanvasVideoPreviewTask[]
): CanvasVideoPreviewTask[] {
  return orderedTasks
    .filter((task) => task.state === 'needs-probe')
    .slice(0, CANVAS_VIDEO_PREVIEW_PROBE_MAX_TARGETS);
}

export function updateCanvasVideoPreviewTask(
  current: Map<string, CanvasVideoPreviewTask>,
  target: CanvasVideoPreviewTarget,
  update: CanvasVideoPreviewTaskUpdate
): Map<string, CanvasVideoPreviewTask> {
  const existing = current.get(target.projectRelativePath);
  if (!existing || canvasVideoPreviewTargetKey(existing) !== canvasVideoPreviewTargetKey(target)) {
    return current;
  }
  const next = new Map(current);
  next.set(target.projectRelativePath, { ...target, ...update } as CanvasVideoPreviewTask);
  return next;
}

export function removeCanvasVideoPreviewTask(
  current: Map<string, CanvasVideoPreviewTask>,
  target: CanvasVideoPreviewTarget
): Map<string, CanvasVideoPreviewTask> {
  const existing = current.get(target.projectRelativePath);
  if (!existing || canvasVideoPreviewTargetKey(existing) !== canvasVideoPreviewTargetKey(target)) {
    return current;
  }
  const next = new Map(current);
  next.delete(target.projectRelativePath);
  return next;
}

export function retryCanvasVideoPreviewTask(
  current: Map<string, CanvasVideoPreviewTask>,
  target: CanvasVideoPreviewTarget
): Map<string, CanvasVideoPreviewTask> {
  const existing = current.get(target.projectRelativePath);
  if (!existing
    || existing.state !== 'failed'
    || canvasVideoPreviewTargetKey(existing) !== canvasVideoPreviewTargetKey(target)) {
    return current;
  }
  return updateCanvasVideoPreviewTask(current, target, { state: 'needs-probe' });
}
