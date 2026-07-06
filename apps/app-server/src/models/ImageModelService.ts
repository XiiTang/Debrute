import { createImageModelCatalog, createImageModelSettingsView, type SecretsConfig } from '@debrute/capability-runtime';
import type { ImageModelSettingsView, SaveImageModelSettingInput, SaveModelApiKeyEntryInput } from '@debrute/app-protocol';
import type { GlobalConfigStore } from '../config/GlobalConfigStore.js';
import { serviceError } from '../server/ServiceErrors.js';
import { normalizeModelApiKeySaveEntries, resolveModelApiKeyEntries } from './ModelApiKeySaveInput.js';

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
    if (saveInput.baseUrlOverride !== null || saveInput.requestModelIdOverride !== null) {
      imageModels.push({
        debruteModelId: modelId,
        baseUrlOverride: saveInput.baseUrlOverride,
        requestModelIdOverride: saveInput.requestModelIdOverride
      });
    }
    imageModels.sort((left, right) => left.debruteModelId.localeCompare(right.debruteModelId));
    const nextImageModels = { imageModels };
    let nextSecrets: SecretsConfig | undefined;
    if (saveInput.apiKeys !== undefined) {
      const secrets = await this.input.configStore.readSecrets();
      const imageModelApiKeys = { ...secrets.imageModelApiKeys };
      imageModelApiKeys[modelId] = resolveModelApiKeyEntries(
        saveInput.apiKeys,
        secrets.imageModelApiKeys[modelId] ?? [],
        'Image model',
        imageModelInputError
      );
      nextSecrets = {
        imageModelApiKeys,
        videoModelApiKeys: { ...secrets.videoModelApiKeys },
        audioModelApiKeys: { ...secrets.audioModelApiKeys }
      };
    }
    await this.input.configStore.saveImageModels(nextImageModels);
    if (nextSecrets !== undefined) {
      await this.input.configStore.saveSecrets(nextSecrets);
    }
    return this.getSettings();
  }
}

function normalizeImageModelSaveInput(input: SaveImageModelSettingInput): {
  baseUrlOverride: string | null;
  requestModelIdOverride: string | null;
  apiKeys?: SaveModelApiKeyEntryInput[];
} {
  if (!isRecord(input)) {
    throw imageModelInputError('Image model setting must be an object.', 'mediaModelSetting');
  }
  const baseUrlOverride = normalizeImageModelBaseUrlOverride(input.baseUrlOverride);
  const requestModelIdOverride = normalizeImageModelRequestModelIdOverride(input.requestModelIdOverride);
  return {
    baseUrlOverride,
    requestModelIdOverride,
    ...(input.apiKeys !== undefined
      ? { apiKeys: normalizeModelApiKeySaveEntries(input.apiKeys, 'Image model', imageModelInputError) }
      : {})
  };
}

function normalizeImageModelBaseUrlOverride(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw imageModelInputError('Image model baseUrlOverride must be a string or null.', 'baseUrlOverride');
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw imageModelInputError('Image model baseUrlOverride must be null or a non-empty string.', 'baseUrlOverride');
  }
  return trimmed;
}

function normalizeImageModelRequestModelIdOverride(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw imageModelInputError('Image model requestModelIdOverride must be a string or null.', 'requestModelIdOverride');
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw imageModelInputError('Image model requestModelIdOverride must be null or a non-empty string.', 'requestModelIdOverride');
  }
  return trimmed;
}

function imageModelInputError(message: string, field: string): Error {
  return serviceError('invalid_input', message, { field });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
