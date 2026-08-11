import {
  canvasPreviewTargetIdentity,
  canvasPreviewTargetKey,
  type CanvasPreviewTargetIdentity,
  type CanvasPreviewTargetKey
} from '@debrute/canvas-core';

export const CANVAS_VIDEO_PREVIEW_READ_MAX_TARGETS = 10;

export interface CanvasVideoPreviewTarget {
  readonly bindingId: string;
  readonly projectRelativePath: string;
  readonly sourceRevision: string;
  readonly frameTimeMs: number;
  readonly sourceUrl: string;
}

export interface CanvasVideoPreviewFailure {
  readonly stage: 'read' | 'decode' | 'capture' | 'save';
  readonly message: string;
}

type CanvasVideoPreviewTaskState =
  | { readonly state: 'needs-read' }
  | { readonly state: 'reading' }
  | { readonly state: 'needs-capture' }
  | { readonly state: 'capturing' }
  | { readonly state: 'saving' }
  | { readonly state: 'failed'; readonly failure: CanvasVideoPreviewFailure };

export type CanvasVideoPreviewTask = CanvasVideoPreviewTarget & CanvasVideoPreviewTaskState;

export function canvasVideoPreviewTargetIdentity(
  target: Pick<CanvasVideoPreviewTarget, 'sourceRevision' | 'frameTimeMs'>
): CanvasPreviewTargetIdentity {
  return canvasPreviewTargetIdentity([
    target.sourceRevision,
    target.frameTimeMs
  ]);
}

export function canvasVideoPreviewTargetKey(target: CanvasVideoPreviewTarget): CanvasPreviewTargetKey {
  return canvasPreviewTargetKey({
    mediaKind: 'video',
    bindingId: target.bindingId,
    projectRelativePath: target.projectRelativePath,
    targetIdentity: canvasVideoPreviewTargetIdentity(target)
  });
}

export function reconcileCanvasVideoPreviewTasks(input: {
  readonly previous: ReadonlyMap<CanvasPreviewTargetKey, CanvasVideoPreviewTask>;
  readonly targets: readonly CanvasVideoPreviewTarget[];
  readonly readyTargetKeys: ReadonlySet<CanvasPreviewTargetKey>;
}): Map<CanvasPreviewTargetKey, CanvasVideoPreviewTask> {
  const next = new Map<CanvasPreviewTargetKey, CanvasVideoPreviewTask>();
  for (const target of input.targets) {
    const key = canvasVideoPreviewTargetKey(target);
    if (input.readyTargetKeys.has(key)) continue;
    const existing = input.previous.get(key);
    next.set(key, existing ?? { ...target, state: 'needs-read' });
  }
  return next;
}

export function canvasVideoPreviewReadWindow(
  orderedTasks: readonly CanvasVideoPreviewTask[]
): CanvasVideoPreviewTask[] {
  return orderedTasks
    .filter((task) => task.state === 'needs-read')
    .slice(0, CANVAS_VIDEO_PREVIEW_READ_MAX_TARGETS);
}

export function updateCanvasVideoPreviewTask(
  current: ReadonlyMap<CanvasPreviewTargetKey, CanvasVideoPreviewTask>,
  target: CanvasVideoPreviewTarget,
  update: CanvasVideoPreviewTaskState
): Map<CanvasPreviewTargetKey, CanvasVideoPreviewTask> {
  const key = canvasVideoPreviewTargetKey(target);
  if (!current.has(key)) return current as Map<CanvasPreviewTargetKey, CanvasVideoPreviewTask>;
  const next = new Map(current);
  next.set(key, { ...target, ...update } as CanvasVideoPreviewTask);
  return next;
}

export function removeCanvasVideoPreviewTask(
  current: ReadonlyMap<CanvasPreviewTargetKey, CanvasVideoPreviewTask>,
  target: CanvasVideoPreviewTarget
): Map<CanvasPreviewTargetKey, CanvasVideoPreviewTask> {
  const key = canvasVideoPreviewTargetKey(target);
  if (!current.has(key)) return current as Map<CanvasPreviewTargetKey, CanvasVideoPreviewTask>;
  const next = new Map(current);
  next.delete(key);
  return next;
}

export function retryCanvasVideoPreviewTask(
  current: ReadonlyMap<CanvasPreviewTargetKey, CanvasVideoPreviewTask>,
  target: CanvasVideoPreviewTarget
): Map<CanvasPreviewTargetKey, CanvasVideoPreviewTask> {
  const existing = current.get(canvasVideoPreviewTargetKey(target));
  return existing?.state === 'failed'
    ? updateCanvasVideoPreviewTask(current, target, { state: 'needs-read' })
    : current as Map<CanvasPreviewTargetKey, CanvasVideoPreviewTask>;
}
