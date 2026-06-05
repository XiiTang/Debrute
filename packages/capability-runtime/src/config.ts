import type {
  ImageModelSettingsView,
  LlmProviderConfig,
  LlmProviderSettingsView,
  LlmProviderType,
  VideoModelSettingsView
} from '@debrute/app-protocol';

export type {
  DiscoverLlmProviderModelsInput,
  DiscoverProviderModelsOutput,
  ImageModelSettingRecord,
  ImageModelSettingsView,
  LlmProviderConfig,
  LlmProviderSettingRecord,
  LlmProviderSettingsView,
  LlmProviderType,
  SaveImageModelSettingInput,
  SaveLlmProviderSettingInput,
  SaveVideoModelSettingInput,
  VideoModelSettingRecord,
  VideoModelSettingsView
} from '@debrute/app-protocol';

export interface LlmProvidersConfig {
  providers: LlmProviderConfig[];
  defaultModelKey: string | null;
}

export interface ProviderModelSpec {
  modelKey: string;
  providerId: string;
  providerType: LlmProviderType;
  modelId: string;
  displayName: string;
  contextWindow?: number;
  supportsTools?: boolean;
}

export interface ImageModelsConfig {
  imageModels: ImageModelConfig[];
}

export interface ImageModelConfig {
  debruteModelId: string;
  baseUrlOverride: string | null;
  requestModelIdOverride: string | null;
}

export interface VideoModelsConfig {
  videoModels: VideoModelConfig[];
}

export interface VideoModelConfig {
  debruteModelId: string;
  baseUrlOverride: string | null;
  requestModelIdOverride: string | null;
}

export interface SecretsConfig {
  llmProviderApiKeys: Record<string, string>;
  imageModelApiKeys: Record<string, string>;
  videoModelApiKeys: Record<string, string>;
}

export interface ImageModelCatalogViewEntry {
  debruteModelId: string;
  summary: string;
  supportsEditing: boolean;
  supportsTextRendering: boolean;
  defaultBaseUrl: string;
  defaultRequestModelId: string;
}

export interface VideoModelCatalogViewEntry {
  debruteModelId: string;
  summary: string;
  supportsTextToVideo: boolean;
  supportsImageReferences: boolean;
  supportsVideoReferences: boolean;
  supportsAudioReferences: boolean;
  supportsGeneratedAudio: boolean;
  defaultBaseUrl: string;
  defaultRequestModelId: string;
}

export function createImageModelSettingsView(
  config: ImageModelsConfig,
  secrets: SecretsConfig,
  catalog: ImageModelCatalogViewEntry[]
): ImageModelSettingsView {
  const configuredById = new Map(config.imageModels.map((model) => [model.debruteModelId, model]));
  return {
    models: catalog.map((entry) => {
      const configured = configuredById.get(entry.debruteModelId);
      const apiKeySet = Boolean(secrets.imageModelApiKeys[entry.debruteModelId]?.trim());
      return {
        debruteModelId: entry.debruteModelId,
        summary: entry.summary,
        supportsEditing: entry.supportsEditing,
        supportsTextRendering: entry.supportsTextRendering,
        defaultBaseUrl: entry.defaultBaseUrl,
        defaultRequestModelId: entry.defaultRequestModelId,
        baseUrlOverride: configured?.baseUrlOverride ?? null,
        requestModelIdOverride: configured?.requestModelIdOverride ?? null,
        apiKeySet
      };
    })
  };
}

export function createVideoModelSettingsView(
  config: VideoModelsConfig,
  secrets: SecretsConfig,
  catalog: VideoModelCatalogViewEntry[]
): VideoModelSettingsView {
  const configuredById = new Map(config.videoModels.map((model) => [model.debruteModelId, model]));
  return {
    models: catalog.map((entry) => {
      const configured = configuredById.get(entry.debruteModelId);
      const apiKeySet = Boolean(secrets.videoModelApiKeys[entry.debruteModelId]?.trim());
      return {
        debruteModelId: entry.debruteModelId,
        summary: entry.summary,
        supportsTextToVideo: entry.supportsTextToVideo,
        supportsImageReferences: entry.supportsImageReferences,
        supportsVideoReferences: entry.supportsVideoReferences,
        supportsAudioReferences: entry.supportsAudioReferences,
        supportsGeneratedAudio: entry.supportsGeneratedAudio,
        defaultBaseUrl: entry.defaultBaseUrl,
        defaultRequestModelId: entry.defaultRequestModelId,
        baseUrlOverride: configured?.baseUrlOverride ?? null,
        requestModelIdOverride: configured?.requestModelIdOverride ?? null,
        apiKeySet
      };
    })
  };
}

export function createLlmProviderSettingsView(
  config: LlmProvidersConfig,
  secrets: SecretsConfig
): LlmProviderSettingsView {
  const providers = config.providers
    .map((provider) => ({
      ...provider,
      apiKeySet: Boolean(secrets.llmProviderApiKeys[provider.id]?.trim()),
      modelKeys: provider.modelIds.map((modelId) => `${provider.id}:${modelId}`)
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const availableModelKeys = providers
    .filter((provider) => provider.enabled && provider.apiKeySet)
    .flatMap((provider) => provider.modelKeys);
  const availableSet = new Set(availableModelKeys);
  return {
    providers,
    availableModelKeys,
    defaultModelKey: config.defaultModelKey && availableSet.has(config.defaultModelKey) ? config.defaultModelKey : null
  };
}
