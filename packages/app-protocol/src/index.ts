import type {
  CanvasDocument,
  CanvasFeedbackDocument,
  CanvasNodeLayerPatch,
  CanvasProjection,
  CanvasSelection,
  CanvasViewport,
  Diagnostic,
  UpdateCanvasFeedbackEntryInput
} from '@axis/canvas-core';
import type {
  AxisProjectMetadata,
  NormalizedFileWatchEvent,
  ProjectFileEntry,
  ProjectPathOperationResult,
  ProjectTextFile
} from '@axis/project-core';

export type { ProjectTextFile } from '@axis/project-core';

export const APP_PROTOCOL_SCHEMA_VERSION = 1;

export interface ProjectHealthSummary {
  projectName: string;
  canvasCount: number;
  diagnosticCounts: {
    errors: number;
    warnings: number;
    infos: number;
  };
  runtimeDataLocation: string;
  checkedAt: string;
}

export interface ProjectSessionSnapshot {
  projectRoot: string;
  metadata: AxisProjectMetadata;
  files: ProjectFileEntry[];
  canvases: CanvasDocument[];
  projections: CanvasProjection[];
  diagnostics: Diagnostic[];
  health: ProjectHealthSummary;
}

export interface ProjectFileOperationResult extends ProjectPathOperationResult {
  snapshot: ProjectSessionSnapshot;
}

export type CanvasSettingsView = {
  imagePreviewsEnabled: boolean;
};

export type LlmProviderType = 'openai_compat' | 'anthropic';

export interface LlmProviderConfig {
  id: string;
  name: string;
  providerType: LlmProviderType;
  baseUrl: string;
  enabled: boolean;
  modelIds: string[];
}

export interface LlmProviderSettingRecord extends LlmProviderConfig {
  apiKeySet: boolean;
  modelKeys: string[];
}

export interface LlmProviderSettingsView {
  providers: LlmProviderSettingRecord[];
  availableModelKeys: string[];
  defaultModelKey: string | null;
}

export interface SaveLlmProviderSettingInput extends LlmProviderConfig {
  apiKey?: string;
}

export interface DiscoverLlmProviderModelsInput {
  id?: string;
  providerType: LlmProviderType;
  baseUrl: string;
  apiKey?: string;
  modelsPath?: string;
  timeoutMs?: number;
}

export interface DiscoverProviderModelsOutput {
  endpoint: string;
  models: string[];
  modelsCount: number;
  supportsDiscovery: boolean;
}

export interface ImageModelSettingRecord {
  axisModelId: string;
  provider: string;
  summary: string;
  supportsEditing: boolean;
  supportsTextRendering: boolean;
  defaultBaseUrl: string;
  defaultProviderModelId: string;
  baseUrlOverride: string | null;
  providerModelIdOverride: string | null;
  apiKeySet: boolean;
}

export interface ImageModelSettingsView {
  models: ImageModelSettingRecord[];
}

export interface SaveImageModelSettingInput {
  baseUrlOverride: string | null;
  providerModelIdOverride: string | null;
  apiKey?: string;
}

export interface VideoModelSettingRecord {
  axisModelId: string;
  provider: string;
  summary: string;
  supportsTextToVideo: boolean;
  supportsImageReferences: boolean;
  supportsVideoReferences: boolean;
  supportsAudioReferences: boolean;
  supportsGeneratedAudio: boolean;
  defaultBaseUrl: string;
  defaultProviderModelId: string;
  baseUrlOverride: string | null;
  providerModelIdOverride: string | null;
  apiKeySet: boolean;
}

export interface VideoModelSettingsView {
  models: VideoModelSettingRecord[];
}

export interface SaveVideoModelSettingInput {
  baseUrlOverride: string | null;
  providerModelIdOverride: string | null;
  apiKey?: string;
}

export interface RunImageModelBatchInput {
  source: ImageModelBatchSource;
  concurrency: number;
  retries: number;
  timeoutMs?: number;
  logPath: string;
  summaryPath?: string;
}

export type ImageModelBatchSource =
  | { kind: 'manifest'; path: string }
  | { kind: 'jsonl'; path: string }
  | { kind: 'requests'; requests: ImageModelBatchRequest[] };

export interface ImageModelBatchRequest {
  model: string;
  arguments: Record<string, unknown>;
  timeoutMs?: number;
  outputPath?: string;
}

export interface ImageModelBatchSummary {
  total: number;
  okCount: number;
  skippedCount: number;
  failedCount: number;
  durationSeconds: number;
  concurrency: number;
  retries: number;
  logPath: string;
  summaryPath?: string;
}

export type IntegrationId = 'ffmpeg' | 'imagemagick' | 'mediainfo' | 'exiftool' | 'remove-ai-watermarks';
export type IntegrationBinaryId = 'ffmpeg' | 'ffprobe' | 'magick' | 'mediainfo' | 'exiftool' | 'remove-ai-watermarks';
export type IntegrationStatusKind = 'ready' | 'not_found' | 'probe_failed';
export type IntegrationBinaryStatusKind = IntegrationStatusKind;
export type IntegrationProbeErrorKind = 'spawn_error' | 'timeout' | 'nonzero_exit' | 'parse_error';
export type SystemPackageManagerId = 'brew' | 'winget' | 'apt';
export type PythonCliInstallerId = 'uv' | 'pipx';
export type IntegrationBackendId = SystemPackageManagerId | PythonCliInstallerId;
export type IntegrationInstallBackendKind = 'system-package-manager' | 'python-cli-installer';
export type IntegrationOperationKind = 'install' | 'update' | 'uninstall';

export interface IntegrationOperationDiagnostic {
  commandPreview: string;
  exitCode?: number;
  errorKind?: IntegrationProbeErrorKind;
  stdoutTail?: string;
  stderrTail?: string;
}

export interface IntegrationBackendStatus {
  kind: IntegrationInstallBackendKind;
  backend?: IntegrationBackendId;
  available: boolean;
  unavailableReason?: string;
}

export interface IntegrationOperationStatus {
  backendKind: IntegrationInstallBackendKind;
  backend?: IntegrationBackendId;
  packageName?: string;
  installAvailable: boolean;
  updateAvailable: boolean;
  uninstallAvailable: boolean;
  installCommandPreview?: string;
  updateCommandPreview?: string;
  uninstallCommandPreview?: string;
  installedVersion?: string;
  latestVersion?: string;
  unavailableReason?: string;
  queryDiagnostic?: IntegrationOperationDiagnostic;
}

export interface IntegrationBinaryStatus {
  binaryId: IntegrationBinaryId;
  displayName: string;
  status: IntegrationBinaryStatusKind;
  version?: string;
  probe?: {
    exitCode?: number;
    errorKind?: IntegrationProbeErrorKind;
    stderrTail?: string;
  };
}

export interface IntegrationStatus {
  integrationId: IntegrationId;
  displayName: string;
  description: string;
  category: 'media' | 'image-cleanup';
  status: IntegrationStatusKind;
  summary: string;
  binaries: IntegrationBinaryStatus[];
  operationStatus?: IntegrationOperationStatus;
}

export interface IntegrationSettingsView {
  integrations: IntegrationStatus[];
  backends: IntegrationBackendStatus[];
  operationRunning: boolean;
}

export const AXIS_CLI_OPERATION_KINDS = [
  'install',
  'update',
  'repair',
  'uninstall',
  'refresh-status',
  'refresh-development-link'
] as const;

export type AxisCliMode = 'missing' | 'release' | 'source-linked' | 'broken';
export type AxisCliPathState = 'configured' | 'configured-pending-terminal' | 'not-configured' | 'write-failed';
export type AxisCliOperationKind = typeof AXIS_CLI_OPERATION_KINDS[number];

export type AxisCliDiagnosticCode =
  | 'network_unavailable'
  | 'release_not_found'
  | 'unsupported_platform'
  | 'download_failed'
  | 'checksum_missing'
  | 'checksum_mismatch'
  | 'archive_extract_failed'
  | 'binary_missing'
  | 'version_probe_failed'
  | 'install_root_unwritable'
  | 'path_profile_unwritable'
  | 'windows_path_update_failed'
  | 'operation_already_running'
  | 'managed_command_conflict'
  | 'source_checkout_missing'
  | 'source_dependency_missing'
  | 'skills_sync_failed'
  | 'internal_error';

export const AXIS_CLI_DIAGNOSTIC_CODES = [
  'network_unavailable',
  'release_not_found',
  'unsupported_platform',
  'download_failed',
  'checksum_missing',
  'checksum_mismatch',
  'archive_extract_failed',
  'binary_missing',
  'version_probe_failed',
  'install_root_unwritable',
  'path_profile_unwritable',
  'windows_path_update_failed',
  'operation_already_running',
  'managed_command_conflict',
  'source_checkout_missing',
  'source_dependency_missing',
  'skills_sync_failed',
  'internal_error'
] as const satisfies readonly AxisCliDiagnosticCode[];

export function isAxisCliDiagnosticCode(code: string): code is AxisCliDiagnosticCode {
  return (AXIS_CLI_DIAGNOSTIC_CODES as readonly string[]).includes(code);
}

export interface AxisCliDiagnostic {
  operation?: AxisCliOperationKind;
  code: AxisCliDiagnosticCode;
  path?: string;
  message: string;
}

export interface AxisCliConflict {
  managedPath: string;
  resolvedPath: string;
  resolvedVersion?: string;
  message: string;
}

export interface AxisCliOperationState {
  kind: AxisCliOperationKind;
  running: boolean;
  startedAt: string;
}

export interface AxisCliStatus {
  mode: AxisCliMode;
  managed: boolean;
  installedVersion?: string;
  latestVersion?: string;
  updateAvailable: boolean;
  commandPath: string;
  resolvedPath?: string;
  binDir: string;
  installRoot: string;
  pathState: AxisCliPathState;
  conflict?: AxisCliConflict;
  operation?: AxisCliOperationState;
  diagnostic?: AxisCliDiagnostic;
}

export type SkillSourceKind = 'shared-agents' | 'axis-repository';

export interface SkillRecord {
  name: string;
  description: string;
  shortDescription?: string;
  source: SkillSourceKind;
  root: string;
  skillDir: string;
  skillPath: string;
  axisVersion?: string;
}

export interface AxisSkillsDiagnostic {
  source: SkillSourceKind | 'axis-sync';
  root: string;
  path?: string;
  code: string;
  message: string;
}

export interface AxisSkillsState {
  schemaVersion: 1;
  axisVersion: string;
  bundledSkills: string[];
  updatedSkills: string[];
  skippedSkills: string[];
  diagnostics: Array<{ code: string; message: string; path?: string }>;
  updatedAt: string;
}

export interface SkillsStatusSnapshot {
  sources: Array<{ source: SkillSourceKind; root: string }>;
  skills: SkillRecord[];
  diagnostics: AxisSkillsDiagnostic[];
  statePath: string;
  state?: AxisSkillsState;
  stateVersion?: number;
  currentAxisVersion: string;
  sharedSkillsRoot: string;
  bundledSkillsRoot?: string;
  bundledRootAvailable: boolean;
  bundledSkills: string[];
  missingBundledSkillCount?: number;
  outdatedState: boolean;
}

export interface SkillsSyncInput {
  force: boolean;
}

export interface SkillsSyncSnapshot extends SkillsStatusSnapshot {
  force: boolean;
  updatedSkills: SkillRecord[];
  skippedSkills: string[];
}

export interface GeneratedAssetRecord {
  schemaVersion: 1;
  recordId: string;
  createdAt: string;
  fingerprint: {
    algorithm: 'sha256';
    hash: string;
  };
  providerCall: {
    request: unknown;
    output: unknown;
  };
}

export interface GeneratedAssetMetadataDiagnostic {
  code: string;
  message: string;
  recordId?: string;
  metadataPath?: string;
}

export type GeneratedAssetMetadataLookup =
  | {
      status: 'matched';
      fingerprint: {
        algorithm: 'sha256';
        hash: string;
      };
      records: GeneratedAssetRecord[];
      diagnostics?: GeneratedAssetMetadataDiagnostic[];
    }
  | {
      status: 'unmatched';
      fingerprint: {
        algorithm: 'sha256';
        hash: string;
      };
      diagnostics?: GeneratedAssetMetadataDiagnostic[];
    }
  | {
      status: 'unavailable';
      reason: 'missing' | 'unreadable' | 'metadata_unreadable';
      message: string;
      diagnostics?: GeneratedAssetMetadataDiagnostic[];
    };

export type AppServerEvent =
  | { type: 'project.opened'; snapshot: ProjectSessionSnapshot }
  | { type: 'project.changed'; snapshot: ProjectSessionSnapshot }
  | { type: 'project.fileChanged'; event: NormalizedFileWatchEvent; snapshot: ProjectSessionSnapshot }
  | { type: 'canvas.changed'; canvas: CanvasDocument; projection: CanvasProjection }
  | { type: 'llm.settings.changed'; settings: LlmProviderSettingsView }
  | { type: 'imageModel.settings.changed'; settings: ImageModelSettingsView }
  | { type: 'videoModel.settings.changed'; settings: VideoModelSettingsView }
  | { type: 'integrations.settings.changed'; settings: IntegrationSettingsView }
  | { type: 'canvas.settings.changed'; settings: CanvasSettingsView };

export type DesktopUpdateState =
  | { type: 'disabled'; reason: 'development' | 'unsupported-platform' | 'missing-config' }
  | { type: 'idle'; currentVersion: string; lastCheckedAt?: string; notAvailable?: boolean; lastError?: string }
  | { type: 'checking'; currentVersion: string; explicit: boolean }
  | { type: 'available'; currentVersion: string; updateVersion: string; releaseName?: string; releaseDate?: string; lastError?: string }
  | { type: 'downloading'; currentVersion: string; updateVersion: string; percent?: number }
  | { type: 'installing'; currentVersion: string; updateVersion: string };

export interface DesktopHotExitSnapshot {
  schemaVersion: 1;
  createdAt: string;
  projectRoot?: string;
  activeCanvasId?: string;
  explorerSelection?: string;
  selection?: CanvasSelection;
  textFileBuffers: DesktopHotExitTextBuffer[];
  textEditorWindows: DesktopHotExitTextEditorWindow[];
}

export interface DesktopHotExitTextBuffer {
  projectRelativePath: string;
  content: string;
  language: string;
  wordWrap: boolean;
  diskRevision?: string;
  lastSavedRevision?: string;
}

export interface DesktopHotExitTextEditorWindow {
  projectRelativePath: string;
  open: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DesktopEvent =
  | AppServerEvent
  | { type: 'desktop.updateState.changed'; state: DesktopUpdateState }
  | { type: 'desktop.axisCli.changed'; status: AxisCliStatus };

export interface DesktopState {
  recentProjectRoots: string[];
  lastProjectRoot?: string;
  setupCompleted: boolean;
}

export interface WorkbenchApiClient {
  readonly mode: 'desktop';
  getDesktopState(): Promise<DesktopState>;
  setSetupCompleted(input: { completed: boolean }): Promise<DesktopState>;
  chooseProjectRoot(): Promise<string | undefined>;
  openProject(projectRoot?: string): Promise<ProjectSessionSnapshot | undefined>;
  getSnapshot(): Promise<ProjectSessionSnapshot>;
  getProjectHealth(): Promise<ProjectHealthSummary>;
  readProjectTextFile(projectRelativePath: string): Promise<ProjectTextFile>;
  writeProjectTextFile(projectRelativePath: string, content: string): Promise<ProjectTextFile>;
  getDesktopPlatform(): Promise<NodeJS.Platform>;
  resolveProjectAbsolutePath(projectRelativePath: string): Promise<string>;
  createProjectFile(input: { parentProjectRelativePath: string; name: string }): Promise<ProjectFileOperationResult>;
  createProjectDirectory(input: { parentProjectRelativePath: string; name: string }): Promise<ProjectFileOperationResult>;
  renameProjectPath(input: { projectRelativePath: string; name: string }): Promise<ProjectFileOperationResult>;
  copyProjectPath(input: { sourceProjectRelativePath: string; targetDirectoryProjectRelativePath: string }): Promise<ProjectFileOperationResult>;
  moveProjectPath(input: { sourceProjectRelativePath: string; targetDirectoryProjectRelativePath: string }): Promise<ProjectFileOperationResult>;
  trashProjectPath(input: { projectRelativePath: string }): Promise<{ projectRelativePath: string; snapshot: ProjectSessionSnapshot }>;
  deleteProjectPathPermanently(input: { projectRelativePath: string }): Promise<ProjectFileOperationResult | undefined>;
  revealProjectPathInSystemFileManager(input: { projectRelativePath: string; kind: 'file' | 'directory' }): Promise<{ ok: true }>;
  lookupGeneratedAssetMetadata(input: { projectRelativePath: string }): Promise<GeneratedAssetMetadataLookup>;
  readCanvasFeedback(): Promise<CanvasFeedbackDocument>;
  updateCanvasFeedbackEntry(input: UpdateCanvasFeedbackEntryInput): Promise<CanvasFeedbackDocument>;
  refreshProject(): Promise<ProjectSessionSnapshot>;
  updateCanvasViewport(canvasId: string, viewport: CanvasViewport): Promise<CanvasDocument>;
  updateCanvasSelection(canvasId: string, selection: CanvasSelection | undefined): Promise<CanvasDocument>;
  updateCanvasNodeLayouts(input: {
    canvasId: string;
    nodeLayouts?: Array<{ projectRelativePath: string; x: number; y: number; width?: number; height?: number }>;
  }): Promise<CanvasDocument>;
  updateCanvasNodeLayers(input: {
    canvasId: string;
    nodeLayers?: CanvasNodeLayerPatch[];
    nodeProjectRelativePathsTopFirst?: string[];
  }): Promise<CanvasDocument>;
  llmGetSettings(): Promise<LlmProviderSettingsView>;
  llmSaveProviderSetting(input: SaveLlmProviderSettingInput, providerId?: string): Promise<LlmProviderSettingsView>;
  llmDeleteProviderSetting(providerId: string): Promise<LlmProviderSettingsView>;
  llmSetDefaultModelKey(modelKey: string | null): Promise<LlmProviderSettingsView>;
  llmDiscoverProviderModels(input: DiscoverLlmProviderModelsInput, providerId?: string): Promise<DiscoverProviderModelsOutput>;
  imageModelGetSettings(): Promise<ImageModelSettingsView>;
  imageModelSaveSetting(modelId: string, input: SaveImageModelSettingInput): Promise<ImageModelSettingsView>;
  videoModelGetSettings(): Promise<VideoModelSettingsView>;
  videoModelSaveSetting(modelId: string, input: SaveVideoModelSettingInput): Promise<VideoModelSettingsView>;
  integrationsListStatus(): Promise<IntegrationSettingsView>;
  integrationsRescan(): Promise<IntegrationSettingsView>;
  canvasSettingsGet(): Promise<CanvasSettingsView>;
  canvasSettingsSave(input: CanvasSettingsView): Promise<CanvasSettingsView>;
  axisCliGetStatus(): Promise<AxisCliStatus>;
  axisCliInstall(): Promise<AxisCliStatus>;
  axisCliUpdate(): Promise<AxisCliStatus>;
  axisCliRepair(): Promise<AxisCliStatus>;
  axisCliUninstall(): Promise<AxisCliStatus>;
  axisCliRefreshDevelopmentLink(): Promise<AxisCliStatus>;
  getUpdateState(): Promise<DesktopUpdateState>;
  updateNow(): Promise<DesktopUpdateState>;
  getHotExitSnapshot(): Promise<DesktopHotExitSnapshot | undefined>;
  clearHotExitSnapshot(): Promise<void>;
  onHotExitSnapshotRequest(listener: () => DesktopHotExitSnapshot | Promise<DesktopHotExitSnapshot>): () => void;
  onEvent(listener: (event: DesktopEvent) => void): () => void;
}

export type DesktopWorkbenchApiClient = Omit<WorkbenchApiClient, 'mode'>;
