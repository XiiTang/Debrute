import type {
  ImageModelConfig,
  ImageModelsConfig,
  SecretsConfig,
  VideoModelConfig,
  VideoModelsConfig
} from '@axis/capability-runtime';
import type {
  SaveImageModelSettingInput,
  SaveVideoModelSettingInput
} from '@axis/app-protocol';
import type { GlobalConfigStore } from '../config/GlobalConfigStore.js';

type MediaModelConfig = ImageModelConfig | VideoModelConfig;
type MediaModelsConfig = ImageModelsConfig | VideoModelsConfig;
type MediaSaveInput = SaveImageModelSettingInput | SaveVideoModelSettingInput;
type MediaSecretKey = 'imageModelApiKeys' | 'videoModelApiKeys';

export interface MediaModelCatalogApi<Entry extends { axisModelId: string }> {
  get(modelId: string): Entry | undefined;
  listAll(): Entry[];
  listConfigured(modelIds: string[]): Entry[];
}

export async function saveMediaModelSetting(input: {
  configStore: GlobalConfigStore;
  modelKind: 'image' | 'video';
  modelId: string;
  value: MediaSaveInput;
  catalog: MediaModelCatalogApi<{ axisModelId: string }>;
  secretKey: MediaSecretKey;
  readConfig: () => Promise<MediaModelsConfig>;
  recordsFromConfig: (config: MediaModelsConfig) => MediaModelConfig[];
  configFromRecords: (records: MediaModelConfig[]) => MediaModelsConfig;
  saveConfig: (config: MediaModelsConfig) => Promise<void>;
}): Promise<void> {
  if (!input.catalog.get(input.modelId)) {
    throw new Error(`Unknown ${input.modelKind} model: ${input.modelId}`);
  }
  const config = await input.readConfig();
  const secrets = await input.configStore.readSecrets();
  const records = input.recordsFromConfig(config);
  const baseUrlOverride = input.value.baseUrlOverride?.trim() || null;
  const providerModelIdOverride = input.value.providerModelIdOverride?.trim() || null;
  const nextRecords = records.filter((model) => model.axisModelId !== input.modelId);
  if (baseUrlOverride || providerModelIdOverride) {
    nextRecords.push({
      axisModelId: input.modelId,
      baseUrlOverride,
      providerModelIdOverride
    });
  }
  await input.saveConfig(input.configFromRecords(nextRecords.sort((left, right) => left.axisModelId.localeCompare(right.axisModelId))));
  await input.configStore.saveSecrets(patchMediaSecret(secrets, input.modelId, input.value, input.secretKey));
}

export async function configuredMediaCatalog<Entry extends { axisModelId: string }>(input: {
  configStore: GlobalConfigStore;
  catalog: MediaModelCatalogApi<Entry>;
  secretKey: MediaSecretKey;
}): Promise<Entry[]> {
  const secrets = await input.configStore.readSecrets();
  const configured = new Set(input.catalog.listAll()
    .filter((model) => secrets[input.secretKey][model.axisModelId]?.trim())
    .map((model) => model.axisModelId));
  return input.catalog.listConfigured([...configured]);
}

function patchMediaSecret(secrets: SecretsConfig, modelId: string, input: MediaSaveInput, secretKey: MediaSecretKey): SecretsConfig {
  const next: SecretsConfig = {
    llmProviderApiKeys: { ...secrets.llmProviderApiKeys },
    imageModelApiKeys: { ...secrets.imageModelApiKeys },
    videoModelApiKeys: { ...secrets.videoModelApiKeys }
  };
  if (Object.prototype.hasOwnProperty.call(input, 'apiKey')) {
    const apiKey = input.apiKey?.trim() ?? '';
    if (apiKey) {
      next[secretKey][modelId] = apiKey;
    } else {
      delete next[secretKey][modelId];
    }
  }
  return next;
}
