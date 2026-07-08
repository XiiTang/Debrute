import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import {
  projectImageExtensionForMimeType,
  projectImageMimeTypeFromPath,
  writeProjectFile
} from '@debrute/project-core';
import type { SecretsConfig, VideoModelsConfig } from '../config.js';
import {
  createRequestTimeoutSignal,
  fetchWithRequestTimeout,
  readResponseArrayBufferWithTimeout as readResponseArrayBufferBodyWithTimeout,
  readResponseTextWithTimeout as readResponseTextBodyWithTimeout
} from '../requestTimeout.js';
import { redactRuntimeSecrets } from '../modelRunMetadataRedaction.js';
import {
  fetchPublicHttpUrl,
  resolveHttpRedirectUrl,
  type PublicRemoteHostLookup,
  type PublicRemoteHttpTransport
} from '../remoteFetchPolicy.js';
import { createVideoModelCatalog, type VideoModelCatalogEntry } from './catalog.js';
import {
  normalizeSeedanceVideoArguments,
  stripVideoOutputArgs,
  VideoArgumentError,
  type VideoReferenceUploadService
} from './normalizer.js';

export type VideoModelFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface VideoModelRequestInput {
  model: string;
  arguments: Record<string, unknown>;
  timeoutMs?: number;
}

export interface VideoModelRequestArtifact {
  artifactId: string;
  title: string;
  projectRelativePath: string;
  mimeType: string;
  width?: number;
  height?: number;
}

export interface ExecuteVideoModelRequestInput {
  projectRoot: string;
  invocationId: string;
  input: VideoModelRequestInput;
  settings: VideoModelsConfig;
  secrets: Pick<SecretsConfig, 'videoModelApiKeys'>;
  fetch?: VideoModelFetch;
  recordGeneratedAsset?: VideoGeneratedAssetRecorder;
  uploadVideoReference?: VideoReferenceUploadService;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  pollMaxAttempts?: number;
  remoteUrlLookup?: PublicRemoteHostLookup;
  remoteHttpTransport?: PublicRemoteHttpTransport;
  signal?: AbortSignal;
}

export interface VideoGeneratedAssetRecorderInput {
  modelRunId: string;
  projectRelativePath: string;
  artifactRole: 'primary-video' | 'last-frame';
  artifactIndex: number;
  modelRun: {
    request: unknown;
    output: unknown;
  };
}

export type VideoGeneratedAssetRecorder = (input: VideoGeneratedAssetRecorderInput) => Promise<void>;

type ModelEndpointResponse = {
  status?: number;
  body: unknown;
};

export type ExecuteVideoModelRequestResult =
  | { status: 'ok'; content: string; artifacts: VideoModelRequestArtifact[]; logs: Array<Record<string, unknown>> }
  | {
      status: 'error';
      content: string;
      error:
        | 'video_argument_invalid'
        | 'model_unavailable'
        | 'video_model_not_configured'
        | 'video_reference_missing'
        | 'video_reference_type_unsupported'
        | 'video_reference_count_invalid'
        | 'video_reference_upload_unavailable'
        | 'video_request_failed';
      logs: Array<Record<string, unknown>>;
    };

interface RequestState {
  projectRoot: string;
  invocationId: string;
  modelRunId: string;
  entry: VideoModelCatalogEntry;
  baseUrl: string;
  apiKey: string;
  requestModelId: string;
  args: Record<string, unknown>;
  redactedDebruteArgs: Record<string, unknown>;
  fetch: VideoModelFetch;
  recordGeneratedAsset?: VideoGeneratedAssetRecorder;
  modelRun: ModelRunLog;
  logs: Array<Record<string, unknown>>;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  pollMaxAttempts: number;
  remoteUrlLookup?: PublicRemoteHostLookup;
  remoteHttpTransport?: PublicRemoteHttpTransport;
  signal?: AbortSignal;
}

interface ModelRunLog {
  request?: unknown;
  responses: ModelResponseLog[];
}

interface ModelResponseLog {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

interface VideoArtifactInput {
  url: string;
  artifactIndex: number;
  artifactRole: VideoGeneratedAssetRecorderInput['artifactRole'];
}

interface DownloadedVideoArtifact extends VideoArtifactInput {
  artifactId: string;
  bytes: Uint8Array;
  mimeType: string;
}

type VideoRequestError = Extract<ExecuteVideoModelRequestResult, { status: 'error' }>;
type JsonResponseResult = { ok: true; payload: Record<string, unknown>; endpointResponse: ModelEndpointResponse } | { ok: false; result: VideoRequestError };
type VideoTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'expired' | 'canceled';

const DEFAULT_POLL_ATTEMPTS = 180;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_VIDEO_REQUEST_TIMEOUT_MS = 600_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

export async function executeVideoModelRequest(input: ExecuteVideoModelRequestInput): Promise<ExecuteVideoModelRequestResult> {
  const logs: Array<Record<string, unknown>> = [];
  const catalog = createVideoModelCatalog();
  const entry = catalog.get(input.input.model);
  if (!entry) {
    return {
      status: 'error',
      content: `Video model is unavailable: ${input.input.model}`,
      error: 'model_unavailable',
      logs
    };
  }
  const apiKey = input.secrets.videoModelApiKeys[input.input.model]?.trim() ?? '';
  if (!apiKey) {
    return {
      status: 'error',
      content: `Video model API key is missing: ${input.input.model}`,
      error: 'video_model_not_configured',
      logs
    };
  }

  const modelSettings = input.settings.videoModels.find((model) => model.debruteModelId === input.input.model);
  let normalized: Awaited<ReturnType<typeof normalizeSeedanceVideoArguments>>;
  try {
    normalized = await normalizeSeedanceVideoArguments({
      projectRoot: input.projectRoot,
      catalogEntry: entry,
      args: input.input.arguments,
      ...(input.uploadVideoReference ? { uploadVideoReference: input.uploadVideoReference } : {}),
      ...(input.remoteUrlLookup ? { remoteUrlLookup: input.remoteUrlLookup } : {})
    });
  } catch (error) {
    if (error instanceof VideoArgumentError) {
      return {
        status: 'error',
        content: error.message,
        error: error.code,
        logs
      };
    }
    return {
      status: 'error',
      content: errorMessage(error),
      error: 'video_argument_invalid',
      logs
    };
  }

  const requestTimeoutMs = input.requestTimeoutMs ?? input.input.timeoutMs ?? DEFAULT_VIDEO_REQUEST_TIMEOUT_MS;
  const operationTimeout = createRequestTimeoutSignal(
    input.signal,
    requestTimeoutMs,
    `Video request timed out after ${requestTimeoutMs}ms`
  );
  const state: RequestState = {
    projectRoot: input.projectRoot,
    invocationId: input.invocationId,
    modelRunId: randomUUID(),
    entry,
    baseUrl: modelSettings?.baseUrlOverride ?? entry.defaultBaseUrl,
    apiKey,
    requestModelId: modelSettings?.requestModelIdOverride ?? entry.defaultRequestModelId,
    args: normalized.upstreamArgs,
    redactedDebruteArgs: normalized.redactedDebruteArgs,
    fetch: input.fetch ?? fetch,
    ...(input.recordGeneratedAsset ? { recordGeneratedAsset: input.recordGeneratedAsset } : {}),
    modelRun: { responses: [] },
    logs,
    pollIntervalMs: input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    requestTimeoutMs,
    pollMaxAttempts: input.pollMaxAttempts ?? DEFAULT_POLL_ATTEMPTS,
    ...(input.remoteUrlLookup ? { remoteUrlLookup: input.remoteUrlLookup } : {}),
    ...(input.remoteHttpTransport ? { remoteHttpTransport: input.remoteHttpTransport } : {}),
    signal: operationTimeout.signal
  };
  log(state, 'resolve_model', {
    model: entry.debruteModelId,
    requestModelId: state.requestModelId,
    configured: true
  });

  try {
    const result = await executeVolcengineArk(state);
    if (result.status === 'error') {
      return result;
    }
    return {
      status: 'ok',
      content: `Generated ${result.artifacts.length} video artifact(s).`,
      artifacts: result.artifacts,
      logs
    };
  } catch (error) {
    log(state, 'error', { message: errorMessage(error) });
    return {
      status: 'error',
      content: `Video request failed: ${errorMessage(error)}`,
      error: 'video_request_failed',
      logs
    };
  } finally {
    operationTimeout.dispose();
  }
}

async function executeVolcengineArk(
  state: RequestState
): Promise<{ status: 'ok'; artifacts: VideoModelRequestArtifact[] } | VideoRequestError> {
  const body = { model: state.requestModelId, ...stripVideoOutputArgs(state.args) };
  const submitUrl = joinUrl(state.baseUrl, 'contents/generations/tasks');
  log(state, 'build_request', { url: submitUrl, argumentKeys: Object.keys(state.args).sort(), contentTypes: contentTypes(state.args.content) });
  const submit = await postJson(state, submitUrl, authorizationHeaders(state), body);
  if (!submit.ok) {
    return submit.result;
  }
  const taskId = extractTaskId(submit.payload);
  if (!taskId) {
    return modelFailure(state, 'Video request failed: model response did not include a task id.', submit.endpointResponse);
  }

  const pollUrl = joinUrl(state.baseUrl, `contents/generations/tasks/${encodeURIComponent(taskId)}`);
  for (let attempt = 0; attempt < state.pollMaxAttempts; attempt += 1) {
    const poll = await getJson(state, pollUrl, authorizationHeaders(state));
    if (!poll.ok) {
      return poll.result;
    }
    const taskStatus = taskStatusFromPayload(poll.payload);
    if (!taskStatus) {
      return modelFailure(state, 'Video request failed: model endpoint returned an unknown task status.', poll.endpointResponse);
    }
    log(state, 'execute_request', { phase: 'poll', taskId, taskStatus });
    if (taskStatus === 'succeeded') {
      const videoUrl = extractOutputUrl(poll.payload, 'video_url');
      if (!videoUrl) {
        return modelFailure(state, 'Video request failed: model response did not include content.video_url.', poll.endpointResponse);
      }
      const artifactInputs: VideoArtifactInput[] = [{ url: videoUrl, artifactIndex: 0, artifactRole: 'primary-video' }];
      if (state.args.return_last_frame === true) {
        const lastFrameUrl = extractOutputUrl(poll.payload, 'last_frame_url');
        if (lastFrameUrl) {
          artifactInputs.push({ url: lastFrameUrl, artifactIndex: 1, artifactRole: 'last-frame' });
        }
      }
      const downloadedArtifacts: DownloadedVideoArtifact[] = [];
      for (const artifactInput of artifactInputs) {
        downloadedArtifacts.push(await downloadVideoArtifact(state, artifactInput));
      }
      const artifacts: VideoModelRequestArtifact[] = [];
      for (const artifact of downloadedArtifacts) {
        artifacts.push(await storeDownloadedArtifact(state, artifact));
      }
      log(state, 'store_artifacts', { count: artifacts.length });
      return { status: 'ok', artifacts };
    }
    if (taskStatus === 'failed' || taskStatus === 'expired' || taskStatus === 'canceled') {
      return modelFailure(state, `Video request failed: model task ${taskStatus}.`, poll.endpointResponse);
    }
    await delay(state.pollIntervalMs, state.signal);
  }
  return modelFailure(state, 'Video request failed: model task polling timed out.', { body: { taskId, pollMaxAttempts: state.pollMaxAttempts } });
}

async function postJson(state: RequestState, url: string, headers: Record<string, string>, body: unknown): Promise<JsonResponseResult> {
  const requestHeaders = { 'content-type': 'application/json', ...headers };
  recordModelRequest(state, {
    method: 'POST',
    url,
    headers: requestHeaders,
    body
  });
  const response = await fetchWithTimeout(state, url, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(body)
  });
  return parseModelResponse(state, response);
}

async function getJson(state: RequestState, url: string, headers: Record<string, string>): Promise<JsonResponseResult> {
  recordModelRequest(state, {
    method: 'GET',
    url,
    headers
  });
  const response = await fetchWithTimeout(state, url, { method: 'GET', headers });
  return parseModelResponse(state, response);
}

async function parseModelResponse(state: RequestState, response: Response): Promise<JsonResponseResult> {
  const rawBody = await readResponseTextWithTimeout(state, response);
  let body: Record<string, unknown>;
  try {
    body = parseJsonObject(rawBody);
  } catch (error) {
    const endpointResponse = {
      status: response.status,
      body: redactModelRunValue(state, rawBody.trim() ? { raw: truncateString(rawBody) } : { raw: '' })
    };
    state.modelRun.responses.push({
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: endpointResponse.body
    });
    log(state, 'execute_request', { status: response.status, payloadShape: summarizeJsonShape(endpointResponse.body) });
    return { ok: false, result: modelFailure(state, `Video request failed: ${errorMessage(error)}`, endpointResponse) };
  }
  const endpointResponse = { status: response.status, body: redactModelRunValue(state, body) };
  state.modelRun.responses.push({
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: endpointResponse.body
  });
  log(state, 'execute_request', { status: response.status, payloadShape: summarizeJsonShape(body) });
  if (!response.ok) {
    return { ok: false, result: modelFailure(state, `Video request failed: model endpoint responded with HTTP ${response.status}.`, endpointResponse) };
  }
  return { ok: true, payload: body, endpointResponse };
}

async function fetchWithTimeout(state: RequestState, url: string, init: RequestInit): Promise<Response> {
  return fetchWithRequestTimeout(state.fetch, url, init, {
    signal: state.signal,
    timeoutMs: state.requestTimeoutMs,
    timeoutMessage: `Video request timed out after ${state.requestTimeoutMs}ms`,
    abortMessage: 'Video request aborted.'
  });
}

async function readResponseTextWithTimeout(state: RequestState, response: Response): Promise<string> {
  return readResponseTextBodyWithTimeout(response, {
    signal: state.signal,
    timeoutMs: state.requestTimeoutMs,
    timeoutMessage: `Video response body timed out after ${state.requestTimeoutMs}ms`,
    abortMessage: 'Video request aborted.'
  });
}

async function readResponseArrayBufferWithTimeout(state: RequestState, response: Response): Promise<ArrayBuffer> {
  return readResponseArrayBufferBodyWithTimeout(response, {
    signal: state.signal,
    timeoutMs: state.requestTimeoutMs,
    timeoutMessage: `Video response body timed out after ${state.requestTimeoutMs}ms`,
    abortMessage: 'Video request aborted.'
  });
}

async function downloadVideoArtifact(
  state: RequestState,
  input: VideoArtifactInput
): Promise<DownloadedVideoArtifact> {
  const response = await fetchRemoteArtifact(state, input.url);
  const bytes = new Uint8Array(await readResponseArrayBufferWithTimeout(state, response));
  if (!response.ok) {
    throw new Error(`Video artifact download failed: ${response.status}`);
  }
  const mimeType = resolveVideoArtifactMimeType({
    artifactRole: input.artifactRole,
    url: input.url,
    headers: response.headers,
    bytes: Buffer.from(bytes)
  });
  return {
    ...input,
    artifactId: randomUUID(),
    bytes,
    mimeType
  };
}

async function storeDownloadedArtifact(
  state: RequestState,
  artifact: DownloadedVideoArtifact
): Promise<VideoModelRequestArtifact> {
  const extension = extensionForMimeType(artifact.mimeType, artifact.artifactRole);
  const outputPath = stringArg(state.args, 'output_path');
  const outputDirectory = stringArg(state.args, 'output_directory') ?? `generated/${state.invocationId}`;
  const projectRelativePath = outputPath && artifact.artifactIndex === 0
    ? outputPath
    : `${outputDirectory.replace(/\/$/, '')}/${artifact.artifactId}.${extension}`;
  const normalizedPath = await writeProjectFile(
    state.projectRoot,
    projectRelativePath,
    artifact.bytes,
    state.signal ? { signal: state.signal } : undefined
  );
  await state.recordGeneratedAsset?.({
    modelRunId: state.modelRunId,
    projectRelativePath: normalizedPath,
    artifactRole: artifact.artifactRole,
    artifactIndex: artifact.artifactIndex,
    modelRun: {
      request: redactModelRunValue(state, state.modelRun.request ?? null),
      output: redactModelRunValue(state, {
        responses: [...state.modelRun.responses],
        artifactIndex: artifact.artifactIndex
      })
    }
  });
  return {
    artifactId: artifact.artifactId,
    title: basename(normalizedPath),
    projectRelativePath: normalizedPath,
    mimeType: artifact.mimeType
  };
}

function resolveVideoArtifactMimeType(input: {
  artifactRole: VideoGeneratedAssetRecorderInput['artifactRole'];
  url: string;
  headers: Headers;
  bytes: Buffer;
}): string {
  const headerMime = normalizedHeaderMime(input.headers);
  if (headerMime && headerMime !== 'application/octet-stream') {
    if (input.artifactRole === 'primary-video' && headerMime === 'video/mp4') {
      return headerMime;
    }
    if (input.artifactRole === 'last-frame' && projectImageExtensionForMimeType(headerMime)) {
      return headerMime;
    }
    throw new Error(`Unsupported ${artifactLabel(input.artifactRole)} artifact MIME type: ${headerMime}`);
  }

  const path = pathForArtifactExtension(input.url);
  if (input.artifactRole === 'primary-video' && path.toLowerCase().endsWith('.mp4')) {
    return 'video/mp4';
  }
  if (input.artifactRole === 'last-frame') {
    const fromPath = projectImageMimeTypeFromPath(path);
    if (fromPath) {
      return fromPath;
    }
    const fromSignature = detectImageMimeTypeFromSignature(input.bytes);
    if (fromSignature) {
      return fromSignature;
    }
  }
  throw new Error(`Unsupported ${artifactLabel(input.artifactRole)} artifact MIME type: ${headerMime ?? 'missing'}`);
}

function normalizedHeaderMime(headers: Headers): string | undefined {
  const value = headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  return value || undefined;
}

function pathForArtifactExtension(url: string): string {
  return new URL(url).pathname;
}

function detectImageMimeTypeFromSignature(content: Buffer): string | undefined {
  if (content.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return 'image/png';
  }
  if (content.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) {
    return 'image/jpeg';
  }
  if (content.subarray(0, 4).toString('ascii') === 'RIFF' && content.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return undefined;
}

function artifactLabel(artifactRole: VideoGeneratedAssetRecorderInput['artifactRole']): string {
  return artifactRole === 'primary-video' ? 'primary video' : 'last-frame';
}

async function fetchRemoteArtifact(state: RequestState, url: string, redirectCount = 0): Promise<Response> {
  const response = await fetchRemoteHttpUrl(state, url, 'Remote artifact URLs');
  if (!isHttpRedirect(response.status)) {
    return response;
  }
  if (redirectCount >= 5) {
    throw new Error('Remote artifact URLs redirected too many times.');
  }
  const redirectUrl = resolveHttpRedirectUrl(url, response.headers.get('location'), 'Remote artifact URLs');
  return fetchRemoteArtifact(state, redirectUrl, redirectCount + 1);
}

async function fetchRemoteHttpUrl(state: RequestState, url: string, label: string): Promise<Response> {
  return fetchWithRequestTimeout(
    (requestUrl, init) => fetchPublicHttpUrl(requestUrl, label, init, {
      lookup: state.remoteUrlLookup,
      transport: state.remoteHttpTransport
    }),
    url,
    { method: 'GET' },
    {
      signal: state.signal,
      timeoutMs: state.requestTimeoutMs,
      timeoutMessage: `Video request timed out after ${state.requestTimeoutMs}ms`,
      abortMessage: 'Video request aborted.'
    }
  );
}

function isHttpRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function recordModelRequest(state: RequestState, request: unknown): void {
  if (state.modelRun.request === undefined) {
    state.modelRun.request = {
      debrute: state.redactedDebruteArgs,
      upstream: redactModelRunValue(state, request)
    };
  }
}

function modelFailure(state: RequestState, content: string, endpointResponse?: ModelEndpointResponse): VideoRequestError {
  log(state, 'model_failure', {
    message: content,
    endpointStatus: endpointResponse?.status ?? null,
    payloadShape: summarizeJsonShape(endpointResponse?.body),
    ...(endpointResponse ? { endpointResponse: redactModelRunValue(state, endpointResponse) } : {})
  });
  return {
    status: 'error',
    content,
    error: 'video_request_failed',
    logs: state.logs
  };
}

function extractTaskId(payload: Record<string, unknown>): string | null {
  return typeof payload.id === 'string' && payload.id.trim() ? payload.id.trim() : null;
}

function taskStatusFromPayload(payload: Record<string, unknown>): VideoTaskStatus | undefined {
  const raw = String(payload.status ?? '').toLowerCase();
  if (raw === 'succeeded') {
    return 'succeeded';
  }
  if (raw === 'failed') {
    return 'failed';
  }
  if (raw === 'expired') {
    return 'expired';
  }
  if (raw === 'canceled' || raw === 'cancelled') {
    return 'canceled';
  }
  if (raw === 'running' || raw === 'in_progress') {
    return 'running';
  }
  if (raw === 'queued' || raw === 'pending') {
    return 'queued';
  }
  return undefined;
}

function extractOutputUrl(payload: Record<string, unknown>, key: 'video_url' | 'last_frame_url'): string | null {
  const value = objectAt(payload.content)?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function authorizationHeaders(state: Pick<RequestState, 'apiKey'>): Record<string, string> {
  return { authorization: `Bearer ${state.apiKey}` };
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

function extensionForMimeType(mimeType: string, artifactRole: VideoGeneratedAssetRecorderInput['artifactRole']): string {
  if (artifactRole === 'primary-video' && mimeType === 'video/mp4') {
    return 'mp4';
  }
  if (artifactRole === 'last-frame') {
    const imageExtension = projectImageExtensionForMimeType(mimeType);
    if (imageExtension) {
      return imageExtension;
    }
  }
  throw new Error(`Unsupported ${artifactLabel(artifactRole)} artifact MIME type: ${mimeType}`);
}

function parseJsonObject(rawBody: string): Record<string, unknown> {
  if (!rawBody.trim()) {
    throw new Error('model endpoint returned an empty response.');
  }
  const parsed = JSON.parse(rawBody) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('model endpoint returned a non-object JSON response.');
  }
  return parsed as Record<string, unknown>;
}

function objectAt(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function redactModelRunValue(state: Pick<RequestState, 'apiKey'>, value: unknown): unknown {
  return redactRuntimeSecrets(value, { secrets: [state.apiKey] });
}

function truncateString(value: string): string {
  return value.length > 2_000 ? `${value.slice(0, 2_000)}...[truncated]` : value;
}

function summarizeJsonShape(value: unknown): unknown {
  if (Array.isArray(value)) {
    return { type: 'array', length: value.length };
  }
  if (value && typeof value === 'object') {
    return { type: 'object', keys: Object.keys(value as Record<string, unknown>).sort() };
  }
  return { type: typeof value };
}

function contentTypes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => objectAt(item)?.type ? [String(objectAt(item)?.type)] : []);
}

function log(state: Pick<RequestState, 'logs'>, stage: string, data: Record<string, unknown> = {}): void {
  state.logs.push({ stage, ...data });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(signal?.reason ?? new Error('Video request aborted.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
