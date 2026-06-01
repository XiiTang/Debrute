import {
  createVideoModelSettingsView,
  type VideoModelsConfig
} from '@axis/capability-runtime';
import { createVideoModelCatalog, type VideoModelCatalogEntry } from '@axis/capability-runtime';
import type { SaveVideoModelSettingInput, VideoModelSettingsView } from '@axis/app-protocol';
import type { GlobalConfigStore } from '../config/GlobalConfigStore.js';
import { configuredMediaCatalog, saveMediaModelSetting } from './MediaModelService.js';

export class VideoModelService {
  private readonly catalog = createVideoModelCatalog();

  constructor(private readonly input: { configStore: GlobalConfigStore }) {}

  async getSettings(): Promise<VideoModelSettingsView> {
    return createVideoModelSettingsView(
      await this.input.configStore.readVideoModels(),
      await this.input.configStore.readSecrets(),
      this.catalog.listAll()
    );
  }

  async saveSetting(modelId: string, input: SaveVideoModelSettingInput): Promise<VideoModelSettingsView> {
    await saveMediaModelSetting({
      configStore: this.input.configStore,
      modelKind: 'video',
      modelId,
      value: input,
      catalog: this.catalog,
      secretKey: 'videoModelApiKeys',
      readConfig: () => this.input.configStore.readVideoModels(),
      recordsFromConfig: (config) => (config as VideoModelsConfig).videoModels,
      configFromRecords: (records) => ({ videoModels: records as VideoModelsConfig['videoModels'] }),
      saveConfig: (config) => this.input.configStore.saveVideoModels(config as VideoModelsConfig)
    });
    return this.getSettings();
  }

  async configuredCatalog(): Promise<VideoModelCatalogEntry[]> {
    return configuredMediaCatalog({
      configStore: this.input.configStore,
      catalog: this.catalog,
      secretKey: 'videoModelApiKeys'
    });
  }
}
