import {
  createVideoModelSettingsView,
  type VideoModelsConfig
} from '@debrute/capability-runtime';
import { createVideoModelCatalog } from '@debrute/capability-runtime';
import type { SaveVideoModelSettingInput, VideoModelSettingsView } from '@debrute/app-protocol';
import type { GlobalConfigStore } from '../config/GlobalConfigStore.js';
import { saveMediaModelSetting } from './MediaModelService.js';

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
}
