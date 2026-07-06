import { randomUUID } from 'node:crypto';
import type { SecretsConfig, AudioModelsConfig } from '../config.js';
import {
  fetchPublicHttpUrl,
  type PublicRemoteHostLookup,
  type PublicRemoteHttpTransport
} from '../remoteFetchPolicy.js';
import { createRequestTimeoutSignal } from '../requestTimeout.js';
import { redactRuntimeSecrets, redactRuntimeSecretString } from '../modelRunMetadataRedaction.js';
import { selectModelApiKey } from '../modelApiKeySelection.js';
import { createAudioModelCatalog, type AudioModelCatalogEntry, type AudioModelKind } from './catalog.js';
import {
  writeAudioArtifactSources,
  type AudioArtifactSource
} from './artifacts.js';
import {
  AudioArgumentError,
  normalizeAudioModelArguments
} from './normalizer.js';
import {
  executeDashScopeTtsModel
} from './adapters/dashscopeTts.js';
import {
  executeElevenLabsMusicModel,
  executeElevenLabsSoundEffectsModel,
  executeElevenLabsTtsModel
} from './adapters/elevenlabsAudio.js';
import { executeFalAudioModel } from './adapters/falAudio.js';
import {
  executeGeminiTtsModel,
  executeGoogleLyriaModel
} from './adapters/geminiAudio.js';
import {
  executeMiniMaxMusicModel,
  executeMiniMaxTtsModel
} from './adapters/minimaxAudio.js';
import { executeOpenAiTtsModel } from './adapters/openaiTts.js';
import { executeVolcengineTtsModel } from './adapters/volcengineTts.js';
import type {
  AudioModelAdapter,
  AudioModelAdapterInput,
  AudioModelAdapterResult,
  AudioModelFetch
} from './adapters/types.js';
import {
  AudioTaskFailedError as AudioTaskFailed,
  AudioTaskTimeoutError as AudioTaskTimeout
} from './adapters/types.js';

export type { AudioModelFetch } from './adapters/types.js';

export interface AudioModelRequestInput {
  model: string;
  arguments: Record<string, unknown>;
  timeoutMs?: number;
}

export interface AudioTaskPollingOptions {
  intervalMs?: number;
  maxAttempts?: number;
}

export interface AudioModelRequestArtifact {
  artifactId: string;
  title: string;
  projectRelativePath: string;
  mimeType: string;
}

export interface ExecuteAudioModelRequestInput {
  projectRoot: string;
  invocationId: string;
  requestedKind: AudioModelKind;
  input: AudioModelRequestInput;
  settings: AudioModelsConfig;
  secrets: Pick<SecretsConfig, 'audioModelApiKeys'>;
  taskPolling?: AudioTaskPollingOptions;
  fetch?: AudioModelFetch;
  recordGeneratedAsset?: AudioGeneratedAssetRecorder;
  remoteUrlLookup?: PublicRemoteHostLookup;
  remoteHttpTransport?: PublicRemoteHttpTransport;
  signal?: AbortSignal;
}

export interface AudioGeneratedAssetRecorderInput {
  modelRunId: string;
  projectRelativePath: string;
  artifactRole: 'tts-audio' | 'music-audio' | 'sound-effect-audio';
  artifactIndex: number;
  modelRun: {
    request: unknown;
    output: unknown;
  };
}

export type AudioGeneratedAssetRecorder = (input: AudioGeneratedAssetRecorderInput) => Promise<void>;

export type ExecuteAudioModelRequestResult =
  | { status: 'ok'; content: string; artifacts: AudioModelRequestArtifact[]; logs: Array<Record<string, unknown>> }
  | {
      status: 'error';
      content: string;
      error:
        | 'audio_model_unavailable'
        | 'audio_model_not_configured'
        | 'audio_model_kind_mismatch'
        | 'audio_argument_invalid'
        | 'audio_task_failed'
        | 'audio_task_timeout'
        | 'audio_artifact_download_failed'
        | 'audio_request_failed';
      logs: Array<Record<string, unknown>>;
      details?: Record<string, unknown>;
    };

const DEFAULT_AUDIO_REQUEST_TIMEOUT_MS = 600_000;
const DEFAULT_AUDIO_TASK_POLL_INTERVAL_MS = 1_000;
const DEFAULT_AUDIO_TASK_POLL_MAX_ATTEMPTS = 600;

const AUDIO_MODEL_ADAPTERS: Record<string, AudioModelAdapter> = {
  'openai-gpt-4o-mini-tts': executeOpenAiTtsModel,
  'openai-tts-1': executeOpenAiTtsModel,
  'openai-tts-1-hd': executeOpenAiTtsModel,
  'elevenlabs-v3-tts': executeElevenLabsTtsModel,
  'elevenlabs-multilingual-v2': executeElevenLabsTtsModel,
  'gemini-tts': executeGeminiTtsModel,
  'minimax-speech-2-8-hd': executeMiniMaxTtsModel,
  'dashscope-qwen3-tts-flash': executeDashScopeTtsModel,
  'doubao-seed-tts-2-0': executeVolcengineTtsModel,
  'elevenlabs-music': executeElevenLabsMusicModel,
  'google-lyria-3-clip-preview': executeGoogleLyriaModel,
  'google-lyria-3-pro-preview': executeGoogleLyriaModel,
  'minimax-music-2-6': executeMiniMaxMusicModel,
  'fal-stable-audio-text-to-audio': executeFalAudioModel,
  'elevenlabs-sound-effects': executeElevenLabsSoundEffectsModel,
  'fal-stable-audio-sfx': executeFalAudioModel
};

export async function executeAudioModelRequest(input: ExecuteAudioModelRequestInput): Promise<ExecuteAudioModelRequestResult> {
  const logs: Array<Record<string, unknown>> = [];
  const catalog = createAudioModelCatalog();
  const entry = catalog.get(input.input.model);
  if (!entry) {
    return {
      status: 'error',
      content: `Audio model is unavailable: ${input.input.model}`,
      error: 'audio_model_unavailable',
      logs
    };
  }
  if (entry.kind !== input.requestedKind) {
    return {
      status: 'error',
      content: `Audio model kind mismatch: ${input.input.model} is ${entry.kind}, not ${input.requestedKind}`,
      error: 'audio_model_kind_mismatch',
      logs,
      details: { model: input.input.model, expected_kind: input.requestedKind, actual_kind: entry.kind }
    };
  }
  const selectedApiKey = selectModelApiKey({
    kind: 'audio',
    modelId: input.input.model,
    entries: input.secrets.audioModelApiKeys[input.input.model]
  });
  const apiKey = selectedApiKey?.key ?? '';
  if (!apiKey) {
    return {
      status: 'error',
      content: `Audio model API key is missing: ${input.input.model}`,
      error: 'audio_model_not_configured',
      logs
    };
  }

  let args: Record<string, unknown>;
  try {
    args = normalizeAudioModelArguments(entry.kind, input.input.arguments);
    validateAudioModelArguments(entry, args);
  } catch (error) {
    return {
      status: 'error',
      content: errorMessage(error),
      error: error instanceof AudioArgumentError ? error.code : 'audio_argument_invalid',
      logs
    };
  }

  const adapter = AUDIO_MODEL_ADAPTERS[entry.debruteModelId];
  if (!adapter) {
    return {
      status: 'error',
      content: `Audio model adapter is unavailable: ${entry.debruteModelId}`,
      error: 'audio_model_unavailable',
      logs
    };
  }

  const modelSettings = input.settings.audioModels.find((model) => model.debruteModelId === input.input.model);
  const baseUrl = modelSettings?.baseUrlOverride ?? entry.defaultBaseUrl;
  const requestModelId = modelSettings?.requestModelIdOverride ?? entry.defaultRequestModelId;
  const modelRunId = randomUUID();
  const requestTimeoutMs = input.input.timeoutMs ?? DEFAULT_AUDIO_REQUEST_TIMEOUT_MS;
  const operationTimeout = createRequestTimeoutSignal(input.signal, requestTimeoutMs, `Audio model request timed out after ${requestTimeoutMs}ms.`);
  try {
    const adapterInput: AudioModelAdapterInput = {
      entry,
      baseUrl,
      requestModelId,
      args,
      apiKey,
      fetch: input.fetch ?? fetch,
      taskPolling: createAudioTaskPollingRuntime(input.taskPolling, operationTimeout.signal),
      signal: operationTimeout.signal
    };
    const adapterResult = await adapter(adapterInput);
    const redactedRequest = redactModelRunValue(apiKey, adapterResult.request);
    const redactedResponses = redactModelRunValue(apiKey, adapterResult.responses);
    logs.push({
      model: entry.debruteModelId,
      kind: entry.kind,
      request: redactedRequest,
      responses: redactedResponses
    });
    const artifacts = await writeAudioArtifactSources({
      projectRoot: input.projectRoot,
      invocationId: input.invocationId,
      kind: entry.kind,
      args,
      sources: adapterResult.sources,
      fetchRemote: async (url) => downloadArtifact(input, url, operationTimeout.signal),
      modelRunId,
      modelRun: {
        request: redactedRequest,
        output: { responses: redactedResponses }
      },
      ...(input.recordGeneratedAsset ? { recordGeneratedAsset: input.recordGeneratedAsset } : {}),
      signal: operationTimeout.signal
    });
    return {
      status: 'ok',
      content: `Generated ${artifacts.length} audio artifact${artifacts.length === 1 ? '' : 's'}.`,
      artifacts,
      logs
    };
  } catch (error) {
    const message = redactModelRunMessage(apiKey, errorMessage(error));
    return {
      status: 'error',
      content: message,
      error: audioErrorCode(error),
      logs
    };
  } finally {
    operationTimeout.dispose();
  }
}

function validateAudioModelArguments(entry: AudioModelCatalogEntry, args: Record<string, unknown>): void {
  validateDeclaredAudioArguments(entry, args);
  validateRequiredAudioArguments(entry, args);
  const format = args.format;
  if (format === undefined) {
    return;
  }
  const supportedFormats = stringArrayCapability(entry.capabilities.formats);
  if (typeof format === 'string' && supportedFormats.includes(format)) {
    return;
  }
  throw new AudioArgumentError(
    `Audio model ${entry.debruteModelId} format must be one of: ${supportedFormats.join(', ')}.`
  );
}

function validateDeclaredAudioArguments(entry: AudioModelCatalogEntry, args: Record<string, unknown>): void {
  const properties = objectRecord(entry.argumentsSchema.properties);
  if (!properties) {
    throw new AudioArgumentError(`Audio model ${entry.debruteModelId} arguments schema is invalid.`);
  }
  for (const key of Object.keys(args)) {
    if (!(key in properties)) {
      throw new AudioArgumentError(`Unsupported audio argument for ${entry.debruteModelId}: ${key}.`);
    }
  }
}

function validateRequiredAudioArguments(entry: AudioModelCatalogEntry, args: Record<string, unknown>): void {
  const required = stringArrayCapability(entry.argumentsSchema.required);
  for (const key of required) {
    const value = args[key];
    if (value === undefined || (typeof value === 'string' && !value.trim())) {
      throw new AudioArgumentError(requiredAudioArgumentMessage(entry, key));
    }
  }
}

function requiredAudioArgumentMessage(entry: AudioModelCatalogEntry, key: string): string {
  if (key === 'voice_id' && entry.debruteModelId.startsWith('elevenlabs-')) {
    return 'ElevenLabs TTS audio arguments require string field "voice_id".';
  }
  return `Audio model ${entry.debruteModelId} requires argument: ${key}.`;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringArrayCapability(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

async function downloadArtifact(
  input: ExecuteAudioModelRequestInput,
  url: string,
  signal: AbortSignal
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  let response: Response;
  try {
    response = await fetchPublicHttpUrl(url, 'Audio artifact URL', {
      signal
    }, {
      ...(input.remoteUrlLookup ? { lookup: input.remoteUrlLookup } : {}),
      ...(input.remoteHttpTransport ? { transport: input.remoteHttpTransport } : {})
    });
  } catch (error) {
    throw new AudioArtifactDownloadError(errorMessage(error));
  }
  if (!response.ok) {
    throw new AudioArtifactDownloadError(`Audio artifact download failed: ${response.status}`);
  }
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    mimeType: response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream'
  };
}

function audioErrorCode(error: unknown): Extract<ExecuteAudioModelRequestResult, { status: 'error' }>['error'] {
  if (error instanceof AudioArtifactDownloadError) {
    return 'audio_artifact_download_failed';
  }
  if (error instanceof AudioTaskFailed) {
    return 'audio_task_failed';
  }
  if (error instanceof AudioTaskTimeout) {
    return 'audio_task_timeout';
  }
  return 'audio_request_failed';
}

class AudioArtifactDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioArtifactDownloadError';
  }
}

function redactModelRunValue(apiKey: string, value: unknown): unknown {
  return redactRuntimeSecrets(value, { secrets: [apiKey] });
}

function redactModelRunMessage(apiKey: string, value: string): string {
  return redactRuntimeSecretString(value, { secrets: [apiKey] });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createAudioTaskPollingRuntime(options: AudioTaskPollingOptions | undefined, signal: AbortSignal) {
  return {
    intervalMs: options?.intervalMs ?? DEFAULT_AUDIO_TASK_POLL_INTERVAL_MS,
    maxAttempts: options?.maxAttempts ?? DEFAULT_AUDIO_TASK_POLL_MAX_ATTEMPTS,
    sleep: (ms: number) => sleepWithSignal(ms, signal)
  };
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timeout = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

export const audioModelAdaptersForTest: Record<string, AudioModelAdapter> = AUDIO_MODEL_ADAPTERS;
export type { AudioArtifactSource, AudioModelCatalogEntry, AudioModelKind, AudioModelAdapterResult };
