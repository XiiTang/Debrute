import type {
  ProjectPathEntry,
  ProjectPathBatchOperationResult,
  ProjectTextLanguageId,
  ProjectTreeEntry,
  ProjectTextFile,
  WriteProjectTextFileInput
} from './project.js';
import { PROJECT_TEXT_LANGUAGE_IDS } from './project.js';
import type { DebruteProductPlatform } from './productPlatform.js';
import {
  isPhotoshopMimeType,
  type PhotoshopMimeType
} from './photoshopPlugin.js';

export * from './runtimeControl.js';
export {
  PHOTOSHOP_BASELINE_PLACEMENT_MIME_TYPES,
  PHOTOSHOP_MAX_BATCH_BYTES,
  PHOTOSHOP_MAX_BATCH_ITEMS,
  PHOTOSHOP_MAX_FILE_BYTES,
  PHOTOSHOP_PORTS,
  PHOTOSHOP_WEBSOCKET_SUBPROTOCOL,
  decodePhotoshopHttpErrorEnvelope,
  parseRuntimeMessage,
  photoshopPlacementFormatForPath,
  serializePluginMessage,
  type PhotoshopDocumentSnapshot,
  type PhotoshopMimeType,
  type PhotoshopPlacementFormat,
  type PhotoshopPlacementRequirement,
  type PhotoshopProjectSnapshot,
  type PluginMessage,
  type RuntimeMessage
} from './photoshopPlugin.js';
export { parseDebruteWorkbenchPath, type DebruteWorkbenchRoute } from './workbenchRoute.js';
export type {
  DebruteShellApi,
  DesktopLaunchContext,
  NativeMenuCommandResult,
  NativeWindowState
} from './desktopShell.js';
export type { DebruteProductPlatform } from './productPlatform.js';
export type {
  ProjectPathEntry,
  ProjectTreeEntry,
  ProjectTextLanguageId,
  WriteProjectTextFileInput
} from './project.js';

export {
  workbenchCommandShortcutAccelerator,
  workbenchCommandShortcutLabel,
  workbenchCommandShortcutMatches,
  type NativeEditCommandId,
  type NativeMenuCommand,
  type NativeMenuCommandId
} from './workbenchChrome.js';

export type CanvasNodeKind = 'directory' | 'file';
export type CanvasMediaKind = 'image' | 'video' | 'audio' | 'text' | 'unknown';
type ProjectDiagnosticSeverity = 'error' | 'warning';

export interface ProjectDiagnostic {
  id: string;
  severity: ProjectDiagnosticSeverity;
  code: string;
  message: string;
  filePath?: string;
  line?: number;
  column?: number;
  entityId?: string;
}

interface CanvasManualLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasVideoPlaybackState {
  currentTimeMs: number;
}

export interface CanvasTextViewportState {
  scrollTop: number;
  scrollLeft: number;
}

export interface CanvasNodeState {
  manualLayout?: CanvasManualLayout;
  videoPlayback?: CanvasVideoPlaybackState;
  textViewport?: CanvasTextViewportState;
}

export interface CanvasState {
  expandedDirectories: string[];
  nodeStates: Record<string, CanvasNodeState>;
  occlusionOrder: string[];
}

interface CanvasNodeStateChange {
  projectRelativePath: string;
  state: CanvasNodeState | null;
}

export interface CanvasStateChange {
  nodeStates: CanvasNodeStateChange[];
  occlusionOrder?: string[];
}

type CanvasNodeAvailability =
  | {
      state: 'resolving';
      size: number;
      mimeType: string;
      sourceToken: string;
      canvasImagePreviewable?: boolean;
      canvasImagePreviewSourceWidth?: number;
    }
  | {
      state: 'available';
      size: number;
      mimeType: string;
      fileUrl: string;
      canvasImagePreviewable?: boolean;
      canvasImagePreviewSourceWidth?: number;
      revision: string;
    }
  | { state: 'missing'; message: string }
  | { state: 'unreadable'; message: string };

interface CanvasVideoTextTrack {
  projectRelativePath: string;
  fileUrl?: string;
  revision: string;
  kind: 'subtitles' | 'captions' | 'chapters' | 'metadata';
  label: string;
  srclang?: string;
  default: boolean;
}

interface CanvasImageDimensions {
  width: number;
  height: number;
}

type CanvasResource =
  | { projectRelativePath: string; nodeKind: 'directory' }
  | {
      projectRelativePath: string;
      nodeKind: 'file';
      mediaKind: CanvasMediaKind;
      availability: CanvasNodeAvailability;
      imageDimensions?: CanvasImageDimensions;
      textLanguage?: ProjectTextLanguageId;
    };

export interface CanvasResourceView {
  resources: CanvasResource[];
}

export type CanvasFeedbackVideoResource = Extract<CanvasResource, { nodeKind: 'file' }> & {
  mediaKind: 'video';
};

export interface CanvasFeedbackVideoResourceView {
  resources: CanvasFeedbackVideoResource[];
}

export interface CanvasSourceResolutionRequest {
  targets: Array<{
    projectRelativePath: string;
    sourceToken: string;
  }>;
}

export interface CanvasSourceResolutionResponse {
  sources: Array<{
    sourceToken: string;
    projectRelativePath: string;
    availability: CanvasNodeAvailability;
    videoTextTracks?: CanvasVideoTextTrack[];
  }>;
}

export type CanvasFeedbackMark = string;
export type CanvasFeedbackGeometry =
  | { type: 'point'; x: number; y: number }
  | { type: 'rect'; x: number; y: number; width: number; height: number };

interface CanvasFeedbackMomentRef {
  label: string;
  currentTimeSeconds: number;
}

interface CanvasFeedbackItemBase {
  id: string;
  comment: string;
  createdAt: string;
  updatedAt: string;
}

type CanvasFeedbackCommentItem =
  | (CanvasFeedbackItemBase & { kind: 'comment'; scope: 'node' })
  | (CanvasFeedbackItemBase & { kind: 'comment'; scope: 'moment'; moment: CanvasFeedbackMomentRef });

export type CanvasFeedbackSpatialItem =
  | (CanvasFeedbackItemBase & {
      kind: 'pin' | 'region';
      scope: 'node';
      label: number;
      geometry: CanvasFeedbackGeometry;
    })
  | (CanvasFeedbackItemBase & {
      kind: 'pin' | 'region';
      scope: 'moment';
      label: number;
      geometry: CanvasFeedbackGeometry;
      moment: CanvasFeedbackMomentRef;
    });

export type CanvasFeedbackItem = CanvasFeedbackCommentItem | CanvasFeedbackSpatialItem;

export interface CanvasFeedbackEntry {
  projectRelativePath: string;
  marks: CanvasFeedbackMark[];
  nextMomentLabel: number;
  nextSpatialLabel: number;
  items: CanvasFeedbackItem[];
  updatedAt: string;
}

export interface CanvasFeedbackDocument {
  updatedAt: string;
  entries: Record<string, CanvasFeedbackEntry>;
}

export type UpdateCanvasFeedbackInput =
  | { operation: 'set-mark'; projectRelativePaths: string[]; mark: CanvasFeedbackMark; selected: boolean }
  | {
      operation: 'add-item';
      projectRelativePath: string;
      item:
        | { id: string; createdAt: string; kind: 'comment'; scope: 'node'; comment: string }
        | { id: string; createdAt: string; kind: 'comment'; scope: 'moment'; momentTimeSeconds: number; comment: string }
        | { id: string; createdAt: string; kind: 'pin' | 'region'; scope: 'node'; geometry: CanvasFeedbackGeometry; comment: string }
        | { id: string; createdAt: string; kind: 'pin' | 'region'; scope: 'moment'; momentTimeSeconds: number; geometry: CanvasFeedbackGeometry; comment: string };
    }
  | { operation: 'update-item'; projectRelativePath: string; itemId: string; geometry?: CanvasFeedbackGeometry; comment?: string }
  | { operation: 'delete-item'; projectRelativePath: string; itemId: string };

export interface WorkbenchProjectHealthSummary {
  projectName: string;
  diagnosticCounts: {
    errors: number;
    warnings: number;
  };
  checkedAt: string;
}

interface CanvasWorkspaceDocument extends CanvasState {
  canonicalRoot: string;
}

const CANVAS_WORKSPACE_UNAVAILABLE_CODES = [
  'canvas_workspace_invalid',
  'canvas_workspace_unreadable',
  'canvas_workspace_root_mismatch',
  'canvas_workspace_persistence_failed'
] as const;

type CanvasWorkspaceUnavailableCode =
  typeof CANVAS_WORKSPACE_UNAVAILABLE_CODES[number];

type CanvasWorkspaceSnapshot =
  | {
      status: 'available';
      workspace: CanvasWorkspaceDocument;
      canvasResources: CanvasResourceView;
      feedbackVideoResources: CanvasFeedbackVideoResourceView;
    }
  | {
      status: 'unavailable';
      code: CanvasWorkspaceUnavailableCode;
      message: string;
    };

export interface WorkbenchProjectSessionSnapshot {
  canonicalRoot: string;
  projectTree: ProjectTreeEntry[];
  canvasWorkspace: CanvasWorkspaceSnapshot;
  diagnostics: ProjectDiagnostic[];
  health: WorkbenchProjectHealthSummary;
}

export type WorkbenchProjectTextFile = Omit<ProjectTextFile, 'absolutePath'>;

export interface RevisionedProjectResult {
  bindingId: string;
  projectRevision: number;
}


export interface DebruteHttpErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export type WorkbenchLocale = 'en' | 'zh-CN';
export type WorkbenchThemePreference = 'system' | 'dark' | 'light';
export type CanvasFontId =
  | 'noto-sans-mono-cjk-sc'
  | 'lilex'
  | 'jetbrains-mono'
  | 'ibm-plex-mono'
  | 'noto-sans-sc';

export interface CanvasTextAppearance {
  fontId: CanvasFontId;
  fontSizePx: number;
  lineHeightRatio: number;
  fontWeight: number;
  letterSpacingPx: number;
  ligatures: boolean;
}

interface DebruteGlobalWorkbenchSettings {
  locale: WorkbenchLocale;
  themePreference: WorkbenchThemePreference;
}

interface DebruteGlobalCanvasSettings {
  textAppearance: CanvasTextAppearance;
  hierarchyEdgesVisible: boolean;
}

interface DebruteGlobalChromeSettings {
  recentProjectRoots: string[];
}

interface DebruteGlobalPluginSettings {
  photoshop: {
    enabled: boolean;
  };
}

export interface FeedbackCatalogEntry {
  name: string;
  icon: string;
}

export interface DebruteGlobalFeedbackSettings {
  catalog: FeedbackCatalogEntry[];
  actionBar: string[];
}

export interface DebruteGlobalSettingsView {
  workbench: DebruteGlobalWorkbenchSettings;
  canvas: DebruteGlobalCanvasSettings;
  chrome: DebruteGlobalChromeSettings;
  plugins: DebruteGlobalPluginSettings;
  feedback: DebruteGlobalFeedbackSettings;
  models: {
    image: ModelSettingRecord[];
    video: ModelSettingRecord[];
    audio: AudioModelSettingRecord[];
  };
}

export type MutateDebruteGlobalSettingsInput =
  | { operation: 'set-locale'; locale: WorkbenchLocale }
  | { operation: 'set-theme-preference'; themePreference: WorkbenchThemePreference }
  | { operation: 'set-canvas-text-appearance'; textAppearance: CanvasTextAppearance }
  | { operation: 'set-hierarchy-edges-visible'; hierarchyEdgesVisible: boolean }
  | { operation: 'create-feedback-mark'; name: string; icon: string }
  | { operation: 'set-feedback-mark-icon'; name: string; icon: string }
  | { operation: 'delete-feedback-mark'; name: string }
  | { operation: 'set-feedback-action-bar'; names: string[] }
  | { operation: 'set-photoshop-plugin-enabled'; enabled: boolean }
  | { operation: 'save-model-setting'; modelId: string; setting: SaveModelSettingInput };

export interface WorkbenchProjectFileOperationResult extends ProjectPathEntry, RevisionedProjectResult {}

export interface WorkbenchProjectFileBatchOperationResult extends ProjectPathBatchOperationResult, RevisionedProjectResult {}

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

export interface WorkbenchProjectPathClipboardInput {
  format: 'absolute' | 'relative';
  entries: ProjectPathEntry[];
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
  canonicalRoot: string;
  snapshot: WorkbenchProjectSessionSnapshot;
  workingCopies: WorkbenchWorkingCopies;
}

export type WorkbenchProjectTarget = { projectRoot: string };

type WorkbenchProjectOpenOutcome =
  | WorkbenchProjectOpenResult
  | { outcome: 'focused_existing_desktop'; canonicalRoot: string };

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
  | { kind: 'comment'; scope: 'node'; momentTimeSeconds?: never; geometry?: never }
  | { kind: 'comment'; scope: 'moment'; momentTimeSeconds: number; geometry?: never }
  | {
      kind: 'pin';
      scope: 'node';
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
      scope: 'node';
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

export interface WorkbenchProjectTextFileWriteResult extends RevisionedProjectResult {
  file: WorkbenchProjectTextFile;
}

interface CanvasTextPreviewSourceTarget {
  projectRelativePath: string;
  targetIdentity: string;
}

type CanvasTextPreviewSourceAvailabilityView = CanvasTextPreviewSourceTarget & (
  | { status: 'available' }
  | { status: 'missing' }
  | { status: 'error'; message: string }
);

export interface SaveCanvasTextPreviewSourceInput extends CanvasTextPreviewSourceTarget {
  sourcePng: Blob;
}

export interface SaveCanvasTextPreviewSourceResult {
  ok: true;
  source: CanvasTextPreviewSourceTarget & { status: 'available' };
}

export interface CanvasTextPreviewSourceAvailabilityRequest {
  sources: CanvasTextPreviewSourceTarget[];
}

export interface CanvasTextPreviewSourceAvailabilityResponse {
  sources: Record<string, CanvasTextPreviewSourceAvailabilityView>;
}

export interface CanvasVideoPreviewTarget {
  projectRelativePath: string;
  sourceRevision: string;
  frameTimeMs: number;
}

export interface CanvasVideoMetadata {
  width: number;
  height: number;
  durationSeconds?: number;
}

export type CanvasVideoPreviewSourceView = CanvasVideoPreviewTarget & (
  | {
      status: 'available';
      sourceWidth: number;
      metadata: CanvasVideoMetadata;
    }
  | {
      status: 'missing';
      metadata?: CanvasVideoMetadata;
    }
  | {
      status: 'error';
      message: string;
    }
);

export interface CanvasVideoPreviewSourceRequest {
  targets: CanvasVideoPreviewTarget[];
}

export interface CanvasVideoPreviewSourceResponse {
  sources: CanvasVideoPreviewSourceView[];
}

export interface SaveCanvasVideoPreviewSourceInput extends CanvasVideoPreviewTarget {
  metadata: CanvasVideoMetadata;
  sourcePng: Blob;
}

export interface SaveCanvasVideoPreviewSourceResult {
  ok: true;
  source: CanvasVideoPreviewTarget & {
    status: 'available';
    sourceWidth: number;
    metadata: CanvasVideoMetadata;
  };
}

export type ModelSettingRecord = {
  debruteModelId: string;
  summary: string;
  defaultBaseUrl: string;
  defaultRequestModelId: string;
  baseUrlOverride: string | null;
  requestModelIdOverride: string | null;
  apiKeySet: boolean;
};

export interface SaveModelSettingInput {
  baseUrlOverride: string | null;
  requestModelIdOverride: string | null;
  apiKey?: string;
}

export interface RevealModelApiKeyResponse {
  apiKey: string;
}

export type AudioModelKind = 'tts' | 'music' | 'sound-effect';

export type AudioModelSettingRecord = ModelSettingRecord & {
  kind: AudioModelKind;
};

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

export type ProductUpdateState =
  | {
      type: 'unknown';
      currentVersion: string;
    }
  | {
      type: 'checking';
      currentVersion: string;
    }
  | {
      type: 'up_to_date';
      currentVersion: string;
      lastCheckedAt?: string;
    }
  | {
      type: 'available';
      currentVersion: string;
      updateVersion: string;
      releaseName?: string;
      releaseDate?: string;
    }
  | {
      type: 'preparing';
      currentVersion: string;
      updateVersion: string;
      stage: 'closing_new_work';
    }
  | {
      type: 'committing';
      currentVersion: string;
      updateVersion: string;
      stage: 'continuing_transaction' | 'installing_and_selecting';
    }
  | {
      type: 'discovery_failed';
      currentVersion: string;
      message: string;
    }
  | {
      type: 'install_failed';
      currentVersion: string;
      stage: 'preparing' | 'committing';
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

export interface ProductRemovalInput {
  confirmed: true;
  keepConfig: boolean;
}

export interface ProductRemovalAccepted {
  accepted: true;
  configPreserved: boolean;
}

interface ModelArtifactProvenanceRecord {
  operationId: string;
  itemIndex: number;
  artifactIndex: number;
  outputPath: string;
  createdAt: string;
  mimeType: string;
  request: unknown;
  response: {
    trace: unknown[];
    output: unknown;
  };
}

export interface ModelArtifactProvenanceLookup {
  sha256: string;
  record: ModelArtifactProvenanceRecord | null;
}

interface CanvasNodeStateUpdate {
  projectRelativePath: string;
  manualLayout?: CanvasManualLayout | null;
  videoPlayback?: CanvasVideoPlaybackState | null;
  textViewport?: CanvasTextViewportState | null;
}

interface PatchCanvasStateInput {
  expandedDirectories?: string[];
  nodeStateUpdates?: CanvasNodeStateUpdate[];
  occlusionOrder?: string[];
}

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
  | { type: 'sync'; protocolVersion: number; topologyRevision: number; sessions: TerminalSessionView[] }
  | { type: 'observed'; session: TerminalSessionView; checkpoint: TerminalCheckpoint }
  | { type: 'input-ack'; requestId: number; terminalId: string; sequence: number }
  | { type: 'resized'; requestId: number; session: TerminalSessionView }
  | { type: 'topology'; topologyRevision: number; sessions: TerminalSessionView[] }
  | { type: 'output'; terminalId: string; sequence: number; dataBase64: string }
  | { type: 'status'; session: TerminalSessionView }
  | { type: 'exit'; terminalId: string; exitCode: number | null; signal: string | null }
  | { type: 'error'; requestId: number | null; terminalId: string | null; code: string; message: string };

export interface WorkbenchCanvasStateMutationResult extends RevisionedProjectResult {}

export interface WorkbenchCanvasFeedbackMutationResult extends RevisionedProjectResult {}

export interface PhotoshopDocumentView {
  documentId: number;
  title: string;
}

export interface PhotoshopSessionView {
  pluginSessionId: string;
  hostVersion: string;
  placementMimeTypes: PhotoshopMimeType[];
  documents: PhotoshopDocumentView[];
}

export interface PhotoshopStateView {
  status: 'off' | 'waiting' | 'connected' | 'unavailable';
  transferActive: boolean;
  sessions: PhotoshopSessionView[];
}

export interface SendProjectFileToPhotoshopInput {
  projectRelativePath: string;
  pluginSessionId: string;
  documentId: number;
}

export interface SendProjectFileToPhotoshopResult {
  commandId: string;
  documentTitle: string;
  fileName: string;
}

export type ActivitySource =
  | 'project'
  | 'canvas'
  | 'explorer'
  | 'model-request'
  | 'photoshop'
  | 'workbench'
  | 'update';

export interface ActivityProjectContext {
  canonicalRoot: string;
  projectName: string;
}

export type ProjectActivityOperation = 'open';
export type CanvasActivityOperation =
  | 'feedback-unavailable'
  | 'feedback-save'
  | 'save-text-viewport'
  | 'save-layout'
  | 'save-video-playback'
  | 'set-directory-disclosure'
  | 'reveal-path'
  | 'raise-selection'
  | 'reset-auto-layout'
  | 'reset-layout'
  | 'reset-canvas'
  | 'copy-path';
export type ExplorerActivityOperation =
  | 'load-directory'
  | 'copy'
  | 'move'
  | 'import'
  | 'copy-path'
  | 'reveal'
  | 'delete'
  | 'paste';
export type WorkbenchActivityOperation =
  | 'window-state'
  | 'window-command'
  | 'menu-command'
  | 'save-canvas-settings';
export type WorkbenchActivityNoticeInput =
  | { kind: 'project-opened' }
  | { kind: 'project-operation-failed'; operation: ProjectActivityOperation }
  | { kind: 'canvas-operation-failed'; operation: CanvasActivityOperation }
  | { kind: 'explorer-operation-failed'; operation: ExplorerActivityOperation }
  | { kind: 'workbench-operation-failed'; operation: WorkbenchActivityOperation }
  | { kind: 'update-install-failed' };

export type ActivityMessage =
  | WorkbenchActivityNoticeInput
  | { kind: 'model-request'; modelKind: 'image' | 'video' | 'tts' | 'music' | 'sound-effect'; itemCount: number }
  | { kind: 'photoshop-send'; projectRelativePath: string; documentTitle?: string };

export type ActivityProgress =
  | { type: 'indeterminate' }
  | { type: 'determinate'; completed: number; total: number };

export type ActivityTaskStatus = 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled';

interface ActivityRecordBase {
  id: string;
  source: ActivitySource;
  project?: ActivityProjectContext;
  createdAt: string;
  updatedAt: string;
}

export type ActivityRecord = ActivityRecordBase & (
  | { type: 'notice'; message: WorkbenchActivityNoticeInput }
  | {
      type: 'task';
      status: ActivityTaskStatus;
      progress: ActivityProgress;
      message: Exclude<ActivityMessage, WorkbenchActivityNoticeInput>;
    }
);

export type WorkbenchActivityFrame =
  | { type: 'activity.snapshot'; activityRevision: number; records: ActivityRecord[] }
  | { type: 'activity.upsert'; activityRevision: number; record: ActivityRecord }
  | { type: 'activity.remove'; activityRevision: number; activityIds: string[] };

const PROJECT_ACTIVITY_OPERATIONS = new Set<ProjectActivityOperation>(['open']);
const CANVAS_ACTIVITY_OPERATIONS = new Set<CanvasActivityOperation>([
  'feedback-unavailable',
  'feedback-save',
  'save-text-viewport',
  'save-layout',
  'save-video-playback',
  'set-directory-disclosure',
  'reveal-path',
  'raise-selection',
  'reset-auto-layout',
  'reset-layout',
  'reset-canvas',
  'copy-path'
]);
const EXPLORER_ACTIVITY_OPERATIONS = new Set<ExplorerActivityOperation>([
  'load-directory', 'copy', 'move', 'import', 'copy-path', 'reveal', 'delete', 'paste'
]);
const WORKBENCH_ACTIVITY_OPERATIONS = new Set<WorkbenchActivityOperation>([
  'window-state', 'window-command', 'menu-command', 'save-canvas-settings'
]);
const ACTIVITY_TASK_STATUSES = new Set<ActivityTaskStatus>([
  'running', 'cancelling', 'succeeded', 'failed', 'cancelled'
]);

function isActivityProjectContext(value: unknown): value is ActivityProjectContext {
  return isProtocolObject(value)
    && hasExactKeys(value, ['canonicalRoot', 'projectName'])
    && typeof value.canonicalRoot === 'string'
    && value.canonicalRoot.length > 0
    && typeof value.projectName === 'string'
    && value.projectName.length > 0;
}

function isActivityMessage(value: unknown): value is ActivityMessage {
  if (!isProtocolObject(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'project-opened':
    case 'update-install-failed':
      return hasExactKeys(value, ['kind']);
    case 'project-operation-failed':
      return hasExactKeys(value, ['kind', 'operation'])
        && PROJECT_ACTIVITY_OPERATIONS.has(value.operation as ProjectActivityOperation);
    case 'canvas-operation-failed':
      return hasExactKeys(value, ['kind', 'operation'])
        && CANVAS_ACTIVITY_OPERATIONS.has(value.operation as CanvasActivityOperation);
    case 'explorer-operation-failed':
      return hasExactKeys(value, ['kind', 'operation'])
        && EXPLORER_ACTIVITY_OPERATIONS.has(value.operation as ExplorerActivityOperation);
    case 'workbench-operation-failed':
      return hasExactKeys(value, ['kind', 'operation'])
        && WORKBENCH_ACTIVITY_OPERATIONS.has(value.operation as WorkbenchActivityOperation);
    case 'model-request':
      return hasExactKeys(value, ['kind', 'modelKind', 'itemCount'])
        && ['image', 'video', 'tts', 'music', 'sound-effect'].includes(String(value.modelKind))
        && isNonNegativeInteger(value.itemCount)
        && Number(value.itemCount) > 0;
    case 'photoshop-send':
      return hasExactKeys(value, ['kind', 'projectRelativePath'], ['documentTitle'])
        && typeof value.projectRelativePath === 'string'
        && (value.documentTitle === undefined || typeof value.documentTitle === 'string');
    default:
      return false;
  }
}

function isActivityProgress(value: unknown): value is ActivityProgress {
  if (!isProtocolObject(value) || typeof value.type !== 'string') return false;
  if (value.type === 'indeterminate') return hasExactKeys(value, ['type']);
  return value.type === 'determinate'
    && hasExactKeys(value, ['type', 'completed', 'total'])
    && isNonNegativeInteger(value.completed)
    && isNonNegativeInteger(value.total)
    && Number(value.total) > 0
    && Number(value.completed) <= Number(value.total);
}

function activitySourceForMessage(message: ActivityMessage): ActivitySource {
  switch (message.kind) {
    case 'project-opened':
    case 'project-operation-failed': return 'project';
    case 'canvas-operation-failed': return 'canvas';
    case 'explorer-operation-failed': return 'explorer';
    case 'workbench-operation-failed': return 'workbench';
    case 'update-install-failed': return 'update';
    case 'model-request': return 'model-request';
    case 'photoshop-send': return 'photoshop';
  }
}

function isActivityRecord(value: unknown): value is ActivityRecord {
  if (!isProtocolObject(value)
    || typeof value.id !== 'string'
    || value.id.length === 0
    || typeof value.source !== 'string'
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string'
    || (value.project !== undefined && !isActivityProjectContext(value.project))
    || !isActivityMessage(value.message)
    || activitySourceForMessage(value.message) !== value.source
  ) {
    return false;
  }
  const projectRequired = ['project', 'canvas', 'explorer', 'model-request', 'photoshop']
    .includes(value.source);
  if (projectRequired !== (value.project !== undefined)) return false;
  if (value.type === 'notice') {
    return !['model-request', 'photoshop-send'].includes(value.message.kind)
      && hasExactKeys(value, ['id', 'source', 'createdAt', 'updatedAt', 'type', 'message'], ['project']);
  }
  return value.type === 'task'
    && ['model-request', 'photoshop-send'].includes(value.message.kind)
    && ACTIVITY_TASK_STATUSES.has(value.status as ActivityTaskStatus)
    && isActivityProgress(value.progress)
    && hasExactKeys(
      value,
      ['id', 'source', 'createdAt', 'updatedAt', 'type', 'status', 'progress', 'message'],
      ['project']
    );
}

export function isRecognizedWorkbenchActivityFrame(
  value: unknown
): value is Record<string, unknown> & { type: WorkbenchActivityFrame['type'] } {
  return isProtocolObject(value)
    && typeof value.type === 'string'
    && ['activity.snapshot', 'activity.upsert', 'activity.remove'].includes(value.type);
}

export function decodeWorkbenchActivityFrame(value: unknown): WorkbenchActivityFrame | undefined {
  if (!isRecognizedWorkbenchActivityFrame(value)
    || !isNonNegativeInteger(value.activityRevision)
  ) return undefined;
  if (value.type === 'activity.snapshot') {
    return hasExactKeys(value, ['type', 'activityRevision', 'records'])
      && Array.isArray(value.records)
      && value.records.every(isActivityRecord)
      ? value as unknown as WorkbenchActivityFrame
      : undefined;
  }
  if (value.type === 'activity.upsert') {
    return hasExactKeys(value, ['type', 'activityRevision', 'record'])
      && isActivityRecord(value.record)
      ? value as unknown as WorkbenchActivityFrame
      : undefined;
  }
  return hasExactKeys(value, ['type', 'activityRevision', 'activityIds'])
    && Array.isArray(value.activityIds)
    && value.activityIds.every((id) => typeof id === 'string' && id.length > 0)
    && new Set(value.activityIds).size === value.activityIds.length
    ? value as unknown as WorkbenchActivityFrame
    : undefined;
}

interface WorkbenchFileWatchEvent {
  projectRelativePath: string;
}

export type WorkbenchEvent =
  | { type: 'project.changed'; bindingId: string; projectRevision: number; snapshot: WorkbenchProjectSessionSnapshot }
  | { type: 'project.fileChanged'; bindingId: string; projectRevision: number; event: WorkbenchFileWatchEvent; snapshot: WorkbenchProjectSessionSnapshot }
  | { type: 'canvas.state.changed'; bindingId: string; projectRevision: number; change: CanvasStateChange }
  | { type: 'canvas.feedback.changed'; bindingId: string; projectRevision: number; feedback: CanvasFeedbackDocument }
  | { type: 'recentProjects.changed'; revision: number; recentProjectRoots: string[] }
  | { type: 'globalSettings.changed'; revision: number; settings: DebruteGlobalSettingsView }
  | { type: 'photoshop.state.changed'; revision: number; state: PhotoshopStateView }
  | { type: 'product.changed'; revision: number; product: DebruteProductState | null };

type WorkbenchProjectConnectionFrame =
  | {
      type: 'project.bound';
      project: Omit<WorkbenchProjectOpenResult, 'workingCopies'>;
      workingCopies: WorkbenchWorkingCopies;
    }
  | {
      type: 'project.open_failed';
      canonicalRoot: string;
      error: { code: string; message: string };
    }
  | { type: 'project.preempted'; bindingId: string };

const workbenchProjectConnectionFrameValidators = {
  'project.bound': (value) => isProtocolObject(value.project)
    && typeof value.project.bindingId === 'string'
    && value.project.bindingId.length > 0
    && typeof value.project.canonicalRoot === 'string'
    && value.project.canonicalRoot.length > 0
    && isNonNegativeInteger(value.project.projectRevision)
    && isWorkbenchProjectSessionSnapshotFor(value.project.snapshot, value.project.canonicalRoot)
    && isWorkbenchWorkingCopies(value.workingCopies),
  'project.open_failed': (value) => typeof value.canonicalRoot === 'string'
    && value.canonicalRoot.length > 0
    && isProtocolObject(value.error)
    && typeof value.error.code === 'string'
    && typeof value.error.message === 'string',
  'project.preempted': (value) => typeof value.bindingId === 'string'
    && value.bindingId.length > 0
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
    && isWorkbenchProjectSessionSnapshot(value.snapshot),
  'project.fileChanged': (value) => isRevisionedProjectEvent(value)
    && isProtocolObject(value.event)
    && typeof value.event.projectRelativePath === 'string'
    && isWorkbenchProjectSessionSnapshot(value.snapshot),
  'canvas.state.changed': (value) => isRevisionedProjectEvent(value)
    && isCanvasStateChange(value.change),
  'canvas.feedback.changed': (value) => isRevisionedProjectEvent(value)
    && isCanvasFeedbackDocument(value.feedback),
  'recentProjects.changed': (value) => isNonNegativeInteger(value.revision)
    && Array.isArray(value.recentProjectRoots)
    && value.recentProjectRoots.every((root) => typeof root === 'string'),
  'globalSettings.changed': (value) => isNonNegativeInteger(value.revision)
    && isProtocolObject(value.settings),
  'photoshop.state.changed': (value) => isNonNegativeInteger(value.revision)
    && isPhotoshopStateView(value.state),
  'product.changed': (value) => isNonNegativeInteger(value.revision)
    && (value.product === null || isProtocolObject(value.product))
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

function isWorkbenchProjectSessionSnapshot(
  value: unknown
): value is WorkbenchProjectSessionSnapshot {
  if (!isProtocolObject(value)
    || !hasExactKeys(value, ['canonicalRoot', 'projectTree', 'canvasWorkspace', 'diagnostics', 'health'])
    || typeof value.canonicalRoot !== 'string'
    || !isCanvasWorkspaceSnapshot(value.canvasWorkspace, value.canonicalRoot)
    || !Array.isArray(value.projectTree)
    || !value.projectTree.every(isProjectTreeEntry)
    || !Array.isArray(value.diagnostics)
    || !value.diagnostics.every(isProjectDiagnostic)
    || !isProtocolObject(value.health)
    || !hasExactKeys(value.health, ['projectName', 'diagnosticCounts', 'checkedAt'])
    || typeof value.health.projectName !== 'string'
    || !isProtocolObject(value.health.diagnosticCounts)
    || !hasExactKeys(value.health.diagnosticCounts, ['errors', 'warnings'])
    || !isNonNegativeInteger(value.health.diagnosticCounts.errors)
    || !isNonNegativeInteger(value.health.diagnosticCounts.warnings)
    || typeof value.health.checkedAt !== 'string'
  ) {
    return false;
  }
  return true;
}

function isWorkbenchProjectSessionSnapshotFor(value: unknown, canonicalRoot: unknown): boolean {
  return typeof canonicalRoot === 'string'
    && isWorkbenchProjectSessionSnapshot(value)
    && value.canonicalRoot === canonicalRoot;
}

function isWorkbenchWorkingCopies(value: unknown): value is WorkbenchWorkingCopies {
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
  return typeof value.bindingId === 'string'
    && value.bindingId.length > 0
    && isNonNegativeInteger(value.projectRevision);
}

function isProjectPathEntry(value: unknown): boolean {
  if (!isProtocolObject(value)
    || Object.keys(value).some((key) => !['projectRelativePath', 'kind', 'sizeBytes'].includes(key))
    || typeof value.projectRelativePath !== 'string'
  ) {
    return false;
  }
  if (value.kind === 'file') {
    return isNonNegativeInteger(value.sizeBytes);
  }
  return value.kind === 'directory' && value.sizeBytes === undefined;
}

function isProjectTreeEntry(value: unknown): boolean {
  if (!isProtocolObject(value)
    || Object.keys(value).some((key) => ![
      'projectRelativePath',
      'kind',
      'sizeBytes',
      'directoryState',
      'directoryError'
    ].includes(key))
    || !isProjectPathEntry({
      projectRelativePath: value.projectRelativePath,
      kind: value.kind,
      ...(value.sizeBytes === undefined ? {} : { sizeBytes: value.sizeBytes })
    })
  ) {
    return false;
  }
  if (value.kind === 'file') {
    return value.directoryState === undefined && value.directoryError === undefined;
  }
  return (
    value.directoryState === 'unloaded'
    || value.directoryState === 'loaded'
    || value.directoryState === 'error'
  ) && (value.directoryError === undefined || typeof value.directoryError === 'string');
}

function isCanvasWorkspaceDocument(
  value: unknown,
  canonicalRoot: string
): value is CanvasWorkspaceDocument {
  if (!isProtocolObject(value)
    || !hasExactKeys(value, ['canonicalRoot', 'expandedDirectories', 'nodeStates', 'occlusionOrder'])
    || value.canonicalRoot !== canonicalRoot
  ) {
    return false;
  }
  return isCanvasState({
    expandedDirectories: value.expandedDirectories,
    nodeStates: value.nodeStates,
    occlusionOrder: value.occlusionOrder
  });
}

function isCanvasWorkspaceSnapshot(
  value: unknown,
  canonicalRoot: string
): value is CanvasWorkspaceSnapshot {
  if (!isProtocolObject(value) || typeof value.status !== 'string') {
    return false;
  }
  if (value.status === 'available') {
    if (!hasExactKeys(value, ['status', 'workspace', 'canvasResources', 'feedbackVideoResources'])
      || !isCanvasWorkspaceDocument(value.workspace, canonicalRoot)
      || !isCanvasResourceView(value.canvasResources)
      || !isCanvasFeedbackVideoResourceView(value.feedbackVideoResources)
    ) {
      return false;
    }
    return true;
  }
  return value.status === 'unavailable'
    && hasExactKeys(value, ['status', 'code', 'message'])
    && CANVAS_WORKSPACE_UNAVAILABLE_CODES.includes(value.code as CanvasWorkspaceUnavailableCode)
    && typeof value.message === 'string';
}

function isCanvasState(value: unknown): value is CanvasState {
  return isProtocolObject(value)
    && hasExactKeys(value, ['expandedDirectories', 'nodeStates', 'occlusionOrder'])
    && Array.isArray(value.expandedDirectories)
    && value.expandedDirectories.every((path) => typeof path === 'string' && path.length > 0)
    && new Set(value.expandedDirectories).size === value.expandedDirectories.length
    && isProtocolObject(value.nodeStates)
    && Object.values(value.nodeStates).every(isCanvasNodeState)
    && Array.isArray(value.occlusionOrder)
    && value.occlusionOrder.every((path) => typeof path === 'string')
    && new Set(value.occlusionOrder).size === value.occlusionOrder.length;
}

function isCanvasNodeState(value: unknown): boolean {
  return isProtocolObject(value)
    && hasExactKeys(value, [], ['manualLayout', 'videoPlayback', 'textViewport'])
    && Object.keys(value).length > 0
    && (value.manualLayout === undefined || (
      isProtocolObject(value.manualLayout)
      && hasExactKeys(value.manualLayout, ['x', 'y', 'width', 'height'])
      && isFiniteNumber(value.manualLayout.x)
      && isFiniteNumber(value.manualLayout.y)
      && isFiniteNumber(value.manualLayout.width)
      && value.manualLayout.width > 0
      && isFiniteNumber(value.manualLayout.height)
      && value.manualLayout.height > 0
    ))
    && (value.videoPlayback === undefined || (
      isProtocolObject(value.videoPlayback)
      && hasExactKeys(value.videoPlayback, ['currentTimeMs'])
      && isNonNegativeInteger(value.videoPlayback.currentTimeMs)
    ))
    && (value.textViewport === undefined || (
      isProtocolObject(value.textViewport)
      && hasExactKeys(value.textViewport, ['scrollTop', 'scrollLeft'])
      && isFiniteNumber(value.textViewport.scrollTop)
      && value.textViewport.scrollTop >= 0
      && isFiniteNumber(value.textViewport.scrollLeft)
      && value.textViewport.scrollLeft >= 0
    ));
}

function isCanvasStateChange(value: unknown): value is CanvasStateChange {
  if (!isProtocolObject(value)
    || !hasExactKeys(value, ['nodeStates'], ['occlusionOrder'])
    || !Array.isArray(value.nodeStates)
    || !value.nodeStates.every((entry) => isProtocolObject(entry)
      && hasExactKeys(entry, ['projectRelativePath', 'state'])
      && typeof entry.projectRelativePath === 'string'
      && (entry.state === null || isCanvasNodeState(entry.state)))
  ) {
    return false;
  }
  const paths = value.nodeStates.map((entry) => entry.projectRelativePath as string);
  return (paths.length > 0 || value.occlusionOrder !== undefined)
    && new Set(paths).size === paths.length
    && (value.occlusionOrder === undefined || (
      Array.isArray(value.occlusionOrder)
      && value.occlusionOrder.every((path) => typeof path === 'string')
      && new Set(value.occlusionOrder).size === value.occlusionOrder.length
    ));
}

function isCanvasResourceView(value: unknown): boolean {
  return isProtocolObject(value)
    && hasExactKeys(value, ['resources'])
    && Array.isArray(value.resources)
    && value.resources.every(isCanvasResource);
}

function isCanvasFeedbackVideoResourceView(value: unknown): boolean {
  return isProtocolObject(value)
    && hasExactKeys(value, ['resources'])
    && Array.isArray(value.resources)
    && value.resources.every((resource) => (
      isCanvasResource(resource)
      && resource.nodeKind === 'file'
      && resource.mediaKind === 'video'
    ));
}

function isCanvasResource(value: unknown): boolean {
  if (!isProtocolObject(value)
    || typeof value.projectRelativePath !== 'string'
    || (value.nodeKind !== 'file' && value.nodeKind !== 'directory')) {
    return false;
  }
  if (value.nodeKind === 'directory') {
    return hasExactKeys(value, ['projectRelativePath', 'nodeKind']);
  }
  if (!hasExactKeys(value, ['projectRelativePath', 'nodeKind', 'mediaKind', 'availability'], ['imageDimensions', 'textLanguage'])
    || !isCanvasMediaKind(value.mediaKind)
    || !isCanvasNodeAvailability(value.availability)
    || !isProtocolObject(value.availability)) return false;
  const availability = value.availability;
  if (value.imageDimensions !== undefined && (
    !isProtocolObject(value.imageDimensions)
    || !hasExactKeys(value.imageDimensions, ['width', 'height'])
    || !isFiniteNumber(value.imageDimensions.width)
    || value.imageDimensions.width <= 0
    || !isFiniteNumber(value.imageDimensions.height)
    || value.imageDimensions.height <= 0
  )) {
    return false;
  }
  if (value.textLanguage !== undefined
    && (typeof value.textLanguage !== 'string'
      || !(PROJECT_TEXT_LANGUAGE_IDS as readonly string[]).includes(value.textLanguage))) {
    return false;
  }
  return (value.mediaKind !== 'text'
      || availability.state !== 'available'
      || typeof value.textLanguage === 'string');
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
    return hasExactKeys(value, ['state', 'message'])
      && typeof value.message === 'string';
  }
  if (value.state === 'resolving') {
    return hasExactKeys(
      value,
      ['state', 'size', 'mimeType', 'sourceToken'],
      ['canvasImagePreviewable', 'canvasImagePreviewSourceWidth']
    )
      && isFiniteNumber(value.size)
      && typeof value.mimeType === 'string'
      && typeof value.sourceToken === 'string'
      && (value.canvasImagePreviewable === undefined || typeof value.canvasImagePreviewable === 'boolean')
      && (value.canvasImagePreviewSourceWidth === undefined || isFiniteNumber(value.canvasImagePreviewSourceWidth));
  }
  return value.state === 'available'
    && hasExactKeys(
      value,
      ['state', 'size', 'mimeType', 'fileUrl', 'revision'],
      ['canvasImagePreviewable', 'canvasImagePreviewSourceWidth']
    )
    && isFiniteNumber(value.size)
    && typeof value.mimeType === 'string'
    && typeof value.fileUrl === 'string'
    && typeof value.revision === 'string'
    && (value.canvasImagePreviewable === undefined || typeof value.canvasImagePreviewable === 'boolean')
    && (value.canvasImagePreviewSourceWidth === undefined || isFiniteNumber(value.canvasImagePreviewSourceWidth));
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
        (value.scope === 'node' && value.moment === undefined)
        || (value.scope === 'moment' && isCanvasFeedbackMoment(value.moment))
      );
  }
  if (value.kind !== 'pin' && value.kind !== 'region') {
    return false;
  }
  return (
    (value.scope === 'node' && value.moment === undefined)
    || (value.scope === 'moment' && isCanvasFeedbackMoment(value.moment))
  )
    && isNonNegativeInteger(value.label)
    && isCanvasFeedbackGeometry(value.geometry)
    && isProtocolObject(value.geometry)
    && (value.kind === 'pin' ? value.geometry.type === 'point' : value.geometry.type === 'rect');
}

function isCanvasFeedbackMark(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
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
    || (value.scope !== 'node' && value.scope !== 'moment')
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

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function isPhotoshopStateView(value: unknown): value is PhotoshopStateView {
  if (!isProtocolObject(value)
    || Object.keys(value).length !== 3
    || typeof value.status !== 'string'
    || !['off', 'waiting', 'connected', 'unavailable'].includes(value.status)
    || typeof value.transferActive !== 'boolean'
  ) {
    return false;
  }
  if (!Array.isArray(value.sessions)
    || !value.sessions.every((session) => isProtocolObject(session)
      && Object.keys(session).length === 4
      && typeof session.pluginSessionId === 'string'
      && typeof session.hostVersion === 'string'
      && Array.isArray(session.placementMimeTypes)
      && session.placementMimeTypes.length > 0
      && session.placementMimeTypes.every(isPhotoshopMimeType)
      && new Set(session.placementMimeTypes).size === session.placementMimeTypes.length
      && Array.isArray(session.documents)
      && session.documents.every((document) => isProtocolObject(document)
        && Object.keys(document).length === 2
        && isNonNegativeInteger(document.documentId)
        && typeof document.title === 'string'))
  ) {
    return false;
  }
  if (value.status === 'connected') {
    return value.sessions.length > 0;
  }
  return value.sessions.length === 0 && !value.transferActive;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export interface WorkbenchApiClient {
  reportActivityNotice(input: WorkbenchActivityNoticeInput): Promise<{ activityId: string }>;
  dismissActivity(activityId: string): Promise<{ ok: true }>;
  clearTerminalActivities(): Promise<{ ok: true; cleared: number }>;
  sendProjectFileToPhotoshop(input: SendProjectFileToPhotoshopInput): Promise<SendProjectFileToPhotoshopResult>;
  openProject(target: WorkbenchProjectTarget): Promise<WorkbenchProjectOpenOutcome>;
  chooseProjectRoot(): Promise<string | undefined>;
  clearRecentProjectRoots(): Promise<{ ok: true }>;
  checkProductUpdate(): Promise<{ ok: true }>;
  applyProductUpdate(): Promise<{ ok: true }>;
  mutateGlobalSettings(input: MutateDebruteGlobalSettingsInput): Promise<{ ok: true }>;
  removeProduct(input: ProductRemovalInput): Promise<ProductRemovalAccepted>;
  revealModelApiKey(modelId: string): Promise<RevealModelApiKeyResponse>;
  subscribeTerminalSessions(
    listener: (sessions: TerminalSessionView[]) => void,
    onError: (error: Error) => void
  ): TerminalEventSubscription;
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
  resolveCanvasSources(input: CanvasSourceResolutionRequest): Promise<CanvasSourceResolutionResponse>;
  loadProjectDirectory(projectRelativeDirectory: string): Promise<RevisionedProjectResult>;
  writeProjectTextFile(input: WriteProjectTextFileInput): Promise<WorkbenchProjectTextFileWriteResult>;
  putTextWorkingCopy(bindingId: string, input: WorkbenchTextWorkingCopy): Promise<WorkbenchTextWorkingCopy>;
  clearTextWorkingCopy(bindingId: string, projectRelativePath: string): Promise<void>;
  putFeedbackWorkingCopy(bindingId: string, input: WorkbenchFeedbackWorkingCopy): Promise<WorkbenchFeedbackWorkingCopy>;
  clearFeedbackWorkingCopy(bindingId: string, itemId: string): Promise<void>;
  saveCanvasTextPreviewSource(input: SaveCanvasTextPreviewSourceInput): Promise<SaveCanvasTextPreviewSourceResult>;
  readCanvasTextPreviewSources(input: CanvasTextPreviewSourceAvailabilityRequest): Promise<CanvasTextPreviewSourceAvailabilityResponse>;
  readCanvasVideoPreviewSources(input: CanvasVideoPreviewSourceRequest, signal?: AbortSignal): Promise<CanvasVideoPreviewSourceResponse>;
  saveCanvasVideoPreviewSource(input: SaveCanvasVideoPreviewSourceInput, signal?: AbortSignal): Promise<SaveCanvasVideoPreviewSourceResult>;
  createProjectFile(input: { parentProjectRelativePath: string; name: string }): Promise<WorkbenchProjectFileOperationResult>;
  createProjectDirectory(input: { parentProjectRelativePath: string; name: string }): Promise<WorkbenchProjectFileOperationResult>;
  renameProjectPath(input: { projectRelativePath: string; name: string }): Promise<WorkbenchProjectFileOperationResult>;
  copyProjectPaths(input: WorkbenchProjectCopyPathsInput): Promise<WorkbenchProjectFileBatchOperationResult>;
  moveProjectPaths(input: WorkbenchProjectMovePathsInput): Promise<WorkbenchProjectFileBatchOperationResult>;
  copyProjectPathsToSystemClipboard(input: WorkbenchProjectPathClipboardInput): Promise<{ ok: true }>;
  trashProjectPaths(input: WorkbenchProjectDeletePathsInput): Promise<WorkbenchProjectFileBatchOperationResult>;
  deleteProjectPathsPermanently(input: WorkbenchProjectDeletePathsInput): Promise<WorkbenchProjectFileBatchOperationResult>;
  importExternalLocalProjectPaths(input: WorkbenchProjectExternalLocalImportInput): Promise<WorkbenchProjectFileBatchOperationResult>;
  importExternalProjectUploads(input: WorkbenchProjectUploadImportInput): Promise<WorkbenchProjectFileBatchOperationResult>;
  revealProjectPathInSystemFileManager(input: { projectRelativePath: string; kind: 'file' | 'directory' }): Promise<{ ok: true }>;
  lookupModelArtifactProvenance(input: { projectRelativePath: string }): Promise<ModelArtifactProvenanceLookup>;
  readCanvasFeedback(): Promise<CanvasFeedbackDocument>;
  updateCanvasFeedback(input: UpdateCanvasFeedbackInput): Promise<WorkbenchCanvasFeedbackMutationResult>;
  resetCanvas(): Promise<RevisionedProjectResult>;
  patchCanvasState(input: PatchCanvasStateInput): Promise<WorkbenchCanvasStateMutationResult>;
  onEvent(listener: (event: WorkbenchEvent) => void): () => void;
  onConnectionEnded(listener: (error: Error) => void): () => void;
  dispose(): void;
}
