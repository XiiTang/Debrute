import type {
  AddProjectPathToCanvasMapInput,
  AdobeBridgeStateView,
  DebruteGlobalSettingsView,
  DebruteProductState,
  CanvasTextPreviewSourceAvailabilityRequest,
  CanvasTextPreviewSourceAvailabilityResponse,
  CanvasVideoPreviewSourceRequest,
  CanvasVideoPreviewSourceResponse,
  GeneratedAssetView,
  GeneratedAssetMetadataLookup,
  IntegrationSettingsView,
  ProductUpdateApplyResult,
  RunIntegrationOperationInput,
  RunIntegrationOperationResult,
  SaveCanvasTextPreviewSourceInput,
  SaveCanvasTextPreviewSourceResult,
  SaveDebruteGlobalSettingsInput,
  SendProjectFileToPhotoshopInput,
  SendProjectFileToPhotoshopResult,
  UpdateCanvasTextViewportStateInput,
  UpdateCanvasVideoPlaybackStateInput,
  WorkbenchCanvasManagementResult,
  WorkbenchCanvasResetLayoutResult,
  WorkbenchProjectSessionSnapshot,
  WorkbenchProjectTextFile,
  WorkbenchProjectTextFileWriteResult,
  WorkbenchTitleBarState,
  WriteProjectTextFileInput
} from '@debrute/app-protocol';
import type {
  CanvasFeedbackDocument,
  UpdateCanvasFeedbackEntryInput
} from '@debrute/canvas-core';
import type { ProjectTreeSelectionState } from './workbench/project-explorer/projectTreeInteraction';
import type { WorkbenchResolvedTheme } from './workbench/services/workbenchTheme';

export type SettingsResource<T> =
  | { status: 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'error'; message: string };

export interface WorkbenchState {
  snapshot: WorkbenchProjectSessionSnapshot | undefined;
  projectId?: string | undefined;
  titleBarState: WorkbenchTitleBarState;
  globalSettings: SettingsResource<DebruteGlobalSettingsView>;
  resolvedTheme: WorkbenchResolvedTheme;
  projectOpen: ProjectOpenState;
  explorerSelection: ProjectTreeSelectionState;
  adobeBridge: SettingsResource<AdobeBridgeStateView>;
  canvasFeedback: CanvasFeedbackDocument | undefined;
  textFileBuffers: Record<string, TextFileBuffer>;
  textEditorWindows: Record<string, FloatingTextEditorWindowState>;
  notifications: string[];
}

export interface ProjectOpenState {
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
  getProductState: () => Promise<DebruteProductState>;
  checkProductUpdate: () => Promise<DebruteProductState>;
  applyProductUpdate: () => Promise<ProductUpdateApplyResult>;
  reloadGlobalSettings: () => Promise<void>;
  reloadAdobeBridge: () => Promise<void>;
  saveGlobalSettings: (input: SaveDebruteGlobalSettingsInput) => Promise<void>;
  rescanIntegrations: () => Promise<IntegrationSettingsView>;
  runIntegrationOperation: (input: RunIntegrationOperationInput) => Promise<RunIntegrationOperationResult>;
  linkAdobeBridgePhotoshop: (input: { adobeClientId: string }) => Promise<void>;
  unlinkAdobeBridgePhotoshop: (adobeClientId: string) => Promise<void>;
  sendProjectFileToPhotoshop: (input: SendProjectFileToPhotoshopInput) => Promise<SendProjectFileToPhotoshopResult>;
  openSendToPhotoshopPicker: (projectRelativePath: string) => void;
  lookupGeneratedAssetMetadata: (input: { projectRelativePath: string }) => Promise<GeneratedAssetMetadataLookup>;
  readGeneratedAsset: (assetId: string) => Promise<GeneratedAssetView>;
  readProjectTextFile: (projectRelativePath: string) => Promise<WorkbenchProjectTextFile>;
  writeProjectTextFile: (input: WriteProjectTextFileInput) => Promise<WorkbenchProjectTextFileWriteResult>;
  saveCanvasTextPreviewSource: (input: SaveCanvasTextPreviewSourceInput) => Promise<SaveCanvasTextPreviewSourceResult>;
  readCanvasTextPreviewSources: (input: CanvasTextPreviewSourceAvailabilityRequest) => Promise<CanvasTextPreviewSourceAvailabilityResponse>;
  readCanvasVideoPreviewSources: (input: CanvasVideoPreviewSourceRequest) => Promise<CanvasVideoPreviewSourceResponse>;
  ensureTextFileBuffer: (projectRelativePath: string) => Promise<void>;
  updateTextFileBuffer: (projectRelativePath: string, content: string) => void;
  saveTextFileBuffer: (projectRelativePath: string) => Promise<void>;
  discardTextFileBuffer: (projectRelativePath: string) => Promise<void>;
  reloadTextFileBuffer: (projectRelativePath: string) => Promise<void>;
  openTextEditorWindow: (projectRelativePath: string) => void;
  toggleTextFileWordWrap: (projectRelativePath: string) => void;
  updateCanvasNodeLayouts: (canvasId: string, input: {
    nodeLayouts?: Array<{ projectRelativePath: string; x: number; y: number; width?: number; height?: number }>;
  }) => Promise<void>;
  resetCanvasNodeLayouts: (canvasId: string, input: { all: true } | { pathRules: { paths?: string[]; globs?: string[] } }) => Promise<WorkbenchCanvasResetLayoutResult>;
  bringCanvasNodeToFront: (canvasId: string, input: {
    projectRelativePath: string;
  }) => Promise<void>;
  updateCanvasVideoPlaybackState: (canvasId: string, input: Omit<UpdateCanvasVideoPlaybackStateInput, 'canvasId'>) => Promise<void>;
  updateCanvasTextViewportState: (canvasId: string, input: Omit<UpdateCanvasTextViewportStateInput, 'canvasId'>) => Promise<void>;
  updateCanvasFeedbackEntry: (input: UpdateCanvasFeedbackEntryInput) => Promise<boolean>;
  addProjectPathToCanvasMap: (input: AddProjectPathToCanvasMapInput) => Promise<void>;
  createCanvas: () => Promise<WorkbenchCanvasManagementResult>;
  renameCanvas: (input: { canvasId: string; name: string }) => Promise<WorkbenchCanvasManagementResult>;
  deleteCanvas: (input: { canvasId: string }) => Promise<WorkbenchCanvasManagementResult>;
  reorderCanvases: (input: { canvasOrder: string[] }) => Promise<WorkbenchCanvasManagementResult>;
  repairCanvasIndex: () => Promise<WorkbenchCanvasManagementResult>;
  openProject: () => Promise<void>;
  openTerminalPanel: (cwdProjectRelativePath?: string) => void;
}

export type {
  WorkbenchEvent,
  WorkbenchApiClient
} from '@debrute/app-protocol';
import type { DebruteShellApi } from './api/shellApi';

declare global {
  interface Window {
    debruteShell?: DebruteShellApi;
  }
}
