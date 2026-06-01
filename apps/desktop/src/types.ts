import type {
  AxisCliStatus,
  CanvasSettingsView,
  DesktopUpdateState,
  DesktopWorkbenchApiClient,
  ImageModelSettingsView,
  DiscoverLlmProviderModelsInput,
  DiscoverProviderModelsOutput,
  GeneratedAssetMetadataLookup,
  LlmProviderSettingsView,
  ProjectTextFile,
  ProjectSessionSnapshot,
  SaveImageModelSettingInput,
  SaveLlmProviderSettingInput,
  SaveVideoModelSettingInput,
  IntegrationSettingsView,
  ProjectFileOperationResult,
  VideoModelSettingsView
} from '@axis/app-protocol';
import type {
  CanvasFeedbackDocument,
  CanvasNodeLayerPatch,
  CanvasSelection,
  CanvasViewport,
  UpdateCanvasFeedbackEntryInput
} from '@axis/canvas-core';

export interface WorkbenchState {
  snapshot: ProjectSessionSnapshot | undefined;
  selection: CanvasSelection | undefined;
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
  updateState: DesktopUpdateState | undefined;
  axisCliStatus: AxisCliStatus | undefined;
  setupCompleted: boolean;
}

export interface TextFileBuffer {
  projectRelativePath: string;
  content: string;
  language: ProjectTextFile['language'] | string;
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
  selectCanvasEntity: (selection: CanvasSelection | undefined) => void;
  saveLlmProviderSetting: (input: SaveLlmProviderSettingInput, providerId?: string) => Promise<void>;
  deleteLlmProviderSetting: (providerId: string) => Promise<void>;
  setDefaultLlmModelKey: (modelKey: string | null) => Promise<void>;
  discoverLlmProviderModels: (input: DiscoverLlmProviderModelsInput, providerId?: string) => Promise<DiscoverProviderModelsOutput>;
  saveImageModelSetting: (modelId: string, input: SaveImageModelSettingInput) => Promise<void>;
  saveVideoModelSetting: (modelId: string, input: SaveVideoModelSettingInput) => Promise<void>;
  refreshIntegrationsStatus: () => Promise<IntegrationSettingsView>;
  rescanIntegrations: () => Promise<IntegrationSettingsView>;
  saveCanvasSettings: (input: CanvasSettingsView) => Promise<void>;
  lookupGeneratedAssetMetadata: (input: { projectRelativePath: string }) => Promise<GeneratedAssetMetadataLookup>;
  readProjectTextFile: (projectRelativePath: string) => Promise<ProjectTextFile>;
  writeProjectTextFile: (projectRelativePath: string, content: string) => Promise<ProjectTextFile>;
  resolveProjectAbsolutePath: (projectRelativePath: string) => Promise<string>;
  createProjectFile: (input: { parentProjectRelativePath: string; name: string }) => Promise<ProjectFileOperationResult>;
  createProjectDirectory: (input: { parentProjectRelativePath: string; name: string }) => Promise<ProjectFileOperationResult>;
  renameProjectPath: (input: { projectRelativePath: string; name: string }) => Promise<ProjectFileOperationResult>;
  copyProjectPath: (input: { sourceProjectRelativePath: string; targetDirectoryProjectRelativePath: string }) => Promise<ProjectFileOperationResult>;
  moveProjectPath: (input: { sourceProjectRelativePath: string; targetDirectoryProjectRelativePath: string }) => Promise<ProjectFileOperationResult>;
  trashProjectPath: (input: { projectRelativePath: string }) => Promise<{ projectRelativePath: string; snapshot: ProjectSessionSnapshot }>;
  deleteProjectPathPermanently: (input: { projectRelativePath: string }) => Promise<ProjectFileOperationResult | undefined>;
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
  updateCanvasViewport: (canvasId: string, viewport: CanvasViewport) => Promise<void>;
  updateCanvasFeedbackEntry: (input: UpdateCanvasFeedbackEntryInput) => Promise<void>;
  openProject: () => Promise<void>;
  updateNow: () => Promise<void>;
  refreshAxisCliStatus: () => Promise<AxisCliStatus>;
  installAxisCli: () => Promise<AxisCliStatus>;
  updateAxisCli: () => Promise<AxisCliStatus>;
  repairAxisCli: () => Promise<AxisCliStatus>;
  uninstallAxisCli: () => Promise<AxisCliStatus>;
  refreshAxisCliDevelopmentLink: () => Promise<AxisCliStatus>;
  completeSetup: () => Promise<void>;
}

export type {
  DesktopEvent,
  DesktopHotExitSnapshot,
  DesktopHotExitTextBuffer,
  DesktopHotExitTextEditorWindow,
  DesktopState,
  DesktopUpdateState,
  DesktopWorkbenchApiClient,
  WorkbenchApiClient
} from '@axis/app-protocol';

declare global {
  interface Window {
    axisDesktop?: DesktopWorkbenchApiClient;
  }
}
