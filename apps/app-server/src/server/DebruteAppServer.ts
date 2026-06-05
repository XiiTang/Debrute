import { randomUUID } from 'node:crypto';
import { access, mkdir, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  getDebruteProjectPaths,
  initializeBlankProject,
  readProjectMetadata,
  readProjectTextFile,
  resolveExistingProjectPath,
  resolveProjectPath,
  watchProjectFiles,
  writeProjectTextFile,
  type CopyOrMoveProjectPathInput,
  type CreateProjectPathInput,
  type DeleteProjectPathInput,
  type NormalizedFileWatchEvent,
  type ProjectFileWatchHandle,
  type RenameProjectPathInput,
  type ProjectTextFile
} from '@debrute/project-core';
import {
  type CanvasDesiredNode,
  type CanvasDocument,
  type CanvasFeedbackDocument,
  type CanvasLayoutSize,
  type CanvasNodeLayerPatch,
  type UpdateCanvasFeedbackEntryInput
} from '@debrute/canvas-core';
import {
  capabilityError,
  capabilityOk,
  projectArtifactPointers,
  type DebruteCapabilityResult
} from '@debrute/capability-core';
import {
  ProviderRegistry,
  createImageModelCatalog,
  createImageModelSettingsView,
  createLlmProviderSettingsView,
  createVideoModelCatalog,
  createVideoModelSettingsView,
  describeImageModelOfficialDoc,
  runLlmRuntimeRequest,
  executeImageModelRequest,
  executeVideoModelRequest,
  type ExecuteImageModelRequestResult,
  type ImageModelCatalogEntry,
  type ImageModelFetch,
  type ImageModelRequestInput,
  type VideoModelRequestInput,
  type VideoModelFetch
} from '@debrute/capability-runtime';
import { FlowmapError } from '@debrute/flowmap-core';
import type {
  AppServerEvent,
  GeneratedAssetMetadataLookup,
  GeneratedAssetRecord,
  ProjectFileOperationResult,
  ProjectHealthSummary,
  ProjectSessionSnapshot,
  RunImageModelBatchInput,
  ImageModelBatchSummary
} from '@debrute/app-protocol';
import { GlobalConfigStore } from '../config/GlobalConfigStore.js';
import {
  readCanvasNodeLayoutSize,
  type ReadCanvasNodeLayoutSizeInput
} from '../canvas/CanvasNodeDimensionsService.js';
import {
  createGeneratedAssetMetadataService,
  type GeneratedAssetMetadataService,
  type RecordGeneratedAssetInput
} from '../generated-assets/GeneratedAssetMetadataService.js';
import {
  createCanvasFeedbackService,
  type CanvasFeedbackService
} from '../canvas/CanvasFeedbackService.js';
import {
  createCanvasImagePreviewService,
  type CanvasImagePreviewResult,
  type CanvasImagePreviewService,
  type ResolveCanvasImagePreviewInput
} from '../canvas/CanvasImagePreviewService.js';
import { CanvasProjectionService } from '../canvas/CanvasProjectionService.js';
import { CanvasSessionService } from '../canvas/CanvasSessionService.js';
import { FlowmapSessionService } from '../flowmap/FlowmapSessionService.js';
import { loadProjectSnapshot } from '../project-session/projectSnapshot.js';
import {
  copyProjectPathWithSnapshot,
  createProjectDirectoryWithSnapshot,
  createProjectFileWithSnapshot,
  deleteProjectPathPermanentlyWithSnapshot,
  moveProjectPathWithSnapshot,
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
  runImageModelBatch as runNativeImageModelBatch
} from '../models/ImageModelBatchService.js';
import {
  cliImageModelDetail,
  cliImageModelListEntry,
  cliModelSummary,
  cliVideoModelDetail,
  imageModelBatchResultFromExecution,
  imageModelReadinessFailure,
  type CliImageModelDetail,
  type CliImageModelListEntry,
  type CliModelDetail,
  type CliModelSummary,
  type CliRuntimeDiagnostic,
  type CliRuntimeStatus
} from '../models/AppServerModelHelpers.js';

export interface OpenProjectOptions {
  initializeIfMissing?: boolean;
  createDefaultCanvas?: boolean;
  watchFiles?: boolean;
}

export interface DebruteAppServerOptions {
  globalConfigStore?: GlobalConfigStore;
  imageModelFetch?: ImageModelFetch;
  videoModelFetch?: VideoModelFetch;
  integrationEnvPath?: string;
  integrationPathExt?: string;
  integrationPlatform?: NodeJS.Platform;
  canvasNodeLayoutSizeReader?: (input: ReadCanvasNodeLayoutSizeInput) => Promise<CanvasLayoutSize>;
}

export type { CliImageModelDetail, CliImageModelListEntry, CliModelDetail, CliModelSummary, CliRuntimeDiagnostic, CliRuntimeStatus };

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

export class DebruteAppServer {
  private readonly events = new EventEmitter();
  private readonly configStore: GlobalConfigStore;
  private readonly generatedAssetMetadataService: GeneratedAssetMetadataService;
  private readonly canvasFeedbackService: CanvasFeedbackService;
  private readonly canvasImagePreviewService: CanvasImagePreviewService;
  private readonly canvasProjectionService: CanvasProjectionService;
  private readonly canvasSessionService: CanvasSessionService;
  private readonly flowmapSessionService: FlowmapSessionService;
  private snapshot: ProjectSessionSnapshot | undefined;
  private snapshotLoadedAt = 0;
  private fileWatchHandle: ProjectFileWatchHandle | undefined;
  private readonly internalProjectFileWrites = new Map<string, { content?: string; expiresAt: number }>();
  private sessionOperation: Promise<void> = Promise.resolve();

  constructor(private readonly options: DebruteAppServerOptions = {}) {
    this.configStore = options.globalConfigStore ?? new GlobalConfigStore();
    this.generatedAssetMetadataService = createGeneratedAssetMetadataService();
    this.canvasFeedbackService = createCanvasFeedbackService();
    this.canvasImagePreviewService = createCanvasImagePreviewService();
    this.canvasProjectionService = new CanvasProjectionService();
    this.canvasSessionService = new CanvasSessionService({
      suppressInternalProjectPathEvent: (absolutePath, content) => this.suppressInternalProjectPathEvent(absolutePath, content),
      clearInternalProjectPathEvent: (absolutePath) => this.clearInternalProjectPathEvent(absolutePath),
      projectCanvasWithKnownAvailability: (canvas, projection) => this.canvasProjectionService.projectCanvasWithKnownAvailability(canvas, projection)
    });
    this.flowmapSessionService = new FlowmapSessionService({
      ensureCanvas: (projectRoot, canvasId) => this.canvasSessionService.ensureCanvas(projectRoot, canvasId, fileExists),
      resolveCanvasNodeLayoutSize: (projectRoot, node) => this.resolveCanvasNodeLayoutSize(projectRoot, node),
      writeCanvasJson: (canvasPath, canvas) => this.canvasSessionService.writeCanvasJson(canvasPath, canvas),
      suppressInternalProjectPathEvent: (absolutePath, content) => this.suppressInternalProjectPathEvent(absolutePath, content),
      clearInternalProjectPathEvent: (absolutePath) => this.clearInternalProjectPathEvent(absolutePath)
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
        await this.canvasSessionService.ensureDefaultCanvas(projectRoot);
      }

      const snapshot = await this.loadSnapshot(projectRoot);
      this.snapshot = snapshot;
      this.snapshotLoadedAt = Date.now();
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

  async initProjectForCli(projectRoot: string): Promise<ProjectSessionSnapshot> {
    return this.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true, watchFiles: false });
  }

  async projectStatusForCli(projectRoot: string): Promise<ProjectSessionSnapshot> {
    return this.loadSnapshot(projectRoot, { writeFlowmapCanvasChanges: false });
  }

  async runtimeStatusForCli(): Promise<CliRuntimeStatus> {
    const [configuredImageModels, videoModels, llmSettings] = await Promise.all([
      this.listImageModelsForCli(),
      this.listVideoModelsForCli(),
      this.readLlmProviderSettings()
    ]);
    return {
      ok: true,
      imageModels: createImageModelCatalog().listAll().length,
      availableImageModels: configuredImageModels.length,
      videoModels: videoModels.length,
      availableVideoModels: videoModels.filter((model) => model.apiKeySet).length,
      availableLlmModels: llmSettings.availableModelKeys.length,
      diagnostics: 0
    };
  }

  async runtimeDoctorForCli(): Promise<{ diagnostics: CliRuntimeDiagnostic[] }> {
    const status = await this.runtimeStatusForCli();
    const diagnostics: CliRuntimeDiagnostic[] = [];
    if (status.availableLlmModels === 0) {
      diagnostics.push({ severity: 'warning', code: 'llm_model_not_configured', message: 'No available LLM model is configured.' });
    }
    if (status.availableImageModels === 0) {
      diagnostics.push({ severity: 'warning', code: 'image_model_not_configured', message: 'No available image model is configured.' });
    }
    if (status.availableVideoModels === 0) {
      diagnostics.push({ severity: 'warning', code: 'video_model_not_configured', message: 'No available video model is configured.' });
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
      const written = await writeProjectTextFile(current.projectRoot, projectRelativePath, content);
      await this.refreshProjectUnlocked();
      return written;
    });
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

  async copyProjectPath(input: CopyOrMoveProjectPathInput): Promise<ProjectFileOperationResult> {
    return this.enqueueSessionOperation(() => copyProjectPathWithSnapshot(this.projectFileOperationContext(), input));
  }

  async moveProjectPath(input: CopyOrMoveProjectPathInput): Promise<ProjectFileOperationResult> {
    return this.enqueueSessionOperation(() => moveProjectPathWithSnapshot(this.projectFileOperationContext(), input));
  }

  async deleteProjectPathPermanently(input: DeleteProjectPathInput): Promise<ProjectFileOperationResult> {
    return this.enqueueSessionOperation(() => deleteProjectPathPermanentlyWithSnapshot(this.projectFileOperationContext(), input));
  }

  async recordGeneratedAssetMetadata(input: RecordGeneratedAssetInput): Promise<GeneratedAssetRecord> {
    const current = this.getSnapshot();
    return this.generatedAssetMetadataService.recordGeneratedAsset(current.projectRoot, input);
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
    const current = this.getSnapshot();
    return this.canvasFeedbackService.updateCanvasFeedbackEntry(current.projectRoot, input);
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

  async publishFlowmapDraft(input: { sourceDraftPath: string }): Promise<{ ok: true; command: 'flowmap.publish' }> {
    const current = this.getSnapshot();
    return this.publishFlowmapDraftForProject(current.projectRoot, input);
  }

  async publishFlowmapDraftForProject(projectRoot: string, input: { sourceDraftPath: string }): Promise<{ ok: true; command: 'flowmap.publish' }> {
    try {
      return await this.flowmapSessionService.publishFlowmapDraftForProject(projectRoot, input);
    } catch (error) {
      if (error instanceof FlowmapError) {
        throw serviceError(error.code, error.message, {
          file_path: input.sourceDraftPath,
          ...(error.line !== undefined ? { line: error.line } : {}),
          ...(error.column !== undefined ? { column: error.column } : {})
        });
      }
      throw error;
    }
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
  }): Promise<CanvasDocument> {
    return this.enqueueSessionOperation(async () => (
      this.applyCanvasSessionUpdate(await this.canvasSessionService.updateCanvasNodeLayouts(this.getSnapshot(), input))
    ));
  }

  async updateCanvasNodeLayers(input: {
    canvasId: string;
    nodeLayers?: CanvasNodeLayerPatch[];
    nodeProjectRelativePathsTopFirst?: string[];
  }): Promise<CanvasDocument> {
    return this.enqueueSessionOperation(async () => (
      this.applyCanvasSessionUpdate(await this.canvasSessionService.updateCanvasNodeLayers(this.getSnapshot(), input))
    ));
  }

  async runLlmRequestForCli(input: Record<string, unknown>): Promise<DebruteCapabilityResult> {
    const llmProviderSettings = await this.configStore.readLlmProviders();
    const providers = new ProviderRegistry(llmProviderSettings, await this.configStore.readSecrets());
    return runLlmRuntimeRequest(input, {
      providers,
      defaultModelKey: llmProviderSettings.defaultModelKey ?? null
    });
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

  async runImageModelBatch(input: RunImageModelBatchInput): Promise<ImageModelBatchSummary> {
    const current = this.getSnapshot();
    let imageRequestExecutor: Promise<AppServerImageModelRequestExecutor> | undefined;
    return runNativeImageModelBatch(input, {
      projectFileExistsWithContent: (check) => this.projectFileExistsWithContent(check),
      executeImageModelRequest: async (request) => {
        imageRequestExecutor ??= this.createImageModelRequestExecutor(current.projectRoot);
        const executor = await imageRequestExecutor;
        return imageModelBatchResultFromExecution(
          await executor.execute(request, {
            invocationId: `image-batch-${randomUUID()}`
          })
        );
      }
    });
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

  async listVideoModelsForCli(): Promise<CliModelSummary[]> {
    return (await this.readVideoModelSettings()).models.map(cliModelSummary);
  }

  async describeVideoModelForCli(modelId: string): Promise<CliModelDetail> {
    const settings = await this.readVideoModelSettings();
    const setting = settings.models.find((model) => model.debruteModelId === modelId);
    const catalog = createVideoModelCatalog();
    const detail = catalog.details([modelId], catalog.listAll()).details[0];
    if (!setting || !detail) {
      throw serviceError('model_unavailable', `Video model is unknown: ${modelId}`, { model: modelId });
    }
    return cliVideoModelDetail(setting, detail);
  }

  async runVideoModelRequestForCli(input: VideoModelRequestInput): Promise<DebruteCapabilityResult> {
    const current = this.getSnapshot();
    const [settings, secrets] = await Promise.all([
      this.configStore.readVideoModels(),
      this.configStore.readSecrets()
    ]);
    const result = await executeVideoModelRequest({
      projectRoot: current.projectRoot,
      invocationId: `video-${randomUUID()}`,
      input,
      settings,
      secrets: { videoModelApiKeys: secrets.videoModelApiKeys },
      recordGeneratedAsset: (metadata) => this.generatedAssetMetadataService.recordGeneratedAsset(current.projectRoot, metadata).then(() => undefined),
      ...(this.options.videoModelFetch ? { fetch: this.options.videoModelFetch } : {})
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

  close(): void {
    this.stopWatchingProject();
  }

  private projectFileOperationContext(): { snapshot: ProjectSessionSnapshot; refreshProject: () => Promise<ProjectSessionSnapshot> } {
    return {
      snapshot: this.getSnapshot(),
      refreshProject: () => this.refreshProjectUnlocked()
    };
  }

  private applyCanvasSessionUpdate(result: { canvas: CanvasDocument; snapshot: ProjectSessionSnapshot; changed: boolean }): CanvasDocument {
    this.snapshot = result.snapshot;
    if (!result.changed) {
      return result.canvas;
    }
    const projection = result.snapshot.projections.find((item) => item.canvasId === result.canvas.id);
    if (!projection) {
      throw new Error(`Canvas projection is not loaded: ${result.canvas.id}`);
    }
    this.emit({ type: 'canvas.changed', canvas: result.canvas, projection });
    return result.canvas;
  }

  private async createImageModelRequestExecutor(projectRoot: string): Promise<AppServerImageModelRequestExecutor> {
    const [settings, secrets] = await Promise.all([
      this.configStore.readImageModels(),
      this.configStore.readSecrets()
    ]);
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
          recordGeneratedAsset: (metadata) => this.generatedAssetMetadataService
            .recordGeneratedAsset(projectRoot, metadata)
            .then(() => undefined),
          ...(this.options.imageModelFetch ? { fetch: this.options.imageModelFetch } : {}),
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

  private async loadSnapshot(
    projectRoot: string,
    options: { writeFlowmapCanvasChanges: boolean } = { writeFlowmapCanvasChanges: true }
  ): Promise<ProjectSessionSnapshot> {
    return loadProjectSnapshot({
      projectRoot,
      writeFlowmapCanvasChanges: options.writeFlowmapCanvasChanges,
      loadCanvases: (root) => this.canvasSessionService.loadCanvases(root),
      synchronizeFlowmaps: (root, canvases, files, flowmapOptions) => this.flowmapSessionService.synchronizeFlowmaps(
        root,
        canvases,
        files,
        flowmapOptions
      ),
      projectCanvasDocument: (root, canvas, diagnostics, structureEdges) => this.canvasProjectionService.projectCanvasDocument(
        root,
        canvas,
        diagnostics,
        structureEdges
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
      const snapshot = await this.refreshProjectUnlocked();
      this.emit({ type: 'project.fileChanged', event, snapshot });
    } catch (error) {
      const current = this.snapshot;
      if (!current) {
        return;
      }
      const snapshot = projectWatchRefreshFailedSnapshot({
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

  private async readLlmProviderSettings() {
    return createLlmProviderSettingsView(
      await this.configStore.readLlmProviders(),
      await this.configStore.readSecrets()
    );
  }

  private async readImageModelSettings() {
    return createImageModelSettingsView(
      await this.configStore.readImageModels(),
      await this.configStore.readSecrets(),
      createImageModelCatalog().listAll()
    );
  }

  private async readVideoModelSettings() {
    return createVideoModelSettingsView(
      await this.configStore.readVideoModels(),
      await this.configStore.readSecrets(),
      createVideoModelCatalog().listAll()
    );
  }

  private async refreshProjectUnlocked(): Promise<ProjectSessionSnapshot> {
    const current = this.getSnapshot();
    const snapshot = await this.loadSnapshot(current.projectRoot);
    this.snapshot = snapshot;
    this.snapshotLoadedAt = Date.now();
    this.emit({ type: 'project.changed', snapshot });
    return snapshot;
  }

  private async enqueueSessionOperation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.sessionOperation.then(operation, operation);
    this.sessionOperation = run.then(() => undefined, () => undefined);
    return run;
  }
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
