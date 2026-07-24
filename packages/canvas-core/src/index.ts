export { canvasRasterPreviewWidth } from './canvasRasterPreviews.js';

export type CanvasNodeKind = 'directory' | 'file';
export type CanvasMediaKind = 'image' | 'video' | 'audio' | 'text' | 'unknown';
type ProjectDiagnosticSeverity = 'error' | 'warning';

export interface ProjectDiagnostic {
  id: string;
  severity: ProjectDiagnosticSeverity;
  code: string;
  message: string;
  filePath?: string;
  line?: number;
  column?: number;
  entityId?: string;
}

interface CanvasAnnotation {
  id: string;
  text: string;
  x: number;
  y: number;
}

interface CanvasNodeElement {
  projectRelativePath: string;
  nodeKind: CanvasNodeKind;
  mediaKind?: CanvasMediaKind;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  layoutMode?: 'manual';
  videoPlayback?: CanvasVideoPlaybackState;
  textViewport?: CanvasTextViewportState;
}

type CanvasNodeAvailability =
  | {
      state: 'available';
      size: number;
      mimeType: string;
      fileUrl: string;
      canvasImagePreviewable?: boolean;
      canvasImagePreviewSourceWidth?: number;
      mtimeMs?: number;
      revision: string;
    }
  | {
      state: 'missing';
      message: string;
    }
  | {
      state: 'unreadable';
      message: string;
    };

export interface CanvasDocument {
  id: string;
  name: string;
  nodeElements: CanvasNodeElement[];
  annotations: CanvasAnnotation[];
  preferences: {
    showDiagnostics: boolean;
  };
}

interface CanvasStructureEdgeProjection {
  id: string;
  sourceProjectRelativePath: string;
  targetProjectRelativePath: string;
}

interface CanvasVideoPlaybackState {
  currentTimeSeconds: number;
}

export interface CanvasTextViewportState {
  scrollTop: number;
  scrollLeft: number;
}

interface CanvasVideoTextTrack {
  projectRelativePath: string;
  fileUrl?: string;
  revision: string;
  kind: 'subtitles' | 'captions' | 'chapters' | 'metadata';
  label: string;
  srclang?: string;
  default: boolean;
}

interface CanvasVideoPresentation {
  kind: 'video';
  width: number;
  height: number;
  durationSeconds?: number;
  textTracks: CanvasVideoTextTrack[];
}

export interface ProjectedCanvasNode extends CanvasNodeElement {
  availability: CanvasNodeAvailability;
  videoPresentation?: CanvasVideoPresentation;
}

export interface CanvasProjection {
  canvasId: string;
  nodes: ProjectedCanvasNode[];
  edges: CanvasStructureEdgeProjection[];
  diagnostics: ProjectDiagnostic[];
}

export const CANVAS_FEEDBACK_MARKS = [
  'like',
  'dislike',
  'check',
  'cross',
  'pending',
  'important',
  'needs_revision'
] as const;

export type CanvasFeedbackMark = typeof CANVAS_FEEDBACK_MARKS[number];

export type CanvasFeedbackGeometry =
  | { type: 'point'; x: number; y: number }
  | { type: 'rect'; x: number; y: number; width: number; height: number };

interface CanvasFeedbackMomentRef {
  label: string;
  currentTimeSeconds: number;
}

interface CanvasFeedbackItemBase {
  id: string;
  comment: string;
  createdAt: string;
  updatedAt: string;
}

interface CanvasFeedbackFileCommentItem extends CanvasFeedbackItemBase {
  kind: 'comment';
  scope: 'file';
}

interface CanvasFeedbackMomentCommentItem extends CanvasFeedbackItemBase {
  kind: 'comment';
  scope: 'moment';
  moment: CanvasFeedbackMomentRef;
}

interface CanvasFeedbackFileSpatialItem extends CanvasFeedbackItemBase {
  kind: 'pin' | 'region';
  scope: 'file';
  label: number;
  geometry: CanvasFeedbackGeometry;
}

interface CanvasFeedbackMomentSpatialItem extends CanvasFeedbackItemBase {
  kind: 'pin' | 'region';
  scope: 'moment';
  label: number;
  geometry: CanvasFeedbackGeometry;
  moment: CanvasFeedbackMomentRef;
}

type CanvasFeedbackCommentItem = CanvasFeedbackFileCommentItem | CanvasFeedbackMomentCommentItem;
export type CanvasFeedbackSpatialItem = CanvasFeedbackFileSpatialItem | CanvasFeedbackMomentSpatialItem;
export type CanvasFeedbackItem = CanvasFeedbackCommentItem | CanvasFeedbackSpatialItem;

export interface CanvasFeedbackEntry {
  projectRelativePath: string;
  marks: CanvasFeedbackMark[];
  nextMomentLabel: number;
  nextSpatialLabel: number;
  items: CanvasFeedbackItem[];
  updatedAt: string;
}

export interface CanvasFeedbackDocument {
  updatedAt: string;
  entries: Record<string, CanvasFeedbackEntry>;
}

export type UpdateCanvasFeedbackEntryInput =
  | {
      operation: 'set-marks';
      projectRelativePath: string;
      marks: CanvasFeedbackMark[];
    }
  | {
      operation: 'add-item';
      projectRelativePath: string;
      item:
        | { kind: 'comment'; scope: 'file'; comment: string }
        | { kind: 'comment'; scope: 'moment'; momentTimeSeconds: number; comment: string }
        | { kind: 'pin' | 'region'; scope: 'file'; geometry: CanvasFeedbackGeometry; comment: string }
        | { kind: 'pin' | 'region'; scope: 'moment'; momentTimeSeconds: number; geometry: CanvasFeedbackGeometry; comment: string };
    }
  | {
      operation: 'update-item';
      projectRelativePath: string;
      itemId: string;
      geometry?: CanvasFeedbackGeometry;
      comment?: string;
    }
  | {
      operation: 'delete-item';
      projectRelativePath: string;
      itemId: string;
    };

export function canvasNodeStackOrderTopFirst(canvas: Pick<CanvasDocument, 'nodeElements'>): string[] {
  return [...canvas.nodeElements]
    .sort((left, right) => {
      if (left.z !== right.z) {
        return right.z - left.z;
      }
      return right.projectRelativePath.localeCompare(left.projectRelativePath);
    })
    .map((nodeElement) => nodeElement.projectRelativePath);
}

export function normalizeCanvasVideoPlaybackTime(currentTimeSeconds: number): number {
  if (!Number.isFinite(currentTimeSeconds) || currentTimeSeconds < 0) {
    throw new Error('Canvas video playback time must be a non-negative finite number.');
  }
  return Math.round(currentTimeSeconds * 1000) / 1000;
}
