export type CanvasTextPreviewFailureStage =
  | 'font_prepare_failed'
  | 'content_read_failed'
  | 'capture_not_ready'
  | 'dom_snapshot_failed'
  | 'source_availability_failed'
  | 'raster_failed'
  | 'source_upload_failed'
  | 'variant_failed';

export interface CanvasTextPreviewFailureFields {
  canvasId: string;
  projectRelativePath: string;
  targetIdentity: CanvasPreviewTargetIdentity;
  cssWidth?: number | undefined;
  cssHeight?: number | undefined;
  sourcePixelWidth?: number | undefined;
  sourcePixelHeight?: number | undefined;
  durationMs?: number | undefined;
}

export function canvasTextPreviewFailureFieldsForTarget(input: Pick<
  CanvasTextPreviewFailureFields,
  'canvasId' | 'projectRelativePath' | 'targetIdentity'
>): CanvasTextPreviewFailureFields {
  return {
    canvasId: input.canvasId,
    projectRelativePath: input.projectRelativePath,
    targetIdentity: input.targetIdentity
  };
}

const DEFAULT_MESSAGES: Record<CanvasTextPreviewFailureStage, string> = {
  font_prepare_failed: 'Canvas text preview font preparation failed.',
  content_read_failed: 'Canvas text preview content read failed.',
  capture_not_ready: 'Canvas text preview capture is not ready.',
  dom_snapshot_failed: 'Canvas text preview DOM snapshot failed.',
  source_availability_failed: 'Canvas text preview source availability check failed.',
  raster_failed: 'Canvas text preview raster failed.',
  source_upload_failed: 'Canvas text preview source upload failed.',
  variant_failed: 'Canvas text preview variant request failed.'
};

export class CanvasTextPreviewFailure extends Error {
  readonly name = 'CanvasTextPreviewFailure';

  constructor(
    readonly stage: CanvasTextPreviewFailureStage,
    readonly fields: CanvasTextPreviewFailureFields,
    message: string
  ) {
    super(message);
  }
}

export function canvasTextPreviewFailureFromUnknown(
  stage: CanvasTextPreviewFailureStage,
  fields: CanvasTextPreviewFailureFields,
  value: unknown
): CanvasTextPreviewFailure {
  if (value instanceof CanvasTextPreviewFailure) {
    return value;
  }
  if (value instanceof Error && value.message.trim() !== '') {
    return new CanvasTextPreviewFailure(stage, fields, value.message);
  }
  if (value instanceof Event) {
    return new CanvasTextPreviewFailure(
      stage,
      fields,
      `${DEFAULT_MESSAGES[stage].replace(/\.$/, '')} (browser event: ${value.type || 'unknown'}).`
    );
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return new CanvasTextPreviewFailure(stage, fields, value);
  }
  return new CanvasTextPreviewFailure(stage, fields, DEFAULT_MESSAGES[stage]);
}
import type { CanvasPreviewTargetIdentity } from '@debrute/canvas-core';
