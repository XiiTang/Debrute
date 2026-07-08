import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { debruteHomeDir } from '@debrute/project-core';
import type {
  AudioModelConfig,
  AudioModelsConfig,
  ImageModelConfig,
  ImageModelsConfig,
  SecretsConfig,
  VideoModelConfig,
  VideoModelsConfig
} from '@debrute/capability-runtime';
import type { WorkbenchPreferencesView } from '@debrute/app-protocol';

export interface GlobalConfigPaths {
  root: string;
  imageModelsFile: string;
  videoModelsFile: string;
  audioModelsFile: string;
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
const WORKBENCH_THEME_PREFERENCE_ERROR_MESSAGE = 'Workbench theme preference must be "system", "dark", or "light".';

export class GlobalConfigStore {
  constructor(private readonly options: { debruteHome?: string } = {}) {}

  paths(): GlobalConfigPaths {
    const debruteHome = this.options.debruteHome ?? debruteHomeDir();
    const root = join(debruteHome, 'config');
    return {
      root,
      imageModelsFile: join(root, 'image_models.json'),
      videoModelsFile: join(root, 'video_models.json'),
      audioModelsFile: join(root, 'audio_models.json'),
      secretsFile: join(root, 'secrets.json'),
      adobeBridgeFile: join(root, 'adobe_bridge.json'),
      workbenchChromeFile: join(root, 'workbench_chrome.json'),
      workbenchPreferencesFile: join(root, 'workbench_preferences.json')
    };
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

  async readAudioModels(): Promise<AudioModelsConfig> {
    return normalizeAudioModelsConfig(await readJsonOrDefault(this.paths().audioModelsFile, { audioModels: [] }));
  }

  async saveAudioModels(config: AudioModelsConfig): Promise<void> {
    await writeJsonAtomic(this.paths().audioModelsFile, normalizeAudioModelsConfig(config));
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
      locale: 'en',
      themePreference: 'system'
    }));
  }

  async saveWorkbenchPreferences(config: WorkbenchPreferencesConfig): Promise<void> {
    await writeJsonAtomic(this.paths().workbenchPreferencesFile, normalizeWorkbenchPreferencesConfig(config));
  }

  async readSecrets(): Promise<SecretsConfig> {
    return normalizeSecretsConfig(await readJsonOrDefault(this.paths().secretsFile, {
      imageModelApiKeys: {},
      videoModelApiKeys: {},
      audioModelApiKeys: {}
    }));
  }

  async saveSecrets(config: SecretsConfig): Promise<void> {
    const normalized = normalizeSecretsConfig(config);
    await writeSecretJsonAtomic(this.paths().secretsFile, {
      imageModelApiKeys: { ...normalized.imageModelApiKeys },
      videoModelApiKeys: { ...normalized.videoModelApiKeys },
      audioModelApiKeys: { ...normalized.audioModelApiKeys }
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
  if (config.themePreference !== 'system' && config.themePreference !== 'dark' && config.themePreference !== 'light') {
    throw new Error(WORKBENCH_THEME_PREFERENCE_ERROR_MESSAGE);
  }
  return {
    locale: config.locale,
    themePreference: config.themePreference
  };
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

function normalizeAudioModelsConfig(config: unknown): AudioModelsConfig {
  if (!isRecord(config) || !Array.isArray(config.audioModels)) {
    throw new Error('Audio models config must contain audioModels.');
  }
  return {
    audioModels: config.audioModels.map(normalizeAudioModelConfig)
  };
}

function normalizeSecretsConfig(config: unknown): SecretsConfig {
  if (!isRecord(config)) {
    throw new Error('Secrets config must be an object.');
  }
  return {
    imageModelApiKeys: normalizeSecretRecord(config.imageModelApiKeys, 'imageModelApiKeys'),
    videoModelApiKeys: normalizeSecretRecord(config.videoModelApiKeys, 'videoModelApiKeys'),
    audioModelApiKeys: normalizeSecretRecord(config.audioModelApiKeys, 'audioModelApiKeys')
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

function normalizeAudioModelConfig(model: unknown): AudioModelConfig {
  if (!isRecord(model)) {
    throw new Error('Audio model config must be an object.');
  }
  const debruteModelId = requireStringProperty(model, 'debruteModelId', 'Audio model debruteModelId').trim();
  if (!debruteModelId) {
    throw new Error('Audio model debruteModelId must be a non-empty string.');
  }
  return {
    debruteModelId,
    baseUrlOverride: normalizeMediaBaseUrlOverride(model.baseUrlOverride, 'Audio model'),
    requestModelIdOverride: normalizeMediaRequestModelIdOverride(model.requestModelIdOverride, 'Audio model')
  };
}

function normalizeSecretRecord(value: unknown, field: string): Record<string, string> {
  if (!isRecord(value)) {
    throw new Error(`Secrets config ${field} must be an object.`);
  }
  const output: Record<string, string> = {};
  for (const [key, secret] of Object.entries(value)) {
    if (typeof secret !== 'string') {
      throw new Error(`Secrets config ${field} values must be strings.`);
    }
    const trimmedKey = key.trim();
    if (!trimmedKey) {
      throw new Error(`Secrets config ${field} keys must be non-empty strings.`);
    }
    output[trimmedKey] = secret;
  }
  return output;
}

function normalizeMediaBaseUrlOverride(value: unknown, label: 'Image model' | 'Video model' | 'Audio model'): string | null {
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

function normalizeMediaRequestModelIdOverride(value: unknown, label: 'Image model' | 'Video model' | 'Audio model'): string | null {
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

function requireStringProperty(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string.`);
  }
  return value;
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
