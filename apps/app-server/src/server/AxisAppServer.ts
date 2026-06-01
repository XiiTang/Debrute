import { randomUUID } from 'node:crypto';
import { access, mkdir, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  getAxisProjectPaths,
  initializeBlankProject,
  readProjectMetadata,
  readProjectTextFile,
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
} from '@axis/project-core';
import {
  type CanvasDesiredNode,
  type CanvasDocument,
  type CanvasFeedbackDocument,
  type CanvasLayoutSize,
  type CanvasNodeLayerPatch,
  type CanvasSelection,
  type CanvasViewport,
  type Diagnostic,
  type UpdateCanvasFeedbackEntryInput
} from '@axis/canvas-core';
import {
  capabilityError,
  capabilityOk,
  projectArtifactPointers,
  type AxisCapabilityResult
} from '@axis/capability-core';
import {
  ProviderRegistry,
  createImageModelCatalog,
  createImageModelSettingsView,
  createVideoModelCatalog,
  describeImageModelOfficialDoc,
  runLlmRuntimeRequest,
  executeImageModelRequest,
  executeVideoModelRequest,
  type ExecuteImageModelRequestResult,
  type ImageModelCatalogEntry,
  type ImageProviderFetch,
  type ImageModelRequestInput,
  type VideoModelRequestInput,
  type VideoProviderFetch
} from '@axis/capability-runtime';
import { FlowmapError } from '@axis/flowmap-core';
import type {
  AppServerEvent,
  CanvasSettingsView,
  DiscoverLlmProviderModelsInput,
  DiscoverProviderModelsOutput,
  GeneratedAssetMetadataLookup,
  GeneratedAssetRecord,
  ImageModelSettingsView,
  IntegrationSettingsView,
  LlmProviderSettingsView,
  ProjectFileOperationResult,
  ProjectHealthSummary,
  ProjectSessionSnapshot,
  RunImageModelBatchInput,
  SaveImageModelSettingInput,
  SaveLlmProviderSettingInput,
  SaveVideoModelSettingInput,
  VideoModelSettingsView,
  ImageModelBatchSummary
} from '@axis/app-protocol';
import { GlobalConfigStore, type CanvasSettingsConfig } from '../config/GlobalConfigStore.js';
import { ImageModelService } from '../models/ImageModelService.js';
import { LlmService } from '../models/LlmService.js';
import { VideoModelService } from '../models/VideoModelService.js';
import { IntegrationsService, type IntegrationsServiceOptions } from '../integrations/IntegrationsService.js';
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
  runImageModelBatch as runNativeImageModelBatch,
  type ImageModelBatchExecutionResult
} from '../models/ImageModelBatchService.js';
import {
  cliImageModelDetail,
  cliImageModelListEntry,
  cliModelSummary,
  cliVideoModelDetail,
  imageModelBatchResultFromExecution,
  imageModelReadinessFailure,
  videoModelReadinessFailure,
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

export interface AxisAppServerOptions {
  globalConfigStore?: GlobalConfigStore;
  imageModelFetch?: ImageProviderFetch;
  videoModelFetch?: VideoProviderFetch;
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

export class AxisAppServer {
  private readonly events = new EventEmitter();
  private readonly configStore: GlobalConfigStore;
  private readonly llmService: LlmService;
  private readonly imageModelService: ImageModelService;
  private readonly videoModelService: VideoModelService;
  private readonly integrationsService: IntegrationsService;
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

  constructor(private readonly options: AxisAppServerOptions = {}) {
    this.configStore = options.globalConfigStore ?? new GlobalConfigStore();
    this.llmService = new LlmService({ configStore: this.configStore });
    this.imageModelService = new ImageModelService({ configStore: this.configStore });
    this.videoModelService = new VideoModelService({ configStore: this.configStore });
    this.integrationsService = new IntegrationsService({
      ...(options.integrationEnvPath !== undefined ? { envPath: options.integrationEnvPath } : {}),
      ...(options.integrationPathExt !== undefined ? { pathExt: options.integrationPathExt } : {}),
      ...(options.integrationPlatform !== undefined ? { platform: options.integrationPlatform } : {})
    });
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

  async openProject(projectRoot: string, options: OpenProjectOptions = { initializeIfMissing: true, createDefaultCanvas: true }): Promise<ProjectSessionSnapshot> {
    return this.enqueueSessionOperation(async () => {
      const paths = getAxisProjectPaths(projectRoot);
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
      this.llmGetSettings()
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
      diagnostics.push({ severity: 'info', code: 'runtime_ok', message: 'AXIS runtime configuration is usable.' });
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
      const fileStat = await stat(resolveProjectPath(current.projectRoot, input.projectRelativePath));
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

  async canvasSettingsGet(): Promise<CanvasSettingsView> {
    return this.configStore.readCanvasSettings();
  }

  async canvasSettingsSave(input: CanvasSettingsConfig): Promise<CanvasSettingsView> {
    await this.configStore.saveCanvasSettings(input);
    const settings = await this.configStore.readCanvasSettings();
    this.emit({ type: 'canvas.settings.changed', settings });
    return settings;
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

  async updateCanvasViewport(canvasId: string, viewport: CanvasViewport): Promise<CanvasDocument> {
    return this.enqueueSessionOperation(async () => (
      this.applyCanvasSessionUpdate(await this.canvasSessionService.updateCanvasViewport(this.getSnapshot(), canvasId, viewport))
    ));
  }

  async updateCanvasSelection(canvasId: string, selection: CanvasSelection | undefined): Promise<CanvasDocument> {
    return this.enqueueSessionOperation(async () => (
      this.applyCanvasSessionUpdate(await this.canvasSessionService.updateCanvasSelection(this.getSnapshot(), canvasId, selection))
    ));
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

  async llmGetSettings(): Promise<LlmProviderSettingsView> {
    return this.llmService.getSettings();
  }

  async llmSaveProviderSetting(input: SaveLlmProviderSettingInput, providerId?: string): Promise<LlmProviderSettingsView> {
    const settings = await this.llmService.saveProviderSetting(input, providerId);
    this.emit({ type: 'llm.settings.changed', settings });
    return settings;
  }

  async llmDeleteProviderSetting(providerId: string): Promise<LlmProviderSettingsView> {
    const settings = await this.llmService.deleteProviderSetting(providerId);
    this.emit({ type: 'llm.settings.changed', settings });
    return settings;
  }

  async llmSetDefaultModelKey(modelKey: string | null): Promise<LlmProviderSettingsView> {
    const settings = await this.llmService.setDefaultModelKey(modelKey);
    this.emit({ type: 'llm.settings.changed', settings });
    return settings;
  }

  async llmDiscoverProviderModels(input: DiscoverLlmProviderModelsInput, providerId?: string): Promise<DiscoverProviderModelsOutput> {
    return this.llmService.discoverProviderModels(input, providerId);
  }

  async runLlmRequestForCli(input: Record<string, unknown>): Promise<AxisCapabilityResult> {
    const llmProviderSettings = await this.configStore.readLlmProviders();
    const providers = new ProviderRegistry(llmProviderSettings, await this.configStore.readSecrets());
    return runLlmRuntimeRequest(input, {
      providers,
      defaultModelKey: llmProviderSettings.defaultModelKey ?? null
    });
  }

  async imageModelGetSettings(): Promise<ImageModelSettingsView> {
    return this.imageModelService.getSettings();
  }

  async listImageModelsForCli(): Promise<CliImageModelListEntry[]> {
    const settings = await this.imageModelGetSettings();
    const configured = new Set(settings.models.filter((model) => model.apiKeySet).map((model) => model.axisModelId));
    return createImageModelCatalog().listAll()
      .filter((entry) => configured.has(entry.axisModelId))
      .map(cliImageModelListEntry);
  }

  async describeImageModelForCli(modelId: string): Promise<CliImageModelDetail> {
    const settings = await this.imageModelGetSettings();
    const setting = settings.models.find((model) => model.axisModelId === modelId);
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

  async imageModelSaveSetting(modelId: string, input: SaveImageModelSettingInput): Promise<ImageModelSettingsView> {
    const settings = await this.imageModelService.saveSetting(modelId, input);
    this.emit({ type: 'imageModel.settings.changed', settings });
    return settings;
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

  async runImageModelRequestForCli(input: ImageModelRequestInput): Promise<AxisCapabilityResult> {
    const current = this.getSnapshot();
    const readinessFailure = imageModelReadinessFailure(input.model, (await this.imageModelGetSettings()).models);
    if (readinessFailure) {
      return capabilityError(readinessFailure.code, readinessFailure.message, undefined, {
        outputs: {
          model: input.model
        },
        logs: [{ stage: readinessFailure.stage, model: input.model }]
      });
    }
    const executor = await this.createImageModelRequestExecutor(current.projectRoot);
    const entry = executor.catalog.find((item) => item.axisModelId === input.model);
    if (!entry) {
      return capabilityError('model_unavailable', `Image model is unavailable: ${input.model}`);
    }
    const result = await executor.execute(input, { invocationId: `image-${randomUUID()}` });
    if (result.status === 'error') {
      return capabilityError(result.error, result.content, undefined, {
        outputs: {
          content: result.content,
          provider: entry.provider,
          model: entry.axisModelId,
          ...(result.rawProviderOutput ? { raw_provider_output: JSON.stringify(result.rawProviderOutput) } : {})
        },
        logs: result.logs
      });
    }
    await this.refreshProject();
    return capabilityOk({
      content: result.content,
      provider: entry.provider,
      model: entry.axisModelId
    }, {
      artifacts: projectArtifactPointers(result.artifacts),
      logs: result.logs
    });
  }

  async videoModelGetSettings(): Promise<VideoModelSettingsView> {
    return this.videoModelService.getSettings();
  }

  async listVideoModelsForCli(): Promise<CliModelSummary[]> {
    return (await this.videoModelGetSettings()).models.map(cliModelSummary);
  }

  async describeVideoModelForCli(modelId: string): Promise<CliModelDetail> {
    const settings = await this.videoModelGetSettings();
    const setting = settings.models.find((model) => model.axisModelId === modelId);
    const catalog = createVideoModelCatalog();
    const detail = catalog.details([modelId], catalog.listAll()).details[0];
    if (!setting || !detail) {
      throw serviceError('model_unavailable', `Video model is unknown: ${modelId}`, { model: modelId });
    }
    return cliVideoModelDetail(setting, detail);
  }

  async videoModelSaveSetting(modelId: string, input: SaveVideoModelSettingInput): Promise<VideoModelSettingsView> {
    const settings = await this.videoModelService.saveSetting(modelId, input);
    this.emit({ type: 'videoModel.settings.changed', settings });
    return settings;
  }

  async runVideoModelRequestForCli(input: VideoModelRequestInput): Promise<AxisCapabilityResult> {
    const current = this.getSnapshot();
    const readinessFailure = videoModelReadinessFailure(input.model, (await this.videoModelGetSettings()).models);
    if (readinessFailure) {
      return capabilityError(readinessFailure.code, readinessFailure.message, undefined, {
        outputs: {
          model: input.model
        },
        logs: [{ stage: readinessFailure.stage, model: input.model }]
      });
    }
    const catalog = await this.videoModelService.configuredCatalog();
    const entry = catalog.find((item) => item.axisModelId === input.model);
    if (!entry) {
      return capabilityError('model_unavailable', `Video model is unavailable: ${input.model}`);
    }
    const secrets = await this.configStore.readSecrets();
    const result = await executeVideoModelRequest({
      projectRoot: current.projectRoot,
      invocationId: `video-${randomUUID()}`,
      input,
      settings: await this.configStore.readVideoModels(),
      secrets: { videoModelApiKeys: secrets.videoModelApiKeys },
      recordGeneratedAsset: (metadata) => this.generatedAssetMetadataService.recordGeneratedAsset(current.projectRoot, metadata).then(() => undefined),
      ...(this.options.videoModelFetch ? { fetch: this.options.videoModelFetch } : {})
    });
    if (result.status === 'error') {
      return capabilityError(result.error, result.content, undefined, {
        outputs: {
          content: result.content,
          provider: entry.provider,
          model: entry.axisModelId,
          ...(result.providerResponse ? { provider_response: JSON.stringify(result.providerResponse) } : {})
        },
        logs: result.logs
      });
    }
    await this.refreshProject();
    return capabilityOk({
      content: result.content,
      provider: entry.provider,
      model: entry.axisModelId
    }, {
      artifacts: projectArtifactPointers(result.artifacts),
      logs: result.logs
    });
  }

  async integrationsListStatus(): Promise<IntegrationSettingsView> {
    return this.integrationsService.listStatus();
  }

  async integrationsRescan(): Promise<IntegrationSettingsView> {
    const settings = await this.integrationsService.rescan();
    this.emit({ type: 'integrations.settings.changed', settings });
    return settings;
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
      .map((model) => model.axisModelId));
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
        const entry = catalog.find((item) => item.axisModelId === request.model);
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
