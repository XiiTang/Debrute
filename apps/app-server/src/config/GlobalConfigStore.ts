import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { debruteHomeDir } from '@debrute/project-core';
import type {
  ImageModelConfig,
  ImageModelsConfig,
  LlmProvidersConfig,
  SecretsConfig,
  VideoModelConfig,
  VideoModelsConfig
} from '@debrute/capability-runtime';
import type { LlmProviderType, WorkbenchPreferencesView } from '@debrute/app-protocol';

export interface GlobalConfigPaths {
  root: string;
  llmProvidersFile: string;
  imageModelsFile: string;
  videoModelsFile: string;
  secretsFile: string;
  adobeBridgeFile: string;
  workbenchChromeFile: string;
  workbenchPreferencesFile: string;
}

export interface AdobeBridgeConfig {
  enabled: boolean;
}

export interface WorkbenchChromeConfig {
  recentProjectRoots: string[];
}

export type WorkbenchPreferencesConfig = WorkbenchPreferencesView;

const WORKBENCH_LOCALE_ERROR_MESSAGE = 'Workbench locale must be "en" or "zh-CN".';

export class GlobalConfigStore {
  constructor(private readonly options: { debruteHome?: string } = {}) {}

  paths(): GlobalConfigPaths {
    const debruteHome = this.options.debruteHome ?? debruteHomeDir();
    const root = join(debruteHome, 'config');
    return {
      root,
      llmProvidersFile: join(root, 'llm_providers.json'),
      imageModelsFile: join(root, 'image_models.json'),
      videoModelsFile: join(root, 'video_models.json'),
      secretsFile: join(root, 'secrets.json'),
      adobeBridgeFile: join(root, 'adobe_bridge.json'),
      workbenchChromeFile: join(root, 'workbench_chrome.json'),
      workbenchPreferencesFile: join(root, 'workbench_preferences.json')
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

  async readAdobeBridge(): Promise<AdobeBridgeConfig> {
    return normalizeAdobeBridgeConfig(await readJsonOrDefault<unknown>(this.paths().adobeBridgeFile, {
      enabled: true
    }));
  }

  async saveAdobeBridge(config: AdobeBridgeConfig): Promise<void> {
    await writeJsonAtomic(this.paths().adobeBridgeFile, normalizeAdobeBridgeConfig(config));
  }

  async readWorkbenchChrome(): Promise<WorkbenchChromeConfig> {
    return normalizeWorkbenchChromeConfig(await readJsonOrDefault<unknown>(this.paths().workbenchChromeFile, {
      recentProjectRoots: []
    }));
  }

  async saveWorkbenchChrome(config: WorkbenchChromeConfig): Promise<void> {
    await writeJsonAtomic(this.paths().workbenchChromeFile, normalizeWorkbenchChromeConfig(config));
  }

  async readWorkbenchPreferences(): Promise<WorkbenchPreferencesConfig> {
    return normalizeWorkbenchPreferencesConfig(await readJsonOrDefault<unknown>(this.paths().workbenchPreferencesFile, {
      locale: 'en'
    }));
  }

  async saveWorkbenchPreferences(config: WorkbenchPreferencesConfig): Promise<void> {
    await writeJsonAtomic(this.paths().workbenchPreferencesFile, normalizeWorkbenchPreferencesConfig(config));
  }

  async readSecrets(): Promise<SecretsConfig> {
    return readJsonOrDefault(this.paths().secretsFile, { llmProviderApiKeys: {}, imageModelApiKeys: {}, videoModelApiKeys: {} });
  }

  async saveSecrets(config: SecretsConfig): Promise<void> {
    await writeSecretJsonAtomic(this.paths().secretsFile, {
      llmProviderApiKeys: { ...config.llmProviderApiKeys },
      imageModelApiKeys: { ...config.imageModelApiKeys },
      videoModelApiKeys: { ...config.videoModelApiKeys }
    });
  }

}

function normalizeAdobeBridgeConfig(config: unknown): AdobeBridgeConfig {
  if (!isRecord(config) || typeof config.enabled !== 'boolean') {
    throw new Error('Adobe Bridge config must contain enabled.');
  }
  return { enabled: config.enabled };
}

function normalizeWorkbenchChromeConfig(config: unknown): WorkbenchChromeConfig {
  if (!isRecord(config) || !Array.isArray(config.recentProjectRoots)) {
    throw new Error('Workbench chrome config must contain recentProjectRoots.');
  }
  return {
    recentProjectRoots: config.recentProjectRoots
      .map((item) => typeof item === 'string' ? item.trim() : '')
      .filter(Boolean)
      .slice(0, 12)
  };
}

function normalizeWorkbenchPreferencesConfig(config: unknown): WorkbenchPreferencesConfig {
  if (!isRecord(config) || (config.locale !== 'en' && config.locale !== 'zh-CN')) {
    throw new Error(WORKBENCH_LOCALE_ERROR_MESSAGE);
  }
  return { locale: config.locale };
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

function normalizeImageModelsConfig(config: unknown): ImageModelsConfig {
  if (!isRecord(config) || !Array.isArray(config.imageModels)) {
    throw new Error('Image models config must contain imageModels.');
  }
  return {
    imageModels: config.imageModels.map(normalizeImageModelConfig)
  };
}

function normalizeVideoModelsConfig(config: unknown): VideoModelsConfig {
  if (!isRecord(config) || !Array.isArray(config.videoModels)) {
    throw new Error('Video models config must contain videoModels.');
  }
  return {
    videoModels: config.videoModels.map(normalizeVideoModelConfig)
  };
}

function normalizeImageModelConfig(model: unknown): ImageModelConfig {
  if (!isRecord(model)) {
    throw new Error('Image model config must be an object.');
  }
  const debruteModelId = requireStringProperty(model, 'debruteModelId', 'Image model debruteModelId').trim();
  if (!debruteModelId) {
    throw new Error('Image model debruteModelId must be a non-empty string.');
  }
  return {
    debruteModelId,
    baseUrlOverride: normalizeMediaBaseUrlOverride(model.baseUrlOverride, 'Image model'),
    requestModelIdOverride: normalizeMediaRequestModelIdOverride(model.requestModelIdOverride, 'Image model')
  };
}

function normalizeVideoModelConfig(model: unknown): VideoModelConfig {
  if (!isRecord(model)) {
    throw new Error('Video model config must be an object.');
  }
  const debruteModelId = requireStringProperty(model, 'debruteModelId', 'Video model debruteModelId').trim();
  if (!debruteModelId) {
    throw new Error('Video model debruteModelId must be a non-empty string.');
  }
  return {
    debruteModelId,
    baseUrlOverride: normalizeMediaBaseUrlOverride(model.baseUrlOverride, 'Video model'),
    requestModelIdOverride: normalizeMediaRequestModelIdOverride(model.requestModelIdOverride, 'Video model')
  };
}

function normalizeMediaBaseUrlOverride(value: unknown, label: 'Image model' | 'Video model'): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`${label} baseUrlOverride must be a string or null.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} baseUrlOverride must be null or a non-empty string.`);
  }
  return trimmed;
}

function normalizeMediaRequestModelIdOverride(value: unknown, label: 'Image model' | 'Video model'): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`${label} requestModelIdOverride must be a string or null.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} requestModelIdOverride must be null or a non-empty string.`);
  }
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalStringOrNull(value: unknown): boolean {
  return value === null || typeof value === 'string';
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

async function writeSecretJsonAtomic(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(tempPath, 0o600);
  await rename(tempPath, path);
  await chmod(path, 0o600);
}
