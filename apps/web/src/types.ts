import type {
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
  WorkbenchProjectFileBatchOperationResult,
  WorkbenchProjectFileOperationResult,
  WorkbenchProjectPathEntry,
  WorkbenchProjectSessionSnapshot,
  WorkbenchProjectTextFile
} from '@debrute/app-protocol';
import type {
  CanvasFeedbackDocument,
  CanvasNodeLayerPatch,
  UpdateCanvasFeedbackEntryInput
} from '@debrute/canvas-core';
import type { ProjectTreeSelectionState } from './workbench/project-explorer/projectTreeInteraction';

export interface WorkbenchState {
  snapshot: WorkbenchProjectSessionSnapshot | undefined;
  explorerSelection: ProjectTreeSelectionState;
  llmSettings: LlmProviderSettingsView | undefined;
  imageModelSettings: ImageModelSettingsView | undefined;
  videoModelSettings: VideoModelSettingsView | undefined;
  integrationsSettings: IntegrationSettingsView | undefined;
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
  saveLlmProviderSetting: (input: SaveLlmProviderSettingInput, providerId?: string) => Promise<void>;
  deleteLlmProviderSetting: (providerId: string) => Promise<void>;
  setDefaultLlmModelKey: (modelKey: string | null) => Promise<void>;
  discoverLlmProviderModels: (input: DiscoverLlmProviderModelsInput, providerId?: string) => Promise<DiscoverProviderModelsOutput>;
  saveImageModelSetting: (modelId: string, input: SaveImageModelSettingInput) => Promise<void>;
  saveVideoModelSetting: (modelId: string, input: SaveVideoModelSettingInput) => Promise<void>;
  rescanIntegrations: () => Promise<IntegrationSettingsView>;
  lookupGeneratedAssetMetadata: (input: { projectRelativePath: string }) => Promise<GeneratedAssetMetadataLookup>;
  readGeneratedAsset: (assetId: string) => Promise<GeneratedAssetView>;
  readProjectTextFile: (projectRelativePath: string) => Promise<WorkbenchProjectTextFile>;
  writeProjectTextFile: (projectRelativePath: string, content: string) => Promise<WorkbenchProjectTextFile>;
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
} from '@debrute/app-protocol';
import type { DebruteShellApi } from './api/shellApi';

declare global {
  interface Window {
    debruteShell?: DebruteShellApi;
  }
}
