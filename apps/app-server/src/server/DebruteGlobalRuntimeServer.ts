import { EventEmitter } from 'node:events';
import {
  buildWorkbenchTitleBarState,
  type WorkbenchHostKind,
  type WorkbenchTitleBarState,
  AdobeBridgeSettings,
  AppServerEvent,
  ImageModelSettingsView,
  IntegrationSettingsView,
  RunIntegrationOperationInput,
  RunIntegrationOperationResult,
  SaveAdobeBridgeSettingsInput,
  SaveImageModelSettingInput,
  SaveWorkbenchPreferencesInput,
  SaveVideoModelSettingInput,
  VideoModelSettingsView,
  WorkbenchPreferencesView
} from '@debrute/app-protocol';
import { AdobeBridgeSettingsService } from '../adobe-bridge/AdobeBridgeSettingsService.js';
import { GlobalConfigStore } from '../config/GlobalConfigStore.js';
import { IntegrationsService } from '../integrations/IntegrationsService.js';
import { ImageModelService } from '../models/ImageModelService.js';
import { VideoModelService } from '../models/VideoModelService.js';

export interface DebruteGlobalRuntimeServerOptions {
  globalConfigStore?: GlobalConfigStore;
  integrationEnvPath?: string;
  integrationPathExt?: string;
  integrationPlatform?: NodeJS.Platform;
}

export class DebruteGlobalRuntimeServer {
  private readonly events = new EventEmitter();
  private readonly configStore: GlobalConfigStore;
  private readonly imageModelService: ImageModelService;
  private readonly videoModelService: VideoModelService;
  private readonly integrationsService: IntegrationsService;
  private readonly adobeBridgeSettingsService: AdobeBridgeSettingsService;

  constructor(options: DebruteGlobalRuntimeServerOptions = {}) {
    this.configStore = options.globalConfigStore ?? new GlobalConfigStore();
    this.imageModelService = new ImageModelService({ configStore: this.configStore });
    this.videoModelService = new VideoModelService({ configStore: this.configStore });
    this.adobeBridgeSettingsService = new AdobeBridgeSettingsService({ configStore: this.configStore });
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

  async integrationsRunOperation(input: RunIntegrationOperationInput): Promise<RunIntegrationOperationResult> {
    return this.integrationsService.runOperation(input, {
      onStarted: (settings) => this.emit({ type: 'integrations.settings.changed', settings }),
      onSettled: (settings) => this.emit({ type: 'integrations.settings.changed', settings })
    });
  }

  async adobeBridgeGetSettings(): Promise<AdobeBridgeSettings> {
    return this.adobeBridgeSettingsService.getSettings();
  }

  async adobeBridgeSaveSettings(input: SaveAdobeBridgeSettingsInput): Promise<AdobeBridgeSettings> {
    const settings = await this.adobeBridgeSettingsService.saveSettings(input);
    this.emit({ type: 'adobeBridge.settings.changed', settings });
    return settings;
  }

  async rememberRecentProjectRoot(projectRoot: string): Promise<void> {
    const trimmed = projectRoot.trim();
    if (!trimmed) {
      return;
    }
    const current = await this.configStore.readWorkbenchChrome();
    await this.configStore.saveWorkbenchChrome({
      recentProjectRoots: [
        trimmed,
        ...current.recentProjectRoots.filter((item) => item !== trimmed)
      ].slice(0, 12)
    });
  }

  async clearRecentProjectRoots(): Promise<void> {
    await this.configStore.saveWorkbenchChrome({ recentProjectRoots: [] });
  }

  async workbenchPreferencesGet(): Promise<WorkbenchPreferencesView> {
    return this.configStore.readWorkbenchPreferences();
  }

  async workbenchPreferencesSave(input: SaveWorkbenchPreferencesInput): Promise<WorkbenchPreferencesView> {
    await this.configStore.saveWorkbenchPreferences(input);
    const preferences = await this.configStore.readWorkbenchPreferences();
    this.emit({ type: 'workbench.preferences.changed', preferences });
    return preferences;
  }

  async workbenchTitleBarState(input: {
    host: WorkbenchHostKind;
    platform: NodeJS.Platform;
    projectTitle?: string | undefined;
  }): Promise<WorkbenchTitleBarState> {
    const chrome = await this.configStore.readWorkbenchChrome();
    return buildWorkbenchTitleBarState({
      host: input.host,
      platform: input.platform,
      projectTitle: input.projectTitle,
      recentProjectRoots: chrome.recentProjectRoots
    });
  }

  close(): void {
    this.events.removeAllListeners();
  }

  private emit(event: AppServerEvent): void {
    this.events.emit('event', event);
  }
}
