import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { axisHomeDir } from '@axis/project-core';
import type { ImageModelsConfig, LlmProvidersConfig, SecretsConfig, VideoModelsConfig } from '@axis/capability-runtime';
import type { LlmProviderType } from '@axis/app-protocol';

export interface GlobalConfigPaths {
  root: string;
  llmProvidersFile: string;
  imageModelsFile: string;
  videoModelsFile: string;
  secretsFile: string;
  canvasSettingsFile: string;
}

export interface CanvasSettingsConfig {
  imagePreviewsEnabled: boolean;
}

export class GlobalConfigStore {
  constructor(private readonly options: { axisHome?: string } = {}) {}

  paths(): GlobalConfigPaths {
    const axisHome = this.options.axisHome ?? axisHomeDir();
    const root = join(axisHome, 'config');
    return {
      root,
      llmProvidersFile: join(root, 'llm_providers.json'),
      imageModelsFile: join(root, 'image_models.json'),
      videoModelsFile: join(root, 'video_models.json'),
      secretsFile: join(root, 'secrets.json'),
      canvasSettingsFile: join(root, 'canvas_settings.json')
    };
  }

  async readLlmProviders(): Promise<LlmProvidersConfig> {
    return normalizeLlmProvidersConfig(await readJsonOrDefault<unknown>(this.paths().llmProvidersFile, {
      providers: [],
      defaultModelKey: null
    }));
  }

  async saveLlmProviders(config: LlmProvidersConfig): Promise<void> {
    await writeJsonAtomic(this.paths().llmProvidersFile, normalizeLlmProvidersConfig(config));
  }

  async readImageModels(): Promise<ImageModelsConfig> {
    return normalizeImageModelsConfig(await readJsonOrDefault(this.paths().imageModelsFile, { imageModels: [] }));
  }

  async saveImageModels(config: ImageModelsConfig): Promise<void> {
    await writeJsonAtomic(this.paths().imageModelsFile, normalizeImageModelsConfig(config));
  }

  async readVideoModels(): Promise<VideoModelsConfig> {
    return normalizeVideoModelsConfig(await readJsonOrDefault(this.paths().videoModelsFile, { videoModels: [] }));
  }

  async saveVideoModels(config: VideoModelsConfig): Promise<void> {
    await writeJsonAtomic(this.paths().videoModelsFile, normalizeVideoModelsConfig(config));
  }

  async readSecrets(): Promise<SecretsConfig> {
    return readJsonOrDefault(this.paths().secretsFile, { llmProviderApiKeys: {}, imageModelApiKeys: {}, videoModelApiKeys: {} });
  }

  async saveSecrets(config: SecretsConfig): Promise<void> {
    await writeJsonAtomic(this.paths().secretsFile, {
      llmProviderApiKeys: { ...config.llmProviderApiKeys },
      imageModelApiKeys: { ...config.imageModelApiKeys },
      videoModelApiKeys: { ...config.videoModelApiKeys }
    });
  }

  async readCanvasSettings(): Promise<CanvasSettingsConfig> {
    return normalizeCanvasSettingsConfig(await readJsonOrDefault<Partial<CanvasSettingsConfig>>(this.paths().canvasSettingsFile, {
      imagePreviewsEnabled: true
    }));
  }

  async saveCanvasSettings(config: CanvasSettingsConfig): Promise<void> {
    await writeJsonAtomic(this.paths().canvasSettingsFile, normalizeCanvasSettingsConfig(config));
  }
}

function normalizeLlmProvidersConfig(config: unknown): LlmProvidersConfig {
  if (!isRecord(config) || !Array.isArray(config.providers) || !optionalStringOrNull(config.defaultModelKey)) {
    throw new Error('LLM providers config must contain providers and defaultModelKey.');
  }
  const defaultModelKey = typeof config.defaultModelKey === 'string' ? config.defaultModelKey.trim() || null : null;
  return {
    providers: config.providers.map(normalizeLlmProviderConfig).filter((provider) => provider.id.length > 0),
    defaultModelKey
  };
}

function normalizeLlmProviderConfig(provider: unknown): LlmProvidersConfig['providers'][number] {
  if (!isRecord(provider)) {
    throw new Error('LLM provider config must be an object.');
  }
  return {
    id: requireStringProperty(provider, 'id', 'LLM provider id').trim(),
    name: requireStringProperty(provider, 'name', 'LLM provider name').trim(),
    providerType: requireLlmProviderType(provider.providerType),
    baseUrl: requireStringProperty(provider, 'baseUrl', 'LLM provider baseUrl').trim(),
    enabled: requireBooleanProperty(provider, 'enabled', 'LLM provider enabled'),
    modelIds: requireStringArrayProperty(provider, 'modelIds', 'LLM provider modelIds').map((modelId) => modelId.trim()).filter(Boolean)
  };
}

function requireLlmProviderType(value: unknown): LlmProviderType {
  if (value !== 'openai_compat' && value !== 'anthropic') {
    throw new Error('LLM provider providerType must be "openai_compat" or "anthropic".');
  }
  return value;
}

function requireStringProperty(value: Record<string, unknown>, key: string, label: string): string {
  if (typeof value[key] !== 'string') {
    throw new Error(`${label} must be a string.`);
  }
  return value[key];
}

function requireBooleanProperty(value: Record<string, unknown>, key: string, label: string): boolean {
  if (typeof value[key] !== 'boolean') {
    throw new Error(`${label} must be a boolean.`);
  }
  return value[key];
}

function requireStringArrayProperty(value: Record<string, unknown>, key: string, label: string): string[] {
  if (!Array.isArray(value[key]) || !value[key].every((item) => typeof item === 'string')) {
    throw new Error(`${label} must be a string array.`);
  }
  return value[key];
}

function normalizeImageModelsConfig(config: ImageModelsConfig): ImageModelsConfig {
  return {
    imageModels: config.imageModels.map((model) => ({
      axisModelId: model.axisModelId.trim(),
      baseUrlOverride: model.baseUrlOverride?.trim() || null,
      requestModelIdOverride: model.requestModelIdOverride?.trim() || null
    })).filter((model) => model.axisModelId.length > 0)
  };
}

function normalizeVideoModelsConfig(config: VideoModelsConfig): VideoModelsConfig {
  return {
    videoModels: config.videoModels.map((model) => ({
      axisModelId: model.axisModelId.trim(),
      baseUrlOverride: model.baseUrlOverride?.trim() || null,
      requestModelIdOverride: model.requestModelIdOverride?.trim() || null
    })).filter((model) => model.axisModelId.length > 0)
  };
}

function normalizeCanvasSettingsConfig(config: unknown): CanvasSettingsConfig {
  if (!isRecord(config)) {
    throw new Error('Canvas settings must be an object.');
  }
  if (!hasExactKeys(config, ['imagePreviewsEnabled'])) {
    throw new Error('Canvas settings must contain only imagePreviewsEnabled.');
  }
  if (typeof config.imagePreviewsEnabled !== 'boolean') {
    throw new Error('Canvas imagePreviewsEnabled must be a boolean.');
  }
  return {
    imagePreviewsEnabled: config.imagePreviewsEnabled
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalStringOrNull(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: string[]): boolean {
  const expected = new Set(expectedKeys);
  const actualKeys = Object.keys(value);
  return actualKeys.length === expected.size && actualKeys.every((key) => expected.has(key));
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function readJsonOrDefault<T>(path: string, fallback: T): Promise<T> {
  try {
    return await readJson<T>(path);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, path);
}
