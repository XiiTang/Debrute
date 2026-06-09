import type {
  CanvasDocument,
  CanvasFeedbackDocument,
  CanvasNodeLayerPatch,
  CanvasProjection,
  Diagnostic,
  UpdateCanvasFeedbackEntryInput
} from '@debrute/canvas-core';
import type {
  DebruteProjectMetadata,
  NormalizedFileWatchEvent,
  ProjectFileEntry,
  ProjectPathBatchEntry,
  ProjectPathBatchOperationResult,
  ProjectPathOperationResult,
  ProjectTextFile
} from '@debrute/project-core';

export type { ProjectTextFile } from '@debrute/project-core';

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
  metadata: DebruteProjectMetadata;
  files: ProjectFileEntry[];
  canvases: CanvasDocument[];
  projections: CanvasProjection[];
  diagnostics: Diagnostic[];
  health: ProjectHealthSummary;
}

export type WorkbenchProjectSessionSnapshot = Omit<ProjectSessionSnapshot, 'projectRoot'>;
export type WorkbenchProjectTextFile = Omit<ProjectTextFile, 'absolutePath'>;

export interface DebruteRuntimeInfo {
  daemonUrl: string;
  webBaseUrl: string | null;
  platform: NodeJS.Platform;
}

export interface LiveProjectView {
  projectId: string;
  snapshot: WorkbenchProjectSessionSnapshot;
  clients: {
    liveCount: number;
  };
}

export interface LiveProjectsView {
  projects: LiveProjectView[];
}

export type DebruteWorkbenchRoute =
  | { kind: 'workbench' }
  | {
      kind: 'project';
      projectId: string;
    };

export interface DebruteHttpErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export function isDebruteMutatingMethod(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized === 'POST' || normalized === 'PUT' || normalized === 'PATCH' || normalized === 'DELETE';
}

export function normalizeDebruteRuntimeInfo(input: {
  daemonUrl: string;
  webBaseUrl?: string | null;
  platform: NodeJS.Platform;
}): DebruteRuntimeInfo {
  return {
    daemonUrl: trimTrailingSlash(input.daemonUrl),
    webBaseUrl: input.webBaseUrl ? trimTrailingSlash(input.webBaseUrl) : null,
    platform: input.platform
  };
}

export function parseDebruteWorkbenchPath(pathname: string): DebruteWorkbenchRoute {
  const segments = pathname
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === 'projects' && segments[1]) {
    return {
      kind: 'project',
      projectId: segments[1]
    };
  }
  return { kind: 'workbench' };
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export interface ProjectFileOperationResult extends ProjectPathOperationResult {
  snapshot: ProjectSessionSnapshot;
}

export interface WorkbenchProjectFileOperationResult extends ProjectPathOperationResult {
  snapshot: WorkbenchProjectSessionSnapshot;
}

export type WorkbenchProjectPathEntry = ProjectPathBatchEntry;

export interface ProjectFileBatchOperationResult extends ProjectPathBatchOperationResult {
  snapshot: ProjectSessionSnapshot;
}

export interface WorkbenchProjectFileBatchOperationResult extends ProjectPathBatchOperationResult {
  snapshot: WorkbenchProjectSessionSnapshot;
}

export interface WorkbenchProjectCopyPathsInput {
  entries: WorkbenchProjectPathEntry[];
  targetDirectoryProjectRelativePath: string;
}

export interface WorkbenchProjectMovePathsInput extends WorkbenchProjectCopyPathsInput {
  overwrite?: boolean;
}

export interface WorkbenchProjectDeletePathsInput {
  entries: WorkbenchProjectPathEntry[];
}

export interface WorkbenchProjectAbsolutePathsResult {
  paths: string[];
}

export interface WorkbenchProjectExternalLocalImportInput {
  sources: string[];
  targetDirectoryProjectRelativePath: string;
  overwrite?: boolean;
}

export type WorkbenchProjectUploadImportEntry =
  | {
      kind: 'directory';
      projectRelativePath: string;
    }
  | {
      kind: 'file';
      projectRelativePath: string;
      file: Blob;
    };

export interface WorkbenchProjectUploadImportInput {
  entries: WorkbenchProjectUploadImportEntry[];
  targetDirectoryProjectRelativePath: string;
  overwrite?: boolean;
}

export interface DaemonProjectUploadImportPlan {
  entries: Array<
    | {
        kind: 'directory';
        projectRelativePath: string;
      }
    | {
        kind: 'file';
        projectRelativePath: string;
        fileField: string;
      }
  >;
  targetDirectoryProjectRelativePath: string;
  overwrite?: boolean;
}

export interface WorkbenchProjectOpenResult {
  projectId: string;
  snapshot: WorkbenchProjectSessionSnapshot;
}

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
  debruteModelId: string;
  summary: string;
  supportsEditing: boolean;
  supportsTextRendering: boolean;
  defaultBaseUrl: string;
  defaultRequestModelId: string;
  baseUrlOverride: string | null;
  requestModelIdOverride: string | null;
  apiKeySet: boolean;
}

export interface ImageModelSettingsView {
  models: ImageModelSettingRecord[];
}

export interface SaveImageModelSettingInput {
  baseUrlOverride: string | null;
  requestModelIdOverride: string | null;
  apiKey?: string;
}

export interface VideoModelSettingRecord {
  debruteModelId: string;
  summary: string;
  supportsTextToVideo: boolean;
  supportsImageReferences: boolean;
  supportsVideoReferences: boolean;
  supportsAudioReferences: boolean;
  supportsGeneratedAudio: boolean;
  defaultBaseUrl: string;
  defaultRequestModelId: string;
  baseUrlOverride: string | null;
  requestModelIdOverride: string | null;
  apiKeySet: boolean;
}

export interface VideoModelSettingsView {
  models: VideoModelSettingRecord[];
}

export interface SaveVideoModelSettingInput {
  baseUrlOverride: string | null;
  requestModelIdOverride: string | null;
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
}

export type SkillSourceKind = 'shared-agents' | 'debrute-repository';

export interface SkillRecord {
  name: string;
  description: string;
  shortDescription?: string;
  source: SkillSourceKind;
  root: string;
  skillDir: string;
  skillPath: string;
  debruteVersion?: string;
}

export interface DebruteSkillsDiagnostic {
  source?: SkillSourceKind | 'debrute-sync';
  root?: string;
  path?: string;
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export interface DebruteSkillsState {
  schemaVersion: 1;
  debruteVersion: string;
  bundledSkills: string[];
  updatedSkills: string[];
  addedBundledSkills: string[];
  skippedDeletedSkills: string[];
  diagnostics: DebruteSkillsDiagnostic[];
  updatedAt: string;
}

export interface SkillsStatusSnapshot {
  sources: Array<{ source: SkillSourceKind; root: string }>;
  skills: SkillRecord[];
  diagnostics: DebruteSkillsDiagnostic[];
  statePath: string;
  state?: DebruteSkillsState;
  currentDebruteVersion: string;
  sharedSkillsRoot: string;
  bundledSkillsRoot?: string;
  bundledRootAvailable: boolean;
  bundledSkills: string[];
  missingBundledSkills: string[];
  missingBundledSkillCount: number;
  skippedDeletedSkills: string[];
}

export interface SkillsSyncInput {
  force: boolean;
}

export interface SkillsSyncSnapshot extends SkillsStatusSnapshot {
  force: boolean;
  updatedSkills: SkillRecord[];
  addedBundledSkills: SkillRecord[];
  skippedDeletedSkills: string[];
}

export type DebruteCliSkillsStatus =
  | { kind: 'in_sync'; debruteVersion: string }
  | { kind: 'out_of_sync'; cliVersion: string; stateDebruteVersion: string | null }
  | { kind: 'partially_removed'; skippedDeletedSkills: string[] }
  | { kind: 'error'; code: string; message: string };

export type DebruteCliStatus =
  | { kind: 'not_installed'; desktopVersion: string; manualCommand: string }
  | {
      kind: 'installed';
      desktopVersion: string;
      cliVersion: string;
      managedPath: string;
      resolvedPath: string | null;
      onPath: boolean;
      skills: DebruteCliSkillsStatus;
    }
  | {
      kind: 'update_available';
      desktopVersion: string;
      cliVersion: string;
      managedPath: string;
      skills: DebruteCliSkillsStatus;
    }
  | {
      kind: 'external_newer';
      desktopVersion: string;
      cliVersion: string;
      managedPath: string;
      skills: DebruteCliSkillsStatus;
    }
  | {
      kind: 'installed_but_not_on_path';
      desktopVersion: string;
      cliVersion: string;
      managedPath: string;
      repairCommand: string;
      skills: DebruteCliSkillsStatus;
    }
  | { kind: 'error'; desktopVersion: string; code: string; message: string; manualCommand: string };

export interface DebruteCliInstallResult {
  ok: boolean;
  status: DebruteCliStatus;
}

export interface DebruteCliSkillsSyncResult {
  ok: boolean;
  status: DebruteCliSkillsStatus;
}

export interface DebruteCliPathRepairResult {
  ok: boolean;
  status: DebruteCliStatus;
}

export interface DebruteCliManualCommand {
  platform: 'macos' | 'linux' | 'windows';
  command: string;
}

export interface GeneratedAssetRecord {
  schemaVersion: 1;
  recordId: string;
  projectRelativePath: string;
  createdAt: string;
  fingerprint: {
    algorithm: 'sha256';
    hash: string;
  };
  modelRun: {
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

export interface GeneratedAssetView {
  assetId: string;
  projectRelativePath: string;
  rawUrl: string;
  record: GeneratedAssetRecord;
}

export interface GeneratedAssetsView {
  assets: GeneratedAssetView[];
}

export type AppServerEvent =
  | { type: 'project.opened'; snapshot: ProjectSessionSnapshot }
  | { type: 'project.changed'; snapshot: ProjectSessionSnapshot }
  | { type: 'project.fileChanged'; event: NormalizedFileWatchEvent; snapshot: ProjectSessionSnapshot }
  | { type: 'canvas.changed'; canvas: CanvasDocument; projection: CanvasProjection }
  | { type: 'llm.settings.changed'; settings: LlmProviderSettingsView }
  | { type: 'imageModel.settings.changed'; settings: ImageModelSettingsView }
  | { type: 'videoModel.settings.changed'; settings: VideoModelSettingsView }
  | { type: 'integrations.settings.changed'; settings: IntegrationSettingsView };

export type WorkbenchFileWatchEvent = Omit<NormalizedFileWatchEvent, 'absolutePath'>;

export type WorkbenchEvent =
  | { type: 'project.opened'; snapshot: WorkbenchProjectSessionSnapshot }
  | { type: 'project.changed'; snapshot: WorkbenchProjectSessionSnapshot }
  | { type: 'project.fileChanged'; event: WorkbenchFileWatchEvent; snapshot: WorkbenchProjectSessionSnapshot }
  | { type: 'canvas.changed'; canvas: CanvasDocument; projection: CanvasProjection }
  | { type: 'llm.settings.changed'; settings: LlmProviderSettingsView }
  | { type: 'imageModel.settings.changed'; settings: ImageModelSettingsView }
  | { type: 'videoModel.settings.changed'; settings: VideoModelSettingsView }
  | { type: 'integrations.settings.changed'; settings: IntegrationSettingsView };

export interface WorkbenchApiClient {
  readonly mode: 'web' | 'desktop';
  chooseProjectRoot(): Promise<string | undefined>;
  openProject(input: { projectRoot: string } | { projectId: string }): Promise<WorkbenchProjectOpenResult>;
  getSnapshot(): Promise<WorkbenchProjectSessionSnapshot>;
  getProjectHealth(): Promise<ProjectHealthSummary>;
  readProjectTextFile(projectRelativePath: string): Promise<WorkbenchProjectTextFile>;
  writeProjectTextFile(projectRelativePath: string, content: string): Promise<WorkbenchProjectTextFile>;
  getDesktopPlatform(): Promise<NodeJS.Platform>;
  createProjectFile(input: { parentProjectRelativePath: string; name: string }): Promise<WorkbenchProjectFileOperationResult>;
  createProjectDirectory(input: { parentProjectRelativePath: string; name: string }): Promise<WorkbenchProjectFileOperationResult>;
  renameProjectPath(input: { projectRelativePath: string; name: string }): Promise<WorkbenchProjectFileOperationResult>;
  copyProjectPaths(input: WorkbenchProjectCopyPathsInput): Promise<WorkbenchProjectFileBatchOperationResult>;
  moveProjectPaths(input: WorkbenchProjectMovePathsInput): Promise<WorkbenchProjectFileBatchOperationResult>;
  copyProjectAbsolutePaths(input: WorkbenchProjectDeletePathsInput): Promise<WorkbenchProjectAbsolutePathsResult>;
  trashProjectPaths(input: WorkbenchProjectDeletePathsInput): Promise<WorkbenchProjectFileBatchOperationResult>;
  deleteProjectPathsPermanently(input: WorkbenchProjectDeletePathsInput): Promise<WorkbenchProjectFileBatchOperationResult>;
  importExternalLocalProjectPaths(input: WorkbenchProjectExternalLocalImportInput): Promise<WorkbenchProjectFileBatchOperationResult>;
  importExternalProjectUploads(input: WorkbenchProjectUploadImportInput): Promise<WorkbenchProjectFileBatchOperationResult>;
  revealProjectPathInSystemFileManager(input: { projectRelativePath: string; kind: 'file' | 'directory' }): Promise<{ ok: true }>;
  lookupGeneratedAssetMetadata(input: { projectRelativePath: string }): Promise<GeneratedAssetMetadataLookup>;
  listGeneratedAssets(): Promise<GeneratedAssetsView>;
  readGeneratedAsset(assetId: string): Promise<GeneratedAssetView>;
  readCanvasFeedback(): Promise<CanvasFeedbackDocument>;
  updateCanvasFeedbackEntry(input: UpdateCanvasFeedbackEntryInput): Promise<CanvasFeedbackDocument>;
  refreshProject(): Promise<WorkbenchProjectSessionSnapshot>;
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
  onEvent(listener: (event: WorkbenchEvent) => void): () => void;
}
