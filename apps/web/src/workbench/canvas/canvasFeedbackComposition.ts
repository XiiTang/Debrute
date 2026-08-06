import type { CanvasFeedbackGeometry } from '@debrute/app-protocol';

export interface CanvasFeedbackComposition {
  itemId: string;
  createdAt: string;
  projectRelativePath: string;
  kind: 'comment' | 'pin' | 'region';
  scope: 'node' | 'moment';
  momentTimeSeconds?: number | undefined;
  geometry?: CanvasFeedbackGeometry | undefined;
}
