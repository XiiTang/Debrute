import { randomUUID } from 'node:crypto';
import { access, mkdir, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  assertProjectTreeVisibleMutationPath,
  getDebruteProjectPaths,
  initializeBlankProject,
  normalizeProjectRelativePath,
  readProjectMetadata,
  readProjectTextFile,
  resolveExistingProjectPath,
  resolveNoSymlinkProjectPathForWrite,
  resolveProjectPath,
  resolveProjectPathForWrite,
  watchProjectFiles,
  writeProjectTextFile,
  type CopyProjectPathsInput,
  type CreateProjectPathInput,
  type DeleteProjectPathsInput,
  type ImportExternalLocalProjectPathsInput,
  type ImportExternalUploadProjectEntriesInput,
  type MoveProjectPathsInput,
  type NormalizedFileWatchEvent,
  type ProjectFileWatchHandle,
  type RenameProjectPathInput,
  type ProjectTextFile
} from '@debrute/project-core';
import {
  type CanvasDesiredNode,
  type Diagnostic,
  type CanvasDocument,
  type CanvasFeedbackDocument,
  type CanvasLayoutSize,
  type CanvasProjection,
  type UpdateCanvasFeedbackEntryInput
} from '@debrute/canvas-core';
import {
  capabilityError,
  capabilityOk,
  projectArtifactPointers,
  type DebruteCapabilityResult
} from '@debrute/capability-core';
import {
  createAudioModelCatalog,
  createAudioModelSettingsView,
  createImageModelCatalog,
  createImageModelSettingsView,
  createVideoModelCatalog,
  createVideoModelSettingsView,
  describeAudioModelOfficialDoc,
  describeImageModelOfficialDoc,
  describeVideoModelOfficialDoc,
  executeAudioModelRequest,
  executeImageModelRequest,
  executeVideoModelRequest,
  type AudioModelFetch,
  type AudioModelKind,
  type AudioModelRequestInput,
  type ExecuteImageModelRequestResult,
  type ImageModelCatalogEntry,
  type ImageModelFetch,
  type ImageModelRequestInput,
  type PublicRemoteHostLookup,
  type PublicRemoteHttpTransport,
  type VideoModelRequestInput,
  type VideoModelFetch
} from '@debrute/capability-runtime';
import {
  CanvasMapError,
  canvasMapPath,
  type CanvasMapPathRuleSet
} from '@debrute/canvas-map-core';
import type {
  AddProjectPathToCanvasMapInput,
  AppServerEvent,
  CloseTerminalSessionInput,
  CreateTerminalSessionInput,
  GeneratedAssetMetadataLookup,
  GeneratedAssetMetadataDiagnostic,
  GeneratedAssetRecord,
  ImageModelBatchSummary,
  ProjectCanvasManagementResult,
  ProjectAddProjectPathToCanvasMapResult,
  ProjectFileBatchOperationResult,
  ProjectFileOperationResult,
  ProjectHealthSummary,
  ProjectSessionSnapshot,
  RunImageModelBatchInput,
  TerminalEvent,
  TerminalEventSubscription,
  TerminalInputWrite,
  TerminalResize,
  TerminalSessionList,
  TerminalSessionResult,
  UpdateCanvasTextViewportStateInput,
  UpdateCanvasVideoPlaybackStateInput
} from '@debrute/app-protocol';
import { GlobalConfigStore } from '../config/GlobalConfigStore.js';
import {
  readCanvasNodeLayoutSize,
  readCanvasVideoMetadata,
  type ReadCanvasNodeLayoutSizeInput
} from '../canvas/CanvasNodeDimensionsService.js';
import {
  createGeneratedAssetMetadataService,
  type GeneratedAssetMetadataService,
  type RecordGeneratedAssetInput
} from '../generated-assets/GeneratedAssetMetadataService.js';
import {
  canvasFeedbackPaths,
  createCanvasFeedbackService,
  type CanvasFeedbackService
} from '../canvas/CanvasFeedbackService.js';
import {
  createCanvasFeedbackRenderScheduler,
  type CanvasFeedbackRenderDiagnosticUpdate,
  type CanvasFeedbackRenderRunner,
  type CanvasFeedbackRenderScheduler
} from '../canvas/CanvasFeedbackArtifactScheduler.js';
import { createCanvasFeedbackArtifactProcessRunner } from '../canvas/CanvasFeedbackArtifactProcessRunner.js';
import {
  createCanvasImagePreviewService,
  type CanvasImagePreviewResult,
  type CanvasImagePreviewService,
  type ResolveCanvasImagePreviewInput
} from '../canvas/CanvasImagePreviewService.js';
import { reconcileCanvasImagePreviewCache } from '../canvas/CanvasImagePreviewCacheCleanup.js';
import {
  createCanvasTextPreviewService,
  type CanvasTextPreviewReadSourcesInput,
  type CanvasTextPreviewResolveVariantInput,
  type CanvasTextPreviewSaveSourceInput,
  type CanvasTextPreviewService
} from '../canvas/CanvasTextPreviewService.js';
import {
  createCanvasVideoPreviewService,
  type CanvasVideoPreviewReadSourcesInput,
  type CanvasVideoPreviewResolveVariantInput,
  type CanvasVideoPreviewService
} from '../canvas/CanvasVideoPreviewService.js';
import { CanvasProjectionService } from '../canvas/CanvasProjectionService.js';
import { CanvasSessionService } from '../canvas/CanvasSessionService.js';
import { CanvasRegistryService } from '../canvas/CanvasRegistryService.js';
import { CanvasMapSessionService } from '../canvas-map/CanvasMapSessionService.js';
import { loadProjectSnapshot, type ProjectDocumentPipelineMode } from '../project-session/projectSnapshot.js';
import {
  copyProjectPathsWithSnapshot,
  createProjectDirectoryWithSnapshot,
  createProjectFileWithSnapshot,
  deleteProjectPathsPermanentlyWithSnapshot,
  importExternalLocalProjectPathsWithSnapshot,
  importExternalUploadProjectEntriesWithSnapshot,
  moveProjectPathsWithSnapshot,
  renameProjectPathWithSnapshot
} from '../project-session/projectFileOperations.js';
import {
  projectWatchRefreshFailedSnapshot,
  shouldIgnoreInternalProjectFileEvent,
  shouldIgnoreStaleWatchedEvent,
  shouldIgnoreWatchedCanvasEvent
} from '../project-session/projectWatchEvents.js';
import { serviceError } from './ServiceErrors.js';
import {
  commitProjectDocumentTransaction,
  projectDocumentFileHash,
  type ProjectDocumentReadParticipant,
  type ProjectDocumentTransactionInput
} from '../project-documents/ProjectDocumentTransaction.js';
import { documentServiceError, projectDocumentDiagnostic } from '../project-documents/ProjectDocumentDiagnostics.js';
import {
  projectDocumentDescriptorForPath
} from '../project-documents/documentDescriptors.js';
import type { ProjectDocumentDescriptor } from '../project-documents/ProjectDocumentRegistry.js';
import {
  runImageModelBatch as runNativeImageModelBatch,
  type ImageModelBatchRunOptions,
  type ResolvedImageModelBatchInput
} from '../models/ImageModelBatchService.js';
import {
  audioModelReadinessFailure,
  cliAudioModelDetail,
  cliAudioModelListEntry,
  cliImageModelDetail,
  cliImageModelListEntry,
  cliVideoModelDetail,
  cliVideoModelListEntry,
  imageModelBatchResultFromExecution,
  imageModelReadinessFailure,
  type CliAudioModelDetail,
  type CliAudioModelListEntry,
  type CliImageModelDetail,
  type CliImageModelListEntry,
  type CliModelDetail,
  type CliVideoModelDetail,
  type CliVideoModelListEntry,
  type CliModelSummary,
  type CliRuntimeDiagnostic,
  type CliRuntimeStatus
} from '../models/AppServerModelHelpers.js';
import { TerminalService } from '../terminal/TerminalService.js';
import type { TerminalPtyFactory } from '../terminal/TerminalPty.js';

export interface OpenProjectOptions {
  initializeIfMissing?: boolean;
  createDefaultCanvas?: boolean;
  watchFiles?: boolean;
}

export interface DebruteAppServerOptions {
  globalConfigStore?: GlobalConfigStore;
  imageModelFetch?: ImageModelFetch;
  videoModelFetch?: VideoModelFetch;
  audioModelFetch?: AudioModelFetch;
  remoteUrlLookup?: PublicRemoteHostLookup;
  remoteHttpTransport?: PublicRemoteHttpTransport;
  integrationEnvPath?: string;
  integrationPathExt?: string;
  integrationPlatform?: NodeJS.Platform;
  canvasNodeLayoutSizeReader?: (input: ReadCanvasNodeLayoutSizeInput) => Promise<CanvasLayoutSize>;
  terminalPtyFactory?: TerminalPtyFactory;
  canvasFeedbackRenderRunner?: CanvasFeedbackRenderRunner;
  canvasFeedbackRenderMaxConcurrentArtifacts?: number;
}

export type { CliAudioModelDetail, CliAudioModelListEntry, CliImageModelDetail, CliImageModelListEntry, CliModelDetail, CliModelSummary, CliRuntimeDiagnostic, CliRuntimeStatus, CliVideoModelDetail, CliVideoModelListEntry };

interface AppServerImageModelRequestExecutor {
  catalog: ImageModelCatalogEntry[];
  execute(
    request: ImageModelRequestInput,
    options: AppServerImageModelRequestOptions
  ): Promise<ExecuteImageModelRequestResult>;
}

interface AppServerImageModelRequestOptions {
  invocationId: string;
  signal?: AbortSignal;
}

const INTERNAL_PROJECT_FILE_WRITE_SUPPRESSION_MS = 2000;
const CANVAS_FEEDBACK_RENDER_DIAGNOSTIC_PREFIX = 'canvas-feedback.render_failed:';
const CANVAS_FEEDBACK_DOCUMENT_INVALID_DIAGNOSTIC_ID = 'canvas-feedback.document_invalid';

export class DebruteAppServer {
  private readonly events = new EventEmitter();
  private readonly configStore: GlobalConfigStore;
  private readonly generatedAssetMetadataService: GeneratedAssetMetadataService;
  private readonly canvasFeedbackRenderScheduler: CanvasFeedbackRenderScheduler;
  private readonly canvasFeedbackService: CanvasFeedbackService;
  private readonly canvasImagePreviewService: CanvasImagePreviewService;
  private readonly canvasTextPreviewService: CanvasTextPreviewService;
  private readonly canvasVideoPreviewService: CanvasVideoPreviewService;
  private readonly canvasProjectionService: CanvasProjectionService;
  private readonly canvasSessionService: CanvasSessionService;
  private readonly canvasRegistryService: CanvasRegistryService;
  private readonly canvasMapSessionService: CanvasMapSessionService;
  private snapshot: ProjectSessionSnapshot | undefined;
  private snapshotLoadedAt = 0;
  private fileWatchHandle: ProjectFileWatchHandle | undefined;
  private readonly internalProjectFileWrites = new Map<string, { content?: string; expiresAt: number }>();
  private sessionOperation: Promise<void> = Promise.resolve();
  private terminalService: TerminalService | undefined;

  constructor(private readonly options: DebruteAppServerOptions = {}) {
    this.configStore = options.globalConfigStore ?? new GlobalConfigStore();
    this.generatedAssetMetadataService = createGeneratedAssetMetadataService({
      writeStructuredDocuments: (input) => this.writeStructuredDocuments(input),
      onDiagnostic: (diagnostic) => this.recordGeneratedAssetMetadataDiagnostic(diagnostic)
    });
    this.canvasFeedbackRenderScheduler = createCanvasFeedbackRenderScheduler({
      runner: options.canvasFeedbackRenderRunner ?? createCanvasFeedbackArtifactProcessRunner(),
      ...(options.canvasFeedbackRenderMaxConcurrentArtifacts !== undefined ? { maxConcurrentArtifacts: options.canvasFeedbackRenderMaxConcurrentArtifacts } : {}),
      onDiagnostic: (diagnostic) => this.applyCanvasFeedbackRenderedDiagnostics(diagnostic)
    });
    this.canvasFeedbackService = createCanvasFeedbackService({
      writeStructuredDocument: (projectRoot, absolutePath, content, expectedHash) => this.writeProjectDocumentText(
        projectRoot,
        'canvas-feedback',
        absolutePath,
        content,
        expectedHash
      ),
      renderScheduler: this.canvasFeedbackRenderScheduler
    });
    this.canvasImagePreviewService = createCanvasImagePreviewService();
    this.canvasTextPreviewService = createCanvasTextPreviewService();
    this.canvasVideoPreviewService = createCanvasVideoPreviewService({
      ...(this.options.integrationEnvPath !== undefined ? { envPath: this.options.integrationEnvPath } : {})
    });
    this.canvasProjectionService = new CanvasProjectionService({
      readCanvasVideoMetadata: (input) => readCanvasVideoMetadata({
        ...input,
        ...(this.options.integrationEnvPath !== undefined ? { envPath: this.options.integrationEnvPath } : {})
      })
    });
    this.canvasSessionService = new CanvasSessionService({
      writeCanvasText: (projectRoot, canvasPath, content, expectedHash) => this.writeProjectDocumentText(
        projectRoot,
        'canvas',
        canvasPath,
        content,
        expectedHash
      ),
      projectCanvasWithKnownProjection: (canvas, projection) => this.canvasProjectionService.projectCanvasWithKnownProjection(canvas, projection)
    });
    this.canvasRegistryService = new CanvasRegistryService({
      loadCanvasDocuments: (projectRoot) => this.canvasSessionService.loadCanvasDocuments(projectRoot),
      writeStructuredDocuments: (input) => this.writeStructuredDocuments(input)
    });
    this.canvasMapSessionService = new CanvasMapSessionService({
      loadCanvases: async (projectRoot) => (
        await this.canvasRegistryService.orderedCanvases(projectRoot)
      ).canvases,
      canvasDocumentHash: (projectRoot, canvasId) => this.canvasSessionService.canvasDocumentHash(projectRoot, canvasId),
      resolveCanvasNodeLayoutSize: (projectRoot, node) => this.resolveCanvasNodeLayoutSize(projectRoot, node),
      writeCanvasMapPush: async (input) => {
        const canvasContent = `${JSON.stringify(input.canvas, null, 2)}\n`;
        await this.writeStructuredDocuments({
          projectRoot: input.projectRoot,
          owner: 'canvas-map',
          reads: [
            { absolutePath: input.sourcePath, expectedHash: input.expectedSourceHash },
            { absolutePath: input.canvasPath, expectedHash: input.expectedCanvasHash }
          ],
          writes: [{ absolutePath: input.canvasPath, content: canvasContent }]
        });
        this.canvasSessionService.recordCanvasDocumentTextHash(input.projectRoot, input.canvas.id, canvasContent);
      },
      writeCanvasMapAndCanvasJson: async (input) => {
        const canvasContent = `${JSON.stringify(input.canvas, null, 2)}\n`;
        await this.writeStructuredDocuments({
          projectRoot: input.projectRoot,
          owner: 'canvas-map',
          reads: [
            { absolutePath: input.sourcePath, expectedHash: input.expectedSourceHash },
            { absolutePath: input.canvasPath, expectedHash: input.expectedCanvasHash }
          ],
          writes: [
            { absolutePath: input.sourcePath, content: input.sourceContent },
            { absolutePath: input.canvasPath, content: canvasContent }
          ]
        });
        this.canvasSessionService.recordCanvasDocumentTextHash(input.projectRoot, input.canvas.id, canvasContent);
      }
    });
  }

  onEvent(listener: (event: AppServerEvent) => void): () => void {
    this.events.on('event', listener);
    return () => this.events.off('event', listener);
  }

  getSnapshot(): ProjectSessionSnapshot {
    if (!this.snapshot) {
      throw new Error('No project session is open.');
    }
    return this.snapshot;
  }

  currentSnapshot(): ProjectSessionSnapshot | undefined {
    return this.snapshot;
  }

  async drainSessionOperations(): Promise<void> {
    await this.sessionOperation;
  }

  async openProject(projectRoot: string, options: OpenProjectOptions = { initializeIfMissing: true, createDefaultCanvas: true }): Promise<ProjectSessionSnapshot> {
    return this.enqueueSessionOperation(async () => {
      const paths = getDebruteProjectPaths(projectRoot);
      if (options.initializeIfMissing) {
        if (!await fileExists(paths.projectFile)) {
          await initializeBlankProject(projectRoot, { name: basename(projectRoot) });
        } else {
          await readProjectMetadata(projectRoot);
        }
      }

      if (options.createDefaultCanvas) {
        await this.canvasRegistryService.ensureDefaultCanvas(projectRoot);
      }

      if (this.snapshot && this.snapshot.projectRoot !== projectRoot) {
        this.canvasFeedbackRenderScheduler.cancelProject(this.snapshot.projectRoot);
      }
      let snapshot = await this.loadSnapshot(projectRoot);
      await reconcileCanvasImagePreviewCache({
        projectRoot,
        files: snapshot.files
      });
      this.snapshot = snapshot;
      this.snapshotLoadedAt = Date.now();
      try {
        await this.canvasFeedbackService.queueRenderedFeedbackDocument(projectRoot);
      } catch (error) {
        snapshot = snapshotWithCanvasFeedbackDocumentInvalidDiagnostic(snapshot, {
          filePath: canvasFeedbackPaths(projectRoot).feedbackFile,
          entityId: '.debrute/reviews/canvas-feedback.json'
        }, error);
        this.snapshot = snapshot;
      }
      this.terminalService?.closeAll();
      this.terminalService = new TerminalService({
        projectRoot: snapshot.projectRoot,
        ...(this.options.terminalPtyFactory ? { ptyFactory: this.options.terminalPtyFactory } : {})
      });
      this.emit({ type: 'project.opened', snapshot });
      await mkdir(paths.globalRuntimeDir, { recursive: true });
      if (options.watchFiles ?? true) {
        this.startWatchingProject(projectRoot);
      } else {
        this.stopWatchingProject();
      }
      return snapshot;
    });
  }

  async refreshProject(): Promise<ProjectSessionSnapshot> {
    return this.enqueueSessionOperation(() => this.refreshProjectUnlocked());
  }

  getProjectHealth(): ProjectHealthSummary {
    return this.getSnapshot().health;
  }

  listTerminalSessions(): TerminalSessionList {
    return { sessions: this.getTerminalService().listSessions() };
  }

  async createTerminalSession(input?: CreateTerminalSessionInput): Promise<TerminalSessionResult> {
    return { session: await this.getTerminalService().createSession(input) };
  }

  writeTerminalInput(input: TerminalInputWrite): { ok: true } {
    this.getTerminalService().writeInput(input);
    return { ok: true };
  }

  resizeTerminal(input: TerminalResize): TerminalSessionResult {
    return { session: this.getTerminalService().resize(input) };
  }

  async closeTerminalSession(input: CloseTerminalSessionInput): Promise<{ ok: true }> {
    await this.getTerminalService().close(input);
    return { ok: true };
  }

  subscribeTerminalEvents(
    terminalId: string,
    listener: (event: TerminalEvent) => void
  ): TerminalEventSubscription {
    return this.getTerminalService().subscribe(terminalId, listener);
  }

  async initProjectForCli(projectRoot: string): Promise<ProjectSessionSnapshot> {
    return this.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true, watchFiles: false });
  }

  async projectStatusForCli(projectRoot: string): Promise<ProjectSessionSnapshot> {
    return this.loadSnapshot(projectRoot, { mode: 'readOnly' });
  }

  async runtimeStatusForCli(): Promise<CliRuntimeStatus> {
    const [configuredImageModels, configuredVideoModels, configuredAudioModels] = await Promise.all([
      this.listImageModelsForCli(),
      this.listVideoModelsForCli(),
      this.listAudioModelsForCli()
    ]);
    return {
      ok: true,
      imageModels: createImageModelCatalog().listAll().length,
      availableImageModels: configuredImageModels.length,
      videoModels: createVideoModelCatalog().listAll().length,
      availableVideoModels: configuredVideoModels.length,
      audioModels: createAudioModelCatalog().listAll().length,
      availableAudioModels: configuredAudioModels.length,
      diagnostics: 0
    };
  }

  async runtimeDoctorForCli(): Promise<{ diagnostics: CliRuntimeDiagnostic[] }> {
    const status = await this.runtimeStatusForCli();
    const diagnostics: CliRuntimeDiagnostic[] = [];
    if (status.availableImageModels === 0) {
      diagnostics.push({ severity: 'warning', code: 'image_model_not_configured', message: 'No available image model is configured.' });
    }
    if (status.availableVideoModels === 0) {
      diagnostics.push({ severity: 'warning', code: 'video_model_not_configured', message: 'No available video model is configured.' });
    }
    if (status.availableAudioModels === 0) {
      diagnostics.push({ severity: 'warning', code: 'audio_model_not_configured', message: 'No available audio model is configured.' });
    }
    if (diagnostics.length === 0) {
      diagnostics.push({ severity: 'info', code: 'runtime_ok', message: 'Debrute runtime configuration is usable.' });
    }
    return { diagnostics };
  }

  async readProjectTextFile(projectRelativePath: string): Promise<ProjectTextFile> {
    const current = this.getSnapshot();
    return readProjectTextFile(current.projectRoot, projectRelativePath);
  }

  async projectFileExistsWithContent(input: { projectRelativePath: string }): Promise<boolean> {
    if (typeof input.projectRelativePath !== 'string' || input.projectRelativePath.length === 0) {
      throw new Error('Project relative path must be a non-empty string.');
    }
    const current = this.getSnapshot();
    try {
      const fileStat = await stat(await resolveExistingProjectPath(current.projectRoot, input.projectRelativePath));
      return fileStat.isFile() && fileStat.size > 0;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  async writeProjectTextFile(projectRelativePath: string, content: string): Promise<ProjectTextFile> {
    return this.enqueueSessionOperation(async () => {
      if (typeof content !== 'string') {
        throw new Error(`Project text content must be a string: ${projectRelativePath}`);
      }
      const current = this.getSnapshot();
      const structuredDocumentWrite = await this.writeProjectDocumentSourceTextFile(current.projectRoot, projectRelativePath, content);
      const written = structuredDocumentWrite ?? await writeProjectTextFile(current.projectRoot, projectRelativePath, content);
      await this.refreshProjectUnlocked();
      return written;
    });
  }

  private async writeProjectDocumentSourceTextFile(
    projectRoot: string,
    projectRelativePath: string,
    content: string
  ): Promise<ProjectTextFile | undefined> {
    const normalizedProjectRelativePath = normalizeProjectRelativePath(projectRelativePath);
    const descriptor = projectDocumentDescriptorForPath(normalizedProjectRelativePath);
    if (!descriptor) {
      return undefined;
    }
    if (descriptor.role !== 'source') {
      throw documentServiceError('document_descriptor_violation', 'Project document is not directly editable as source text.', {
        file_path: normalizedProjectRelativePath,
        document_type: descriptor.type
      });
    }
    const absolutePath = await resolveProjectPathForWrite(projectRoot, normalizedProjectRelativePath);
    const expectedHash = await projectDocumentFileHash(absolutePath);
    await this.writeStructuredDocuments({
      projectRoot,
      owner: sourceProjectDocumentTextOwner(descriptor),
      reads: [{ absolutePath, expectedHash }],
      writes: [{ absolutePath, content }]
    });
    return readProjectTextFile(projectRoot, normalizedProjectRelativePath);
  }

  async createProjectFile(input: CreateProjectPathInput): Promise<ProjectFileOperationResult> {
    return this.enqueueSessionOperation(() => createProjectFileWithSnapshot(this.projectFileOperationContext(), input));
  }

  async createProjectDirectory(input: CreateProjectPathInput): Promise<ProjectFileOperationResult> {
    return this.enqueueSessionOperation(() => createProjectDirectoryWithSnapshot(this.projectFileOperationContext(), input));
  }

  async renameProjectPath(input: RenameProjectPathInput): Promise<ProjectFileOperationResult> {
    return this.enqueueSessionOperation(() => renameProjectPathWithSnapshot(this.projectFileOperationContext(), input));
  }

  async copyProjectPaths(input: CopyProjectPathsInput): Promise<ProjectFileBatchOperationResult> {
    return this.enqueueSessionOperation(() => copyProjectPathsWithSnapshot(this.projectFileOperationContext(), input));
  }

  async moveProjectPaths(input: MoveProjectPathsInput): Promise<ProjectFileBatchOperationResult> {
    return this.enqueueSessionOperation(() => moveProjectPathsWithSnapshot(this.projectFileOperationContext(), input));
  }

  async deleteProjectPathsPermanently(input: DeleteProjectPathsInput): Promise<ProjectFileBatchOperationResult> {
    return this.enqueueSessionOperation(() => deleteProjectPathsPermanentlyWithSnapshot(this.projectFileOperationContext(), input));
  }

  async importExternalLocalProjectPaths(input: ImportExternalLocalProjectPathsInput): Promise<ProjectFileBatchOperationResult> {
    return this.enqueueSessionOperation(() => importExternalLocalProjectPathsWithSnapshot(this.projectFileOperationContext(), input));
  }

  async importExternalUploadProjectEntries(input: ImportExternalUploadProjectEntriesInput): Promise<ProjectFileBatchOperationResult> {
    return this.enqueueSessionOperation(() => importExternalUploadProjectEntriesWithSnapshot(this.projectFileOperationContext(), input));
  }

  async recordGeneratedAssetMetadata(input: RecordGeneratedAssetInput): Promise<GeneratedAssetRecord> {
    return this.enqueueSessionOperation(async () => this.recordGeneratedAssetMetadataUnlocked(input));
  }

  async lookupGeneratedAssetMetadata(input: { projectRelativePath: string }): Promise<GeneratedAssetMetadataLookup> {
    const current = this.getSnapshot();
    return this.generatedAssetMetadataService.lookupGeneratedAssetMetadata(current.projectRoot, input);
  }

  async listGeneratedAssets(): Promise<GeneratedAssetRecord[]> {
    const current = this.getSnapshot();
    return this.generatedAssetMetadataService.listGeneratedAssets(current.projectRoot);
  }

  async readGeneratedAsset(recordId: string): Promise<GeneratedAssetRecord> {
    const current = this.getSnapshot();
    return this.generatedAssetMetadataService.readGeneratedAsset(current.projectRoot, recordId);
  }

  async resolveGeneratedAssetRawPath(recordId: string): Promise<string> {
    const current = this.getSnapshot();
    return this.generatedAssetMetadataService.resolveGeneratedAssetRawPath(current.projectRoot, recordId);
  }

  async lookupGeneratedAssetMetadataForCli(projectRoot: string, input: { projectRelativePath: string }): Promise<GeneratedAssetMetadataLookup> {
    await readProjectMetadata(projectRoot);
    return this.generatedAssetMetadataService.lookupGeneratedAssetMetadata(projectRoot, input);
  }

  async readCanvasFeedback(): Promise<CanvasFeedbackDocument> {
    const current = this.getSnapshot();
    return this.canvasFeedbackService.readCanvasFeedback(current.projectRoot);
  }

  async updateCanvasFeedbackEntry(input: UpdateCanvasFeedbackEntryInput): Promise<CanvasFeedbackDocument> {
    return this.enqueueSessionOperation(async () => {
      const current = this.getSnapshot();
      const feedback = await this.canvasFeedbackService.updateCanvasFeedbackEntry(current.projectRoot, input);
      this.emit({ type: 'canvas.feedback.changed', feedback });
      return feedback;
    });
  }

  async resolveCanvasImagePreview(
    input: Omit<ResolveCanvasImagePreviewInput, 'projectRoot'>
  ): Promise<CanvasImagePreviewResult> {
    const current = this.getSnapshot();
    return this.canvasImagePreviewService.resolve({
      projectRoot: current.projectRoot,
      ...input
    });
  }

  async saveCanvasTextPreviewSource(
    input: Omit<CanvasTextPreviewSaveSourceInput, 'projectRoot'>
  ) {
    const current = this.getSnapshot();
    return this.canvasTextPreviewService.saveSource({
      projectRoot: current.projectRoot,
      ...input
    });
  }

  async readCanvasTextPreviewSources(
    input: Omit<CanvasTextPreviewReadSourcesInput, 'projectRoot'>
  ) {
    const current = this.getSnapshot();
    return this.canvasTextPreviewService.readSources({
      projectRoot: current.projectRoot,
      ...input
    });
  }

  async resolveCanvasTextPreviewVariant(
    input: Omit<CanvasTextPreviewResolveVariantInput, 'projectRoot'>
  ) {
    const current = this.getSnapshot();
    return this.canvasTextPreviewService.resolveVariant({
      projectRoot: current.projectRoot,
      ...input
    });
  }

  async readCanvasVideoPreviewSources(
    input: Omit<CanvasVideoPreviewReadSourcesInput, 'projectRoot'>
  ) {
    const current = this.getSnapshot();
    return this.canvasVideoPreviewService.readSources({
      projectRoot: current.projectRoot,
      ...input
    });
  }

  async resolveCanvasVideoPreviewVariant(
    input: Omit<CanvasVideoPreviewResolveVariantInput, 'projectRoot'>
  ) {
    const current = this.getSnapshot();
    return this.canvasVideoPreviewService.resolveVariant({
      projectRoot: current.projectRoot,
      ...input
    });
  }

  async pushCanvasMapForProject(projectRoot: string, input: { canvasId: string }): Promise<{ ok: true; command: 'canvas-map.push'; canvasId: string }> {
    try {
      return await this.canvasMapSessionService.pushCanvasMapForProject(await realpath(projectRoot), input);
    } catch (error) {
      if (error instanceof CanvasMapError) {
        throw canvasMapServiceError(error, input.canvasId);
      }
      throw error;
    }
  }

  async addProjectPathToCanvasMap(input: AddProjectPathToCanvasMapInput): Promise<ProjectAddProjectPathToCanvasMapResult> {
    return this.enqueueSessionOperation(async () => {
      const current = this.getSnapshot();
      let writeback: Awaited<ReturnType<CanvasMapSessionService['addProjectPathToCanvasMap']>>;
      try {
        writeback = await this.canvasMapSessionService.addProjectPathToCanvasMap(current.projectRoot, input);
      } catch (error) {
        if (error instanceof CanvasMapError) {
          throw canvasMapServiceError(error, input.canvasId);
        }
        throw error;
      }
      const snapshot = await this.refreshProjectUnlocked();
      const canvas = snapshot.canvases.find((item) => item.id === input.canvasId);
      const projection = snapshot.projections.find((item) => item.canvasId === input.canvasId);
      if (!canvas || !projection) {
        throw serviceError('canvas_map_canvas_missing', `Canvas is not loaded: ${input.canvasId}`, { canvas_id: input.canvasId });
      }
      return {
        snapshot,
        canvas,
        projection,
        centerProjectRelativePath: writeback.centerProjectRelativePath
      };
    });
  }

  async createCanvas(): Promise<ProjectCanvasManagementResult> {
    return this.enqueueSessionOperation(async () => {
      const current = this.getSnapshot();
      const { canvasId } = await this.canvasRegistryService.createCanvas(current.projectRoot);
      const snapshot = await this.refreshProjectUnlocked();
      return { snapshot, activeCanvasId: canvasId };
    });
  }

  async renameCanvas(input: { canvasId: string; name: string }): Promise<ProjectCanvasManagementResult> {
    return this.enqueueSessionOperation(async () => {
      const current = this.getSnapshot();
      const { canvasId } = await this.canvasRegistryService.renameCanvas(current.projectRoot, input);
      const snapshot = await this.refreshProjectUnlocked();
      return { snapshot, activeCanvasId: canvasId };
    });
  }

  async deleteCanvas(input: { canvasId: string }): Promise<ProjectCanvasManagementResult> {
    return this.enqueueSessionOperation(async () => {
      const current = this.getSnapshot();
      const { activeCanvasId } = await this.canvasRegistryService.deleteCanvas(current.projectRoot, input);
      const snapshot = await this.refreshProjectUnlocked();
      return { snapshot, activeCanvasId };
    });
  }

  async reorderCanvases(input: { canvasOrder: string[] }): Promise<ProjectCanvasManagementResult> {
    return this.enqueueSessionOperation(async () => {
      const current = this.getSnapshot();
      await this.canvasRegistryService.reorderCanvases(current.projectRoot, input);
      const snapshot = await this.refreshProjectUnlocked();
      return { snapshot };
    });
  }

  async repairCanvasIndex(): Promise<ProjectCanvasManagementResult> {
    return this.enqueueSessionOperation(async () => {
      const current = this.getSnapshot();
      const { activeCanvasId } = await this.canvasRegistryService.repairCanvasIndex(current.projectRoot);
      const snapshot = await this.refreshProjectUnlocked();
      return { snapshot, activeCanvasId };
    });
  }

  async updateCanvasNodeLayouts(input: {
    canvasId: string;
    nodeLayouts?: Array<{
      projectRelativePath: string;
      x: number;
      y: number;
      width?: number;
      height?: number;
    }>;
  }): Promise<{ canvas: CanvasDocument; projection: CanvasProjection }> {
    return this.enqueueSessionOperation(async () => (
      this.applyCanvasSessionUpdate(await this.canvasSessionService.updateCanvasNodeLayouts(this.getSnapshot(), input))
    ));
  }

  async resetCanvasNodeLayouts(
    input: { canvasId: string } & ({ all: true } | { pathRules: CanvasMapPathRuleSet })
  ): Promise<{ canvas: CanvasDocument; projection: CanvasProjection; resetCount: number }> {
    return this.enqueueSessionOperation(async () => {
      let reset: Awaited<ReturnType<CanvasMapSessionService['resetCanvasNodeLayouts']>>;
      try {
        reset = await this.canvasMapSessionService.resetCanvasNodeLayouts(this.getSnapshot().projectRoot, input);
      } catch (error) {
        if (error instanceof CanvasMapError) {
          throw canvasMapServiceError(error, input.canvasId);
        }
        throw error;
      }
      const snapshot = await this.refreshProjectUnlocked();
      const canvas = snapshot.canvases.find((item) => item.id === input.canvasId);
      const projection = snapshot.projections.find((item) => item.canvasId === input.canvasId);
      if (!canvas || !projection) {
        throw serviceError('canvas_map_canvas_missing', `Canvas is not loaded: ${input.canvasId}`, { canvas_id: input.canvasId });
      }
      return {
        canvas,
        projection,
        resetCount: reset.resetCount
      };
    });
  }

  async bringCanvasNodeToFront(input: {
    canvasId: string;
    projectRelativePath: string;
  }): Promise<{ canvas: CanvasDocument; projection: CanvasProjection }> {
    return this.enqueueSessionOperation(async () => (
      this.applyCanvasSessionUpdate(await this.canvasSessionService.bringCanvasNodeToFront(this.getSnapshot(), input))
    ));
  }

  async updateCanvasVideoPlaybackState(input: UpdateCanvasVideoPlaybackStateInput): Promise<{ canvas: CanvasDocument; projection: CanvasProjection }> {
    return this.enqueueSessionOperation(async () => (
      this.applyCanvasSessionUpdate(await this.canvasSessionService.updateCanvasVideoPlaybackState(this.getSnapshot(), input))
    ));
  }

  async updateCanvasTextViewportState(input: UpdateCanvasTextViewportStateInput): Promise<{ canvas: CanvasDocument; projection: CanvasProjection }> {
    return this.enqueueSessionOperation(async () => (
      this.applyCanvasSessionUpdate(await this.canvasSessionService.updateCanvasTextViewportState(this.getSnapshot(), input))
    ));
  }

  async listImageModelsForCli(): Promise<CliImageModelListEntry[]> {
    const settings = await this.readImageModelSettings();
    const configured = new Set(settings.models.filter((model) => model.apiKeySet).map((model) => model.debruteModelId));
    return createImageModelCatalog().listAll()
      .filter((entry) => configured.has(entry.debruteModelId))
      .map(cliImageModelListEntry);
  }

  async describeImageModelForCli(modelId: string): Promise<CliImageModelDetail> {
    const settings = await this.readImageModelSettings();
    const setting = settings.models.find((model) => model.debruteModelId === modelId);
    const catalog = createImageModelCatalog();
    const detail = catalog.details([modelId], catalog.listAll()).details[0];
    if (!setting || !detail) {
      throw serviceError('model_unavailable', `Image model is unknown: ${modelId}`, { model: modelId });
    }
    const officialDescription = await describeImageModelOfficialDoc(modelId);
    if (!officialDescription) {
      throw serviceError('image_model_official_doc_missing', `Official image model documentation is missing: ${modelId}`, { model: modelId });
    }
    return cliImageModelDetail(setting, detail, officialDescription);
  }

  async runImageModelBatch(input: RunImageModelBatchInput, options: ImageModelBatchRunOptions = {}): Promise<ImageModelBatchSummary> {
    const current = this.getSnapshot();
    const resolvedInput = await this.resolveImageModelBatchInput(current.projectRoot, input);
    let imageRequestExecutor: Promise<AppServerImageModelRequestExecutor> | undefined;
    return runNativeImageModelBatch(resolvedInput, {
      projectFileExistsWithContent: (check) => this.projectFileExistsWithContent(check),
      executeImageModelRequest: async (request) => {
        const { signal, ...imageRequest } = request;
        imageRequestExecutor ??= this.createImageModelRequestExecutor(current.projectRoot);
        const executor = await imageRequestExecutor;
        return imageModelBatchResultFromExecution(
          await executor.execute(imageRequest, {
            invocationId: `image-batch-${randomUUID()}`,
            ...(signal ? { signal } : {})
          })
        );
      }
    }, options);
  }

  private async resolveImageModelBatchInput(
    projectRoot: string,
    input: RunImageModelBatchInput
  ): Promise<ResolvedImageModelBatchInput> {
    const logProjectRelativePath = normalizeProjectRelativePath(input.logPath);
    const summaryProjectRelativePath = input.summaryPath === undefined
      ? undefined
      : normalizeProjectRelativePath(input.summaryPath);
    assertProjectTreeVisibleMutationPath(logProjectRelativePath);
    if (summaryProjectRelativePath) {
      assertProjectTreeVisibleMutationPath(summaryProjectRelativePath);
    }
    const source = await this.resolveImageModelBatchSource(projectRoot, input.source);
    return {
      ...input,
      source,
      logPath: await resolveNoSymlinkProjectPathForWrite(projectRoot, logProjectRelativePath),
      logProjectRelativePath,
      ...(summaryProjectRelativePath
        ? {
            summaryPath: await resolveNoSymlinkProjectPathForWrite(projectRoot, summaryProjectRelativePath),
            summaryProjectRelativePath
          }
        : {})
    };
  }

  private async resolveImageModelBatchSource(
    projectRoot: string,
    source: RunImageModelBatchInput['source']
  ): Promise<RunImageModelBatchInput['source']> {
    if (source.kind === 'requests') {
      return source;
    }
    const projectRelativePath = normalizeProjectRelativePath(source.path);
    return {
      ...source,
      path: await resolveExistingProjectPath(projectRoot, projectRelativePath)
    };
  }

  async runImageModelRequestForCli(input: ImageModelRequestInput): Promise<DebruteCapabilityResult> {
    const current = this.getSnapshot();
    const executor = await this.createImageModelRequestExecutor(current.projectRoot);
    const result = await executor.execute(input, { invocationId: `image-${randomUUID()}` });
    const entry = executor.catalog.find((item) => item.debruteModelId === input.model);
    if (result.status === 'error') {
      return capabilityError(result.error, result.content, undefined, {
        outputs: {
          content: result.content,
          model: input.model
        },
        logs: result.logs
      });
    }
    if (!entry) {
      throw new Error(`Image model execution succeeded without a catalog entry: ${input.model}`);
    }
    await this.refreshProject();
    return capabilityOk({
      content: result.content,
      model: entry.debruteModelId
    }, {
      artifacts: projectArtifactPointers(result.artifacts),
      logs: result.logs
    });
  }

  async listVideoModelsForCli(): Promise<CliVideoModelListEntry[]> {
    const settings = await this.readVideoModelSettings();
    const configured = new Set(settings.models.filter((model) => model.apiKeySet).map((model) => model.debruteModelId));
    return createVideoModelCatalog().listAll()
      .filter((entry) => configured.has(entry.debruteModelId))
      .map(cliVideoModelListEntry);
  }

  async describeVideoModelForCli(modelId: string): Promise<CliVideoModelDetail> {
    const settings = await this.readVideoModelSettings();
    const setting = settings.models.find((model) => model.debruteModelId === modelId);
    const catalog = createVideoModelCatalog();
    const detail = catalog.details([modelId], catalog.listAll()).details[0];
    if (!setting || !detail) {
      throw serviceError('model_unavailable', `Video model is unknown: ${modelId}`, { model: modelId });
    }
    const officialDescription = await describeVideoModelOfficialDoc(modelId);
    if (!officialDescription) {
      throw serviceError('video_model_official_doc_missing', `Official video model documentation is missing: ${modelId}`, { model: modelId });
    }
    return cliVideoModelDetail(setting, detail, officialDescription);
  }

  async runVideoModelRequestForCli(input: VideoModelRequestInput): Promise<DebruteCapabilityResult> {
    const current = this.getSnapshot();
    const snapshot = await this.configStore.readGlobalSnapshot();
    const settings = snapshot.settings.models.video;
    const secrets = snapshot.secrets;
    const result = await executeVideoModelRequest({
      projectRoot: current.projectRoot,
      invocationId: `video-${randomUUID()}`,
      input,
      settings,
      secrets: { videoModelApiKeys: secrets.videoModelApiKeys },
      recordGeneratedAsset: (metadata) => this.recordGeneratedAssetMetadata(metadata).then(() => undefined),
      ...(this.options.videoModelFetch ? { fetch: this.options.videoModelFetch } : {}),
      ...(this.options.remoteUrlLookup ? { remoteUrlLookup: this.options.remoteUrlLookup } : {}),
      ...(this.options.remoteHttpTransport ? { remoteHttpTransport: this.options.remoteHttpTransport } : {})
    });
    if (result.status === 'error') {
      return capabilityError(result.error, result.content, undefined, {
        outputs: {
          content: result.content,
          model: input.model
        },
        logs: result.logs
      });
    }
    const entry = createVideoModelCatalog().get(input.model);
    if (!entry) {
      throw new Error(`Video model execution succeeded without a catalog entry: ${input.model}`);
    }
    await this.refreshProject();
    return capabilityOk({
      content: result.content,
      model: entry.debruteModelId
    }, {
      artifacts: projectArtifactPointers(result.artifacts),
      logs: result.logs
    });
  }

  async listAudioModelsForCli(kind?: AudioModelKind): Promise<CliAudioModelListEntry[]> {
    const settings = await this.readAudioModelSettings();
    const configured = new Set(settings.models.filter((model) => model.apiKeySet).map((model) => model.debruteModelId));
    const catalog = createAudioModelCatalog();
    const entries = kind ? catalog.listByKind(kind) : catalog.listAll();
    return entries
      .filter((entry) => configured.has(entry.debruteModelId))
      .map(cliAudioModelListEntry);
  }

  async describeAudioModelForCli(kind: AudioModelKind, modelId: string): Promise<CliAudioModelDetail> {
    const settings = await this.readAudioModelSettings();
    const setting = settings.models.find((model) => model.debruteModelId === modelId);
    const catalog = createAudioModelCatalog();
    const detail = catalog.details([modelId], catalog.listAll()).details[0];
    if (!setting || !detail) {
      throw serviceError('audio_model_unavailable', `Audio model is unknown: ${modelId}`, { model: modelId });
    }
    if (detail.kind !== kind) {
      throw serviceError('audio_model_kind_mismatch', `Audio model kind mismatch: ${modelId} is ${detail.kind}, not ${kind}`, {
        model: modelId,
        expected_kind: kind,
        actual_kind: detail.kind
      });
    }
    const officialDescription = await describeAudioModelOfficialDoc(modelId);
    if (!officialDescription) {
      throw serviceError('audio_model_official_doc_missing', `Official audio model documentation is missing: ${modelId}`, { model: modelId });
    }
    return cliAudioModelDetail(setting, detail, officialDescription);
  }

  async runAudioModelRequestForCli(kind: AudioModelKind, input: AudioModelRequestInput): Promise<DebruteCapabilityResult> {
    const current = this.getSnapshot();
    const entry = createAudioModelCatalog().get(input.model);
    if (!entry) {
      const message = `Audio model is unavailable: ${input.model}`;
      return capabilityError('audio_model_unavailable', message, undefined, {
        outputs: {
          content: message,
          model: input.model
        },
        logs: [{ stage: 'resolve_model' }]
      });
    }
    if (entry.kind !== kind) {
      const message = `Audio model kind mismatch: ${input.model} is ${entry.kind}, not ${kind}`;
      return capabilityError('audio_model_kind_mismatch', message, {
        model: input.model,
        expected_kind: kind,
        actual_kind: entry.kind
      }, {
        outputs: {
          content: message,
          model: input.model
        },
        logs: [{ stage: 'resolve_model_kind' }]
      });
    }
    const snapshot = await this.configStore.readGlobalSnapshot();
    const settings = snapshot.settings.models.audio;
    const secrets = snapshot.secrets;
    const settingsView = createAudioModelSettingsView(
      settings,
      secrets,
      createAudioModelCatalog().listAll()
    );
    const readinessFailure = audioModelReadinessFailure(input.model, settingsView.models);
    if (readinessFailure) {
      return capabilityError(readinessFailure.code, readinessFailure.message, undefined, {
        outputs: {
          content: readinessFailure.message,
          model: input.model
        },
        logs: [{ stage: readinessFailure.stage }]
      });
    }
    const result = await executeAudioModelRequest({
      projectRoot: current.projectRoot,
      invocationId: `audio-${kind}-${randomUUID()}`,
      requestedKind: kind,
      input,
      settings,
      secrets: { audioModelApiKeys: secrets.audioModelApiKeys },
      recordGeneratedAsset: (metadata) => this.recordGeneratedAssetMetadata(metadata).then(() => undefined),
      ...(this.options.audioModelFetch ? { fetch: this.options.audioModelFetch } : {}),
      ...(this.options.remoteUrlLookup ? { remoteUrlLookup: this.options.remoteUrlLookup } : {}),
      ...(this.options.remoteHttpTransport ? { remoteHttpTransport: this.options.remoteHttpTransport } : {})
    });
    if (result.status === 'error') {
      return capabilityError(result.error, result.content, undefined, {
        outputs: {
          content: result.content,
          model: input.model
        },
        logs: result.logs
      });
    }
    await this.refreshProject();
    return capabilityOk({
      content: result.content,
      model: entry.debruteModelId
    }, {
      artifacts: projectArtifactPointers(result.artifacts),
      logs: result.logs
    });
  }

  close(): void {
    if (this.snapshot) {
      this.canvasFeedbackRenderScheduler.cancelProject(this.snapshot.projectRoot);
    }
    this.terminalService?.closeAll();
    this.terminalService = undefined;
    this.stopWatchingProject();
  }

  private projectFileOperationContext(): { snapshot: ProjectSessionSnapshot; refreshProject: () => Promise<ProjectSessionSnapshot> } {
    return {
      snapshot: this.getSnapshot(),
      refreshProject: () => this.refreshProjectUnlocked()
    };
  }

  private applyCanvasSessionUpdate(result: { canvas: CanvasDocument; snapshot: ProjectSessionSnapshot; changed: boolean }): { canvas: CanvasDocument; projection: CanvasProjection } {
    this.snapshot = result.snapshot;
    const projection = result.snapshot.projections.find((item) => item.canvasId === result.canvas.id);
    if (!projection) {
      throw new Error(`Canvas projection is not loaded: ${result.canvas.id}`);
    }
    if (result.changed) {
      this.emit({ type: 'canvas.changed', canvas: result.canvas, projection });
    }
    return { canvas: result.canvas, projection };
  }

  private async createImageModelRequestExecutor(projectRoot: string): Promise<AppServerImageModelRequestExecutor> {
    const snapshot = await this.configStore.readGlobalSnapshot();
    const settings = snapshot.settings.models.image;
    const secrets = snapshot.secrets;
    const catalogApi = createImageModelCatalog();
    const settingsView = createImageModelSettingsView(settings, secrets, catalogApi.listAll());
    const catalog = catalogApi.listConfigured(settingsView.models
      .filter((model) => model.apiKeySet)
      .map((model) => model.debruteModelId));
    return {
      catalog,
      execute: async (request, options) => {
        const readinessFailure = imageModelReadinessFailure(request.model, settingsView.models);
        if (readinessFailure) {
          return {
            status: 'error',
            content: readinessFailure.message,
            error: readinessFailure.code,
            logs: [{ stage: readinessFailure.stage, model: request.model }]
          };
        }
        const entry = catalog.find((item) => item.debruteModelId === request.model);
        if (!entry) {
          return {
            status: 'error',
            content: `Image model is unavailable: ${request.model}`,
            error: 'model_unavailable',
            logs: [{ stage: 'resolve_model', requestedModel: request.model }]
          };
        }
        return executeImageModelRequest({
          projectRoot,
          invocationId: options.invocationId,
          input: request,
          settings,
          secrets: { imageModelApiKeys: secrets.imageModelApiKeys },
          recordGeneratedAsset: (metadata) => this.recordGeneratedAssetMetadata(metadata).then(() => undefined),
          ...(this.options.imageModelFetch ? { fetch: this.options.imageModelFetch } : {}),
          ...(this.options.remoteUrlLookup ? { remoteUrlLookup: this.options.remoteUrlLookup } : {}),
          ...(this.options.remoteHttpTransport ? { remoteHttpTransport: this.options.remoteHttpTransport } : {}),
          ...(options.signal ? { signal: options.signal } : {})
        });
      }
    };
  }

  private suppressInternalProjectPathEvent(absolutePath: string, content?: string): void {
    const expiresAt = Date.now() + INTERNAL_PROJECT_FILE_WRITE_SUPPRESSION_MS;
    this.internalProjectFileWrites.set(absolutePath, {
      ...(content !== undefined ? { content } : {}),
      expiresAt
    });
  }

  private clearInternalProjectPathEvent(absolutePath: string): void {
    this.internalProjectFileWrites.delete(absolutePath);
  }

  private async writeProjectDocumentText(
    projectRoot: string,
    owner: string,
    absolutePath: string,
    content: string,
    expectedHash: string | null
  ): Promise<void> {
    await this.writeStructuredDocuments({
      projectRoot,
      owner,
      reads: [{ absolutePath, expectedHash }],
      writes: [{ absolutePath, content }]
    });
  }

  private async writeStructuredDocuments(input: {
    projectRoot: string;
    owner: string;
    reads: ProjectDocumentReadParticipant[];
    writes?: Array<{ absolutePath: string; content: string }>;
    deletes?: Array<{ absolutePath: string }>;
  }): Promise<void> {
    const transactionInput: ProjectDocumentTransactionInput = {
      projectRoot: input.projectRoot,
      owner: input.owner,
      reads: input.reads
    };
    if (input.writes) {
      transactionInput.writes = input.writes.map((write) => ({
        ...write,
        suppressInternalEvent: (absolutePath, content) => this.suppressInternalProjectPathEvent(absolutePath, content),
        clearInternalEvent: (absolutePath) => this.clearInternalProjectPathEvent(absolutePath)
      }));
    }
    if (input.deletes) {
      transactionInput.deletes = input.deletes.map((deleteItem) => ({
        ...deleteItem,
        suppressInternalEvent: (absolutePath) => this.suppressInternalProjectPathEvent(absolutePath),
        clearInternalEvent: (absolutePath) => this.clearInternalProjectPathEvent(absolutePath)
      }));
    }
    await commitProjectDocumentTransaction(transactionInput);
  }

  private async loadSnapshot(
    projectRoot: string,
    options: { mode: ProjectDocumentPipelineMode } = { mode: 'push' }
  ): Promise<ProjectSessionSnapshot> {
    return loadProjectSnapshot({
      projectRoot,
      mode: options.mode,
      loadOrderedCanvases: (root) => this.canvasRegistryService.orderedCanvases(root),
      synchronizeCanvasMaps: (root, canvases, files, syncOptions) => this.canvasMapSessionService.synchronizeCanvasMaps(
        root,
        canvases,
        files,
        syncOptions
      ),
      projectCanvasDocument: (root, canvas, diagnostics) => this.canvasProjectionService.projectCanvasDocument(
        root,
        canvas,
        diagnostics
      )
    });
  }

  private async resolveCanvasNodeLayoutSize(projectRoot: string, node: CanvasDesiredNode): Promise<CanvasLayoutSize> {
    return (this.options.canvasNodeLayoutSizeReader ?? readCanvasNodeLayoutSize)({
      projectRoot,
      projectRelativePath: node.projectRelativePath,
      nodeKind: node.nodeKind,
      mediaKind: node.mediaKind ?? 'unknown',
      ...(this.options.integrationEnvPath !== undefined ? { envPath: this.options.integrationEnvPath } : {})
    });
  }

  private startWatchingProject(projectRoot: string): void {
    this.fileWatchHandle?.close();
    this.fileWatchHandle = watchProjectFiles(projectRoot, (event) => {
      void this.handleWatchedFileEvent(event);
    });
  }

  private stopWatchingProject(): void {
    this.fileWatchHandle?.close();
    this.fileWatchHandle = undefined;
  }

  private async handleWatchedFileEvent(event: NormalizedFileWatchEvent): Promise<void> {
    return this.enqueueSessionOperation(() => this.handleWatchedFileEventUnlocked(event));
  }

  private async handleWatchedFileEventUnlocked(event: NormalizedFileWatchEvent): Promise<void> {
    try {
      if (event.affects.length === 0) {
        return;
      }
      if (event.affects.length === 1 && event.affects[0] === 'generated-asset-metadata') {
        return;
      }
      if (await shouldIgnoreStaleWatchedEvent({
        snapshotLoadedAt: this.snapshotLoadedAt,
        event
      })) {
        return;
      }
      if (await shouldIgnoreInternalProjectFileEvent({
        event,
        internalProjectFileWrites: this.internalProjectFileWrites
      })) {
        return;
      }
      if (await shouldIgnoreWatchedCanvasEvent({
        current: this.snapshot,
        event,
        internalProjectFileWrites: this.internalProjectFileWrites
      })) {
        return;
      }
      if (event.affects.includes('canvas-feedback')) {
        const current = this.getSnapshot();
        await this.canvasFeedbackService.queueRenderedFeedbackDocument(current.projectRoot);
      } else if (event.affects.includes('content')) {
        const current = this.getSnapshot();
        await this.canvasFeedbackService.queueRenderedFeedbackForSource(current.projectRoot, event.projectRelativePath);
      }
      const loadedSnapshot = await this.loadFreshProjectSnapshotUnlocked();
      const snapshot = event.affects.includes('canvas-feedback')
        ? snapshotWithoutCanvasFeedbackDocumentInvalidDiagnostic(loadedSnapshot)
        : loadedSnapshot;
      this.snapshot = snapshot;
      this.emit({ type: 'project.fileChanged', event, snapshot });
    } catch (error) {
      const current = this.snapshot;
      if (!current) {
        return;
      }
      const snapshot = event.affects.includes('canvas-feedback')
        ? snapshotWithCanvasFeedbackDocumentInvalidDiagnostic(current, {
          filePath: event.absolutePath,
          entityId: event.projectRelativePath
        }, error)
        : projectWatchRefreshFailedSnapshot({
          current,
          event,
          errorMessage: errorMessage(error),
          checkedAt: new Date().toISOString()
        });
      this.snapshot = snapshot;
      this.emit({ type: 'project.fileChanged', event, snapshot });
    }
  }

  private emit(event: AppServerEvent): void {
    this.events.emit('event', event);
  }

  private applyCanvasFeedbackRenderedDiagnostics(renderedFeedback: CanvasFeedbackRenderDiagnosticUpdate): void {
    const current = this.snapshot;
    if (!current) {
      return;
    }
    const snapshot = snapshotWithCanvasFeedbackRenderedDiagnostics(current, renderedFeedback);
    if (snapshot === current) {
      return;
    }
    this.snapshot = snapshot;
    this.emit({ type: 'project.changed', snapshot });
  }

  private getTerminalService(): TerminalService {
    if (!this.terminalService) {
      throw serviceError('terminal_project_not_open', 'Terminal service is unavailable because no project session is open.');
    }
    return this.terminalService;
  }

  private async recordGeneratedAssetMetadataUnlocked(input: RecordGeneratedAssetInput): Promise<GeneratedAssetRecord> {
    const current = this.getSnapshot();
    const record = await this.generatedAssetMetadataService.recordGeneratedAsset(current.projectRoot, input);
    this.emit({ type: 'generatedAsset.metadata.changed', record });
    return record;
  }

  private recordGeneratedAssetMetadataDiagnostic(diagnostic: GeneratedAssetMetadataDiagnostic): void {
    const current = this.snapshot;
    if (!current) {
      return;
    }
    const projectDiagnostic = projectDocumentDiagnostic({
      id: `generated-asset.metadata:${diagnostic.code}:${diagnostic.metadataPath ?? 'metadata'}`,
      severity: 'warning',
      code: diagnostic.code,
      message: diagnostic.message,
      ...(diagnostic.metadataPath ? { filePath: join(current.projectRoot, diagnostic.metadataPath) } : {}),
      ...(diagnostic.recordId ? { entityId: diagnostic.recordId } : {})
    });
    const snapshot: ProjectSessionSnapshot = {
      ...current,
      diagnostics: [projectDiagnostic, ...current.diagnostics],
      health: {
        ...current.health,
        diagnosticCounts: {
          ...current.health.diagnosticCounts,
          warnings: current.health.diagnosticCounts.warnings + 1
        },
        checkedAt: new Date().toISOString()
      }
    };
    this.snapshot = snapshot;
    this.emit({ type: 'project.changed', snapshot });
  }

  private async readImageModelSettings() {
    const snapshot = await this.configStore.readGlobalSnapshot();
    return createImageModelSettingsView(
      snapshot.settings.models.image,
      snapshot.secrets,
      createImageModelCatalog().listAll()
    );
  }

  private async readVideoModelSettings() {
    const snapshot = await this.configStore.readGlobalSnapshot();
    return createVideoModelSettingsView(
      snapshot.settings.models.video,
      snapshot.secrets,
      createVideoModelCatalog().listAll()
    );
  }

  private async readAudioModelSettings() {
    const snapshot = await this.configStore.readGlobalSnapshot();
    return createAudioModelSettingsView(
      snapshot.settings.models.audio,
      snapshot.secrets,
      createAudioModelCatalog().listAll()
    );
  }

  private async refreshProjectUnlocked(): Promise<ProjectSessionSnapshot> {
    const snapshot = await this.loadFreshProjectSnapshotUnlocked();
    this.emit({ type: 'project.changed', snapshot });
    return snapshot;
  }

  private async loadFreshProjectSnapshotUnlocked(): Promise<ProjectSessionSnapshot> {
    const current = this.getSnapshot();
    const snapshot = await this.loadSnapshot(current.projectRoot);
    await reconcileCanvasImagePreviewCache({
      projectRoot: current.projectRoot,
      files: snapshot.files
    });
    this.snapshot = snapshot;
    this.snapshotLoadedAt = Date.now();
    return snapshot;
  }

  private async enqueueSessionOperation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.sessionOperation.then(operation, operation);
    this.sessionOperation = run.then(() => undefined, () => undefined);
    return run;
  }
}

function snapshotWithCanvasFeedbackRenderedDiagnostics(
  snapshot: ProjectSessionSnapshot,
  renderedFeedback: CanvasFeedbackRenderDiagnosticUpdate
): ProjectSessionSnapshot {
  if (!renderedFeedback.checkedAllEntries
    && renderedFeedback.checkedProjectRelativePaths.length === 0
    && renderedFeedback.diagnostics.length === 0) {
    return snapshot;
  }
  const checkedProjectRelativePaths = new Set(renderedFeedback.checkedProjectRelativePaths);
  const retainedProjectRelativePaths = new Set(renderedFeedback.retainedProjectRelativePaths ?? []);
  const retainedDiagnostics = snapshot.diagnostics.filter((diagnostic) => {
    if (renderedFeedback.checkedAllEntries && diagnostic.id.startsWith(CANVAS_FEEDBACK_RENDER_DIAGNOSTIC_PREFIX)) {
      return typeof diagnostic.entityId === 'string' && retainedProjectRelativePaths.has(diagnostic.entityId);
    }
    return !canvasFeedbackRenderDiagnosticMatchesCheckedPath(diagnostic, checkedProjectRelativePaths);
  });
  const diagnostics = uniqueDiagnostics([
    ...renderedFeedback.diagnostics,
    ...retainedDiagnostics
  ]);
  if (sameDiagnostics(snapshot.diagnostics, diagnostics)) {
    return snapshot;
  }
  return {
    ...snapshot,
    diagnostics,
    health: {
      ...snapshot.health,
      diagnosticCounts: diagnosticCounts(diagnostics),
      checkedAt: new Date().toISOString()
    }
  };
}

function snapshotWithCanvasFeedbackDocumentInvalidDiagnostic(
  snapshot: ProjectSessionSnapshot,
  input: { filePath: string; entityId: string },
  error: unknown
): ProjectSessionSnapshot {
  return snapshotWithDiagnostics(snapshot, uniqueDiagnostics([
    projectDocumentDiagnostic({
      id: CANVAS_FEEDBACK_DOCUMENT_INVALID_DIAGNOSTIC_ID,
      code: 'canvas-feedback.document_invalid',
      severity: 'error',
      message: `Canvas feedback document is invalid: ${errorMessage(error)}`,
      filePath: input.filePath,
      entityId: input.entityId
    }),
    ...snapshot.diagnostics.filter((diagnostic) => diagnostic.id !== CANVAS_FEEDBACK_DOCUMENT_INVALID_DIAGNOSTIC_ID)
  ]));
}

function snapshotWithoutCanvasFeedbackDocumentInvalidDiagnostic(snapshot: ProjectSessionSnapshot): ProjectSessionSnapshot {
  return snapshotWithDiagnostics(
    snapshot,
    snapshot.diagnostics.filter((diagnostic) => diagnostic.id !== CANVAS_FEEDBACK_DOCUMENT_INVALID_DIAGNOSTIC_ID)
  );
}

function snapshotWithDiagnostics(snapshot: ProjectSessionSnapshot, diagnostics: Diagnostic[]): ProjectSessionSnapshot {
  if (sameDiagnostics(snapshot.diagnostics, diagnostics)) {
    return snapshot;
  }
  return {
    ...snapshot,
    diagnostics,
    health: {
      ...snapshot.health,
      diagnosticCounts: diagnosticCounts(diagnostics),
      checkedAt: new Date().toISOString()
    }
  };
}

function canvasFeedbackRenderDiagnosticMatchesCheckedPath(
  diagnostic: Diagnostic,
  checkedProjectRelativePaths: Set<string>
): boolean {
  if (!diagnostic.id.startsWith(CANVAS_FEEDBACK_RENDER_DIAGNOSTIC_PREFIX)) {
    return false;
  }
  const diagnosticProjectRelativePath = diagnostic.id.slice(CANVAS_FEEDBACK_RENDER_DIAGNOSTIC_PREFIX.length);
  for (const checkedProjectRelativePath of checkedProjectRelativePaths) {
    if (diagnosticProjectRelativePath === checkedProjectRelativePath
      || diagnosticProjectRelativePath.startsWith(`${checkedProjectRelativePath}#`)) {
      return true;
    }
  }
  return false;
}

function uniqueDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return [...new Map(diagnostics.map((diagnostic) => [diagnostic.id, diagnostic])).values()];
}

function sameDiagnostics(left: Diagnostic[], right: Diagnostic[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function diagnosticCounts(diagnostics: Diagnostic[]): ProjectHealthSummary['diagnosticCounts'] {
  return {
    errors: diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length,
    warnings: diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length,
    infos: diagnostics.filter((diagnostic) => diagnostic.severity === 'info').length
  };
}

async function fileExists(absolutePath: string): Promise<boolean> {
  try {
    await access(absolutePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canvasMapServiceError(error: CanvasMapError, canvasId: string): Error {
  return serviceError(error.code, error.message, {
    canvas_id: canvasId,
    file_path: canvasMapPath(canvasId),
    ...(error.line !== undefined ? { line: error.line } : {}),
    ...(error.column !== undefined ? { column: error.column } : {})
  });
}

function sourceProjectDocumentTextOwner(descriptor: ProjectDocumentDescriptor): string {
  const owner = descriptor.owners[0];
  if (!owner) {
    throw documentServiceError('document_descriptor_violation', 'Source project document has no owner.', {
      document_type: descriptor.type
    });
  }
  return owner;
}
