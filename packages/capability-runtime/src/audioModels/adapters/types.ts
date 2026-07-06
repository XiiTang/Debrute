import type { AudioModelCatalogEntry } from '../catalog.js';
import type { AudioArtifactSource } from '../artifacts.js';

export type AudioModelFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface AudioModelAdapterInput {
  entry: AudioModelCatalogEntry;
  baseUrl: string;
  requestModelId: string;
  args: Record<string, unknown>;
  apiKey: string;
  fetch: AudioModelFetch;
  taskPolling: AudioModelTaskPollingRuntime;
  signal?: AbortSignal;
}

export interface AudioModelTaskPollingRuntime {
  intervalMs: number;
  maxAttempts: number;
  sleep: (ms: number) => Promise<void>;
}

export interface AudioModelAdapterResult {
  sources: AudioArtifactSource[];
  request: unknown;
  responses: Array<{
    status: number;
    headers: Record<string, string>;
    body: unknown;
  }>;
}

export type AudioModelAdapter = (input: AudioModelAdapterInput) => Promise<AudioModelAdapterResult>;

export async function requestJson(
  input: AudioModelAdapterInput,
  url: string,
  init: RequestInit
): Promise<{ response: Response; body: unknown }> {
  const response = await input.fetch(url, { ...init, ...(input.signal ? { signal: input.signal } : {}) });
  const text = await response.text();
  const body = text ? JSON.parse(text) as unknown : {};
  return { response, body };
}

export async function requestBytes(
  input: AudioModelAdapterInput,
  url: string,
  init: RequestInit
): Promise<{ response: Response; bytes: Uint8Array }> {
  const response = await input.fetch(url, { ...init, ...(input.signal ? { signal: input.signal } : {}) });
  return { response, bytes: new Uint8Array(await response.arrayBuffer()) };
}

export async function requestText(
  input: AudioModelAdapterInput,
  url: string,
  init: RequestInit
): Promise<{ response: Response; text: string }> {
  const response = await input.fetch(url, { ...init, ...(input.signal ? { signal: input.signal } : {}) });
  return { response, text: await response.text() };
}

export function responseLog(response: Response, body: unknown): AudioModelAdapterResult['responses'][number] {
  return {
    status: response.status,
    headers: responseHeaders(response.headers),
    body
  };
}

export function responseHeaders(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  headers.forEach((value, key) => {
    output[key] = value;
  });
  return output;
}

export function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function booleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function assertOkResponse(response: Response, body: unknown, label: string): void {
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status} ${JSON.stringify(body)}`);
  }
}

export function requiredObjectField(
  record: Record<string, unknown>,
  key: string,
  label: string
): Record<string, unknown> {
  return jsonObject(record[key], `${label}.${key}`);
}

export function optionalObjectField(
  record: Record<string, unknown>,
  key: string,
  label: string
): Record<string, unknown> | undefined {
  const value = record[key];
  return value === undefined ? undefined : jsonObject(value, `${label}.${key}`);
}

export function requiredStringField(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value) {
    throw new Error(`${label}.${key} must be a non-empty string.`);
  }
  return value;
}

export function optionalStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value ? value : undefined;
}

export class AudioTaskFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioTaskFailedError';
  }
}

export class AudioTaskTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioTaskTimeoutError';
  }
}
