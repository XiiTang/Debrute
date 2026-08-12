import type {
  CanvasTextPreviewSourceAvailabilityRequest,
  CanvasTextPreviewSourceAvailabilityResponse,
  CanvasSourceResolutionRequest,
  CanvasSourceResolutionResponse,
  CanvasVideoPreviewSourceRequest,
  CanvasVideoPreviewSourceResponse,
  ModelArtifactProvenanceLookup,
  ProjectFileSourceResolution,
  ProjectPathInspection,
  PhotoshopStateView,
  SaveCanvasTextPreviewSourceInput,
  SaveCanvasTextPreviewSourceResult,
  SaveCanvasVideoPreviewSourceInput,
  SaveCanvasVideoPreviewSourceResult,
  WorkbenchProjectSessionSnapshot,
  WorkbenchProjectTextFile,
  WorkbenchProjectTextFileWriteResult,
  WriteProjectTextFileInput
} from '@debrute/app-protocol';
import type { CanvasFeedbackDocument } from '@debrute/app-protocol';
import type { CanvasProjection } from './workbench/canvas/CanvasScene';
import type { WorkbenchResolvedTheme } from './workbench/services/workbenchTheme';
import type { WorkbenchTitleBarState } from './workbench/shell/workbenchTitleBarState';

export type EventProjection<T> =
  | { status: 'loading' }
  | { status: 'ready'; value: T };

export interface WorkbenchState {
  snapshot: WorkbenchProjectSessionSnapshot | undefined;
  canvasProjection: CanvasProjection | undefined;
  bindingId?: string | undefined;
  canonicalRoot?: string | undefined;
  titleBarState: WorkbenchTitleBarState;
  resolvedTheme: WorkbenchResolvedTheme;
  projectOpen: ProjectOpenState;
  photoshop: EventProjection<PhotoshopStateView>;
  canvasFeedback: CanvasFeedbackDocument | undefined;
  textFileBuffers: Record<string, TextFileBuffer>;
  textEditorWindows: Record<string, FloatingTextEditorWindowState>;
}

interface ProjectOpenState {
  attemptedPath?: string;
  error?: string;
  opening: boolean;
}

export interface TextFileBuffer {
  projectRelativePath: string;
  content: string;
  language: WorkbenchProjectTextFile['language'];
  wordWrap: boolean;
  dirty: boolean;
  saving: boolean;
  baseRevision?: string;
  externalChange: boolean;
  error?: string;
}

export interface FloatingTextEditorWindowState {
  projectRelativePath: string;
  open: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WorkbenchActions {
  lookupModelArtifactProvenance: (
    input: { projectRelativePath: string },
    signal?: AbortSignal
  ) => Promise<ModelArtifactProvenanceLookup>;
  inspectProjectPath: (
    input: { projectRelativePath: string },
    signal?: AbortSignal
  ) => Promise<ProjectPathInspection>;
  resolveProjectFileSource: (
    input: { projectRelativePath: string; sourceToken: string },
    signal?: AbortSignal
  ) => Promise<ProjectFileSourceResolution>;
  readProjectTextFile: (projectRelativePath: string) => Promise<WorkbenchProjectTextFile>;
  resolveCanvasSources: (input: CanvasSourceResolutionRequest) => Promise<CanvasSourceResolutionResponse>;
  writeProjectTextFile: (input: WriteProjectTextFileInput) => Promise<WorkbenchProjectTextFileWriteResult>;
  saveCanvasTextPreviewSource: (input: SaveCanvasTextPreviewSourceInput) => Promise<SaveCanvasTextPreviewSourceResult>;
  readCanvasTextPreviewSources: (input: CanvasTextPreviewSourceAvailabilityRequest) => Promise<CanvasTextPreviewSourceAvailabilityResponse>;
  readCanvasVideoPreviewSources: (input: CanvasVideoPreviewSourceRequest, signal?: AbortSignal) => Promise<CanvasVideoPreviewSourceResponse>;
  saveCanvasVideoPreviewSource: (input: SaveCanvasVideoPreviewSourceInput, signal?: AbortSignal) => Promise<SaveCanvasVideoPreviewSourceResult>;
  ensureTextFileBuffer: (projectRelativePath: string) => Promise<void>;
  updateTextFileBuffer: (projectRelativePath: string, content: string) => void;
  saveTextFileBuffer: (projectRelativePath: string) => Promise<void>;
  discardTextFileBuffer: (projectRelativePath: string) => Promise<void>;
  reloadTextFileBuffer: (projectRelativePath: string) => Promise<void>;
  openTextEditorWindow: (projectRelativePath: string) => void;
  toggleTextFileWordWrap: (projectRelativePath: string) => void;
  updateCanvasNodeLayouts: (input: {
    selectedProjectRelativePaths: string[];
    nodeLayouts: Array<{ projectRelativePath: string; x: number; y: number; width: number; height: number }>;
  }) => Promise<void>;
  resetCanvasNodeLayouts: (input: { all: true } | { nodePaths: string[] }) => Promise<void>;
  updateCanvasVideoPlaybackState: (input: { updates: Array<{ projectRelativePath: string; currentTimeMs: number }> }) => Promise<void>;
  updateCanvasTextViewportState: (input: { updates: Array<{ projectRelativePath: string; scrollTop: number; scrollLeft: number }> }) => Promise<void>;
  setCanvasDirectoryExpanded: (input: { projectRelativePath: string; expanded: boolean }) => Promise<void>;
  raiseCanvasSelection: (input: { projectRelativePaths: string[] }) => Promise<void>;
  openProject: () => Promise<void>;
}

export type {
  WorkbenchApiClient
} from '@debrute/app-protocol';
import type { DebruteShellApi } from '@debrute/app-protocol';

declare global {
  interface Window {
    debruteShell?: DebruteShellApi;
  }
}
