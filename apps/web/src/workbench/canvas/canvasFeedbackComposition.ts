import type { CanvasFeedbackGeometry } from '@debrute/canvas-core';

export interface CanvasFeedbackComposition {
  itemId: string;
  createdAt: string;
  projectRelativePath: string;
  kind: 'comment' | 'pin' | 'region';
  scope: 'file' | 'moment';
  momentTimeSeconds?: number | undefined;
  geometry?: CanvasFeedbackGeometry | undefined;
}
