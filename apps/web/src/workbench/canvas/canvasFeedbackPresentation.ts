import {
  AlertCircle,
  Check,
  CircleDot,
  Heart,
  Star,
  ThumbsDown,
  X,
  type CutoutIcon
} from '../ui/index.js';
import type { CanvasFeedbackMark } from '@debrute/canvas-core';
import type { WorkbenchTranslationKey } from '../i18n';

export const CANVAS_FEEDBACK_MARK_PRESENTATION: Record<CanvasFeedbackMark, {
  labelKey: WorkbenchTranslationKey;
  Icon: CutoutIcon;
}> = {
  like: { labelKey: 'canvas.feedback.like', Icon: Heart },
  dislike: { labelKey: 'canvas.feedback.dislike', Icon: ThumbsDown },
  check: { labelKey: 'canvas.feedback.check', Icon: Check },
  cross: { labelKey: 'canvas.feedback.cross', Icon: X },
  pending: { labelKey: 'canvas.feedback.pending', Icon: CircleDot },
  important: { labelKey: 'canvas.feedback.important', Icon: Star },
  needs_revision: { labelKey: 'canvas.feedback.needsRevision', Icon: AlertCircle }
};
