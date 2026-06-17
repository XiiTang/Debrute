import { createVideoModelCatalog, createVideoModelSettingsView } from '@debrute/capability-runtime';
import type { SaveVideoModelSettingInput, VideoModelSettingsView } from '@debrute/app-protocol';
import type { GlobalConfigStore } from '../config/GlobalConfigStore.js';
import { serviceError } from '../server/ServiceErrors.js';

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
    if (saveInput.requestModelIdOverride !== null) {
      videoModels.push({
        debruteModelId: modelId,
        requestModelIdOverride: saveInput.requestModelIdOverride
      });
    }
    videoModels.sort((left, right) => left.debruteModelId.localeCompare(right.debruteModelId));
    await this.input.configStore.saveVideoModels({ videoModels });
    if (saveInput.apiKey !== undefined) {
      const secrets = await this.input.configStore.readSecrets();
      const videoModelApiKeys = { ...secrets.videoModelApiKeys };
      const apiKey = saveInput.apiKey.trim();
      if (apiKey) {
        videoModelApiKeys[modelId] = apiKey;
      } else {
        delete videoModelApiKeys[modelId];
      }
      await this.input.configStore.saveSecrets({
        llmProviderApiKeys: { ...secrets.llmProviderApiKeys },
        imageModelApiKeys: { ...secrets.imageModelApiKeys },
        videoModelApiKeys
      });
    }
    return this.getSettings();
  }
}

function normalizeVideoModelSaveInput(input: SaveVideoModelSettingInput): { requestModelIdOverride: string | null; apiKey?: string } {
  if (!isRecord(input)) {
    throw videoModelInputError('Video model setting must be an object.');
  }
  const requestModelIdOverride = normalizeVideoModelRequestModelIdOverride(input.requestModelIdOverride);
  if (input.apiKey !== undefined && typeof input.apiKey !== 'string') {
    throw videoModelInputError('Video model apiKey must be a string when provided.');
  }
  return {
    requestModelIdOverride,
    ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {})
  };
}

function normalizeVideoModelRequestModelIdOverride(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw videoModelInputError('Video model requestModelIdOverride must be a string or null.');
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw videoModelInputError('Video model requestModelIdOverride must be null or a non-empty string.');
  }
  return trimmed;
}

function videoModelInputError(message: string): Error {
  return serviceError('invalid_input', message, { field: 'requestModelIdOverride' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
