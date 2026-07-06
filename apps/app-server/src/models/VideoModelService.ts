import { createVideoModelCatalog, createVideoModelSettingsView, type SecretsConfig } from '@debrute/capability-runtime';
import type { SaveModelApiKeyEntryInput, SaveVideoModelSettingInput, VideoModelSettingsView } from '@debrute/app-protocol';
import type { GlobalConfigStore } from '../config/GlobalConfigStore.js';
import { serviceError } from '../server/ServiceErrors.js';
import { normalizeModelApiKeySaveEntries, resolveModelApiKeyEntries } from './ModelApiKeySaveInput.js';

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
    const saveInput = normalizeVideoModelSaveInput(input);
    if (!this.catalog.get(modelId)) {
      throw new Error(`Unknown video model: ${modelId}`);
    }
    const config = await this.input.configStore.readVideoModels();
    const videoModels = config.videoModels.filter((model) => model.debruteModelId !== modelId);
    if (saveInput.baseUrlOverride !== null || saveInput.requestModelIdOverride !== null) {
      videoModels.push({
        debruteModelId: modelId,
        baseUrlOverride: saveInput.baseUrlOverride,
        requestModelIdOverride: saveInput.requestModelIdOverride
      });
    }
    videoModels.sort((left, right) => left.debruteModelId.localeCompare(right.debruteModelId));
    const nextVideoModels = { videoModels };
    let nextSecrets: SecretsConfig | undefined;
    if (saveInput.apiKeys !== undefined) {
      const secrets = await this.input.configStore.readSecrets();
      const videoModelApiKeys = { ...secrets.videoModelApiKeys };
      videoModelApiKeys[modelId] = resolveModelApiKeyEntries(
        saveInput.apiKeys,
        secrets.videoModelApiKeys[modelId] ?? [],
        'Video model',
        videoModelInputError
      );
      nextSecrets = {
        imageModelApiKeys: { ...secrets.imageModelApiKeys },
        videoModelApiKeys,
        audioModelApiKeys: { ...secrets.audioModelApiKeys }
      };
    }
    await this.input.configStore.saveVideoModels(nextVideoModels);
    if (nextSecrets !== undefined) {
      await this.input.configStore.saveSecrets(nextSecrets);
    }
    return this.getSettings();
  }
}

function normalizeVideoModelSaveInput(input: SaveVideoModelSettingInput): {
  baseUrlOverride: string | null;
  requestModelIdOverride: string | null;
  apiKeys?: SaveModelApiKeyEntryInput[];
} {
  if (!isRecord(input)) {
    throw videoModelInputError('Video model setting must be an object.', 'mediaModelSetting');
  }
  const baseUrlOverride = normalizeVideoModelBaseUrlOverride(input.baseUrlOverride);
  const requestModelIdOverride = normalizeVideoModelRequestModelIdOverride(input.requestModelIdOverride);
  return {
    baseUrlOverride,
    requestModelIdOverride,
    ...(input.apiKeys !== undefined
      ? { apiKeys: normalizeModelApiKeySaveEntries(input.apiKeys, 'Video model', videoModelInputError) }
      : {})
  };
}

function normalizeVideoModelBaseUrlOverride(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw videoModelInputError('Video model baseUrlOverride must be a string or null.', 'baseUrlOverride');
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw videoModelInputError('Video model baseUrlOverride must be null or a non-empty string.', 'baseUrlOverride');
  }
  return trimmed;
}

function normalizeVideoModelRequestModelIdOverride(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw videoModelInputError('Video model requestModelIdOverride must be a string or null.', 'requestModelIdOverride');
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw videoModelInputError('Video model requestModelIdOverride must be null or a non-empty string.', 'requestModelIdOverride');
  }
  return trimmed;
}

function videoModelInputError(message: string, field: string): Error {
  return serviceError('invalid_input', message, { field });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
