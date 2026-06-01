import type { DiscoverProviderModelsOutput, LlmProviderType } from '../config.js';
import type { ProviderFetch } from '../providers.js';

export interface ProviderModelDiscoveryInput {
  providerType: LlmProviderType;
  baseUrl: string;
  apiKey?: string;
  modelsPath?: string;
  fetch?: ProviderFetch;
  timeoutMs?: number;
}

export async function discoverProviderModels(input: ProviderModelDiscoveryInput): Promise<DiscoverProviderModelsOutput> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (input.providerType === 'anthropic') {
    return {
      endpoint: `${baseUrl}/<manual-model-entry>`,
      models: [],
      modelsCount: 0,
      supportsDiscovery: false
    };
  }

  const endpoint = resolveModelsEndpoint(baseUrl, input.modelsPath);
  const fetchImpl = input.fetch ?? fetch;
  const headers: Record<string, string> = { accept: 'application/json' };
  const apiKey = input.apiKey?.trim();
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  const response = await callWithTimeout(fetchImpl, input.timeoutMs ?? 20_000, endpoint, {
    method: 'GET',
    headers
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Model discovery failed with status ${response.status}`);
  }
  const payload = parseJsonPayload(text);
  const models = parseDiscoveredModelIds(payload);
  return {
    endpoint,
    models,
    modelsCount: models.length,
    supportsDiscovery: true
  };
}

export function parseDiscoveredModelIds(payload: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of modelItemsFromPayload(payload)) {
    const id = modelIdFromItem(item);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

function modelItemsFromPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.data)) {
      return record.data;
    }
    if (Array.isArray(record.models)) {
      return record.models;
    }
  }
  throw new Error('Model discovery response must be an array or an object with data/models array.');
}

function modelIdFromItem(item: unknown): string | null {
  if (typeof item === 'string') {
    return item.trim() || null;
  }
  if (!item || typeof item !== 'object') {
    return null;
  }
  const raw = (item as Record<string, unknown>).id ?? (item as Record<string, unknown>).name;
  return typeof raw === 'string' ? raw.trim() || null : null;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('baseUrl must be a valid HTTP or HTTPS URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('baseUrl must be a valid HTTP or HTTPS URL');
  }
  return trimmed;
}

function resolveModelsEndpoint(baseUrl: string, modelsPath?: string): string {
  const path = modelsPath?.trim();
  if (!path) {
    return `${baseUrl}/models`;
  }
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

function parseJsonPayload(text: string): unknown {
  if (!text.trim()) {
    throw new Error('Model discovery response must be JSON.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Model discovery response must be JSON.');
  }
}

async function callWithTimeout(fetchImpl: ProviderFetch, timeoutMs: number, url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
