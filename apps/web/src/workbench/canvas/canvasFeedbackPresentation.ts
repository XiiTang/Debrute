import {
  AlertCircle,
  Check,
  CircleDot,
  Heart,
  Star,
  ThumbsDown,
  X,
  type LucideIcon
} from 'lucide-react';
import type { CanvasFeedbackMark } from '@debrute/canvas-core';
import type { WorkbenchTranslationKey } from '../i18n';

export type CanvasFeedbackFrameKind = CanvasFeedbackMark | 'comments' | 'regions';

export const CANVAS_FEEDBACK_MARK_PRESENTATION: Record<CanvasFeedbackMark, {
  labelKey: WorkbenchTranslationKey;
  Icon: LucideIcon;
}> = {
  like: { labelKey: 'canvas.feedback.like', Icon: Heart },
  dislike: { labelKey: 'canvas.feedback.dislike', Icon: ThumbsDown },
  check: { labelKey: 'canvas.feedback.check', Icon: Check },
  cross: { labelKey: 'canvas.feedback.cross', Icon: X },
  pending: { labelKey: 'canvas.feedback.pending', Icon: CircleDot },
  important: { labelKey: 'canvas.feedback.important', Icon: Star },
  needs_revision: { labelKey: 'canvas.feedback.needsRevision', Icon: AlertCircle }
};

export const CANVAS_FEEDBACK_FRAME_COLORS: Record<CanvasFeedbackFrameKind, string> = {
  like: '#22c55e',
  dislike: '#ef4444',
  check: '#14b8a6',
  cross: '#dc2626',
  pending: '#f59e0b',
  important: '#eab308',
  needs_revision: '#f97316',
  comments: '#3b82f6',
  regions: '#facc15'
};
