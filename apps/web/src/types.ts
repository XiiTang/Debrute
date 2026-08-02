import type {
  AddProjectPathToCanvasMapInput,
  CanvasTextPreviewSourceAvailabilityRequest,
  CanvasTextPreviewSourceAvailabilityResponse,
  CanvasVideoPreviewEnsureRequest,
  CanvasVideoPreviewEnsureResponse,
  CanvasVideoPreviewProbeRequest,
  CanvasVideoPreviewProbeResponse,
  GeneratedAssetMetadataLookup,
  PhotoshopStateView,
  SaveCanvasTextPreviewSourceInput,
  SaveCanvasTextPreviewSourceResult,
  UpdateCanvasTextViewportStateInput,
  UpdateCanvasVideoPlaybackStateInput,
  WorkbenchCanvasManagementResult,
  WorkbenchCanvasResetLayoutResult,
  WorkbenchProjectSessionSnapshot,
  WorkbenchProjectTextFile,
  WorkbenchProjectTextFileWriteResult,
  WriteProjectTextFileInput
} from '@debrute/app-protocol';
import type { CanvasFeedbackDocument } from '@debrute/canvas-core';
import type { ProjectTreeSelectionState } from './workbench/project-explorer/projectTreeInteraction';
import type { WorkbenchResolvedTheme } from './workbench/services/workbenchTheme';
import type { WorkbenchTitleBarState } from './workbench/shell/workbenchTitleBarState';

export type EventProjection<T> =
  | { status: 'loading' }
  | { status: 'ready'; value: T };

export type SettingsResource<T> =
  | EventProjection<T>
  | { status: 'error'; message: string };

export interface WorkbenchState {
  snapshot: WorkbenchProjectSessionSnapshot | undefined;
  projectId?: string | undefined;
  titleBarState: WorkbenchTitleBarState;
  resolvedTheme: WorkbenchResolvedTheme;
  projectOpen: ProjectOpenState;
  explorerSelection: ProjectTreeSelectionState;
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
  lookupGeneratedAssetMetadata: (input: { projectRelativePath: string }) => Promise<GeneratedAssetMetadataLookup>;
  readProjectTextFile: (projectRelativePath: string) => Promise<WorkbenchProjectTextFile>;
  writeProjectTextFile: (input: WriteProjectTextFileInput) => Promise<WorkbenchProjectTextFileWriteResult>;
  saveCanvasTextPreviewSource: (input: SaveCanvasTextPreviewSourceInput) => Promise<SaveCanvasTextPreviewSourceResult>;
  readCanvasTextPreviewSources: (input: CanvasTextPreviewSourceAvailabilityRequest) => Promise<CanvasTextPreviewSourceAvailabilityResponse>;
  probeCanvasVideoPreviewSources: (input: CanvasVideoPreviewProbeRequest, signal?: AbortSignal) => Promise<CanvasVideoPreviewProbeResponse>;
  ensureCanvasVideoPreviewSource: (input: CanvasVideoPreviewEnsureRequest, signal?: AbortSignal) => Promise<CanvasVideoPreviewEnsureResponse>;
  ensureTextFileBuffer: (projectRelativePath: string) => Promise<void>;
  updateTextFileBuffer: (projectRelativePath: string, content: string) => void;
  saveTextFileBuffer: (projectRelativePath: string) => Promise<void>;
  discardTextFileBuffer: (projectRelativePath: string) => Promise<void>;
  reloadTextFileBuffer: (projectRelativePath: string) => Promise<void>;
  openTextEditorWindow: (projectRelativePath: string) => void;
  toggleTextFileWordWrap: (projectRelativePath: string) => void;
  updateCanvasNodeLayouts: (canvasId: string, input: {
    interaction: 'move' | 'resize';
    nodeLayouts: Array<{ projectRelativePath: string; x: number; y: number; width: number; height: number }>;
  }) => Promise<void>;
  resetCanvasNodeLayouts: (canvasId: string, input: { all: true } | { nodePaths: string[] }) => Promise<WorkbenchCanvasResetLayoutResult>;
  updateCanvasVideoPlaybackState: (canvasId: string, input: Omit<UpdateCanvasVideoPlaybackStateInput, 'canvasId'>) => Promise<void>;
  updateCanvasTextViewportState: (canvasId: string, input: Omit<UpdateCanvasTextViewportStateInput, 'canvasId'>) => Promise<void>;
  addProjectPathToCanvasMap: (input: AddProjectPathToCanvasMapInput) => Promise<void>;
  createCanvas: () => Promise<WorkbenchCanvasManagementResult>;
  renameCanvas: (input: { canvasId: string; name: string }) => Promise<WorkbenchCanvasManagementResult>;
  deleteCanvas: (input: { canvasId: string }) => Promise<WorkbenchCanvasManagementResult>;
  reorderCanvases: (input: { canvasOrder: string[] }) => Promise<WorkbenchCanvasManagementResult>;
  repairCanvasIndex: () => Promise<WorkbenchCanvasManagementResult>;
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
