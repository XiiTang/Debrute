import type {
  CanvasFeedbackEntry,
  CanvasFeedbackGeometry,
  UpdateCanvasFeedbackEntryInput
} from '@debrute/canvas-core';
import type { CanvasLocalFeedbackDraft } from '../shell/floatingBars';

export interface PendingCanvasFeedbackItem {
  projectRelativePath: string;
  kind: 'comment' | 'pin' | 'region';
  scope: 'file' | 'moment';
  momentTimeSeconds?: number | undefined;
  geometry?: CanvasFeedbackGeometry | undefined;
  label?: number | string | undefined;
}

type CanvasFeedbackAddItemInput = Extract<
  UpdateCanvasFeedbackEntryInput,
  { operation: 'add-item' }
>['item'];

export function pendingCanvasFeedbackItemLabel(
  draft: CanvasLocalFeedbackDraft,
  entry: CanvasFeedbackEntry | undefined
): number | string | undefined {
  if (draft.kind === 'pin' || draft.kind === 'region') {
    return entry?.nextSpatialLabel ?? 1;
  }
  if (draft.scope === 'moment' && draft.momentTimeSeconds !== undefined) {
    for (const item of entry?.items ?? []) {
      if (item.scope === 'moment' && item.moment.currentTimeSeconds === draft.momentTimeSeconds) {
        return item.moment.label;
      }
    }
  }
  return undefined;
}

export function canvasFeedbackAddItemForPending(
  pending: PendingCanvasFeedbackItem,
  comment: string
): CanvasFeedbackAddItemInput | undefined {
  if (pending.scope === 'file') {
    if (pending.kind === 'comment') return { kind: 'comment', scope: 'file', comment };
    if (!pending.geometry) return undefined;
    return { kind: pending.kind, scope: 'file', geometry: pending.geometry, comment };
  }
  if (pending.momentTimeSeconds === undefined) return undefined;
  if (pending.kind === 'comment') {
    return {
      kind: 'comment',
      scope: 'moment',
      momentTimeSeconds: pending.momentTimeSeconds,
      comment
    };
  }
  if (!pending.geometry) return undefined;
  return {
    kind: pending.kind,
    scope: 'moment',
    momentTimeSeconds: pending.momentTimeSeconds,
    geometry: pending.geometry,
    comment
  };
}
