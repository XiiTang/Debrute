import {
  createLlmProviderSettingsView,
  discoverProviderModels,
  type LlmProvidersConfig,
  type SecretsConfig
} from '@debrute/capability-runtime';
import type {
  DiscoverLlmProviderModelsInput,
  DiscoverProviderModelsOutput,
  LlmProviderSettingsView,
  SaveLlmProviderSettingInput
} from '@debrute/app-protocol';
import type { GlobalConfigStore } from '../config/GlobalConfigStore.js';

export class LlmService {
  constructor(private readonly input: { configStore: GlobalConfigStore }) {}

  async getSettings(): Promise<LlmProviderSettingsView> {
    return createLlmProviderSettingsView(
      await this.input.configStore.readLlmProviders(),
      await this.input.configStore.readSecrets()
    );
  }

  async saveProviderSetting(input: SaveLlmProviderSettingInput, providerId?: string): Promise<LlmProviderSettingsView> {
    const normalizedId = normalizeProviderId(providerId ?? input.id);
    if (!normalizedId) {
      throw new Error('Provider id is required');
    }
    assertValidHttpUrl(input.baseUrl, 'baseUrl');
    const providers = await this.input.configStore.readLlmProviders();
    const secrets = await this.input.configStore.readSecrets();
    const nextProviders: LlmProvidersConfig = {
      providers: [
        ...providers.providers.filter((provider) => provider.id !== normalizedId),
        {
          id: normalizedId,
          name: requireText(input.name, 'name'),
          providerType: input.providerType,
          baseUrl: requireText(input.baseUrl, 'baseUrl'),
          enabled: input.enabled === true,
          modelIds: input.modelIds.map((modelId) => modelId.trim()).filter(Boolean)
        }
      ].sort((left, right) => left.id.localeCompare(right.id)),
      defaultModelKey: providers.defaultModelKey
    };
    nextProviders.defaultModelKey = normalizeDefaultModelKey(nextProviders, nextProviders.defaultModelKey);
    await this.input.configStore.saveLlmProviders(nextProviders);
    await this.input.configStore.saveSecrets(patchProviderSecret(secrets, normalizedId, input));
    return this.getSettings();
  }

  async deleteProviderSetting(providerId: string): Promise<LlmProviderSettingsView> {
    const normalizedId = normalizeProviderId(providerId);
    const providers = await this.input.configStore.readLlmProviders();
    const secrets = await this.input.configStore.readSecrets();
    const nextProviders: LlmProvidersConfig = {
      providers: providers.providers.filter((provider) => provider.id !== normalizedId),
      defaultModelKey: providers.defaultModelKey
    };
    nextProviders.defaultModelKey = normalizeDefaultModelKey(nextProviders, nextProviders.defaultModelKey);
    await this.input.configStore.saveLlmProviders(nextProviders);
    await this.input.configStore.saveSecrets({
      llmProviderApiKeys: Object.fromEntries(Object.entries(secrets.llmProviderApiKeys).filter(([key]) => key !== normalizedId)),
      imageModelApiKeys: { ...secrets.imageModelApiKeys },
      videoModelApiKeys: { ...secrets.videoModelApiKeys }
    });
    return this.getSettings();
  }

  async setDefaultModelKey(modelKey: string | null): Promise<LlmProviderSettingsView> {
    const providers = await this.input.configStore.readLlmProviders();
    await this.input.configStore.saveLlmProviders({
      ...providers,
      defaultModelKey: normalizeDefaultModelKey(providers, modelKey)
    });
    return this.getSettings();
  }

  async discoverProviderModels(input: DiscoverLlmProviderModelsInput, providerId?: string): Promise<DiscoverProviderModelsOutput> {
    const normalizedId = normalizeProviderId(providerId ?? input.id ?? '');
    const baseUrl = requireText(input.baseUrl, 'baseUrl');
    assertValidHttpUrl(baseUrl, 'baseUrl');
    const secrets = await this.input.configStore.readSecrets();
    const apiKey = input.apiKey?.trim() || (normalizedId ? secrets.llmProviderApiKeys[normalizedId]?.trim() : undefined);
    return discoverProviderModels({
      providerType: input.providerType,
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      ...(input.modelsPath?.trim() ? { modelsPath: input.modelsPath.trim() } : {}),
      ...(typeof input.timeoutMs === 'number' ? { timeoutMs: input.timeoutMs } : {})
    });
  }
}

function normalizeDefaultModelKey(config: LlmProvidersConfig, modelKey: string | null | undefined): string | null {
  const normalized = modelKey?.trim() || null;
  if (!normalized) {
    return null;
  }
  const available = new Set(config.providers.flatMap((provider) =>
    provider.enabled ? provider.modelIds.map((modelId) => `${provider.id}:${modelId}`) : []
  ));
  return available.has(normalized) ? normalized : null;
}

function patchProviderSecret(secrets: SecretsConfig, providerId: string, input: SaveLlmProviderSettingInput): SecretsConfig {
  const next: SecretsConfig = {
    llmProviderApiKeys: { ...secrets.llmProviderApiKeys },
    imageModelApiKeys: { ...secrets.imageModelApiKeys },
    videoModelApiKeys: { ...secrets.videoModelApiKeys }
  };
  if (Object.prototype.hasOwnProperty.call(input, 'apiKey')) {
    const apiKey = input.apiKey?.trim() ?? '';
    if (apiKey) {
      next.llmProviderApiKeys[providerId] = apiKey;
    } else {
      delete next.llmProviderApiKeys[providerId];
    }
  }
  return next;
}

function normalizeProviderId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function requireText(value: string, field: string): string {
  const text = value.trim();
  if (!text) {
    throw new Error(`${field} is required`);
  }
  return text;
}

function assertValidHttpUrl(value: string, field: string): void {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${field} must be a valid HTTP or HTTPS URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${field} must be a valid HTTP or HTTPS URL`);
  }
}
