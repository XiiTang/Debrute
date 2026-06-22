import type {
  CanvasDocument,
  CanvasFeedbackDocument,
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

export type CanvasRegistryErrorCode =
  | 'canvas_registry_missing'
  | 'canvas_registry_invalid'
  | 'canvas_registry_conflict'
  | 'canvas_registry_repair_failed';

export type CanvasRegistryState =
  | {
      status: 'ready';
      canvasOrder: string[];
    }
  | {
      status: 'invalid';
      code: CanvasRegistryErrorCode;
      message: string;
    };

export interface ProjectSessionSnapshot {
  projectRoot: string;
  metadata: DebruteProjectMetadata;
  files: ProjectFileEntry[];
  canvases: CanvasDocument[];
  projections: CanvasProjection[];
  diagnostics: Diagnostic[];
  canvasRegistry: CanvasRegistryState;
  health: ProjectHealthSummary;
}

export type WorkbenchProjectSessionSnapshot = Omit<ProjectSessionSnapshot, 'projectRoot'>;
export type WorkbenchProjectTextFile = Omit<ProjectTextFile, 'absolutePath'>;

export interface DebruteRuntimeInfo {
  daemonUrl: string;
  webBaseUrl: string | null;
  platform: NodeJS.Platform;
}

export interface BrowserSessionCredential {
  token: string;
  runtime: DebruteRuntimeInfo;
}

export interface RevisionedProjectResult {
  projectId: string;
  projectRevision: number;
}

export interface RevisionedProjectMutation {
  baseRevision: number;
}

export interface StaleProjectRevisionDetails extends RevisionedProjectResult {
  snapshot: WorkbenchProjectSessionSnapshot;
}

export interface LiveProjectView extends RevisionedProjectResult {
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
      kind: 'project-open';
      projectRoot?: string;
    }
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

export type DebruteAgentFieldValue = string | number | boolean | null;

export interface DebruteAgentNamedRecord {
  name: string;
  fields: Record<string, DebruteAgentFieldValue>;
}

export interface DebruteAgentCommandResult {
  status: 'ok' | 'error';
  command: string;
  code?: string;
  message?: string;
  records?: DebruteAgentNamedRecord[];
  fields?: Record<string, DebruteAgentFieldValue>;
}

export interface DaemonCliCommandRequest {
  command: string;
  positional: string[];
  options: Record<string, string>;
  projectRoot?: string;
}

export type DaemonCliRunEvent =
  | { type: 'progress'; command: string; fields: Record<string, DebruteAgentFieldValue> }
  | { type: 'result'; result: DebruteAgentCommandResult };

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

export function parseDebruteWorkbenchPath(pathname: string, search = ''): DebruteWorkbenchRoute {
  const segments = pathname
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(decodeURIComponent);
  if (segments.length === 1 && segments[0] === 'open') {
    const projectRoot = new URLSearchParams(search).get('path') ?? undefined;
    return projectRoot ? { kind: 'project-open', projectRoot } : { kind: 'project-open' };
  }
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

export interface WorkbenchProjectFileOperationResult extends ProjectPathOperationResult, RevisionedProjectResult {
  snapshot: WorkbenchProjectSessionSnapshot;
}

export type WorkbenchProjectPathEntry = ProjectPathBatchEntry;

export interface ProjectFileBatchOperationResult extends ProjectPathBatchOperationResult {
  snapshot: ProjectSessionSnapshot;
}

export interface WorkbenchProjectFileBatchOperationResult extends ProjectPathBatchOperationResult, RevisionedProjectResult {
  snapshot: WorkbenchProjectSessionSnapshot;
}

export interface ProjectCanvasManagementResult {
  snapshot: ProjectSessionSnapshot;
  activeCanvasId?: string;
}

export interface WorkbenchCanvasManagementResult extends RevisionedProjectResult {
  snapshot: WorkbenchProjectSessionSnapshot;
  activeCanvasId?: string;
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

export interface DaemonProjectUploadImportPlan extends RevisionedProjectMutation {
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

export interface WorkbenchProjectOpenResult extends RevisionedProjectResult {
  snapshot: WorkbenchProjectSessionSnapshot;
}

export interface WorkbenchProjectRefreshResult extends RevisionedProjectResult {
  snapshot: WorkbenchProjectSessionSnapshot;
}

export interface WorkbenchProjectTextFileWriteResult extends RevisionedProjectResult {
  file: WorkbenchProjectTextFile;
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
  apiKeyPreview?: string;
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
  apiKeyPreview?: string;
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
  apiKeyPreview?: string;
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
  overwriteExisting?: boolean;
  /** Project-relative output path for the result JSONL file. */
  logPath: string;
  /** Project-relative output path for the optional summary JSON file. */
  summaryPath?: string;
}

export type ImageModelBatchSource =
  | {
      kind: 'manifest';
      /** Project-relative batch manifest path. */
      path: string;
    }
  | {
      kind: 'jsonl';
      /** Project-relative batch JSONL path. */
      path: string;
    }
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
  /** Project-relative output path reported to callers. */
  logPath: string;
  /** Project-relative summary path reported to callers. */
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

export type DesktopAppUpdateDisabledReason =
  | 'development'
  | 'browser'
  | 'unsupported-platform';

export type DesktopAppUpdateInstallMode = 'automatic' | 'manual-download';
export type DesktopAppUpdateErrorOperation = 'check' | 'download' | 'install';

export type DesktopAppUpdateState =
  | {
      type: 'disabled';
      currentVersion: string;
      platform?: NodeJS.Platform;
      reason: DesktopAppUpdateDisabledReason;
    }
  | {
      type: 'idle';
      currentVersion: string;
      platform: NodeJS.Platform;
      lastCheckedAt?: string;
      notAvailable?: boolean;
      lastError?: string;
    }
  | {
      type: 'checking';
      currentVersion: string;
      platform: NodeJS.Platform;
      explicit: boolean;
    }
  | {
      type: 'available';
      currentVersion: string;
      platform: NodeJS.Platform;
      updateVersion: string;
      releaseName?: string;
      releaseDate?: string;
      releaseUrl?: string;
      installMode: DesktopAppUpdateInstallMode;
    }
  | {
      type: 'downloading';
      currentVersion: string;
      platform: NodeJS.Platform;
      updateVersion: string;
      percent: number;
    }
  | {
      type: 'downloaded';
      currentVersion: string;
      platform: NodeJS.Platform;
      updateVersion: string;
      releaseName?: string;
      releaseDate?: string;
    }
  | {
      type: 'installing';
      currentVersion: string;
      platform: NodeJS.Platform;
      updateVersion: string;
    }
  | {
      type: 'error';
      currentVersion: string;
      platform: NodeJS.Platform;
      operation: DesktopAppUpdateErrorOperation;
      message: string;
      retryable: boolean;
      updateVersion?: string;
      installMode?: DesktopAppUpdateInstallMode;
    };

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

export type TerminalSessionStatus = 'starting' | 'running' | 'exited' | 'failed';

export interface TerminalSessionView {
  id: string;
  title: string;
  cwdProjectRelativePath: string;
  cols: number;
  rows: number;
  status: TerminalSessionStatus;
  exitCode: number | null;
  signal: string | null;
  createdAt: string;
  updatedAt: string;
  restartCount: number;
}

export interface CreateTerminalSessionInput {
  cwdProjectRelativePath?: string;
  cols?: number;
  rows?: number;
}

export interface TerminalSessionList {
  sessions: TerminalSessionView[];
}

export interface TerminalSessionResult {
  session: TerminalSessionView;
}

export interface TerminalInputWrite {
  terminalId: string;
  data: string;
}

export interface TerminalResize {
  terminalId: string;
  cols: number;
  rows: number;
}

export interface RestartTerminalSessionInput {
  terminalId: string;
}

export interface CloseTerminalSessionInput {
  terminalId: string;
}

export interface TerminalDataChunk {
  sequence: number;
  data: string;
}

export type TerminalEvent =
  | {
      type: 'replay';
      terminalId: string;
      chunks: TerminalDataChunk[];
      lastSequence: number;
    }
  | {
      type: 'data';
      terminalId: string;
      sequence: number;
      data: string;
    }
  | {
      type: 'status';
      terminalId: string;
      session: TerminalSessionView;
    }
  | {
      type: 'exit';
      terminalId: string;
      exitCode: number | null;
      signal: string | null;
    }
  | {
      type: 'closed';
      terminalId: string;
    }
  | {
      type: 'error';
      terminalId: string;
      code: string;
      message: string;
    };

export interface TerminalEventSubscription {
  close(): void;
}

export interface AddProjectPathToCanvasMapInput {
  canvasId: string;
  projectRelativePath: string;
}

export type ResetCanvasNodeLayoutsInput = {
  canvasId: string;
} & (
  | { all: true }
  | { pathRules: string[] }
);

export interface ProjectAddProjectPathToCanvasMapResult {
  snapshot: ProjectSessionSnapshot;
  canvas: CanvasDocument;
  projection: CanvasProjection;
  centerProjectRelativePath: string;
}

export interface WorkbenchAddProjectPathToCanvasMapResult extends RevisionedProjectResult {
  snapshot: WorkbenchProjectSessionSnapshot;
  canvas: CanvasDocument;
  projection: CanvasProjection;
  centerProjectRelativePath: string;
}

export interface WorkbenchCanvasDocumentMutationResult extends RevisionedProjectResult {
  canvas: CanvasDocument;
  projection: CanvasProjection;
}

export interface WorkbenchCanvasResetLayoutResult extends WorkbenchCanvasDocumentMutationResult {
  resetCount: number;
}

export interface WorkbenchCanvasFeedbackMutationResult extends RevisionedProjectResult {
  feedback: CanvasFeedbackDocument;
}

export type AdobeBridgeDiscoveryStatus = 'available' | 'disabled' | 'unavailable';

export interface AdobeBridgeSettings {
  enabled: boolean;
  discoveryStatus: AdobeBridgeDiscoveryStatus;
}

export type AdobeBridgeHostApp = 'photoshop';
export type AdobeBridgeClientRuntime = 'uxp' | 'cep';

export interface AdobeBridgeClient {
  adobeClientId: string;
  hostApp: AdobeBridgeHostApp;
  hostVersion: string;
  clientRuntime?: AdobeBridgeClientRuntime;
  displayName: string;
  documentCount: number;
  activeDocumentTitle: string | null;
  connectedAt: string;
  lastSeenAt: string;
}

export interface ProjectBridgeDirectory {
  projectRelativePath: string;
  name: string;
  depth: number;
}

export interface ProjectBridgeClient {
  projectId: string;
  projectName: string;
  projectRevision: number;
  directories: ProjectBridgeDirectory[];
  connectedWorkbenchClientCount: number;
}

export interface AdobeBridgeLink {
  linkId: string;
  projectId: string;
  adobeClientId: string;
  createdAt: string;
  status: 'active' | 'adobe-offline' | 'project-offline';
}

export type AdobeBridgeTransferDirection = 'photoshop-to-debrute' | 'debrute-to-photoshop';
export type AdobeBridgeTransferStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface AdobeBridgeTransferView {
  transferId: string;
  direction: AdobeBridgeTransferDirection;
  projectId: string;
  adobeClientId: string;
  projectRelativePath: string | null;
  status: AdobeBridgeTransferStatus;
  errorCode?: AdobeBridgeErrorCode;
  message?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdobeBridgeStateView {
  settings: AdobeBridgeSettings;
  adobeClients: AdobeBridgeClient[];
  projects: ProjectBridgeClient[];
  links: AdobeBridgeLink[];
  transfers: AdobeBridgeTransferView[];
}

export interface SaveAdobeBridgeSettingsInput {
  enabled: boolean;
}

export interface CreateAdobeBridgeLinkInput {
  adobeClientId: string;
}

export interface SendProjectFileToPhotoshopInput {
  projectRelativePath: string;
  adobeClientId: string;
}

export interface SendProjectFileToPhotoshopResult {
  transfer: AdobeBridgeTransferView;
}

export interface PhotoshopBridgeHelloMessage {
  type: 'hello';
  adobeClientId?: string;
  hostApp: 'photoshop';
  hostVersion: string;
  clientRuntime?: AdobeBridgeClientRuntime;
  documentCount: number;
  activeDocumentTitle: string | null;
}

export interface PhotoshopBridgeStatusMessage {
  type: 'photoshop.status';
  documentCount: number;
  activeDocumentTitle: string | null;
}

export interface PhotoshopBridgeImportResultMessage {
  type: 'transfer.import.result';
  transferId: string;
  ok: boolean;
  errorCode?: AdobeBridgeErrorCode;
  message?: string;
}

export type PhotoshopBridgeClientMessage =
  | PhotoshopBridgeHelloMessage
  | PhotoshopBridgeStatusMessage
  | PhotoshopBridgeImportResultMessage
  | { type: 'heartbeat' };

export interface DaemonBridgeStateMessage {
  type: 'bridge.state';
  state: AdobeBridgeStateView;
}

export interface DaemonBridgeImportRequestMessage {
  type: 'transfer.import.request';
  transferId: string;
  projectId: string;
  projectRelativePath: string;
  fileName: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/vnd.adobe.photoshop';
  byteLength: number;
  downloadUrl: string;
}

export type DaemonBridgeClientMessage =
  | DaemonBridgeStateMessage
  | DaemonBridgeImportRequestMessage
  | { type: 'bridge.error'; code: AdobeBridgeErrorCode; message: string };

export const adobeBridgeErrorCodes = [
  'adobe_bridge_disabled',
  'adobe_discovery_unavailable',
  'adobe_client_offline',
  'project_offline',
  'project_not_linked',
  'target_directory_missing',
  'target_directory_not_visible',
  'unsupported_file_type',
  'upload_too_large',
  'invalid_transfer_payload',
  'no_active_document',
  'photoshop_place_failed',
  'transfer_url_expired',
  'transfer_timeout'
] as const;

export type AdobeBridgeErrorCode = typeof adobeBridgeErrorCodes[number];

export function isAdobeBridgeErrorCode(value: string): value is AdobeBridgeErrorCode {
  return (adobeBridgeErrorCodes as readonly string[]).includes(value);
}

export function adobeBridgeClientDisplayName(input: {
  hostApp: AdobeBridgeHostApp;
  hostVersion: string;
  activeDocumentTitle: string | null;
}): string {
  const hostLabel = input.hostApp === 'photoshop' ? 'Photoshop' : input.hostApp;
  return `${hostLabel} ${input.hostVersion} · ${input.activeDocumentTitle ?? 'No document open'}`;
}

export type AppServerEvent =
  | { type: 'project.opened'; snapshot: ProjectSessionSnapshot }
  | { type: 'project.changed'; snapshot: ProjectSessionSnapshot }
  | { type: 'project.fileChanged'; event: NormalizedFileWatchEvent; snapshot: ProjectSessionSnapshot }
  | { type: 'canvas.changed'; canvas: CanvasDocument; projection: CanvasProjection }
  | { type: 'canvas.feedback.changed'; feedback: CanvasFeedbackDocument }
  | { type: 'generatedAsset.metadata.changed'; record: GeneratedAssetRecord }
  | { type: 'llm.settings.changed'; settings: LlmProviderSettingsView }
  | { type: 'imageModel.settings.changed'; settings: ImageModelSettingsView }
  | { type: 'videoModel.settings.changed'; settings: VideoModelSettingsView }
  | { type: 'integrations.settings.changed'; settings: IntegrationSettingsView }
  | { type: 'adobeBridge.settings.changed'; settings: AdobeBridgeSettings };

export type WorkbenchFileWatchEvent = Omit<NormalizedFileWatchEvent, 'absolutePath'>;

export type WorkbenchEvent =
  | { type: 'project.opened'; projectId: string; projectRevision: number; snapshot: WorkbenchProjectSessionSnapshot }
  | { type: 'project.changed'; projectId: string; projectRevision: number; snapshot: WorkbenchProjectSessionSnapshot }
  | { type: 'project.fileChanged'; projectId: string; projectRevision: number; event: WorkbenchFileWatchEvent; snapshot: WorkbenchProjectSessionSnapshot }
  | { type: 'canvas.changed'; projectId: string; projectRevision: number; canvas: CanvasDocument; projection: CanvasProjection }
  | { type: 'canvas.feedback.changed'; projectId: string; projectRevision: number; feedback: CanvasFeedbackDocument }
  | { type: 'generatedAsset.metadata.changed'; projectId: string; projectRevision: number; record: GeneratedAssetRecord }
  | { type: 'llm.settings.changed'; settings: LlmProviderSettingsView }
  | { type: 'imageModel.settings.changed'; settings: ImageModelSettingsView }
  | { type: 'videoModel.settings.changed'; settings: VideoModelSettingsView }
  | { type: 'integrations.settings.changed'; settings: IntegrationSettingsView }
  | { type: 'adobeBridge.settings.changed'; settings: AdobeBridgeSettings }
  | { type: 'adobeBridge.state.changed'; state: AdobeBridgeStateView };

export interface WorkbenchApiClient {
  readonly mode: 'web' | 'desktop';
  readonly clientId: string;
  adobeBridgeGetState(): Promise<AdobeBridgeStateView>;
  adobeBridgeSaveSettings(input: SaveAdobeBridgeSettingsInput): Promise<AdobeBridgeStateView>;
  adobeBridgeLinkPhotoshop(input: CreateAdobeBridgeLinkInput): Promise<AdobeBridgeStateView>;
  adobeBridgeUnlinkPhotoshop(adobeClientId: string): Promise<AdobeBridgeStateView>;
  sendProjectFileToPhotoshop(input: SendProjectFileToPhotoshopInput): Promise<SendProjectFileToPhotoshopResult>;
  chooseProjectRoot(): Promise<string | undefined>;
  openProjectFromShell(input: { forceNewWindow: boolean }): Promise<{ opened: boolean }>;
  openProject(input: { projectRoot: string } | { projectId: string }): Promise<WorkbenchProjectOpenResult>;
  getSnapshot(): Promise<WorkbenchProjectRefreshResult>;
  getProjectHealth(): Promise<ProjectHealthSummary>;
  listTerminalSessions(): Promise<TerminalSessionList>;
  createTerminalSession(input?: CreateTerminalSessionInput): Promise<TerminalSessionResult>;
  writeTerminalInput(input: TerminalInputWrite): Promise<{ ok: true }>;
  resizeTerminal(input: TerminalResize): Promise<TerminalSessionResult>;
  restartTerminalSession(input: RestartTerminalSessionInput): Promise<TerminalSessionResult>;
  closeTerminalSession(input: CloseTerminalSessionInput): Promise<{ ok: true }>;
  subscribeTerminalEvents(
    terminalId: string,
    listener: (event: TerminalEvent) => void,
    onError?: (error: Error) => void
  ): TerminalEventSubscription;
  readProjectTextFile(projectRelativePath: string): Promise<WorkbenchProjectTextFile>;
  writeProjectTextFile(projectRelativePath: string, content: string): Promise<WorkbenchProjectTextFileWriteResult>;
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
  updateCanvasFeedbackEntry(input: UpdateCanvasFeedbackEntryInput): Promise<WorkbenchCanvasFeedbackMutationResult>;
  refreshProject(): Promise<WorkbenchProjectRefreshResult>;
  createCanvas(): Promise<WorkbenchCanvasManagementResult>;
  renameCanvas(input: { canvasId: string; nextCanvasId: string }): Promise<WorkbenchCanvasManagementResult>;
  deleteCanvas(input: { canvasId: string }): Promise<WorkbenchCanvasManagementResult>;
  reorderCanvases(input: { canvasOrder: string[] }): Promise<WorkbenchCanvasManagementResult>;
  repairCanvasIndex(): Promise<WorkbenchCanvasManagementResult>;
  addProjectPathToCanvasMap(input: AddProjectPathToCanvasMapInput): Promise<WorkbenchAddProjectPathToCanvasMapResult>;
  updateCanvasNodeLayouts(input: {
    canvasId: string;
    nodeLayouts?: Array<{ projectRelativePath: string; x: number; y: number; width?: number; height?: number }>;
  }): Promise<WorkbenchCanvasDocumentMutationResult>;
  resetCanvasNodeLayouts(input: ResetCanvasNodeLayoutsInput): Promise<WorkbenchCanvasResetLayoutResult>;
  updateCanvasNodeLayers(input: {
    canvasId: string;
    nodeProjectRelativePathsTopFirst?: string[];
  }): Promise<WorkbenchCanvasDocumentMutationResult>;
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
