import type {
  ApiKeyPreviewRecord,
  AudioModelKind,
  AudioModelSettingsView,
  ImageModelSettingsView,
  MediaModelKeyState,
  ModelApiKeyEntry,
  VideoModelSettingsView
} from '@debrute/app-protocol';

export type {
  ApiKeyPreviewRecord,
  AudioModelSettingRecord,
  AudioModelSettingsView,
  MediaModelKeyState,
  ModelApiKeyEntry,
  SaveAudioModelSettingInput,
  ImageModelSettingRecord,
  ImageModelSettingsView,
  SaveImageModelSettingInput,
  SaveVideoModelSettingInput,
  VideoModelSettingRecord,
  VideoModelSettingsView
} from '@debrute/app-protocol';

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

export interface AudioModelsConfig {
  audioModels: AudioModelConfig[];
}

export interface AudioModelConfig {
  debruteModelId: string;
  baseUrlOverride: string | null;
  requestModelIdOverride: string | null;
}

export interface SecretsConfig {
  imageModelApiKeys: Record<string, ModelApiKeyEntry[]>;
  videoModelApiKeys: Record<string, ModelApiKeyEntry[]>;
  audioModelApiKeys: Record<string, ModelApiKeyEntry[]>;
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

export interface AudioModelCatalogViewEntry {
  debruteModelId: string;
  kind: AudioModelKind;
  summary: string;
  defaultBaseUrl: string;
  defaultRequestModelId: string;
}

const API_KEY_PREVIEW_MASK = '****************************';
const API_KEY_PREVIEW_MIN_LENGTH = 8;

export function apiKeyPreview(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length < API_KEY_PREVIEW_MIN_LENGTH) {
    return '****';
  }
  return `${trimmed.slice(0, 2)}${API_KEY_PREVIEW_MASK}${trimmed.slice(-2)}`;
}

export function createApiKeyState(entries: ModelApiKeyEntry[] | undefined): MediaModelKeyState {
  const apiKeys = entries ?? [];
  const enabledApiKeyCount = apiKeys.filter((entry) => entry.enabled && entry.key.trim()).length;
  return {
    apiKeySet: enabledApiKeyCount > 0,
    apiKeyCount: apiKeys.length,
    enabledApiKeyCount,
    apiKeyPreviews: apiKeys.map((entry): ApiKeyPreviewRecord => ({
      id: entry.id,
      label: entry.label,
      enabled: entry.enabled,
      preview: apiKeyPreview(entry.key)
    }))
  };
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
      const keyState = createApiKeyState(secrets.imageModelApiKeys[entry.debruteModelId]);
      return {
        debruteModelId: entry.debruteModelId,
        summary: entry.summary,
        supportsEditing: entry.supportsEditing,
        supportsTextRendering: entry.supportsTextRendering,
        defaultBaseUrl: entry.defaultBaseUrl,
        defaultRequestModelId: entry.defaultRequestModelId,
        baseUrlOverride: configured?.baseUrlOverride ?? null,
        requestModelIdOverride: configured?.requestModelIdOverride ?? null,
        ...keyState
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
      const keyState = createApiKeyState(secrets.videoModelApiKeys[entry.debruteModelId]);
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
        ...keyState
      };
    })
  };
}

export function createAudioModelSettingsView(
  config: AudioModelsConfig,
  secrets: SecretsConfig,
  catalog: AudioModelCatalogViewEntry[]
): AudioModelSettingsView {
  const configuredById = new Map(config.audioModels.map((model) => [model.debruteModelId, model]));
  return {
    models: catalog.map((entry) => {
      const configured = configuredById.get(entry.debruteModelId);
      const keyState = createApiKeyState(secrets.audioModelApiKeys[entry.debruteModelId]);
      return {
        debruteModelId: entry.debruteModelId,
        kind: entry.kind,
        summary: entry.summary,
        defaultBaseUrl: entry.defaultBaseUrl,
        defaultRequestModelId: entry.defaultRequestModelId,
        baseUrlOverride: configured?.baseUrlOverride ?? null,
        requestModelIdOverride: configured?.requestModelIdOverride ?? null,
        ...keyState
      };
    })
  };
}
