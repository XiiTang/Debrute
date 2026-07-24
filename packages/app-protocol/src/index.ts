import type {
  CanvasDocument,
  CanvasFeedbackDocument,
  CanvasFeedbackGeometry,
  CanvasProjection,
  ProjectDiagnostic,
  UpdateCanvasFeedbackEntryInput
} from '@debrute/canvas-core';
import type {
  DebruteProjectMetadata,
  ProjectPathEntry,
  ProjectPathBatchOperationResult,
  ProjectTextFile,
  WriteProjectTextFileInput
} from './project.js';
import { PROJECT_TEXT_LANGUAGE_IDS } from './project.js';
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
export { PROJECT_TEXT_LANGUAGE_IDS } from './project.js';

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

export interface WorkbenchProjectFileOperationResult extends ProjectPathEntry, RevisionedProjectResult {}

export interface WorkbenchProjectFileBatchOperationResult extends ProjectPathBatchOperationResult, RevisionedProjectResult {}

export interface WorkbenchCanvasManagementResult extends RevisionedProjectResult {
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

interface WorkbenchFeedbackWorkingCopyBase {
  itemId: string;
  createdAt: string;
  projectRelativePath: string;
  comment: string;
}

export type WorkbenchFeedbackWorkingCopy = WorkbenchFeedbackWorkingCopyBase & (
  | { kind: 'comment'; scope: 'file'; momentTimeSeconds?: never; geometry?: never }
  | { kind: 'comment'; scope: 'moment'; momentTimeSeconds: number; geometry?: never }
  | {
      kind: 'pin';
      scope: 'file';
      momentTimeSeconds?: never;
      geometry: Extract<CanvasFeedbackGeometry, { type: 'point' }>;
    }
  | {
      kind: 'pin';
      scope: 'moment';
      momentTimeSeconds: number;
      geometry: Extract<CanvasFeedbackGeometry, { type: 'point' }>;
    }
  | {
      kind: 'region';
      scope: 'file';
      momentTimeSeconds?: never;
      geometry: Extract<CanvasFeedbackGeometry, { type: 'rect' }>;
    }
  | {
      kind: 'region';
      scope: 'moment';
      momentTimeSeconds: number;
      geometry: Extract<CanvasFeedbackGeometry, { type: 'rect' }>;
    }
);

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

export interface WorkbenchAddProjectPathToCanvasMapResult extends RevisionedProjectResult {}

export interface WorkbenchCanvasDocumentMutationResult extends RevisionedProjectResult {}

export interface WorkbenchCanvasResetLayoutResult extends WorkbenchCanvasDocumentMutationResult {
  resetCount: number;
}

export interface WorkbenchCanvasFeedbackMutationResult extends RevisionedProjectResult {}

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

interface WorkbenchFileWatchEvent {
  projectRelativePath: string;
}

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

export type WorkbenchProjectConnectionFrame =
  | {
      type: 'project.bound';
      project: Omit<WorkbenchProjectOpenResult, 'workingCopies'>;
      workingCopies: WorkbenchWorkingCopies;
    }
  | {
      type: 'project.open_failed';
      projectId: string;
      error: { code: string; message: string };
    }
  | { type: 'project.preempted'; projectId: string };

const workbenchProjectConnectionFrameValidators = {
  'project.bound': (value) => isProtocolObject(value.project)
    && typeof value.project.projectId === 'string'
    && isNonNegativeInteger(value.project.projectRevision)
    && isWorkbenchProjectSessionSnapshotFor(value.project.snapshot, value.project.projectId)
    && isWorkbenchWorkingCopies(value.workingCopies),
  'project.open_failed': (value) => typeof value.projectId === 'string'
    && isProtocolObject(value.error)
    && typeof value.error.code === 'string'
    && typeof value.error.message === 'string',
  'project.preempted': (value) => typeof value.projectId === 'string'
} satisfies Record<
  WorkbenchProjectConnectionFrame['type'],
  (value: Record<string, unknown>) => boolean
>;

export function isRecognizedWorkbenchProjectConnectionFrame(
  value: unknown
): value is Record<string, unknown> & { type: WorkbenchProjectConnectionFrame['type'] } {
  return isProtocolObject(value)
    && typeof value.type === 'string'
    && Object.hasOwn(workbenchProjectConnectionFrameValidators, value.type);
}

export function decodeWorkbenchProjectConnectionFrame(
  value: unknown
): WorkbenchProjectConnectionFrame | undefined {
  if (!isRecognizedWorkbenchProjectConnectionFrame(value)) {
    return undefined;
  }
  const validator = workbenchProjectConnectionFrameValidators[value.type];
  return validator(value) ? value as unknown as WorkbenchProjectConnectionFrame : undefined;
}

const workbenchEventValidators = {
  'project.changed': (value) => isRevisionedProjectEvent(value)
    && isWorkbenchProjectSessionSnapshotFor(value.snapshot, value.projectId),
  'project.fileChanged': (value) => isRevisionedProjectEvent(value)
    && isProtocolObject(value.event)
    && typeof value.event.projectRelativePath === 'string'
    && isWorkbenchProjectSessionSnapshotFor(value.snapshot, value.projectId),
  'canvas.changed': (value) => isRevisionedProjectEvent(value)
    && isCanvasDocument(value.canvas)
    && isProtocolObject(value.canvas)
    && isCanvasProjection(value.projection)
    && isProtocolObject(value.projection)
    && value.canvas.id === value.projection.canvasId,
  'canvas.feedback.changed': (value) => isRevisionedProjectEvent(value)
    && isCanvasFeedbackDocument(value.feedback),
  'recentProjects.changed': (value) => Array.isArray(value.recentProjects),
  'globalSettings.changed': (value) => isProtocolObject(value.settings),
  'integrations.changed': (value) => isProtocolObject(value.integrations),
  'adobeBridge.state.changed': (value) => isProtocolObject(value.state),
  'product.changed': (value) => value.product === null || isProtocolObject(value.product)
} satisfies Record<WorkbenchEvent['type'], (value: Record<string, unknown>) => boolean>;

export function isRecognizedWorkbenchEventFrame(
  value: unknown
): value is Record<string, unknown> & { type: WorkbenchEvent['type'] } {
  return isProtocolObject(value)
    && typeof value.type === 'string'
    && Object.hasOwn(workbenchEventValidators, value.type);
}

export function decodeWorkbenchEvent(value: unknown): WorkbenchEvent | undefined {
  if (!isRecognizedWorkbenchEventFrame(value)) {
    return undefined;
  }
  const validator = workbenchEventValidators[value.type];
  return validator(value) ? value as unknown as WorkbenchEvent : undefined;
}

export function isWorkbenchProjectSessionSnapshot(
  value: unknown
): value is WorkbenchProjectSessionSnapshot {
  if (!isProtocolObject(value)
    || !isProtocolObject(value.metadata)
    || !isProtocolObject(value.metadata.project)
    || typeof value.metadata.project.id !== 'string'
    || typeof value.metadata.project.name !== 'string'
    || typeof value.metadata.project.createdAt !== 'string'
    || typeof value.metadata.project.updatedAt !== 'string'
    || !Array.isArray(value.files)
    || !value.files.every(isProjectPathEntry)
    || !Array.isArray(value.canvases)
    || !value.canvases.every(isCanvasDocument)
    || !Array.isArray(value.projections)
    || !value.projections.every(isCanvasProjection)
    || !Array.isArray(value.diagnostics)
    || !value.diagnostics.every(isProjectDiagnostic)
    || !isCanvasRegistryState(value.canvasRegistry)
    || !isProtocolObject(value.canvasRegistry)
    || !isProtocolObject(value.health)
    || typeof value.health.projectName !== 'string'
    || !isNonNegativeInteger(value.health.canvasCount)
    || value.health.canvasCount !== value.canvases.length
    || value.health.projectName !== value.metadata.project.name
    || !isProtocolObject(value.health.diagnosticCounts)
    || !isNonNegativeInteger(value.health.diagnosticCounts.errors)
    || !isNonNegativeInteger(value.health.diagnosticCounts.warnings)
    || typeof value.health.checkedAt !== 'string'
  ) {
    return false;
  }
  return hasClosedCanvasTopology(value.canvases, value.projections, value.canvasRegistry);
}

function isWorkbenchProjectSessionSnapshotFor(value: unknown, projectId: unknown): boolean {
  return typeof projectId === 'string'
    && isWorkbenchProjectSessionSnapshot(value)
    && value.metadata.project.id === projectId;
}

function hasClosedCanvasTopology(
  canvases: unknown[],
  projections: unknown[],
  canvasRegistry: Record<string, unknown>
): boolean {
  const canvasIds = canvases.map((canvas) => isProtocolObject(canvas) ? canvas.id : undefined);
  const projectionIds = projections.map(
    (projection) => isProtocolObject(projection) ? projection.canvasId : undefined
  );
  if (
    canvasIds.some((id) => typeof id !== 'string')
    || projectionIds.some((id) => typeof id !== 'string')
    || new Set(canvasIds).size !== canvasIds.length
    || new Set(projectionIds).size !== projectionIds.length
    || canvasIds.length !== projectionIds.length
  ) {
    return false;
  }
  const canvasIdSet = new Set(canvasIds);
  if (!projectionIds.every((id) => canvasIdSet.has(id))) {
    return false;
  }
  if (canvasRegistry.status !== 'ready') {
    return true;
  }
  if (!Array.isArray(canvasRegistry.canvasOrder)) {
    return false;
  }
  return canvasRegistry.canvasOrder.length === canvasIds.length
    && new Set(canvasRegistry.canvasOrder).size === canvasRegistry.canvasOrder.length
    && canvasRegistry.canvasOrder.every((id) => typeof id === 'string' && canvasIdSet.has(id));
}

export function isWorkbenchWorkingCopies(value: unknown): value is WorkbenchWorkingCopies {
  return isProtocolObject(value)
    && isProtocolObject(value.text)
    && Object.entries(value.text).every(([projectRelativePath, workingCopy]) => (
      isTextWorkingCopy(workingCopy)
      && isProtocolObject(workingCopy)
      && workingCopy.projectRelativePath === projectRelativePath
    ))
    && isProtocolObject(value.feedback)
    && Object.entries(value.feedback).every(([itemId, workingCopy]) => (
      isFeedbackWorkingCopy(workingCopy)
      && isProtocolObject(workingCopy)
      && workingCopy.itemId === itemId
    ));
}

function isRevisionedProjectEvent(value: Record<string, unknown>): boolean {
  return typeof value.projectId === 'string'
    && isNonNegativeInteger(value.projectRevision);
}

function isProjectPathEntry(value: unknown): boolean {
  return isProtocolObject(value)
    && typeof value.projectRelativePath === 'string'
    && (value.kind === 'file' || value.kind === 'directory');
}

function isCanvasDocument(value: unknown): boolean {
  return isProtocolObject(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && Array.isArray(value.nodeElements)
    && value.nodeElements.every(isCanvasNode)
    && Array.isArray(value.annotations)
    && value.annotations.every(isCanvasAnnotation)
    && isProtocolObject(value.preferences)
    && typeof value.preferences.showDiagnostics === 'boolean';
}

function isCanvasProjection(value: unknown): boolean {
  return isProtocolObject(value)
    && typeof value.canvasId === 'string'
    && Array.isArray(value.nodes)
    && value.nodes.every(isProjectedCanvasNode)
    && Array.isArray(value.edges)
    && value.edges.every(isCanvasEdge)
    && Array.isArray(value.diagnostics)
    && value.diagnostics.every(isProjectDiagnostic);
}

function isProjectedCanvasNode(value: unknown): boolean {
  if (!isCanvasNode(value)
    || !isProtocolObject(value)
    || !isCanvasNodeAvailability(value.availability)
    || !isProtocolObject(value.availability)
  ) {
    return false;
  }
  if (value.videoPresentation !== undefined && !isCanvasVideoPresentation(value.videoPresentation)) {
    return false;
  }
  return value.mediaKind !== 'video'
    || value.availability.state !== 'available'
    || isCanvasVideoPresentation(value.videoPresentation);
}

function isCanvasNode(value: unknown): boolean {
  return isProtocolObject(value)
    && typeof value.projectRelativePath === 'string'
    && (value.nodeKind === 'file' || value.nodeKind === 'directory')
    && (value.mediaKind === undefined || isCanvasMediaKind(value.mediaKind))
    && isFiniteNumber(value.x)
    && isFiniteNumber(value.y)
    && isFiniteNumber(value.width)
    && isFiniteNumber(value.height)
    && isFiniteNumber(value.z)
    && (value.layoutMode === undefined || value.layoutMode === 'manual')
    && (value.videoPlayback === undefined || (
      isProtocolObject(value.videoPlayback)
      && isFiniteNumber(value.videoPlayback.currentTimeSeconds)
      && value.videoPlayback.currentTimeSeconds >= 0
    ))
    && (value.textViewport === undefined || (
      isProtocolObject(value.textViewport)
      && isFiniteNumber(value.textViewport.scrollTop)
      && isFiniteNumber(value.textViewport.scrollLeft)
    ));
}

function isCanvasMediaKind(value: unknown): boolean {
  return value === 'image'
    || value === 'video'
    || value === 'audio'
    || value === 'text'
    || value === 'unknown';
}

function isCanvasNodeAvailability(value: unknown): boolean {
  if (!isProtocolObject(value) || typeof value.state !== 'string') {
    return false;
  }
  if (value.state === 'missing' || value.state === 'unreadable') {
    return typeof value.message === 'string';
  }
  return value.state === 'available'
    && isFiniteNumber(value.size)
    && typeof value.mimeType === 'string'
    && typeof value.fileUrl === 'string'
    && typeof value.revision === 'string'
    && (value.canvasImagePreviewable === undefined || typeof value.canvasImagePreviewable === 'boolean')
    && (value.canvasImagePreviewSourceWidth === undefined || isFiniteNumber(value.canvasImagePreviewSourceWidth))
    && (value.mtimeMs === undefined || isFiniteNumber(value.mtimeMs));
}

function isCanvasVideoPresentation(value: unknown): boolean {
  return isProtocolObject(value)
    && value.kind === 'video'
    && isFiniteNumber(value.width)
    && isFiniteNumber(value.height)
    && (value.durationSeconds === undefined || isFiniteNumber(value.durationSeconds))
    && Array.isArray(value.textTracks)
    && value.textTracks.every(isCanvasVideoTextTrack);
}

function isCanvasVideoTextTrack(value: unknown): boolean {
  return isProtocolObject(value)
    && typeof value.projectRelativePath === 'string'
    && (value.fileUrl === undefined || typeof value.fileUrl === 'string')
    && typeof value.revision === 'string'
    && (
      value.kind === 'subtitles'
      || value.kind === 'captions'
      || value.kind === 'chapters'
      || value.kind === 'metadata'
    )
    && typeof value.label === 'string'
    && (value.srclang === undefined || typeof value.srclang === 'string')
    && typeof value.default === 'boolean';
}

function isCanvasAnnotation(value: unknown): boolean {
  return isProtocolObject(value)
    && typeof value.id === 'string'
    && typeof value.text === 'string'
    && isFiniteNumber(value.x)
    && isFiniteNumber(value.y);
}

function isCanvasEdge(value: unknown): boolean {
  return isProtocolObject(value)
    && typeof value.id === 'string'
    && typeof value.sourceProjectRelativePath === 'string'
    && typeof value.targetProjectRelativePath === 'string';
}

function isProjectDiagnostic(value: unknown): boolean {
  return isProtocolObject(value)
    && typeof value.id === 'string'
    && (value.severity === 'error' || value.severity === 'warning')
    && typeof value.code === 'string'
    && typeof value.message === 'string'
    && (value.filePath === undefined || typeof value.filePath === 'string')
    && (value.line === undefined || isFiniteNumber(value.line))
    && (value.column === undefined || isFiniteNumber(value.column))
    && (value.entityId === undefined || typeof value.entityId === 'string');
}

function isCanvasRegistryState(value: unknown): boolean {
  if (!isProtocolObject(value)) {
    return false;
  }
  if (value.status === 'ready') {
    return Array.isArray(value.canvasOrder)
      && value.canvasOrder.every((canvasId) => typeof canvasId === 'string');
  }
  return value.status === 'invalid'
    && (
      value.code === 'canvas_registry_missing'
      || value.code === 'canvas_registry_invalid'
      || value.code === 'canvas_registry_conflict'
      || value.code === 'canvas_registry_repair_failed'
    )
    && typeof value.message === 'string';
}

function isCanvasFeedbackDocument(value: unknown): boolean {
  return isProtocolObject(value)
    && typeof value.updatedAt === 'string'
    && isProtocolObject(value.entries)
    && Object.entries(value.entries).every(([projectRelativePath, entry]) => isProtocolObject(entry)
      && typeof entry.projectRelativePath === 'string'
      && entry.projectRelativePath === projectRelativePath
      && Array.isArray(entry.marks)
      && entry.marks.every(isCanvasFeedbackMark)
      && isNonNegativeInteger(entry.nextMomentLabel)
      && isNonNegativeInteger(entry.nextSpatialLabel)
      && Array.isArray(entry.items)
      && entry.items.every(isCanvasFeedbackItem)
      && typeof entry.updatedAt === 'string');
}

function isCanvasFeedbackItem(value: unknown): boolean {
  if (!isProtocolObject(value)
    || typeof value.id !== 'string'
    || typeof value.comment !== 'string'
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string'
  ) {
    return false;
  }
  if (value.kind === 'comment') {
    return value.label === undefined
      && value.geometry === undefined
      && (
        (value.scope === 'file' && value.moment === undefined)
        || (value.scope === 'moment' && isCanvasFeedbackMoment(value.moment))
      );
  }
  if (value.kind !== 'pin' && value.kind !== 'region') {
    return false;
  }
  return (
    (value.scope === 'file' && value.moment === undefined)
    || (value.scope === 'moment' && isCanvasFeedbackMoment(value.moment))
  )
    && isNonNegativeInteger(value.label)
    && isCanvasFeedbackGeometry(value.geometry)
    && isProtocolObject(value.geometry)
    && (value.kind === 'pin' ? value.geometry.type === 'point' : value.geometry.type === 'rect');
}

function isCanvasFeedbackMark(value: unknown): boolean {
  return value === 'like'
    || value === 'dislike'
    || value === 'check'
    || value === 'cross'
    || value === 'pending'
    || value === 'important'
    || value === 'needs_revision';
}

function isCanvasFeedbackMoment(value: unknown): boolean {
  return isProtocolObject(value)
    && typeof value.label === 'string'
    && isFiniteNumber(value.currentTimeSeconds)
    && value.currentTimeSeconds >= 0;
}

function isCanvasFeedbackGeometry(value: unknown): boolean {
  if (!isProtocolObject(value) || !isFiniteNumber(value.x) || !isFiniteNumber(value.y)) {
    return false;
  }
  if (value.x < 0 || value.x > 1 || value.y < 0 || value.y > 1) {
    return false;
  }
  if (value.type === 'point') {
    return true;
  }
  return value.type === 'rect'
    && isFiniteNumber(value.width)
    && isFiniteNumber(value.height)
    && value.width > 0
    && value.height > 0
    && value.x + value.width <= 1
    && value.y + value.height <= 1;
}

function isTextWorkingCopy(value: unknown): boolean {
  return isProtocolObject(value)
    && typeof value.projectRelativePath === 'string'
    && typeof value.content === 'string'
    && typeof value.language === 'string'
    && (PROJECT_TEXT_LANGUAGE_IDS as readonly string[]).includes(value.language)
    && typeof value.baseRevision === 'string';
}

function isFeedbackWorkingCopy(value: unknown): boolean {
  if (!isProtocolObject(value)
    || typeof value.itemId !== 'string'
    || typeof value.createdAt !== 'string'
    || typeof value.projectRelativePath !== 'string'
    || typeof value.comment !== 'string'
    || (value.kind !== 'comment' && value.kind !== 'pin' && value.kind !== 'region')
    || (value.scope !== 'file' && value.scope !== 'moment')
  ) {
    return false;
  }
  if (value.scope === 'moment') {
    if (!isFiniteNumber(value.momentTimeSeconds) || value.momentTimeSeconds < 0) {
      return false;
    }
  } else if (value.momentTimeSeconds !== undefined) {
    return false;
  }
  if (value.kind === 'comment') {
    return value.geometry === undefined;
  }
  return isCanvasFeedbackGeometry(value.geometry)
    && isProtocolObject(value.geometry)
    && (value.kind === 'pin' ? value.geometry.type === 'point' : value.geometry.type === 'rect');
}

function isProtocolObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

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
  onConnectionEnded(listener: (error: Error) => void): () => void;
  dispose(): void;
}
