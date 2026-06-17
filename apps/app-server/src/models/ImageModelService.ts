import { createImageModelCatalog, createImageModelSettingsView } from '@debrute/capability-runtime';
import type { ImageModelSettingsView, SaveImageModelSettingInput } from '@debrute/app-protocol';
import type { GlobalConfigStore } from '../config/GlobalConfigStore.js';
import { serviceError } from '../server/ServiceErrors.js';

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
    const saveInput = normalizeImageModelSaveInput(input);
    if (!this.catalog.get(modelId)) {
      throw new Error(`Unknown image model: ${modelId}`);
    }
    const config = await this.input.configStore.readImageModels();
    const imageModels = config.imageModels.filter((model) => model.debruteModelId !== modelId);
    if (saveInput.requestModelIdOverride !== null) {
      imageModels.push({
        debruteModelId: modelId,
        requestModelIdOverride: saveInput.requestModelIdOverride
      });
    }
    imageModels.sort((left, right) => left.debruteModelId.localeCompare(right.debruteModelId));
    await this.input.configStore.saveImageModels({ imageModels });
    if (saveInput.apiKey !== undefined) {
      const secrets = await this.input.configStore.readSecrets();
      const imageModelApiKeys = { ...secrets.imageModelApiKeys };
      const apiKey = saveInput.apiKey.trim();
      if (apiKey) {
        imageModelApiKeys[modelId] = apiKey;
      } else {
        delete imageModelApiKeys[modelId];
      }
      await this.input.configStore.saveSecrets({
        llmProviderApiKeys: { ...secrets.llmProviderApiKeys },
        imageModelApiKeys,
        videoModelApiKeys: { ...secrets.videoModelApiKeys }
      });
    }
    return this.getSettings();
  }
}

function normalizeImageModelSaveInput(input: SaveImageModelSettingInput): { requestModelIdOverride: string | null; apiKey?: string } {
  if (!isRecord(input)) {
    throw imageModelInputError('Image model setting must be an object.');
  }
  const requestModelIdOverride = normalizeImageModelRequestModelIdOverride(input.requestModelIdOverride);
  if (input.apiKey !== undefined && typeof input.apiKey !== 'string') {
    throw imageModelInputError('Image model apiKey must be a string when provided.');
  }
  return {
    requestModelIdOverride,
    ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {})
  };
}

function normalizeImageModelRequestModelIdOverride(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw imageModelInputError('Image model requestModelIdOverride must be a string or null.');
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw imageModelInputError('Image model requestModelIdOverride must be null or a non-empty string.');
  }
  return trimmed;
}

function imageModelInputError(message: string): Error {
  return serviceError('invalid_input', message, { field: 'requestModelIdOverride' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
