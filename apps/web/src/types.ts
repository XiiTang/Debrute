import type {
  AddProjectPathToCanvasMapInput,
  AdobeBridgeStateView,
  DebruteProductState,
  ImageModelSettingsView,
  CanvasTextPreviewDescriptorRequest,
  CanvasTextPreviewDescriptorResponse,
  CanvasTextPreviewDescriptorView,
  CanvasTextPreviewReconcileRequest,
  GeneratedAssetView,
  GeneratedAssetMetadataLookup,
  ProductUpdateApplyResult,
  SaveAdobeBridgeSettingsInput,
  SaveCanvasTextPreviewSourceInput,
  SaveWorkbenchPreferencesInput,
  SaveImageModelSettingInput,
  SaveVideoModelSettingInput,
  SendProjectFileToPhotoshopInput,
  SendProjectFileToPhotoshopResult,
  IntegrationSettingsView,
  VideoModelSettingsView,
  WorkbenchCanvasManagementResult,
  WorkbenchCanvasResetLayoutResult,
  WorkbenchProjectFileBatchOperationResult,
  WorkbenchProjectFileOperationResult,
  WorkbenchProjectPathEntry,
  WorkbenchProjectSessionSnapshot,
  WorkbenchProjectTextFile,
  WorkbenchProjectTextFileWriteResult,
  WorkbenchPreferencesView,
  WorkbenchTitleBarState
} from '@debrute/app-protocol';
import type {
  CanvasFeedbackDocument,
  UpdateCanvasFeedbackEntryInput
} from '@debrute/canvas-core';
import type { ProjectTreeSelectionState } from './workbench/project-explorer/projectTreeInteraction';
import type { WorkbenchResolvedTheme } from './workbench/services/workbenchTheme';

export interface WorkbenchState {
  snapshot: WorkbenchProjectSessionSnapshot | undefined;
  projectId?: string | undefined;
  titleBarState: WorkbenchTitleBarState;
  workbenchPreferences: WorkbenchPreferencesView | undefined;
  resolvedTheme: WorkbenchResolvedTheme;
  projectOpen: ProjectOpenState;
  explorerSelection: ProjectTreeSelectionState;
  imageModelSettings: ImageModelSettingsView | undefined;
  videoModelSettings: VideoModelSettingsView | undefined;
  integrationsSettings: IntegrationSettingsView | undefined;
  adobeBridge: AdobeBridgeStateView | undefined;
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
  diskRevision?: string;
  lastSavedRevision?: string;
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
  saveWorkbenchPreferences: (input: SaveWorkbenchPreferencesInput) => Promise<void>;
  saveImageModelSetting: (modelId: string, input: SaveImageModelSettingInput) => Promise<void>;
  saveVideoModelSetting: (modelId: string, input: SaveVideoModelSettingInput) => Promise<void>;
  rescanIntegrations: () => Promise<IntegrationSettingsView>;
  saveAdobeBridgeSettings: (input: SaveAdobeBridgeSettingsInput) => Promise<void>;
  linkAdobeBridgePhotoshop: (input: { adobeClientId: string }) => Promise<void>;
  unlinkAdobeBridgePhotoshop: (adobeClientId: string) => Promise<void>;
  sendProjectFileToPhotoshop: (input: SendProjectFileToPhotoshopInput) => Promise<SendProjectFileToPhotoshopResult>;
  openSendToPhotoshopPicker: (projectRelativePath: string) => void;
  lookupGeneratedAssetMetadata: (input: { projectRelativePath: string }) => Promise<GeneratedAssetMetadataLookup>;
  readGeneratedAsset: (assetId: string) => Promise<GeneratedAssetView>;
  readProjectTextFile: (projectRelativePath: string) => Promise<WorkbenchProjectTextFile>;
  writeProjectTextFile: (projectRelativePath: string, content: string) => Promise<WorkbenchProjectTextFileWriteResult>;
  saveCanvasTextPreviewSource: (input: SaveCanvasTextPreviewSourceInput) => Promise<CanvasTextPreviewDescriptorView>;
  readCanvasTextPreviewDescriptors: (input: CanvasTextPreviewDescriptorRequest) => Promise<CanvasTextPreviewDescriptorResponse>;
  reconcileCanvasTextPreviews: (input: CanvasTextPreviewReconcileRequest) => Promise<CanvasTextPreviewDescriptorResponse>;
  createProjectFile: (input: { parentProjectRelativePath: string; name: string }) => Promise<WorkbenchProjectFileOperationResult>;
  createProjectDirectory: (input: { parentProjectRelativePath: string; name: string }) => Promise<WorkbenchProjectFileOperationResult>;
  renameProjectPath: (input: { projectRelativePath: string; name: string }) => Promise<WorkbenchProjectFileOperationResult>;
  copyProjectPaths: (input: { entries: WorkbenchProjectPathEntry[]; targetDirectoryProjectRelativePath: string }) => Promise<WorkbenchProjectFileBatchOperationResult>;
  moveProjectPaths: (input: { entries: WorkbenchProjectPathEntry[]; targetDirectoryProjectRelativePath: string; overwrite?: boolean }) => Promise<WorkbenchProjectFileBatchOperationResult>;
  copyProjectAbsolutePaths: (input: { entries: WorkbenchProjectPathEntry[] }) => Promise<{ paths: string[] }>;
  trashProjectPaths: (input: { entries: WorkbenchProjectPathEntry[] }) => Promise<WorkbenchProjectFileBatchOperationResult>;
  deleteProjectPathsPermanently: (input: { entries: WorkbenchProjectPathEntry[] }) => Promise<WorkbenchProjectFileBatchOperationResult>;
  revealProjectPathInSystemFileManager: (input: { projectRelativePath: string; kind: 'file' | 'directory' }) => Promise<{ ok: true }>;
  ensureTextFileBuffer: (projectRelativePath: string, diskRevision?: string) => Promise<void>;
  updateTextFileBuffer: (projectRelativePath: string, content: string) => void;
  saveTextFileBuffer: (projectRelativePath: string) => Promise<void>;
  reloadTextFileBuffer: (projectRelativePath: string) => Promise<void>;
  openTextEditorWindow: (projectRelativePath: string) => void;
  toggleTextFileWordWrap: (projectRelativePath: string) => void;
  updateCanvasNodeLayouts: (canvasId: string, input: {
    nodeLayouts?: Array<{ projectRelativePath: string; x: number; y: number; width?: number; height?: number }>;
  }) => Promise<void>;
  resetCanvasNodeLayouts: (canvasId: string, input: { all: true } | { pathRules: string[] }) => Promise<WorkbenchCanvasResetLayoutResult>;
  updateCanvasNodeLayers: (canvasId: string, input: {
    nodeProjectRelativePathsTopFirst?: string[];
  }) => Promise<void>;
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
