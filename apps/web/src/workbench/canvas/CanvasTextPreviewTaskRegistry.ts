import type { CanvasPreviewTargetKey } from '@debrute/canvas-core';
import {
  canvasTextPreviewTargetKey,
  type CanvasTextPreviewTarget
} from './CanvasTextPreviewCapture.js';

export const CANVAS_TEXT_PREVIEW_CONTENT_MAX_TARGETS = 10;
export const CANVAS_TEXT_PREVIEW_CONTENT_MAX_BYTES = 8 * 1024 * 1024;
export const CANVAS_TEXT_PREVIEW_CONTENT_MAX_CONCURRENT_READS = 2;

export type CanvasTextPreviewTaskState =
  | 'checking'
  | 'needs-content'
  | 'reading'
  | 'ready'
  | 'waiting-font'
  | 'capturing'
  | 'uploading'
  | 'waiting-projection'
  | 'failed';

export interface CanvasTextPreviewTask extends CanvasTextPreviewTarget {
  readonly attempt: object;
  readonly state: CanvasTextPreviewTaskState;
  readonly content?: string | undefined;
  readonly contentBytes?: number | undefined;
  readonly coverage?: Uint32Array | undefined;
}

interface CanvasTextPreviewAvailability {
  readonly targetKey: CanvasPreviewTargetKey;
  readonly available: boolean;
}

export function reconcileCanvasTextPreviewTasks(input: {
  readonly previous: ReadonlyMap<string, CanvasTextPreviewTask>;
  readonly targets: readonly CanvasTextPreviewTarget[];
  readonly sourceAvailability: Readonly<Record<string, CanvasTextPreviewAvailability>>;
}): Map<string, CanvasTextPreviewTask> {
  const next = new Map<string, CanvasTextPreviewTask>();
  const executing = canvasTextPreviewExecutingTask(input.previous);
  for (const target of input.targets) {
    const availability = input.sourceAvailability[target.projectRelativePath];
    const targetKey = canvasTextPreviewTargetKey(target);
    if (availability?.targetKey === targetKey && availability.available) {
      continue;
    }
    const existing = input.previous.get(target.projectRelativePath);
    if (executing && existing === executing) {
      next.set(target.projectRelativePath, existing);
      continue;
    }
    if (existing && canvasTextPreviewTargetKey(existing) === targetKey) {
      next.set(target.projectRelativePath, availability?.targetKey === targetKey
        && !availability.available
        && existing.state === 'checking'
        ? { ...existing, state: 'needs-content' }
        : existing);
      continue;
    }
    next.set(target.projectRelativePath, {
      ...target,
      attempt: {},
      state: availability?.targetKey === targetKey ? 'needs-content' : 'checking'
    });
  }
  if (executing && !next.has(executing.projectRelativePath)) {
    next.set(executing.projectRelativePath, executing);
  }
  return next;
}

export function canvasTextPreviewExecutingTask(
  tasks: ReadonlyMap<string, CanvasTextPreviewTask>
): CanvasTextPreviewTask | undefined {
  return [...tasks.values()].find((task) => (
    task.state === 'capturing' || task.state === 'uploading'
  ));
}

export function canvasTextPreviewContentWindow(input: {
  readonly orderedTasks: readonly CanvasTextPreviewTask[];
  readonly allocatedTasks: readonly CanvasTextPreviewTask[];
}): CanvasTextPreviewTask[] {
  let count = input.allocatedTasks.length;
  let bytes = input.allocatedTasks.reduce((sum, task) => sum + taskAllocatedBytes(task), 0);
  const selected: CanvasTextPreviewTask[] = [];
  for (const task of input.orderedTasks) {
    if (task.state !== 'needs-content' || count >= CANVAS_TEXT_PREVIEW_CONTENT_MAX_TARGETS) {
      continue;
    }
    const taskBytes = task.estimatedBytes;
    if (bytes + taskBytes > CANVAS_TEXT_PREVIEW_CONTENT_MAX_BYTES) {
      if (count === 0 && selected.length === 0) {
        return [task];
      }
      continue;
    }
    selected.push(task);
    count += 1;
    bytes += taskBytes;
  }
  return selected;
}

export function canvasTextPreviewTaskHoldsContent(task: CanvasTextPreviewTask): boolean {
  return task.state === 'reading'
    || task.state === 'ready'
    || task.state === 'waiting-font'
    || task.state === 'capturing';
}

function taskAllocatedBytes(task: CanvasTextPreviewTask): number {
  return task.contentBytes ?? task.estimatedBytes;
}
