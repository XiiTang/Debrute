import type { LlmProviderConfig, LlmProviderType, LlmProvidersConfig, ProviderModelSpec, SecretsConfig } from './config.js';

export type ProviderFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type ProviderResponse =
  | { type: 'message'; modelKey: string; text: string }
  | { type: 'error'; modelKey: string; message: string; retryable: boolean };

export interface ProviderRequest {
  modelKey: string;
  systemPrompt: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  signal?: AbortSignal;
}

export interface ChatProvider {
  id: string;
  providerType: LlmProviderType;
  modelKeys: string[];
  send(request: ProviderRequest): Promise<ProviderResponse>;
}

export interface OpenAICompatibleProviderInput {
  id: string;
  baseUrl: string;
  apiKey: string;
  modelIds: string[];
  fetch?: ProviderFetch;
}

export interface AnthropicProviderInput extends OpenAICompatibleProviderInput {}

export interface ResolvedProvider {
  spec: ProviderModelSpec;
  provider: LlmProviderConfig & { apiKey: string };
  chatProvider: ChatProvider;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ChatProvider>();
  private readonly providerRecords = new Map<string, LlmProviderConfig & { apiKey: string }>();
  private readonly models = new Map<string, ProviderModelSpec>();

  constructor(providers: LlmProvidersConfig, secrets?: SecretsConfig) {
    for (const provider of providers.providers) {
      const apiKey = secrets?.llmProviderApiKeys[provider.id]?.trim() ?? '';
      if (!provider.enabled || !apiKey) {
        continue;
      }
      const chatProvider = chatProviderFromConfig({ ...provider, apiKey });
      this.addChatProvider(chatProvider, { ...provider, apiKey });
    }
  }

  private addChatProvider(provider: ChatProvider, record: LlmProviderConfig & { apiKey: string }): void {
    this.providers.set(provider.id, provider);
    this.providerRecords.set(record.id, record);
    for (const modelKey of provider.modelKeys) {
      const providerId = providerIdForModelKey(modelKey);
      const modelId = modelIdForModelKey(modelKey);
      this.models.set(modelKey, {
        modelKey,
        providerId,
        providerType: record.providerType,
        modelId,
        displayName: `${record.name} ${modelId}`
      });
    }
  }

  providerForModel(modelKey: string): ChatProvider | undefined {
    const providerId = providerIdForModelKey(modelKey);
    return this.providers.get(providerId);
  }

  apiKeysForModel(modelKey: string): string[] {
    const providerId = providerIdForModelKey(modelKey);
    const apiKey = this.providerRecords.get(providerId)?.apiKey.trim();
    return apiKey ? [apiKey] : [];
  }

  resolve(modelKey: string): ResolvedProvider {
    const spec = this.models.get(modelKey);
    if (!spec) {
      throw new Error(`Unknown model_key: ${modelKey}`);
    }
    const provider = this.providerRecords.get(spec.providerId);
    const chatProvider = this.providers.get(spec.providerId);
    if (!provider || !chatProvider) {
      throw new Error(`Unknown providerId: ${spec.providerId}`);
    }
    return { spec, provider, chatProvider };
  }

  listModels(): ProviderModelSpec[] {
    return [...this.models.values()];
  }

  listProviders(): Array<LlmProviderConfig & { apiKey: string }> {
    return [...this.providerRecords.values()];
  }
}

function chatProviderFromConfig(provider: LlmProviderConfig & { apiKey: string }): ChatProvider {
  if (provider.providerType === 'openai_compat') {
    return createOpenAICompatibleProvider({ id: provider.id, baseUrl: provider.baseUrl, apiKey: provider.apiKey, modelIds: provider.modelIds });
  }
  if (provider.providerType === 'anthropic') {
    return createAnthropicProvider({ id: provider.id, baseUrl: provider.baseUrl, apiKey: provider.apiKey, modelIds: provider.modelIds });
  }
  throw new Error('LLM provider providerType must be "openai_compat" or "anthropic".');
}

export function createOpenAICompatibleProvider(input: OpenAICompatibleProviderInput): ChatProvider {
  const fetchImpl = input.fetch ?? fetch;
  return {
    id: input.id,
    providerType: 'openai_compat',
    modelKeys: input.modelIds.map((modelId) => `${input.id}:${modelId}`),
    async send(request) {
      const modelId = modelIdForModelKey(request.modelKey);
      const body = {
        model: modelId,
        messages: [
          { role: 'system', content: request.systemPrompt },
          ...request.messages.map((message) => openAIMessage(message))
        ]
      };
      const response = await fetchImpl(`${input.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body),
        ...(request.signal ? { signal: request.signal } : {})
      });
      if (!response.ok) {
        return { type: 'error', modelKey: request.modelKey, message: `Provider request failed with ${response.status}`, retryable: response.status >= 500 };
      }
      const json = await response.json();
      return parseOpenAIResponse(request.modelKey, json);
    }
  };
}

export function createAnthropicProvider(input: AnthropicProviderInput): ChatProvider {
  const fetchImpl = input.fetch ?? fetch;
  return {
    id: input.id,
    providerType: 'anthropic',
    modelKeys: input.modelIds.map((modelId) => `${input.id}:${modelId}`),
    async send(request) {
      const systemPrompt = [
        request.systemPrompt,
        ...request.messages.filter((message) => message.role === 'system').map((message) => message.content)
      ].filter((content) => content.trim().length > 0).join('\n\n');
      const response = await fetchImpl(`${input.baseUrl.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': input.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        ...(request.signal ? { signal: request.signal } : {}),
        body: JSON.stringify({
          model: modelIdForModelKey(request.modelKey),
          max_tokens: 4096,
          system: systemPrompt,
          messages: request.messages.filter((message) => message.role !== 'system').map((message) => anthropicMessage(message))
        })
      });
      if (!response.ok) {
        return { type: 'error', modelKey: request.modelKey, message: `Provider request failed with ${response.status}`, retryable: response.status >= 500 };
      }
      const json = await response.json();
      return parseAnthropicResponse(request.modelKey, json);
    }
  };
}

function providerIdForModelKey(modelKey: string): string {
  return modelKey.includes(':') ? modelKey.slice(0, modelKey.indexOf(':')) : modelKey;
}

function modelIdForModelKey(modelKey: string): string {
  return modelKey.includes(':') ? modelKey.slice(modelKey.indexOf(':') + 1) : modelKey;
}

function openAIMessage(message: ProviderRequest['messages'][number]): Record<string, unknown> {
  return { role: message.role, content: message.content };
}

function parseOpenAIResponse(modelKey: string, json: unknown): ProviderResponse {
  const message = firstChoiceMessage(json);
  if (!message || typeof message.content !== 'string') {
    return providerParseError(modelKey, 'OpenAI-compatible');
  }
  const text = message.content;
  return { type: 'message', modelKey, text };
}

function firstChoiceMessage(json: unknown): { content?: unknown } | undefined {
  if (!isRecord(json) || !Array.isArray(json.choices)) {
    return undefined;
  }
  const choice = json.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    return undefined;
  }
  return choice.message;
}

function parseAnthropicResponse(modelKey: string, json: unknown): ProviderResponse {
  if (!isRecord(json) || !Array.isArray(json.content)) {
    return providerParseError(modelKey, 'Anthropic');
  }
  const text: string[] = [];
  for (const block of json.content) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      text.push(block.text);
    }
  }
  if (text.length === 0) {
    return providerParseError(modelKey, 'Anthropic');
  }
  return { type: 'message', modelKey, text: text.join('\n') };
}

function anthropicMessage(message: ProviderRequest['messages'][number]): Record<string, unknown> {
  return {
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: message.content
  };
}

function providerParseError(modelKey: string, providerLabel: string): ProviderResponse {
  return {
    type: 'error',
    modelKey,
    message: `${providerLabel} provider response did not include text content.`,
    retryable: false
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
