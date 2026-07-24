import type {
  CanvasDocument,
  CanvasFeedbackDocument,
  CanvasProjection,
  ProjectDiagnostic,
  UpdateCanvasFeedbackEntryInput
} from '@debrute/canvas-core';
import type {
  DebruteProjectMetadata,
  NormalizedFileWatchEvent,
  ProjectPathEntry,
  ProjectPathBatchOperationResult,
  ProjectTextFile,
  WriteProjectTextFileInput
} from './project.js';
import type { DebruteProductPlatform } from './productPlatform.js';

export * from './runtimeControl.js';
export { parseDebruteWorkbenchPath, type DebruteWorkbenchRoute } from './workbenchRoute.js';
export type { DebruteShellApi, NativeWindowState } from './desktopShell.js';
export type { DebruteProductPlatform } from './productPlatform.js';
export type {
  ProjectPathEntry,
  ProjectTextLanguageId,
  WriteProjectTextFileInput
} from './project.js';

export type { NativeMenuCommandId } from './workbenchChrome.js';

interface ProjectHealthSummary {
  projectName: string;
  canvasCount: number;
  diagnosticCounts: {
    errors: number;
    warnings: number;
  };
  runtimeDataLocation: string;
  checkedAt: string;
}

type CanvasRegistryErrorCode =
  | 'canvas_registry_missing'
  | 'canvas_registry_invalid'
  | 'canvas_registry_conflict'
  | 'canvas_registry_repair_failed';

type CanvasRegistryState =
  | {
      status: 'ready';
      canvasOrder: string[];
    }
  | {
      status: 'invalid';
      code: CanvasRegistryErrorCode;
      message: string;
    };

interface ProjectSessionSnapshot {
  projectRoot: string;
  metadata: DebruteProjectMetadata;
  files: ProjectPathEntry[];
  canvases: CanvasDocument[];
  projections: CanvasProjection[];
  diagnostics: ProjectDiagnostic[];
  canvasRegistry: CanvasRegistryState;
  health: ProjectHealthSummary;
}

export type WorkbenchProjectHealthSummary = Omit<ProjectHealthSummary, 'runtimeDataLocation'>;
export type WorkbenchProjectSessionSnapshot = Omit<ProjectSessionSnapshot, 'projectRoot' | 'health'> & {
  health: WorkbenchProjectHealthSummary;
};
export type WorkbenchProjectTextFile = Omit<ProjectTextFile, 'absolutePath'>;

interface RevisionedProjectResult {
  projectId: string;
  projectRevision: number;
}


export interface DebruteHttpErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type WorkbenchLocale = 'en' | 'zh-CN';
export type WorkbenchThemePreference = 'system' | 'dark' | 'light';
export type DebruteDefaultFrontend = 'desktop' | 'browser' | 'runtime-only';

interface RecentProjectView {
  projectId: string;
  projectRoot: string;
}

interface DebruteGlobalWorkbenchSettings {
  locale: WorkbenchLocale;
  themePreference: WorkbenchThemePreference;
  defaultFrontend: DebruteDefaultFrontend;
}

interface DebruteGlobalChromeSettings {
  recentProjects: RecentProjectView[];
}

export interface DebruteGlobalAdobeBridgeSettings {
  enabled: boolean;
}

export interface DebruteGlobalSettingsView {
  workbench: DebruteGlobalWorkbenchSettings;
  chrome: DebruteGlobalChromeSettings;
  models: {
    image: ImageModelSettingRecord[];
    video: VideoModelSettingRecord[];
    audio: AudioModelSettingRecord[];
  };
  integrations: IntegrationSettingsView;
  adobeBridge: DebruteGlobalAdobeBridgeSettings;
}

export interface SaveDebruteGlobalSettingsInput {
  workbench?: Partial<DebruteGlobalWorkbenchSettings>;
  modelSetting?: { modelId: string; setting: SaveModelSettingInput };
  adobeBridge?: SaveAdobeBridgeSettingsInput;
}

export interface WorkbenchProjectFileOperationResult extends ProjectPathEntry, RevisionedProjectResult {
  snapshot: WorkbenchProjectSessionSnapshot;
}

export interface WorkbenchProjectFileBatchOperationResult extends ProjectPathBatchOperationResult, RevisionedProjectResult {
  snapshot: WorkbenchProjectSessionSnapshot;
}

export interface WorkbenchCanvasManagementResult extends RevisionedProjectResult {
  snapshot: WorkbenchProjectSessionSnapshot;
  activeCanvasId?: string;
}

interface WorkbenchProjectCopyPathsInput {
  entries: ProjectPathEntry[];
  targetDirectoryProjectRelativePath: string;
}

interface WorkbenchProjectMovePathsInput extends WorkbenchProjectCopyPathsInput {
  overwrite?: boolean;
}

interface WorkbenchProjectDeletePathsInput {
  entries: ProjectPathEntry[];
}

interface WorkbenchProjectAbsolutePathsResult {
  paths: string[];
}

interface WorkbenchProjectExternalLocalImportInput {
  sources: string[];
  targetDirectoryProjectRelativePath: string;
  overwrite?: boolean;
}

type WorkbenchProjectUploadImportEntry =
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

export interface RuntimeProjectUploadImportPlan {
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
  workingCopies: WorkbenchWorkingCopies;
}

type WorkbenchProjectOpenOutcome =
  | WorkbenchProjectOpenResult
  | { outcome: 'focused_existing_desktop'; projectId: string };

export interface WorkbenchTextWorkingCopy {
  projectRelativePath: string;
  content: string;
  language: WorkbenchProjectTextFile['language'];
  baseRevision: string;
}

export interface WorkbenchFeedbackWorkingCopy {
  itemId: string;
  createdAt: string;
  projectRelativePath: string;
  kind: 'comment' | 'pin' | 'region';
  scope: 'file' | 'moment';
  momentTimeSeconds?: number | undefined;
  geometry?: import('@debrute/canvas-core').CanvasFeedbackGeometry | undefined;
  comment: string;
}

export interface WorkbenchWorkingCopies {
  text: Record<string, WorkbenchTextWorkingCopy>;
  feedback: Record<string, WorkbenchFeedbackWorkingCopy>;
}

type WorkbenchProjectPickerOpenResult =
  | { opened: false }
  | ({ opened: true } & WorkbenchProjectOpenOutcome);

export interface WorkbenchProjectTextFileWriteResult extends RevisionedProjectResult {
  file: WorkbenchProjectTextFile;
}

interface CanvasTextPreviewSourceTarget {
  projectRelativePath: string;
  fingerprint: string;
}

type CanvasTextPreviewSourceAvailabilityView = CanvasTextPreviewSourceTarget & (
  | { status: 'available' }
  | { status: 'missing' }
  | { status: 'error'; message: string }
);

export interface SaveCanvasTextPreviewSourceInput extends CanvasTextPreviewSourceTarget {
  canvasId: string;
  sourcePng: Blob;
}

export interface SaveCanvasTextPreviewSourceResult {
  ok: true;
  source: CanvasTextPreviewSourceTarget & { status: 'available' };
}

export interface CanvasTextPreviewSourceAvailabilityRequest {
  canvasId: string;
  sources: CanvasTextPreviewSourceTarget[];
}

export interface CanvasTextPreviewSourceAvailabilityResponse {
  sources: Record<string, CanvasTextPreviewSourceAvailabilityView>;
}

type CanvasVideoPreviewSourceKind =
  | 'initial-poster'
  | 'playback-frame';

interface CanvasVideoPreviewSourceTarget {
  projectRelativePath: string;
  videoRevision: string;
  currentTimeSeconds: number;
}

export type CanvasVideoPreviewSourceView = CanvasVideoPreviewSourceTarget & (
  | {
      status: 'available';
      sourceKind: CanvasVideoPreviewSourceKind;
      sourceKey: string;
      sourceWidth: number;
    }
  | {
      status: 'error';
      sourceKind: CanvasVideoPreviewSourceKind;
      message: string;
    }
);

export interface CanvasVideoPreviewSourceRequest {
  canvasId: string;
  targets: CanvasVideoPreviewSourceTarget[];
}

export interface CanvasVideoPreviewSourceResponse {
  sources: Record<string, CanvasVideoPreviewSourceView>;
}

export interface UpdateCanvasVideoPlaybackStateInput {
  canvasId: string;
  updates: Array<{
    projectRelativePath: string;
    currentTimeSeconds: number;
  }>;
}

export interface UpdateCanvasTextViewportStateInput {
  canvasId: string;
  updates: Array<{
    projectRelativePath: string;
    scrollTop: number;
    scrollLeft: number;
  }>;
}

interface ApiKeySettingState {
  apiKeySet: boolean;
}

export type ImageModelSettingRecord = {
  debruteModelId: string;
  summary: string;
  supportsEditing: boolean;
  supportsTextRendering: boolean;
  defaultBaseUrl: string;
  defaultRequestModelId: string;
  baseUrlOverride: string | null;
  requestModelIdOverride: string | null;
} & ApiKeySettingState;

export interface SaveModelSettingInput {
  baseUrlOverride: string | null;
  requestModelIdOverride: string | null;
  apiKey?: string;
}

export interface RevealModelApiKeyResponse {
  apiKey: string;
}

export type VideoModelSettingRecord = {
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
} & ApiKeySettingState;

export type AudioModelKind = 'tts' | 'music' | 'sound-effect';

export type AudioModelSettingRecord = {
  debruteModelId: string;
  kind: AudioModelKind;
  summary: string;
  defaultBaseUrl: string;
  defaultRequestModelId: string;
  baseUrlOverride: string | null;
  requestModelIdOverride: string | null;
} & ApiKeySettingState;

type IntegrationId = 'ffmpeg' | 'imagemagick' | 'mediainfo' | 'exiftool' | 'remove-ai-watermarks';
type IntegrationBinaryId = 'ffmpeg' | 'ffprobe' | 'magick' | 'mediainfo' | 'exiftool' | 'remove-ai-watermarks';
type IntegrationStatusKind = 'ready' | 'not_found' | 'probe_failed';
type IntegrationProbeErrorKind = 'spawn_error' | 'timeout' | 'nonzero_exit' | 'parse_error';
type IntegrationOperationFailureKind =
  | IntegrationProbeErrorKind
  | 'operation_already_running'
  | 'backend_unavailable'
  | 'integration_not_found'
  | 'operation_unavailable'
  | 'command_unavailable';
type SystemPackageManagerId = 'brew' | 'winget';
type PythonCliInstallerId = 'uv' | 'pipx';
export type IntegrationBackendId = SystemPackageManagerId | PythonCliInstallerId;
type IntegrationInstallBackendKind = 'system-package-manager' | 'python-cli-installer';
export type IntegrationOperationKind = 'install' | 'update' | 'uninstall';

export interface IntegrationOperationDiagnostic {
  exitCode?: number;
  errorKind?: IntegrationOperationFailureKind;
  stdoutTail?: string;
  stderrTail?: string;
}

export interface IntegrationOperationInFlight {
  integrationId: IntegrationId;
  operation: IntegrationOperationKind;
}

export interface RunIntegrationOperationInput {
  integrationId: IntegrationId;
  operation: IntegrationOperationKind;
}

export interface RunIntegrationOperationResult {
  ok: boolean;
  integrationId: IntegrationId;
  operation: IntegrationOperationKind;
  diagnostic?: IntegrationOperationDiagnostic;
}

export interface IntegrationBackendStatus {
  kind: IntegrationInstallBackendKind;
  backend?: IntegrationBackendId;
  available: boolean;
  unavailableReason?: string;
}

interface IntegrationOperationStatus {
  backendKind: IntegrationInstallBackendKind;
  backend?: IntegrationBackendId;
  packageName?: string;
  availableOperations: IntegrationOperationKind[];
  installedVersion?: string;
  latestVersion?: string;
  unavailableReason?: string;
  queryDiagnostic?: IntegrationOperationDiagnostic;
}

interface IntegrationBinaryStatus {
  binaryId: IntegrationBinaryId;
  displayName: string;
  status: IntegrationStatusKind;
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
  runningOperation?: IntegrationOperationInFlight;
}

export type ManagedCliDiagnostic =
  | {
      status: 'ready';
      version: string;
      path: string;
      skillsVersion: string;
      skillsRoot: string;
    }
  | {
      status: 'error';
      version: string;
      path?: string;
      message: string;
      logPath?: string;
    };

type ProductUpdateOperation = 'check' | 'apply';

export type ProductUpdateState =
  | {
      type: 'idle';
      currentVersion: string;
      lastCheckedAt?: string;
      updateAvailable: false;
    }
  | {
      type: 'checking';
      currentVersion: string;
    }
  | {
      type: 'available';
      currentVersion: string;
      updateVersion: string;
      releaseName?: string;
      releaseDate?: string;
    }
  | {
      type: 'installing';
      currentVersion: string;
      updateVersion: string;
    }
  | {
      type: 'error';
      currentVersion: string;
      operation: ProductUpdateOperation;
      message: string;
      updateVersion?: string;
      logPath?: string;
    };

export interface DebruteProductState {
  productVersion: string;
  platform: DebruteProductPlatform;
  cli: ManagedCliDiagnostic;
  update: ProductUpdateState;
}

type GeneratedArtifactRole =
  | 'primary-image'
  | 'primary-video'
  | 'last-frame'
  | 'tts-audio'
  | 'music-audio'
  | 'sound-effect-audio'
  | 'other';

export interface GeneratedAssetRecord {
  recordId: string;
  modelRunId: string;
  projectRelativePath: string;
  createdAt: string;
  artifactRole: GeneratedArtifactRole;
  artifactIndex: number;
  fingerprint: {
    algorithm: 'sha256';
    hash: string;
  };
  modelRun: {
    request: unknown;
    output: unknown;
  };
}

interface GeneratedAssetMetadataDiagnostic {
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
      diagnostics: GeneratedAssetMetadataDiagnostic[];
    }
  | {
      status: 'unmatched';
      fingerprint: {
        algorithm: 'sha256';
        hash: string;
      };
      diagnostics: GeneratedAssetMetadataDiagnostic[];
    }
  | {
      status: 'unavailable';
      reason: 'missing' | 'unreadable' | 'metadata_unreadable';
      message: string;
      diagnostics: GeneratedAssetMetadataDiagnostic[];
    };

type TerminalSessionStatus = 'starting' | 'running' | 'terminating' | 'exited' | 'failed';

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
}

interface CreateTerminalSessionInput {
  cwdProjectRelativePath: string;
}

export interface TerminalSessionList {
  sessions: TerminalSessionView[];
}

export interface TerminalSessionResult {
  session: TerminalSessionView;
}

interface TerminalInputWrite {
  terminalId: string;
  data: string;
}

interface TerminalResize {
  terminalId: string;
  cols: number;
  rows: number;
}

interface CloseTerminalSessionInput {
  terminalId: string;
}

interface TerminalDataChunk {
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

export interface TerminalCheckpoint {
  version: number;
  terminalId: string;
  outputSequence: number;
  cols: number;
  rows: number;
  scrollbackRows: number;
  cursorRow: number;
  cursorCol: number;
  cursorHidden: boolean;
  alternateScreen: boolean;
  applicationCursor: boolean;
  applicationKeypad: boolean;
  bracketedPaste: boolean;
  title: string;
  ansiBase64: string;
}

export type TerminalServerFrame =
  | { type: 'sync'; protocolVersion: number; topologyRevision: number; sessions: TerminalSessionView[]; checkpoints: TerminalCheckpoint[] }
  | { type: 'observed'; checkpoint: TerminalCheckpoint }
  | { type: 'input-ack'; terminalId: string; sequence: number }
  | { type: 'resized'; terminalId: string; cols: number; rows: number }
  | { type: 'topology'; topologyRevision: number; sessions: TerminalSessionView[] }
  | { type: 'output'; terminalId: string; sequence: number; dataBase64: string }
  | { type: 'status'; session: TerminalSessionView }
  | { type: 'exit'; terminalId: string; exitCode: number | null; signal: string | null }
  | { type: 'error'; terminalId: string | null; code: string; message: string };

export interface AddProjectPathToCanvasMapInput {
  canvasId: string;
  projectRelativePath: string;
}

type ResetCanvasNodeLayoutsInput = {
  canvasId: string;
} & (
  | { all: true }
  | { pathRules: { paths: string[]; globs: string[] } }
);

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
  pluginInstanceId: string;
  hostApp: AdobeBridgeHostApp;
  hostVersion: string;
  clientRuntime: AdobeBridgeClientRuntime;
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
}

export interface AdobeBridgeLink {
  linkId: string;
  projectId: string;
  pluginInstanceId: string;
  createdAt: string;
  status: 'active' | 'adobe-offline' | 'project-offline';
}

export type AdobeBridgeTransferDirection = 'photoshop-to-debrute' | 'debrute-to-photoshop';
export type AdobeBridgeTransferStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface AdobeBridgeTransferView {
  transferId: string;
  direction: AdobeBridgeTransferDirection;
  projectId: string;
  pluginInstanceId: string;
  projectRelativePath: string | null;
  status: AdobeBridgeTransferStatus;
  errorCode?: AdobeBridgeErrorCode;
  message?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdobeBridgeStateView {
  settings: AdobeBridgeSettings;
  pairedPlugins: Array<{
    pluginInstanceId: string;
    clientRuntime: AdobeBridgeClientRuntime;
    createdAt: string;
    connected: boolean;
  }>;
  clients: AdobeBridgeClient[];
  projects: ProjectBridgeClient[];
  links: AdobeBridgeLink[];
  transfers: AdobeBridgeTransferView[];
}

export interface SaveAdobeBridgeSettingsInput {
  enabled: boolean;
}

export interface CreateAdobeBridgeLinkInput {
  pluginInstanceId: string;
}

export interface SendProjectFileToPhotoshopInput {
  projectRelativePath: string;
  pluginInstanceId: string;
}

export interface SendProjectFileToPhotoshopResult {
  transfer: AdobeBridgeTransferView;
}

export interface PhotoshopBridgeHelloMessage {
  type: 'hello';
  pluginInstanceId: string;
  hostApp: 'photoshop';
  hostVersion: string;
  clientRuntime: AdobeBridgeClientRuntime;
  documentCount: number;
  activeDocumentTitle: string | null;
  signature: string;
  publicKey: string | null;
  pairingCode: string | null;
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

export interface PhotoshopBridgeChallengeMessage {
  type: 'bridge.challenge';
  bridgeVersion: number;
  productVersion: string;
  runtimeInstanceId: string;
  challenge: string;
}

export interface PhotoshopBridgeReadyMessage {
  type: 'bridge.ready';
  pluginSessionId: string;
  bearer: string;
  state: AdobeBridgeStateView;
}

export interface PhotoshopBridgeStateMessage {
  type: 'bridge.state';
  state: AdobeBridgeStateView;
}

export interface PhotoshopBridgeImportRequestMessage {
  type: 'transfer.import.request';
  transferId: string;
  projectId: string;
  projectRelativePath: string;
  fileName: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/vnd.adobe.photoshop';
  byteLength: number;
  downloadUrl: string;
}

export type PhotoshopBridgeRuntimeMessage =
  | PhotoshopBridgeChallengeMessage
  | PhotoshopBridgeReadyMessage
  | PhotoshopBridgeStateMessage
  | PhotoshopBridgeImportRequestMessage
  | { type: 'runtime_replacing'; runtimeInstanceId: string; deadline: string }
  | { type: 'bridge.error'; code: AdobeBridgeErrorCode; message: string };

export const adobeBridgeErrorCodes = [
  'adobe_bridge_disabled',
  'adobe_discovery_unavailable',
  'adobe_client_offline',
  'project_offline',
  'project_not_linked',
  'pairing_not_found',
  'pairing_expired',
  'pairing_code_invalid',
  'pairing_attempts_exceeded',
  'pairing_key_invalid',
  'pairing_signature_invalid',
  'pairing_registry_invalid',
  'pairing_capacity_reached',
  'plugin_session_invalid',
  'plugin_session_replaced',
  'target_directory_missing',
  'target_directory_not_visible',
  'unsupported_file_type',
  'upload_too_large',
  'invalid_transfer_payload',
  'transfer_capacity_reached',
  'no_active_document',
  'photoshop_place_failed',
  'transfer_url_expired',
  'transfer_timeout',
  'persistence_failed'
] as const;

export type AdobeBridgeErrorCode = typeof adobeBridgeErrorCodes[number];

export function isAdobeBridgeErrorCode(value: string): value is AdobeBridgeErrorCode {
  return (adobeBridgeErrorCodes as readonly string[]).includes(value);
}

type WorkbenchFileWatchEvent = Omit<NormalizedFileWatchEvent, 'absolutePath'>;

export type WorkbenchEvent =
  | { type: 'project.changed'; projectId: string; projectRevision: number; snapshot: WorkbenchProjectSessionSnapshot }
  | { type: 'project.fileChanged'; projectId: string; projectRevision: number; event: WorkbenchFileWatchEvent; snapshot: WorkbenchProjectSessionSnapshot }
  | { type: 'canvas.changed'; projectId: string; projectRevision: number; canvas: CanvasDocument; projection: CanvasProjection }
  | { type: 'canvas.feedback.changed'; projectId: string; projectRevision: number; feedback: CanvasFeedbackDocument }
  | { type: 'recentProjects.changed'; recentProjects: RecentProjectView[] }
  | { type: 'globalSettings.changed'; settings: DebruteGlobalSettingsView }
  | { type: 'integrations.changed'; integrations: IntegrationSettingsView }
  | { type: 'adobeBridge.state.changed'; state: AdobeBridgeStateView }
  | { type: 'product.changed'; product: DebruteProductState | null };

export interface WorkbenchApiClient {
  adobeBridgeGetState(): Promise<AdobeBridgeStateView>;
  adobeBridgeCreatePairing(): Promise<{ pairingId: string; code: string; expiresAt: string }>;
  adobeBridgeCancelPairing(pairingId: string): Promise<void>;
  adobeBridgeRemovePairing(pluginInstanceId: string): Promise<AdobeBridgeStateView>;
  adobeBridgeLinkPhotoshop(input: CreateAdobeBridgeLinkInput): Promise<AdobeBridgeStateView>;
  adobeBridgeUnlinkPhotoshop(pluginInstanceId: string): Promise<AdobeBridgeStateView>;
  sendProjectFileToPhotoshop(input: SendProjectFileToPhotoshopInput): Promise<SendProjectFileToPhotoshopResult>;
  openProject(
    input: { projectRoot: string; forceOpenHere?: boolean } | { projectId: string; forceOpenHere?: boolean }
  ): Promise<WorkbenchProjectOpenOutcome>;
  openProjectFromPicker(): Promise<WorkbenchProjectPickerOpenResult>;
  clearRecentProjectRoots(): Promise<{ ok: true }>;
  checkProductUpdate(): Promise<{ ok: true }>;
  applyProductUpdate(): Promise<{ ok: true }>;
  globalSettingsSave(input: SaveDebruteGlobalSettingsInput): Promise<{ ok: true }>;
  revealModelApiKey(modelId: string): Promise<RevealModelApiKeyResponse>;
  listTerminalSessions(): Promise<TerminalSessionList>;
  createTerminalSession(input: CreateTerminalSessionInput): Promise<TerminalSessionResult>;
  writeTerminalInput(input: TerminalInputWrite): Promise<{ ok: true }>;
  resizeTerminal(input: TerminalResize): Promise<TerminalSessionResult>;
  closeTerminalSession(input: CloseTerminalSessionInput): Promise<{ ok: true }>;
  subscribeTerminalEvents(
    terminalId: string,
    listener: (event: TerminalEvent) => void,
    onError: (error: Error) => void
  ): TerminalEventSubscription;
  readProjectTextFile(projectRelativePath: string): Promise<WorkbenchProjectTextFile>;
  writeProjectTextFile(input: WriteProjectTextFileInput): Promise<WorkbenchProjectTextFileWriteResult>;
  putTextWorkingCopy(projectId: string, input: WorkbenchTextWorkingCopy): Promise<WorkbenchTextWorkingCopy>;
  clearTextWorkingCopy(projectId: string, projectRelativePath: string): Promise<void>;
  putFeedbackWorkingCopy(projectId: string, input: WorkbenchFeedbackWorkingCopy): Promise<WorkbenchFeedbackWorkingCopy>;
  clearFeedbackWorkingCopy(projectId: string, itemId: string): Promise<void>;
  saveCanvasTextPreviewSource(input: SaveCanvasTextPreviewSourceInput): Promise<SaveCanvasTextPreviewSourceResult>;
  readCanvasTextPreviewSources(input: CanvasTextPreviewSourceAvailabilityRequest): Promise<CanvasTextPreviewSourceAvailabilityResponse>;
  readCanvasVideoPreviewSources(input: CanvasVideoPreviewSourceRequest): Promise<CanvasVideoPreviewSourceResponse>;
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
  readCanvasFeedback(): Promise<CanvasFeedbackDocument>;
  updateCanvasFeedbackEntry(input: UpdateCanvasFeedbackEntryInput): Promise<WorkbenchCanvasFeedbackMutationResult>;
  createCanvas(): Promise<WorkbenchCanvasManagementResult>;
  renameCanvas(input: { canvasId: string; name: string }): Promise<WorkbenchCanvasManagementResult>;
  deleteCanvas(input: { canvasId: string }): Promise<WorkbenchCanvasManagementResult>;
  reorderCanvases(input: { canvasOrder: string[] }): Promise<WorkbenchCanvasManagementResult>;
  repairCanvasIndex(): Promise<WorkbenchCanvasManagementResult>;
  addProjectPathToCanvasMap(input: AddProjectPathToCanvasMapInput): Promise<WorkbenchAddProjectPathToCanvasMapResult>;
  updateCanvasNodeLayouts(input: {
    canvasId: string;
    nodeLayouts: Array<{ projectRelativePath: string; x: number; y: number; width?: number; height?: number }>;
  }): Promise<WorkbenchCanvasDocumentMutationResult>;
  updateCanvasVideoPlaybackState(input: UpdateCanvasVideoPlaybackStateInput): Promise<WorkbenchCanvasDocumentMutationResult>;
  updateCanvasTextViewportState(input: UpdateCanvasTextViewportStateInput): Promise<WorkbenchCanvasDocumentMutationResult>;
  resetCanvasNodeLayouts(input: ResetCanvasNodeLayoutsInput): Promise<WorkbenchCanvasResetLayoutResult>;
  bringCanvasNodeToFront(input: {
    canvasId: string;
    projectRelativePath: string;
  }): Promise<WorkbenchCanvasDocumentMutationResult>;
  integrationsRescan(): Promise<{ ok: true }>;
  integrationsRunOperation(input: RunIntegrationOperationInput): Promise<RunIntegrationOperationResult>;
  onEvent(listener: (event: WorkbenchEvent) => void): () => void;
  onProjectDetached(listener: () => void): () => void;
  onConnectionEnded(listener: (error: Error) => void): () => void;
  dispose(): void;
}
