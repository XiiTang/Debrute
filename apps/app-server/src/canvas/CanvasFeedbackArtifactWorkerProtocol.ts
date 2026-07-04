import type {
  CanvasFeedbackEntry,
  CanvasFeedbackMomentRef
} from '@debrute/canvas-core';

export type CanvasFeedbackArtifact =
  | {
      readonly kind: 'image';
      readonly projectRelativePath: string;
      readonly entry: CanvasFeedbackEntry;
    }
  | {
      readonly kind: 'video-moment';
      readonly projectRelativePath: string;
      readonly moment: CanvasFeedbackMomentRef;
      readonly entry: CanvasFeedbackEntry;
    };

export interface CanvasFeedbackRenderJobInput {
  readonly jobId: string;
  readonly projectRoot: string;
  readonly artifact: CanvasFeedbackArtifact;
  readonly outputPath: string;
}

export interface CanvasFeedbackRenderJobSuccess {
  readonly ok: true;
  readonly jobId: string;
  readonly outputPath: string;
  readonly width: number;
  readonly height: number;
}

export interface CanvasFeedbackRenderJobFailure {
  readonly ok: false;
  readonly jobId: string;
  readonly message: string;
}

export type CanvasFeedbackRenderJobResult =
  | CanvasFeedbackRenderJobSuccess
  | CanvasFeedbackRenderJobFailure;
