export { canvasRasterPreviewWidth } from './canvasRasterPreviews.js';
export {
  canvasPreviewContinuityKey,
  type CanvasPreviewContinuityKey
} from './canvasPreviewContinuity.js';
export {
  canvasPreviewCanonicalSourceIdentity,
  canvasPreviewTargetIdentity,
  canvasPreviewTargetIdentityFromDigest,
  canvasPreviewTargetKey,
  canvasPreviewVariantIdentity,
  canvasPreviewVariantKey,
  type CanvasPreviewCanonicalSourceIdentity,
  type CanvasPreviewOwner,
  type CanvasPreviewTargetIdentity,
  type CanvasPreviewTargetKey,
  type CanvasPreviewVariantIdentity,
  type CanvasPreviewVariantKey
} from './canvasPreviewIdentities.js';

export type CanvasNodeKind = 'directory' | 'file';
export type CanvasMediaKind = 'image' | 'video' | 'audio' | 'text' | 'unknown';
export const PROJECT_TEXT_LANGUAGE_IDS = [
  'plaintext',
  'markdown',
  'json',
  'jsonc',
  'jsonl',
  'yaml',
  'shell',
  'dotenv',
  'ini',
  'properties',
  'log',
  'html',
  'css',
  'scss',
  'less',
  'xml',
  'javascript',
  'javascriptreact',
  'typescript',
  'typescriptreact',
  'python',
  'ruby',
  'php',
  'sql',
  'powershell',
  'bat',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'lua',
  'perl',
  'r',
  'dockerfile',
  'makefile',
  'diff',
  'csv',
  'tsv',
  'subtitle',
  'webvtt',
  'toml',
  'tex',
  'textile',
  'protobuf',
  'restructuredtext',
  'asciidoc',
  'org'
] as const;
export type ProjectTextLanguageId = typeof PROJECT_TEXT_LANGUAGE_IDS[number];
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
  currentTimeMs: number;
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
  textLanguage?: ProjectTextLanguageId;
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

interface CanvasFeedbackNodeCommentItem extends CanvasFeedbackItemBase {
  kind: 'comment';
  scope: 'node';
}

interface CanvasFeedbackMomentCommentItem extends CanvasFeedbackItemBase {
  kind: 'comment';
  scope: 'moment';
  moment: CanvasFeedbackMomentRef;
}

interface CanvasFeedbackNodeSpatialItem extends CanvasFeedbackItemBase {
  kind: 'pin' | 'region';
  scope: 'node';
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

type CanvasFeedbackCommentItem = CanvasFeedbackNodeCommentItem | CanvasFeedbackMomentCommentItem;
export type CanvasFeedbackSpatialItem = CanvasFeedbackNodeSpatialItem | CanvasFeedbackMomentSpatialItem;
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

export type UpdateCanvasFeedbackInput =
  | {
      operation: 'set-mark';
      projectRelativePaths: string[];
      mark: CanvasFeedbackMark;
      selected: boolean;
    }
  | {
      operation: 'add-item';
      projectRelativePath: string;
      item:
        | { id: string; createdAt: string; kind: 'comment'; scope: 'node'; comment: string }
        | { id: string; createdAt: string; kind: 'comment'; scope: 'moment'; momentTimeSeconds: number; comment: string }
        | { id: string; createdAt: string; kind: 'pin' | 'region'; scope: 'node'; geometry: CanvasFeedbackGeometry; comment: string }
        | { id: string; createdAt: string; kind: 'pin' | 'region'; scope: 'moment'; momentTimeSeconds: number; geometry: CanvasFeedbackGeometry; comment: string };
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

export function normalizeCanvasVideoPlaybackTimeMs(currentTimeMs: number): number {
  if (!Number.isSafeInteger(currentTimeMs) || currentTimeMs < 0) {
    throw new Error('Canvas video playback time must be a non-negative safe integer in milliseconds.');
  }
  return currentTimeMs;
}
