import { EventEmitter } from 'node:events';
import {
  buildWorkbenchTitleBarState,
  type WorkbenchHostKind,
  type WorkbenchTitleBarState,
  AppServerEvent,
  DebruteGlobalAdobeBridgeSettings,
  DebruteGlobalSettingsView,
  IntegrationSettingsView,
  RunIntegrationOperationInput,
  RunIntegrationOperationResult,
  SaveDebruteGlobalSettingsInput
} from '@debrute/app-protocol';
import {
  createAudioModelCatalog,
  createAudioModelSettingsView,
  createImageModelCatalog,
  createImageModelSettingsView,
  createVideoModelCatalog,
  createVideoModelSettingsView
} from '@debrute/capability-runtime';
import {
  GlobalConfigStore,
  GlobalSettingsValidationError,
  type DebruteGlobalConfigSnapshot
} from '../config/GlobalConfigStore.js';
import { IntegrationsService } from '../integrations/IntegrationsService.js';
import type { IntegrationProcessAdapter } from '../integrations/IntegrationCommandRunner.js';

export interface DebruteGlobalRuntimeServerOptions {
  globalConfigStore?: GlobalConfigStore;
  integrationEnvPath?: string;
  integrationPathExt?: string;
  integrationPlatform?: NodeJS.Platform;
  integrationProcessAdapter?: IntegrationProcessAdapter;
}

export class DebruteGlobalRuntimeServer {
  private readonly events = new EventEmitter();
  private readonly configStore: GlobalConfigStore;
  private readonly imageCatalog = createImageModelCatalog();
  private readonly videoCatalog = createVideoModelCatalog();
  private readonly audioCatalog = createAudioModelCatalog();
  private readonly integrationsService: IntegrationsService;

  constructor(options: DebruteGlobalRuntimeServerOptions = {}) {
    this.configStore = options.globalConfigStore ?? new GlobalConfigStore();
    this.integrationsService = new IntegrationsService({
      ...(options.integrationEnvPath !== undefined ? { envPath: options.integrationEnvPath } : {}),
      ...(options.integrationPathExt !== undefined ? { pathExt: options.integrationPathExt } : {}),
      ...(options.integrationPlatform !== undefined ? { platform: options.integrationPlatform } : {}),
      ...(options.integrationProcessAdapter !== undefined
        ? { processAdapter: options.integrationProcessAdapter }
        : {})
    });
  }

  onEvent(listener: (event: AppServerEvent) => void): () => void {
    this.events.on('event', listener);
    return () => this.events.off('event', listener);
  }

  async integrationsRescan(): Promise<IntegrationSettingsView> {
    const settings = await this.integrationsService.rescan();
    await this.emitIntegrationSettingsChanged(settings);
    return settings;
  }

  async integrationsRunOperation(input: RunIntegrationOperationInput): Promise<RunIntegrationOperationResult> {
    return this.integrationsService.runOperation(input, {
      onStarted: async (settings) => {
        await this.emitIntegrationSettingsChanged(settings);
      },
      onSettled: async (settings) => {
        await this.emitIntegrationSettingsChanged(settings);
      }
    });
  }

  async adobeBridgeGetPersistedSettings(): Promise<DebruteGlobalAdobeBridgeSettings> {
    return (await this.configStore.readGlobalSettings()).adobeBridge;
  }

  async globalSettingsGet(): Promise<DebruteGlobalSettingsView> {
    const [snapshot, integrations] = await Promise.all([
      this.configStore.readGlobalSnapshot(),
      this.integrationsService.listStatus()
    ]);
    return this.globalSettingsView(snapshot, integrations);
  }

  async globalSettingsSave(input: SaveDebruteGlobalSettingsInput): Promise<DebruteGlobalSettingsView> {
    this.validateKnownModelPatches(input);
    const integrations = await this.integrationsService.listStatus();
    const result = await this.configStore.mutateGlobalSettings({ kind: 'patch', input });
    const settings = this.globalSettingsView(result.snapshot, integrations);
    if (result.changed) {
      this.emit({ type: 'globalSettings.changed', settings });
    }
    return settings;
  }

  async rememberRecentProjectRoot(projectRoot: string): Promise<void> {
    const result = await this.configStore.mutateGlobalSettings({
      kind: 'rememberRecentProjectRoot',
      projectRoot
    });
    if (result.changed) {
      this.emit({
        type: 'recentProjects.changed',
        recentProjectRoots: result.snapshot.settings.chrome.recentProjectRoots
      });
    }
  }

  async clearRecentProjectRoots(): Promise<void> {
    const result = await this.configStore.mutateGlobalSettings({ kind: 'clearRecentProjectRoots' });
    if (result.changed) {
      this.emit({
        type: 'recentProjects.changed',
        recentProjectRoots: result.snapshot.settings.chrome.recentProjectRoots
      });
    }
  }

  async workbenchTitleBarState(input: {
    host: WorkbenchHostKind;
    platform: NodeJS.Platform;
    projectTitle?: string | undefined;
  }): Promise<WorkbenchTitleBarState> {
    const settings = await this.configStore.readGlobalSettings();
    return buildWorkbenchTitleBarState({
      host: input.host,
      platform: input.platform,
      projectTitle: input.projectTitle,
      recentProjectRoots: settings.chrome.recentProjectRoots
    });
  }

  close(): void {
    this.events.removeAllListeners();
  }

  private emit(event: AppServerEvent): void {
    this.events.emit('event', event);
  }

  private globalSettingsView(
    snapshot: DebruteGlobalConfigSnapshot,
    integrations: IntegrationSettingsView
  ): DebruteGlobalSettingsView {
    return {
      workbench: snapshot.settings.workbench,
      chrome: snapshot.settings.chrome,
      models: {
        image: createImageModelSettingsView(
          snapshot.settings.models.image,
          snapshot.secrets,
          this.imageCatalog.listAll()
        ),
        video: createVideoModelSettingsView(
          snapshot.settings.models.video,
          snapshot.secrets,
          this.videoCatalog.listAll()
        ),
        audio: createAudioModelSettingsView(
          snapshot.settings.models.audio,
          snapshot.secrets,
          this.audioCatalog.listAll()
        )
      },
      integrations,
      adobeBridge: snapshot.settings.adobeBridge
    };
  }

  private async emitIntegrationSettingsChanged(integrations: IntegrationSettingsView): Promise<void> {
    const snapshot = await this.configStore.readGlobalSnapshot();
    this.emit({
      type: 'globalSettings.changed',
      settings: this.globalSettingsView(snapshot, integrations)
    });
  }

  private validateKnownModelPatches(input: SaveDebruteGlobalSettingsInput): void {
    if (!isRecord(input)) {
      return;
    }
    const models = input.models;
    if (!isRecord(models)) {
      return;
    }
    const image = models.image;
    if (isRecord(image)) {
      this.assertKnownModelPatch(image, 'image', this.imageCatalog);
    }
    const video = models.video;
    if (isRecord(video)) {
      this.assertKnownModelPatch(video, 'video', this.videoCatalog);
    }
    const audio = models.audio;
    if (isRecord(audio)) {
      this.assertKnownModelPatch(audio, 'audio', this.audioCatalog);
    }
  }

  private assertKnownModelPatch(
    patch: Record<string, unknown>,
    kind: 'image' | 'video' | 'audio',
    catalog: { get(modelId: string): unknown }
  ): void {
    const modelId = patch.modelId;
    if (typeof modelId !== 'string' || !catalog.get(modelId)) {
      throw new GlobalSettingsValidationError(`Unknown ${kind} model: ${String(modelId)}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
