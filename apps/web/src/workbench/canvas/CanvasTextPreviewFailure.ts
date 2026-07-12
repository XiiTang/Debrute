export type CanvasTextPreviewFailureStage =
  | 'snapshot_not_ready'
  | 'snapshot_invariant_violation'
  | 'source_availability_failed'
  | 'raster_failed'
  | 'source_upload_failed'
  | 'variant_failed'
  | 'preview_decode_failed';

export interface CanvasTextPreviewFailureFields {
  canvasId: string;
  projectRelativePath: string;
  fingerprint: string;
  snapshotWidth?: number | undefined;
  snapshotHeight?: number | undefined;
  snapshotBytes?: number | undefined;
  durationMs?: number | undefined;
}

const DEFAULT_MESSAGES: Record<CanvasTextPreviewFailureStage, string> = {
  snapshot_not_ready: 'Canvas text preview snapshot is not ready.',
  snapshot_invariant_violation: 'Canvas text preview snapshot is invalid.',
  source_availability_failed: 'Canvas text preview source availability check failed.',
  raster_failed: 'Canvas text preview raster failed.',
  source_upload_failed: 'Canvas text preview source upload failed.',
  variant_failed: 'Canvas text preview variant request failed.',
  preview_decode_failed: 'Canvas text preview variant decode failed.'
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
