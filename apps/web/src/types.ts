import type {
  CanvasSettingsView,
  ImageModelSettingsView,
  DiscoverLlmProviderModelsInput,
  DiscoverProviderModelsOutput,
  GeneratedAssetView,
  GeneratedAssetMetadataLookup,
  LlmProviderSettingsView,
  SaveImageModelSettingInput,
  SaveLlmProviderSettingInput,
  SaveVideoModelSettingInput,
  IntegrationSettingsView,
  VideoModelSettingsView,
  WorkbenchProjectFileOperationResult,
  WorkbenchProjectSessionSnapshot,
  WorkbenchProjectTextFile
} from '@axis/app-protocol';
import type {
  CanvasFeedbackDocument,
  CanvasNodeLayerPatch,
  UpdateCanvasFeedbackEntryInput
} from '@axis/canvas-core';

export interface WorkbenchState {
  snapshot: WorkbenchProjectSessionSnapshot | undefined;
  explorerSelection: string | undefined;
  llmSettings: LlmProviderSettingsView | undefined;
  imageModelSettings: ImageModelSettingsView | undefined;
  videoModelSettings: VideoModelSettingsView | undefined;
  integrationsSettings: IntegrationSettingsView | undefined;
  canvasSettings: CanvasSettingsView | undefined;
  canvasFeedback: CanvasFeedbackDocument | undefined;
  textFileBuffers: Record<string, TextFileBuffer>;
  textEditorWindows: Record<string, FloatingTextEditorWindowState>;
  notifications: string[];
}

export interface TextFileBuffer {
  projectRelativePath: string;
  content: string;
  language: WorkbenchProjectTextFile['language'] | string;
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
  selectExplorerPath: (projectRelativePath: string) => void;
  saveLlmProviderSetting: (input: SaveLlmProviderSettingInput, providerId?: string) => Promise<void>;
  deleteLlmProviderSetting: (providerId: string) => Promise<void>;
  setDefaultLlmModelKey: (modelKey: string | null) => Promise<void>;
  discoverLlmProviderModels: (input: DiscoverLlmProviderModelsInput, providerId?: string) => Promise<DiscoverProviderModelsOutput>;
  saveImageModelSetting: (modelId: string, input: SaveImageModelSettingInput) => Promise<void>;
  saveVideoModelSetting: (modelId: string, input: SaveVideoModelSettingInput) => Promise<void>;
  rescanIntegrations: () => Promise<IntegrationSettingsView>;
  saveCanvasSettings: (input: CanvasSettingsView) => Promise<void>;
  lookupGeneratedAssetMetadata: (input: { projectRelativePath: string }) => Promise<GeneratedAssetMetadataLookup>;
  readGeneratedAsset: (assetId: string) => Promise<GeneratedAssetView>;
  readProjectTextFile: (projectRelativePath: string) => Promise<WorkbenchProjectTextFile>;
  writeProjectTextFile: (projectRelativePath: string, content: string) => Promise<WorkbenchProjectTextFile>;
  createProjectFile: (input: { parentProjectRelativePath: string; name: string }) => Promise<WorkbenchProjectFileOperationResult>;
  createProjectDirectory: (input: { parentProjectRelativePath: string; name: string }) => Promise<WorkbenchProjectFileOperationResult>;
  renameProjectPath: (input: { projectRelativePath: string; name: string }) => Promise<WorkbenchProjectFileOperationResult>;
  copyProjectPath: (input: { sourceProjectRelativePath: string; targetDirectoryProjectRelativePath: string }) => Promise<WorkbenchProjectFileOperationResult>;
  moveProjectPath: (input: { sourceProjectRelativePath: string; targetDirectoryProjectRelativePath: string }) => Promise<WorkbenchProjectFileOperationResult>;
  trashProjectPath: (input: { projectRelativePath: string }) => Promise<{ projectRelativePath: string; snapshot: WorkbenchProjectSessionSnapshot }>;
  deleteProjectPathPermanently: (input: { projectRelativePath: string }) => Promise<WorkbenchProjectFileOperationResult>;
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
  updateCanvasNodeLayers: (canvasId: string, input: {
    nodeLayers?: CanvasNodeLayerPatch[];
    nodeProjectRelativePathsTopFirst?: string[];
  }) => Promise<void>;
  updateCanvasFeedbackEntry: (input: UpdateCanvasFeedbackEntryInput) => Promise<void>;
  openProject: () => Promise<void>;
}

export type {
  WorkbenchEvent,
  WorkbenchApiClient
} from '@axis/app-protocol';
import type { AxisShellApi } from './api/shellApi';

declare global {
  interface Window {
    axisShell?: AxisShellApi;
  }
}
