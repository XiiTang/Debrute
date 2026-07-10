import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
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
import type {
  DebruteDefaultFrontend,
  SaveAudioModelSettingInput,
  SaveDebruteGlobalSettingsInput,
  SaveImageModelSettingInput,
  SaveVideoModelSettingInput,
  WorkbenchLocale,
  WorkbenchThemePreference
} from '@debrute/app-protocol';

export interface DebruteGlobalSettingsConfig {
  workbench: {
    locale: WorkbenchLocale;
    themePreference: WorkbenchThemePreference;
    defaultFrontend: DebruteDefaultFrontend;
  };
  chrome: {
    recentProjectRoots: string[];
  };
  models: {
    image: ImageModelsConfig;
    video: VideoModelsConfig;
    audio: AudioModelsConfig;
  };
  adobeBridge: {
    enabled: boolean;
  };
}

export interface DebruteGlobalConfigSnapshot {
  settings: DebruteGlobalSettingsConfig;
  secrets: SecretsConfig;
}

export type GlobalConfigMutation =
  | { kind: 'patch'; input: SaveDebruteGlobalSettingsInput }
  | { kind: 'rememberRecentProjectRoot'; projectRoot: string }
  | { kind: 'clearRecentProjectRoots' };

export interface GlobalConfigMutationResult {
  snapshot: DebruteGlobalConfigSnapshot;
  changed: boolean;
}

export class GlobalSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlobalSettingsValidationError';
  }
}

type NormalizedModelSettingInput = {
  baseUrlOverride: string | null;
  requestModelIdOverride: string | null;
  apiKey?: string;
};

const WORKBENCH_LOCALE_ERROR_MESSAGE = 'Workbench locale must be "en" or "zh-CN".';
const WORKBENCH_THEME_PREFERENCE_ERROR_MESSAGE = 'Workbench theme preference must be "system", "dark", or "light".';
const DEFAULT_FRONTEND_ERROR_MESSAGE = 'Global settings defaultFrontend must be "electron", "browser", or "runtime-only".';

const DEFAULT_GLOBAL_SETTINGS: DebruteGlobalSettingsConfig = {
  workbench: {
    locale: 'en',
    themePreference: 'system',
    defaultFrontend: 'electron'
  },
  chrome: {
    recentProjectRoots: []
  },
  models: {
    image: { imageModels: [] },
    video: { videoModels: [] },
    audio: { audioModels: [] }
  },
  adobeBridge: { enabled: true }
};

const DEFAULT_SECRETS: SecretsConfig = {
  imageModelApiKeys: {},
  videoModelApiKeys: {},
  audioModelApiKeys: {}
};

export class GlobalConfigStore {
  private readonly globalSettingsFile: string;
  private readonly secretsFile: string;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: { debruteHome?: string } = {}) {
    const root = join(options.debruteHome ?? debruteHomeDir(), 'config');
    this.globalSettingsFile = join(root, 'global_settings.json');
    this.secretsFile = join(root, 'secrets.json');
  }

  readGlobalSettings(): Promise<DebruteGlobalSettingsConfig> {
    return this.enqueue(() => this.readGlobalSettingsUnlocked());
  }

  readGlobalSnapshot(): Promise<DebruteGlobalConfigSnapshot> {
    return this.enqueue(() => this.readGlobalSnapshotUnlocked());
  }

  mutateGlobalSettings(mutation: GlobalConfigMutation): Promise<GlobalConfigMutationResult> {
    return this.enqueue(async () => {
      const current = await this.readGlobalSnapshotUnlocked();
      const snapshot = applyGlobalConfigMutation(current, mutation);
      const settingsChanged = !isDeepStrictEqual(current.settings, snapshot.settings);
      const secretsChanged = !isDeepStrictEqual(current.secrets, snapshot.secrets);

      if (secretsChanged) {
        await writeSecretJsonAtomic(this.secretsFile, snapshot.secrets);
      }
      if (settingsChanged) {
        await writeJsonAtomic(this.globalSettingsFile, snapshot.settings);
      }
      return { snapshot, changed: settingsChanged || secretsChanged };
    });
  }

  private async readGlobalSettingsUnlocked(): Promise<DebruteGlobalSettingsConfig> {
    return normalizeGlobalSettingsConfig(await readJsonOrDefault(
      this.globalSettingsFile,
      DEFAULT_GLOBAL_SETTINGS
    ));
  }

  private async readGlobalSnapshotUnlocked(): Promise<DebruteGlobalConfigSnapshot> {
    const [settings, secrets] = await Promise.all([
      this.readGlobalSettingsUnlocked(),
      readJsonOrDefault(this.secretsFile, DEFAULT_SECRETS).then(normalizeSecretsConfig)
    ]);
    return { settings, secrets };
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.then(operation, operation);
    this.operationQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}

function applyGlobalConfigMutation(
  current: DebruteGlobalConfigSnapshot,
  mutation: GlobalConfigMutation
): DebruteGlobalConfigSnapshot {
  if (mutation.kind === 'clearRecentProjectRoots') {
    return {
      settings: {
        ...current.settings,
        chrome: { recentProjectRoots: [] }
      },
      secrets: current.secrets
    };
  }
  if (mutation.kind === 'rememberRecentProjectRoot') {
    const projectRoot = mutation.projectRoot.trim();
    if (!projectRoot) {
      return current;
    }
    return {
      settings: {
        ...current.settings,
        chrome: {
          recentProjectRoots: [
            projectRoot,
            ...current.settings.chrome.recentProjectRoots.filter((root) => root !== projectRoot)
          ].slice(0, 12)
        }
      },
      secrets: current.secrets
    };
  }
  return asGlobalSettingsInput(() => applyGlobalSettingsPatch(current, mutation.input));
}

function applyGlobalSettingsPatch(
  current: DebruteGlobalConfigSnapshot,
  input: SaveDebruteGlobalSettingsInput
): DebruteGlobalConfigSnapshot {
  const patch = requireRecord(input, 'Global settings patch');
  const workbenchPatch = knownObjectPatch(patch, 'workbench', 'Global settings workbench');
  const modelsPatch = knownObjectPatch(patch, 'models', 'Global settings models');
  const adobeBridgePatch = knownObjectPatch(patch, 'adobeBridge', 'Global settings adobeBridge');
  const settings: DebruteGlobalSettingsConfig = {
    workbench: workbenchPatch
      ? normalizeWorkbenchSettings({ ...current.settings.workbench, ...workbenchPatch })
      : current.settings.workbench,
    chrome: current.settings.chrome,
    models: { ...current.settings.models },
    adobeBridge: adobeBridgePatch
      ? normalizeAdobeBridgeConfig({ ...current.settings.adobeBridge, ...adobeBridgePatch })
      : current.settings.adobeBridge
  };
  const secrets: SecretsConfig = {
    imageModelApiKeys: { ...current.secrets.imageModelApiKeys },
    videoModelApiKeys: { ...current.secrets.videoModelApiKeys },
    audioModelApiKeys: { ...current.secrets.audioModelApiKeys }
  };

  const image = modelsPatch && knownObjectPatch(modelsPatch, 'image', 'Global settings models.image');
  if (image) {
    const modelId = normalizeModelId(image.modelId, 'Image model');
    const setting = normalizeModelSettingInput(image.setting as SaveImageModelSettingInput, 'Image model');
    settings.models.image = upsertImageModelSetting(settings.models.image, modelId, setting);
    if (setting.apiKey !== undefined) {
      setSecretValue(secrets.imageModelApiKeys, modelId, setting.apiKey);
    }
  }

  const video = modelsPatch && knownObjectPatch(modelsPatch, 'video', 'Global settings models.video');
  if (video) {
    const modelId = normalizeModelId(video.modelId, 'Video model');
    const setting = normalizeModelSettingInput(video.setting as SaveVideoModelSettingInput, 'Video model');
    settings.models.video = upsertVideoModelSetting(settings.models.video, modelId, setting);
    if (setting.apiKey !== undefined) {
      setSecretValue(secrets.videoModelApiKeys, modelId, setting.apiKey);
    }
  }

  const audio = modelsPatch && knownObjectPatch(modelsPatch, 'audio', 'Global settings models.audio');
  if (audio) {
    const modelId = normalizeModelId(audio.modelId, 'Audio model');
    const setting = normalizeModelSettingInput(audio.setting as SaveAudioModelSettingInput, 'Audio model');
    settings.models.audio = upsertAudioModelSetting(settings.models.audio, modelId, setting);
    if (setting.apiKey !== undefined) {
      setSecretValue(secrets.audioModelApiKeys, modelId, setting.apiKey);
    }
  }

  return { settings, secrets };
}

function knownObjectPatch(
  record: Record<string, unknown>,
  key: string,
  label: string
): Record<string, unknown> | undefined {
  return key in record ? requireRecord(record[key], label) : undefined;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function asGlobalSettingsInput<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof Error) {
      throw new GlobalSettingsValidationError(error.message);
    }
    throw error;
  }
}

function normalizeGlobalSettingsConfig(config: unknown): DebruteGlobalSettingsConfig {
  if (!isRecord(config)) {
    throw new Error('Global settings config must be an object.');
  }
  if (!isRecord(config.models)) {
    throw new Error('Global settings config must contain models.');
  }
  return {
    workbench: normalizeWorkbenchSettings(config.workbench),
    chrome: normalizeWorkbenchChromeConfig(config.chrome),
    models: {
      image: normalizeImageModelsConfig(config.models.image),
      video: normalizeVideoModelsConfig(config.models.video),
      audio: normalizeAudioModelsConfig(config.models.audio)
    },
    adobeBridge: normalizeAdobeBridgeConfig(config.adobeBridge)
  };
}

function normalizeWorkbenchSettings(config: unknown): DebruteGlobalSettingsConfig['workbench'] {
  if (!isRecord(config) || (config.locale !== 'en' && config.locale !== 'zh-CN')) {
    throw new Error(WORKBENCH_LOCALE_ERROR_MESSAGE);
  }
  if (config.themePreference !== 'system' && config.themePreference !== 'dark' && config.themePreference !== 'light') {
    throw new Error(WORKBENCH_THEME_PREFERENCE_ERROR_MESSAGE);
  }
  if (!isDefaultFrontend(config.defaultFrontend)) {
    throw new Error(DEFAULT_FRONTEND_ERROR_MESSAGE);
  }
  return {
    locale: config.locale,
    themePreference: config.themePreference,
    defaultFrontend: config.defaultFrontend
  };
}

function isDefaultFrontend(value: unknown): value is DebruteDefaultFrontend {
  return value === 'electron' || value === 'browser' || value === 'runtime-only';
}

function normalizeAdobeBridgeConfig(config: unknown): DebruteGlobalSettingsConfig['adobeBridge'] {
  if (!isRecord(config) || typeof config.enabled !== 'boolean') {
    throw new Error('Adobe Bridge config must contain enabled.');
  }
  return { enabled: config.enabled };
}

function normalizeWorkbenchChromeConfig(config: unknown): DebruteGlobalSettingsConfig['chrome'] {
  if (!isRecord(config) || !Array.isArray(config.recentProjectRoots)) {
    throw new Error('Workbench chrome config must contain recentProjectRoots.');
  }
  const recentProjectRoots: string[] = [];
  for (const item of config.recentProjectRoots) {
    if (typeof item !== 'string') {
      throw new Error('Workbench chrome recentProjectRoots values must be strings.');
    }
    const trimmed = item.trim();
    if (trimmed && !recentProjectRoots.includes(trimmed)) {
      recentProjectRoots.push(trimmed);
    }
  }
  return { recentProjectRoots: recentProjectRoots.slice(0, 12) };
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

function upsertImageModelSetting(
  config: ImageModelsConfig,
  modelId: string,
  setting: NormalizedModelSettingInput
): ImageModelsConfig {
  const imageModels = config.imageModels.filter((model) => model.debruteModelId !== modelId);
  if (setting.baseUrlOverride !== null || setting.requestModelIdOverride !== null) {
    imageModels.push({
      debruteModelId: modelId,
      baseUrlOverride: setting.baseUrlOverride,
      requestModelIdOverride: setting.requestModelIdOverride
    });
  }
  return { imageModels: imageModels.sort(compareModelConfig) };
}

function upsertVideoModelSetting(
  config: VideoModelsConfig,
  modelId: string,
  setting: NormalizedModelSettingInput
): VideoModelsConfig {
  const videoModels = config.videoModels.filter((model) => model.debruteModelId !== modelId);
  if (setting.baseUrlOverride !== null || setting.requestModelIdOverride !== null) {
    videoModels.push({
      debruteModelId: modelId,
      baseUrlOverride: setting.baseUrlOverride,
      requestModelIdOverride: setting.requestModelIdOverride
    });
  }
  return { videoModels: videoModels.sort(compareModelConfig) };
}

function upsertAudioModelSetting(
  config: AudioModelsConfig,
  modelId: string,
  setting: NormalizedModelSettingInput
): AudioModelsConfig {
  const audioModels = config.audioModels.filter((model) => model.debruteModelId !== modelId);
  if (setting.baseUrlOverride !== null || setting.requestModelIdOverride !== null) {
    audioModels.push({
      debruteModelId: modelId,
      baseUrlOverride: setting.baseUrlOverride,
      requestModelIdOverride: setting.requestModelIdOverride
    });
  }
  return { audioModels: audioModels.sort(compareModelConfig) };
}

function compareModelConfig(left: { debruteModelId: string }, right: { debruteModelId: string }): number {
  return left.debruteModelId.localeCompare(right.debruteModelId);
}

function normalizeModelSettingInput(
  input: SaveImageModelSettingInput | SaveVideoModelSettingInput | SaveAudioModelSettingInput,
  label: 'Image model' | 'Video model' | 'Audio model'
): NormalizedModelSettingInput {
  if (!isRecord(input)) {
    throw new Error(`${label} setting must be an object.`);
  }
  if (input.apiKey !== undefined && typeof input.apiKey !== 'string') {
    throw new Error(`${label} apiKey must be a string when provided.`);
  }
  return {
    baseUrlOverride: normalizeMediaBaseUrlOverride(input.baseUrlOverride, label),
    requestModelIdOverride: normalizeMediaRequestModelIdOverride(input.requestModelIdOverride, label),
    ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {})
  };
}

function normalizeModelId(value: unknown, label: 'Image model' | 'Video model' | 'Audio model'): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} id must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} id must be a non-empty string.`);
  }
  return trimmed;
}

function setSecretValue(secrets: Record<string, string>, modelId: string, apiKey: string): void {
  const trimmedApiKey = apiKey.trim();
  if (trimmedApiKey) {
    secrets[modelId] = trimmedApiKey;
    return;
  }
  delete secrets[modelId];
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
    if (isNodeErrorCode(error, 'ENOENT')) {
      if (await canUseMissingFileDefault(path)) {
        return fallback;
      }
      throw globalSettingsPersistenceError(error);
    }
    throw error;
  }
}

async function canUseMissingFileDefault(path: string): Promise<boolean> {
  let current = path;
  while (true) {
    try {
      const entry = await lstat(current);
      if (current === path) {
        return false;
      }
      if (entry.isDirectory()) {
        return true;
      }
      if (!entry.isSymbolicLink()) {
        return false;
      }
      try {
        return (await stat(current)).isDirectory();
      } catch (error) {
        if (isNodeErrorCode(error, 'ENOENT')) {
          return false;
        }
        throw error;
      }
    } catch (error) {
      if (!isNodeErrorCode(error, 'ENOENT')) {
        throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      return true;
    }
    current = parent;
  }
}

function isNodeErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await persistGlobalSettings(async () => {
    await ensureConfigDirectory(dirname(path));
    const tempPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tempPath, path);
  });
}

async function writeSecretJsonAtomic(path: string, value: unknown): Promise<void> {
  await persistGlobalSettings(async () => {
    const directory = dirname(path);
    await ensureConfigDirectory(directory);
    const tempPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, path);
  });
}

async function ensureConfigDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function persistGlobalSettings(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    throw globalSettingsPersistenceError(error);
  }
}

function globalSettingsPersistenceError(error: unknown): Error {
  return new Error(error instanceof Error ? error.message : String(error), { cause: error });
}
