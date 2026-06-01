import {
  createImageModelSettingsView,
  type ImageModelsConfig
} from '@axis/capability-runtime';
import { createImageModelCatalog, type ImageModelCatalogEntry } from '@axis/capability-runtime';
import type { ImageModelSettingsView, SaveImageModelSettingInput } from '@axis/app-protocol';
import type { GlobalConfigStore } from '../config/GlobalConfigStore.js';
import { configuredMediaCatalog, saveMediaModelSetting } from './MediaModelService.js';

export class ImageModelService {
  private readonly catalog = createImageModelCatalog();

  constructor(private readonly input: { configStore: GlobalConfigStore }) {}

  async getSettings(): Promise<ImageModelSettingsView> {
    return createImageModelSettingsView(
      await this.input.configStore.readImageModels(),
      await this.input.configStore.readSecrets(),
      this.catalog.listAll()
    );
  }

  async saveSetting(modelId: string, input: SaveImageModelSettingInput): Promise<ImageModelSettingsView> {
    await saveMediaModelSetting({
      configStore: this.input.configStore,
      modelKind: 'image',
      modelId,
      value: input,
      catalog: this.catalog,
      secretKey: 'imageModelApiKeys',
      readConfig: () => this.input.configStore.readImageModels(),
      recordsFromConfig: (config) => (config as ImageModelsConfig).imageModels,
      configFromRecords: (records) => ({ imageModels: records as ImageModelsConfig['imageModels'] }),
      saveConfig: (config) => this.input.configStore.saveImageModels(config as ImageModelsConfig)
    });
    return this.getSettings();
  }

  async configuredCatalog(): Promise<ImageModelCatalogEntry[]> {
    return configuredMediaCatalog({
      configStore: this.input.configStore,
      catalog: this.catalog,
      secretKey: 'imageModelApiKeys'
    });
  }
}
