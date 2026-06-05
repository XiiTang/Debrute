import type {
  ImageModelConfig,
  ImageModelsConfig,
  SecretsConfig,
  VideoModelConfig,
  VideoModelsConfig
} from '@debrute/capability-runtime';
import type {
  SaveImageModelSettingInput,
  SaveVideoModelSettingInput
} from '@debrute/app-protocol';
import type { GlobalConfigStore } from '../config/GlobalConfigStore.js';

type MediaModelConfig = ImageModelConfig | VideoModelConfig;
type MediaModelsConfig = ImageModelsConfig | VideoModelsConfig;
type MediaSaveInput = SaveImageModelSettingInput | SaveVideoModelSettingInput;
type MediaSecretKey = 'imageModelApiKeys' | 'videoModelApiKeys';

export interface MediaModelCatalogApi<Entry extends { debruteModelId: string }> {
  get(modelId: string): Entry | undefined;
}

export async function saveMediaModelSetting(input: {
  configStore: GlobalConfigStore;
  modelKind: 'image' | 'video';
  modelId: string;
  value: MediaSaveInput;
  catalog: MediaModelCatalogApi<{ debruteModelId: string }>;
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
  const requestModelIdOverride = input.value.requestModelIdOverride?.trim() || null;
  const nextRecords = records.filter((model) => model.debruteModelId !== input.modelId);
  if (baseUrlOverride || requestModelIdOverride) {
    nextRecords.push({
      debruteModelId: input.modelId,
      baseUrlOverride,
      requestModelIdOverride
    });
  }
  await input.saveConfig(input.configFromRecords(nextRecords.sort((left, right) => left.debruteModelId.localeCompare(right.debruteModelId))));
  await input.configStore.saveSecrets(patchMediaSecret(secrets, input.modelId, input.value, input.secretKey));
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
