import { createAudioModelCatalog, createAudioModelSettingsView, type SecretsConfig } from '@debrute/capability-runtime';
import type { AudioModelSettingsView, SaveAudioModelSettingInput, SaveModelApiKeyEntryInput } from '@debrute/app-protocol';
import type { GlobalConfigStore } from '../config/GlobalConfigStore.js';
import { serviceError } from '../server/ServiceErrors.js';
import { normalizeModelApiKeySaveEntries, resolveModelApiKeyEntries } from './ModelApiKeySaveInput.js';

export class AudioModelService {
  private readonly catalog = createAudioModelCatalog();

  constructor(private readonly input: { configStore: GlobalConfigStore }) {}

  async getSettings(): Promise<AudioModelSettingsView> {
    return createAudioModelSettingsView(
      await this.input.configStore.readAudioModels(),
      await this.input.configStore.readSecrets(),
      this.catalog.listAll()
    );
  }

  async saveSetting(modelId: string, input: SaveAudioModelSettingInput): Promise<AudioModelSettingsView> {
    const saveInput = normalizeAudioModelSaveInput(input);
    if (!this.catalog.get(modelId)) {
      throw new Error(`Unknown audio model: ${modelId}`);
    }
    const config = await this.input.configStore.readAudioModels();
    const audioModels = config.audioModels.filter((model) => model.debruteModelId !== modelId);
    if (saveInput.baseUrlOverride !== null || saveInput.requestModelIdOverride !== null) {
      audioModels.push({
        debruteModelId: modelId,
        baseUrlOverride: saveInput.baseUrlOverride,
        requestModelIdOverride: saveInput.requestModelIdOverride
      });
    }
    audioModels.sort((left, right) => left.debruteModelId.localeCompare(right.debruteModelId));
    const nextAudioModels = { audioModels };
    let nextSecrets: SecretsConfig | undefined;
    if (saveInput.apiKeys !== undefined) {
      const secrets = await this.input.configStore.readSecrets();
      const audioModelApiKeys = { ...secrets.audioModelApiKeys };
      audioModelApiKeys[modelId] = resolveModelApiKeyEntries(
        saveInput.apiKeys,
        secrets.audioModelApiKeys[modelId] ?? [],
        'Audio model',
        audioModelInputError
      );
      nextSecrets = {
        imageModelApiKeys: { ...secrets.imageModelApiKeys },
        videoModelApiKeys: { ...secrets.videoModelApiKeys },
        audioModelApiKeys
      };
    }
    await this.input.configStore.saveAudioModels(nextAudioModels);
    if (nextSecrets !== undefined) {
      await this.input.configStore.saveSecrets(nextSecrets);
    }
    return this.getSettings();
  }
}

function normalizeAudioModelSaveInput(input: SaveAudioModelSettingInput): {
  baseUrlOverride: string | null;
  requestModelIdOverride: string | null;
  apiKeys?: SaveModelApiKeyEntryInput[];
} {
  if (!isRecord(input)) {
    throw audioModelInputError('Audio model setting must be an object.', 'audioModelSetting');
  }
  const baseUrlOverride = normalizeAudioModelBaseUrlOverride(input.baseUrlOverride);
  const requestModelIdOverride = normalizeAudioModelRequestModelIdOverride(input.requestModelIdOverride);
  return {
    baseUrlOverride,
    requestModelIdOverride,
    ...(input.apiKeys !== undefined
      ? { apiKeys: normalizeModelApiKeySaveEntries(input.apiKeys, 'Audio model', audioModelInputError) }
      : {})
  };
}

function normalizeAudioModelBaseUrlOverride(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw audioModelInputError('Audio model baseUrlOverride must be a string or null.', 'baseUrlOverride');
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw audioModelInputError('Audio model baseUrlOverride must be null or a non-empty string.', 'baseUrlOverride');
  }
  return trimmed;
}

function normalizeAudioModelRequestModelIdOverride(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw audioModelInputError('Audio model requestModelIdOverride must be a string or null.', 'requestModelIdOverride');
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw audioModelInputError('Audio model requestModelIdOverride must be null or a non-empty string.', 'requestModelIdOverride');
  }
  return trimmed;
}

function audioModelInputError(message: string, field: string): Error {
  return serviceError('invalid_input', message, { field });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
