import { EventEmitter } from 'node:events';
import type {
  AppServerEvent,
  CanvasSettingsView,
  DiscoverLlmProviderModelsInput,
  DiscoverProviderModelsOutput,
  ImageModelSettingsView,
  IntegrationSettingsView,
  LlmProviderSettingsView,
  SaveImageModelSettingInput,
  SaveLlmProviderSettingInput,
  SaveVideoModelSettingInput,
  VideoModelSettingsView
} from '@axis/app-protocol';
import { GlobalConfigStore, type CanvasSettingsConfig } from '../config/GlobalConfigStore.js';
import { IntegrationsService } from '../integrations/IntegrationsService.js';
import { ImageModelService } from '../models/ImageModelService.js';
import { LlmService } from '../models/LlmService.js';
import { VideoModelService } from '../models/VideoModelService.js';

export interface AxisGlobalRuntimeServerOptions {
  globalConfigStore?: GlobalConfigStore;
  integrationEnvPath?: string;
  integrationPathExt?: string;
  integrationPlatform?: NodeJS.Platform;
}

export class AxisGlobalRuntimeServer {
  private readonly events = new EventEmitter();
  private readonly configStore: GlobalConfigStore;
  private readonly llmService: LlmService;
  private readonly imageModelService: ImageModelService;
  private readonly videoModelService: VideoModelService;
  private readonly integrationsService: IntegrationsService;

  constructor(options: AxisGlobalRuntimeServerOptions = {}) {
    this.configStore = options.globalConfigStore ?? new GlobalConfigStore();
    this.llmService = new LlmService({ configStore: this.configStore });
    this.imageModelService = new ImageModelService({ configStore: this.configStore });
    this.videoModelService = new VideoModelService({ configStore: this.configStore });
    this.integrationsService = new IntegrationsService({
      ...(options.integrationEnvPath !== undefined ? { envPath: options.integrationEnvPath } : {}),
      ...(options.integrationPathExt !== undefined ? { pathExt: options.integrationPathExt } : {}),
      ...(options.integrationPlatform !== undefined ? { platform: options.integrationPlatform } : {})
    });
  }

  onEvent(listener: (event: AppServerEvent) => void): () => void {
    this.events.on('event', listener);
    return () => this.events.off('event', listener);
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

  async imageModelGetSettings(): Promise<ImageModelSettingsView> {
    return this.imageModelService.getSettings();
  }

  async imageModelSaveSetting(modelId: string, input: SaveImageModelSettingInput): Promise<ImageModelSettingsView> {
    const settings = await this.imageModelService.saveSetting(modelId, input);
    this.emit({ type: 'imageModel.settings.changed', settings });
    return settings;
  }

  async videoModelGetSettings(): Promise<VideoModelSettingsView> {
    return this.videoModelService.getSettings();
  }

  async videoModelSaveSetting(modelId: string, input: SaveVideoModelSettingInput): Promise<VideoModelSettingsView> {
    const settings = await this.videoModelService.saveSetting(modelId, input);
    this.emit({ type: 'videoModel.settings.changed', settings });
    return settings;
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
    this.events.removeAllListeners();
  }

  private emit(event: AppServerEvent): void {
    this.events.emit('event', event);
  }
}
